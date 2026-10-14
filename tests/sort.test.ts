import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { openDb } from '../src/db.js';
import { finishImports, importCsvContent } from '../src/importer.js';
import { getColumnValues, getSummary, getTransactions, getTrends, parseFilters } from '../src/reports.js';
import type { SortColumn } from '../src/reports.js';

const fixture = (name: string) => fs.readFileSync(path.resolve(__dirname, 'fixtures', name), 'utf8');
const db = openDb(':memory:');
for (const f of ['Chase1234_Activity_20261031.CSV', 'Chase5678_Activity_20261031.CSV']) importCsvContent(db, f, fixture(f));
finishImports(db);

const list = (sort: SortColumn, dir?: 'asc' | 'desc') => getTransactions(db, { sort, dir }, 'all').transactions;
const isSorted = <T>(xs: T[], cmp: (a: T, b: T) => number) => xs.every((x, i) => i === 0 || cmp(xs[i - 1], x) <= 0);
const text = (a: string | null, b: string | null) => (a ?? '').localeCompare(b ?? '', 'en', { sensitivity: 'base' });

describe('Transactions list: click a column header to sort', () => {
  it('T-01: date is newest first by default, oldest first when reversed', () => {
    expect(isSorted(list('date'), (a, b) => b.date.localeCompare(a.date))).toBe(true);
    expect(isSorted(list('date', 'asc'), (a, b) => a.date.localeCompare(b.date))).toBe(true);
  });

  it('T-02: amount is largest first by default, smallest first when reversed', () => {
    const desc = list('amount');
    expect(isSorted(desc, (a, b) => b.amountCents - a.amountCents)).toBe(true);
    expect(desc[0].amountCents).toBe(Math.max(...desc.map(t => t.amountCents)));
    expect(isSorted(list('amount', 'asc'), (a, b) => a.amountCents - b.amountCents)).toBe(true);
  });

  it('T-03: merchant, account and category sort A→Z first, then Z→A', () => {
    expect(isSorted(list('merchant'), (a, b) => text(a.merchant, b.merchant))).toBe(true);
    expect(isSorted(list('merchant', 'desc'), (a, b) => text(b.merchant, a.merchant))).toBe(true);
    expect(isSorted(list('category'), (a, b) => text(a.categoryName, b.categoryName))).toBe(true);
    const accounts = list('account').map(t => t.accountId);
    expect(accounts.indexOf(accounts[accounts.length - 1])).toBeGreaterThan(0); // grouped by account
  });

  it('T-04: person sorts by name with unassigned rows always last', () => {
    const anna = db.prepare("INSERT INTO people (name, color) VALUES ('Anna', '#000')").run().lastInsertRowid;
    const ben = db.prepare("INSERT INTO people (name, color) VALUES ('Ben', '#111')").run().lastInsertRowid;
    db.prepare("UPDATE transactions SET person_id = ? WHERE raw_description LIKE '%SHELL%'").run(ben);
    db.prepare("UPDATE transactions SET person_id = ? WHERE raw_description LIKE '%AMAZON%'").run(anna);
    const names = (dir: 'asc' | 'desc') => list('person', dir).map(t => t.personName);
    expect(names('asc').slice(0, 3)).toEqual(['Anna', 'Anna', 'Ben']);
    expect(names('desc')[0]).toBe('Ben');
    expect(names('asc').at(-1)).toBeNull();
    expect(names('desc').at(-1)).toBeNull();
  });
});

describe('Transactions list: Excel-style column filters', () => {
  it('F-10: keeps only the chosen merchants, and the menu offers values with counts', () => {
    const merchants = getColumnValues(db, {}, 'all', 'merchant');
    expect(merchants.length).toBeGreaterThan(2);
    const [a, b] = merchants.filter(m => m.count > 0).slice(0, 2);
    const rows = getTransactions(db, { merchants: [a.value, b.value] }, 'all').transactions;
    expect(new Set(rows.map(r => r.merchant))).toEqual(new Set([a.value, b.value]));
    expect(rows.length).toBe(a.count + b.count);
    // The merchant menu still offers every merchant while a merchant filter is on
    expect(getColumnValues(db, { merchants: [a.value] }, 'all', 'merchant').length).toBe(merchants.length);
  });

  it('F-11: a column filter narrows what the other columns offer', () => {
    const one = getColumnValues(db, {}, 'all', 'merchant')[0];
    const cats = getColumnValues(db, { merchants: [one.value] }, 'all', 'category');
    expect(cats.reduce((n, c) => n + c.count, 0)).toBe(one.count);
  });

  it('F-12: person filter can include "Unassigned" alongside people', () => {
    const people = getColumnValues(db, {}, 'all', 'person');
    expect(people.at(-1)).toMatchObject({ value: 'none', label: 'Unassigned' });
    const anna = people.find(p => p.label === 'Anna')!;
    const rows = getTransactions(db, { personIds: [Number(anna.value), 'none'] }, 'all').transactions;
    expect(rows.every(r => r.personName === 'Anna' || r.personName === null)).toBe(true);
    expect(rows.some(r => r.personName === 'Anna')).toBe(true);
  });

  it('F-13: parses filters from the address bar and ignores junk', () => {
    const f = parseFilters({ merchants: '["AMAZON","SHELL OIL"]', categoryIds: '3,x,5', personIds: 'none,2', accountIds: '' });
    expect(f).toMatchObject({ merchants: ['AMAZON', 'SHELL OIL'], categoryIds: [3, 5], personIds: ['none', 2] });
    expect(f.accountIds).toBeUndefined();
    expect(parseFilters({ merchants: 'not json' }).merchants).toBeUndefined();
  });
});

describe('Trends: money in', () => {
  it('I-01: monthly income matches the Money in total and lists where it came from', () => {
    const t = getTrends(db, {}, 12, 'category');
    const total = t.income.reduce((s, m) => s + m.cents, 0);
    expect(total).toBe(getSummary(db, {}).moneyIn);
    expect(total).toBeGreaterThan(0);
    const oct = t.income.find(m => m.month === '2026-10')!;
    expect(oct.topSources[0].cents).toBeGreaterThanOrEqual(oct.topSources.at(-1)!.cents);
    expect(t.income.map(m => m.month)).toEqual(t.months.map(m => m.month)); // same months as the spending chart
  });
});
