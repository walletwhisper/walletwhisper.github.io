import { audit, Db, openDb } from './db.js';
import { backupFileName, createBackup, isEncryptedBackup, readBackup } from './backup.js';
import { compareWithBackup, mergeBackup, openBackupCopy } from './merge.js';
import { backfillLast4, finishImports, importCsvContent, previewCsv, accountLabel } from './importer.js';
import type { AccountChoice } from './importer.js';
import { detectProvider, planQuestion, PROVIDER_NAMES, recategorizeWithLlm } from './llm.js';
import { answerQuestion } from './ask.js';
import { parseList, recompute, saveDecision } from './ledger.js';
import { answerReview, getReviewItems, linkManually, pickColor, setKindManually, unlink } from './review.js';
import type { ReviewAnswer } from './review.js';
import { getColumnValues, getCoverage, getSummary, getTransactions, getTrends, parseFilters } from './reports.js';
import type { FilterColumn, StackBy } from './reports.js';
import { UserError } from './errors.js';

/**
 * WalletWhisper's API, running inside the page. There is no server: the screens call these
 * routes directly, and every number is computed from the database in the browser's memory.
 *
 * The host (the browser page, or the tests) decides where the database is kept: it is told after
 * every change, and asked to keep a copy before anything that replaces or deletes data.
 */
export interface Host {
  /** The data changed; save it. */
  save(db: Db): void;
  /** Keep a copy of the data as it is now, before a risky change (undo, reset, restore, combine). */
  snapshot(label: string, data: Uint8Array): void | Promise<void>;
  /** The user's AI key, or null. It stays on this computer and is sent only to that AI provider. */
  aiKey(): string | null;
  setAiKey(key: string | null): void;
}

/** A file picked by the user, already read into memory. */
export interface UploadedFile { name: string; bytes: Uint8Array }

export interface ApiRequest {
  method: string;
  url: string;
  /** JSON body, or form fields plus files. */
  body?: Record<string, unknown> & { files?: UploadedFile[] };
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class BadRequest extends UserError {}

export const RESET_CONFIRMATION = 'DELETE ALL';
const KINDS = new Set(['spend', 'refund', 'income', 'transfer', 'fee']);
const ACCOUNT_TYPES = new Set(['checking', 'credit', 'savings', 'brokerage', 'other']);
const CARD_POLICIES = new Set(['will_import', 'payments_are_spending']);
const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_CSV_FILES = 20;
const MERGE_WINDOW_MS = 30 * 60_000;

interface Ctx {
  query: Record<string, string>;
  body: Record<string, any>;
  files: UploadedFile[];
  id: number;
}
type Handler = (c: Ctx) => unknown;

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');

export class LocalApi {
  private db: Db | null;
  private routes: { method: string; pattern: RegExp; handler: Handler; needsData: boolean }[] = [];
  private pendingMerges = new Map<string, { data: Uint8Array; created: number }>();

  /** `data` is the saved database, or null for a brand-new user (setup comes first). */
  private host: Host;

  constructor(host: Host, data: Uint8Array | null, onMigrate?: (fromVersion: number, oldData: Uint8Array) => void) {
    this.host = host;
    this.db = null;
    if (data) this.load(data, onMigrate);
    this.defineRoutes();
  }

  get ready(): boolean { return this.db !== null; }

  /** The live database (for saving). */
  get database(): Db | null { return this.db; }

  private load(data: Uint8Array | null, onMigrate?: (fromVersion: number, oldData: Uint8Array) => void): void {
    this.db?.close();
    const db = openDb(data ?? undefined, from => { if (data && from > 0) onMigrate?.(from, data); });
    backfillLast4(db);
    recompute(db);
    this.db = db;
    this.host.save(db);
  }

  private snapshot(label: string): Promise<void> | void {
    return this.host.snapshot(label, this.data.export());
  }

  private get data(): Db {
    if (!this.db) throw new ApiError(409, 'Set up WalletWhisper first');
    return this.db;
  }

  private on(method: string, path: string, handler: Handler, needsData = true) {
    const pattern = new RegExp('^' + path.replace(':id', '([^/]+)') + '$');
    this.routes.push({ method, pattern, handler, needsData });
  }

  /** Handle one request. Throws ApiError with a message for the user when something is wrong. */
  async handle(req: ApiRequest): Promise<unknown> {
    const [path, search = ''] = req.url.split('?');
    const route = this.routes.find(r => r.method === req.method && r.pattern.test(path));
    if (!route) throw new ApiError(404, 'Not found');
    if (route.needsData && !this.db) throw new ApiError(409, 'Set up WalletWhisper first');
    const idText = route.pattern.exec(path)![1];
    const { files = [], ...body } = req.body ?? {};
    const ctx: Ctx = {
      query: Object.fromEntries(new URLSearchParams(search)),
      body,
      files,
      id: idText === undefined ? 0 : Number(idText),
    };
    if (idText !== undefined && (!Number.isInteger(ctx.id) || ctx.id <= 0)) throw new ApiError(400, 'Invalid id');
    try {
      const out = await route.handler(ctx);
      if (req.method !== 'GET' && this.db) this.host.save(this.db);
      return out;
    } catch (err: any) {
      if (err instanceof ApiError) throw err;
      if (err instanceof UserError) throw new ApiError(400, err.message);
      console.error(err);
      throw new ApiError(500, err?.message || 'Something went wrong');
    }
  }

  private csvFiles(c: Ctx) {
    if (c.files.length === 0) throw new BadRequest('No files chosen');
    if (c.files.length > MAX_CSV_FILES) throw new BadRequest(`Import up to ${MAX_CSV_FILES} files at a time`);
    return c.files.map(f => {
      if (f.bytes.length > MAX_CSV_BYTES) throw new BadRequest(`${f.name} is too large (limit 10 MB)`);
      return { name: f.name.split(/[\\/]/).pop()!, text: new TextDecoder().decode(f.bytes) };
    });
  }

  private backupFile(c: Ctx) {
    const file = c.files[0];
    if (!file) throw new BadRequest('Choose a backup file');
    const password = typeof c.body.password === 'string' && c.body.password ? c.body.password : undefined;
    return { bytes: file.bytes, password };
  }

  private defineRoutes() {
    const db = () => this.data;

    // ---------- First run ----------
    this.on('GET', '/api/setup', () => ({ configured: this.ready }), false);

    this.on('POST', '/api/setup', () => {
      if (this.ready) throw new BadRequest('WalletWhisper is already set up.');
      this.load(null);
      return { success: true };
    }, false);

    // ---------- Imports ----------
    this.on('POST', '/api/imports/preview', c => ({ previews: this.csvFiles(c).map(f => previewCsv(db(), f.name, f.text)) }));

    this.on('POST', '/api/imports', c => {
      let choices: Record<string, AccountChoice> = {};
      if (typeof c.body.choices === 'string') {
        try { choices = JSON.parse(c.body.choices); } catch { throw new BadRequest('Invalid account choices'); }
      }
      const results = this.csvFiles(c).map(f => {
        try {
          return importCsvContent(db(), f.name, f.text, choices[f.name] || {});
        } catch (err: any) {
          return { filename: f.name, bank: 'Unknown', accountType: 'Unknown', rowsAdded: 0, rowsSkipped: 0, error: err.message };
        }
      });
      const matched = finishImports(db());
      audit(db(), 'import', results.map(r => ({ file: r.filename, added: r.rowsAdded, error: r.error })));
      return { results, matched, reviewCount: getReviewItems(db()).length };
    });

    this.on('GET', '/api/imports', () => {
      const rows = db().prepare(`
        SELECT i.id, i.filename, i.imported_at AS importedAt, i.rows_added AS rowsAdded, i.rows_skipped AS rowsSkipped,
               i.min_date AS minDate, i.max_date AS maxDate, a.nickname, a.bank, a.account_type, a.last4
        FROM imports i JOIN accounts a ON a.id = i.account_id ORDER BY i.id DESC`).all() as any[];
      return { imports: rows.map(r => ({ ...r, account: accountLabel(r) })) };
    });

    this.on('DELETE', '/api/imports/:id', async c => {
      const imp = db().prepare('SELECT filename FROM imports WHERE id = ?').get(c.id) as { filename: string } | undefined;
      if (!imp) throw new BadRequest('Import not found');
      await this.snapshot(`before-undo-import-${c.id}`);
      db().transaction(() => {
        // Answers we gave stay in `decisions` and come back if the file is imported again
        db().prepare('DELETE FROM transactions WHERE import_id = ?').run(c.id);
        db().prepare('DELETE FROM imports WHERE id = ?').run(c.id);
      })();
      recompute(db());
      audit(db(), 'undo_import', { id: c.id, filename: imp.filename });
      return { success: true };
    });

    // ---------- Reference data ----------
    this.on('GET', '/api/categories', () => {
      const rows = db().prepare('SELECT id, name, color, is_system AS isSystem FROM categories ORDER BY name').all() as any[];
      return { categories: rows.map(r => ({ ...r, isSystem: r.isSystem === 1 })) };
    });

    // ---------- Reports ----------
    this.on('GET', '/api/summary', c => getSummary(db(), parseFilters(c.query)));

    this.on('GET', '/api/trends', c => {
      const months = Math.min(Math.max(Number(c.query.months) || 12, 1), 60);
      const stack = (['category', 'person', 'account'].includes(c.query.stack) ? c.query.stack : 'category') as StackBy;
      return getTrends(db(), parseFilters(c.query), months, stack);
    });

    this.on('GET', '/api/coverage', () => getCoverage(db()));

    const kindOf = (c: Ctx) => (['spending', 'transfer', 'income', 'all'].includes(c.query.kind) ? c.query.kind : 'spending');
    this.on('GET', '/api/transactions', c => getTransactions(db(), parseFilters(c.query), kindOf(c)));

    // Values for an Excel-style column filter (merchant, account, person, category)
    this.on('GET', '/api/transactions/values', c => {
      if (!['merchant', 'account', 'person', 'category'].includes(c.query.column)) throw new BadRequest('Unknown column');
      return { values: getColumnValues(db(), parseFilters(c.query), kindOf(c), c.query.column as FilterColumn) };
    });

    // ---------- Editing transactions ----------
    this.on('PATCH', '/api/transactions/:id', c => {
      const d = db();
      const body = c.body;
      const txn = d.prepare('SELECT id, merchant, fingerprint FROM transactions WHERE id = ?').get(c.id) as { id: number; merchant: string; fingerprint: string } | undefined;
      if (!txn) throw new ApiError(404, 'Transaction not found');

      d.transaction(() => {
        if (body.categoryId !== undefined) {
          const categoryId = Number(body.categoryId);
          if (!d.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw new BadRequest('Unknown category');
          d.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(categoryId, c.id);
          saveDecision(d, txn.fingerprint, { category_id: categoryId });
          if (body.remember) {
            d.prepare("DELETE FROM rules WHERE source = 'user' AND pattern = ?").run(txn.merchant.toLowerCase());
            d.prepare("INSERT INTO rules (pattern, category_id, priority, source) VALUES (?, ?, 10, 'user')").run(txn.merchant.toLowerCase(), categoryId);
          }
        }
        if (body.personId !== undefined) {
          const personId = body.personId === null ? null : Number(body.personId);
          if (personId !== null && !d.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) throw new BadRequest('Unknown person');
          d.prepare('UPDATE transactions SET person_id = ?, person_source = ? WHERE id = ?').run(personId, personId ? 'manual' : null, c.id);
          saveDecision(d, txn.fingerprint, { person_id: personId });
          if (body.rememberPerson && personId) {
            d.prepare('INSERT INTO person_rules (pattern, person_id) VALUES (?, ?) ON CONFLICT(pattern) DO UPDATE SET person_id = excluded.person_id')
              .run(txn.merchant.toLowerCase(), personId);
          }
        }
        if (body.kind !== undefined) {
          if (!KINDS.has(body.kind)) throw new BadRequest('Unknown kind');
          setKindManually(d, c.id, body.kind);
        }
        if (body.hidden !== undefined) {
          const v = body.hidden ? 1 : 0;
          d.prepare('UPDATE transactions SET is_one_time = ? WHERE id = ?').run(v, c.id);
          saveDecision(d, txn.fingerprint, { is_one_time: v });
        }
      })();
      recompute(d);
      return { success: true };
    });

    // Bulk: assign a person (or category) to many rows at once
    this.on('PATCH', '/api/transactions', c => {
      const d = db();
      const { ids, personId, categoryId, hidden } = c.body;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 5000 || !ids.every((x: unknown) => Number.isInteger(x))) {
        throw new BadRequest('ids must be a non-empty list of transaction ids');
      }
      if (personId !== undefined && personId !== null && !d.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) throw new BadRequest('Unknown person');
      if (categoryId !== undefined && !d.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw new BadRequest('Unknown category');
      const fpOf = d.prepare('SELECT fingerprint FROM transactions WHERE id = ?');
      let updated = 0;
      d.transaction(() => {
        for (const id of ids as number[]) {
          const row = fpOf.get(id) as { fingerprint: string } | undefined;
          if (!row) continue;
          if (personId !== undefined) {
            d.prepare('UPDATE transactions SET person_id = ?, person_source = ? WHERE id = ?').run(personId, personId ? 'manual' : null, id);
            saveDecision(d, row.fingerprint, { person_id: personId });
          }
          if (categoryId !== undefined) {
            d.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(categoryId, id);
            saveDecision(d, row.fingerprint, { category_id: categoryId });
          }
          if (hidden !== undefined) {
            const v = hidden ? 1 : 0;
            d.prepare('UPDATE transactions SET is_one_time = ? WHERE id = ?').run(v, id);
            saveDecision(d, row.fingerprint, { is_one_time: v });
          }
          updated++;
        }
      })();
      recompute(d);
      return { success: true, updated };
    });

    // ---------- Transfer links ----------
    this.on('POST', '/api/transfer-links', c => {
      const { outId, inId } = c.body;
      if (!Number.isInteger(outId) || !Number.isInteger(inId)) throw new BadRequest('outId and inId are required');
      db().transaction(() => linkManually(db(), outId, inId))();
      recompute(db());
      return { success: true };
    });

    this.on('DELETE', '/api/transfer-links/:id', c => {
      db().transaction(() => unlink(db(), c.id))();
      recompute(db());
      return { success: true };
    });

    // ---------- Review inbox ----------
    this.on('GET', '/api/review', () => ({ items: getReviewItems(db()) }));

    this.on('POST', '/api/review/answer', c => {
      answerReview(db(), c.body as unknown as ReviewAnswer);
      return { success: true, reviewCount: getReviewItems(db()).length };
    });

    // ---------- Accounts ----------
    this.on('GET', '/api/accounts', () => {
      const rows = db().prepare(`
        SELECT a.id, a.profile_id AS profileId, a.bank, a.account_type AS accountType, a.nickname, a.last4,
               a.is_tracked AS isTracked, a.card_policy AS cardPolicy, a.match_patterns AS matchPatterns,
               a.default_person_id AS defaultPersonId,
               (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS txnCount,
               (SELECT COUNT(*) FROM transactions t WHERE t.counterparty_account_id = a.id) AS counterpartyCount
        FROM accounts a ORDER BY a.is_tracked DESC, a.id`).all() as any[];
      return {
        accounts: rows.map(r => ({
          ...r,
          label: accountLabel({ nickname: r.nickname, bank: r.bank, account_type: r.accountType, last4: r.last4 }),
          isTracked: r.isTracked === 1,
          matchPatterns: parseList(r.matchPatterns),
        })),
      };
    });

    // Add an account we own but don't import (savings, brokerage, another bank's card)
    this.on('POST', '/api/accounts', c => {
      const { nickname, accountType, cardPolicy, matchPatterns } = c.body;
      if (typeof nickname !== 'string' || !nickname.trim()) throw new BadRequest('Name is required');
      if (!ACCOUNT_TYPES.has(accountType)) throw new BadRequest('Unknown account type');
      const policy = accountType === 'credit' ? (CARD_POLICIES.has(cardPolicy) ? cardPolicy : 'will_import') : null;
      const patterns = Array.isArray(matchPatterns) ? matchPatterns.filter((p: unknown) => typeof p === 'string' && p.trim().length >= 4) : [];
      const id = db().prepare(`INSERT INTO accounts (profile_id, bank, account_type, nickname, is_tracked, card_policy, match_patterns)
        VALUES ('', ?, ?, ?, 0, ?, ?)`).run(nickname.trim(), accountType, nickname.trim(), policy, JSON.stringify(patterns)).lastInsertRowid;
      recompute(db());
      return { success: true, id: Number(id) };
    });

    this.on('PATCH', '/api/accounts/:id', c => {
      const d = db();
      const acct = d.prepare('SELECT id, account_type, is_tracked FROM accounts WHERE id = ?').get(c.id) as { account_type: string; is_tracked: number } | undefined;
      if (!acct) throw new BadRequest('Account not found');
      const b = c.body;
      if (b.nickname !== undefined) {
        if (typeof b.nickname !== 'string' || !b.nickname.trim()) throw new BadRequest('Name is required');
        d.prepare('UPDATE accounts SET nickname = ? WHERE id = ?').run(b.nickname.trim(), c.id);
      }
      if (b.defaultPersonId !== undefined) {
        if (b.defaultPersonId !== null && !d.prepare('SELECT 1 FROM people WHERE id = ?').get(b.defaultPersonId)) throw new BadRequest('Unknown person');
        d.prepare('UPDATE accounts SET default_person_id = ? WHERE id = ?').run(b.defaultPersonId, c.id);
      }
      if (b.cardPolicy !== undefined) {
        if (!CARD_POLICIES.has(b.cardPolicy)) throw new BadRequest('Unknown card policy');
        d.prepare('UPDATE accounts SET card_policy = ? WHERE id = ?').run(b.cardPolicy, c.id);
      }
      if (b.accountType !== undefined && !acct.is_tracked) {
        if (!ACCOUNT_TYPES.has(b.accountType)) throw new BadRequest('Unknown account type');
        d.prepare("UPDATE accounts SET account_type = ?, card_policy = CASE WHEN ? = 'credit' THEN COALESCE(card_policy, 'will_import') ELSE NULL END WHERE id = ?")
          .run(b.accountType, b.accountType, c.id);
      }
      if (b.matchPatterns !== undefined) {
        if (!Array.isArray(b.matchPatterns)) throw new BadRequest('matchPatterns must be a list');
        const patterns = b.matchPatterns.map((p: unknown) => String(p).trim()).filter((p: string) => p.length >= 4);
        d.prepare('UPDATE accounts SET match_patterns = ? WHERE id = ?').run(JSON.stringify(patterns), c.id);
      }
      recompute(d);
      return { success: true };
    });

    this.on('DELETE', '/api/accounts/:id', c => {
      const acct = db().prepare('SELECT is_tracked FROM accounts WHERE id = ?').get(c.id) as { is_tracked: number } | undefined;
      if (!acct) throw new BadRequest('Account not found');
      if (acct.is_tracked) throw new BadRequest('This account has imported transactions; undo its imports instead');
      db().transaction(() => {
        db().prepare('UPDATE transactions SET counterparty_account_id = NULL WHERE counterparty_account_id = ?').run(c.id);
        db().prepare('DELETE FROM accounts WHERE id = ?').run(c.id);
      })();
      recompute(db());
      return { success: true };
    });

    // ---------- People ----------
    this.on('GET', '/api/people', () => {
      const rows = db().prepare(`SELECT p.id, p.name, p.color, p.aliases,
        (SELECT COUNT(*) FROM transactions t WHERE t.person_id = p.id) AS txnCount FROM people p ORDER BY p.id`).all() as any[];
      return { people: rows.map(r => ({ ...r, aliases: parseList(r.aliases) })) };
    });

    this.on('POST', '/api/people', c => {
      const { name, color } = c.body;
      if (typeof name !== 'string' || !name.trim()) throw new BadRequest('Name is required');
      if (db().prepare('SELECT 1 FROM people WHERE name = ?').get(name.trim())) throw new BadRequest('That name already exists');
      const col = typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : pickColor(db());
      const id = db().prepare('INSERT INTO people (name, color) VALUES (?, ?)').run(name.trim(), col).lastInsertRowid;
      return { success: true, id: Number(id) };
    });

    this.on('PATCH', '/api/people/:id', c => {
      const { name, color, aliases } = c.body;
      if (!db().prepare('SELECT 1 FROM people WHERE id = ?').get(c.id)) throw new BadRequest('Person not found');
      if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim()) throw new BadRequest('Name is required');
        db().prepare('UPDATE people SET name = ? WHERE id = ?').run(name.trim(), c.id);
      }
      if (color !== undefined) {
        if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new BadRequest('Color must look like #RRGGBB');
        db().prepare('UPDATE people SET color = ? WHERE id = ?').run(color, c.id);
      }
      if (aliases !== undefined) {
        if (!Array.isArray(aliases)) throw new BadRequest('aliases must be a list');
        const list = aliases.map((a: unknown) => String(a).trim()).filter((a: string) => a.length >= 3);
        db().prepare('UPDATE people SET aliases = ? WHERE id = ?').run(JSON.stringify(list), c.id);
      }
      recompute(db());
      return { success: true };
    });

    this.on('DELETE', '/api/people/:id', c => {
      db().transaction(() => {
        db().prepare('UPDATE decisions SET person_id = NULL WHERE person_id = ?').run(c.id);
        db().prepare('UPDATE transactions SET person_id = NULL, person_source = NULL WHERE person_id = ?').run(c.id);
        db().prepare('DELETE FROM people WHERE id = ?').run(c.id);
      })();
      recompute(db());
      return { success: true };
    });

    // ---------- Remembered rules ----------
    this.on('GET', '/api/rules', () => ({
      category: db().prepare(`SELECT r.id, r.pattern, c.name AS target FROM rules r JOIN categories c ON c.id = r.category_id
        WHERE r.source = 'user' ORDER BY r.pattern`).all(),
      person: db().prepare(`SELECT r.id, r.pattern, p.name AS target FROM person_rules r JOIN people p ON p.id = r.person_id
        ORDER BY r.pattern`).all(),
    }));

    this.on('DELETE', '/api/rules/:id', c => {
      db().prepare("DELETE FROM rules WHERE id = ? AND source = 'user'").run(c.id);
      recompute(db());
      return { success: true };
    });

    this.on('DELETE', '/api/person-rules/:id', c => {
      db().prepare('DELETE FROM person_rules WHERE id = ?').run(c.id);
      recompute(db());
      return { success: true };
    });

    // ---------- Settings: AI key ----------
    const aiProvider = () => {
      const p = detectProvider(this.host.aiKey() ?? '');
      return p ? PROVIDER_NAMES[p] : null;
    };
    this.on('GET', '/api/settings', () => ({ aiConfigured: aiProvider() !== null, aiProvider: aiProvider() }), false);

    // The key is kept in this browser only, and is never shown again
    this.on('PUT', '/api/settings/ai', c => {
      const key = typeof c.body.key === 'string' ? c.body.key.trim() : '';
      if (key && !detectProvider(key)) throw new BadRequest("That doesn't look like a Claude, Gemini or OpenAI API key. Copy the whole key and try again.");
      this.host.setAiKey(key || null);
      return { success: true, aiProvider: aiProvider() };
    }, false);

    // ---------- Ask (opt-in AI) ----------
    // Only the question, today's date and category names go to the AI; the answer is computed here
    this.on('POST', '/api/ask', async c => {
      const question = typeof c.body.question === 'string' ? c.body.question.trim() : '';
      if (!question) throw new BadRequest('Type a question first');
      if (question.length > 300) throw new BadRequest('Please keep the question under 300 characters');
      const categoryNames = (db().prepare('SELECT name FROM categories ORDER BY name').all() as { name: string }[])
        .map(r => r.name).filter(n => !['Transfer', 'Income', 'Credit card (untracked)'].includes(n));
      const today = new Date().toISOString().slice(0, 10);
      const plan = await planQuestion(question, categoryNames, today, this.host.aiKey());
      return answerQuestion(db(), plan);
    });

    this.on('POST', '/api/ai/recategorize', async () => {
      const result = await recategorizeWithLlm(db(), this.host.aiKey());
      recompute(db());
      audit(db(), 'ai_recategorize', { reviewed: result.reviewed, changed: result.changed });
      return result;
    });

    // ---------- Backup files: move to another computer or browser ----------
    this.on('POST', '/api/backup/export', async c => {
      const password = typeof c.body.password === 'string' && c.body.password ? c.body.password : undefined;
      if (password && password.length < 8) throw new BadRequest('Use a password of at least 8 characters');
      const bytes = await createBackup(db(), password);
      audit(db(), 'backup_exported', { encrypted: !!password, bytes: bytes.length });
      return { filename: backupFileName(), bytes };
    });

    // Look inside a backup before restoring it, so the user can confirm what they're about to load
    this.on('POST', '/api/backup/inspect', async c => {
      const { bytes, password } = this.backupFile(c);
      if (isEncryptedBackup(bytes) && !password) return { needsPassword: true };
      const { info } = await readBackup(bytes, password);
      return { needsPassword: false, info };
    }, false);

    // Compare a backup with the data here, then combine them with the user's choices.
    // The unpacked backup waits in memory between the two steps, for up to 30 minutes.
    this.on('POST', '/api/backup/compare', async c => {
      for (const [id, p] of this.pendingMerges) if (Date.now() - p.created > MERGE_WINDOW_MS) this.pendingMerges.delete(id);
      const { bytes, password } = this.backupFile(c);
      const { data, info } = await readBackup(bytes, password);
      const other = openBackupCopy(data);
      let preview;
      try { preview = compareWithBackup(db(), other); } finally { other.close(); }
      if (preview.identical) return { compareId: null, info, preview };
      const compareId = randomId();
      this.pendingMerges.set(compareId, { data, created: Date.now() });
      return { compareId, info, preview };
    });

    this.on('POST', '/api/backup/merge', async c => {
      const id = String(c.body.compareId);
      const pending = this.pendingMerges.get(id);
      if (!pending) throw new BadRequest('That comparison has expired. Choose the backup file again.');
      const choices: Record<string, 'mine' | 'theirs'> = {};
      for (const [k, v] of Object.entries(c.body.choices ?? {})) if (v === 'mine' || v === 'theirs') choices[k] = v;
      await this.snapshot('before-merge');
      const other = openBackupCopy(pending.data);
      try {
        const result = mergeBackup(db(), other, { choices, removeLocalOnly: c.body.removeLocalOnly === true });
        audit(db(), 'backup_merged', { ...result, conflictsResolved: Object.keys(choices).length });
        return { success: true, ...result };
      } finally {
        other.close();
        this.pendingMerges.delete(id);
      }
    });

    this.on('POST', '/api/backup/restore', async c => {
      const { bytes, password } = this.backupFile(c);
      const hasData = this.db !== null && (this.db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n > 0;
      if (hasData && c.body.confirm !== 'REPLACE') throw new BadRequest('Restoring replaces the data here. Confirm to continue.');
      const { data, info } = await readBackup(bytes, password);
      if (this.db) await this.snapshot('before-restore');
      this.load(data, (from, old) => this.host.snapshot(`pre-upgrade-v${from}`, old)); // upgrades backups from older versions
      audit(this.data, 'backup_restored', info);
      return { success: true, info };
    }, false);

    // ---------- Reset ----------
    this.on('POST', '/api/reset', async c => {
      if (c.body.confirm !== RESET_CONFIRMATION) throw new BadRequest(`To reset, type "${RESET_CONFIRMATION}" to confirm`);
      await this.snapshot('before-reset');
      db().transaction(() => {
        db().exec(`
          DELETE FROM transfer_links;
          DELETE FROM transactions;
          DELETE FROM imports;
          DELETE FROM accounts;
          DELETE FROM rules WHERE source = 'user';
          DELETE FROM person_rules;
          DELETE FROM decisions;
          DELETE FROM not_pairs;
        `);
      })();
      audit(db(), 'reset', {});
      return { success: true };
    });
  }
}
