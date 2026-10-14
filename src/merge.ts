import type { Db } from './db.js';
import { applyDecisions, parseList, recompute } from './ledger.js';
import { getSetting, openDb, setSetting } from './db.js';

/**
 * Combining a backup from another computer with the data on this one.
 *
 * Rows are matched by stable keys, not database ids: transactions by fingerprint, categories and
 * people by name, accounts by bank profile + card ending (or nickname for accounts you don't import),
 * rules by pattern. Anything that exists on only one side is kept. An edit made on only one side is
 * taken automatically. Only when both sides changed the same thing differently is it a conflict
 * that the user resolves.
 */

type Side = 'mine' | 'theirs';

export interface Conflict {
  id: string;
  kind: 'transaction' | 'rule' | 'person_rule' | 'account';
  title: string;
  detail: string;
  field: string;
  mine: string;
  theirs: string;
  mineChangedAt: string | null;
  theirsChangedAt: string | null;
  suggested: Side;
}

export interface MergePreview {
  identical: boolean;
  newTransactions: number;
  localOnlyTransactions: number;
  localOnlySample: { date: string; merchant: string; amountCents: number }[];
  newPeople: string[];
  newAccounts: string[];
  newRules: number;
  editsFromBackup: number;
  conflicts: Conflict[];
}

/** Open a backup's database, upgrading it if it came from an older version. */
export function openBackupCopy(data: Uint8Array): Db {
  return openDb(data);
}

// ---------- matching helpers ----------

interface AccountRow {
  id: number; profile_id: string; bank: string; account_type: string; nickname: string | null; last4: string | null;
  is_tracked: number; card_policy: string | null; match_patterns: string; default_person_id: number | null;
}
interface DecisionRow {
  fingerprint: string; kind: string | null; category_id: number | null; person_id: number | null;
  is_one_time: number | null; reviewed: number | null; updated_at: string;
}

const accountKey = (a: AccountRow) =>
  a.last4 ? `${a.profile_id}|${a.last4}` : `${a.profile_id}|~${(a.nickname ?? a.bank).trim().toLowerCase()}`;
const accountName = (a: AccountRow) => a.nickname || `${a.bank} ${a.account_type}${a.last4 ? ` ··${a.last4}` : ''}`;

function lookups(db: Db) {
  const categories = db.prepare('SELECT id, name, color FROM categories').all() as { id: number; name: string; color: string }[];
  const people = db.prepare('SELECT id, name, color, aliases FROM people').all() as { id: number; name: string; color: string; aliases: string }[];
  const accounts = db.prepare('SELECT * FROM accounts').all() as AccountRow[];
  return {
    categories, people, accounts,
    catName: new Map(categories.map(c => [c.id, c.name])),
    personName: new Map(people.map(p => [p.id, p.name])),
    accountByKey: new Map(accounts.map(a => [accountKey(a), a])),
    accountById: new Map(accounts.map(a => [a.id, a])),
  };
}

const KIND_LABEL: Record<string, string> = {
  spend: 'Spending', refund: 'Refund', fee: 'Fee', income: 'Income', transfer: 'Transfer between own accounts',
};
const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const later = (a: string | null, b: string | null): Side => (b && (!a || b > a) ? 'theirs' : 'mine');

/** What each decision field means to a person, given both databases' id→name maps. */
const DECISION_FIELDS = [
  { col: 'category_id', label: 'Category', show: (v: any, names: { cat: Map<number, string> }) => names.cat.get(v) ?? '?' },
  { col: 'person_id', label: 'Person', show: (v: any, names: { person: Map<number, string> }) => names.person.get(v) ?? '?' },
  { col: 'kind', label: 'Type', show: (v: any) => KIND_LABEL[v] ?? v },
  { col: 'is_one_time', label: 'Charts', show: (v: any) => (v ? 'Hidden from charts' : 'Shown in charts') },
] as const;

/** Compare decision values by meaning (category/person by name), not raw id. */
function sameValue(col: string, mine: any, theirs: any, l: ReturnType<typeof lookups>, o: ReturnType<typeof lookups>): boolean {
  if (col === 'category_id') return l.catName.get(mine) === o.catName.get(theirs);
  if (col === 'person_id') return (l.personName.get(mine) ?? '').toLowerCase() === (o.personName.get(theirs) ?? '').toLowerCase();
  return mine === theirs;
}

// ---------- compare ----------

export function compareWithBackup(live: Db, other: Db): MergePreview {
  const l = lookups(live);
  const o = lookups(other);

  const liveFps = new Set((live.prepare('SELECT fingerprint FROM transactions').all() as { fingerprint: string }[]).map(r => r.fingerprint));
  const otherFps = new Set((other.prepare('SELECT fingerprint FROM transactions').all() as { fingerprint: string }[]).map(r => r.fingerprint));
  const newTransactions = [...otherFps].filter(f => !liveFps.has(f)).length;
  const localOnly = [...liveFps].filter(f => !otherFps.has(f));
  const sampleStmt = live.prepare('SELECT txn_date AS date, merchant, amount_cents AS amountCents FROM transactions WHERE fingerprint = ?');
  const localOnlySample = localOnly.slice(0, 5).map(fp => sampleStmt.get(fp) as { date: string; merchant: string; amountCents: number });

  const livePeople = new Set(l.people.map(p => p.name.toLowerCase()));
  const newPeople = o.people.filter(p => !livePeople.has(p.name.toLowerCase())).map(p => p.name);
  const newAccounts = o.accounts.filter(a => !l.accountByKey.has(accountKey(a))).map(accountName);

  const conflicts: Conflict[] = [];

  // Transaction edits (stored as decisions, with the time they were last changed)
  const mineDecisions = new Map((live.prepare('SELECT * FROM decisions').all() as DecisionRow[]).map(d => [d.fingerprint, d]));
  const theirDecisions = other.prepare('SELECT * FROM decisions').all() as DecisionRow[];
  const describe = (fp: string) => {
    const t = (live.prepare('SELECT txn_date AS date, merchant, amount_cents AS cents FROM transactions WHERE fingerprint = ?').get(fp)
      ?? other.prepare('SELECT txn_date AS date, merchant, amount_cents AS cents FROM transactions WHERE fingerprint = ?').get(fp)) as
      { date: string; merchant: string; cents: number } | undefined;
    return t ? { title: t.merchant, detail: `${t.date} · ${usd(t.cents)}` } : { title: 'A transaction', detail: '' };
  };
  let editsFromBackup = 0;
  for (const theirs of theirDecisions) {
    const mine = mineDecisions.get(theirs.fingerprint);
    for (const f of DECISION_FIELDS) {
      const tv = (theirs as any)[f.col];
      if (tv === null || tv === undefined) continue;
      const mv = mine ? (mine as any)[f.col] : null;
      if (mv === null || mv === undefined) { editsFromBackup++; continue; }
      if (sameValue(f.col, mv, tv, l, o)) continue;
      const { title, detail } = describe(theirs.fingerprint);
      conflicts.push({
        id: `d:${theirs.fingerprint}:${f.col}`, kind: 'transaction', title, detail, field: f.label,
        mine: f.show(mv, { cat: l.catName, person: l.personName } as any),
        theirs: f.show(tv, { cat: o.catName, person: o.personName } as any),
        mineChangedAt: mine!.updated_at, theirsChangedAt: theirs.updated_at,
        suggested: later(mine!.updated_at, theirs.updated_at),
      });
    }
    if (theirs.reviewed && !mine?.reviewed) editsFromBackup++;
  }

  // "Always use this category / person" rules
  const mineRules = new Map((live.prepare("SELECT pattern, category_id FROM rules WHERE source = 'user'").all() as { pattern: string; category_id: number }[])
    .map(r => [r.pattern, l.catName.get(r.category_id)]));
  let newRules = 0;
  for (const r of other.prepare("SELECT pattern, category_id FROM rules WHERE source = 'user'").all() as { pattern: string; category_id: number }[]) {
    const theirs = o.catName.get(r.category_id) ?? '?';
    if (!mineRules.has(r.pattern)) { newRules++; continue; }
    if (mineRules.get(r.pattern) !== theirs) {
      conflicts.push({ id: `r:${r.pattern}`, kind: 'rule', title: `Rule for "${r.pattern}"`, detail: 'Always use this category',
        field: 'Category', mine: mineRules.get(r.pattern) ?? '?', theirs, mineChangedAt: null, theirsChangedAt: null, suggested: 'mine' });
    }
  }
  const minePersonRules = new Map((live.prepare('SELECT pattern, person_id FROM person_rules').all() as { pattern: string; person_id: number }[])
    .map(r => [r.pattern, l.personName.get(r.person_id)]));
  for (const r of other.prepare('SELECT pattern, person_id FROM person_rules').all() as { pattern: string; person_id: number }[]) {
    const theirs = o.personName.get(r.person_id) ?? '?';
    if (!minePersonRules.has(r.pattern)) { newRules++; continue; }
    if ((minePersonRules.get(r.pattern) ?? '').toLowerCase() !== theirs.toLowerCase()) {
      conflicts.push({ id: `pr:${r.pattern}`, kind: 'person_rule', title: `Rule for "${r.pattern}"`, detail: 'Always assign to this person',
        field: 'Person', mine: minePersonRules.get(r.pattern) ?? '?', theirs, mineChangedAt: null, theirsChangedAt: null, suggested: 'mine' });
    }
  }

  // Account settings that both sides set differently
  for (const theirs of o.accounts) {
    const mine = l.accountByKey.get(accountKey(theirs));
    if (!mine) continue;
    const fields: [string, string, string | null, string | null][] = [
      ['nickname', 'Name', mine.nickname, theirs.nickname],
      ['card_policy', 'Card payments', mine.card_policy, theirs.card_policy],
      ['default_person', 'Default person',
        mine.default_person_id ? l.personName.get(mine.default_person_id) ?? null : null,
        theirs.default_person_id ? o.personName.get(theirs.default_person_id) ?? null : null],
    ];
    for (const [col, label, mv, tv] of fields) {
      if (mv && tv && mv.toLowerCase() !== tv.toLowerCase()) {
        conflicts.push({ id: `a:${accountKey(theirs)}:${col}`, kind: 'account', title: accountName(mine), detail: 'Account setting',
          field: label, mine: mv, theirs: tv, mineChangedAt: null, theirsChangedAt: null, suggested: 'mine' });
      }
    }
  }

  return {
    identical: newTransactions === 0 && localOnly.length === 0 && newPeople.length === 0 && newAccounts.length === 0
      && newRules === 0 && editsFromBackup === 0 && conflicts.length === 0,
    newTransactions,
    localOnlyTransactions: localOnly.length,
    localOnlySample,
    newPeople,
    newAccounts,
    newRules,
    editsFromBackup,
    conflicts,
  };
}

// ---------- combine ----------

export interface MergeOptions {
  /** Conflict id -> which side wins. Unlisted conflicts keep this computer's value. */
  choices: Record<string, Side>;
  /** Remove transactions that exist only on this computer (e.g. imports undone on the other one). */
  removeLocalOnly: boolean;
}

export function mergeBackup(live: Db, other: Db, opts: MergeOptions): { added: number; removed: number } {
  const o = lookups(other);
  const pick = (id: string): Side => opts.choices[id] ?? 'mine';
  let added = 0;
  let removed = 0;

  live.transaction(() => {
    // Categories and people: add the ones this computer doesn't have; people also gain aliases
    const catId = new Map<string, number>((live.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[]).map(c => [c.name, c.id]));
    for (const c of o.categories) {
      if (!catId.has(c.name)) catId.set(c.name, Number(live.prepare('INSERT INTO categories (name, color, is_system) VALUES (?, ?, 0)').run(c.name, c.color).lastInsertRowid));
    }
    const personId = new Map<string, number>((live.prepare('SELECT id, name FROM people').all() as { id: number; name: string }[]).map(p => [p.name.toLowerCase(), p.id]));
    for (const p of o.people) {
      const id = personId.get(p.name.toLowerCase());
      if (id === undefined) {
        personId.set(p.name.toLowerCase(), Number(live.prepare('INSERT INTO people (name, color, aliases) VALUES (?, ?, ?)').run(p.name, p.color, p.aliases).lastInsertRowid));
      } else {
        const mine = live.prepare('SELECT aliases FROM people WHERE id = ?').get(id) as { aliases: string };
        const union = [...new Set([...parseList(mine.aliases), ...parseList(p.aliases)])];
        live.prepare('UPDATE people SET aliases = ? WHERE id = ?').run(JSON.stringify(union), id);
      }
    }
    const mapCat = (otherId: number | null) => (otherId === null ? null : catId.get(o.catName.get(otherId) ?? '') ?? null);
    const mapPerson = (otherId: number | null) => (otherId === null ? null : personId.get((o.personName.get(otherId) ?? '').toLowerCase()) ?? null);

    // Accounts: add missing; for shared ones, fill blanks, merge match patterns, apply chosen settings
    const accountId = new Map<number, number>(); // other id -> live id
    for (const a of o.accounts) {
      const mine = (live.prepare('SELECT * FROM accounts').all() as AccountRow[]).find(x => accountKey(x) === accountKey(a));
      if (!mine) {
        accountId.set(a.id, Number(live.prepare(`INSERT INTO accounts (profile_id, bank, account_type, nickname, last4, is_tracked, card_policy, match_patterns, default_person_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.profile_id, a.bank, a.account_type, a.nickname, a.last4, a.is_tracked,
          a.card_policy, a.match_patterns, mapPerson(a.default_person_id)).lastInsertRowid));
        continue;
      }
      accountId.set(a.id, mine.id);
      const key = accountKey(a);
      const patterns = [...new Set([...parseList(mine.match_patterns), ...parseList(a.match_patterns)])];
      const theirPerson = mapPerson(a.default_person_id);
      const choose = <T>(col: string, mv: T | null, tv: T | null) => (!mv ? tv ?? mv : tv && pick(`a:${key}:${col}`) === 'theirs' ? tv : mv);
      live.prepare('UPDATE accounts SET match_patterns = ?, nickname = ?, card_policy = ?, default_person_id = ? WHERE id = ?').run(
        JSON.stringify(patterns),
        choose('nickname', mine.nickname, a.nickname),
        choose('card_policy', mine.card_policy, a.card_policy),
        choose('default_person', mine.default_person_id, theirPerson),
        mine.id);
    }

    // Transactions that only the backup has, with their import record
    const liveFps = new Set((live.prepare('SELECT fingerprint FROM transactions').all() as { fingerprint: string }[]).map(r => r.fingerprint));
    const importId = new Map<number, number>();
    const mapImport = (otherImportId: number) => {
      if (importId.has(otherImportId)) return importId.get(otherImportId)!;
      const imp = other.prepare('SELECT * FROM imports WHERE id = ?').get(otherImportId) as any;
      const existing = live.prepare('SELECT id FROM imports WHERE filename = ? AND imported_at = ?').get(imp.filename, imp.imported_at) as { id: number } | undefined;
      const id = existing?.id ?? Number(live.prepare(`INSERT INTO imports (account_id, filename, imported_at, rows_added, rows_skipped, min_date, max_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(accountId.get(imp.account_id), imp.filename, imp.imported_at, imp.rows_added, imp.rows_skipped,
        imp.min_date, imp.max_date).lastInsertRowid);
      importId.set(otherImportId, id);
      return id;
    };
    const insertTxn = live.prepare(`INSERT INTO transactions (import_id, account_id, txn_date, raw_description, merchant, amount_cents, kind,
      category_id, category_source, bank_category, fingerprint, direction, bank_kind, kind_source, transfer_via, counterparty_account_id,
      person_id, person_source, is_one_time, reviewed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of other.prepare('SELECT * FROM transactions').all() as any[]) {
      if (liveFps.has(t.fingerprint)) continue;
      insertTxn.run(mapImport(t.import_id), accountId.get(t.account_id), t.txn_date, t.raw_description, t.merchant, t.amount_cents, t.kind,
        mapCat(t.category_id) ?? catId.get('Uncategorized'), t.category_source, t.bank_category, t.fingerprint, t.direction, t.bank_kind,
        t.kind_source, t.transfer_via, t.counterparty_account_id ? accountId.get(t.counterparty_account_id) ?? null : null,
        mapPerson(t.person_id), t.person_source, t.is_one_time, t.reviewed);
      added++;
    }

    if (opts.removeLocalOnly) {
      const otherFps = new Set((other.prepare('SELECT fingerprint FROM transactions').all() as { fingerprint: string }[]).map(r => r.fingerprint));
      const del = live.prepare('DELETE FROM transactions WHERE fingerprint = ?');
      for (const fp of liveFps) if (!otherFps.has(fp)) { del.run(fp); removed++; }
      live.exec('DELETE FROM imports WHERE id NOT IN (SELECT DISTINCT import_id FROM transactions)');
    }

    // Transaction edits: take one-sided edits, apply choices where both sides changed the same field
    const mineDecisions = new Map((live.prepare('SELECT * FROM decisions').all() as DecisionRow[]).map(d => [d.fingerprint, d]));
    for (const theirs of other.prepare('SELECT * FROM decisions').all() as DecisionRow[]) {
      const mine = mineDecisions.get(theirs.fingerprint);
      const mapped: Record<string, unknown> = {
        category_id: mapCat(theirs.category_id), person_id: mapPerson(theirs.person_id), kind: theirs.kind, is_one_time: theirs.is_one_time,
      };
      if (!mine) {
        live.prepare(`INSERT INTO decisions (fingerprint, kind, category_id, person_id, is_one_time, reviewed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(theirs.fingerprint, mapped.kind, mapped.category_id, mapped.person_id, mapped.is_one_time, theirs.reviewed, theirs.updated_at);
        continue;
      }
      const next: Record<string, unknown> = {};
      let tookTheirs = false;
      for (const f of DECISION_FIELDS) {
        const mv = (mine as any)[f.col];
        const tv = mapped[f.col];
        if (tv === null || tv === undefined) continue;
        if (mv === null || mv === undefined || (mv !== tv && pick(`d:${theirs.fingerprint}:${f.col}`) === 'theirs')) {
          next[f.col] = tv;
          tookTheirs = true;
        }
      }
      if (theirs.reviewed && !mine.reviewed) next.reviewed = 1;
      const cols = Object.keys(next);
      if (cols.length) {
        const stamp = tookTheirs && theirs.updated_at > mine.updated_at ? theirs.updated_at : mine.updated_at;
        live.prepare(`UPDATE decisions SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE fingerprint = ?`)
          .run(...cols.map(c => next[c]), stamp, theirs.fingerprint);
      }
    }

    // Rules
    for (const r of other.prepare("SELECT pattern, category_id, priority FROM rules WHERE source = 'user'").all() as { pattern: string; category_id: number; priority: number }[]) {
      const mine = live.prepare("SELECT id FROM rules WHERE source = 'user' AND pattern = ?").get(r.pattern) as { id: number } | undefined;
      const cat = mapCat(r.category_id);
      if (!cat) continue;
      if (!mine) live.prepare("INSERT INTO rules (pattern, category_id, priority, source) VALUES (?, ?, ?, 'user')").run(r.pattern, cat, r.priority);
      else if (pick(`r:${r.pattern}`) === 'theirs') live.prepare('UPDATE rules SET category_id = ? WHERE id = ?').run(cat, mine.id);
    }
    for (const r of other.prepare('SELECT pattern, person_id FROM person_rules').all() as { pattern: string; person_id: number }[]) {
      const person = mapPerson(r.person_id);
      if (!person) continue;
      const mine = live.prepare('SELECT id FROM person_rules WHERE pattern = ?').get(r.pattern) as { id: number } | undefined;
      if (!mine) live.prepare('INSERT INTO person_rules (pattern, person_id) VALUES (?, ?)').run(r.pattern, person);
      else if (pick(`pr:${r.pattern}`) === 'theirs') live.prepare('UPDATE person_rules SET person_id = ? WHERE id = ?').run(person, mine.id);
    }

    // Links the user made by hand, rows they said aren't a pair, and "not household" names
    const idByFp = live.prepare('SELECT id FROM transactions WHERE fingerprint = ?');
    for (const link of other.prepare(`SELECT o.fingerprint AS outFp, i.fingerprint AS inFp, l.created_at FROM transfer_links l
        JOIN transactions o ON o.id = l.out_txn_id JOIN transactions i ON i.id = l.in_txn_id WHERE l.method = 'manual'`).all() as { outFp: string; inFp: string; created_at: string }[]) {
      const out = idByFp.get(link.outFp) as { id: number } | undefined;
      const inn = idByFp.get(link.inFp) as { id: number } | undefined;
      if (!out || !inn) continue;
      const existing = live.prepare('SELECT method FROM transfer_links WHERE out_txn_id IN (?, ?) OR in_txn_id IN (?, ?)').all(out.id, inn.id, out.id, inn.id) as { method: string }[];
      if (existing.some(e => e.method === 'manual')) continue;
      live.prepare('DELETE FROM transfer_links WHERE out_txn_id IN (?, ?) OR in_txn_id IN (?, ?)').run(out.id, inn.id, out.id, inn.id);
      live.prepare("INSERT INTO transfer_links (out_txn_id, in_txn_id, method, created_at) VALUES (?, ?, 'manual', ?)").run(out.id, inn.id, link.created_at);
    }
    for (const np of other.prepare('SELECT out_fingerprint, in_fingerprint FROM not_pairs').all() as { out_fingerprint: string; in_fingerprint: string }[]) {
      live.prepare('INSERT OR IGNORE INTO not_pairs (out_fingerprint, in_fingerprint) VALUES (?, ?)').run(np.out_fingerprint, np.in_fingerprint);
    }
    const notHousehold = new Set([...parseList(getSetting(live, 'p2p_not_household', '[]')), ...parseList(getSetting(other as unknown as Db, 'p2p_not_household', '[]'))]);
    setSetting(live, 'p2p_not_household', JSON.stringify([...notHousehold]));
  })();

  applyDecisions(live);
  recompute(live);
  return { added, removed };
}
