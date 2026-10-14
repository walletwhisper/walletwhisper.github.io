import { useState } from 'react';
import { Trash2, Plus, Undo2 } from 'lucide-react';
import { api } from '../api';
import type { Account, Coverage, ImportRecord, Person } from '../api';
import { useFetch, useStore } from '../store';
import { shortMonth } from '../lib';
import { Button, Card, Dot, Empty, inputClass } from '../ui';

export function Accounts() {
  return (
    <div className="space-y-6">
      <People />
      <ImportedAccounts />
      <UntrackedAccounts />
      <CoverageMap />
      <ImportHistory />
      <Rules />
      <DangerZone />
    </div>
  );
}

function useAction() {
  const { refresh, toast } = useStore();
  return async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
      refresh();
    } catch (e: any) { toast(e.message); }
  };
}

function People() {
  const { people } = useStore();
  const act = useAction();
  const [name, setName] = useState('');
  return (
    <Card title="People" subtitle="Who spends. Mark transactions per person on the Transactions screen. Names as they appear in Zelle/Venmo help recognize money moved between you.">
      <div className="space-y-2">
        {people.map(p => <PersonRow key={p.id} person={p} />)}
        {people.length === 0 && <p className="text-xs text-slate-400">No people yet. Add yourselves, and "Shared" for joint spending.</p>}
      </div>
      <form className="flex gap-2 mt-3" onSubmit={e => { e.preventDefault(); if (name.trim()) act(() => api.post('/api/people', { name }).then(() => setName(''))); }}>
        <input className={`${inputClass} w-48`} placeholder="Name, e.g. Alex or Shared" value={name} onChange={e => setName(e.target.value)} />
        <Button type="submit" disabled={!name.trim()}><Plus className="w-3.5 h-3.5" /> Add person</Button>
      </form>
    </Card>
  );
}

function PersonRow({ person }: { person: Person }) {
  const act = useAction();
  const [aliases, setAliases] = useState(person.aliases.join(', '));
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <input type="color" value={person.color} aria-label={`${person.name} color`} className="w-7 h-7 bg-transparent cursor-pointer"
        onChange={e => act(() => api.patch(`/api/people/${person.id}`, { color: e.target.value }))} />
      <span className="text-white font-medium w-28 truncate">{person.name}</span>
      <span className="text-slate-500 w-24">{person.txnCount} txns</span>
      <span className="text-slate-400">Names in P2P payments:</span>
      <input className={`${inputClass} w-64`} placeholder="e.g. ALEX EXAMPLE, A EXAMPLE" value={aliases} onChange={e => setAliases(e.target.value)}
        onBlur={() => aliases !== person.aliases.join(', ') && act(() => api.patch(`/api/people/${person.id}`, { aliases: aliases.split(',').map(s => s.trim()).filter(Boolean) }))} />
      {confirm ? (
        <>
          <Button variant="danger" onClick={() => act(() => api.del(`/api/people/${person.id}`))}>Remove {person.name}</Button>
          <Button variant="ghost" onClick={() => setConfirm(false)}>Keep</Button>
        </>
      ) : (
        <Button variant="ghost" onClick={() => setConfirm(true)} aria-label={`Remove ${person.name}`}><Trash2 className="w-3.5 h-3.5" /></Button>
      )}
    </div>
  );
}

function ImportedAccounts() {
  const { accounts, people } = useStore();
  const act = useAction();
  const tracked = accounts.filter(a => a.isTracked);
  return (
    <Card title="Accounts you import" subtitle="Each card is identified by the last 4 digits in its export filename.">
      {tracked.length === 0 ? <Empty>No accounts yet. Import a bank CSV to add one.</Empty> : (
        <div className="space-y-2">
          {tracked.map(a => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 text-xs">
              <input className={`${inputClass} w-56`} defaultValue={a.nickname ?? a.label} aria-label="Account name"
                onBlur={e => e.target.value.trim() && e.target.value !== a.nickname && act(() => api.patch(`/api/accounts/${a.id}`, { nickname: e.target.value }))} />
              <span className="text-slate-400 w-40">{a.bank} {a.accountType}{a.last4 ? ` ··${a.last4}` : ''}</span>
              <span className="text-slate-500 w-20">{a.txnCount} txns</span>
              <span className="text-slate-400">Usually spent by</span>
              <select className={inputClass} value={a.defaultPersonId ?? ''}
                onChange={e => act(() => api.patch(`/api/accounts/${a.id}`, { defaultPersonId: e.target.value ? Number(e.target.value) : null }))}>
                <option value="">— nobody in particular</option>
                {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <PatternEditor account={a} hint="Also match payments for months not imported" />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function PatternEditor({ account, hint }: { account: Account; hint?: string }) {
  const act = useAction();
  const [value, setValue] = useState(account.matchPatterns.join(', '));
  return (
    <input className={`${inputClass} w-72`} title={hint} placeholder={hint ?? 'Description contains…'} value={value} onChange={e => setValue(e.target.value)}
      onBlur={() => value !== account.matchPatterns.join(', ') &&
        act(() => api.patch(`/api/accounts/${account.id}`, { matchPatterns: value.split(',').map(s => s.trim()).filter(Boolean) }))} />
  );
}

function UntrackedAccounts() {
  const { accounts } = useStore();
  const act = useAction();
  const untracked = accounts.filter(a => !a.isTracked);
  const [name, setName] = useState('');
  const [type, setType] = useState('savings');
  const [pattern, setPattern] = useState('');
  return (
    <Card title="Our accounts you don't import" subtitle="Money moved to or from these is a transfer, not spending or income. Payments are recognized by description text.">
      <div className="space-y-2">
        {untracked.map(a => (
          <div key={a.id} className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-white font-medium w-44 truncate">{a.label}</span>
            <span className="text-slate-400 w-20">{a.accountType}</span>
            <span className="text-slate-500 w-20">{a.counterpartyCount} matches</span>
            <PatternEditor account={a} />
            {a.accountType === 'credit' && (
              <select className={inputClass} value={a.cardPolicy ?? 'will_import'} onChange={e => act(() => api.patch(`/api/accounts/${a.id}`, { cardPolicy: e.target.value }))}>
                <option value="will_import">Will import later: payments are transfers</option>
                <option value="payments_are_spending">Won't import: payments count as spending</option>
              </select>
            )}
            <Button variant="ghost" aria-label={`Remove ${a.label}`} onClick={() => act(() => api.del(`/api/accounts/${a.id}`))}><Trash2 className="w-3.5 h-3.5" /></Button>
          </div>
        ))}
        {untracked.length === 0 && <p className="text-xs text-slate-400">None yet. The Review screen suggests them when it finds unexplained transfers.</p>}
      </div>
      <form className="flex flex-wrap gap-2 mt-3 text-xs" onSubmit={e => {
        e.preventDefault();
        act(() => api.post('/api/accounts', { nickname: name, accountType: type, matchPatterns: pattern ? [pattern] : [] })
          .then(() => { setName(''); setPattern(''); }));
      }}>
        <input className={`${inputClass} w-44`} placeholder="Name, e.g. Ally Savings" value={name} onChange={e => setName(e.target.value)} />
        <select className={inputClass} value={type} onChange={e => setType(e.target.value)}>
          <option value="savings">Savings</option>
          <option value="checking">Checking</option>
          <option value="brokerage">Brokerage / retirement</option>
          <option value="credit">Credit card</option>
          <option value="other">Other</option>
        </select>
        <input className={`${inputClass} w-56`} placeholder="Description contains, e.g. ALLY BANK" value={pattern} onChange={e => setPattern(e.target.value)} />
        <Button type="submit" disabled={!name.trim()}><Plus className="w-3.5 h-3.5" /> Add account</Button>
      </form>
    </Card>
  );
}

const STATUS_STYLE: Record<string, string> = {
  full: 'bg-emerald-500/80',
  partial: 'bg-amber-400/80',
  missing: 'bg-rose-500/80',
  'n/a': 'bg-slate-700/40',
};

function CoverageMap() {
  const { data } = useFetch<Coverage>('/api/coverage');
  if (!data) return null;
  return (
    <Card title="Statement coverage" subtitle="Which months each account has been imported for. Months with gaps are marked incomplete in the charts.">
      {data.accounts.length === 0 ? <Empty>Nothing imported yet.</Empty> : (
        <>
          <div className="overflow-x-auto">
            <table className="text-[10px] text-slate-400">
              <thead>
                <tr>
                  <th className="pr-3" />
                  {data.months.map(m => <th key={m} className="px-0.5 font-normal whitespace-nowrap [writing-mode:vertical-rl] rotate-180 h-12">{shortMonth(m)}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.accounts.map(a => (
                  <tr key={a.id}>
                    <td className="pr-3 py-1 text-xs text-slate-200 whitespace-nowrap">
                      {a.name}{!a.tracked && <span className="text-slate-500"> (not imported)</span>}
                    </td>
                    {data.months.map(m => (
                      <td key={m} className="px-0.5 py-1">
                        <div className={`w-4 h-4 rounded-sm ${STATUS_STYLE[a.months[m] ?? 'n/a']}`} title={`${a.name} · ${shortMonth(m)}: ${a.months[m] ?? 'n/a'}`} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-4 mt-3 text-xs text-slate-400">
            <span className="flex items-center gap-1.5"><span className={`w-3 h-3 rounded-sm ${STATUS_STYLE.full}`} /> Imported</span>
            <span className="flex items-center gap-1.5"><span className={`w-3 h-3 rounded-sm ${STATUS_STYLE.partial}`} /> Part of the month</span>
            <span className="flex items-center gap-1.5"><span className={`w-3 h-3 rounded-sm ${STATUS_STYLE.missing}`} /> Missing (we see payments to it)</span>
          </div>
          {data.accounts.some(a => a.gapMonths.length > 0) && (
            <ul className="mt-3 space-y-1 text-xs text-amber-200">
              {data.accounts.filter(a => a.gapMonths.length > 0).map(a => (
                <li key={a.id}>{a.name}: {a.gapMonths.length} month{a.gapMonths.length > 1 ? 's' : ''} missing or partial ({a.gapMonths.slice(0, 4).map(shortMonth).join(', ')}{a.gapMonths.length > 4 ? '…' : ''})</li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}

function ImportHistory() {
  const { data } = useFetch<{ imports: ImportRecord[] }>('/api/imports');
  const act = useAction();
  const [confirmId, setConfirmId] = useState<number | null>(null);
  if (!data) return null;
  return (
    <Card title="Import history" subtitle="Undo removes exactly that file's rows (a backup is taken first). Your answers come back if you import it again.">
      {data.imports.length === 0 ? <Empty>No imports yet.</Empty> : (
        <ul className="divide-y divide-slate-700/60">
          {data.imports.map(i => (
            <li key={i.id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div>
                <p className="text-white">{i.filename}</p>
                <p className="text-slate-400">{i.account} · {i.minDate} → {i.maxDate} · {i.rowsAdded} added, {i.rowsSkipped} skipped · imported {i.importedAt.slice(0, 10)}</p>
              </div>
              {confirmId === i.id ? (
                <span className="flex gap-2">
                  <Button variant="danger" onClick={() => act(() => api.del(`/api/imports/${i.id}`), `Removed ${i.filename}`).then(() => setConfirmId(null))}>Remove {i.rowsAdded} rows</Button>
                  <Button variant="ghost" onClick={() => setConfirmId(null)}>Cancel</Button>
                </span>
              ) : (
                <Button variant="ghost" onClick={() => setConfirmId(i.id)}><Undo2 className="w-3.5 h-3.5" /> Undo</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Rules() {
  const { data } = useFetch<{ category: { id: number; pattern: string; target: string }[]; person: { id: number; pattern: string; target: string }[] }>('/api/rules');
  const act = useAction();
  if (!data || (data.category.length === 0 && data.person.length === 0)) return null;
  return (
    <Card title="Remembered choices" subtitle='Created by "always use this for…" checkboxes.'>
      <ul className="space-y-1 text-xs">
        {data.category.map(r => (
          <li key={`c${r.id}`} className="flex items-center gap-2">
            <span className="text-slate-200">"{r.pattern}"</span><span className="text-slate-500">→ category</span><span className="text-white">{r.target}</span>
            <Button variant="ghost" aria-label="Delete rule" onClick={() => act(() => api.del(`/api/rules/${r.id}`))}><Trash2 className="w-3.5 h-3.5" /></Button>
          </li>
        ))}
        {data.person.map(r => (
          <li key={`p${r.id}`} className="flex items-center gap-2">
            <span className="text-slate-200">"{r.pattern}"</span><span className="text-slate-500">→ person</span>
            <span className="text-white flex items-center gap-1"><Dot color="#6366F1" />{r.target}</span>
            <Button variant="ghost" aria-label="Delete rule" onClick={() => act(() => api.del(`/api/person-rules/${r.id}`))}><Trash2 className="w-3.5 h-3.5" /></Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DangerZone() {
  const act = useAction();
  const [text, setText] = useState('');
  return (
    <Card title="Reset all data" subtitle="Deletes all transactions, imports, accounts and remembered choices. A backup is saved in data/backups first.">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-300">Type <b className="text-white">DELETE ALL</b> to confirm:</span>
        <input className={`${inputClass} w-36`} value={text} onChange={e => setText(e.target.value)} />
        <Button variant="danger" disabled={text !== 'DELETE ALL'}
          onClick={() => act(() => api.post<{ backup: string }>('/api/reset', { confirm: text }).then(r => { setText(''); return r; }), 'All data reset. A backup was saved first.')}>
          Reset
        </Button>
      </div>
    </Card>
  );
}
