import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDb, saveDb } from './db.js';
import { importCsvContent } from './importer.js';
import { recategorizeWithLlm } from './llm.js';

export async function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const upload = multer({ storage: multer.memoryStorage() });

  // 1. Upload one or more CSVs
  app.post('/api/imports', upload.array('files'), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const db = await getDb();
      const results = [];

      for (const file of files) {
        const text = file.buffer.toString('utf-8');
        const result = importCsvContent(db, file.originalname, text);
        results.push(result);
      }

      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. List imports
  app.get('/api/imports', async (req, res) => {
    try {
      const db = await getDb();
      const rows = db.exec(`
        SELECT i.id, i.filename, i.imported_at, i.rows_added, i.rows_skipped, a.bank, a.account_type
        FROM imports i
        JOIN accounts a ON i.account_id = a.id
        ORDER BY i.id DESC
      `);
      if (rows.length === 0) return res.json({ imports: [] });

      const imports = rows[0].values.map(v => ({
        id: v[0],
        filename: v[1],
        importedAt: v[2],
        rowsAdded: v[3],
        rowsSkipped: v[4],
        bank: v[5],
        accountType: v[6]
      }));
      res.json({ imports });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 3. Undo / delete an import
  app.delete('/api/imports/:id', async (req, res) => {
    try {
      const db = await getDb();
      const id = parseInt(req.params.id);
      db.run("DELETE FROM transactions WHERE import_id = ?", [id]);
      db.run("DELETE FROM imports WHERE id = ?", [id]);
      saveDb();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 4. Categories list
  app.get('/api/categories', async (req, res) => {
    try {
      const db = await getDb();
      const rows = db.exec("SELECT id, name, color, is_system FROM categories ORDER BY name ASC");
      if (rows.length === 0) return res.json({ categories: [] });
      const categories = rows[0].values.map(v => ({
        id: v[0],
        name: v[1],
        color: v[2],
        isSystem: Boolean(v[3])
      }));
      res.json({ categories });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. Summary dashboard data
  app.get('/api/summary', async (req, res) => {
    try {
      const db = await getDb();
      const { from, to } = req.query as { from?: string; to?: string };

      let dateFilter = "1=1";
      const params: any[] = [];
      if (from) {
        dateFilter += " AND t.txn_date >= ?";
        params.push(from);
      }
      if (to) {
        dateFilter += " AND t.txn_date <= ?";
        params.push(to);
      }

      // Total spend: spend, refund, fee
      const spendQuery = db.exec(`
        SELECT 
          COALESCE(SUM(amount_cents), 0) as total_spend,
          COUNT(*) as txn_count
        FROM transactions t
        WHERE ${dateFilter} AND t.kind IN ('spend', 'refund', 'fee')
      `, params);

      const totalSpend = (spendQuery[0]?.values[0]?.[0] as number) || 0;
      const totalTxnCount = (spendQuery[0]?.values[0]?.[1] as number) || 0;

      // Money in
      const incomeQuery = db.exec(`
        SELECT COALESCE(SUM(amount_cents), 0)
        FROM transactions t
        WHERE ${dateFilter} AND t.kind = 'income'
      `, params);
      const moneyIn = (incomeQuery[0]?.values[0]?.[0] as number) || 0;

      // By category (spending only, excluding transfers and income)
      const catQuery = db.exec(`
        SELECT 
          c.id, c.name, c.color, 
          COALESCE(SUM(t.amount_cents), 0) as cat_spend,
          COUNT(t.id) as count
        FROM categories c
        JOIN transactions t ON t.category_id = c.id
        WHERE ${dateFilter} AND t.kind IN ('spend', 'refund', 'fee')
        GROUP BY c.id
        HAVING cat_spend > 0
        ORDER BY cat_spend DESC
      `, params);

      const byCategory = (catQuery[0]?.values || []).map(v => {
        const cents = v[3] as number;
        return {
          id: v[0],
          name: v[1],
          color: v[2],
          cents,
          count: v[4],
          pct: totalSpend > 0 ? Math.round((cents / totalSpend) * 1000) / 10 : 0
        };
      });

      // By month
      const monthQuery = db.exec(`
        SELECT 
          SUBSTR(t.txn_date, 1, 7) as month,
          COALESCE(SUM(t.amount_cents), 0) as month_spend
        FROM transactions t
        WHERE t.kind IN ('spend', 'refund', 'fee')
        GROUP BY month
        ORDER BY month ASC
      `);

      const byMonth = (monthQuery[0]?.values || []).map(v => ({
        month: v[0],
        cents: v[1]
      }));

      res.json({
        totalSpend,
        moneyIn,
        totalTxnCount,
        byCategory,
        byMonth
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. Transactions query
  app.get('/api/transactions', async (req, res) => {
    try {
      const db = await getDb();
      const { from, to, categoryId, month, q, kind } = req.query as Record<string, string | undefined>;

      let whereClause = "1=1";
      const params: any[] = [];

      if (from) {
        whereClause += " AND t.txn_date >= ?";
        params.push(from);
      }
      if (to) {
        whereClause += " AND t.txn_date <= ?";
        params.push(to);
      }
      if (month) {
        whereClause += " AND t.txn_date LIKE ?";
        params.push(`${month}%`);
      }
      if (categoryId) {
        whereClause += " AND t.category_id = ?";
        params.push(parseInt(categoryId));
      }
      if (q) {
        whereClause += " AND (t.merchant LIKE ? OR t.raw_description LIKE ?)";
        params.push(`%${q}%`, `%${q}%`);
      }
      if (kind) {
        whereClause += " AND t.kind = ?";
        params.push(kind);
      } else {
        // By default show spend, refund, fee
        whereClause += " AND t.kind IN ('spend', 'refund', 'fee')";
      }

      const rows = db.exec(`
        SELECT 
          t.id, t.txn_date, t.raw_description, t.merchant, t.amount_cents,
          t.kind, t.category_id, t.category_source, t.bank_category,
          c.name as category_name, c.color as category_color,
          a.bank, a.account_type
        FROM transactions t
        JOIN categories c ON t.category_id = c.id
        JOIN accounts a ON t.account_id = a.id
        WHERE ${whereClause}
        ORDER BY t.txn_date DESC, t.id DESC
      `, params);

      if (rows.length === 0) {
        return res.json({ transactions: [], count: 0, sumCents: 0 });
      }

      let sumCents = 0;
      const transactions = rows[0].values.map(v => {
        const cents = v[4] as number;
        sumCents += cents;
        return {
          id: v[0],
          date: v[1],
          rawDescription: v[2],
          merchant: v[3],
          amountCents: cents,
          kind: v[5],
          categoryId: v[6],
          categorySource: v[7],
          bankCategory: v[8],
          categoryName: v[9],
          categoryColor: v[10],
          bank: v[11],
          accountType: v[12]
        };
      });

      res.json({
        transactions,
        count: transactions.length,
        sumCents
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. Update transaction category + optional "remember" rule
  app.patch('/api/transactions/:id', async (req, res) => {
    try {
      const db = await getDb();
      const id = parseInt(req.params.id);
      const { categoryId, remember } = req.body as { categoryId: number; remember?: boolean };

      // Get transaction merchant
      const txnQuery = db.exec("SELECT merchant FROM transactions WHERE id = ?", [id]);
      if (txnQuery.length === 0 || txnQuery[0].values.length === 0) {
        return res.status(404).json({ error: 'Transaction not found' });
      }
      const merchant = txnQuery[0].values[0][0] as string;

      // Update this transaction
      db.run(
        "UPDATE transactions SET category_id = ?, category_source = 'manual' WHERE id = ?",
        [categoryId, id]
      );

      // If remember is true, create user rule and retroactively apply to non-manual rows
      if (remember) {
        db.run(
          "INSERT INTO rules (pattern, category_id, priority, source) VALUES (?, ?, 10, 'user')",
          [merchant.toLowerCase(), categoryId]
        );

        // Retroactively update all other transactions for this merchant that are NOT manual
        db.run(
          `UPDATE transactions 
           SET category_id = ?, category_source = 'user_rule' 
           WHERE LOWER(merchant) = ? AND category_source != 'manual'`,
          [categoryId, merchant.toLowerCase()]
        );
      }

      saveDb();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 8. AI recategorization using the LLM key in .env
  app.post('/api/ai/recategorize', async (req, res) => {
    try {
      const db = await getDb();
      const result = await recategorizeWithLlm(db);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 9. Reset all data (wipe transactions, imports, accounts, user rules)
  app.post('/api/reset', async (req, res) => {
    try {
      const db = await getDb();
      db.run("DELETE FROM transactions");
      db.run("DELETE FROM imports");
      db.run("DELETE FROM accounts");
      db.run("DELETE FROM rules WHERE source = 'user'");
      saveDb();
      res.json({ success: true, message: 'All transactions and imports have been reset.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve static client if dist folder exists
  const clientDist = path.resolve(process.cwd(), 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}
