import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import type { Db } from './db.js';
import { readConfig } from './config.js';
import { UserError } from './errors.js';

/**
 * Optional AI categorization with the user's own API key (Claude, Gemini or OpenAI; the
 * provider is recognised from the key). The AI only picks spending categories: whether a row
 * is a transfer or income is decided by the transfer matcher and the review inbox, never the AI.
 * Manual edits and user rules are never touched.
 *
 * Privacy: only a cleaned description (long IDs/reference numbers stripped), account type,
 * amount, and the bank's own category are sent, once per distinct description, and only when
 * the user presses the button. No account numbers, balances, dates, people, or fingerprints.
 */

export type AiProvider = 'claude' | 'gemini' | 'openai';

export const PROVIDER_NAMES: Record<AiProvider, string> = { claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI' };

const DEFAULT_MODELS: Record<AiProvider, string> = {
  claude: 'claude-opus-5-5',
  gemini: 'gemini-3.8-flash',
  openai: 'gpt-5-mini',
};

interface LlmConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
}

interface Suggestion { id: number; category: string }

export interface AiChange {
  date: string;
  merchant: string;
  amountCents: number;
  from: string;
  to: string;
}

export interface AiRecategorizeResult {
  reviewed: number;
  groupsSent: number;
  changed: number;
  unchanged: number;
  skippedSuggestions: number;
  changes: AiChange[];
}

/** Recognise the provider from the key's format; null if it isn't a key we support. */
export function detectProvider(key: string): AiProvider | null {
  const k = key.trim();
  if (/^sk-ant-[\w-]{20,}$/.test(k)) return 'claude';
  if (/^AIza[\w-]{30,}$/.test(k)) return 'gemini';
  if (/^sk-[\w-]{20,}$/.test(k)) return 'openai';
  return null;
}

/** Key saved in Settings, or LLM_API_KEY from .env / the environment (older setups). */
function storedKey(): string {
  const fromSettings = readConfig().aiKey;
  if (fromSettings) return fromSettings;
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
  try {
    const env = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf-8');
    return env.match(/^\s*LLM_API_KEY\s*=\s*["']?([^"'\s]+)/m)?.[1] ?? '';
  } catch {
    return '';
  }
}

/** Which provider is configured, for the Settings screen. Never returns the key itself. */
export function aiStatus(): { provider: AiProvider | null; providerName: string | null; fromEnvFile: boolean } {
  const key = storedKey();
  const provider = detectProvider(key);
  return {
    provider,
    providerName: provider ? PROVIDER_NAMES[provider] : null,
    fromEnvFile: !!key && !readConfig().aiKey,
  };
}

function getConfig(): LlmConfig {
  const apiKey = storedKey().trim();
  if (!apiKey) throw new UserError('AI is not set up. Add an AI API key in Settings to use it.');
  const provider = detectProvider(apiKey);
  if (!provider) throw new UserError('The saved AI key is not a Claude, Gemini or OpenAI key. Replace it in Settings.');
  return { provider, apiKey, model: process.env.LLM_MODEL || DEFAULT_MODELS[provider] };
}

/** Strip reference numbers / IDs so nothing account-identifying is sent. */
function sanitizeDescription(raw: string): string {
  return raw
    .replace(/\b(WEB|PPD|CCD|TEL|IAT)\s+ID:?\s*\S*/gi, '')
    .replace(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{6,}\b/gi, '')
    .replace(/[#*]+\S*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** JSON shape Claude and OpenAI must return: { results: [{ id, category }] } */
function resultSchema(categoryNames: string[]) {
  return {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'integer' }, category: { type: 'string', enum: categoryNames } },
          required: ['id', 'category'],
          additionalProperties: false,
        },
      },
    },
    required: ['results'],
    additionalProperties: false,
  };
}

function parseResults(text: string | undefined, who: string): Suggestion[] {
  if (!text) throw new Error(`${who} returned an empty response.`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed.results ?? [];
}

async function callClaude(cfg: LlmConfig, prompt: string, categoryNames: string[]): Promise<Suggestion[]> {
  const client = new Anthropic({ apiKey: cfg.apiKey });
  try {
    const response = await client.beta.messages.create({
      model: cfg.model,
      max_tokens: 16000,
      // Simple classification: low effort keeps it fast and cheap
      output_config: { effort: 'low', format: { type: 'json_schema', schema: resultSchema(categoryNames) } },
      // If the model declines a request, the API retries it on a suitable fallback model
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to categorize these transactions.');
    if (response.stop_reason === 'max_tokens') throw new Error('Claude response was cut off; try again.');
    const text = response.content.find(b => b.type === 'text');
    return parseResults(text?.type === 'text' ? text.text : undefined, 'Claude');
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new UserError('Claude rejected the API key. Check it in Settings.');
    if (err instanceof Anthropic.RateLimitError) throw new UserError('Claude rate limit reached. Try again in a minute.');
    if (err instanceof Anthropic.APIError) throw new Error(`Claude API error ${err.status}: ${err.message}`);
    throw err;
  }
}

async function callGemini(cfg: LlmConfig, prompt: string, categoryNames: string[]): Promise<Suggestion[]> {
  const candidateModels = [cfg.model, 'gemini-3.5-flash', 'gemini-3.1-flash-lite'].filter((v, i, a) => a.indexOf(v) === i);
  let lastError: Error | null = null;

  for (const modelName of candidateModels) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                id: { type: 'INTEGER' },
                category: { type: 'STRING', enum: categoryNames }
              },
              required: ['id', 'category']
            }
          }
        }
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini API error ${res.status} (${modelName}): ${text.slice(0, 300)}`);
      }

      const data: any = await res.json();
      return parseResults(data?.candidates?.[0]?.content?.parts?.[0]?.text, 'Gemini');
    } catch (err: any) {
      lastError = err;
      console.warn(`Gemini attempt with ${modelName} failed:`, err.message);
    }
  }

  throw lastError || new Error('All Gemini candidate models failed.');
}

async function callOpenAI(cfg: LlmConfig, prompt: string, categoryNames: string[]): Promise<Suggestion[]> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'categories', strict: true, schema: resultSchema(categoryNames) },
      },
    }),
  });
  if (res.status === 401) throw new UserError('OpenAI rejected the API key. Check it in Settings.');
  if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return parseResults(data?.choices?.[0]?.message?.content, 'OpenAI');
}

const CALLERS: Record<AiProvider, (cfg: LlmConfig, prompt: string, categoryNames: string[]) => Promise<Suggestion[]>> = {
  claude: callClaude,
  gemini: callGemini,
  openai: callOpenAI,
};

function buildPrompt(items: object[], categoryNames: string[]): string {
  return `You categorize personal credit card and bank purchases for a spending tracker.

Allowed categories: ${categoryNames.join(', ')}

Rules:
- Every item is money spent (or a refund of a purchase). Pick the most specific spending category.
- Gas stations -> Gas; groceries -> Groceries; restaurants, coffee, food delivery -> Dining;
  rideshare, transit, parking, tolls -> Transport; phone/internet/electric/water -> Utilities;
  rent/mortgage/HOA -> Housing; streaming/software -> Subscriptions; insurance premiums -> Insurance;
  daycare, school fees, kids' activities -> Kids; charities -> Gifts & Donations.
- Use "Uncategorized" only if you genuinely cannot tell.

Each item has: id, description, account (checking/credit), amountUSD, bankCategory (may be empty).
Return one result per id.

Items:
${JSON.stringify(items)}`;
}

/** Categories the AI may choose: spending categories only. */
const NOT_FOR_AI = new Set(['Transfer', 'Income', 'Credit card (untracked)']);

export async function recategorizeWithLlm(db: Db): Promise<AiRecategorizeResult> {
  const cfg = getConfig();

  const cats = db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[];
  const nameToId = new Map(cats.map(c => [c.name, c.id]));
  const idToName = new Map(cats.map(c => [c.id, c.name]));
  const categoryNames = cats.map(c => c.name).filter(n => !NOT_FOR_AI.has(n));

  // Spending rows only; never touch manual edits, user rules, or rows tied to an untracked card
  const txs = db.prepare(`
    SELECT t.id, t.txn_date AS date, t.raw_description AS raw, t.merchant, t.amount_cents AS cents,
           t.category_id AS categoryId, COALESCE(t.bank_category, '') AS bankCategory, a.account_type AS account
    FROM transactions t JOIN accounts a ON t.account_id = a.id
    WHERE t.kind IN ('spend', 'fee', 'refund')
      AND t.category_source NOT IN ('manual', 'user_rule')
      AND t.counterparty_account_id IS NULL
  `).all() as { id: number; date: string; raw: string; merchant: string; cents: number;
               categoryId: number; bankCategory: string; account: string }[];

  // Group identical-looking transactions so each distinct description is sent once
  const groups = new Map<string, typeof txs>();
  for (const t of txs) {
    const key = `${t.account}|${sanitizeDescription(t.raw).toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const groupList = [...groups.values()];

  const suggestions = new Map<number, string>(); // group index -> category name
  const BATCH = 80;
  for (let start = 0; start < groupList.length; start += BATCH) {
    const slice = groupList.slice(start, start + BATCH);
    const items = slice.map((g, i) => ({
      id: start + i,
      description: sanitizeDescription(g[0].raw) || g[0].merchant,
      account: g[0].account,
      amountUSD: Math.abs(g[0].cents) / 100,
      bankCategory: g[0].bankCategory
    }));
    const results = await CALLERS[cfg.provider](cfg, buildPrompt(items, categoryNames), categoryNames);
    for (const r of results) {
      if (categoryNames.includes(r.category)) suggestions.set(r.id, r.category);
    }
  }

  const changes: AiChange[] = [];
  let unchanged = 0;
  let skipped = 0;
  const update = db.prepare("UPDATE transactions SET category_id = ?, category_source = 'ai' WHERE id = ?");

  db.transaction(() => {
    groupList.forEach((group, idx) => {
      const suggested = suggestions.get(idx);
      if (!suggested) { skipped += group.length; return; }
      const newCatId = nameToId.get(suggested)!;
      for (const t of group) {
        if (newCatId === t.categoryId) { unchanged++; continue; }
        update.run(newCatId, t.id);
        changes.push({ date: t.date, merchant: t.merchant, amountCents: t.cents, from: idToName.get(t.categoryId) || '?', to: suggested });
      }
    });
  })();

  return {
    reviewed: txs.length,
    groupsSent: groupList.length,
    changed: changes.length,
    unchanged,
    skippedSuggestions: skipped,
    changes: changes.sort((a, b) => b.date.localeCompare(a.date))
  };
}
