import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { runMigrations } from './migrations.js';
import { dataFolder } from './config.js';

export type Db = Database.Database;

let dbInstance: Db | null = null;

/**
 * The folder the user chose for their data (app.db + backups/), or null before first-run setup.
 * Tests set SPENDING_DB_PATH=':memory:' so they never touch real data.
 */
export function currentDataFolder(): string | null {
  if (process.env.SPENDING_DB_PATH) return null;
  return dataFolder();
}

export function isSetUp(): boolean {
  return !!process.env.SPENDING_DB_PATH || currentDataFolder() !== null;
}

/** Path of the live database. */
export function dbPath(): string {
  if (process.env.SPENDING_DB_PATH) return process.env.SPENDING_DB_PATH;
  const folder = currentDataFolder();
  if (!folder) throw new Error('No data folder chosen yet');
  return path.join(folder, 'app.db');
}

export function backupDir(): string {
  if (process.env.SPENDING_BACKUP_DIR) return process.env.SPENDING_BACKUP_DIR;
  const folder = currentDataFolder();
  return path.join(folder ?? path.resolve(process.cwd(), 'data'), 'backups');
}

/** Open a database, enable WAL + foreign keys, and bring the schema up to date. */
export function openDb(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, (fromVersion) => {
    if (file !== ':memory:' && fromVersion > 0) backupDb(db, `pre-migration-v${fromVersion}`);
  });
  return db;
}

export function getDb(): Db {
  if (!dbInstance) {
    dbInstance = openDb(dbPath());
    if (dbPath() !== ':memory:') dailyBackup(dbInstance);
  }
  return dbInstance;
}

/** Close the shared instance (used by tests to get a fresh in-memory database). */
export function resetDbInstance(): void {
  dbInstance?.close();
  dbInstance = null;
}

/** Write a consistent snapshot to data/backups/<label>-<timestamp>.db. Returns the file path. */
export function backupDb(db: Db, label: string): string | null {
  if (db.memory) return null;
  fs.mkdirSync(backupDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(backupDir(), `${label}-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

/** One backup per day, keeping the newest 14 daily files. */
function dailyBackup(db: Db): void {
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const daily = fs.readdirSync(dir).filter(f => f.startsWith('daily-')).sort();
    if (!daily.some(f => f.startsWith(`daily-${today}`))) {
      backupDb(db, 'daily');
      daily.push(`daily-${today}`);
    }
    const all = fs.readdirSync(dir).filter(f => f.startsWith('daily-')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 14))) {
      fs.unlinkSync(path.join(dir, old));
    }
  } catch (err: any) {
    console.warn('Daily backup failed:', err.message);
  }
}

export function audit(db: Db, action: string, detail: unknown): void {
  db.prepare('INSERT INTO audit_log (at, action, detail) VALUES (?, ?, ?)')
    .run(new Date().toISOString(), action, JSON.stringify(detail));
}

export function getSetting(db: Db, key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
