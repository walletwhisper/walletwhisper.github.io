import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { audit, backupDb, backupDir, dbPath, getDb, setSetting } from './db.js';
import { AccountChoice, backfillLast4, finishImports, importCsvContent, previewCsv, accountLabel } from './importer.js';
import { recategorizeWithLlm } from './llm.js';
import { parseList, recompute, saveDecision } from './ledger.js';
import { answerReview, getReviewItems, linkManually, oneTimeThreshold, pickColor, ReviewAnswer, setKindManually, unlink } from './review.js';
import { getCoverage, getSummary, getTransactions, getTrends, parseFilters, StackBy } from './reports.js';
import { requestGuard, RESET_CONFIRMATION, SESSION_TOKEN } from './security.js';

import { UserError } from './errors.js';

class BadRequest extends UserError {}

/** Wrap a handler so thrown errors become JSON responses. */
const h = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = fn(req, res);
    if (out instanceof Promise) out.catch(next);
  } catch (err) {
    next(err);
  }
};

const idParam = (req: Request) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new BadRequest('Invalid id');
  return id;
};

const KINDS = new Set(['spend', 'refund', 'income', 'transfer', 'fee']);
const ACCOUNT_TYPES = new Set(['checking', 'credit', 'savings', 'brokerage', 'other']);
const CARD_POLICIES = new Set(['will_import', 'payments_are_spending']);

export async function createServer() {
  const db = getDb();
  backfillLast4(db);
  recompute(db);

  const app = express();
  app.disable('x-powered-by');
  app.use(requestGuard);
  app.use(express.json({ limit: '1mb' }));

  const upload = multer({
    storage: multer.memoryStorage(), // raw CSVs are never written to disk
    limits: { fileSize: 10 * 1024 * 1024, files: 20 }
  });
  const files = (req: Request) => {
    const list = (req.files as Express.Multer.File[]) || [];
    if (list.length === 0) throw new BadRequest('No files uploaded');
    return list.map(f => ({ name: path.basename(f.originalname), text: f.buffer.toString('utf-8') }));
  };

  // ---------- Session ----------
  app.get('/api/session', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ token: SESSION_TOKEN });
  });

  // ---------- Imports ----------
  app.post('/api/imports/preview', upload.array('files'), h((req, res) => {
    res.json({ previews: files(req).map(f => previewCsv(db, f.name, f.text)) });
  }));

  app.post('/api/imports', upload.array('files'), h((req, res) => {
    let choices: Record<string, AccountChoice> = {};
    if (typeof req.body?.choices === 'string') {
      try { choices = JSON.parse(req.body.choices); } catch { throw new BadRequest('Invalid account choices'); }
    }
    const results = files(req).map(f => {
      try {
        return importCsvContent(db, f.name, f.text, choices[f.name] || {});
      } catch (err: any) {
        return { filename: f.name, bank: 'Unknown', accountType: 'Unknown', rowsAdded: 0, rowsSkipped: 0, error: err.message };
      }
    });
    const matched = finishImports(db);
    audit(db, 'import', results.map(r => ({ file: r.filename, added: r.rowsAdded, error: r.error })));
    res.json({ results, matched, reviewCount: getReviewItems(db).length });
  }));

  app.get('/api/imports', h((_req, res) => {
    const rows = db.prepare(`
      SELECT i.id, i.filename, i.imported_at AS importedAt, i.rows_added AS rowsAdded, i.rows_skipped AS rowsSkipped,
             i.min_date AS minDate, i.max_date AS maxDate, a.nickname, a.bank, a.account_type, a.last4
      FROM imports i JOIN accounts a ON a.id = i.account_id ORDER BY i.id DESC`).all() as any[];
    res.json({ imports: rows.map(r => ({ ...r, account: accountLabel(r) })) });
  }));

  app.delete('/api/imports/:id', h((req, res) => {
    const id = idParam(req);
    const imp = db.prepare('SELECT filename FROM imports WHERE id = ?').get(id) as { filename: string } | undefined;
    if (!imp) throw new BadRequest('Import not found');
    const backup = backupDb(db, `before-undo-import-${id}`);
    db.transaction(() => {
      // Answers we gave stay in `decisions` and come back if the file is imported again
      db.prepare('DELETE FROM transactions WHERE import_id = ?').run(id);
      db.prepare('DELETE FROM imports WHERE id = ?').run(id);
    })();
    recompute(db);
    audit(db, 'undo_import', { id, filename: imp.filename, backup });
    res.json({ success: true });
  }));

  // ---------- Reference data ----------
  app.get('/api/categories', h((_req, res) => {
    const rows = db.prepare('SELECT id, name, color, is_system AS isSystem FROM categories ORDER BY name').all() as any[];
    res.json({ categories: rows.map(r => ({ ...r, isSystem: r.isSystem === 1 })) });
  }));

  // ---------- Reports ----------
  app.get('/api/summary', h((req, res) => {
    res.json(getSummary(db, parseFilters(req.query)));
  }));

  app.get('/api/trends', h((req, res) => {
    const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 60);
    const stack = (['category', 'person', 'account'].includes(String(req.query.stack)) ? req.query.stack : 'category') as StackBy;
    res.json(getTrends(db, parseFilters(req.query), months, stack));
  }));

  app.get('/api/coverage', h((_req, res) => {
    res.json(getCoverage(db));
  }));

  app.get('/api/transactions', h((req, res) => {
    const kind = ['spending', 'transfer', 'income', 'all'].includes(String(req.query.kind)) ? String(req.query.kind) : 'spending';
    res.json(getTransactions(db, parseFilters(req.query), kind));
  }));

  // ---------- Editing transactions ----------
  app.patch('/api/transactions/:id', h((req, res) => {
    const id = idParam(req);
    const body = req.body || {};
    const txn = db.prepare('SELECT id, merchant, fingerprint FROM transactions WHERE id = ?').get(id) as { id: number; merchant: string; fingerprint: string } | undefined;
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    db.transaction(() => {
      if (body.categoryId !== undefined) {
        const categoryId = Number(body.categoryId);
        if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw new BadRequest('Unknown category');
        db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(categoryId, id);
        saveDecision(db, txn.fingerprint, { category_id: categoryId });
        if (body.remember) {
          db.prepare("DELETE FROM rules WHERE source = 'user' AND pattern = ?").run(txn.merchant.toLowerCase());
          db.prepare("INSERT INTO rules (pattern, category_id, priority, source) VALUES (?, ?, 10, 'user')").run(txn.merchant.toLowerCase(), categoryId);
        }
      }
      if (body.personId !== undefined) {
        const personId = body.personId === null ? null : Number(body.personId);
        if (personId !== null && !db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) throw new BadRequest('Unknown person');
        db.prepare("UPDATE transactions SET person_id = ?, person_source = ? WHERE id = ?").run(personId, personId ? 'manual' : null, id);
        saveDecision(db, txn.fingerprint, { person_id: personId });
        if (body.rememberPerson && personId) {
          db.prepare('INSERT INTO person_rules (pattern, person_id) VALUES (?, ?) ON CONFLICT(pattern) DO UPDATE SET person_id = excluded.person_id')
            .run(txn.merchant.toLowerCase(), personId);
        }
      }
      if (body.kind !== undefined) {
        if (!KINDS.has(body.kind)) throw new BadRequest('Unknown kind');
        setKindManually(db, id, body.kind);
      }
      if (body.isOneTime !== undefined) {
        const v = body.isOneTime ? 1 : 0;
        db.prepare('UPDATE transactions SET is_one_time = ? WHERE id = ?').run(v, id);
        saveDecision(db, txn.fingerprint, { is_one_time: v });
      }
    })();
    recompute(db);
    res.json({ success: true });
  }));

  // Bulk: assign a person (or category) to many rows at once
  app.patch('/api/transactions', h((req, res) => {
    const { ids, personId, categoryId } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 5000 || !ids.every((x: unknown) => Number.isInteger(x))) {
      throw new BadRequest('ids must be a non-empty list of transaction ids');
    }
    if (personId !== undefined && personId !== null && !db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) throw new BadRequest('Unknown person');
    if (categoryId !== undefined && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw new BadRequest('Unknown category');
    const fpOf = db.prepare('SELECT fingerprint FROM transactions WHERE id = ?');
    let updated = 0;
    db.transaction(() => {
      for (const id of ids as number[]) {
        const row = fpOf.get(id) as { fingerprint: string } | undefined;
        if (!row) continue;
        if (personId !== undefined) {
          db.prepare('UPDATE transactions SET person_id = ?, person_source = ? WHERE id = ?').run(personId, personId ? 'manual' : null, id);
          saveDecision(db, row.fingerprint, { person_id: personId });
        }
        if (categoryId !== undefined) {
          db.prepare("UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?").run(categoryId, id);
          saveDecision(db, row.fingerprint, { category_id: categoryId });
        }
        updated++;
      }
    })();
    recompute(db);
    res.json({ success: true, updated });
  }));

  // ---------- Transfer links ----------
  app.post('/api/transfer-links', h((req, res) => {
    const { outId, inId } = req.body || {};
    if (!Number.isInteger(outId) || !Number.isInteger(inId)) throw new BadRequest('outId and inId are required');
    db.transaction(() => linkManually(db, outId, inId))();
    recompute(db);
    res.json({ success: true });
  }));

  app.delete('/api/transfer-links/:id', h((req, res) => {
    const id = idParam(req);
    db.transaction(() => unlink(db, id))();
    recompute(db);
    res.json({ success: true });
  }));

  // ---------- Review inbox ----------
  app.get('/api/review', h((_req, res) => {
    res.json({ items: getReviewItems(db), oneTimeThresholdCents: oneTimeThreshold(db) });
  }));

  app.post('/api/review/answer', h((req, res) => {
    answerReview(db, req.body as ReviewAnswer);
    res.json({ success: true, reviewCount: getReviewItems(db).length });
  }));

  // ---------- Accounts ----------
  app.get('/api/accounts', h((_req, res) => {
    const rows = db.prepare(`
      SELECT a.id, a.profile_id AS profileId, a.bank, a.account_type AS accountType, a.nickname, a.last4,
             a.is_tracked AS isTracked, a.card_policy AS cardPolicy, a.match_patterns AS matchPatterns,
             a.default_person_id AS defaultPersonId,
             (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS txnCount,
             (SELECT COUNT(*) FROM transactions t WHERE t.counterparty_account_id = a.id) AS counterpartyCount
      FROM accounts a ORDER BY a.is_tracked DESC, a.id`).all() as any[];
    res.json({
      accounts: rows.map(r => ({
        ...r,
        label: accountLabel({ nickname: r.nickname, bank: r.bank, account_type: r.accountType, last4: r.last4 }),
        isTracked: r.isTracked === 1,
        matchPatterns: parseList(r.matchPatterns)
      }))
    });
  }));

  // Add an account we own but don't import (savings, brokerage, another bank's card)
  app.post('/api/accounts', h((req, res) => {
    const { nickname, accountType, cardPolicy, matchPatterns } = req.body || {};
    if (typeof nickname !== 'string' || !nickname.trim()) throw new BadRequest('Name is required');
    if (!ACCOUNT_TYPES.has(accountType)) throw new BadRequest('Unknown account type');
    const policy = accountType === 'credit' ? (CARD_POLICIES.has(cardPolicy) ? cardPolicy : 'will_import') : null;
    const patterns = Array.isArray(matchPatterns) ? matchPatterns.filter((p: unknown) => typeof p === 'string' && p.trim().length >= 4) : [];
    const id = db.prepare(`INSERT INTO accounts (profile_id, bank, account_type, nickname, is_tracked, card_policy, match_patterns)
      VALUES ('', ?, ?, ?, 0, ?, ?)`).run(nickname.trim(), accountType, nickname.trim(), policy, JSON.stringify(patterns)).lastInsertRowid;
    recompute(db);
    res.json({ success: true, id: Number(id) });
  }));

  app.patch('/api/accounts/:id', h((req, res) => {
    const id = idParam(req);
    const acct = db.prepare('SELECT id, account_type, is_tracked FROM accounts WHERE id = ?').get(id) as { account_type: string; is_tracked: number } | undefined;
    if (!acct) throw new BadRequest('Account not found');
    const b = req.body || {};
    if (b.nickname !== undefined) {
      if (typeof b.nickname !== 'string' || !b.nickname.trim()) throw new BadRequest('Name is required');
      db.prepare('UPDATE accounts SET nickname = ? WHERE id = ?').run(b.nickname.trim(), id);
    }
    if (b.defaultPersonId !== undefined) {
      if (b.defaultPersonId !== null && !db.prepare('SELECT 1 FROM people WHERE id = ?').get(b.defaultPersonId)) throw new BadRequest('Unknown person');
      db.prepare('UPDATE accounts SET default_person_id = ? WHERE id = ?').run(b.defaultPersonId, id);
    }
    if (b.cardPolicy !== undefined) {
      if (!CARD_POLICIES.has(b.cardPolicy)) throw new BadRequest('Unknown card policy');
      db.prepare('UPDATE accounts SET card_policy = ? WHERE id = ?').run(b.cardPolicy, id);
    }
    if (b.accountType !== undefined && !acct.is_tracked) {
      if (!ACCOUNT_TYPES.has(b.accountType)) throw new BadRequest('Unknown account type');
      db.prepare("UPDATE accounts SET account_type = ?, card_policy = CASE WHEN ? = 'credit' THEN COALESCE(card_policy, 'will_import') ELSE NULL END WHERE id = ?")
        .run(b.accountType, b.accountType, id);
    }
    if (b.matchPatterns !== undefined) {
      if (!Array.isArray(b.matchPatterns)) throw new BadRequest('matchPatterns must be a list');
      const patterns = b.matchPatterns.map((p: unknown) => String(p).trim()).filter((p: string) => p.length >= 4);
      db.prepare('UPDATE accounts SET match_patterns = ? WHERE id = ?').run(JSON.stringify(patterns), id);
    }
    recompute(db);
    res.json({ success: true });
  }));

  app.delete('/api/accounts/:id', h((req, res) => {
    const id = idParam(req);
    const acct = db.prepare('SELECT is_tracked FROM accounts WHERE id = ?').get(id) as { is_tracked: number } | undefined;
    if (!acct) throw new BadRequest('Account not found');
    if (acct.is_tracked) throw new BadRequest('This account has imported transactions; undo its imports instead');
    db.transaction(() => {
      db.prepare('UPDATE transactions SET counterparty_account_id = NULL WHERE counterparty_account_id = ?').run(id);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    })();
    recompute(db);
    res.json({ success: true });
  }));

  // ---------- People ----------
  app.get('/api/people', h((_req, res) => {
    const rows = db.prepare(`SELECT p.id, p.name, p.color, p.aliases,
      (SELECT COUNT(*) FROM transactions t WHERE t.person_id = p.id) AS txnCount FROM people p ORDER BY p.id`).all() as any[];
    res.json({ people: rows.map(r => ({ ...r, aliases: parseList(r.aliases) })) });
  }));

  app.post('/api/people', h((req, res) => {
    const { name, color } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) throw new BadRequest('Name is required');
    if (db.prepare('SELECT 1 FROM people WHERE name = ?').get(name.trim())) throw new BadRequest('That name already exists');
    const c = typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : pickColor(db);
    const id = db.prepare('INSERT INTO people (name, color) VALUES (?, ?)').run(name.trim(), c).lastInsertRowid;
    res.json({ success: true, id: Number(id) });
  }));

  app.patch('/api/people/:id', h((req, res) => {
    const id = idParam(req);
    const { name, color, aliases } = req.body || {};
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) throw new BadRequest('Person not found');
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) throw new BadRequest('Name is required');
      db.prepare('UPDATE people SET name = ? WHERE id = ?').run(name.trim(), id);
    }
    if (color !== undefined) {
      if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new BadRequest('Color must look like #RRGGBB');
      db.prepare('UPDATE people SET color = ? WHERE id = ?').run(color, id);
    }
    if (aliases !== undefined) {
      if (!Array.isArray(aliases)) throw new BadRequest('aliases must be a list');
      const list = aliases.map((a: unknown) => String(a).trim()).filter((a: string) => a.length >= 3);
      db.prepare('UPDATE people SET aliases = ? WHERE id = ?').run(JSON.stringify(list), id);
    }
    recompute(db);
    res.json({ success: true });
  }));

  app.delete('/api/people/:id', h((req, res) => {
    const id = idParam(req);
    db.transaction(() => {
      db.prepare('UPDATE decisions SET person_id = NULL WHERE person_id = ?').run(id);
      db.prepare("UPDATE transactions SET person_id = NULL, person_source = NULL WHERE person_id = ?").run(id);
      db.prepare('DELETE FROM people WHERE id = ?').run(id);
    })();
    recompute(db);
    res.json({ success: true });
  }));

  // ---------- Remembered rules ----------
  app.get('/api/rules', h((_req, res) => {
    const category = db.prepare(`SELECT r.id, r.pattern, c.name AS target FROM rules r JOIN categories c ON c.id = r.category_id
      WHERE r.source = 'user' ORDER BY r.pattern`).all();
    const person = db.prepare(`SELECT r.id, r.pattern, p.name AS target FROM person_rules r JOIN people p ON p.id = r.person_id
      ORDER BY r.pattern`).all();
    res.json({ category, person });
  }));

  app.delete('/api/rules/:id', h((req, res) => {
    db.prepare("DELETE FROM rules WHERE id = ? AND source = 'user'").run(idParam(req));
    recompute(db);
    res.json({ success: true });
  }));

  app.delete('/api/person-rules/:id', h((req, res) => {
    db.prepare('DELETE FROM person_rules WHERE id = ?').run(idParam(req));
    recompute(db);
    res.json({ success: true });
  }));

  // ---------- Settings ----------
  app.get('/api/settings', h((_req, res) => {
    res.json({
      oneTimeThresholdCents: oneTimeThreshold(db),
      aiConfigured: hasLlmKey(),
      // Shown on the About page so people can see exactly where their data lives
      databaseFile: dbPath() === ':memory:' ? null : path.resolve(dbPath()),
      backupFolder: path.resolve(backupDir()),
    });
  }));

  app.patch('/api/settings', h((req, res) => {
    const v = Number(req.body?.oneTimeThresholdCents);
    if (!Number.isInteger(v) || v < 10_000) throw new BadRequest('Threshold must be at least $100');
    setSetting(db, 'one_time_threshold_cents', String(v));
    res.json({ success: true });
  }));

  // ---------- AI (opt-in) ----------
  app.post('/api/ai/recategorize', h(async (_req, res) => {
    const result = await recategorizeWithLlm(db);
    recompute(db);
    audit(db, 'ai_recategorize', { reviewed: result.reviewed, changed: result.changed });
    res.json(result);
  }));

  // ---------- Reset ----------
  app.post('/api/reset', h((req, res) => {
    if (req.body?.confirm !== RESET_CONFIRMATION) {
      throw new BadRequest(`To reset, type "${RESET_CONFIRMATION}" to confirm`);
    }
    const backup = backupDb(db, 'before-reset');
    db.transaction(() => {
      db.exec(`
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
    audit(db, 'reset', { backup });
    res.json({ success: true, backup: backup ? path.basename(backup) : null });
  }));

  // ---------- Errors ----------
  app.use('/api', (_req: Request, res: Response) => res.status(404).json({ error: 'Not found' }));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof UserError) return res.status(400).json({ error: err.message });
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large (limit 10 MB)' });
    console.error(err);
    res.status(500).json({ error: err?.message || 'Server error' });
  });

  // ---------- Client ----------
  const clientDist = path.resolve(process.cwd(), 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}

function hasLlmKey(): boolean {
  if (process.env.LLM_API_KEY) return true;
  try {
    return /^\s*LLM_API_KEY\s*=\s*\S+/m.test(fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf-8'));
  } catch {
    return false;
  }
}
