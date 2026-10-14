# WalletWhisper

**See where your household's money goes, without giving your bank data to anyone.**

WalletWhisper turns the CSV statements you download from your banks into one clear picture of your spending: by month, by category, by person, and by account. It runs entirely on your own computer.

> ## 🔒 Your financial data stays on your computer
>
> - **WalletWhisper is a program you run on your own computer.** There is no WalletWhisper server, no sign-up and no tracking. GitHub only hosts the code; your statements never go there.
> - **You choose where your data is kept.** The first time you start the app, it asks which folder to use. Your transactions, people, choices and automatic backups all stay in that folder, and you can move it later in **Settings**.
> - **Only you can open it.** The app only accepts connections from your own computer, so other devices and websites can't read your data.
> - **AI is optional.** It's off unless you add your own AI key, and nothing is sent until you press **AI categorize**.
>
> To delete everything, use **Accounts → Reset all data**, or delete your data folder.

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
npm start        # builds the interface and opens it in your browser
```

Choose a folder for your data, then download CSV statements from your bank's website and drop them onto the page, or click **Import**.

### Optional: AI categories

WalletWhisper works fully without AI: categories come from built-in rules and your own corrections. If you'd like AI suggestions for merchants it doesn't recognize:

1. Create an API key with your AI provider. Claude, Gemini and OpenAI keys all work.
2. In WalletWhisper, open **Settings** and paste the key. It's saved on your computer only.
3. On the Transactions screen, press **AI categorize** whenever you want suggestions.

Without a key, everything else works as normal; only **AI categorize** is unavailable.

When you press the button, only cleaned merchant descriptions, amounts, the account type (checking or credit) and the bank's own category are sent to your AI provider. Account numbers, balances, dates and names are never sent. The AI only suggests spending categories and never overrides a choice you made.

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
