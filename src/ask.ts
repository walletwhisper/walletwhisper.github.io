import type { Db } from './db.js';
import type { QuestionPlan } from './llm.js';
import { IN_CHARTS, SPENDING } from './reports.js';
import { parseList } from './ledger.js';

/**
 * Answers a planned spending question from the local database: the period's total, the same
 * comparison a person would make (previous period, same period last year), the monthly trend,
 * and where the money went. Nothing here leaves the computer.
 */

interface Period { label: string; from: string; to: string }
interface PeriodTotal extends Period { cents: number; count: number }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

function addMonths(s: string, n: number): string {
  const d = parse(s);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const day = Math.min(d.getUTCDate(), lastDayOfMonth(y, m));
  return iso(new Date(Date.UTC(y, m, day)));
}

/** Whole calendar months: from is the 1st, to is a month end. Returns the number of months. */
function wholeMonths(p: Period): number | null {
  const f = parse(p.from);
  const t = parse(p.to);
  if (f.getUTCDate() !== 1 || t.getUTCDate() !== lastDayOfMonth(t.getUTCFullYear(), t.getUTCMonth())) return null;
  return (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + t.getUTCMonth() - f.getUTCMonth() + 1;
}

function labelFor(from: string, to: string): string {
  const f = parse(from);
  const t = parse(to);
  const months = wholeMonths({ label: '', from, to });
  if (months === 1) return `${MONTHS[f.getUTCMonth()]} ${f.getUTCFullYear()}`;
  if (months === 12 && f.getUTCMonth() === 0) return String(f.getUTCFullYear());
  const short = (d: Date) => `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;
  return f.getUTCFullYear() === t.getUTCFullYear()
    ? `${short(f)} – ${short(t)}, ${t.getUTCFullYear()}`
    : `${short(f)}, ${f.getUTCFullYear()} – ${short(t)}, ${t.getUTCFullYear()}`;
}

/** The period just before, of the same length (whole months stay whole months, and this month so far
 *  compares with the same days of last month). */
function previousPeriod(p: Period): Period {
  if (p.from.endsWith('-01') && p.from.slice(0, 7) === p.to.slice(0, 7) && !wholeMonths(p)) {
    const from = addMonths(p.from, -1);
    const to = addMonths(p.to, -1);
    return { from, to, label: labelFor(from, to) };
  }
  const n = wholeMonths(p);
  if (n) {
    const from = addMonths(p.from, -n);
    const toStart = addMonths(p.from, -1);
    const t = parse(toStart);
    const to = iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), lastDayOfMonth(t.getUTCFullYear(), t.getUTCMonth()))));
    return { from, to, label: labelFor(from, to) };
  }
  const days = Math.round((parse(p.to).getTime() - parse(p.from).getTime()) / 86_400_000) + 1;
  const to = iso(new Date(parse(p.from).getTime() - 86_400_000));
  const from = iso(new Date(parse(to).getTime() - (days - 1) * 86_400_000));
  return { from, to, label: labelFor(from, to) };
}

function yearEarlier(p: Period): Period {
  const from = addMonths(p.from, -12);
  const to = addMonths(p.to, -12);
  return { from, to, label: labelFor(from, to) };
}

export interface AskAnswer {
  understood: boolean;
  clarification: string | null;
  headline: string;
  subject: string;
  period: PeriodTotal;
  previous: PeriodTotal;
  lastYear: PeriodTotal;
  months: { month: string; cents: number; inPeriod: boolean }[];
  topMerchants: { merchant: string; cents: number; count: number }[];
  byCategory: { id: number; name: string; color: string; cents: number }[];
  filters: { categoryIds: number[]; personId: number | null; merchant: string | null };
  notes: string[];
}

const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/** "That's $12 more than September 2026." Periods with nothing recorded are named, not compared. */
function comparisons(now: number, periods: PeriodTotal[]): string {
  const withData = periods.filter(p => p.count > 0).map(p => compare(now, p));
  const empty = periods.filter(p => p.count === 0).map(p => p.label);
  const parts: string[] = [];
  if (withData.length) parts.push(`That's ${withData.join(', and ')}.`);
  if (empty.length) parts.push(`There's no spending recorded for ${empty.join(' or ')} to compare with.`);
  return parts.join(' ');
}

function compare(now: number, then: PeriodTotal): string {
  const diff = now - then.cents;
  if (Math.abs(diff) < 100) return `about the same as ${then.label}`;
  const pct = then.cents > 0 ? ` (${Math.round(Math.abs(diff) / then.cents * 100)}%)` : '';
  return `${usd(Math.abs(diff))}${pct} ${diff > 0 ? 'more' : 'less'} than ${then.label}`;
}

export function answerQuestion(db: Db, plan: QuestionPlan): AskAnswer | { understood: false; clarification: string } {
  if (!plan.understood) {
    return { understood: false, clarification: plan.clarification || 'Try asking about your spending, e.g. "How much did we spend on dining last month?"' };
  }
  const notes: string[] = [];

  const cats = db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[];
  const categoryIds = plan.categories.map(n => cats.find(c => c.name === n)?.id).filter((x): x is number => x !== undefined);

  let personId: number | null = null;
  let personName: string | null = null;
  if (plan.person) {
    const wanted = plan.person.trim().toLowerCase();
    const people = db.prepare('SELECT id, name, aliases FROM people').all() as { id: number; name: string; aliases: string }[];
    const match = people.find(p => p.name.toLowerCase() === wanted || p.name.toLowerCase().split(/\s+/)[0] === wanted
      || parseList(p.aliases).some(a => a.toLowerCase() === wanted));
    if (match) { personId = match.id; personName = match.name; }
    else notes.push(`No one named "${plan.person}" is set up under Accounts → People, so this covers everyone.`);
  }
  const merchant = plan.merchant?.trim() || null;

  // Shared filter (everything except the date range)
  const parts = [SPENDING, IN_CHARTS];
  const params: unknown[] = [];
  if (categoryIds.length) { parts.push(`t.category_id IN (${categoryIds.map(() => '?').join(',')})`); params.push(...categoryIds); }
  if (personId !== null) { parts.push('t.person_id = ?'); params.push(personId); }
  if (merchant) { parts.push('(t.merchant LIKE ? OR t.raw_description LIKE ?)'); params.push(`%${merchant}%`, `%${merchant}%`); }
  const where = parts.join(' AND ');

  const totalFor = (p: Period): PeriodTotal => {
    const r = db.prepare(`SELECT COALESCE(SUM(t.amount_cents), 0) AS cents, COUNT(*) AS count FROM transactions t
      WHERE ${where} AND t.txn_date BETWEEN ? AND ?`).get(...params, p.from, p.to) as { cents: number; count: number };
    return { ...p, ...r };
  };

  const main: Period = { from: plan.from, to: plan.to, label: plan.periodLabel || labelFor(plan.from, plan.to) };
  const period = totalFor(main);
  const previous = totalFor(previousPeriod(main));
  const lastYear = totalFor(yearEarlier(main));

  // Monthly trend: the 13 months ending with the period's last month
  const endMonth = plan.to.slice(0, 7);
  const firstMonth = addMonths(`${endMonth}-01`, -12).slice(0, 7);
  const monthRows = db.prepare(`SELECT substr(t.txn_date, 1, 7) AS month, SUM(t.amount_cents) AS cents FROM transactions t
    WHERE ${where} AND substr(t.txn_date, 1, 7) BETWEEN ? AND ? GROUP BY month`).all(...params, firstMonth, endMonth) as { month: string; cents: number }[];
  const months: AskAnswer['months'] = [];
  for (let m = `${firstMonth}-01`; m.slice(0, 7) <= endMonth; m = addMonths(m, 1)) {
    const key = m.slice(0, 7);
    months.push({ month: key, cents: monthRows.find(r => r.month === key)?.cents ?? 0, inPeriod: key >= plan.from.slice(0, 7) && key <= endMonth });
  }

  const topMerchants = db.prepare(`SELECT t.merchant, SUM(t.amount_cents) AS cents, COUNT(*) AS count FROM transactions t
    WHERE ${where} AND t.txn_date BETWEEN ? AND ? GROUP BY t.merchant HAVING cents > 0 ORDER BY cents DESC LIMIT 5`)
    .all(...params, plan.from, plan.to) as AskAnswer['topMerchants'];

  const byCategory = categoryIds.length === 1 ? [] : db.prepare(`SELECT c.id, c.name, c.color, SUM(t.amount_cents) AS cents
    FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE ${where} AND t.txn_date BETWEEN ? AND ? GROUP BY c.id HAVING cents > 0 ORDER BY cents DESC LIMIT 8`)
    .all(...params, plan.from, plan.to) as AskAnswer['byCategory'];

  const what = [
    categoryIds.length ? plan.categories.join(' and ') : merchant ? null : 'everything',
    merchant ? `at ${merchant}` : null,
  ].filter(Boolean).join(' ');
  const subject = categoryIds.length ? `on ${what}` : merchant ? what : 'in total';
  const who = personName ? `${personName} spent` : 'You spent';

  const range = db.prepare('SELECT MIN(txn_date) AS min, MAX(txn_date) AS max FROM transactions').get() as { min: string | null; max: string | null };
  if (range.max && plan.from > range.max) notes.push(`Your imported statements end on ${range.max}, so there's nothing to show for ${period.label} yet.`);
  else if (range.max && plan.to > range.max) notes.push(`Your imported statements end on ${range.max}, so ${period.label} may be incomplete.`);

  const headline = period.count === 0
    ? `No spending ${subject === 'in total' ? '' : subject + ' '}found for ${period.label}.`
    : `${who} ${usd(period.cents)} ${subject} in ${period.label}, across ${period.count} transaction${period.count === 1 ? '' : 's'}. ` +
      comparisons(period.cents, [previous, lastYear]);

  return {
    understood: true,
    clarification: null,
    headline,
    subject,
    period, previous, lastYear,
    months,
    topMerchants,
    byCategory,
    filters: { categoryIds, personId, merchant },
    notes,
  };
}
