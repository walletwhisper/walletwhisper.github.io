import { describe, it, expect, beforeAll } from 'vitest';
import { LocalApi } from '../src/app.js';
import { client, fixtureFile, memoryHost } from './helpers.js';

const CREDIT = 'Chase1234_Activity_20261031.CSV';
const CHECKING = 'Chase5678_Activity_20261031.CSV';

describe('API', () => {
  const host = memoryHost();
  let api: ReturnType<typeof client>;
  const files = (...names: string[]) => names.map(fixtureFile);

  beforeAll(async () => {
    const app = new LocalApi(host, null);
    api = client(app);
    expect((await api.get('/api/summary')).status).toBe(409); // set up first
    await api.post('/api/setup');
  });

  it('S-03: reset needs typed confirmation', async () => {
    const noConfirm = await api.post('/api/reset', {});
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error).toMatch(/DELETE ALL/);
  });

  it('A-00: preview shows what will be imported without writing anything', async () => {
    const res = await api.post('/api/imports/preview', { files: files(CREDIT, CHECKING) });
    expect(res.status).toBe(200);
    expect(res.body.previews.map((p: any) => [p.profileId, p.last4, p.newRows])).toEqual([
      ['chase_credit', '1234', 6],
      ['chase_checking', '5678', 10]
    ]);
    expect((await api.get('/api/imports')).body.imports).toEqual([]);
  });

  it('A-01: import links the card payment, and every breakdown adds up', async () => {
    const res = await api.post('/api/imports', { files: files(CREDIT, CHECKING) });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r.rowsAdded)).toEqual([6, 10]);
    expect(res.body.matched.pairsLinked).toBe(1);

    const s = (await api.get('/api/summary')).body;
    const sum = (xs: any[]) => xs.reduce((a, x) => a + x.cents, 0);
    expect(sum(s.byCategory)).toBe(s.totalSpend);
    expect(sum(s.byPerson)).toBe(s.totalSpend);
    expect(sum(s.byAccount)).toBe(s.totalSpend);
    expect(s.moneyIn).toBe(320000 + 200000); // payroll + Zelle from Alex (until we say Alex is one of us)
    expect(s.reviewCount).toBeGreaterThan(0);

    const transfers = (await api.get('/api/transactions?kind=transfer')).body.transactions;
    const card = transfers.find((t: any) => t.rawDescription.startsWith('Payment to Chase card'));
    expect(card).toMatchObject({ transferVia: 'pair', counterparty: 'Chase Credit ··1234', partnerDate: '2026-10-03' });
  });

  it('A-02: the table footer equals the clicked category', async () => {
    const s = (await api.get('/api/summary')).body;
    const cat = s.byCategory[0];
    const t = (await api.get(`/api/transactions?categoryId=${cat.id}`)).body;
    expect(t.sumCents).toBe(cat.cents);
    for (const row of t.transactions) expect(row.categoryId).toBe(cat.id);
  });

  it('A-03: review answers are applied and the inbox shrinks', async () => {
    const items = (await api.get('/api/review')).body.items;
    const before = items.length;
    const alex = items.find((i: any) => i.type === 'p2p_name' && i.name === 'ALEX EXAMPLE');
    const res = await api.post('/api/review/answer', { action: 'household', txnIds: alex.txns.map((t: any) => t.id), name: alex.name, newPersonName: 'Alex' });
    expect(res.status).toBe(200);
    expect(res.body.reviewCount).toBe(before - 1);
    expect((await api.get('/api/summary')).body.moneyIn).toBe(320000);

    const bad = await api.post('/api/review/answer', { action: 'assign_account', txnIds: [], pattern: 'ab' });
    expect(bad.status).toBe(400);
  });

  it('A-04: recategorize with remember, and edits are protected', async () => {
    const all = (await api.get('/api/transactions')).body.transactions;
    const shell = all.find((t: any) => t.merchant === 'Shell Oil');
    const cats = (await api.get('/api/categories')).body.categories;
    const travel = cats.find((c: any) => c.name === 'Travel');
    expect((await api.patch(`/api/transactions/${shell.id}`, { categoryId: travel.id, remember: true })).status).toBe(200);
    const after = (await api.get('/api/transactions')).body.transactions.find((t: any) => t.id === shell.id);
    expect(after).toMatchObject({ categoryId: travel.id, categorySource: 'manual' });
  });

  it('H-01: bulk-assign a person, then filter by person', async () => {
    const people = (await api.get('/api/people')).body.people;
    const alex = people.find((p: any) => p.name === 'Alex');
    const credit = (await api.get('/api/accounts')).body.accounts.find((a: any) => a.last4 === '1234');
    const rows = (await api.get(`/api/transactions?accountId=${credit.id}`)).body.transactions;
    const res = await api.patch('/api/transactions', { ids: rows.map((r: any) => r.id), personId: alex.id });
    expect(res.body.updated).toBe(rows.length);
    const s = (await api.get(`/api/summary?personId=${alex.id}`)).body;
    expect(s.byPerson).toHaveLength(1);
    expect(s.totalSpend).toBe(rows.reduce((a: number, r: any) => a + r.amountCents, 0));
    expect((await api.patch('/api/transactions', { ids: 'all' })).status).toBe(400);
  });

  it('trends and coverage respond', async () => {
    const t = (await api.get('/api/trends?months=6&stack=person')).body;
    expect(t.months.length).toBeGreaterThan(0);
    expect(t.series.some((s: any) => s.name === 'Alex')).toBe(true);
    const c = (await api.get('/api/coverage')).body;
    expect(c.accounts.map((a: any) => a.name).sort()).toEqual(['Chase Checking ··5678', 'Chase Credit ··1234']);
  });

  it('A-05: undo an import removes exactly its rows; reset wipes data after confirmation', async () => {
    const imports = (await api.get('/api/imports')).body.imports;
    const checking = imports.find((i: any) => i.filename === CHECKING);
    expect((await api.del(`/api/imports/${checking.id}`)).status).toBe(200);
    const left = (await api.get('/api/transactions?kind=all')).body;
    expect(left.count).toBe(6);

    const reset = await api.post('/api/reset', { confirm: 'DELETE ALL' });
    expect(reset.status).toBe(200);
    expect((await api.get('/api/transactions?kind=all')).body.count).toBe(0);
    expect(host.snapshots).toEqual([`before-undo-import-${checking.id}`, 'before-reset']); // a copy is kept first
  });

  it('A-06: every change is saved, reading is not', async () => {
    const before = host.saves;
    await api.get('/api/summary');
    expect(host.saves).toBe(before);
    await api.post('/api/people', { name: 'Saved Person' });
    expect(host.saves).toBe(before + 1);
  });
});
