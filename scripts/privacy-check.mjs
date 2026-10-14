#!/usr/bin/env node
/**
 * Blocks personal financial data and secrets from reaching git / GitHub.
 *
 *   node scripts/privacy-check.mjs --staged   files staged for commit   (pre-commit hook)
 *   node scripts/privacy-check.mjs --push     commits about to be pushed (pre-push hook, reads refs on stdin)
 *   node scripts/privacy-check.mjs --all      every tracked file + full history (manual / CI)
 *
 * Checks:
 *   1. Forbidden files: databases, backups, .env, bank exports (CSV/OFX/QFX/XLSX/PDF) outside tests/fixtures.
 *   2. Secrets: API key formats, private keys, and the literal values in your local .env.
 *   3. Your own identifiers, read automatically from your local database (account last-4 digits,
 *      people names and aliases) plus any extra terms you list in .privacy-blocklist (git-ignored).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const ZERO = /^0+$/;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

// ---------- rules ----------

const FORBIDDEN_FILES = [
  [/(^|\/)\.env$|(^|\/)\.env\.(?!example$)[^/]+$/i, 'environment file with secrets'],
  [/(^|\/)data\//i, 'local app data folder'],
  [/(^|\/)backups?\//i, 'backup folder'],
  [/\.(db|db-wal|db-shm|db-journal|sqlite3?)$/i, 'database file'],
  [/\.(pem|key|p12|pfx)$/i, 'private key / certificate'],
];
const BANK_EXPORT = /\.(csv|ofx|qfx|qif|xlsx?|pdf)$/i;
const ALLOWED_EXPORT_DIR = /^tests\/fixtures\//;

const SECRET_PATTERNS = [
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/sk-ant-[0-9A-Za-z_-]{20,}/, 'Anthropic API key'],
  [/sk-(proj-)?[0-9A-Za-z_-]{32,}/, 'OpenAI API key'],
  [/gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,}/, 'GitHub token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*['"][^'"\s]{16,}['"]/i, 'hard-coded credential'],
];

// Lock files are machine-generated hashes; only secret formats are checked there
const SKIP_PERSONAL = /(^|\/)package-lock\.json$|\.(png|jpe?g|gif|ico|woff2?)$/i;

function localSecrets() {
  const out = [];
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(.+?)\s*$/i);
      if (m && m[3].length >= 8) out.push({ term: m[3].replace(/^['"]|['"]$/g, ''), label: `value of ${m[1]} from .env` });
    }
  } catch { /* no .env */ }
  return out;
}

function personalTerms() {
  const terms = [];
  // From the local database: account last-4s, people names and aliases
  try {
    const require = createRequire(path.join(ROOT, 'package.json'));
    const Database = require('better-sqlite3');
    const dbFile = path.join(ROOT, 'data', 'app.db');
    if (fs.existsSync(dbFile)) {
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        for (const r of db.prepare("SELECT last4 FROM accounts WHERE last4 IS NOT NULL AND last4 != ''").all()) {
          terms.push({ term: r.last4, label: 'account number ending', digits: true });
        }
        for (const r of db.prepare('SELECT name, aliases FROM people').all()) {
          terms.push({ term: r.name, label: 'household member name' });
          for (const a of JSON.parse(r.aliases || '[]')) terms.push({ term: a, label: 'household member alias' });
        }
      } catch { /* older schema */ }
      db.close();
    }
  } catch { /* better-sqlite3 not installed (e.g. CI) */ }
  // Extra terms, one per line (git-ignored): names, addresses, account numbers, employer...
  try {
    const list = fs.readFileSync(path.join(ROOT, '.privacy-blocklist'), 'utf8');
    for (const raw of list.split(/\r?\n/)) {
      const t = raw.trim();
      if (t && !t.startsWith('#')) terms.push({ term: t, label: 'term from .privacy-blocklist', digits: /^\d+$/.test(t) });
    }
  } catch { /* none */ }
  return terms.filter(t => t.term.length >= 3);
}

function termRegex({ term, digits }) {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  // Digits must stand alone (not inside a longer number); words match case-insensitively
  return digits ? new RegExp(`(?<![0-9])${esc}(?![0-9])`) : new RegExp(`\\b${esc}\\b`, 'i');
}

// ---------- what to scan ----------

/** Returns [{ file, lines: [{text, where}] }] */
function stagedChanges() {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  return files.map(file => {
    const diff = git(['diff', '--cached', '-U0', '--no-color', '--', file]);
    return { file, lines: addedLines(diff, 'staged') };
  });
}

function pushRanges() {
  const input = fs.readFileSync(0, 'utf8');
  const ranges = [];
  for (const line of input.split(/\r?\n/)) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // branch deletion
    ranges.push(remoteSha && !ZERO.test(remoteSha)
      ? [`${remoteSha}..${localSha}`]
      : [localSha, '--not', '--remotes']);
  }
  return ranges;
}

function commitChanges(revArgs) {
  const byFile = new Map();
  const commits = git(['rev-list', ...revArgs]).split('\n').filter(Boolean);
  for (const sha of commits) {
    const short = sha.slice(0, 7);
    const files = git(['diff-tree', '--root', '--no-commit-id', '-r', '--name-only', '--diff-filter=ACMR', '-z', sha])
      .split('\0').filter(Boolean);
    for (const file of files) {
      const diff = git(['show', '-U0', '--no-color', '--format=', sha, '--', file]);
      const entry = byFile.get(file) || { file, lines: [] };
      entry.lines.push(...addedLines(diff, `commit ${short}`));
      byFile.set(file, entry);
    }
  }
  return [...byFile.values()];
}

function trackedFiles() {
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const out = files.map(file => {
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { /* deleted */ }
    return { file, lines: text.split(/\r?\n/).map((t, i) => ({ text: t, where: `line ${i + 1}` })) };
  });
  // Also every file name that ever existed in history
  const historic = git(['log', '--all', '--pretty=format:', '--name-only', '--diff-filter=A']).split('\n').filter(Boolean);
  for (const f of new Set(historic)) if (!files.includes(f)) out.push({ file: f, lines: [], historic: true });
  return out;
}

function addedLines(diff, where) {
  return diff.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => ({ text: l.slice(1), where }));
}

// ---------- check ----------

function check(changes, extraHistoryScan) {
  const problems = [];
  const secrets = localSecrets();
  const personal = personalTerms().map(t => ({ ...t, re: termRegex(t) }));

  for (const { file, lines, historic } of changes) {
    const posix = file.replace(/\\/g, '/');
    const tag = historic ? `${posix} (in git history)` : posix;
    for (const [re, why] of FORBIDDEN_FILES) if (re.test(posix)) problems.push(`${tag}: ${why}`);
    if (BANK_EXPORT.test(posix) && !ALLOWED_EXPORT_DIR.test(posix)) {
      problems.push(`${tag}: looks like a bank export (only tests/fixtures/ may hold sample files)`);
    }
    const checkPersonal = !SKIP_PERSONAL.test(posix);
    for (const { text, where } of lines) {
      for (const [re, why] of SECRET_PATTERNS) if (re.test(text)) problems.push(`${posix} (${where}): ${why}`);
      for (const s of secrets) if (text.includes(s.term)) problems.push(`${posix} (${where}): ${s.label}`);
      if (checkPersonal) {
        for (const p of personal) if (p.re.test(text)) problems.push(`${posix} (${where}): ${p.label} "${mask(p.term)}"`);
      }
    }
  }
  if (extraHistoryScan) problems.push(...extraHistoryScan(secrets, personal));
  return [...new Set(problems)];
}

/** --all: also look for secrets / personal terms in every line ever added in history */
function historyScan() {
  return check(commitChanges(['--branches', '--tags']));
}

function mask(term) {
  return /^\d+$/.test(term) ? term : term[0] + '*'.repeat(Math.max(1, term.length - 1));
}

// ---------- main ----------

const mode = process.argv[2] || '--staged';
let problems;
if (mode === '--staged') problems = check(stagedChanges());
else if (mode === '--push') problems = check(pushRanges().flatMap(commitChanges));
else if (mode === '--all') problems = check(trackedFiles(), historyScan);
else { console.error(`Unknown mode ${mode}`); process.exit(2); }

if (problems.length) {
  console.error('\n⛔ Privacy check failed. Personal data or secrets would be ' +
    (mode === '--push' ? 'pushed' : 'committed') + ':\n');
  for (const p of problems.slice(0, 50)) console.error('  - ' + p);
  if (problems.length > 50) console.error(`  ... and ${problems.length - 50} more`);
  console.error('\nRemove it (and from earlier commits if it is in history), then try again.\n');
  process.exit(1);
}
console.log(`✔ Privacy check passed (${mode.slice(2)}).`);
