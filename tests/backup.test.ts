import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb, resetDbInstance } from '../src/db.js';
import { finishImports, importCsvContent } from '../src/importer.js';
import { createBackup, isEncryptedBackup, prepareRestore } from '../src/backup.js';
import { createServer } from '../src/server.js';

const fixture = (name: string) => fs.readFileSync(path.resolve(__dirname, 'fixtures', name), 'utf8');
const CREDIT = 'Chase1234_Activity_20261031.CSV';
const CHECKING = 'Chase5678_Activity_20261031.CSV';

function loadedDb() {
  const db = openDb(':memory:');
  for (const f of [CREDIT, CHECKING]) importCsvContent(db, f, fixture(f));
  finishImports(db);
  return db;
}
const count = (db: Database.Database) => (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;

describe('Backup files', () => {
  it('B-01: a backup restores to the same data', () => {
    const db = loadedDb();
    const file = createBackup(db);
    expect(isEncryptedBackup(file)).toBe(false);
    const { tmpPath, info } = prepareRestore(file);
    const restored = new Database(tmpPath, { readonly: true });
    expect(count(restored)).toBe(count(db));
    expect(info.transactions).toBe(count(db));
    restored.close();
    fs.rmSync(tmpPath);
  });

  it('B-02: a password-protected backup is encrypted and needs the right password', () => {
    const db = loadedDb();
    const file = createBackup(db, 'correct horse battery');
    expect(isEncryptedBackup(file)).toBe(true);
    expect(file.includes(Buffer.from('SQLite format 3'))).toBe(false);
    expect(file.includes(Buffer.from('TRADER JOE'))).toBe(false); // no readable transaction data
    expect(() => prepareRestore(file)).toThrow(/password/);
    expect(() => prepareRestore(file, 'wrong password')).toThrow(/Wrong password/);
    const { tmpPath, info } = prepareRestore(file, 'correct horse battery');
    expect(info.transactions).toBe(count(db));
    fs.rmSync(tmpPath);
  });

  it('B-03: rejects files that are not WalletWhisper backups, or are from a newer version', () => {
    expect(() => prepareRestore(Buffer.from('hello'))).toThrow(/isn't a WalletWhisper backup/);
    const other = path.join(os.tmpdir(), `ww-other-${process.pid}.db`);
    const o = new Database(other);
    o.exec('CREATE TABLE notes (x)');
    o.close();
    expect(() => prepareRestore(fs.readFileSync(other))).toThrow(/doesn't contain WalletWhisper data/);
    const newer = path.join(os.tmpdir(), `ww-newer-${process.pid}.db`);
    const n = new Database(newer);
    n.exec('CREATE TABLE transactions (x); CREATE TABLE accounts (x); CREATE TABLE imports (x); CREATE TABLE categories (x);');
    n.pragma('user_version = 999');
    n.close();
    expect(() => prepareRestore(fs.readFileSync(newer))).toThrow(/newer WalletWhisper/);
    fs.rmSync(other); fs.rmSync(newer);
  });
});

describe('Moving to another computer through the app', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walletwhisper-move-'));
  const savedEnv = { db: process.env.SPENDING_DB_PATH, cfg: process.env.WALLETWHISPER_CONFIG };
  let app: any;
  let token: string;
  const post = (url: string) => request(app).post(url).set('X-App-Token', token);

  beforeAll(async () => {
    delete process.env.SPENDING_DB_PATH;
    process.env.WALLETWHISPER_CONFIG = path.join(root, 'config.json'); // this file's own settings
    resetDbInstance();
    app = await createServer();
    token = (await request(app).get('/api/session')).body.token;
    await post('/api/setup').send({ folder: path.join(root, 'computer-a') });
  });

  afterAll(() => {
    resetDbInstance();
    process.env.SPENDING_DB_PATH = savedEnv.db;
    process.env.WALLETWHISPER_CONFIG = savedEnv.cfg;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('M-10: export, then restore replaces the data (after confirming) and keeps a copy of the old data', async () => {
    await post('/api/imports').attach('files', path.resolve(__dirname, 'fixtures', CREDIT)).field('choices', '[{}]');
    const before = (await request(app).get('/api/transactions?kind=all')).body.count;
    expect(before).toBeGreaterThan(0);

    const exported = await post('/api/backup/export').send({ password: 'moving day 2026' }).buffer(true)
      .parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(exported.status).toBe(200);
    expect(exported.headers['content-disposition']).toMatch(/walletwhisper-backup-.*\.wwbackup/);
    const file: Buffer = exported.body;

    // Change the data, then bring the backup back
    await post('/api/imports').attach('files', path.resolve(__dirname, 'fixtures', CHECKING)).field('choices', '[{}]');
    expect((await request(app).get('/api/transactions?kind=all')).body.count).toBeGreaterThan(before);

    const inspect = await post('/api/backup/inspect').attach('file', file, 'b.wwbackup');
    expect(inspect.body).toEqual({ needsPassword: true });
    const looked = await post('/api/backup/inspect').attach('file', file, 'b.wwbackup').field('password', 'moving day 2026');
    expect(looked.body.info.transactions).toBe(before);

    const unconfirmed = await post('/api/backup/restore').attach('file', file, 'b.wwbackup').field('password', 'moving day 2026');
    expect(unconfirmed.status).toBe(400);
    const restored = await post('/api/backup/restore').attach('file', file, 'b.wwbackup')
      .field('password', 'moving day 2026').field('confirm', 'REPLACE');
    expect(restored.status).toBe(200);
    expect((await request(app).get('/api/transactions?kind=all')).body.count).toBe(before);

    // Still fully manageable after restoring
    expect((await post('/api/people').send({ name: 'After Restore' })).status).toBe(200);
    const saved = fs.readdirSync(path.join(root, 'computer-a', 'backups')).filter(f => f.startsWith('before-restore'));
    expect(saved).toHaveLength(1);
  });
});
