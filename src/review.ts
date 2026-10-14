import type { Db } from './db.js';
import { getSetting, setSetting } from './db.js';
import { findPairCandidates, P2P_RE, parseList, recompute, saveDecision } from './ledger.js';
import { accountLabel } from './importer.js';
import { UserError } from './errors.js';

export const DEFAULT_ONE_TIME_THRESHOLD_CENTS = 500_000; // $5,000
export const P2P_REVIEW_MIN_CENTS = 50_000; // $500: smaller P2P payments are assumed to be ordinary spending

export interface ReviewTxn {
  id: number;
  date: string;
  account: string;
  description: string;
  amountCents: number;
  direction: string;
}

export interface ReviewItem {
  key: string;
  type: 'unmatched_transfer' | 'ambiguous_pair' | 'p2p_name' | 'one_time';
  title: string;
  detail: string;
  direction?: 'out' | 'in';
  count: number;
  totalCents: number;
  txns: ReviewTxn[];
  suggestedPattern?: string;
  name?: string;
  candidates?: ReviewTxn[];
}

const TXN_SELECT = `
  SELECT t.id, t.txn_date AS date, t.raw_description AS description, t.merchant, t.amount_cents AS amountCents,
         t.direction, t.reviewed, a.nickname, a.bank, a.account_type, a.last4
  FROM transactions t JOIN accounts a ON a.id = t.account_id`;

type TxnRow = { id: number; date: string; description: string; merchant: string; amountCents: number; direction: string; reviewed: number;
  nickname: string | null; bank: string; account_type: string; last4: string | null };

function toReviewTxn(r: TxnRow): ReviewTxn {
  return { id: r.id, date: r.date, account: accountLabel(r), description: r.description, amountCents: Math.abs(r.amountCents), direction: r.direction };
}

/** Longest common word-prefix of descriptions: a pattern that matches all of them. */
export function commonPattern(descriptions: string[]): string {
  const split = descriptions.map(d => d.toUpperCase().split(/\s+/).filter(Boolean));
  const out: string[] = [];
  for (let i = 0; i < split[0].length; i++) {
    const w = split[0][i];
    if (split.every(s => s[i] === w)) out.push(w); else break;
  }
  // Stop at reference numbers, dates and ACH id markers; keep plain 4-digit card endings
  const cut = out.findIndex((w, i) => i >= 2 && (
    /^(WEB|PPD|CCD|TEL|IAT)$/.test(w) || /[/#:]/.test(w) || (/\d/.test(w) && !/^\d{4}$/.test(w))
  ));
  const kept = cut >= 0 ? out.slice(0, cut) : out;
  return kept.join(' ') || split[0].slice(0, 3).join(' ');
}

/**
 * Groups payments to the same payee despite reference numbers:
 * "FID BKG SVC LLC MONEYLINE Z0745 WEB ID:" and "FID BKG SVC LLC MONEYLINE PPD ID:" -> "FID BKG SVC".
 */
export function payeeKey(description: string): string {
  const words = description.toUpperCase()
    .split(/\b(?:WEB|PPD|CCD|TEL|IAT)\s+ID\b/)[0]
    .split(/\s+/)
    .filter(w => /^[A-Z&'.-]+$/.test(w) && !/^[.'-]+$/.test(w));
  return words.slice(0, 3).join(' ') || description.toUpperCase().slice(0, 20);
}

const NAME_STOP =new Set(['WEB', 'ID', 'ID:', 'PPD', 'CCD', 'PAYMENT', 'TRANSFER', 'ON', 'REF', 'CONF', 'TEL', 'IAT']);

/** The person's name in a P2P description: "Zelle payment from JANE DOE BAC123" -> "JANE DOE". */
export function extractP2PName(description: string): string | null {
  const tokens = description.toUpperCase().split(/\s+/);
  const idx = tokens.findIndex(t => t === 'FROM' || t === 'TO' || t === 'P2P');
  if (idx < 0) return null;
  const name: string[] = [];
  for (const t of tokens.slice(idx + 1)) {
    if (!/^[A-Z][A-Z.'-]*$/.test(t) || NAME_STOP.has(t)) break;
    name.push(t);
    if (name.length === 3) break;
  }
  return name.length > 0 ? name.join(' ') : null;
}

export function oneTimeThreshold(db: Db): number {
  return Number(getSetting(db, 'one_time_threshold_cents', String(DEFAULT_ONE_TIME_THRESHOLD_CENTS)));
}

export function getReviewItems(db: Db): ReviewItem[] {
  const items: ReviewItem[] = [];

  // 1. Same amount in two of our accounts, but more than one possible partner
  const candidates = findPairCandidates(db);
  const inAmbiguous = new Set<number>();
  const byId = db.prepare(`${TXN_SELECT} WHERE t.id = ?`);
  for (const [outId, inIds] of candidates) {
    const out = byId.get(outId) as TxnRow;
    if (out.reviewed) continue;
    const ins = inIds.map(id => byId.get(id) as TxnRow);
    ins.forEach(i => inAmbiguous.add(i.id));
    inAmbiguous.add(outId);
    items.push({
      key: `pair:${outId}`,
      type: 'ambiguous_pair',
      title: `Which transaction is the other side of this ${formatUsd(out.amountCents)} transfer?`,
      detail: `${ins.length} rows in your other accounts have the same amount within a few days.`,
      count: 1,
      totalCents: Math.abs(out.amountCents),
      txns: [toReviewTxn(out)],
      candidates: ins.map(toReviewTxn)
    });
  }

  // 2. Transfers the bank flagged that we can't explain, grouped by payee + direction
  const unmatched = (db.prepare(`${TXN_SELECT}
    WHERE t.kind = 'transfer' AND t.transfer_via = 'bank' AND t.reviewed = 0
    ORDER BY t.txn_date DESC`).all() as TxnRow[]).filter(r => !inAmbiguous.has(r.id));
  const groups = new Map<string, TxnRow[]>();
  for (const r of unmatched) {
    const key = `${payeeKey(r.description)}|${r.direction}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  for (const [key, rows] of groups) {
    const total = rows.reduce((s, r) => s + Math.abs(r.amountCents), 0);
    const dir = rows[0].direction as 'out' | 'in';
    const pattern = commonPattern(rows.map(r => r.description));
    items.push({
      key: `transfer:${key}`,
      type: 'unmatched_transfer',
      title: `${rows.length} transfer${rows.length > 1 ? 's' : ''} ${dir === 'out' ? 'out' : 'in'}: "${pattern}"`,
      detail: dir === 'out'
        ? 'Money left this account, but no matching deposit was found in your imported accounts. Where did it go?'
        : 'Money arrived, but no matching withdrawal was found in your imported accounts. Where did it come from?',
      direction: dir,
      count: rows.length,
      totalCents: total,
      txns: rows.map(toReviewTxn),
      suggestedPattern: pattern
    });
  }

  // 3. Larger P2P payments to/from a named person: could be one of us
  const ignored = new Set(parseList(getSetting(db, 'p2p_not_household', '[]')).map(n => n.toUpperCase()));
  const p2p = db.prepare(`${TXN_SELECT}
    WHERE t.kind IN ('spend', 'income') AND t.transfer_via IS NULL AND t.reviewed = 0 AND ABS(t.amount_cents) >= ?
    ORDER BY t.txn_date DESC`).all(P2P_REVIEW_MIN_CENTS) as TxnRow[];
  const byName = new Map<string, TxnRow[]>();
  for (const r of p2p) {
    if (!P2P_RE.test(r.description.toUpperCase())) continue;
    const name = extractP2PName(r.description);
    if (!name || ignored.has(name)) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(r);
  }
  for (const [name, rows] of byName) {
    items.push({
      key: `p2p:${name}`,
      type: 'p2p_name',
      title: `Is "${name}" one of us?`,
      detail: `${rows.length} P2P payment${rows.length > 1 ? 's' : ''} with this name. Money between household members isn't spending or income.`,
      count: rows.length,
      totalCents: rows.reduce((s, r) => s + Math.abs(r.amountCents), 0),
      txns: rows.map(toReviewTxn),
      name
    });
  }

  // 4. Very large single payments: one-time or normal spending?
  const big = db.prepare(`${TXN_SELECT}
    WHERE t.kind = 'spend' AND t.is_one_time IS NULL AND t.amount_cents >= ?
    ORDER BY t.amount_cents DESC`).all(oneTimeThreshold(db)) as TxnRow[];
  for (const r of big) {
    items.push({
      key: `onetime:${r.id}`,
      type: 'one_time',
      title: `Large payment: ${formatUsd(r.amountCents)} "${r.merchant}"`,
      detail: 'One-time items (home closing, car, tuition) are shown separately so they don\'t hide your normal monthly pattern.',
      count: 1,
      totalCents: r.amountCents,
      txns: [toReviewTxn(r)]
    });
  }

  return items;
}

function formatUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Math.abs(cents) / 100);
}

export type ReviewAnswer =
  | { action: 'assign_account'; txnIds: number[]; pattern: string; accountId?: number;
      newAccount?: { nickname: string; accountType: string; cardPolicy?: string } }
  | { action: 'set_kind'; txnIds: number[]; kind: 'spend' | 'income' | 'transfer' | 'refund' }
  | { action: 'keep_transfer'; txnIds: number[] }
  | { action: 'link'; outId: number; inId: number }
  | { action: 'household'; txnIds: number[]; name: string; personId?: number; newPersonName?: string }
  | { action: 'not_household'; name: string }
  | { action: 'one_time'; txnIds: number[]; value: boolean };

const fingerprintOf = (db: Db, id: number) =>
  (db.prepare('SELECT fingerprint FROM transactions WHERE id = ?').get(id) as { fingerprint: string } | undefined)?.fingerprint;

export function setKindManually(db: Db, id: number, kind: string): void {
  const fp = fingerprintOf(db, id);
  if (!fp) return;
  db.prepare(`UPDATE transactions SET kind = ?, kind_source = 'manual', reviewed = 1,
              transfer_via = CASE WHEN ? = 'transfer' THEN 'manual' ELSE NULL END WHERE id = ?`).run(kind, kind, id);
  saveDecision(db, fp, { kind, reviewed: 1 });
}

export function linkManually(db: Db, outId: number, inId: number): void {
  const rows = db.prepare('SELECT id, account_id, direction FROM transactions WHERE id IN (?, ?)').all(outId, inId) as { id: number; account_id: number; direction: string }[];
  const out = rows.find(r => r.id === outId);
  const inn = rows.find(r => r.id === inId);
  if (!out || !inn || out.account_id === inn.account_id) throw new UserError('Pick two transactions from different accounts');
  db.prepare('DELETE FROM transfer_links WHERE out_txn_id IN (?, ?) OR in_txn_id IN (?, ?)').run(outId, inId, outId, inId);
  db.prepare("INSERT INTO transfer_links (out_txn_id, in_txn_id, method, created_at) VALUES (?, ?, 'manual', ?)")
    .run(outId, inId, new Date().toISOString());
  setKindManually(db, outId, 'transfer');
  setKindManually(db, inId, 'transfer');
  db.prepare('UPDATE transactions SET counterparty_account_id = ? WHERE id = ?').run(inn.account_id, outId);
  db.prepare('UPDATE transactions SET counterparty_account_id = ? WHERE id = ?').run(out.account_id, inId);
}

/** Remove a link and remember that these two rows are not a pair. */
export function unlink(db: Db, linkId: number): void {
  const link = db.prepare(`
    SELECT l.out_txn_id, l.in_txn_id, o.fingerprint AS ofp, i.fingerprint AS ifp FROM transfer_links l
    JOIN transactions o ON o.id = l.out_txn_id JOIN transactions i ON i.id = l.in_txn_id WHERE l.id = ?`
  ).get(linkId) as { out_txn_id: number; in_txn_id: number; ofp: string; ifp: string } | undefined;
  if (!link) throw new UserError('Link not found');
  db.prepare('INSERT OR IGNORE INTO not_pairs (out_fingerprint, in_fingerprint) VALUES (?, ?)').run(link.ofp, link.ifp);
  db.prepare('DELETE FROM transfer_links WHERE id = ?').run(linkId);
  // Hand both rows back to the automatic rules
  for (const [id, fp] of [[link.out_txn_id, link.ofp], [link.in_txn_id, link.ifp]] as const) {
    db.prepare("UPDATE transactions SET kind_source = 'bank', reviewed = 0 WHERE id = ?").run(id);
    db.prepare('UPDATE decisions SET kind = NULL, reviewed = NULL WHERE fingerprint = ?').run(fp);
  }
}

function addToList(db: Db, table: 'accounts' | 'people', column: 'match_patterns' | 'aliases', id: number, value: string): void {
  const row = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE id = ?`).get(id) as { v: string } | undefined;
  if (!row) throw new UserError(`${table} ${id} not found`);
  const list = parseList(row.v);
  if (!list.some(x => x.toUpperCase() === value.toUpperCase())) list.push(value);
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(JSON.stringify(list), id);
}

export function answerReview(db: Db, a: ReviewAnswer): void {
  db.transaction(() => {
    switch (a.action) {
      case 'assign_account': {
        const pattern = a.pattern.trim();
        if (pattern.length < 4) throw new UserError('Pattern is too short; use at least 4 characters');
        let accountId = a.accountId;
        if (!accountId) {
          if (!a.newAccount?.nickname?.trim()) throw new UserError('Pick an account or name a new one');
          accountId = Number(db.prepare(`INSERT INTO accounts (profile_id, bank, account_type, nickname, is_tracked, card_policy)
            VALUES ('', ?, ?, ?, 0, ?)`).run(a.newAccount.nickname.trim(), a.newAccount.accountType || 'other',
            a.newAccount.nickname.trim(), a.newAccount.accountType === 'credit' ? (a.newAccount.cardPolicy || 'will_import') : null).lastInsertRowid);
        }
        addToList(db, 'accounts', 'match_patterns', accountId, pattern);
        break;
      }
      case 'set_kind':
        for (const id of a.txnIds) setKindManually(db, id, a.kind);
        break;
      case 'keep_transfer':
        for (const id of a.txnIds) {
          const fp = fingerprintOf(db, id);
          db.prepare('UPDATE transactions SET reviewed = 1 WHERE id = ?').run(id);
          if (fp) saveDecision(db, fp, { reviewed: 1 });
        }
        break;
      case 'link':
        linkManually(db, a.outId, a.inId);
        break;
      case 'household': {
        let personId = a.personId;
        if (!personId) {
          if (!a.newPersonName?.trim()) throw new UserError('Pick a person or enter a name');
          personId = Number(db.prepare('INSERT INTO people (name, color) VALUES (?, ?)').run(a.newPersonName.trim(), pickColor(db)).lastInsertRowid);
        }
        addToList(db, 'people', 'aliases', personId, a.name);
        break;
      }
      case 'not_household': {
        const list = parseList(getSetting(db, 'p2p_not_household', '[]'));
        list.push(a.name.toUpperCase());
        setSetting(db, 'p2p_not_household', JSON.stringify([...new Set(list)]));
        break;
      }
      case 'one_time':
        for (const id of a.txnIds) {
          const fp = fingerprintOf(db, id);
          db.prepare('UPDATE transactions SET is_one_time = ? WHERE id = ?').run(a.value ? 1 : 0, id);
          if (fp) saveDecision(db, fp, { is_one_time: a.value ? 1 : 0 });
        }
        break;
      default:
        throw new UserError('Unknown review action');
    }
  })();
  recompute(db);
}

const PERSON_COLORS = ['#6366F1', '#F59E0B', '#10B981', '#EC4899', '#06B6D4', '#8B5CF6', '#EF4444', '#84CC16'];
export function pickColor(db: Db): string {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n;
  return PERSON_COLORS[n % PERSON_COLORS.length];
}
