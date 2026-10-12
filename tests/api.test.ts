import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createServer } from '../src/server.js';
import path from 'path';

describe('API Integration Tests', () => {
  let app: any;

  beforeAll(async () => {
    app = await createServer();
  });

  it('A-01: Uploads fixtures and computes summary invariants', async () => {
    const creditPath = path.resolve(__dirname, 'fixtures/chase_credit.csv');
    const checkingPath = path.resolve(__dirname, 'fixtures/chase_checking.csv');

    const res = await request(app)
      .post('/api/imports')
      .attach('files', creditPath)
      .attach('files', checkingPath);

    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(2);

    // Summary endpoint
    const sumRes = await request(app).get('/api/summary');
    expect(sumRes.status).toBe(200);
    expect(sumRes.body.totalSpend).toBeGreaterThan(0);
    expect(sumRes.body.moneyIn).toBe(320000); // Payroll 3200.00
    expect(sumRes.body.byCategory.length).toBeGreaterThan(0);

    // Verify invariant: sum of categories == total spend
    const sumCats = sumRes.body.byCategory.reduce((acc: number, c: any) => acc + c.cents, 0);
    expect(sumCats).toBe(sumRes.body.totalSpend);
  });

  it('A-02: Queries transactions with category filter', async () => {
    // Get categories
    const catRes = await request(app).get('/api/categories');
    const groc = catRes.body.categories.find((c: any) => c.name === 'Groceries');
    expect(groc).toBeDefined();

    const txnRes = await request(app).get(`/api/transactions?categoryId=${groc.id}`);
    expect(txnRes.status).toBe(200);
    expect(txnRes.body.count).toBeGreaterThan(0);
    for (const t of txnRes.body.transactions) {
      expect(t.categoryId).toBe(groc.id);
    }
  });

  it('A-03: Recategorizes with remember and protects manual edits', async () => {
    const allTxns = await request(app).get('/api/transactions');
    const targetTxn = allTxns.body.transactions[0];
    const catRes = await request(app).get('/api/categories');
    const shoppingCat = catRes.body.categories.find((c: any) => c.name === 'Shopping');

    const patchRes = await request(app)
      .patch(`/api/transactions/${targetTxn.id}`)
      .send({ categoryId: shoppingCat.id, remember: true });

    expect(patchRes.status).toBe(200);

    // Check that transaction source is now 'manual'
    const updatedTxns = await request(app).get('/api/transactions');
    const checkTxn = updatedTxns.body.transactions.find((t: any) => t.id === targetTxn.id);
    expect(checkTxn.categoryId).toBe(shoppingCat.id);
    expect(checkTxn.categorySource).toBe('manual');
  });
});
