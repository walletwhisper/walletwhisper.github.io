import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { openDb, type Db } from '../src/db.js';
import { finishImports, importCsvContent } from '../src/importer.js';
import { compareWithBackup, mergeBackup, openBackupCopy } from '../src/merge.js';
import { saveDecision } from '../src/ledger.js';

/** The other computer's data, as it arrives in a backup file. */
const copyOf = (a: Db) => openBackupCopy(a.export());

const fixture = (name: string) => fs.readFileSync(path.resolve(__dirname, 'fixtures', name), 'utf8');
const CREDIT = 'Chase1234_Activity_20261031.CSV';
const CHECKING = 'Chase5678_Activity_20261031.CSV';

const fp = (db: Db, like: string) => (db.prepare('SELECT fingerprint FROM transactions WHERE raw_description LIKE ?').get(`%${like}%`) as { fingerprint: string }).fingerprint;
const row = (db: Db, like: string) => db.prepare(`SELECT t.*, c.name AS category, p.name AS person FROM transactions t
  JOIN categories c ON c.id = t.category_id LEFT JOIN people p ON p.id = t.person_id WHERE raw_description LIKE ?`).get(`%${like}%`) as any;
const catId = (db: Db, name: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id;
const count = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;

/** "This computer" (A) and "the other computer" (B, started from A's backup), each changed afterwards. */
function twoComputers() {
  const a = openDb(':memory:');
  importCsvContent(a, CREDIT, fixture(CREDIT));
  finishImports(a);
  const b = copyOf(a);

  // On the other computer: import the checking account, add a person, edit two transactions
  importCsvContent(b, CHECKING, fixture(CHECKING));
  finishImports(b);
  const sam = Number(b.prepare("INSERT INTO people (name, color) VALUES ('Sam', '#123456')").run().lastInsertRowid);
  saveDecision(b, fp(b, 'SHELL OIL'), { person_id: sam });
  saveDecision(b, fp(b, 'TRADER JOE'), { category_id: catId(b, 'Dining') });
  b.prepare("UPDATE decisions SET updated_at = '2030-01-02T00:00:00Z' WHERE fingerprint = ?").run(fp(b, 'TRADER JOE'));

  // On this computer: a different edit to the same transaction (older), and one extra import
  saveDecision(a, fp(a, 'TRADER JOE'), { category_id: catId(a, 'Shopping') });
  a.prepare("UPDATE decisions SET updated_at = '2030-01-01T00:00:00Z' WHERE fingerprint = ?").run(fp(a, 'TRADER JOE'));
  const lines = fixture(CREDIT).trim().split(/\r?\n/);
  importCsvContent(a, 'Chase1234_extra.CSV', [lines[0], '10/29/2026,10/30/2026,LOCAL BAKERY,Food & Drink,Sale,-9.25,'].join('\n'));
  finishImports(a);
  return { a, b };
}

describe('Combining a backup from another computer', () => {
  it('G-01: a backup of the same data is reported as identical', () => {
    const a = openDb(':memory:');
    importCsvContent(a, CREDIT, fixture(CREDIT));
    finishImports(a);
    const copy = copyOf(a);
    expect(compareWithBackup(a, copy).identical).toBe(true);
  });

  it('G-02: shows what is new on each side, one-sided edits, and real conflicts', () => {
    const { a, b } = twoComputers();
    const p = compareWithBackup(a, b);
    const checkingRows = fixture(CHECKING).trim().split(/\r?\n/).length - 1;
    expect(p.identical).toBe(false);
    expect(p.newTransactions).toBe(count(b) - (count(a) - 1));
    expect(p.newTransactions).toBeLessThanOrEqual(checkingRows);
    expect(p.localOnlyTransactions).toBe(1);
    expect(p.localOnlySample[0].merchant).toMatch(/BAKERY/i);
    expect(p.newPeople).toEqual(['Sam']);
    expect(p.editsFromBackup).toBeGreaterThanOrEqual(1); // Shell → Sam was only changed over there
    expect(p.conflicts).toHaveLength(1);
    expect(p.conflicts[0]).toMatchObject({ kind: 'transaction', field: 'Category', mine: 'Shopping', theirs: 'Dining', suggested: 'theirs' });
  });

  it('G-03: combining keeps both sides, takes one-sided edits, and applies the chosen side of a conflict', () => {
    const { a, b } = twoComputers();
    const before = count(a);
    const p = compareWithBackup(a, b);
    const result = mergeBackup(a, b, { choices: { [p.conflicts[0].id]: 'theirs' }, removeLocalOnly: false });
    expect(result).toEqual({ added: p.newTransactions, removed: 0 });
    expect(count(a)).toBe(before + p.newTransactions);
    expect(row(a, 'TRADER JOE')).toMatchObject({ category: 'Dining', category_source: 'manual' });
    expect(row(a, 'SHELL OIL')).toMatchObject({ person: 'Sam', person_source: 'manual' });
    expect(row(a, 'LOCAL BAKERY')).toBeTruthy();
    // Afterwards the two computers agree, except for what only this one has
    const again = compareWithBackup(a, b);
    expect(again.conflicts).toHaveLength(0);
    expect(again.newTransactions).toBe(0);
  });

  it('G-04: keeping my side of a conflict, and removing what the other computer no longer has', () => {
    const { a, b } = twoComputers();
    const p = compareWithBackup(a, b);
    const result = mergeBackup(a, b, { choices: { [p.conflicts[0].id]: 'mine' }, removeLocalOnly: true });
    expect(result.removed).toBe(1);
    expect(row(a, 'LOCAL BAKERY')).toBeUndefined();
    expect(row(a, 'TRADER JOE').category).toBe('Shopping');
    expect(compareWithBackup(a, b).identical).toBe(false); // still differs only by the kept choice
    expect(compareWithBackup(a, b).conflicts).toHaveLength(1);
  });
});
