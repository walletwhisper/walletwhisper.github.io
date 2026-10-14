import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Eye, EyeOff, ListFilter, Search, X, Link2, Sparkles, Users } from 'lucide-react';
import { api, qs } from '../api';
import type { Settings, Summary, Txn, TxnList } from '../api';
import { useFetch, useStore } from '../store';
import { PRESETS, formatCents, monthEnd, monthLabel, presetRange, useRoute } from '../lib';
import { Button, Card, Chip, Empty, Modal, Segmented, inputClass } from '../ui';
import { FilterMenu } from '../FilterMenu';

const KIND_TABS = [
  { id: 'spending', label: 'Spending' },
  { id: 'transfer', label: 'Transfers' },
  { id: 'income', label: 'Income' },
  { id: 'all', label: 'All' },
];

type SortColumn = 'date' | 'merchant' | 'account' | 'person' | 'category' | 'amount';
/** First click: newest / largest first for date and amount, A→Z for names (same as the server). */
const DEFAULT_DIR: Record<SortColumn, 'asc' | 'desc'> = {
  date: 'desc', amount: 'desc', merchant: 'asc', account: 'asc', person: 'asc', category: 'asc',
};

type FilterColumn = 'merchant' | 'account' | 'person' | 'category';
/** Address-bar parameter holding each column filter (merchant names are JSON; ids are comma lists) */
const FILTER_PARAM: Record<FilterColumn, string> = { merchant: 'merch', account: 'acct', person: 'person', category: 'cat' };

function readFilter(params: Record<string, string>, col: FilterColumn): string[] | null {
  const raw = params[FILTER_PARAM[col]];
  if (!raw) return null;
  if (col !== 'merchant') return raw.split(',').filter(Boolean);
  try { const list = JSON.parse(raw); return Array.isArray(list) ? list.map(String) : null; } catch { return null; }
}

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
  const aiReady = useFetch<Settings>('/api/settings').data?.aiConfigured ?? false;
  const latest = summary.data?.dataRange.max ?? null;
  const set = (patch: Record<string, string>) => navigate('transactions', { ...params, ...patch });

  const preset = params.preset || 'all';
  const range = params.from && params.to ? { from: params.from, to: params.to }
    : params.month ? { from: `${params.month}-01`, to: monthEnd(params.month) } : presetRange(preset, latest);
  const kind = params.kind || 'spending';
  const [search, setSearch] = useState(params.q || '');
  useEffect(() => setSearch(params.q || ''), [params.q]);
  useEffect(() => {
    const t = window.setTimeout(() => { if ((params.q || '') !== search) set({ q: search }); }, 350);
    return () => window.clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = {
    ...range, kind, categoryIds: params.cat, personIds: params.person, accountIds: params.acct, merchants: params.merch,
    q: params.q, hidden: params.hidden,
  };
  const { data } = useFetch<TxnList>(`/api/transactions${qs({ ...query, sort: params.sort, dir: params.dir })}`);

  // Excel-style column filters: click the funnel (or right-click the header), search, tick, OK
  const [openFilter, setOpenFilter] = useState<{ col: FilterColumn; anchor: DOMRect } | null>(null);
  const applyFilter = (col: FilterColumn, values: string[] | null) => {
    const value = values === null ? '' : col === 'merchant' ? JSON.stringify(values) : values.join(',');
    set({ [FILTER_PARAM[col]]: value });
    setOpenFilter(null);
  };
  const filters = {
    merchant: readFilter(params, 'merchant'),
    account: readFilter(params, 'account'),
    person: readFilter(params, 'person'),
    category: readFilter(params, 'category'),
  };
  const nameOf = (col: FilterColumn, v: string) =>
    col === 'merchant' ? v
    : col === 'category' ? categories.find(c => String(c.id) === v)?.name ?? '?'
    : col === 'person' ? (v === 'none' ? 'Unassigned' : people.find(p => String(p.id) === v)?.name ?? '?')
    : accounts.find(a => String(a.id) === v)?.label ?? '?';
  const chipText = (col: FilterColumn, list: string[], plural: string) =>
    list.length <= 2 ? list.map(v => nameOf(col, v)).join(', ') : `${list.length} ${plural}`;

  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => setSelected(new Set()), [data]);
  const [editing, setEditing] = useState<Txn | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const rows = data?.transactions ?? [];
  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id));
  const selectedSum = useMemo(() => rows.filter(r => selected.has(r.id)).reduce((a, r) => a + r.amountCents, 0), [rows, selected]);


  const setPerson = async (ids: number[], personId: number | null) => {
    try {
      if (ids.length === 1) await api.patch(`/api/transactions/${ids[0]}`, { personId });
      else await api.patch('/api/transactions', { ids, personId });
      refresh();
    } catch (e: any) { toast(e.message); }
  };
  // Click a column header to sort by it; click again to reverse
  const sortCol = (params.sort as SortColumn) || 'date';
  const sortDir = (params.dir as 'asc' | 'desc') || DEFAULT_DIR[sortCol];
  const sortBy = (col: SortColumn) => {
    if (col === sortCol) set({ sort: col === 'date' ? '' : col, dir: sortDir === 'asc' ? 'desc' : 'asc' });
    else set({ sort: col === 'date' ? '' : col, dir: '' });
  };
  const header = (col: SortColumn, label: string, align: 'left' | 'right' = 'left') => {
    const active = col === sortCol;
    const filterCol = (['merchant', 'account', 'person', 'category'] as string[]).includes(col) ? col as FilterColumn : null;
    const filtered = filterCol ? filters[filterCol] !== null : false;
    const open = (el: Element) => filterCol && setOpenFilter({ col: filterCol, anchor: el.closest('th')!.getBoundingClientRect() });
    const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
    const hint = col === 'date' ? (sortDir === 'desc' && active ? 'oldest first' : 'newest first')
      : col === 'amount' ? (sortDir === 'desc' && active ? 'smallest first' : 'largest first')
      : (sortDir === 'asc' && active ? 'Z to A' : 'A to Z');
    return (
      <th className={`px-3 py-3 whitespace-nowrap ${align === 'right' ? 'text-right' : ''}`} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
        onContextMenu={e => { if (filterCol) { e.preventDefault(); open(e.currentTarget); } }}>
        <button onClick={() => sortBy(col)} title={`Sort by ${label.toLowerCase()}: ${hint}`}
          className={`inline-flex items-center gap-1 uppercase tracking-wider cursor-pointer hover:text-ink ${active ? 'text-ink font-semibold' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}>
          {label}
          <Icon className={`w-3 h-3 ${active ? 'text-accent' : 'opacity-40'}`} />
        </button>
        {filterCol && (
          <button onClick={e => open(e.currentTarget)} aria-label={`Filter ${label.toLowerCase()}`}
            title={filtered ? `Filtered: click to change` : `Filter ${label.toLowerCase()} (or right-click the header)`}
            className={`ml-1.5 align-middle p-0.5 rounded cursor-pointer ${filtered ? 'bg-accent text-white' : 'opacity-40 hover:opacity-100 hover:bg-fill'}`}>
            <ListFilter className="w-3 h-3" />
          </button>
        )}
      </th>
    );
  };

  const setHidden = async (ids: number[], hidden: boolean) => {
    try {
      await api.patch('/api/transactions', { ids, hidden });
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
    if (!aiReady) {
      toast('AI is optional. To turn it on, add your own AI API key here in Settings.');
      navigate('settings');
      return;
    }
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
          <Segmented options={KIND_TABS} value={kind} onChange={id => set({ kind: id === 'spending' ? '' : id })} />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select className={inputClass} value={params.month || params.from ? '' : preset} onChange={e => set({ preset: e.target.value, month: '', from: '', to: '' })}>
              {params.month && <option value="">{monthLabel(params.month)}</option>}
              {params.from && !params.month && <option value="">{params.from} – {params.to}</option>}
              {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-muted absolute left-2.5 top-2" />
              <input className={`${inputClass} pl-8 w-44`} placeholder="Search merchant…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <Button onClick={runAi} disabled={aiBusy} title={aiReady
              ? 'Sends cleaned merchant descriptions, amounts, account type and bank category to your AI provider. Never account numbers, balances, dates or names.'
              : 'Optional: add your own AI API key in Settings to use this'}>
              <Sparkles className={`w-3.5 h-3.5 ${aiBusy ? 'animate-spin' : ''}`} /> AI categorize
            </Button>
          </div>
        </div>

        {(params.month || params.from || Object.values(filters).some(Boolean) || params.q || params.hidden) && (
          <div className="flex flex-wrap gap-2 mt-3">
            {params.month && <Chip onClear={() => set({ month: '' })}>{monthLabel(params.month)}</Chip>}
            {params.from && !params.month && <Chip onClear={() => set({ from: '', to: '' })}>{params.from} – {params.to}</Chip>}
            {params.hidden && <Chip onClear={() => set({ hidden: '' })}>Hidden from charts</Chip>}
            {filters.merchant && <Chip onClear={() => applyFilter('merchant', null)}>Merchant: {chipText('merchant', filters.merchant, 'merchants')}</Chip>}
            {filters.account && <Chip onClear={() => applyFilter('account', null)}>Account: {chipText('account', filters.account, 'accounts')}</Chip>}
            {filters.person && <Chip onClear={() => applyFilter('person', null)}>Person: {chipText('person', filters.person, 'people')}</Chip>}
            {filters.category && <Chip onClear={() => applyFilter('category', null)}>Category: {chipText('category', filters.category, 'categories')}</Chip>}
            {params.q && <Chip onClear={() => set({ q: '' })}>"{params.q}"</Chip>}
          </div>
        )}
      </Card>

      {selected.size > 0 && (
        <div className="sticky top-[72px] z-30 bg-white/90 border border-accent/25 rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-3 text-xs shadow-lg">
          <span className="text-brand font-medium">{selected.size} selected · {formatCents(selectedSum)}</span>
          <span className="flex items-center gap-1.5 text-brand"><Users className="w-3.5 h-3.5" /> Assign to</span>
          <select className={inputClass} value="" onChange={e => e.target.value && setPerson([...selected], e.target.value === 'none' ? null : Number(e.target.value))}>
            <option value="">Choose person…</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="none">Nobody (clear)</option>
          </select>
          <span className="text-brand">Category</span>
          <select className={inputClass} value="" onChange={e => e.target.value && setCategory([...selected], Number(e.target.value))}>
            <option value="">Choose category…</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {kind === 'spending' && (
            <>
              <Button onClick={() => setHidden([...selected], true)}><EyeOff className="w-3.5 h-3.5" /> Hide from charts</Button>
              <Button onClick={() => setHidden([...selected], false)}><Eye className="w-3.5 h-3.5" /> Show in charts</Button>
            </>
          )}
          {people.length === 0 && <span className="text-warn">Add people on the Accounts screen first.</span>}
          <Button variant="ghost" onClick={() => setSelected(new Set())}><X className="w-3.5 h-3.5" /> Clear</Button>
        </div>
      )}

      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-ink-2">
            <thead className="bg-page text-muted uppercase tracking-wider border-b border-line">
              <tr>
                <th className="pl-4 pr-1 py-3 w-8">
                  <input type="checkbox" aria-label="Select all shown" title="Select every transaction shown (use the column filters first to narrow it down)" checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(r => r.id)))} />
                </th>
                {header('date', 'Date')}
                {header('merchant', 'Merchant')}
                {header('account', 'Account')}
                {header('person', 'Person')}
                {header('category', 'Category')}
                {header('amount', 'Amount', 'right')}
                {kind === 'spending' && <th className="px-3 py-3 text-center" title="Untick to leave a transaction out of every chart and total">In charts</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map(t => (
                <tr key={t.id} className={`hover:bg-fill/60 ${selected.has(t.id) ? 'bg-accent/5' : ''} ${t.hidden ? 'text-muted' : ''}`}>
                  <td className="pl-4 pr-1 py-2.5">
                    <input type="checkbox" aria-label={`Select ${t.merchant}`} checked={selected.has(t.id)} onChange={() => {
                      const next = new Set(selected);
                      if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
                      setSelected(next);
                    }} />
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap font-mono text-muted">{t.date}</td>
                  <td className="px-3 py-2.5 max-w-xs">
                    <button className="text-left cursor-pointer group" onClick={() => setEditing(t)}>
                      <div className="font-medium text-ink group-hover:text-accent">{t.merchant}</div>
                      <div className="text-[11px] text-muted truncate max-w-xs">{t.rawDescription}</div>
                      {t.kind === 'transfer' && (
                        <div className="text-[11px] text-brand flex items-center gap-1 mt-0.5">
                          <Link2 className="w-3 h-3" />
                          {t.transferVia === 'pair' || t.linkId ? `${VIA_LABEL.pair} ${t.counterparty ?? ''} ${t.partnerDate ?? ''}`
                            : t.counterparty ? `${VIA_LABEL.account}: ${t.counterparty}` : VIA_LABEL[t.transferVia ?? 'manual']}
                        </div>
                      )}
                      {t.hidden && <span className="text-[10px] uppercase tracking-wide text-muted">Hidden from charts</span>}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-muted">{t.account}</td>
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
                    {t.categorySource === 'manual' && <span className="ml-1 text-[10px] text-muted">edited</span>}
                    {t.categorySource === 'ai' && <span className="ml-1 text-[10px] text-[#5856D6]">AI</span>}
                  </td>
                  <td className={`px-3 py-2.5 whitespace-nowrap text-right font-mono font-medium ${t.hidden ? 'text-muted line-through' : amountTone(t)}`}>
                    {t.kind === 'refund' ? `−${formatCents(Math.abs(t.amountCents))}` : formatCents(t.amountCents)}
                  </td>
                  {kind === 'spending' && (
                    <td className="px-3 py-2.5 text-center">
                      <input type="checkbox" checked={!t.hidden} onChange={e => setHidden([t.id], !e.target.checked)}
                        aria-label={`Show ${t.merchant} in charts`} title={t.hidden ? 'Hidden from charts: tick to include it again' : 'Untick to leave this out of charts and totals'} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {data && rows.length === 0 && <Empty>No matching transactions.</Empty>}
        </div>
        {data && (
          <div className="border-t border-line px-4 py-3 flex justify-between text-xs text-muted">
            <span>
              {data.count} transactions{data.truncated ? ` (showing the first ${rows.length})` : ''}
              {data.hiddenCount > 0 && !params.hidden && (
                <> · <button className="text-accent hover:underline cursor-pointer" onClick={() => set({ hidden: '1' })}>
                  {data.hiddenCount} hidden from charts ({formatCents(data.hiddenCents)})
                </button></>
              )}
            </span>
            <span>Total in charts <span className="text-ink font-semibold font-mono">{formatCents(data.sumCents)}</span></span>
          </div>
        )}
      </Card>

      {editing && <EditTxnDialog txn={editing} onClose={() => setEditing(null)} />}
      {openFilter && (
        <FilterMenu
          key={openFilter.col}
          title={{ merchant: 'Merchant', account: 'Account', person: 'Person', category: 'Category' }[openFilter.col]}
          valuesUrl={`/api/transactions/values${qs({ ...query, column: openFilter.col })}`}
          selected={filters[openFilter.col]}
          anchor={openFilter.anchor}
          onApply={values => applyFilter(openFilter.col, values)}
          onClose={() => setOpenFilter(null)} />
      )}
    </div>
  );
}

/** Money in (income, refunds, money arriving) is green; spending is red; transfers stay neutral. */
function amountTone(t: Txn): string {
  if (t.kind === 'income' || t.kind === 'refund' || t.amountCents < 0) return 'text-good';
  if (t.kind === 'spend' || t.kind === 'fee') return 'text-bad';
  return 'text-ink';
}

function EditTxnDialog({ txn, onClose }: { txn: Txn; onClose: () => void }) {
  const { categories, people, refresh, toast } = useStore();
  const [categoryId, setCategoryId] = useState(txn.categoryId);
  const [remember, setRemember] = useState(false);
  const [personId, setPersonId] = useState<number | null>(txn.personId);
  const [rememberPerson, setRememberPerson] = useState(false);
  const [kind, setKind] = useState(txn.kind);
  const [inCharts, setInCharts] = useState(!txn.hidden);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const body: Record<string, unknown> = {};
    if (categoryId !== txn.categoryId || remember) Object.assign(body, { categoryId, remember });
    if (personId !== txn.personId || rememberPerson) Object.assign(body, { personId, rememberPerson });
    if (kind !== txn.kind) body.kind = kind;
    if (inCharts === txn.hidden) body.hidden = !inCharts;
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
          <p className="text-sm font-semibold text-ink">{txn.merchant}</p>
          <p className="text-muted mt-0.5 break-all">{txn.rawDescription}</p>
          <p className="text-muted mt-1">{txn.date} · {txn.account} · {formatCents(txn.amountCents)}</p>
        </div>

        <label className="block">
          <span className="text-muted block mb-1">Category</span>
          <select className={`${inputClass} w-full`} value={categoryId} onChange={e => setCategoryId(Number(e.target.value))}>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-ink-2">
          <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          Always use this category for "{txn.merchant}"
        </label>

        <label className="block">
          <span className="text-muted block mb-1">Person</span>
          <select className={`${inputClass} w-full`} value={personId ?? ''} onChange={e => setPersonId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— Unassigned</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {personId && (
          <label className="flex items-center gap-2 text-ink-2">
            <input type="checkbox" checked={rememberPerson} onChange={e => setRememberPerson(e.target.checked)} />
            Always assign "{txn.merchant}" to this person
          </label>
        )}

        <label className="block">
          <span className="text-muted block mb-1">What kind of money movement is this?</span>
          <select className={`${inputClass} w-full`} value={kind} onChange={e => setKind(e.target.value)}>
            <option value="spend">Spending</option>
            <option value="refund">Refund (reduces spending)</option>
            <option value="fee">Fee</option>
            <option value="income">Income</option>
            <option value="transfer">Transfer between our own accounts (not spending)</option>
          </select>
        </label>

        {(kind === 'spend' || kind === 'fee' || kind === 'refund') && (
          <label className="flex items-center gap-2 text-ink-2">
            <input type="checkbox" checked={inCharts} onChange={e => setInCharts(e.target.checked)} />
            Show in charts and totals (untick for a big one-off, like a house deposit)
          </label>
        )}

        {txn.linkId && (
          <div className="rounded-lg border border-sky/30 bg-sky/10 p-3 text-brand flex items-center justify-between gap-2">
            <span>Matched with {txn.counterparty} on {txn.partnerDate}</span>
            <Button variant="ghost" onClick={unlink}>Not the same money: unlink</Button>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-3 border-t border-line">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={save}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}
