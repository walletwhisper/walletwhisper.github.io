import fs from 'fs';
import path from 'path';
import type { Db } from './db.js';

/**
 * LLM Recategorization (Gemini):
 * Sends sanitized, de-duplicated transactions to the configured LLM and applies
 * its category suggestions. Manual edits and user rules are never touched, and the AI
 * only picks spending categories: whether a row is a transfer or income is decided by the
 * transfer matcher and by us in the review inbox, never by the AI.
 *
 * Privacy: only a cleaned description (long IDs/reference numbers stripped), account type,
 * amount, and the bank's own category are sent, once per distinct description.
 * No account numbers, balances, dates, people, or fingerprints.
 */

interface LlmConfig {
  provider: string;
  apiKey: string;
  model: string;
}

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

/** Minimal .env reader, re-read on every call so key edits apply without restart. */
function readEnvFile(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env');
  const out: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function getConfig(): LlmConfig {
  const env = { ...readEnvFile(), ...process.env } as Record<string, string | undefined>;
  const provider = (env.LLM_PROVIDER || 'gemini').toLowerCase();
  const apiKey = env.LLM_API_KEY || '';
  const model = env.LLM_MODEL || 'gemini-3.8-flash';
  if (provider !== 'gemini') {
    throw new Error(`LLM_PROVIDER "${provider}" is not supported yet. Use "gemini".`);
  }
  if (!apiKey) {
    throw new Error('LLM_API_KEY is empty. Add your key to the .env file in the project folder.');
  }
  return { provider, apiKey, model };
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

async function callGemini(cfg: LlmConfig, prompt: string, categoryNames: string[]): Promise<{ id: number; category: string }[]> {
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
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error(`Gemini returned an empty response from ${modelName}.`);
      return JSON.parse(text);
    } catch (err: any) {
      lastError = err;
      console.warn(`Gemini attempt with ${modelName} failed:`, err.message);
    }
  }

  throw lastError || new Error('All Gemini candidate models failed.');
}

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
    const results = await callGemini(cfg, buildPrompt(items, categoryNames), categoryNames);
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
