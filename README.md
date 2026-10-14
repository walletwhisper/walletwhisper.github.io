# WalletWhisper

**See where your household's money goes, without giving your bank data to anyone.**

WalletWhisper turns the CSV statements you download from your banks into one clear picture of your spending: by month, by category, by person, and by account. It runs entirely in your web browser.

**Use it:** https://xiaoliu8811.github.io/financialTool/ (nothing to install).

> ## 🔒 Your financial data stays on your computer
>
> - **There is no WalletWhisper server.** The website only delivers the app to your browser. Your statements are read inside the browser and never uploaded. There's no sign-up and no tracking.
> - **Your data is saved in your browser, on your computer.** Each website's storage is private, so other websites can't read it, and it isn't synced anywhere. In Chrome and Edge you can also keep a copy in a folder you choose.
> - **The page can't send your data anywhere.** A security rule built into the page (a Content Security Policy) lets the browser contact only this site and, if you turn on AI, your AI provider.
> - **AI is optional.** It's off unless you add your own AI key. Asking a question sends only your words and the category names; the answer is calculated in your browser.
>
> To delete everything, use **Settings → Your data → Erase everything from this browser**.

---

## Features

- **Many banks, one view.** Import CSVs from checking and credit card accounts. The bank format is detected automatically (Chase checking and credit today; more banks are planned).
- **Every dollar counted once.**
  - Card payments and transfers between your own accounts are matched automatically and left out of spending.
  - Re-importing an overlapping statement never creates duplicate rows.
  - Anything ambiguous lands in a short **Review** list for you to answer once.
- **See it visually.**
  - A monthly overview with a category donut and "biggest changes vs. your typical month".
  - Trends by category, person or account, money in, and monthly cash flow. Months with missing statements are flagged.
- **Who spent what.** Mark any transaction with a household member, select many rows at once, or set a default person per account.
- **You decide what's in the charts.** Sort, filter and search transactions like a spreadsheet, and untick any (a house deposit, a big wire) to leave it out of every chart and total.
- **Safe to experiment.**
  - Undo any import.
  - A copy of your data is kept automatically before every undo, reset or restore, plus one a day.
  - Download a backup file at any time.

## Getting started

1. Open https://xiaoliu8811.github.io/financialTool/ in Chrome, Edge, Firefox or Safari on your computer.
2. Choose **Start**.
3. Download CSV statements from your bank's website and drop them onto the page, or click **Import**.

Your data is now saved in this browser. Two things to know:

- **Clearing this browser's site data deletes it.** Download a backup file now and then (**Settings → Back up or move to another computer**). In Chrome or Edge, you can instead choose **Keep a copy in a folder**, and the app updates a file there after every change. Settings also keeps automatic copies from the last week.
- **Each browser has its own data.** A different browser, profile or computer starts empty until you open a backup file there.

### Moving to another computer or browser

You don't need to import your statements again.

1. **Where your data is now:** go to **Settings → Back up or move to another computer** and choose **Download backup file**. It holds all your transactions, people, accounts and choices. You can set a password to encrypt it (AES-256), which is a good idea if it goes through email or a cloud drive.
2. **On the new computer or browser:** open WalletWhisper and choose **I have a backup file**. If it already has data, use **Settings → Open a backup file** instead.

After that, everything works as before, and you can keep importing and editing.

**Going back and forth.** If the browser you open the backup in already has data, WalletWhisper compares the two first and shows what's different. You can then:
- **Combine both (recommended).**
  - Transactions, people, accounts and rules from either side are kept.
  - Changes made on only one side come across automatically.
  - Where the same thing was changed differently on each side, you choose per item: this computer's version or the backup's. The newer change is pre-selected, and there are "use newer / mine / backup for all" buttons.
  - Transactions that exist only here are kept unless you choose to remove them.
- **Use the backup instead,** which replaces everything here.
- **Cancel,** which changes nothing.

Either way, a copy of the current data is kept first.

Backup files (`.wwbackup`) are git-ignored and blocked by the privacy check. Your AI key isn't included.

**Coming from the earlier desktop version?** It kept your data in `app.db` in its data folder. Open that file with **I have a backup file**. If there's also an `app.db-wal` file next to it, it holds recent changes: combine the two into one file first, for example with `sqlite3 app.db "VACUUM INTO 'walletwhisper.db'"`, and open that.

### Run it on your own computer instead

You need [Node.js](https://nodejs.org) 22 or newer.

```bash
git clone https://github.com/XiaoLiu8811/financialTool.git walletwhisper
cd walletwhisper
npm install
npm start        # builds the app and opens it at http://localhost:8000
```

It's the same app. Data you save at `localhost:8000` is separate from data on the website, because each address has its own browser storage. Use a backup file to move between them.

### Optional: the AI assistant

WalletWhisper works fully without AI. With your own AI key you can also:

- **Ask questions** on the Overview and Trends screens, for example *"How much did we spend on dining last month?"*. You get the total, how it compares with the month before and the same time last year, a 13-month chart, and where the money went.
- **Get category suggestions** for merchants it doesn't recognize (**AI categorize** on Transactions).

To set it up:

1. Get an API key from one AI provider:
   - **Claude**: [console.anthropic.com](https://console.anthropic.com/settings/keys) → API keys → Create key.
   - **ChatGPT**: [platform.openai.com](https://platform.openai.com/api-keys) → API keys → Create new secret key.
   - **Gemini**: [aistudio.google.com](https://aistudio.google.com/apikey) → Get API key → Create API key.
2. In WalletWhisper, open **Settings → AI assistant** and paste it. It's saved in this browser only, and sent only to that provider.

Without a key, everything else works as normal; only the AI features are unavailable.

**What is sent, and when.** Nothing is sent until you ask a question or press **AI categorize**, and then only to the provider your key belongs to.
- **Asking a question:** only your words and the category names are sent, so the AI can understand what you mean. Every number is calculated on your computer.
- **AI categorize:** cleaned merchant descriptions, amounts, account type and the bank's own category are sent.

Account numbers, balances, dates and names are never sent.

## For developers

```bash
npm test        # engine + in-page API tests (in-memory databases, never real data)
npm run dev     # app with hot reload (Vite)
npm run build   # static site in client/dist
```

- `src/` is the engine: import, transfer matching, reports, backups and the in-page API (`src/app.ts`). It runs in the browser on SQLite compiled to WebAssembly (`src/sqlite.ts`), and in Node for the tests.
- `client/` is the React app. `client/src/local/` saves the data in the browser (IndexedDB) and to the optional folder.
- Pushing to `main` publishes the site with GitHub Pages (`.github/workflows/pages.yml`), after the privacy check and the tests pass.

Design notes: [DESIGN.md](DESIGN.md).

### Privacy guard for contributors

A privacy check runs automatically before every `git commit` and `git push`. The hooks live in `.githooks/` and are switched on by `npm install`. It blocks:
- databases, backups, `.env` and bank exports;
- API keys, including the actual key values in your `.env`;
- your own account numbers and household names. They're read from any WalletWhisper database file in `data/`, and remembered in `.privacy-blocklist` so they stay blocked after that file is gone.

To block other words, such as your address or employer, list them one per line in `.privacy-blocklist`, which is itself git-ignored. Run `npm run privacy-check` to scan every file and the full history. The same check also runs on GitHub (`.github/workflows/privacy-check.yml`).

Test data in `tests/fixtures/` is made up. Never add real statements to the repo.
