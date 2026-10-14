# Financial Characterizer & Spending Visualizer

A local-first, interactive spending visualizer designed to import bank CSV statements (Chase Credit & Checking first, easily scalable to BoA, Santander, TD Bank, Discover, Citi, and Capital One), normalize transactions, automatically categorize spending, and provide interactive drill-down charts.

---

## Features

- **Multi-Bank Ingestion Pipeline**: Auto-detects statement headers without manual column mapping.
- **Transfers & Card Payment Exclusion**: Autopay and card payments are categorized as transfers and excluded from spending totals to prevent double-counting.
- **Refund Netting**: Credit returns (e.g. Amazon refunds) reduce the respective category total rather than inflating income.
- **Deduplication Guard**: Robust occurrence-indexed SHA-256 fingerprinting prevents double-counting when overlapping monthly statements are uploaded, while preserving legitimate same-day identical transactions.
- **Merchant Beautifier**: Strips POS terminal numbers, payment gateway prefixes (`SQ *`, `TST*`), and location junk.
- **Interactive Visualizations**:
  - **Donut Chart**: Hover to view category percentage and dollar amount; click any slice to filter the table.
  - **Monthly Trend Bar Chart**: Click a month bar to filter transactions to that month.
  - **KPI Cards**: Real-time spending total, money in (income), top category, and record count.
- **Inline Recategorization & 1-Click Rule Learning**: Fix a category directly in the table and check *"Always categorize [Merchant] as [Category]"* to apply retroactively and to future imports. Hand-edited categories are protected from being overwritten.
- **Single Process Localhost**: Runs locally at `http://127.0.0.1:8000` with zero cloud leakage.

---

## Quick Start

### 1. Start the Application
Run one command from the project root:
```bash
npm start
```
This starts the local server at `http://127.0.0.1:8000` and automatically opens your browser.

Optional AI categorization: copy `.env.example` to `.env` and add your API key.

### Your data stays on your computer
Your database (`data/`), backups, bank CSV exports and `.env` (API keys) are all git-ignored and are never committed. The only CSVs in the repo are the made-up samples in `tests/fixtures/`.

A privacy check runs automatically before every `git commit` and `git push` (hooks in `.githooks/`, switched on by `npm install`). It blocks:
- databases, backups, `.env` and bank exports;
- API keys, including the actual key values in your `.env`;
- your own account numbers and household names, read from your local database.

To block other words, such as your address or employer, list them one per line in `.privacy-blocklist`, which is itself git-ignored. Run `npm run privacy-check` to scan every file and the full history. The same check also runs on GitHub (`.github/workflows/privacy-check.yml`).

### 2. Run the Automated Tests
```bash
npm test
```

### 3. Development Mode
To develop backend and frontend with live reloading:
```bash
# Terminal 1: Backend
npm run dev:server

# Terminal 2: Frontend
npm run dev:client
```
