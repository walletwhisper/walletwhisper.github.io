# WalletWhisper

**See where your household's money goes, without giving your bank data to anyone.**

WalletWhisper turns the CSV statements you download from your banks into one clear picture of your spending: by month, by category, by person, and by account. It runs entirely on your own computer.

> ## 🔒 Your financial data stays on your computer
>
> - **WalletWhisper is a program you run on your own computer.** There is no WalletWhisper server, no sign-up and no tracking. GitHub only hosts the code; your statements never go there.
> - **You choose where your data is kept.** The first time you start the app, it asks which folder to use. Your transactions, people, choices and automatic backups all stay in that folder, and you can move it later in **Settings**.
> - **Only you can open it.** The app only accepts connections from your own computer, so other devices and websites can't read your data.
> - **AI is optional.** It's off unless you add your own AI key. Asking a question sends only your words; the answer is calculated on your computer.
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
- **You decide what's in the charts.** Sort transactions by amount and untick any (a house deposit, a big wire) to leave it out of every chart and total. Tick it again any time.
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

### Moving to another computer

You don't need to import your statements again on a new computer.

1. **On the old computer:** go to **Settings → Move to another computer** and choose **Download backup file**. The file holds all your transactions, people, accounts and choices. You can set a password to encrypt it (AES-256), which is a good idea if it goes through email or a cloud drive.
2. **On the new computer:** install WalletWhisper. On the welcome screen, tick **Moving from another computer?** and choose the file. If WalletWhisper is already set up there, use **Settings → Restore from file** instead.

After restoring, everything works as before, and you can keep importing and editing.

**Going back and forth between computers.** If the computer you restore onto already has data, WalletWhisper compares the two first and shows what's different. You can then:
- **Combine both (recommended).**
  - Transactions, people, accounts and rules from either side are kept.
  - Changes made on only one computer come across automatically.
  - Where the same thing was changed differently on each computer, you choose per item: this computer's version or the backup's. The newer change is pre-selected, and there are "use newer / mine / backup for all" buttons.
  - Transactions that exist only on this computer are kept unless you choose to remove them.
- **Use the backup instead,** which replaces everything on this computer.
- **Cancel,** which changes nothing.

Either way, a copy of the computer's current data is saved in its backups folder first.

Backup files (`.wwbackup`) are git-ignored and blocked by the privacy check. Your AI key and data folder aren't included, because they belong to each computer.

### Optional: the AI assistant

WalletWhisper works fully without AI. With your own AI key you can also:

- **Ask questions** on the Overview and Trends screens, for example *"How much did we spend on dining last month?"*. You get the total, how it compares with the month before and the same time last year, a 13-month chart, and where the money went.
- **Get category suggestions** for merchants it doesn't recognize (**AI categorize** on Transactions).

To set it up:

1. Get an API key from one AI provider:
   - **Claude**: [console.anthropic.com](https://console.anthropic.com/settings/keys) → API keys → Create key.
   - **ChatGPT**: [platform.openai.com](https://platform.openai.com/api-keys) → API keys → Create new secret key.
   - **Gemini**: [aistudio.google.com](https://aistudio.google.com/apikey) → Get API key → Create API key.
2. In WalletWhisper, open **Settings → AI assistant** and paste it. It's saved on your computer only.

Without a key, everything else works as normal; only the AI features are unavailable.

**What is sent, and when.** Nothing is sent until you ask a question or press **AI categorize**.
- **Asking a question:** only your words and the category names are sent, so the AI can understand what you mean. Every number is calculated on your computer.
- **AI categorize:** cleaned merchant descriptions, amounts, account type and the bank's own category are sent.

Account numbers, balances, dates and names are never sent.

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
