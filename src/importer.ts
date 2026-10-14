import { parse } from 'csv-parse/browser/esm/sync';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Db } from './db.js';
import { bankRegistry } from './registry.js';
import { cleanMerchant } from './cleaner.js';
import { createClassifier } from './classifier.js';
import { applyDecisions, recompute } from './ledger.js';
import type { RecomputeStats } from './ledger.js';
import type { BankProfile, ParsedRow } from './types.js';
import { UserError } from './errors.js';

export const MAX_ROWS_PER_FILE = 50_000;

interface ParsedFile {
  profile: BankProfile;
  last4: string | null;
  rows: ParsedRow[];
  unparsable: number;
}

export interface AccountChoice {
  /** Existing account to import into. */
  accountId?: number;
  /** Or create a new one. */
  newAccount?: { nickname?: string };
}

export interface PreviewResult {
  filename: string;
  error?: string;
  profileId?: string;
  bank?: string;
  accountType?: string;
  last4?: string | null;
  /** Account the rows will go into if the user doesn't pick another; null = a new account. */
  suggestedAccountId?: number | null;
  /** True when we can't tell which account this file belongs to. */
  needsAccountChoice?: boolean;
  accountOptions?: { id: number; label: string }[];
  rows?: number;
  newRows?: number;
  duplicates?: number;
  minDate?: string;
  maxDate?: string;
}

export interface ImportResult {
  filename: string;
  bank: string;
  accountType: string;
  accountId?: number;
  rowsAdded: number;
  rowsSkipped: number;
  importId?: number;
  error?: string;
}

function parseFile(filename: string, csvText: string): ParsedFile | { error: string } {
  let records: Record<string, string>[];
  try {
    records = parse(csvText.replace(/^﻿/, ''), {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true, // Chase checking rows have a trailing comma
      trim: true
    });
  } catch (err: any) {
    return { error: `Could not read this CSV file: ${err.message}` };
  }
  if (records.length === 0) return { error: 'The CSV file contains no rows' };
  if (records.length > MAX_ROWS_PER_FILE) return { error: `Too many rows (limit ${MAX_ROWS_PER_FILE})` };

  const headers = Object.keys(records[0]);
  const profile = bankRegistry.detect(headers);
  if (!profile) return { error: `Unrecognized bank format. Headers found: ${headers.join(', ')}` };

  const rows: ParsedRow[] = [];
  let unparsable = 0;
  for (const r of records) {
    const p = profile.parseRow(r);
    if (p) rows.push(p); else unparsable++;
  }
  return { profile, last4: profile.last4FromFilename?.(filename) ?? null, rows, unparsable };
}

/** Fingerprints for a file's rows; identical rows in one file get increasing occurrence numbers. */
function fingerprints(accountId: number, rows: ParsedRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map(r => {
    const base = `${accountId}|${r.date}|${r.rawDescription}|${r.amountCents}`;
    const occ = (seen.get(base) || 0) + 1;
    seen.set(base, occ);
    return bytesToHex(sha256(utf8ToBytes(`${base}|${occ}`)));
  });
}

export function accountLabel(a: { nickname: string | null; bank: string; account_type: string; last4: string | null }): string {
  const base = a.nickname || `${a.bank} ${a.account_type}`;
  return a.last4 && !base.includes(a.last4) ? `${base} ··${a.last4}` : base;
}

interface AccountRow { id: number; profile_id: string; bank: string; account_type: string; nickname: string | null; last4: string | null; }

/** Which existing account a file belongs to, or null if a new account should be created. */
function resolveAccount(db: Db, profile: BankProfile, last4: string | null): { accountId: number | null; ambiguous: boolean; options: AccountRow[] } {
  const options = db.prepare('SELECT id, profile_id, bank, account_type, nickname, last4 FROM accounts WHERE profile_id = ? AND is_tracked = 1')
    .all(profile.id) as AccountRow[];
  if (last4) {
    const exact = options.find(a => a.last4 === last4);
    if (exact) return { accountId: exact.id, ambiguous: false, options };
    // A different card from the same bank: new account (ask if there are unlabeled accounts)
    const unlabeled = options.filter(a => !a.last4);
    return { accountId: null, ambiguous: unlabeled.length > 0, options };
  }
  if (options.length === 1) return { accountId: options[0].id, ambiguous: false, options };
  return { accountId: null, ambiguous: options.length > 1, options };
}

export function previewCsv(db: Db, filename: string, csvText: string): PreviewResult {
  const parsed = parseFile(filename, csvText);
  if ('error' in parsed) return { filename, error: parsed.error };
  const { profile, last4, rows } = parsed;
  const { accountId, ambiguous, options } = resolveAccount(db, profile, last4);

  let duplicates = 0;
  if (accountId) {
    const exists = db.prepare('SELECT 1 FROM transactions WHERE fingerprint = ?');
    duplicates = fingerprints(accountId, rows).filter(fp => exists.get(fp)).length;
  }
  const dates = rows.map(r => r.date).sort();
  return {
    filename,
    profileId: profile.id,
    bank: profile.bank,
    accountType: profile.accountType,
    last4,
    suggestedAccountId: accountId,
    needsAccountChoice: ambiguous,
    accountOptions: options.map(a => ({ id: a.id, label: accountLabel(a) })),
    rows: rows.length,
    newRows: rows.length - duplicates,
    duplicates,
    minDate: dates[0],
    maxDate: dates[dates.length - 1]
  };
}

/**
 * Import one file. Does not run the transfer matcher; call finishImports() after a batch.
 * Rows already present (same fingerprint) are skipped, but their bank-derived fields
 * (direction, original kind) are refreshed so re-importing fixes older data.
 */
export function importCsvContent(db: Db, filename: string, csvText: string, choice: AccountChoice = {}): ImportResult {
  const parsed = parseFile(filename, csvText);
  if ('error' in parsed) {
    return { filename, bank: 'Unknown', accountType: 'Unknown', rowsAdded: 0, rowsSkipped: 0, error: parsed.error };
  }
  const { profile, last4, rows, unparsable } = parsed;

  return db.transaction((): ImportResult => {
    let accountId = choice.accountId ?? null;
    if (accountId) {
      const acct = db.prepare('SELECT id, profile_id, last4 FROM accounts WHERE id = ?').get(accountId) as AccountRow | undefined;
      if (!acct || acct.profile_id !== profile.id) throw new UserError(`Account ${accountId} is not a ${profile.bank} ${profile.accountType} account`);
      if (last4 && !acct.last4) db.prepare('UPDATE accounts SET last4 = ? WHERE id = ?').run(last4, accountId);
    } else if (!choice.newAccount) {
      accountId = resolveAccount(db, profile, last4).accountId;
    }
    if (!accountId) {
      const nickname = choice.newAccount?.nickname?.trim()
        || `${profile.bank} ${profile.accountType === 'credit' ? 'Credit' : 'Checking'}${last4 ? ` ··${last4}` : ''}`;
      accountId = Number(db.prepare(
        'INSERT INTO accounts (profile_id, bank, account_type, nickname, last4, is_tracked) VALUES (?, ?, ?, ?, ?, 1)'
      ).run(profile.id, profile.bank, profile.accountType, nickname, last4).lastInsertRowid);
    }

    const importId = Number(db.prepare(
      'INSERT INTO imports (account_id, filename, imported_at, rows_added, rows_skipped) VALUES (?, ?, ?, 0, 0)'
    ).run(accountId, filename, new Date().toISOString()).lastInsertRowid);

    const classify = createClassifier(db);
    const exists = db.prepare('SELECT id FROM transactions WHERE fingerprint = ?');
    // Re-import restores the exact direction; it may upgrade the bank's kind to 'transfer' but never
    // downgrades one (v0.1 rows may carry a transfer judgment that the CSV alone can't reproduce)
    const refresh = db.prepare("UPDATE transactions SET direction = ?, bank_kind = CASE WHEN ? = 'transfer' THEN 'transfer' ELSE bank_kind END WHERE id = ?");
    const insert = db.prepare(`
      INSERT INTO transactions (
        import_id, account_id, txn_date, raw_description, merchant, amount_cents, kind, bank_kind, direction,
        transfer_via, category_id, category_source, bank_category, fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const fps = fingerprints(accountId, rows);
    let added = 0;
    let skipped = unparsable;
    rows.forEach((r, i) => {
      const existing = exists.get(fps[i]) as { id: number } | undefined;
      if (existing) {
        refresh.run(r.direction, r.kind, existing.id);
        skipped++;
        return;
      }
      const merchant = cleanMerchant(r.rawDescription);
      const { categoryId, categorySource } = classify(merchant, r.kind, r.bankCategory);
      insert.run(importId, accountId, r.date, r.rawDescription, merchant, r.amountCents, r.kind, r.kind, r.direction,
        r.kind === 'transfer' ? 'bank' : null, categoryId, categorySource, r.bankCategory || null, fps[i]);
      added++;
    });

    const dates = rows.map(r => r.date).sort();
    db.prepare('UPDATE imports SET rows_added = ?, rows_skipped = ?, min_date = ?, max_date = ? WHERE id = ?')
      .run(added, skipped, dates[0] ?? null, dates[dates.length - 1] ?? null, importId);

    applyDecisions(db, importId);

    return { filename, bank: profile.bank, accountType: profile.accountType, accountId, rowsAdded: added, rowsSkipped: skipped, importId };
  })();
}

/** Run after a batch of imports (or an undo): pair transfers and re-derive categories/people. */
export function finishImports(db: Db): RecomputeStats {
  return recompute(db);
}

/** v0.1 accounts have no last 4 digits; recover them from the filenames they were imported from. */
export function backfillLast4(db: Db): void {
  const accounts = db.prepare('SELECT id, profile_id FROM accounts WHERE last4 IS NULL AND is_tracked = 1').all() as { id: number; profile_id: string }[];
  for (const a of accounts) {
    const profile = bankRegistry.getProfile(a.profile_id);
    if (!profile?.last4FromFilename) continue;
    const found = new Set(
      (db.prepare('SELECT filename FROM imports WHERE account_id = ?').all(a.id) as { filename: string }[])
        .map(i => profile.last4FromFilename!(i.filename))
        .filter(Boolean)
    );
    if (found.size === 1) {
      const last4 = [...found][0];
      const type = profile.accountType === 'credit' ? 'Credit' : 'Checking';
      // Replace the generated v0.1 nickname ("Chase CHECKING"), keep anything the user typed
      db.prepare(`UPDATE accounts SET last4 = ?,
                    nickname = CASE WHEN nickname IS NULL OR nickname = ? THEN ? ELSE nickname END
                  WHERE id = ?`)
        .run(last4, `${profile.bank} ${profile.accountType.toUpperCase()}`, `${profile.bank} ${type} ··${last4}`, a.id);
    }
  }
}
