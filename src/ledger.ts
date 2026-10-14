import type { Db } from './db.js';
import { createClassifier, categoryIdByName } from './classifier.js';
import { looksLikeTransfer } from './profiles/chaseChecking.js';

/** Person-to-person payment services. A P2P row is spending unless it's to/from one of us. */
export const P2P_RE = /\b(ZELLE|VENMO|P2P|CASH APP|PAYPAL|APPLE CASH)\b/;

export const PAIR_WINDOW = { before: 2, after: 5 }; // in-side may post 2 days before .. 5 days after out-side

interface Row {
  id: number;
  account_id: number;
  txn_date: string;
  raw_description: string;
  merchant: string;
  amount_cents: number;
  direction: 'out' | 'in';
  bank_kind: string;
  kind: string;
  kind_source: string;
  fingerprint: string;
}

export interface PairCandidate { outId: number; inId: number; }

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
}

/** A row that could be one side of a transfer between our own accounts. */
function pairable(r: Row): boolean {
  const d = r.raw_description.toUpperCase();
  return r.bank_kind === 'transfer' || looksLikeTransfer(d) || P2P_RE.test(d);
}

/**
 * For every unlinked out-row, the unlinked in-rows in another account with the same amount
 * inside the date window, where at least one side looks like a transfer.
 */
export function findPairCandidates(db: Db, onlyUnlinked = true): Map<number, number[]> {
  const rows = db.prepare(`
    SELECT t.id, t.account_id, t.txn_date, t.raw_description, t.merchant, t.amount_cents, t.direction,
           t.bank_kind, t.kind, t.kind_source, t.fingerprint
    FROM transactions t
    WHERE t.direction IS NOT NULL
      AND t.kind_source != 'manual'
      ${onlyUnlinked ? 'AND t.id NOT IN (SELECT out_txn_id FROM transfer_links UNION SELECT in_txn_id FROM transfer_links)' : ''}
  `).all() as Row[];

  const notPairs = new Set(
    (db.prepare('SELECT out_fingerprint, in_fingerprint FROM not_pairs').all() as { out_fingerprint: string; in_fingerprint: string }[])
      .map(p => `${p.out_fingerprint}|${p.in_fingerprint}`)
  );

  const insByAmount = new Map<number, Row[]>();
  for (const r of rows) {
    if (r.direction !== 'in') continue;
    const key = Math.abs(r.amount_cents);
    if (!insByAmount.has(key)) insByAmount.set(key, []);
    insByAmount.get(key)!.push(r);
  }

  const result = new Map<number, number[]>();
  for (const out of rows) {
    if (out.direction !== 'out') continue;
    const outDay = dayNumber(out.txn_date);
    const matches = (insByAmount.get(Math.abs(out.amount_cents)) || []).filter(inn => {
      if (inn.account_id === out.account_id) return false;
      const diff = dayNumber(inn.txn_date) - outDay;
      if (diff < -PAIR_WINDOW.before || diff > PAIR_WINDOW.after) return false;
      if (!pairable(out) && !pairable(inn)) return false;
      return !notPairs.has(`${out.fingerprint}|${inn.fingerprint}`);
    });
    if (matches.length > 0) result.set(out.id, matches.map(m => m.id));
  }
  return result;
}

export function parseList(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
  } catch {
    return [];
  }
}

export interface RecomputeStats {
  pairsLinked: number;
  accountMatches: number;
  householdTransfers: number;
}

/**
 * Re-derive everything the app decides on its own, from the bank data plus our answers:
 * transfer kind/links, counterparty accounts, categories, and people. Rows we set by hand
 * (kind_source / category_source / person_source = 'manual') are never changed.
 * Idempotent: running it twice gives the same result.
 */
export function recompute(db: Db): RecomputeStats {
  const stats: RecomputeStats = { pairsLinked: 0, accountMatches: 0, householdTransfers: 0 };

  db.transaction(() => {
    // 1. Reset derived transfer state
    db.exec(`
      DELETE FROM transfer_links WHERE method = 'auto';
      UPDATE transactions
         SET kind = bank_kind,
             transfer_via = CASE WHEN bank_kind = 'transfer' THEN 'bank' ELSE NULL END,
             counterparty_account_id = NULL
       WHERE kind_source != 'manual';
    `);

    // 2. Pair rows between our imported accounts (only unambiguous one-to-one matches)
    const candidates = findPairCandidates(db);
    const inCount = new Map<number, number>();
    for (const ins of candidates.values()) for (const id of ins) inCount.set(id, (inCount.get(id) || 0) + 1);

    const accountOf = db.prepare('SELECT account_id FROM transactions WHERE id = ?');
    const setTransfer = db.prepare(
      "UPDATE transactions SET kind = 'transfer', transfer_via = ?, counterparty_account_id = ? WHERE id = ?"
    );
    const link = db.prepare(
      "INSERT INTO transfer_links (out_txn_id, in_txn_id, method, created_at) VALUES (?, ?, 'auto', ?)"
    );
    const now = new Date().toISOString();
    for (const [outId, ins] of candidates) {
      if (ins.length !== 1 || inCount.get(ins[0]) !== 1) continue;
      const inId = ins[0];
      const outAcct = (accountOf.get(outId) as { account_id: number }).account_id;
      const inAcct = (accountOf.get(inId) as { account_id: number }).account_id;
      link.run(outId, inId, now);
      setTransfer.run('pair', inAcct, outId);
      setTransfer.run('pair', outAcct, inId);
      stats.pairsLinked++;
    }

    // 3. Rows matching one of our accounts' description patterns (accounts we don't import,
    //    or imported accounts for periods we haven't imported)
    const accounts = db.prepare(
      'SELECT id, account_type, is_tracked, card_policy, match_patterns FROM accounts'
    ).all() as { id: number; account_type: string; is_tracked: number; card_policy: string | null; match_patterns: string }[];
    const patterned = accounts
      .map(a => ({ ...a, patterns: parseList(a.match_patterns).map(p => p.toUpperCase()) }))
      .filter(a => a.patterns.length > 0);

    const unpaired = db.prepare(`
      SELECT id, account_id, raw_description, merchant, direction FROM transactions
      WHERE kind_source != 'manual' AND transfer_via IS NOT 'pair'
    `).all() as { id: number; account_id: number; raw_description: string; merchant: string; direction: string }[];

    const setKind = db.prepare('UPDATE transactions SET kind = ?, transfer_via = ?, counterparty_account_id = ? WHERE id = ?');
    const matchedIds = new Set<number>();
    for (const r of unpaired) {
      const raw = r.raw_description.toUpperCase();
      const merchant = r.merchant.toUpperCase();
      const acct = patterned.find(a => a.id !== r.account_id && a.patterns.some(p => raw.includes(p) || merchant.includes(p)));
      if (!acct) continue;
      matchedIds.add(r.id);
      stats.accountMatches++;
      const untrackedCardSpending = !acct.is_tracked && acct.account_type === 'credit'
        && acct.card_policy === 'payments_are_spending' && r.direction === 'out';
      if (untrackedCardSpending) setKind.run('spend', null, acct.id, r.id);
      else setKind.run('transfer', 'account', acct.id, r.id);
    }

    // 4. P2P to/from a household member is moving money within the household
    const aliases = (db.prepare('SELECT aliases FROM people').all() as { aliases: string }[])
      .flatMap(p => parseList(p.aliases).map(a => a.toUpperCase()));
    if (aliases.length > 0) {
      for (const r of unpaired) {
        if (matchedIds.has(r.id)) continue;
        const raw = r.raw_description.toUpperCase();
        if (P2P_RE.test(raw) && aliases.some(a => raw.includes(a))) {
          setKind.run('transfer', 'household', null, r.id);
          stats.householdTransfers++;
        }
      }
    }

    // 5. Categories follow kind; keep manual edits, user rules on spending, and AI picks on spending
    const classify = createClassifier(db);
    const transferId = categoryIdByName(db, 'Transfer');
    const incomeId = categoryIdByName(db, 'Income');
    const untrackedCardId = categoryIdByName(db, 'Credit card (untracked)');
    const rows = db.prepare(`
      SELECT t.id, t.merchant, t.kind, t.bank_category, t.category_id, t.category_source,
             t.counterparty_account_id, a.is_tracked AS cp_tracked
      FROM transactions t LEFT JOIN accounts a ON a.id = t.counterparty_account_id
      WHERE t.category_source != 'manual'
    `).all() as { id: number; merchant: string; kind: string; bank_category: string | null; category_id: number;
                 category_source: string; counterparty_account_id: number | null; cp_tracked: number | null }[];
    const setCat = db.prepare('UPDATE transactions SET category_id = ?, category_source = ? WHERE id = ?');

    for (const r of rows) {
      let next: { id: number; source: string };
      if (r.kind === 'transfer') next = { id: transferId, source: 'default_rule' };
      else if (r.kind === 'income') next = { id: incomeId, source: 'default_rule' };
      else if (r.counterparty_account_id && r.cp_tracked === 0) next = { id: untrackedCardId, source: 'default_rule' };
      else {
        const c = classify(r.merchant, r.kind, r.bank_category);
        // Our own rules beat an earlier AI pick; otherwise keep the AI's spending category
        const keepAi = r.category_source === 'ai' && c.categorySource !== 'user_rule'
          && r.category_id !== transferId && r.category_id !== incomeId && r.category_id !== untrackedCardId;
        if (keepAi) continue;
        next = { id: c.categoryId, source: c.categorySource };
      }
      if (next.id !== r.category_id || next.source !== r.category_source) setCat.run(next.id, next.source, r.id);
    }

    // 6. People: person rule by merchant, else the account's default person
    const personRules = db.prepare('SELECT pattern, person_id FROM person_rules').all() as { pattern: string; person_id: number }[];
    const defaults = new Map(
      (db.prepare('SELECT id, default_person_id FROM accounts').all() as { id: number; default_person_id: number | null }[])
        .map(a => [a.id, a.default_person_id])
    );
    const people = db.prepare(`
      SELECT id, account_id, merchant, person_id, person_source FROM transactions WHERE person_source IS NOT 'manual'
    `).all() as { id: number; account_id: number; merchant: string; person_id: number | null; person_source: string | null }[];
    const setPerson = db.prepare('UPDATE transactions SET person_id = ?, person_source = ? WHERE id = ?');
    for (const r of people) {
      const rule = personRules.find(p => p.pattern === r.merchant.toLowerCase());
      const next = rule
        ? { id: rule.person_id, source: 'rule' }
        : defaults.get(r.account_id)
          ? { id: defaults.get(r.account_id)!, source: 'account' }
          : { id: null, source: null };
      if (next.id !== r.person_id || next.source !== r.person_source) setPerson.run(next.id, next.source, r.id);
    }
  })();

  return stats;
}

type DecisionField = 'kind' | 'category_id' | 'person_id' | 'is_one_time' | 'reviewed';

/** Remember a user answer for this row by fingerprint, so it survives undo + re-import. */
export function saveDecision(db: Db, fingerprint: string, fields: Partial<Record<DecisionField, string | number | null>>): void {
  const cols = Object.keys(fields) as DecisionField[];
  if (cols.length === 0) return;
  db.prepare('INSERT OR IGNORE INTO decisions (fingerprint, updated_at) VALUES (?, ?)').run(fingerprint, new Date().toISOString());
  db.prepare(`UPDATE decisions SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE fingerprint = ?`)
    .run(...cols.map(c => fields[c] ?? null), new Date().toISOString(), fingerprint);
}

/** Apply stored decisions to rows (after import). Sets the matching *_source to 'manual'. */
export function applyDecisions(db: Db, importId?: number): void {
  const where = importId ? 'WHERE t.import_id = ?' : '';
  const rows = db.prepare(`
    SELECT t.id, d.kind, d.category_id, d.person_id, d.is_one_time, d.reviewed
    FROM transactions t JOIN decisions d ON d.fingerprint = t.fingerprint ${where}
  `).all(...(importId ? [importId] : [])) as { id: number; kind: string | null; category_id: number | null;
    person_id: number | null; is_one_time: number | null; reviewed: number | null }[];

  for (const d of rows) {
    if (d.kind) db.prepare("UPDATE transactions SET kind = ?, kind_source = 'manual', transfer_via = CASE WHEN ? = 'transfer' THEN 'manual' ELSE NULL END WHERE id = ?").run(d.kind, d.kind, d.id);
    if (d.category_id) db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(d.category_id, d.id);
    if (d.person_id) db.prepare("UPDATE transactions SET person_id = ?, person_source = 'manual' WHERE id = ?").run(d.person_id, d.id);
    if (d.is_one_time !== null) db.prepare('UPDATE transactions SET is_one_time = ? WHERE id = ?').run(d.is_one_time, d.id);
    if (d.reviewed) db.prepare('UPDATE transactions SET reviewed = 1 WHERE id = ?').run(d.id);
  }
}
