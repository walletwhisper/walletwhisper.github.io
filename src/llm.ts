import fs from 'fs';
import path from 'path';
import { Database } from 'sql.js';
import { saveDb } from './db.js';

/**
 * LLM Recategorization (Gemini):
 * Sends sanitized, de-duplicated transactions to the configured LLM and applies
 * its category suggestions. Manual edits and user rules are never touched.
 *
 * Privacy: only a cleaned description (long IDs/reference numbers stripped),
 * account type, direction, and amount are sent. No account numbers, balances, or fingerprints.
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
  return `You categorize personal bank transactions for a spending tracker.

Allowed categories: ${categoryNames.join(', ')}

Rules:
- "Transfer" = money moved between the user's own accounts, including paying ANY credit card bill
  (e.g. "CAPITAL ONE MOBILE PMT", "DISCOVER E-PAYMENT", "CITI AUTOPAY", "AMEX EPAYMENT"), savings transfers,
  brokerage/investment transfers, and Venmo/Zelle cash-outs to self. Transfers are excluded from spending.
- "Income" = payroll, direct deposit, salary, interest, dividends, tax refunds. Only for money coming IN.
- Pick the most specific spending category for purchases. Gas stations -> Gas; groceries -> Groceries;
  restaurants, coffee, food delivery -> Dining; rideshare, transit, parking, tolls -> Transport;
  phone/internet/electric/water -> Utilities; rent/mortgage -> Housing; streaming/software -> Subscriptions.
- Use "Uncategorized" only if you genuinely cannot tell.

Each item has: id, description, account (checking/credit), flow (money_out / money_in), amountUSD, bankCategory (may be empty).
Return one result per id.

Items:
${JSON.stringify(items)}`;
}

export async function recategorizeWithLlm(db: Database): Promise<AiRecategorizeResult> {
  const cfg = getConfig();

  // Categories
  const catRows = db.exec('SELECT id, name FROM categories')[0]?.values || [];
  const nameToId = new Map<string, number>();
  const idToName = new Map<number, string>();
  for (const [id, name] of catRows) {
    nameToId.set(name as string, id as number);
    idToName.set(id as number, name as string);
  }
  const categoryNames = [...nameToId.keys()];

  // Transactions eligible for AI: never touch manual edits or user rules
  const txRows = db.exec(`
    SELECT t.id, t.txn_date, t.raw_description, t.merchant, t.amount_cents, t.kind,
           t.category_id, t.bank_category, a.account_type
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.category_source NOT IN ('manual', 'user_rule')
  `)[0]?.values || [];

  type Tx = {
    id: number; date: string; raw: string; merchant: string; cents: number;
    kind: string; categoryId: number; bankCategory: string; account: string;
  };
  const txs: Tx[] = txRows.map(v => ({
    id: v[0] as number, date: v[1] as string, raw: v[2] as string, merchant: v[3] as string,
    cents: v[4] as number, kind: v[5] as string, categoryId: v[6] as number,
    bankCategory: (v[7] as string) || '', account: v[8] as string
  }));

  // Group identical-looking transactions so each unique merchant is sent once
  const groups = new Map<string, Tx[]>();
  for (const t of txs) {
    const desc = sanitizeDescription(t.raw);
    const flow = t.kind === 'income' || t.kind === 'refund' ? 'in' : 'out';
    const key = `${t.account}|${flow}|${desc.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const groupList = [...groups.values()];

  // Ask the LLM in batches
  const suggestions = new Map<number, string>(); // group index -> category name
  const BATCH = 80;
  for (let start = 0; start < groupList.length; start += BATCH) {
    const slice = groupList.slice(start, start + BATCH);
    const items = slice.map((g, i) => {
      const t = g[0];
      return {
        id: start + i,
        description: sanitizeDescription(t.raw) || t.merchant,
        account: t.account,
        flow: t.kind === 'income' || t.kind === 'refund' ? 'money_in' : 'money_out',
        amountUSD: Math.abs(t.cents) / 100,
        bankCategory: t.bankCategory
      };
    });
    const results = await callGemini(cfg, buildPrompt(items, categoryNames), categoryNames);
    for (const r of results) {
      if (nameToId.has(r.category)) suggestions.set(r.id, r.category);
    }
  }

  // Apply suggestions conservatively
  const changes: AiChange[] = [];
  let unchanged = 0;
  let skipped = 0;
  const spendKinds = new Set(['spend', 'fee', 'refund']);

  groupList.forEach((group, idx) => {
    const suggested = suggestions.get(idx);
    if (!suggested) { skipped += group.length; return; }
    const newCatId = nameToId.get(suggested)!;

    for (const t of group) {
      let newKind = t.kind;
      if (suggested === 'Transfer') {
        newKind = 'transfer';
      } else if (suggested === 'Income') {
        if (t.kind !== 'income') { skipped++; continue; }
      } else if (!spendKinds.has(t.kind)) {
        // Don't turn transfers/income into spending automatically
        skipped++;
        continue;
      }

      if (newCatId === t.categoryId && newKind === t.kind) { unchanged++; continue; }

      db.run(
        "UPDATE transactions SET category_id = ?, kind = ?, category_source = 'ai' WHERE id = ?",
        [newCatId, newKind, t.id]
      );
      changes.push({
        date: t.date,
        merchant: t.merchant,
        amountCents: t.cents,
        from: idToName.get(t.categoryId) || '?',
        to: suggested
      });
    }
  });

  saveDb();

  return {
    reviewed: txs.length,
    groupsSent: groupList.length,
    changed: changes.length,
    unchanged,
    skippedSuggestions: skipped,
    changes: changes.sort((a, b) => b.date.localeCompare(a.date))
  };
}
