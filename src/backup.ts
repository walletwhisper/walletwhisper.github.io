import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type { Db } from './db.js';
import { SCHEMA_VERSION } from './migrations.js';
import { UserError } from './errors.js';

/**
 * Portable backup files for moving WalletWhisper to another computer.
 *
 *   WALLETWHISPER-BACKUP 1\n
 *   {"app":"WalletWhisper","format":1,"createdAt":...,"encrypted":true,"salt":...,"iv":...,"tag":...}\n
 *   <SQLite database bytes, AES-256-GCM encrypted when a password is given>
 *
 * A plain SQLite file (e.g. one of the automatic backups) is also accepted when restoring.
 */

export const BACKUP_EXTENSION = '.wwbackup';
const MAGIC = Buffer.from('WALLETWHISPER-BACKUP 1\n');
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

interface Header {
  app: 'WalletWhisper';
  format: 1;
  createdAt: string;
  encrypted: boolean;
  salt?: string;
  iv?: string;
  tag?: string;
}

const tempFile = (label: string) =>
  path.join(os.tmpdir(), `walletwhisper-${label}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`);

function keyFrom(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password.normalize('NFKC'), salt, 32, SCRYPT);
}

/** A consistent snapshot of the live database, packed (and optionally encrypted) for download. */
export function createBackup(db: Db, password?: string): Buffer {
  const tmp = tempFile('export');
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const data = fs.readFileSync(tmp);
    const header: Header = { app: 'WalletWhisper', format: 1, createdAt: new Date().toISOString(), encrypted: !!password };
    let payload = data;
    if (password) {
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(password, salt), iv);
      payload = Buffer.concat([cipher.update(data), cipher.final()]);
      Object.assign(header, { salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
    }
    return Buffer.concat([MAGIC, Buffer.from(JSON.stringify(header) + '\n'), payload]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function isEncryptedBackup(file: Buffer): boolean {
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) return false;
  const end = file.indexOf(0x0a, MAGIC.length);
  try { return JSON.parse(file.subarray(MAGIC.length, end).toString('utf8')).encrypted === true; } catch { return false; }
}

/** Unpack a backup file to the raw SQLite bytes, decrypting if needed. */
function unpack(file: Buffer, password?: string): Buffer {
  if (file.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return file;
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new UserError("That isn't a WalletWhisper backup file.");
  }
  const end = file.indexOf(0x0a, MAGIC.length);
  let header: Header;
  try { header = JSON.parse(file.subarray(MAGIC.length, end).toString('utf8')); } catch {
    throw new UserError('This backup file is damaged.');
  }
  if (header.format !== 1) throw new UserError('This backup was made by a newer WalletWhisper. Update the app on this computer first.');
  const payload = file.subarray(end + 1);
  if (!header.encrypted) return payload;
  if (!password) throw new UserError('This backup is protected with a password. Enter it to restore.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(password, Buffer.from(header.salt!, 'base64')), Buffer.from(header.iv!, 'base64'));
    decipher.setAuthTag(Buffer.from(header.tag!, 'base64'));
    return Buffer.concat([decipher.update(payload), decipher.final()]);
  } catch {
    throw new UserError('Wrong password, or the backup file is damaged.');
  }
}

export interface BackupInfo { transactions: number; accounts: number; people: number; from: string | null; to: string | null }

/**
 * Check a backup and write its database to a temporary file, ready to swap in.
 * Returns the temp path (the caller moves or deletes it) and what the backup contains.
 */
export function prepareRestore(file: Buffer, password?: string): { tmpPath: string; info: BackupInfo } {
  const data = unpack(file, password);
  if (!data.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) throw new UserError('This backup file is damaged.');
  const tmpPath = tempFile('restore');
  fs.writeFileSync(tmpPath, data);
  let check: Database.Database | null = null;
  try {
    check = new Database(tmpPath, { readonly: true, fileMustExist: true });
    if (check.pragma('quick_check', { simple: true }) !== 'ok') throw new UserError('This backup file is damaged.');
    const version = check.pragma('user_version', { simple: true }) as number;
    if (version > SCHEMA_VERSION) throw new UserError('This backup was made by a newer WalletWhisper. Update the app on this computer first.');
    const tables = new Set((check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(t => t.name));
    if (!['transactions', 'accounts', 'imports', 'categories'].every(t => tables.has(t))) {
      throw new UserError("That file doesn't contain WalletWhisper data.");
    }
    const n = (sql: string) => (check!.prepare(sql).get() as { n: number }).n;
    const range = check.prepare('SELECT MIN(txn_date) AS from_, MAX(txn_date) AS to_ FROM transactions').get() as { from_: string | null; to_: string | null };
    const info: BackupInfo = {
      transactions: n('SELECT COUNT(*) AS n FROM transactions'),
      accounts: n('SELECT COUNT(*) AS n FROM accounts'),
      people: tables.has('people') ? n('SELECT COUNT(*) AS n FROM people') : 0,
      from: range.from_,
      to: range.to_,
    };
    check.close();
    return { tmpPath, info };
  } catch (err) {
    check?.close();
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

/** Put a prepared database in place of the live one (the live one must be closed first). */
export function swapInDatabase(tmpPath: string, livePath: string): void {
  for (const suffix of ['-wal', '-shm']) fs.rmSync(livePath + suffix, { force: true });
  fs.copyFileSync(tmpPath, livePath);
  fs.rmSync(tmpPath, { force: true });
}

export function backupFileName(date = new Date()): string {
  return `walletwhisper-backup-${date.toISOString().slice(0, 10)}${BACKUP_EXTENSION}`;
}
