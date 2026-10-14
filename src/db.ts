import { Db } from './sqlite.js';
import { runMigrations } from './migrations.js';

export { Db };

/**
 * Open a database (empty, or from the bytes of a saved one), enable foreign keys and bring the
 * schema up to date. `beforeMigrate` runs first if an older database is about to be upgraded,
 * so the caller can keep a copy. `':memory:'` is accepted for an empty database.
 */
export function openDb(data?: Uint8Array | ':memory:', beforeMigrate?: (fromVersion: number) => void): Db {
  const db = new Db(data instanceof Uint8Array ? data : undefined);
  db.pragma('foreign_keys = ON');
  runMigrations(db, beforeMigrate);
  return db;
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
