import { useEffect, useMemo, useState } from 'react';
import { Search, X, Link2, Sparkles, Users } from 'lucide-react';
import { api, qs } from '../api';
import type { Summary, Txn, TxnList } from '../api';
import { useFetch, useStore } from '../store';
import { PRESETS, formatCents, monthEnd, monthLabel, presetRange, useRoute } from '../lib';
import { Button, Card, Chip, Empty, Modal, inputClass } from '../ui';

const KIND_TABS = [
  { id: 'spending', label: 'Spending' },
  { id: 'transfer', label: 'Transfers' },
  { id: 'income', label: 'Income' },
  { id: 'all', label: 'All' },
];

const VIA_LABEL: Record<string, string> = {
  pair: 'Matched with',
  account: 'To/from your account',
  household: 'Between household members',
  bank: 'Bank marked as transfer, not matched yet',
  manual: 'Marked by you',
};

export function Transactions() {
  const { params, navigate } = useRoute();
  const { categories, people, accounts, refresh, toast } = useStore();
  const summary = useFetch<Summary>('/api/summary');
  const latest = summary.data?.dataRange.max ?? null;
  const set = (patch: Record<string, string>) => navigate('transactions', { ...params, ...patch });

  const preset = params.preset || 'all';
  const range = params.month ? { from: `${params.month}-01`, to: monthEnd(params.month) } : presetRange(preset, latest);
  const kind = params.kind || 'spending';
  const [search, setSearch] = useState(params.q || '');
  useEffect(() => setSearch(params.q || ''), [params.q]);
  useEffect(() => {
    const t = window.setTimeout(() => { if ((params.q || '') !== search) set({ q: search }); }, 350);
    return () => window.clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data } = useFetch<TxnList>(`/api/transactions${qs({
    ...range, kind, categoryId: params.cat, personId: params.person, accountId: params.acct, q: params.q,
    includeOneTime: params.onetime === '1',
  })}`);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => setSelected(new Set()), [data]);
  const [editing, setEditing] = useState<Txn | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const rows = data?.transactions ?? [];
  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id));
  const selectedSum = useMemo(() => rows.filter(r => selected.has(r.id)).reduce((a, r) => a + r.amountCents, 0), [rows, selected]);

  const cat = categories.find(c => String(c.id) === params.cat);
  const person = params.person === 'none' ? { name: 'Unassigned', color: '#64748B' } : people.find(p => String(p.id) === params.person);
  const acct = accounts.find(a => String(a.id) === params.acct);

  const setPerson = async (ids: number[], personId: number | null) => {
    try {
      if (ids.length === 1) await api.patch(`/api/transactions/${ids[0]}`, { personId });
      else await api.patch('/api/transactions', { ids, personId });
      refresh();
    } catch (e: any) { toast(e.message); }
  };
  const setCategory = async (ids: number[], categoryId: number) => {
    try {
      await api.patch('/api/transactions', { ids, categoryId });
      refresh();
    } catch (e: any) { toast(e.message); }
  };

  const runAi = async () => {
    setAiBusy(true);
    toast('Asking the AI to categorize unclear merchants…');
    try {
      const r = await api.post<{ changed: number; groupsSent: number }>('/api/ai/recategorize');
      toast(`AI updated ${r.changed} transactions (${r.groupsSent} distinct merchants sent). Your own edits and rules were not touched.`);
      refresh();
    } catch (e: any) { toast(`AI error: ${e.message}`); }
    finally { setAiBusy(false); }
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex rounded-lg overflow-hidden border border-slate-600 text-xs">
            {KIND_TABS.map(t => (
              <button key={t.id} onClick={() => set({ kind: t.id === 'spending' ? '' : t.id })}
                className={`px-3 py-1.5 cursor-pointer ${kind === t.id ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select className={inputClass} value={params.month ? '' : preset} onChange={e => set({ preset: e.target.value, month: '' })}>
              {params.month && <option value="">{monthLabel(params.month)}</option>}
              {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <select className={inputClass} value={params.person || ''} onChange={e => set({ person: e.target.value })}>
              <option value="">Everyone</option>
              <option value="none">Unassigned</option>
              {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className={inputClass} value={params.acct || ''} onChange={e => set({ acct: e.target.value })}>
              <option value="">All accounts</option>
              {accounts.filter(a => a.isTracked).map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
              <input className={`${inputClass} pl-8 w-44`} placeholder="Search merchant…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {kind === 'spending' && (
              <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                <input type="checkbox" checked={params.onetime === '1'} onChange={e => set({ onetime: e.target.checked ? '1' : '' })} />
                One-time items
              </label>
            )}
            <Button onClick={runAi} disabled={aiBusy} title="Categorize unclear merchants with your LLM key (only cleaned merchant names are sent)">
              <Sparkles className={`w-3.5 h-3.5 ${aiBusy ? 'animate-spin' : ''}`} /> AI categorize
            </Button>
          </div>
        </div>

        {(params.month || cat || person || acct || params.q) && (
          <div className="flex flex-wrap gap-2 mt-3">
            {params.month && <Chip onClear={() => set({ month: '' })}>{monthLabel(params.month)}</Chip>}
            {cat && <Chip color={cat.color} onClear={() => set({ cat: '' })}>{cat.name}</Chip>}
            {person && <Chip color={person.color} onClear={() => set({ person: '' })}>{person.name}</Chip>}
            {acct && <Chip onClear={() => set({ acct: '' })}>{acct.label}</Chip>}
            {params.q && <Chip onClear={() => set({ q: '' })}>"{params.q}"</Chip>}
          </div>
        )}
      </Card>

      {selected.size > 0 && (
        <div className="sticky top-[72px] z-30 bg-indigo-950/95 border border-indigo-700 rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-3 text-xs shadow-lg">
          <span className="text-indigo-100 font-medium">{selected.size} selected · {formatCents(selectedSum)}</span>
          <span className="flex items-center gap-1.5 text-indigo-200"><Users className="w-3.5 h-3.5" /> Assign to</span>
          <select className={inputClass} value="" onChange={e => e.target.value && setPerson([...selected], e.target.value === 'none' ? null : Number(e.target.value))}>
            <option value="">Choose person…</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="none">Nobody (clear)</option>
          </select>
          <span className="text-indigo-200">Category</span>
          <select className={inputClass} value="" onChange={e => e.target.value && setCategory([...selected], Number(e.target.value))}>
            <option value="">Choose category…</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {people.length === 0 && <span className="text-amber-300">Add people on the Accounts screen first.</span>}
          <Button variant="ghost" onClick={() => setSelected(new Set())}><X className="w-3.5 h-3.5" /> Clear</Button>
        </div>
      )}

      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900/60 text-slate-400 uppercase tracking-wider border-b border-slate-700">
              <tr>
                <th className="pl-4 pr-1 py-3 w-8">
                  <input type="checkbox" aria-label="Select all" checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)))} />
                </th>
                <th className="px-3 py-3">Date</th>
                <th className="px-3 py-3">Merchant</th>
                <th className="px-3 py-3">Account</th>
                <th className="px-3 py-3">Person</th>
                <th className="px-3 py-3">Category</th>
                <th className="px-3 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {rows.map(t => (
                <tr key={t.id} className={`hover:bg-slate-700/30 ${selected.has(t.id) ? 'bg-indigo-900/20' : ''}`}>
                  <td className="pl-4 pr-1 py-2.5">
                    <input type="checkbox" aria-label={`Select ${t.merchant}`} checked={selected.has(t.id)} onChange={() => {
                      const next = new Set(selected);
                      if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
                      setSelected(next);
                    }} />
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap font-mono text-slate-400">{t.date}</td>
                  <td className="px-3 py-2.5 max-w-xs">
                    <button className="text-left cursor-pointer group" onClick={() => setEditing(t)}>
                      <div className="font-medium text-white group-hover:text-indigo-300">{t.merchant}</div>
                      <div className="text-[11px] text-slate-500 truncate max-w-xs">{t.rawDescription}</div>
                      {t.kind === 'transfer' && (
                        <div className="text-[11px] text-sky-300 flex items-center gap-1 mt-0.5">
                          <Link2 className="w-3 h-3" />
                          {t.transferVia === 'pair' || t.linkId ? `${VIA_LABEL.pair} ${t.counterparty ?? ''} ${t.partnerDate ?? ''}`
                            : t.counterparty ? `${VIA_LABEL.account}: ${t.counterparty}` : VIA_LABEL[t.transferVia ?? 'manual']}
                        </div>
                      )}
                      {t.isOneTime && <span className="text-[10px] uppercase tracking-wide text-amber-300">One-time</span>}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-slate-400">{t.account}</td>
                  <td className="px-3 py-2.5">
                    <select className={`${inputClass} py-1`} value={t.personId ?? ''} aria-label="Person"
                      onChange={e => setPerson([t.id], e.target.value ? Number(e.target.value) : null)}
                      style={t.personColor ? { borderColor: t.personColor } : undefined}>
                      <option value="">—</option>
                      {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <button onClick={() => setEditing(t)} className="cursor-pointer inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium"
                      style={{ backgroundColor: `${t.categoryColor}22`, color: t.categoryColor, border: `1px solid ${t.categoryColor}55` }}>
                      {t.categoryName}
                    </button>
                    {t.categorySource === 'manual' && <span className="ml-1 text-[10px] text-slate-500">edited</span>}
                    {t.categorySource === 'ai' && <span className="ml-1 text-[10px] text-purple-300">AI</span>}
                  </td>
                  <td className={`px-3 py-2.5 whitespace-nowrap text-right font-mono font-medium ${t.amountCents < 0 || (kind !== 'spending' && t.direction === 'in') ? 'text-emerald-400' : 'text-slate-100'}`}>
                    {t.kind === 'refund' ? `−${formatCents(Math.abs(t.amountCents))}` : formatCents(t.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && rows.length === 0 && <Empty>No matching transactions.</Empty>}
        </div>
        {data && (
          <div className="border-t border-slate-700 px-4 py-3 flex justify-between text-xs text-slate-400">
            <span>{data.count} transactions{data.truncated ? ` (showing the latest ${rows.length})` : ''}</span>
            <span>Total <span className="text-white font-semibold font-mono">{formatCents(data.sumCents)}</span></span>
          </div>
        )}
      </Card>

      {editing && <EditTxnDialog txn={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EditTxnDialog({ txn, onClose }: { txn: Txn; onClose: () => void }) {
  const { categories, people, refresh, toast } = useStore();
  const [categoryId, setCategoryId] = useState(txn.categoryId);
  const [remember, setRemember] = useState(false);
  const [personId, setPersonId] = useState<number | null>(txn.personId);
  const [rememberPerson, setRememberPerson] = useState(false);
  const [kind, setKind] = useState(txn.kind);
  const [oneTime, setOneTime] = useState(txn.isOneTime);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const body: Record<string, unknown> = {};
    if (categoryId !== txn.categoryId || remember) Object.assign(body, { categoryId, remember });
    if (personId !== txn.personId || rememberPerson) Object.assign(body, { personId, rememberPerson });
    if (kind !== txn.kind) body.kind = kind;
    if (oneTime !== txn.isOneTime) body.isOneTime = oneTime;
    if (Object.keys(body).length === 0) return onClose();
    setBusy(true);
    try {
      await api.patch(`/api/transactions/${txn.id}`, body);
      refresh();
      onClose();
    } catch (e: any) { toast(e.message); setBusy(false); }
  };

  const unlink = async () => {
    if (!txn.linkId) return;
    try {
      await api.del(`/api/transfer-links/${txn.linkId}`);
      toast('Unlinked. These two rows will not be matched again.');
      refresh();
      onClose();
    } catch (e: any) { toast(e.message); }
  };

  return (
    <Modal title="Edit transaction" onClose={onClose}>
      <div className="space-y-4 text-xs">
        <div>
          <p className="text-sm font-semibold text-white">{txn.merchant}</p>
          <p className="text-slate-500 mt-0.5 break-all">{txn.rawDescription}</p>
          <p className="text-slate-400 mt-1">{txn.date} · {txn.account} · {formatCents(txn.amountCents)}</p>
        </div>

        <label className="block">
          <span className="text-slate-400 block mb-1">Category</span>
          <select className={`${inputClass} w-full`} value={categoryId} onChange={e => setCategoryId(Number(e.target.value))}>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-slate-300">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          Always use this category for "{txn.merchant}"
        </label>

        <label className="block">
          <span className="text-slate-400 block mb-1">Person</span>
          <select className={`${inputClass} w-full`} value={personId ?? ''} onChange={e => setPersonId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— Unassigned</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {personId && (
          <label className="flex items-center gap-2 text-slate-300">
            <input type="checkbox" checked={rememberPerson} onChange={e => setRememberPerson(e.target.checked)} />
            Always assign "{txn.merchant}" to this person
          </label>
        )}

        <label className="block">
          <span className="text-slate-400 block mb-1">What kind of money movement is this?</span>
          <select className={`${inputClass} w-full`} value={kind} onChange={e => setKind(e.target.value)}>
            <option value="spend">Spending</option>
            <option value="refund">Refund (reduces spending)</option>
            <option value="fee">Fee</option>
            <option value="income">Income</option>
            <option value="transfer">Transfer between our own accounts (not spending)</option>
          </select>
        </label>

        {(kind === 'spend' || kind === 'fee') && (
          <label className="flex items-center gap-2 text-slate-300">
            <input type="checkbox" checked={oneTime} onChange={e => setOneTime(e.target.checked)} />
            One-time item (keep it out of normal monthly trends)
          </label>
        )}

        {txn.linkId && (
          <div className="rounded-lg border border-sky-800 bg-sky-950/40 p-3 text-sky-200 flex items-center justify-between gap-2">
            <span>Matched with {txn.counterparty} on {txn.partnerDate}</span>
            <Button variant="ghost" onClick={unlink}>Not the same money: unlink</Button>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-700">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={save}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}
