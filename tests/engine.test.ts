import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb, type Db } from '../src/db.js';
import { bankRegistry } from '../src/registry.js';
import { cleanMerchant } from '../src/cleaner.js';
import { importCsvContent, finishImports, previewCsv } from '../src/importer.js';
import { recompute } from '../src/ledger.js';
import { answerReview, getReviewItems, extractP2PName, payeeKey, unlink } from '../src/review.js';
import { getCoverage, getSummary, getTransactions } from '../src/reports.js';
import { recategorizeWithLlm } from '../src/llm.js';

const fixture = (name: string) => fs.readFileSync(path.resolve(__dirname, 'fixtures', name), 'utf8');
const CREDIT = 'Chase1234_Activity_20261031.CSV';
const CHECKING = 'Chase5678_Activity_20261031.CSV';
const expected = JSON.parse(fixture('matched-set.expected.json'));

function load(db: Db, ...files: string[]) {
  const results = files.map(f => importCsvContent(db, f, fixture(f)));
  finishImports(db);
  return results;
}

const row = (db: Db, like: string) =>
  db.prepare('SELECT * FROM transactions WHERE raw_description LIKE ?').get(`%${like}%`) as any;
const spending = (db: Db, includeOneTime = true) => getSummary(db, { includeOneTime }).totalSpend;
const accountIdByLast4 = (db: Db, last4: string) =>
  (db.prepare('SELECT id FROM accounts WHERE last4 = ?').get(last4) as { id: number }).id;

describe('Bank profiles and parsing', () => {
  it('P-01/P-02: each Chase header matches only its own profile', () => {
    expect(bankRegistry.detect(['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo'])?.id).toBe('chase_credit');
    expect(bankRegistry.detect(['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #'])?.id).toBe('chase_checking');
  });

  it('P-03: unknown header is rejected and nothing is written', () => {
    const db = openDb(':memory:');
    const res = importCsvContent(db, 'other.csv', 'Date,Payee,Amount\n10/01/2026,X,-1.00\n');
    expect(res.error).toMatch(/Unrecognized/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as any).n).toBe(0);
  });

  it('P-04: last 4 digits from the filename keep two cards apart', () => {
    const db = openDb(':memory:');
    importCsvContent(db, 'Chase1111_Activity_20261031.CSV', fixture(CREDIT));
    importCsvContent(db, 'Chase2222_Activity_20261031.CSV', fixture(CREDIT));
    const accts = db.prepare("SELECT last4 FROM accounts WHERE profile_id = 'chase_credit' ORDER BY last4").all() as any[];
    expect(accts.map(a => a.last4)).toEqual(['1111', '2222']);
  });

  it('C-01: cleans merchant strings', () => {
    expect(cleanMerchant('SQ *BLUE BOTTLE #12 SAN FRANCISCO CA')).toBe('Blue Bottle');
    expect(cleanMerchant('TST* SWEETGREEN 041 NEW YORK NY')).toBe('Sweetgreen');
    expect(cleanMerchant('AMAZON.COM*2A345 SEATTLE WA')).toBe('Amazon');
  });

  it('groups payments to the same payee despite reference numbers', () => {
    expect(payeeKey('Fid Bkg Svc Llc Moneyline Z07452365 1qe11 Web Id: 1')).toBe(payeeKey('FID BKG SVC LLC MONEYLINE PPD ID: 2'));
    expect(payeeKey('Target Card Srvc Bill Pay Web Id: T5')).toBe(payeeKey('TARGET CARD SRVC PAYMENT H WEB ID:'));
    expect(payeeKey('Citi Autopay Payment')).not.toBe(payeeKey('Capital One Mobile Pmt'));
  });

  it('extracts the person name from P2P descriptions', () => {
    expect(extractP2PName('Zelle payment from ALEX EXAMPLE BACabc12345')).toBe('ALEX EXAMPLE');
    expect(extractP2PName('UNFCU P2P JANE DOE WEB ID: 123')).toBe('JANE DOE');
    expect(extractP2PName('Venmo Payment Web Id: 333')).toBeNull();
  });
});

describe('Import, dedup, sign and direction', () => {
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); });

  it('N-01: purchases positive spend/out, returns negative refund/in, card payment transfer/in', () => {
    load(db, CREDIT);
    expect(row(db, 'TRADER JOE')).toMatchObject({ kind: 'spend', direction: 'out', amount_cents: 7845 });
    expect(row(db, 'REFUND')).toMatchObject({ kind: 'refund', direction: 'in', amount_cents: -2000 });
    expect(row(db, 'Payment Thank You')).toMatchObject({ bank_kind: 'transfer', direction: 'in' });
  });

  it('N-02: cents are exact', () => {
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n10/01/2026,10/01/2026,A,,Sale,-0.10,\n10/01/2026,10/01/2026,B,,Sale,-0.20,\n';
    importCsvContent(db, 'Chase9999_Activity_1.CSV', csv);
    expect(spending(db)).toBe(30);
  });

  it('D-01: re-uploading the same file adds 0 rows', () => {
    expect(load(db, CREDIT)[0].rowsAdded).toBe(6);
    const again = load(db, CREDIT)[0];
    expect(again.rowsAdded).toBe(0);
    expect(again.rowsSkipped).toBe(6);
  });

  it('D-02: two identical same-day purchases are both kept', () => {
    load(db, CHECKING);
    expect((db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE raw_description = 'WHOLEFDS 042 NYC'").get() as any).n).toBe(2);
  });

  it('D-03: overlapping statements add only the new rows', () => {
    const lines = fixture(CREDIT).trim().split(/\r?\n/);
    const first = [lines[0], ...lines.slice(3)].join('\n');   // older rows
    const second = [lines[0], ...lines.slice(1, 5)].join('\n'); // newer rows, overlapping two
    expect(importCsvContent(db, CREDIT, first).rowsAdded).toBe(4);
    const res = importCsvContent(db, CREDIT, second);
    expect(res.rowsAdded).toBe(2);
    expect(res.rowsSkipped).toBe(2);
  });

  it('preview reports new and duplicate rows without writing', () => {
    load(db, CREDIT);
    const p = previewCsv(db, CREDIT, fixture(CREDIT));
    expect(p).toMatchObject({ last4: '1234', rows: 6, newRows: 0, duplicates: 6, minDate: '2026-10-01', maxDate: '2026-10-10' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM imports').get() as any).n).toBe(1);
  });
});

describe('Counting every dollar once', () => {
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); });

  it('X-01: a card payment seen in checking and on the card is linked and excluded on both sides', () => {
    load(db, CREDIT, CHECKING);
    const out = row(db, 'Payment to Chase card');
    const inn = row(db, 'Payment Thank You');
    expect(out).toMatchObject({ kind: 'transfer', transfer_via: 'pair' });
    expect(inn).toMatchObject({ kind: 'transfer', transfer_via: 'pair' });
    const link = db.prepare('SELECT * FROM transfer_links').get() as any;
    expect([link.out_txn_id, link.in_txn_id]).toEqual([out.id, inn.id]);
    expect(spending(db)).toBe(expected.creditSpendingCents + expected.checkingSpendingBeforeReviewCents);
  });

  it('X-02: import order does not matter', () => {
    const a = openDb(':memory:');
    load(a, CREDIT, CHECKING);
    const b = openDb(':memory:');
    load(b, CHECKING);
    load(b, CREDIT);
    expect(spending(b)).toBe(spending(a));
    expect((b.prepare('SELECT COUNT(*) AS n FROM transfer_links').get() as any).n).toBe(1);
  });

  it('X-03: two equal payments in the window are not auto-linked; review asks', () => {
    const checking = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n'
      + 'DEBIT,10/02/2026,Payment to Chase card ending in 1234,-100.00,LOAN_PMT,1,,\n'
      + 'DEBIT,10/03/2026,Payment to Chase card ending in 1234,-100.00,LOAN_PMT,1,,\n';
    const credit = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n'
      + '10/03/2026,10/03/2026,Payment Thank You,,Payment,100.00,\n'
      + '10/04/2026,10/04/2026,Payment Thank You,,Payment,100.00,\n';
    importCsvContent(db, 'Chase5678_A.CSV', checking);
    importCsvContent(db, 'Chase1234_A.CSV', credit);
    finishImports(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transfer_links').get() as any).n).toBe(0);
    expect(getReviewItems(db).filter(i => i.type === 'ambiguous_pair').length).toBe(2);
    // Still excluded from spending: the bank marked them as transfers
    expect(spending(db)).toBe(0);
  });

  it('X-04: an unlinked pair stays unlinked after re-running the matcher', () => {
    load(db, CREDIT, CHECKING);
    const link = db.prepare('SELECT id FROM transfer_links').get() as any;
    unlink(db, link.id);
    recompute(db);
    recompute(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transfer_links').get() as any).n).toBe(0);
    expect(row(db, 'Payment to Chase card').transfer_via).toBe('bank');
  });

  it('X-05: undoing the checking import un-links the card payment and sends it to review', () => {
    const [, checking] = load(db, CREDIT, CHECKING);
    db.prepare('DELETE FROM transactions WHERE import_id = ?').run(checking.importId);
    db.prepare('DELETE FROM imports WHERE id = ?').run(checking.importId);
    recompute(db);
    expect(row(db, 'Payment Thank You').transfer_via).toBe('bank');
    expect(getReviewItems(db).some(i => i.type === 'unmatched_transfer' && i.txns[0].description.includes('Payment Thank You'))).toBe(true);
  });

  it('X-06: payments to an untracked card we will import are excluded and show as a coverage gap', () => {
    load(db, CREDIT, CHECKING);
    const target = row(db, 'TARGET CARD');
    answerReview(db, { action: 'assign_account', txnIds: [target.id], pattern: 'TARGET CARD SRVC',
      newAccount: { nickname: 'Target RedCard', accountType: 'credit', cardPolicy: 'will_import' } });
    expect(row(db, 'TARGET CARD')).toMatchObject({ kind: 'transfer', transfer_via: 'account' });
    const cov = getCoverage(db).accounts.find(a => a.name === 'Target RedCard')!;
    expect(cov.gapMonths).toEqual(['2026-10']);
  });

  it('X-07: payments to a card we never import count once as "Credit card (untracked)"', () => {
    load(db, CREDIT, CHECKING);
    const before = spending(db);
    const target = row(db, 'TARGET CARD');
    answerReview(db, { action: 'assign_account', txnIds: [target.id], pattern: 'TARGET CARD SRVC',
      newAccount: { nickname: 'Target RedCard', accountType: 'credit', cardPolicy: 'payments_are_spending' } });
    expect(spending(db)).toBe(before + expected.untrackedTargetCardCents);
    const cat = getSummary(db, { includeOneTime: true }).byCategory.find((c: any) => c.name === 'Credit card (untracked)');
    expect(cat.cents).toBe(expected.untrackedTargetCardCents);
  });

  it('X-08: a transfer to our own savings (never imported) is not spending', () => {
    load(db, CREDIT, CHECKING);
    const item = getReviewItems(db).find(i => i.type === 'unmatched_transfer' && i.txns[0].description.includes('Advantage Savings'))!;
    expect(item.suggestedPattern).toContain('ADVANTAGE SAVINGS');
    answerReview(db, { action: 'assign_account', txnIds: item.txns.map(t => t.id), pattern: 'ADVANTAGE SAVINGS',
      newAccount: { nickname: 'Savings', accountType: 'savings' } });
    expect(row(db, 'Advantage Savings')).toMatchObject({ kind: 'transfer', transfer_via: 'account' });
    expect(getReviewItems(db).some(i => i.txns.some(t => t.description.includes('Advantage Savings')))).toBe(false);
  });

  it('X-09: P2P with a household member is a transfer; P2P to anyone else is spending', () => {
    load(db, CREDIT, CHECKING);
    const moneyInBefore = getSummary(db, {}).moneyIn;
    const p2p = getReviewItems(db).filter(i => i.type === 'p2p_name');
    expect(p2p.map(i => i.name).sort()).toEqual(['ALEX EXAMPLE', 'CONTRACTOR JOE']);

    answerReview(db, { action: 'household', txnIds: [], name: 'ALEX EXAMPLE', newPersonName: 'Alex' });
    answerReview(db, { action: 'not_household', name: 'CONTRACTOR JOE' });
    expect(row(db, 'ALEX EXAMPLE')).toMatchObject({ kind: 'transfer', transfer_via: 'household' });
    expect(row(db, 'CONTRACTOR JOE').kind).toBe('spend');
    expect(getSummary(db, {}).moneyIn).toBe(moneyInBefore - expected.householdZelleCents);
    expect(getReviewItems(db).some(i => i.type === 'p2p_name')).toBe(false);
  });

  it('X-10: one-time items are excluded from normal totals and reported separately', () => {
    load(db, CREDIT, CHECKING);
    const item = getReviewItems(db).find(i => i.type === 'one_time')!;
    expect(item.totalCents).toBe(expected.oneTimeCents);
    answerReview(db, { action: 'one_time', txnIds: [item.txns[0].id], value: true });
    const s = getSummary(db, {});
    expect(s.oneTimeCents).toBe(expected.oneTimeCents);
    expect(s.totalSpend).toBe(expected.creditSpendingCents + expected.checkingSpendingBeforeReviewCents - expected.oneTimeCents);
    expect(s.byMonth.find((m: any) => m.month === '2026-10')!.cents).toBe(s.totalSpend);
  });

  it('X-11/A-01: every breakdown adds up to the same total', () => {
    load(db, CREDIT, CHECKING);
    const s = getSummary(db, { includeOneTime: true });
    const sum = (xs: { cents: number }[]) => xs.reduce((a, x) => a + x.cents, 0);
    expect(sum(s.byCategory)).toBe(s.totalSpend);
    expect(sum(s.byPerson)).toBe(s.totalSpend);
    expect(sum(s.byAccount)).toBe(s.totalSpend);
    expect(s.byMonth.reduce((a: number, m: any) => a + m.cents + m.oneTimeCents, 0)).toBe(s.totalSpend);
    const t = getTransactions(db, { includeOneTime: true }, 'spending');
    expect(t.sumCents).toBe(s.totalSpend);
  });

  it('X-12: a missing month between two statements is reported as a gap', () => {
    const lines = fixture(CREDIT).trim().split(/\r?\n/);
    const aug = [lines[0], lines[1].replace(/10\/(\d\d)\/2026/g, '08/$1/2026')].join('\n');
    importCsvContent(db, 'Chase1234_aug.CSV', aug);
    importCsvContent(db, CREDIT, fixture(CREDIT));
    finishImports(db);
    const card = getCoverage(db).accounts[0];
    expect(card.months['2026-09']).toBe('missing');
    expect(card.gapMonths).toContain('2026-09');
    expect(getSummary(db, {}).byMonth.every((m: any) => m.complete === (m.month !== '2026-08'))).toBe(true);
  });
});

describe('Categories, people, and decisions', () => {
  let db: Db;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.LLM_API_KEY; });

  it('C-02: user rule beats default rule beats bank category', () => {
    load(db, CREDIT);
    expect(row(db, 'SHELL OIL').category_source).toBe('default_rule'); // "shell" keyword
    expect(row(db, 'AMAZON.COM*2A')).toMatchObject({ category_source: 'default_rule' });
    const shopping = (db.prepare("SELECT id FROM categories WHERE name = 'Travel'").get() as any).id;
    db.prepare("INSERT INTO rules (pattern, category_id, priority, source) VALUES ('shell oil', ?, 10, 'user')").run(shopping);
    recompute(db);
    expect(row(db, 'SHELL OIL')).toMatchObject({ category_id: shopping, category_source: 'user_rule' });
  });

  it('C-03: rules never change a manual edit', () => {
    load(db, CREDIT);
    const health = (db.prepare("SELECT id FROM categories WHERE name = 'Health'").get() as any).id;
    const travel = (db.prepare("SELECT id FROM categories WHERE name = 'Travel'").get() as any).id;
    db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE raw_description LIKE '%SHELL%'").run(health);
    db.prepare("INSERT INTO rules (pattern, category_id, priority, source) VALUES ('shell oil', ?, 10, 'user')").run(travel);
    recompute(db);
    expect(row(db, 'SHELL OIL').category_id).toBe(health);
  });

  it('C-04: the AI only changes spending categories, never kind, and never sees transfers', async () => {
    load(db, CREDIT, CHECKING);
    process.env.LLM_API_KEY = 'test-key';
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const prompt = JSON.parse(init.body).contents[0].parts[0].text as string;
      sent.push(prompt);
      const items = JSON.parse(prompt.slice(prompt.indexOf('Items:') + 6));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(items.map((i: any) => ({ id: i.id, category: 'Dining' }))) }] } }] }));
    }));
    const kindsBefore = db.prepare('SELECT id, kind FROM transactions ORDER BY id').all();
    await recategorizeWithLlm(db);
    expect(db.prepare('SELECT id, kind FROM transactions ORDER BY id').all()).toEqual(kindsBefore);
    expect(sent.join()).not.toMatch(/Payment to Chase card|Payment Thank You|PAYROLL|Advantage Savings/);
    expect(sent.join()).not.toMatch(/Allowed categories:.*\bTransfer\b/);
  });

  it('C-05: manual answers survive undo + re-import of the file', () => {
    let [credit] = load(db, CREDIT);
    const health = (db.prepare("SELECT id FROM categories WHERE name = 'Health'").get() as any).id;
    const alex = Number(db.prepare("INSERT INTO people (name, color) VALUES ('Alex', '#6366F1')").run().lastInsertRowid);
    const shell = row(db, 'SHELL OIL');
    // Decisions are written by the API layer (covered in api.test.ts); write one directly here
    db.prepare("INSERT INTO decisions (fingerprint, category_id, person_id, updated_at) VALUES (?, ?, ?, 'now')").run(shell.fingerprint, health, alex);
    db.prepare('DELETE FROM transactions WHERE import_id = ?').run(credit.importId);
    [credit] = load(db, CREDIT);
    expect(row(db, 'SHELL OIL')).toMatchObject({ category_id: health, category_source: 'manual', person_id: alex, person_source: 'manual' });
  });

  it('H-01: account default person and person rules fill in, manual choices win', () => {
    load(db, CREDIT, CHECKING);
    const alex = Number(db.prepare("INSERT INTO people (name, color) VALUES ('Alex', '#6366F1')").run().lastInsertRowid);
    const sam = Number(db.prepare("INSERT INTO people (name, color) VALUES ('Sam', '#F59E0B')").run().lastInsertRowid);
    db.prepare('UPDATE accounts SET default_person_id = ? WHERE last4 = ?').run(alex, '1234');
    db.prepare("INSERT INTO person_rules (pattern, person_id) VALUES ('sweetgreen', ?)").run(sam);
    db.prepare("UPDATE transactions SET person_id = ?, person_source = 'manual' WHERE raw_description LIKE '%TRADER JOE%'").run(sam);
    recompute(db);
    expect(row(db, 'SHELL OIL')).toMatchObject({ person_id: alex, person_source: 'account' });
    expect(row(db, 'SWEETGREEN')).toMatchObject({ person_id: sam, person_source: 'rule' });
    expect(row(db, 'TRADER JOE')).toMatchObject({ person_id: sam, person_source: 'manual' });
    expect(row(db, 'CON EDISON').person_id).toBeNull();
    const s = getSummary(db, { personId: alex, includeOneTime: true });
    expect(s.byPerson.map((p: any) => p.name)).toEqual(['Alex']);
    expect(accountIdByLast4(db, '1234')).toBeGreaterThan(0);
  });
});

describe('Migrating a v0.1 database', () => {
  it('M-01: upgrades in place, backfills direction, keeps manual edits, and takes a backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'));
    const file = path.join(dir, 'app.db');
    const old = new Database(file);
    old.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, bank TEXT NOT NULL, account_type TEXT NOT NULL, nickname TEXT);
      CREATE TABLE imports (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, filename TEXT NOT NULL, imported_at TEXT NOT NULL, rows_added INTEGER NOT NULL, rows_skipped INTEGER NOT NULL);
      CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, is_system INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE rules (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL, category_id INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 10, source TEXT NOT NULL);
      CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, import_id INTEGER NOT NULL, account_id INTEGER NOT NULL, txn_date TEXT NOT NULL, raw_description TEXT NOT NULL, merchant TEXT NOT NULL, amount_cents INTEGER NOT NULL, kind TEXT NOT NULL, category_id INTEGER NOT NULL, category_source TEXT NOT NULL, bank_category TEXT, fingerprint TEXT NOT NULL UNIQUE);
      INSERT INTO categories (name, color) VALUES ('Dining', '#F59E0B'), ('Transfer', '#64748B'), ('Income', '#22C55E'), ('Uncategorized', '#CBD5E1');
      INSERT INTO accounts (profile_id, bank, account_type, nickname) VALUES ('chase_checking', 'Chase', 'checking', 'Chase CHECKING');
      INSERT INTO imports (account_id, filename, imported_at, rows_added, rows_skipped) VALUES (1, 'Chase5678_Activity_20261011.csv', 'x', 2, 0);
      INSERT INTO transactions (import_id, account_id, txn_date, raw_description, merchant, amount_cents, kind, category_id, category_source, fingerprint)
        VALUES (1, 1, '2026-10-01', 'Online Transfer from Savings', 'Savings', 50000, 'transfer', 2, 'default_rule', 'fp1'),
               (1, 1, '2026-10-02', 'Cafe', 'Cafe', 500, 'spend', 1, 'manual', 'fp2');
    `);
    old.close();

    const backups = path.join(dir, 'backups');
    process.env.SPENDING_BACKUP_DIR = backups;
    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.prepare("SELECT direction, bank_kind FROM transactions WHERE fingerprint = 'fp1'").get()).toEqual({ direction: 'in', bank_kind: 'transfer' });
    expect(db.prepare("SELECT category_id FROM decisions WHERE fingerprint = 'fp2'").get()).toEqual({ category_id: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM categories WHERE name = 'Credit card (untracked)'").get()).toEqual({ n: 1 });
    expect(fs.readdirSync(backups).filter(f => f.startsWith('pre-migration'))).toHaveLength(1);
    delete process.env.SPENDING_BACKUP_DIR;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
