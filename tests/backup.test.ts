import { describe, it, expect } from 'vitest';
import nodeCrypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { openDb } from '../src/db.js';
import { Db } from '../src/sqlite.js';
import { finishImports, importCsvContent } from '../src/importer.js';
import { createBackup, isEncryptedBackup, readBackup } from '../src/backup.js';
import { LocalApi } from '../src/app.js';
import { client, fixtureFile, memoryHost } from './helpers.js';

const fixture = (name: string) => fs.readFileSync(path.resolve(__dirname, 'fixtures', name), 'utf8');
const CREDIT = 'Chase1234_Activity_20261031.CSV';
const CHECKING = 'Chase5678_Activity_20261031.CSV';

function loadedDb() {
  const db = openDb(':memory:');
  for (const f of [CREDIT, CHECKING]) importCsvContent(db, f, fixture(f));
  finishImports(db);
  return db;
}
const count = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
const has = (data: Uint8Array, text: string) => Buffer.from(data).includes(Buffer.from(text));

describe('Backup files', () => {
  it('B-01: a backup restores to the same data', async () => {
    const db = loadedDb();
    const file = await createBackup(db);
    expect(isEncryptedBackup(file)).toBe(false);
    const { data, info } = await readBackup(file);
    const restored = openDb(data);
    expect(count(restored)).toBe(count(db));
    expect(info.transactions).toBe(count(db));
  });

  it('B-02: a password-protected backup is encrypted and needs the right password', async () => {
    const db = loadedDb();
    const file = await createBackup(db, 'correct horse battery');
    expect(isEncryptedBackup(file)).toBe(true);
    expect(has(file, 'SQLite format 3')).toBe(false);
    expect(has(file, 'TRADER JOE')).toBe(false); // no readable transaction data
    await expect(readBackup(file)).rejects.toThrow(/password/);
    await expect(readBackup(file, 'wrong password')).rejects.toThrow(/Wrong password/);
    const { info } = await readBackup(file, 'correct horse battery');
    expect(info.transactions).toBe(count(db));
  });

  it('B-03: rejects files that are not WalletWhisper backups, or are from a newer version', async () => {
    await expect(readBackup(new TextEncoder().encode('hello'))).rejects.toThrow(/isn't a WalletWhisper backup/);
    const other = new Db();
    other.exec('CREATE TABLE notes (x)');
    await expect(readBackup(other.export())).rejects.toThrow(/doesn't contain WalletWhisper data/);
    const newer = new Db();
    newer.exec('CREATE TABLE transactions (x); CREATE TABLE accounts (x); CREATE TABLE imports (x); CREATE TABLE categories (x);');
    newer.pragma('user_version = 999');
    await expect(readBackup(newer.export())).rejects.toThrow(/newer WalletWhisper/);
  });

  it('B-04: opens password-protected backups made by the earlier desktop version', async () => {
    // Exactly how the desktop version (Node crypto) wrote them
    const data = Buffer.from(loadedDb().export());
    const salt = nodeCrypto.randomBytes(16);
    const iv = nodeCrypto.randomBytes(12);
    const key = nodeCrypto.scryptSync('moving day 2026'.normalize('NFKC'), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    const payload = Buffer.concat([cipher.update(data), cipher.final()]);
    const header = { app: 'WalletWhisper', format: 1, createdAt: '2026-10-01T00:00:00Z', encrypted: true,
      salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    const file = Buffer.concat([Buffer.from('WALLETWHISPER-BACKUP 1\n'), Buffer.from(JSON.stringify(header) + '\n'), payload]);
    const { info } = await readBackup(new Uint8Array(file), 'moving day 2026');
    expect(info.transactions).toBe(count(loadedDb()));
    // ...and the desktop version's own data file (app.db) can be restored directly
    expect((await readBackup(new Uint8Array(data))).info.transactions).toBe(info.transactions);
  });
});

describe('Moving to another computer through the app', () => {
  const host = memoryHost();
  const api = client(new LocalApi(host, null));
  const backupOf = (r: { body: { bytes: Uint8Array } }) => ({ name: 'b.wwbackup', bytes: r.body.bytes });

  it('M-09: a new computer can restore a backup instead of starting empty', async () => {
    const other = client(new LocalApi(memoryHost(), null));
    await other.post('/api/setup');
    await other.post('/api/imports', { files: [fixtureFile(CREDIT)], choices: '{}' });
    const file = backupOf(await other.post('/api/backup/export', {}));

    const fresh = client(new LocalApi(memoryHost(), null));
    expect((await fresh.post('/api/backup/restore', { files: [file] })).status).toBe(200);
    expect((await fresh.get('/api/transactions?kind=all')).body.count).toBe(6);
  });

  it('M-10: export, then restore replaces the data (after confirming) and keeps a copy of the old data', async () => {
    await api.post('/api/setup');
    await api.post('/api/imports', { files: [fixtureFile(CREDIT)], choices: '{}' });
    const before = (await api.get('/api/transactions?kind=all')).body.count;
    expect(before).toBeGreaterThan(0);

    const exported = await api.post('/api/backup/export', { password: 'moving day 2026' });
    expect(exported.status).toBe(200);
    expect(exported.body.filename).toMatch(/walletwhisper-backup-.*\.wwbackup/);
    expect((await api.post('/api/backup/export', { password: 'short' })).status).toBe(400);
    const file = backupOf(exported);

    // Change the data, then bring the backup back
    await api.post('/api/imports', { files: [fixtureFile(CHECKING)], choices: '{}' });
    expect((await api.get('/api/transactions?kind=all')).body.count).toBeGreaterThan(before);

    expect((await api.post('/api/backup/inspect', { files: [file] })).body).toEqual({ needsPassword: true });
    const looked = await api.post('/api/backup/inspect', { files: [file], password: 'moving day 2026' });
    expect(looked.body.info.transactions).toBe(before);

    const unconfirmed = await api.post('/api/backup/restore', { files: [file], password: 'moving day 2026' });
    expect(unconfirmed.status).toBe(400);
    const restored = await api.post('/api/backup/restore', { files: [file], password: 'moving day 2026', confirm: 'REPLACE' });
    expect(restored.status).toBe(200);
    expect((await api.get('/api/transactions?kind=all')).body.count).toBe(before);

    // Still fully manageable after restoring
    expect((await api.post('/api/people', { name: 'After Restore' })).status).toBe(200);
    expect(host.snapshots.filter(s => s === 'before-restore')).toHaveLength(1);
  });

  it('M-11: a backup that differs is compared first, then combined', async () => {
    const file = backupOf(await api.post('/api/backup/export', {}));
    // After the backup was made, this computer imports more
    await api.post('/api/imports', { files: [fixtureFile(CHECKING)], choices: '{}' });
    const here = (await api.get('/api/transactions?kind=all')).body.count;

    const cmp = await api.post('/api/backup/compare', { files: [file] });
    expect(cmp.status).toBe(200);
    expect(cmp.body.preview.identical).toBe(false);
    expect(cmp.body.preview.localOnlyTransactions).toBeGreaterThan(0);
    expect(cmp.body.preview.newTransactions).toBe(0);

    const merged = await api.post('/api/backup/merge', { compareId: cmp.body.compareId, choices: {}, removeLocalOnly: false });
    expect(merged.body).toMatchObject({ success: true, added: 0, removed: 0 });
    expect((await api.get('/api/transactions?kind=all')).body.count).toBe(here); // nothing lost
    expect(host.snapshots).toContain('before-merge');
    expect((await api.post('/api/backup/merge', { compareId: cmp.body.compareId })).status).toBe(400); // used up
  });

  it('M-12: comparing a backup with identical data says so', async () => {
    const file = backupOf(await api.post('/api/backup/export', {}));
    const cmp = await api.post('/api/backup/compare', { files: [file] });
    expect(cmp.body).toMatchObject({ compareId: null, preview: { identical: true } });
  });
});
