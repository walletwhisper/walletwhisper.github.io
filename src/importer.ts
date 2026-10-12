import { parse } from 'csv-parse/sync';
import crypto from 'crypto';
import { Database } from 'sql.js';
import { bankRegistry } from './registry.js';
import { cleanMerchant } from './cleaner.js';
import { classifyTransaction } from './classifier.js';
import { saveDb } from './db.js';

export interface ImportResult {
  filename: string;
  bank: string;
  accountType: string;
  rowsAdded: number;
  rowsSkipped: number;
  importId?: number;
  error?: string;
}

export function importCsvContent(
  db: Database,
  filename: string,
  csvText: string
): ImportResult {
  // Parse CSV records
  let records: Record<string, string>[] = [];
  try {
    records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true, // Handle Chase checking trailing commas
      trim: true
    });
  } catch (err: any) {
    return {
      filename,
      bank: 'Unknown',
      accountType: 'Unknown',
      rowsAdded: 0,
      rowsSkipped: 0,
      error: `Failed to parse CSV file: ${err.message}`
    };
  }

  if (records.length === 0) {
    return {
      filename,
      bank: 'Unknown',
      accountType: 'Unknown',
      rowsAdded: 0,
      rowsSkipped: 0,
      error: 'CSV file contains no rows'
    };
  }

  // Detect bank profile from headers
  const headers = Object.keys(records[0]);
  const profile = bankRegistry.detect(headers);

  if (!profile) {
    return {
      filename,
      bank: 'Unknown',
      accountType: 'Unknown',
      rowsAdded: 0,
      rowsSkipped: 0,
      error: `Unrecognized bank format. Headers found: ${headers.join(', ')}`
    };
  }

  // Find or create account
  const accQuery = db.exec(
    "SELECT id FROM accounts WHERE profile_id = ?",
    [profile.id]
  );
  let accountId: number;
  if (accQuery.length > 0 && accQuery[0].values.length > 0) {
    accountId = accQuery[0].values[0][0] as number;
  } else {
    db.run(
      "INSERT INTO accounts (profile_id, bank, account_type, nickname) VALUES (?, ?, ?, ?)",
      [profile.id, profile.bank, profile.accountType, `${profile.bank} ${profile.accountType.toUpperCase()}`]
    );
    const lastId = db.exec("SELECT last_insert_rowid()")[0].values[0][0] as number;
    accountId = lastId;
  }

  // Create import record
  db.run(
    "INSERT INTO imports (account_id, filename, imported_at, rows_added, rows_skipped) VALUES (?, ?, ?, 0, 0)",
    [accountId, filename, new Date().toISOString()]
  );
  const importId = db.exec("SELECT last_insert_rowid()")[0].values[0][0] as number;

  let added = 0;
  let skipped = 0;

  // Track occurrence index per identical row inside this specific file
  const occurrenceMap = new Map<string, number>();

  for (const rawRow of records) {
    const parsed = profile.parseRow(rawRow);
    if (!parsed) {
      skipped++;
      continue;
    }

    const merchant = cleanMerchant(parsed.rawDescription);

    // Compute occurrence index for two identical transactions on same day
    const rowBaseKey = `${accountId}|${parsed.date}|${parsed.rawDescription}|${parsed.amountCents}`;
    const occIndex = (occurrenceMap.get(rowBaseKey) || 0) + 1;
    occurrenceMap.set(rowBaseKey, occIndex);

    // Stable SHA-256 fingerprint for deduplication
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${rowBaseKey}|${occIndex}`)
      .digest('hex');

    // Check if fingerprint already exists
    const exists = db.exec(
      "SELECT 1 FROM transactions WHERE fingerprint = ?",
      [fingerprint]
    );

    if (exists.length > 0 && exists[0].values.length > 0) {
      skipped++;
      continue;
    }

    // Classify
    const { categoryId, categorySource } = classifyTransaction(
      db,
      merchant,
      parsed.kind,
      parsed.bankCategory
    );

    // Insert transaction
    db.run(
      `INSERT INTO transactions (
        import_id, account_id, txn_date, raw_description, merchant,
        amount_cents, kind, category_id, category_source, bank_category, fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        importId,
        accountId,
        parsed.date,
        parsed.rawDescription,
        merchant,
        parsed.amountCents,
        parsed.kind,
        categoryId,
        categorySource,
        parsed.bankCategory || null,
        fingerprint
      ]
    );
    added++;
  }

  // Update import record with final counts
  db.run(
    "UPDATE imports SET rows_added = ?, rows_skipped = ? WHERE id = ?",
    [added, skipped, importId]
  );

  saveDb();

  return {
    filename,
    bank: profile.bank,
    accountType: profile.accountType,
    rowsAdded: added,
    rowsSkipped: skipped,
    importId
  };
}
