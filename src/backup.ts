import { scryptAsync } from '@noble/hashes/scrypt.js';
import type { Db } from './db.js';
import { Db as Database } from './sqlite.js';
import { SCHEMA_VERSION } from './migrations.js';
import { UserError } from './errors.js';

/**
 * Portable backup files for moving WalletWhisper to another computer or browser.
 *
 *   WALLETWHISPER-BACKUP 1\n
 *   {"app":"WalletWhisper","format":1,"createdAt":...,"encrypted":true,"salt":...,"iv":...,"tag":...}\n
 *   <SQLite database bytes, AES-256-GCM encrypted when a password is given>
 *
 * A plain SQLite file (e.g. app.db from the earlier desktop version) is also accepted when restoring.
 */

export const BACKUP_EXTENSION = '.wwbackup';
const enc = new TextEncoder();
const MAGIC = enc.encode('WALLETWHISPER-BACKUP 1\n');
const SQLITE_MAGIC = enc.encode('SQLite format 3\0');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 };

interface Header {
  app: 'WalletWhisper';
  format: 1;
  createdAt: string;
  encrypted: boolean;
  salt?: string;
  iv?: string;
  tag?: string;
}

const startsWith = (data: Uint8Array, prefix: Uint8Array) =>
  data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

async function keyFrom(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT);
  return crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Pack the database (and encrypt it, if a password is given) into a backup file. */
export async function createBackup(db: Db, password?: string): Promise<Uint8Array> {
  const data = db.export();
  const header: Header = { app: 'WalletWhisper', format: 1, createdAt: new Date().toISOString(), encrypted: !!password };
  let payload = data;
  if (password) {
    const salt = random(16);
    const iv = random(12);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(password, salt), data as Uint8Array<ArrayBuffer>));
    payload = sealed.subarray(0, sealed.length - 16); // WebCrypto appends the 16-byte tag; the file keeps it in the header
    Object.assign(header, { salt: toBase64(salt), iv: toBase64(iv), tag: toBase64(sealed.subarray(sealed.length - 16)) });
  }
  return concat(MAGIC, enc.encode(JSON.stringify(header) + '\n'), payload);
}

function readHeader(file: Uint8Array): { header: Header; payload: Uint8Array } | null {
  if (!startsWith(file, MAGIC)) return null;
  const end = file.indexOf(0x0a, MAGIC.length);
  try {
    return { header: JSON.parse(new TextDecoder().decode(file.subarray(MAGIC.length, end))), payload: file.subarray(end + 1) };
  } catch {
    throw new UserError('This backup file is damaged.');
  }
}

export function isEncryptedBackup(file: Uint8Array): boolean {
  try { return readHeader(file)?.header.encrypted === true; } catch { return false; }
}

/** Unpack a backup file to the raw SQLite bytes, decrypting if needed. */
async function unpack(file: Uint8Array, password?: string): Promise<Uint8Array> {
  if (startsWith(file, SQLITE_MAGIC)) return file;
  const parsed = readHeader(file);
  if (!parsed) throw new UserError("That isn't a WalletWhisper backup file.");
  const { header, payload } = parsed;
  if (header.format !== 1) throw new UserError('This backup was made by a newer WalletWhisper. Update the app first.');
  if (!header.encrypted) return payload;
  if (!password) throw new UserError('This backup is protected with a password. Enter it to restore.');
  try {
    const key = await keyFrom(password, fromBase64(header.salt!));
    const sealed = concat(payload, fromBase64(header.tag!));
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(header.iv!) as Uint8Array<ArrayBuffer> }, key, sealed as Uint8Array<ArrayBuffer>));
  } catch {
    throw new UserError('Wrong password, or the backup file is damaged.');
  }
}

export interface BackupInfo { transactions: number; accounts: number; people: number; from: string | null; to: string | null }

/** Check a backup file and return its database bytes (ready to load) and what it contains. */
export async function readBackup(file: Uint8Array, password?: string): Promise<{ data: Uint8Array; info: BackupInfo }> {
  const data = await unpack(file, password);
  if (!startsWith(data, SQLITE_MAGIC)) throw new UserError('This backup file is damaged.');
  let check: Database;
  try { check = new Database(data); } catch { throw new UserError('This backup file is damaged.'); }
  try {
    if (check.pragma('quick_check', { simple: true }) !== 'ok') throw new UserError('This backup file is damaged.');
    const version = check.pragma('user_version', { simple: true }) as number;
    if (version > SCHEMA_VERSION) throw new UserError('This backup was made by a newer WalletWhisper. Update the app first.');
    const tables = new Set((check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(t => t.name));
    if (!['transactions', 'accounts', 'imports', 'categories'].every(t => tables.has(t))) {
      throw new UserError("That file doesn't contain WalletWhisper data.");
    }
    const n = (sql: string) => (check.prepare(sql).get() as { n: number }).n;
    const range = check.prepare('SELECT MIN(txn_date) AS from_, MAX(txn_date) AS to_ FROM transactions').get() as { from_: string | null; to_: string | null };
    const info: BackupInfo = {
      transactions: n('SELECT COUNT(*) AS n FROM transactions'),
      accounts: n('SELECT COUNT(*) AS n FROM accounts'),
      people: tables.has('people') ? n('SELECT COUNT(*) AS n FROM people') : 0,
      from: range.from_,
      to: range.to_,
    };
    return { data, info };
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError('This backup file is damaged.');
  } finally {
    check.close();
  }
}

export function backupFileName(date = new Date()): string {
  return `walletwhisper-backup-${date.toISOString().slice(0, 10)}${BACKUP_EXTENSION}`;
}
