# WalletWhisper

**See where your household's money goes, without giving your bank data to anyone.**

WalletWhisper turns the CSV statements you download from your banks into one clear picture of your spending: by month, by category, by person, and by account. It runs entirely on your own computer.

> ## 🔒 Your financial data never leaves your computer
>
> - **There is no WalletWhisper server and no account to sign up for.** You download the program from GitHub and run it on your own machine. GitHub only hosts the code; your statements never go there.
> - **Everything is stored in one local file:** `data/app.db` inside the folder where you installed the app. Automatic backups go to `data/backups/`. Both folders are git-ignored, so they can't be committed by accident.
> - **Only your computer can open the app.** It listens on `127.0.0.1` (localhost), so other devices on your network can't reach it. It also refuses requests from other websites open in your browser.
> - **No analytics, no tracking, no cookies, no external fonts or scripts.**
> - **AI is optional and off by default.** See [Optional: AI categories](#optional-ai-categories) for exactly what is sent if you turn it on.
>
> To delete everything, use **Accounts → Reset all data** in the app, or delete the `data/` folder. To move to a new computer, copy the `data/` folder.

---

## Features

- **Many banks, one view.** Import CSVs from checking and credit card accounts. The bank format is detected automatically (Chase checking and credit today; more banks are planned).
- **Every dollar counted once.**
  - Card payments and transfers between your own accounts are matched automatically and left out of spending.
  - Re-importing an overlapping statement never creates duplicate rows.
  - Anything ambiguous lands in a short **Review** list for you to answer once.
- **See it visually.**
  - A monthly overview with a category donut and "biggest changes vs. your typical month".
  - Stacked trends by category, person or account. Months with missing statements are flagged.
- **Who spent what.** Mark any transaction with a household member, select many rows at once, or set a default person per account.
- **One-time items** (a house closing, a big wire) are kept separate, so they don't distort your normal monthly pattern.
- **Undo and backups.**
  - Undo any import.
  - Reset asks you to type a confirmation.
  - A backup is saved automatically before any destructive action.

## Getting started

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/XiaoLiu8811/financialTool.git walletwhisper
cd walletwhisper
npm install      # installs the server and the web interface
npm start        # builds the interface and opens http://127.0.0.1:8000
```

Then download CSV statements from your bank's website and drop them onto the page, or click **Import**.

### Optional: AI categories

WalletWhisper categorizes transactions with built-in rules and your own corrections, so you don't need AI. If you'd like AI suggestions for unclear merchants:

1. Copy `.env.example` to `.env`.
2. Paste your own Google Gemini API key into it. `.env` is git-ignored.
3. Press **AI categorize** on the Transactions screen.

What gets sent to Google, only when you press the button:
- **Sent:** cleaned merchant descriptions with reference numbers stripped, the amount, the bank's own category, and whether the account is checking or credit.
- **Never sent:** account numbers, balances, dates, people, or file names.

The AI can only suggest a spending category. It never decides what is a transfer or income, and it never overrides a choice you made.

## For developers

```bash
npm test             # engine + API tests (use an in-memory database, never your real data)
npm run dev:server   # backend with reload
npm run dev:client   # frontend with hot reload (Vite)
```

Design notes: [DESIGN.md](DESIGN.md).

### Privacy guard for contributors

A privacy check runs automatically before every `git commit` and `git push`. The hooks live in `.githooks/` and are switched on by `npm install`. It blocks:
- databases, backups, `.env` and bank exports;
- API keys, including the actual key values in your `.env`;
- your own account numbers and household names, read from your local database.

To block other words, such as your address or employer, list them one per line in `.privacy-blocklist`, which is itself git-ignored. Run `npm run privacy-check` to scan every file and the full history. The same check also runs on GitHub (`.github/workflows/privacy-check.yml`).

Test data in `tests/fixtures/` is made up. Never add real statements to the repo.
