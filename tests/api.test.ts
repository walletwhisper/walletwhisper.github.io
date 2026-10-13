import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import path from 'path';
import { createServer } from '../src/server.js';
import { dbPath } from '../src/db.js';

const fixture = (name: string) => path.resolve(__dirname, 'fixtures', name);
const CREDIT = 'Chase1234_Activity_20261031.CSV';
const CHECKING = 'Chase5678_Activity_20261031.CSV';

describe('API', () => {
  let app: any;
  let token: string;

  const post = (url: string) => request(app).post(url).set('X-App-Token', token);
  const patch = (url: string) => request(app).patch(url).set('X-App-Token', token);

  beforeAll(async () => {
    expect(dbPath()).toBe(':memory:'); // never the real database
    app = await createServer();
    token = (await request(app).get('/api/session')).body.token;
  });

  it('S-01: refuses requests from another website', async () => {
    const res = await request(app).get('/api/transactions').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('S-02: refuses a foreign Host header (DNS rebinding)', async () => {
    const res = await request(app).get('/api/summary').set('Host', 'attacker.example');
    expect(res.status).toBe(403);
  });

  it('S-03: writes need the session token, and reset needs typed confirmation', async () => {
    expect((await request(app).post('/api/reset').send({ confirm: 'DELETE ALL' })).status).toBe(403);
    expect((await request(app).post('/api/reset').set('X-App-Token', 'x'.repeat(64)).send({ confirm: 'DELETE ALL' })).status).toBe(403);
    const noConfirm = await post('/api/reset').send({});
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error).toMatch(/DELETE ALL/);
  });

  it('A-00: preview shows what will be imported without writing anything', async () => {
    const res = await post('/api/imports/preview').attach('files', fixture(CREDIT)).attach('files', fixture(CHECKING));
    expect(res.status).toBe(200);
    expect(res.body.previews.map((p: any) => [p.profileId, p.last4, p.newRows])).toEqual([
      ['chase_credit', '1234', 6],
      ['chase_checking', '5678', 10]
    ]);
    expect((await request(app).get('/api/imports')).body.imports).toEqual([]);
  });

  it('A-01: import links the card payment, and every breakdown adds up', async () => {
    const res = await post('/api/imports').attach('files', fixture(CREDIT)).attach('files', fixture(CHECKING));
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: any) => r.rowsAdded)).toEqual([6, 10]);
    expect(res.body.matched.pairsLinked).toBe(1);

    const s = (await request(app).get('/api/summary?includeOneTime=true')).body;
    const sum = (xs: any[]) => xs.reduce((a, x) => a + x.cents, 0);
    expect(sum(s.byCategory)).toBe(s.totalSpend);
    expect(sum(s.byPerson)).toBe(s.totalSpend);
    expect(sum(s.byAccount)).toBe(s.totalSpend);
    expect(s.moneyIn).toBe(320000 + 200000); // payroll + Zelle from Alex (until we say Alex is one of us)
    expect(s.reviewCount).toBeGreaterThan(0);

    const transfers = (await request(app).get('/api/transactions?kind=transfer')).body.transactions;
    const card = transfers.find((t: any) => t.rawDescription.startsWith('Payment to Chase card'));
    expect(card).toMatchObject({ transferVia: 'pair', counterparty: 'Chase Credit ··1234', partnerDate: '2026-10-03' });
  });

  it('A-02: the table footer equals the clicked category', async () => {
    const s = (await request(app).get('/api/summary')).body;
    const cat = s.byCategory[0];
    const t = (await request(app).get(`/api/transactions?categoryId=${cat.id}`)).body;
    expect(t.sumCents).toBe(cat.cents);
    for (const row of t.transactions) expect(row.categoryId).toBe(cat.id);
  });

  it('A-03: review answers are applied and the inbox shrinks', async () => {
    const items = (await request(app).get('/api/review')).body.items;
    const before = items.length;
    const alex = items.find((i: any) => i.type === 'p2p_name' && i.name === 'ALEX EXAMPLE');
    const res = await post('/api/review/answer').send({ action: 'household', txnIds: alex.txns.map((t: any) => t.id), name: alex.name, newPersonName: 'Alex' });
    expect(res.status).toBe(200);
    expect(res.body.reviewCount).toBe(before - 1);
    expect((await request(app).get('/api/summary')).body.moneyIn).toBe(320000);

    const bad = await post('/api/review/answer').send({ action: 'assign_account', txnIds: [], pattern: 'ab' });
    expect(bad.status).toBe(400);
  });

  it('A-04: recategorize with remember, and edits are protected', async () => {
    const all = (await request(app).get('/api/transactions')).body.transactions;
    const shell = all.find((t: any) => t.merchant === 'Shell Oil');
    const cats = (await request(app).get('/api/categories')).body.categories;
    const travel = cats.find((c: any) => c.name === 'Travel');
    expect((await patch(`/api/transactions/${shell.id}`).send({ categoryId: travel.id, remember: true })).status).toBe(200);
    const after = (await request(app).get('/api/transactions')).body.transactions.find((t: any) => t.id === shell.id);
    expect(after).toMatchObject({ categoryId: travel.id, categorySource: 'manual' });
  });

  it('H-01: bulk-assign a person, then filter by person', async () => {
    const people = (await request(app).get('/api/people')).body.people;
    const alex = people.find((p: any) => p.name === 'Alex');
    const credit = (await request(app).get('/api/accounts')).body.accounts.find((a: any) => a.last4 === '1234');
    const rows = (await request(app).get(`/api/transactions?accountId=${credit.id}`)).body.transactions;
    const res = await patch('/api/transactions').send({ ids: rows.map((r: any) => r.id), personId: alex.id });
    expect(res.body.updated).toBe(rows.length);
    const s = (await request(app).get(`/api/summary?personId=${alex.id}`)).body;
    expect(s.byPerson).toHaveLength(1);
    expect(s.totalSpend).toBe(rows.reduce((a: number, r: any) => a + r.amountCents, 0));
    expect((await patch('/api/transactions').send({ ids: 'all' })).status).toBe(400);
  });

  it('trends and coverage respond', async () => {
    const t = (await request(app).get('/api/trends?months=6&stack=person')).body;
    expect(t.months.length).toBeGreaterThan(0);
    expect(t.series.some((s: any) => s.name === 'Alex')).toBe(true);
    const c = (await request(app).get('/api/coverage')).body;
    expect(c.accounts.map((a: any) => a.name).sort()).toEqual(['Chase Checking ··5678', 'Chase Credit ··1234']);
  });

  it('A-05: undo an import removes exactly its rows; reset wipes data after confirmation', async () => {
    const imports = (await request(app).get('/api/imports')).body.imports;
    const checking = imports.find((i: any) => i.filename === CHECKING);
    expect((await request(app).delete(`/api/imports/${checking.id}`).set('X-App-Token', token)).status).toBe(200);
    const left = (await request(app).get('/api/transactions?kind=all')).body;
    expect(left.count).toBe(6);

    const reset = await post('/api/reset').send({ confirm: 'DELETE ALL' });
    expect(reset.status).toBe(200);
    expect((await request(app).get('/api/transactions?kind=all')).body.count).toBe(0);
  });
});
