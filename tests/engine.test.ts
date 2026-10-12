import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs, { Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { bankRegistry } from '../src/registry.js';
import { cleanMerchant } from '../src/cleaner.js';
import { importCsvContent } from '../src/importer.js';
import { DEFAULT_CATEGORIES } from '../src/taxonomy.js';

describe('Spending Analyzer Core Engine Tests', () => {
  let db: Database;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database();

    // Create schema
    db.run(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        bank TEXT NOT NULL,
        account_type TEXT NOT NULL,
        nickname TEXT
      );
      CREATE TABLE imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        rows_added INTEGER NOT NULL,
        rows_skipped INTEGER NOT NULL
      );
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL,
        is_system INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL,
        category_id INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 10,
        source TEXT NOT NULL
      );
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        import_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL,
        txn_date TEXT NOT NULL,
        raw_description TEXT NOT NULL,
        merchant TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        kind TEXT NOT NULL,
        category_id INTEGER NOT NULL,
        category_source TEXT NOT NULL,
        bank_category TEXT,
        fingerprint TEXT NOT NULL UNIQUE
      );
    `);

    // Seed categories & rules
    for (const cat of DEFAULT_CATEGORIES) {
      db.run("INSERT INTO categories (name, color, is_system) VALUES (?, ?, ?)", [
        cat.name,
        cat.color,
        cat.isSystem ? 1 : 0
      ]);
    }

    const catRows = db.exec("SELECT id, name FROM categories")[0].values;
    const catMap = new Map<string, number>();
    for (const row of catRows) {
      catMap.set(row[1] as string, row[0] as number);
    }

    for (const cat of DEFAULT_CATEGORIES) {
      const catId = catMap.get(cat.name);
      if (!catId) continue;
      for (const kw of cat.keywords) {
        db.run(
          "INSERT INTO rules (pattern, category_id, priority, source) VALUES (?, ?, 1, 'default')",
          [kw.toLowerCase(), catId]
        );
      }
    }
  });

  it('P-01: Correctly detects Chase Credit profile from headers', () => {
    const headers = ['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo'];
    const profile = bankRegistry.detect(headers);
    expect(profile).not.toBeNull();
    expect(profile?.id).toBe('chase_credit');
  });

  it('P-02: Correctly detects Chase Checking profile from headers', () => {
    const headers = ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #'];
    const profile = bankRegistry.detect(headers);
    expect(profile).not.toBeNull();
    expect(profile?.id).toBe('chase_checking');
  });

  it('C-01: Cleans merchant strings properly', () => {
    expect(cleanMerchant('SQ *BLUE BOTTLE #12 SAN FRANCISCO CA')).toBe('Blue Bottle');
    expect(cleanMerchant('TST* SWEETGREEN 041 NEW YORK NY')).toBe('Sweetgreen');
    expect(cleanMerchant('AMAZON.COM*2A345 SEATTLE WA')).toBe('Amazon');
  });

  it('N-01 & D-02 & T-02: Imports Chase Credit with refund netting, autopay exclusion, and same-day duplicates', () => {
    const creditCsv = fs.readFileSync(path.resolve(__dirname, 'fixtures/chase_credit.csv'), 'utf8');
    const res = importCsvContent(db, 'chase_credit.csv', creditCsv);

    expect(res.error).toBeUndefined();
    expect(res.rowsAdded).toBe(9);
    expect(res.rowsSkipped).toBe(0);

    // Verify refund row
    const refundRows = db.exec("SELECT amount_cents, kind FROM transactions WHERE raw_description LIKE '%REFUND%'");
    expect(refundRows[0].values.length).toBe(1);
    expect(refundRows[0].values[0][0]).toBe(-2000); // -20.00 refund
    expect(refundRows[0].values[0][1]).toBe('refund');

    // Verify autopay transfer row
    const transferRows = db.exec("SELECT kind FROM transactions WHERE raw_description LIKE '%AUTOMATIC PAYMENT%'");
    expect(transferRows[0].values.length).toBe(1);
    expect(transferRows[0].values[0][0]).toBe('transfer');

    // Verify two identical same-day coffees are BOTH kept
    const coffeeRows = db.exec("SELECT id, amount_cents FROM transactions WHERE raw_description = 'BLUE BOTTLE COFFEE'");
    expect(coffeeRows[0].values.length).toBe(2);
    expect(coffeeRows[0].values[0][1]).toBe(575);
    expect(coffeeRows[0].values[1][1]).toBe(575);
  });

  it('D-01: Re-uploading the exact same file skips all duplicate rows', () => {
    const creditCsv = fs.readFileSync(path.resolve(__dirname, 'fixtures/chase_credit.csv'), 'utf8');
    const firstRes = importCsvContent(db, 'chase_credit.csv', creditCsv);
    expect(firstRes.rowsAdded).toBe(9);

    const secondRes = importCsvContent(db, 'chase_credit.csv', creditCsv);
    expect(secondRes.rowsAdded).toBe(0);
    expect(secondRes.rowsSkipped).toBe(9);
  });

  it('T-01: Checking import excludes credit card payment from spending', () => {
    const checkingCsv = fs.readFileSync(path.resolve(__dirname, 'fixtures/chase_checking.csv'), 'utf8');
    const res = importCsvContent(db, 'chase_checking.csv', checkingCsv);

    expect(res.error).toBeUndefined();
    expect(res.rowsAdded).toBe(4);

    // Verify autopay is classified as transfer
    const autopayRow = db.exec("SELECT kind, amount_cents FROM transactions WHERE raw_description LIKE '%AUTOPAY%'");
    expect(autopayRow[0].values[0][0]).toBe('transfer');

    // Verify payroll is classified as income
    const payrollRow = db.exec("SELECT kind, amount_cents FROM transactions WHERE raw_description LIKE '%PAYROLL%'");
    expect(payrollRow[0].values[0][0]).toBe('income');
    expect(payrollRow[0].values[0][1]).toBe(320000);
  });
});
