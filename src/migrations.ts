import type { Db } from './sqlite.js';
import { DEFAULT_CATEGORIES } from './taxonomy.js';

interface Migration {
  version: number;
  name: string;
  up(db: Db): void;
}

/**
 * Numbered schema migrations tracked with PRAGMA user_version.
 * Never edit a released migration; add a new one.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'v0.1 baseline schema',
    up(db) {
      // IF NOT EXISTS: databases created by v0.1 already have these tables at user_version 0
      db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id TEXT NOT NULL,
          bank TEXT NOT NULL,
          account_type TEXT NOT NULL,
          nickname TEXT
        );
        CREATE TABLE IF NOT EXISTS imports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL,
          filename TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          rows_added INTEGER NOT NULL,
          rows_skipped INTEGER NOT NULL,
          FOREIGN KEY (account_id) REFERENCES accounts(id)
        );
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          color TEXT NOT NULL,
          is_system INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern TEXT NOT NULL,
          category_id INTEGER NOT NULL,
          priority INTEGER NOT NULL DEFAULT 10,
          source TEXT NOT NULL,
          FOREIGN KEY (category_id) REFERENCES categories(id)
        );
        CREATE TABLE IF NOT EXISTS transactions (
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
          fingerprint TEXT NOT NULL UNIQUE,
          FOREIGN KEY (import_id) REFERENCES imports(id),
          FOREIGN KEY (account_id) REFERENCES accounts(id),
          FOREIGN KEY (category_id) REFERENCES categories(id)
        );
      `);
    }
  },
  {
    version: 2,
    name: 'v4: accounts, people, transfer matching, review decisions',
    up(db) {
      db.exec(`
        CREATE TABLE people (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          color TEXT NOT NULL,
          aliases TEXT NOT NULL DEFAULT '[]'
        );

        ALTER TABLE accounts ADD COLUMN last4 TEXT;
        ALTER TABLE accounts ADD COLUMN is_tracked INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE accounts ADD COLUMN card_policy TEXT;
        ALTER TABLE accounts ADD COLUMN match_patterns TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE accounts ADD COLUMN default_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL;

        ALTER TABLE imports ADD COLUMN min_date TEXT;
        ALTER TABLE imports ADD COLUMN max_date TEXT;

        ALTER TABLE transactions ADD COLUMN direction TEXT;
        ALTER TABLE transactions ADD COLUMN bank_kind TEXT;
        ALTER TABLE transactions ADD COLUMN kind_source TEXT NOT NULL DEFAULT 'bank';
        ALTER TABLE transactions ADD COLUMN transfer_via TEXT;
        ALTER TABLE transactions ADD COLUMN counterparty_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
        ALTER TABLE transactions ADD COLUMN person_id INTEGER REFERENCES people(id) ON DELETE SET NULL;
        ALTER TABLE transactions ADD COLUMN person_source TEXT;
        ALTER TABLE transactions ADD COLUMN is_one_time INTEGER;
        ALTER TABLE transactions ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0;

        CREATE TABLE person_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern TEXT NOT NULL UNIQUE,
          person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE
        );

        CREATE TABLE transfer_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          out_txn_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
          in_txn_id INTEGER NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
          method TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        -- User answers keyed by fingerprint, so they survive undo + re-import of a file
        CREATE TABLE decisions (
          fingerprint TEXT PRIMARY KEY,
          kind TEXT,
          category_id INTEGER,
          person_id INTEGER,
          is_one_time INTEGER,
          reviewed INTEGER,
          updated_at TEXT NOT NULL
        );

        -- Pairs the user unlinked; the matcher never re-links them
        CREATE TABLE not_pairs (
          out_fingerprint TEXT NOT NULL,
          in_fingerprint TEXT NOT NULL,
          PRIMARY KEY (out_fingerprint, in_fingerprint)
        );

        CREATE TABLE audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          action TEXT NOT NULL,
          detail TEXT
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE INDEX idx_txn_date ON transactions(txn_date);
        CREATE INDEX idx_txn_account_date ON transactions(account_id, txn_date);
        CREATE INDEX idx_txn_person ON transactions(person_id);
        CREATE INDEX idx_txn_import ON transactions(import_id);
      `);

      // Seed categories (new database) or add the ones introduced in v4 (existing database)
      const insertCat = db.prepare('INSERT OR IGNORE INTO categories (name, color, is_system) VALUES (?, ?, ?)');
      for (const cat of DEFAULT_CATEGORIES) insertCat.run(cat.name, cat.color, cat.isSystem ? 1 : 0);

      // Default keyword rules: replace wholesale (Transfer/Income keywords are retired)
      db.prepare("DELETE FROM rules WHERE source = 'default'").run();
      const catId = db.prepare('SELECT id FROM categories WHERE name = ?');
      const insertRule = db.prepare("INSERT INTO rules (pattern, category_id, priority, source) VALUES (?, ?, 1, 'default')");
      for (const cat of DEFAULT_CATEGORIES) {
        const row = catId.get(cat.name) as { id: number } | undefined;
        if (!row) continue;
        for (const kw of cat.keywords) insertRule.run(kw.toLowerCase(), row.id);
      }

      // Backfill: the original kind from the bank, and the money direction
      db.exec(`
        UPDATE transactions SET bank_kind = kind;
        UPDATE transactions SET direction = CASE
          WHEN kind IN ('spend', 'fee') THEN 'out'
          WHEN kind IN ('refund', 'income') THEN 'in'
          WHEN kind = 'transfer' AND account_id IN (SELECT id FROM accounts WHERE account_type = 'credit') THEN 'in'
          WHEN kind = 'transfer' AND (
            UPPER(raw_description) LIKE '%FROM%' OR UPPER(raw_description) LIKE '%DEPOSIT%'
            OR UPPER(raw_description) LIKE '% CR %' OR UPPER(raw_description) LIKE 'MANUAL CR%'
            OR UPPER(raw_description) LIKE '%CASHOUT%' OR UPPER(raw_description) LIKE '%REVERSAL%'
          ) THEN 'in'
          ELSE 'out'
        END;
        UPDATE transactions SET transfer_via = 'bank' WHERE kind = 'transfer';
        UPDATE imports SET
          min_date = (SELECT MIN(txn_date) FROM transactions t WHERE t.import_id = imports.id),
          max_date = (SELECT MAX(txn_date) FROM transactions t WHERE t.import_id = imports.id);
      `);

      // Existing manual category edits become decisions so they survive re-import
      db.exec(`
        INSERT OR IGNORE INTO decisions (fingerprint, category_id, updated_at)
        SELECT fingerprint, category_id, datetime('now') FROM transactions WHERE category_source = 'manual';
      `);
    }
  }
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Apply pending migrations, each in its own transaction. `beforeMigrate` runs once if any are pending. */
export function runMigrations(db: Db, beforeMigrate?: (fromVersion: number) => void): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.filter(m => m.version > current);
  if (pending.length === 0) return;

  // A v0.1 database has tables but user_version 0; still back it up before changing it
  const hasData = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='transactions'").get() as { n: number }).n > 0;
  beforeMigrate?.(hasData ? Math.max(current, 1) : 0);

  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}
