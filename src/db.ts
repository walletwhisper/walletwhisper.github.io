import initSqlJs, { Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { DEFAULT_CATEGORIES } from './taxonomy.js';

let dbInstance: Database | null = null;
const dbDir = path.resolve(process.cwd(), 'data');
const dbFile = path.join(dbDir, 'app.db');

export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;

  const SQL = await initSqlJs();

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (fs.existsSync(dbFile)) {
    const fileBuffer = fs.readFileSync(dbFile);
    dbInstance = new SQL.Database(fileBuffer);
  } else {
    dbInstance = new SQL.Database();
  }

  initSchema(dbInstance);
  saveDb();
  return dbInstance;
}

export function saveDb(): void {
  if (!dbInstance) return;
  const data = dbInstance.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbFile, buffer);
}

function initSchema(db: Database) {
  db.run(`
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
      source TEXT NOT NULL, -- 'default' | 'user'
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
      category_source TEXT NOT NULL, -- 'manual' | 'user_rule' | 'default_rule' | 'bank' | 'uncategorized'
      bank_category TEXT,
      fingerprint TEXT NOT NULL UNIQUE,
      FOREIGN KEY (import_id) REFERENCES imports(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );
  `);

  // Seed default categories if empty
  const res = db.exec("SELECT COUNT(*) as cnt FROM categories");
  const count = res[0]?.values[0]?.[0] as number || 0;

  if (count === 0) {
    for (const cat of DEFAULT_CATEGORIES) {
      db.run(
        "INSERT INTO categories (name, color, is_system) VALUES (?, ?, ?)",
        [cat.name, cat.color, cat.isSystem ? 1 : 0]
      );
    }

    // Seed default keyword rules
    const catRows = db.exec("SELECT id, name FROM categories");
    const catMap = new Map<string, number>();
    for (const row of catRows[0].values) {
      catMap.set(row[1] as string, row[0] as number);
    }

    for (const catDef of DEFAULT_CATEGORIES) {
      const catId = catMap.get(catDef.name);
      if (!catId) continue;
      for (const kw of catDef.keywords) {
        db.run(
          "INSERT INTO rules (pattern, category_id, priority, source) VALUES (?, ?, 1, 'default')",
          [kw.toLowerCase(), catId]
        );
      }
    }
  }
}
