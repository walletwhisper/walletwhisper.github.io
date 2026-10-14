import type { Db } from './db.js';
import { accountLabel } from './importer.js';
import { getReviewItems } from './review.js';

export const SPENDING = "t.kind IN ('spend', 'refund', 'fee')";

export interface Filters {
  from?: string;
  to?: string;
  month?: string;          // YYYY-MM
  categoryId?: number;
  personId?: number | 'none';
  accountId?: number;
  /** Excel-style column filters on the transactions list: keep only these values (any of them) */
  merchants?: string[];
  categoryIds?: number[];
  personIds?: (number | 'none')[];
  accountIds?: number[];
  q?: string;
  /** Transactions list: column to sort by (default date) and direction (default depends on the column) */
  sort?: SortColumn;
  dir?: 'asc' | 'desc';
  /** Transactions list: only the ones left out of the charts */
  hiddenOnly?: boolean;
}

export type SortColumn = 'date' | 'merchant' | 'account' | 'person' | 'category' | 'amount';
const SORT_COLUMNS: SortColumn[] = ['date', 'merchant', 'account', 'person', 'category', 'amount'];

/** First click on a column header: newest / largest first for date and amount, A→Z for names. */
export const DEFAULT_DIR: Record<SortColumn, 'asc' | 'desc'> = {
  date: 'desc', amount: 'desc', merchant: 'asc', account: 'asc', person: 'asc', category: 'asc',
};

/** ORDER BY for the transactions list. Blank people always sort last; ties fall back to newest first. */
function orderBy(f: Filters): string {
  const col = f.sort ?? 'date';
  const dir = (f.dir ?? DEFAULT_DIR[col]).toUpperCase();
  const key: Record<SortColumn, string> = {
    date: `t.txn_date ${dir}, t.id ${dir}`,
    amount: `t.amount_cents ${dir}`,
    merchant: `t.merchant COLLATE NOCASE ${dir}`,
    account: `COALESCE(a.nickname, a.bank) COLLATE NOCASE ${dir}, a.last4 ${dir}`,
    person: `p.name IS NULL, p.name COLLATE NOCASE ${dir}`,
    category: `c.name COLLATE NOCASE ${dir}`,
  };
  return col === 'date' ? key.date : `${key[col]}, t.txn_date DESC, t.id DESC`;
}

/** Parse query-string filters, ignoring anything malformed. */
export function parseFilters(q: Record<string, unknown>): Filters {
  const str = (k: string) => (typeof q[k] === 'string' && q[k] !== '' ? (q[k] as string) : undefined);
  const int = (k: string) => { const v = str(k); return v && /^\d+$/.test(v) ? Number(v) : undefined; };
  const date = (k: string) => { const v = str(k); return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined; };
  const person = str('personId');
  const ids = (k: string) => {
    const list = (str(k) ?? '').split(',').filter(x => /^\d+$/.test(x)).map(Number);
    return list.length ? list.slice(0, 500) : undefined;
  };
  const personList = (str('personIds') ?? '').split(',').filter(x => x === 'none' || /^\d+$/.test(x))
    .map(x => (x === 'none' ? 'none' as const : Number(x)));
  let merchants: string[] | undefined;
  try {
    const m = JSON.parse(str('merchants') ?? 'null');
    if (Array.isArray(m)) merchants = m.filter((x): x is string => typeof x === 'string').slice(0, 500);
  } catch { /* ignore malformed */ }
  return {
    merchants: merchants?.length ? merchants : undefined,
    categoryIds: ids('categoryIds'),
    accountIds: ids('accountIds'),
    personIds: personList.length ? personList.slice(0, 500) : undefined,
    from: date('from'),
    to: date('to'),
    month: str('month') && /^\d{4}-\d{2}$/.test(str('month')!) ? str('month') : undefined,
    categoryId: int('categoryId'),
    personId: person === 'none' ? 'none' : int('personId'),
    accountId: int('accountId'),
    q: str('q')?.slice(0, 100),
    sort: SORT_COLUMNS.includes(str('sort') as SortColumn) ? (str('sort') as SortColumn) : undefined,
    dir: str('dir') === 'asc' || str('dir') === 'desc' ? (str('dir') as 'asc' | 'desc') : undefined,
    hiddenOnly: str('hidden') === '1'
  };
}

interface Where { sql: string; params: unknown[] }

/** SQL conditions for the filters. `skip` leaves some out (e.g. charts that show all months). */
function buildWhere(f: Filters, skip: (keyof Filters)[] = []): Where {
  const parts: string[] = ['1=1'];
  const params: unknown[] = [];
  const use = (k: keyof Filters) => f[k] !== undefined && !skip.includes(k);
  if (use('from')) { parts.push('t.txn_date >= ?'); params.push(f.from); }
  if (use('to')) { parts.push('t.txn_date <= ?'); params.push(f.to); }
  if (use('month')) { parts.push("substr(t.txn_date, 1, 7) = ?"); params.push(f.month); }
  if (use('categoryId')) { parts.push('t.category_id = ?'); params.push(f.categoryId); }
  if (use('accountId')) { parts.push('t.account_id = ?'); params.push(f.accountId); }
  if (use('personId')) {
    if (f.personId === 'none') parts.push('t.person_id IS NULL');
    else { parts.push('t.person_id = ?'); params.push(f.personId); }
  }
  if (use('q')) { parts.push('(t.merchant LIKE ? OR t.raw_description LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
  const inList = (col: string, values: unknown[]) => {
    parts.push(`${col} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };
  if (use('merchants')) inList('t.merchant', f.merchants!);
  if (use('categoryIds')) inList('t.category_id', f.categoryIds!);
  if (use('accountIds')) inList('t.account_id', f.accountIds!);
  if (use('personIds')) {
    const ids = f.personIds!.filter(x => x !== 'none');
    const none = f.personIds!.includes('none');
    const clauses = [...(ids.length ? [`t.person_id IN (${ids.map(() => '?').join(',')})`] : []), ...(none ? ['t.person_id IS NULL'] : [])];
    parts.push(`(${clauses.join(' OR ')})`);
    params.push(...ids);
  }
  return { sql: parts.join(' AND '), params };
}

// Transactions the user unticked ("Show in charts") are left out of every chart and total.
// Stored in the is_one_time column, which predates the per-transaction switch.
const inCharts = 'COALESCE(t.is_one_time, 0) = 0';
const hiddenFromCharts = 't.is_one_time = 1';
export const IN_CHARTS = inCharts;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function getSummary(db: Db, f: Filters) {
  const w = buildWhere(f);
  const spendWhere = `${w.sql} AND ${SPENDING} AND ${inCharts}`;

  const totals = db.prepare(`SELECT COALESCE(SUM(t.amount_cents), 0) AS total, COUNT(*) AS n FROM transactions t WHERE ${spendWhere}`)
    .get(...w.params) as { total: number; n: number };
  const hidden = db.prepare(`SELECT COALESCE(SUM(t.amount_cents), 0) AS total, COUNT(*) AS n FROM transactions t
    WHERE ${w.sql} AND ${SPENDING} AND ${hiddenFromCharts}`).get(...w.params) as { total: number; n: number };
  const wIncome = buildWhere(f, ['categoryId', 'categoryIds']);
  const moneyIn = (db.prepare(`SELECT COALESCE(SUM(t.amount_cents), 0) AS total FROM transactions t WHERE ${wIncome.sql} AND t.kind = 'income'`)
    .get(...wIncome.params) as { total: number }).total;

  const pct = (cents: number) => (totals.total > 0 ? Math.round((cents / totals.total) * 1000) / 10 : 0);

  const byCategory = (db.prepare(`
    SELECT c.id, c.name, c.color, SUM(t.amount_cents) AS cents, COUNT(*) AS count
    FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE ${spendWhere} GROUP BY c.id HAVING cents > 0 ORDER BY cents DESC`).all(...w.params) as any[])
    .map(r => ({ ...r, pct: pct(r.cents) }));

  const byPerson = (db.prepare(`
    SELECT t.person_id AS id, COALESCE(p.name, 'Unassigned') AS name, COALESCE(p.color, '#64748B') AS color,
           SUM(t.amount_cents) AS cents, COUNT(*) AS count
    FROM transactions t LEFT JOIN people p ON p.id = t.person_id
    WHERE ${spendWhere} GROUP BY t.person_id ORDER BY cents DESC`).all(...w.params) as any[])
    .map(r => ({ ...r, pct: pct(r.cents) }));

  const byAccount = (db.prepare(`
    SELECT a.id, a.nickname, a.bank, a.account_type, a.last4, SUM(t.amount_cents) AS cents, COUNT(*) AS count
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE ${spendWhere} GROUP BY a.id ORDER BY cents DESC`).all(...w.params) as any[])
    .map(r => ({ id: r.id, name: accountLabel(r), cents: r.cents, count: r.count, pct: pct(r.cents) }));

  // Monthly bars show every month (not just the selected range) for context
  const wMonths = buildWhere(f, ['from', 'to', 'month']);
  const completeness = monthCompleteness(db);
  const byMonth = (db.prepare(`
    SELECT substr(t.txn_date, 1, 7) AS month,
           SUM(CASE WHEN ${inCharts} THEN t.amount_cents ELSE 0 END) AS cents,
           SUM(CASE WHEN ${hiddenFromCharts} THEN t.amount_cents ELSE 0 END) AS hiddenCents
    FROM transactions t WHERE ${wMonths.sql} AND ${SPENDING}
    GROUP BY month ORDER BY month`).all(...wMonths.params) as { month: string; cents: number; hiddenCents: number }[])
    .map(m => ({ ...m, complete: completeness.get(m.month) ?? true }));

  // Typical month: median of the last 6 complete months before the period being viewed
  const endMonth = (f.month || f.to?.slice(0, 7) || byMonth[byMonth.length - 1]?.month) ?? '';
  const prior = byMonth.filter(m => m.month < endMonth && m.complete).slice(-6);
  const typicalMonthCents = median(prior.map(m => m.cents));

  const range = db.prepare('SELECT MIN(txn_date) AS min, MAX(txn_date) AS max FROM transactions').get() as { min: string | null; max: string | null };

  return {
    totalSpend: totals.total,
    totalTxnCount: totals.n,
    hiddenCents: hidden.total,
    hiddenCount: hidden.n,
    moneyIn,
    byCategory,
    byPerson,
    byAccount,
    byMonth,
    typicalMonthCents,
    typicalMonthBasis: prior.map(m => m.month),
    reviewCount: getReviewItems(db).length,
    dataRange: range
  };
}

export type StackBy = 'category' | 'person' | 'account';

export function getTrends(db: Db, f: Filters, months: number, stack: StackBy) {
  const w = buildWhere(f, ['from', 'to', 'month']);
  const keyExpr = stack === 'category' ? 't.category_id' : stack === 'person' ? 'COALESCE(t.person_id, 0)' : 't.account_id';

  const rows = db.prepare(`
    SELECT substr(t.txn_date, 1, 7) AS month, ${keyExpr} AS key, SUM(t.amount_cents) AS cents
    FROM transactions t WHERE ${w.sql} AND ${SPENDING} AND ${inCharts}
    GROUP BY month, key`).all(...w.params) as { month: string; key: number; cents: number }[];
  const hiddenRows = db.prepare(`
    SELECT substr(t.txn_date, 1, 7) AS month, SUM(t.amount_cents) AS cents
    FROM transactions t WHERE ${w.sql} AND ${SPENDING} AND ${hiddenFromCharts} GROUP BY month`).all(...w.params) as { month: string; cents: number }[];

  const allMonths = [...new Set(rows.map(r => r.month))].sort();
  const last = f.to?.slice(0, 7) || allMonths[allMonths.length - 1];
  const monthList: string[] = [];
  if (last) {
    let [y, m] = last.split('-').map(Number);
    for (let i = 0; i < months; i++) {
      monthList.unshift(`${y}-${String(m).padStart(2, '0')}`);
      m--; if (m === 0) { m = 12; y--; }
    }
  }
  const first = allMonths[0];
  const visible = monthList.filter(m => !first || m >= first);

  // Series names/colors; categories beyond the top 8 are grouped as "Other"
  const meta = new Map<number, { name: string; color: string }>();
  if (stack === 'category') {
    for (const c of db.prepare('SELECT id, name, color FROM categories').all() as any[]) meta.set(c.id, { name: c.name, color: c.color });
  } else if (stack === 'person') {
    meta.set(0, { name: 'Unassigned', color: '#64748B' });
    for (const p of db.prepare('SELECT id, name, color FROM people').all() as any[]) meta.set(p.id, { name: p.name, color: p.color });
  } else {
    const palette = ['#6366F1', '#F59E0B', '#10B981', '#EC4899', '#06B6D4', '#8B5CF6', '#EF4444', '#84CC16'];
    (db.prepare('SELECT id, nickname, bank, account_type, last4 FROM accounts WHERE is_tracked = 1 ORDER BY id').all() as any[])
      .forEach((a, i) => meta.set(a.id, { name: accountLabel(a), color: palette[i % palette.length] }));
  }

  const inView = rows.filter(r => visible.includes(r.month));
  const totalsByKey = new Map<number, number>();
  for (const r of inView) totalsByKey.set(r.key, (totalsByKey.get(r.key) || 0) + r.cents);
  const ranked = [...totalsByKey.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const top = stack === 'category' ? ranked.slice(0, 8) : ranked;
  const OTHER = -1;
  const keyOf = (k: number) => (top.includes(k) ? k : OTHER);

  const series = top.map(k => ({ key: String(k), name: meta.get(k)?.name ?? 'Unknown', color: meta.get(k)?.color ?? '#94A3B8', totalCents: totalsByKey.get(k) || 0 }));
  if (ranked.length > top.length) {
    series.push({ key: String(OTHER), name: 'Other', color: '#94A3B8',
      totalCents: ranked.slice(top.length).reduce((s, k) => s + (totalsByKey.get(k) || 0), 0) });
  }

  const completeness = monthCompleteness(db);
  const data = visible.map(month => {
    const segments: Record<string, number> = {};
    let total = 0;
    for (const r of inView.filter(r => r.month === month)) {
      const k = String(keyOf(r.key));
      segments[k] = (segments[k] || 0) + r.cents;
      total += r.cents;
    }
    return {
      month,
      complete: completeness.get(month) ?? true,
      totalCents: total,
      hiddenCents: hiddenRows.find(o => o.month === month)?.cents || 0,
      segments
    };
  });

  // Money in for the same months: income only (transfers between own accounts are never earnings).
  // Person/account filters apply; a category filter doesn't, since income has no spending category.
  const wIn = buildWhere(f, ['from', 'to', 'month', 'categoryId', 'categoryIds']);
  const incomeRows = db.prepare(`
    SELECT substr(t.txn_date, 1, 7) AS month, t.merchant AS source, SUM(t.amount_cents) AS cents
    FROM transactions t WHERE ${wIn.sql} AND t.kind = 'income'
    GROUP BY month, source`).all(...wIn.params) as { month: string; source: string; cents: number }[];
  const income = visible.map(month => {
    const sources = incomeRows.filter(r => r.month === month && r.cents > 0).sort((a, b) => b.cents - a.cents);
    return {
      month,
      complete: completeness.get(month) ?? true,
      cents: sources.reduce((s, r) => s + r.cents, 0),
      topSources: sources.slice(0, 4).map(r => ({ name: r.source, cents: r.cents })),
      otherSources: Math.max(0, sources.length - 4),
    };
  });

  return { stack, months: data, series, income };
}

// ---------- Coverage ----------

const DAY = 86_400_000;
const toDay = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const fromDay = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const TRAILING_TOLERANCE_DAYS = 7;

export interface CoverageAccount {
  id: number;
  name: string;
  tracked: boolean;
  cardPolicy: string | null;
  ranges: { from: string; to: string }[];
  expectedFrom: string | null;
  months: Record<string, 'full' | 'partial' | 'missing' | 'n/a'>;
  gapMonths: string[];
}

export function getCoverage(db: Db): { months: string[]; accounts: CoverageAccount[] } {
  const accounts = db.prepare('SELECT id, nickname, bank, account_type, last4, is_tracked, card_policy FROM accounts ORDER BY is_tracked DESC, id')
    .all() as any[];
  const imports = db.prepare('SELECT account_id, min_date, max_date FROM imports WHERE min_date IS NOT NULL').all() as { account_id: number; min_date: string; max_date: string }[];
  const evidence = db.prepare(`SELECT counterparty_account_id AS id, MIN(txn_date) AS first FROM transactions
    WHERE counterparty_account_id IS NOT NULL GROUP BY counterparty_account_id`).all() as { id: number; first: string }[];

  if (imports.length === 0) return { months: [], accounts: [] };
  const globalMin = Math.min(...imports.map(i => toDay(i.min_date)), ...evidence.map(e => toDay(e.first)));
  const globalMax = Math.max(...imports.map(i => toDay(i.max_date)));

  const months: string[] = [];
  for (let d = new Date(fromDay(globalMin).slice(0, 7) + '-01T00:00:00Z'); d.getTime() / DAY <= globalMax; d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.push(d.toISOString().slice(0, 7));
  }

  const result: CoverageAccount[] = [];
  for (const a of accounts) {
    const tracked = a.is_tracked === 1;
    const needsImport = !tracked && a.account_type === 'credit' && a.card_policy === 'will_import';
    const ranges = imports.filter(i => i.account_id === a.id).map(i => [toDay(i.min_date), toDay(i.max_date)] as [number, number]);
    const firstEvidence = evidence.find(e => e.id === a.id)?.first;
    if (!tracked && !needsImport) continue; // untracked savings/brokerage: nothing to import

    const starts = [...ranges.map(r => r[0]), ...(firstEvidence ? [toDay(firstEvidence)] : [])];
    if (starts.length === 0) continue;
    const expectedStart = Math.min(...starts);
    const ownMax = ranges.length ? Math.max(...ranges.map(r => r[1])) : -Infinity;
    // Exports taken a few days apart shouldn't count as a gap at the end
    const expectedEnd = ownMax >= globalMax - TRAILING_TOLERANCE_DAYS ? ownMax : globalMax;

    const covered = (d: number) => ranges.some(([s, e]) => d >= s && d <= e);
    const monthStatus: CoverageAccount['months'] = {};
    const gapMonths: string[] = [];
    for (const m of months) {
      const mStart = toDay(`${m}-01`);
      const next = new Date(`${m}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
      const mEnd = next.getTime() / DAY - 1;
      const from = Math.max(mStart, expectedStart);
      const to = Math.min(mEnd, expectedEnd);
      if (from > to) { monthStatus[m] = 'n/a'; continue; }
      let hit = 0;
      for (let d = from; d <= to; d++) if (covered(d)) hit++;
      const status = hit === to - from + 1 ? 'full' : hit === 0 ? 'missing' : 'partial';
      monthStatus[m] = status;
      if (status !== 'full') gapMonths.push(m);
    }

    result.push({
      id: a.id,
      name: accountLabel(a),
      tracked,
      cardPolicy: a.card_policy,
      ranges: ranges.map(([s, e]) => ({ from: fromDay(s), to: fromDay(e) })),
      expectedFrom: fromDay(expectedStart),
      months: monthStatus,
      gapMonths
    });
  }
  return { months, accounts: result };
}

/** month -> true if every account we expect data from is fully covered that month. */
export function monthCompleteness(db: Db): Map<string, boolean> {
  const cov = getCoverage(db);
  const map = new Map<string, boolean>();
  for (const m of cov.months) map.set(m, cov.accounts.every(a => a.months[m] === 'full' || a.months[m] === 'n/a'));
  return map;
}

// ---------- Transactions ----------

function kindClause(kind: string): string {
  return kind === 'all' ? '' :
    kind === 'transfer' ? " AND t.kind = 'transfer'" :
    kind === 'income' ? " AND t.kind = 'income'" :
    ` AND ${SPENDING}`;
}

export type FilterColumn = 'merchant' | 'account' | 'person' | 'category';

/**
 * The values a column filter offers, like Excel: what appears in the list under every *other*
 * filter, with how many rows each has. Values already chosen for this column stay offered.
 */
export function getColumnValues(db: Db, f: Filters, kind: string, column: FilterColumn) {
  const skip: Record<FilterColumn, (keyof Filters)[]> = {
    merchant: ['merchants'], account: ['accountId', 'accountIds'], person: ['personId', 'personIds'], category: ['categoryId', 'categoryIds'],
  };
  const w = buildWhere(f, skip[column]);
  const where = `${w.sql}${kindClause(kind)}${f.hiddenOnly ? ` AND ${hiddenFromCharts}` : ''}`;
  const select: Record<FilterColumn, string> = {
    merchant: `SELECT t.merchant AS value, t.merchant AS label, NULL AS color, COUNT(*) AS count
      FROM transactions t WHERE ${where} GROUP BY t.merchant ORDER BY t.merchant COLLATE NOCASE`,
    category: `SELECT c.id AS value, c.name AS label, c.color AS color, COUNT(*) AS count
      FROM transactions t JOIN categories c ON c.id = t.category_id WHERE ${where} GROUP BY c.id ORDER BY c.name COLLATE NOCASE`,
    person: `SELECT COALESCE(CAST(p.id AS TEXT), 'none') AS value, COALESCE(p.name, 'Unassigned') AS label, p.color AS color, COUNT(*) AS count
      FROM transactions t LEFT JOIN people p ON p.id = t.person_id WHERE ${where} GROUP BY p.id ORDER BY p.name IS NULL, p.name COLLATE NOCASE`,
    account: `SELECT a.id AS value, a.nickname, a.bank, a.account_type, a.last4, NULL AS color, COUNT(*) AS count
      FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE ${where} GROUP BY a.id ORDER BY COALESCE(a.nickname, a.bank) COLLATE NOCASE`,
  };
  const rows = db.prepare(select[column]).all(...w.params) as any[];
  return rows.slice(0, 3000).map(r => ({
    value: String(r.value),
    label: column === 'account' ? accountLabel(r) : String(r.label),
    color: r.color ?? null,
    count: r.count,
  }));
}

export function getTransactions(db: Db, f: Filters, kind: string, limit = 2000) {
  const w = buildWhere(f);
  const where = `${w.sql}${kindClause(kind)}${f.hiddenOnly ? ` AND ${hiddenFromCharts}` : ''}`;

  // The footer total counts only rows shown in charts, so it matches the chart slice that was clicked
  const agg = db.prepare(`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN ${inCharts} THEN t.amount_cents END), 0) AS sum,
           COALESCE(SUM(CASE WHEN ${hiddenFromCharts} THEN t.amount_cents END), 0) AS hiddenSum,
           COUNT(CASE WHEN ${hiddenFromCharts} THEN 1 END) AS hiddenCount
    FROM transactions t WHERE ${where}`).get(...w.params) as { n: number; sum: number; hiddenSum: number; hiddenCount: number };

  const rows = db.prepare(`
    SELECT t.id, t.txn_date AS date, t.raw_description AS rawDescription, t.merchant, t.amount_cents AS amountCents,
           t.kind, t.kind_source AS kindSource, t.transfer_via AS transferVia, t.direction,
           t.category_id AS categoryId, t.category_source AS categorySource, t.bank_category AS bankCategory,
           c.name AS categoryName, c.color AS categoryColor,
           t.person_id AS personId, t.person_source AS personSource, p.name AS personName, p.color AS personColor,
           t.is_one_time AS hidden,
           a.id AS accountId, a.nickname, a.bank, a.account_type, a.last4,
           cp.nickname AS cpNickname, cp.bank AS cpBank, cp.account_type AS cpType, cp.last4 AS cpLast4,
           l.id AS linkId, l.method AS linkMethod,
           partner.txn_date AS partnerDate
    FROM transactions t
    JOIN categories c ON c.id = t.category_id
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN people p ON p.id = t.person_id
    LEFT JOIN accounts cp ON cp.id = t.counterparty_account_id
    LEFT JOIN transfer_links l ON l.out_txn_id = t.id OR l.in_txn_id = t.id
    LEFT JOIN transactions partner ON partner.id = CASE WHEN l.out_txn_id = t.id THEN l.in_txn_id ELSE l.out_txn_id END
    WHERE ${where}
    ORDER BY ${orderBy(f)}
    LIMIT ?`).all(...w.params, limit) as any[];

  const transactions = rows.map(r => ({
    id: r.id, date: r.date, rawDescription: r.rawDescription, merchant: r.merchant, amountCents: r.amountCents,
    kind: r.kind, kindSource: r.kindSource, transferVia: r.transferVia, direction: r.direction,
    categoryId: r.categoryId, categorySource: r.categorySource, bankCategory: r.bankCategory,
    categoryName: r.categoryName, categoryColor: r.categoryColor,
    personId: r.personId, personSource: r.personSource, personName: r.personName, personColor: r.personColor,
    hidden: r.hidden === 1,
    accountId: r.accountId,
    account: accountLabel(r),
    counterparty: r.cpBank ? accountLabel({ nickname: r.cpNickname, bank: r.cpBank, account_type: r.cpType, last4: r.cpLast4 }) : null,
    linkId: r.linkId, linkMethod: r.linkMethod, partnerDate: r.partnerDate
  }));

  return {
    transactions, count: agg.n, sumCents: agg.sum, hiddenCents: agg.hiddenSum, hiddenCount: agg.hiddenCount,
    truncated: agg.n > transactions.length
  };
}
