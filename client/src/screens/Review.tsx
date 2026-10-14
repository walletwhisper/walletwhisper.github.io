import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api';
import type { ReviewItem, ReviewTxn } from '../api';
import { useFetch, useStore } from '../store';
import { formatCents } from '../lib';
import { Button, Card, Empty, inputClass } from '../ui';

export function Review() {
  const { data } = useFetch<{ items: ReviewItem[] }>('/api/review');

  if (!data) return <Card><Empty>Loading…</Empty></Card>;
  const groups: { type: ReviewItem['type']; title: string; hint: string }[] = [
    { type: 'unmatched_transfer', title: 'Transfers we couldn’t match', hint: 'Tell us which of your accounts this money moved to or from. You answer once per kind of payment.' },
    { type: 'ambiguous_pair', title: 'Which one is the other side?', hint: 'Several rows could be the matching side of these transfers.' },
    { type: 'p2p_name', title: 'Person-to-person payments', hint: 'Money between household members is not spending or income.' },
  ];

  return (
    <div className="space-y-6">
      {data.items.length === 0 ? (
        <Card>
          <div className="text-center py-10">
            <CheckCircle2 className="w-10 h-10 text-good mx-auto" />
            <p className="mt-3 text-ink font-medium">Nothing to review</p>
            <p className="text-xs text-muted mt-1">Every transfer is matched or explained, so nothing is counted twice.</p>
          </div>
        </Card>
      ) : groups.map(g => {
        const items = data.items.filter(i => i.type === g.type);
        if (items.length === 0) return null;
        return (
          <Card key={g.type} title={`${g.title} (${items.length})`} subtitle={g.hint}>
            <div className="space-y-3">
              {items.map(item => <ReviewCard key={item.key} item={item} />)}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function TxnLines({ txns, limit = 4 }: { txns: ReviewTxn[]; limit?: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? txns : txns.slice(0, limit);
  return (
    <div className="mt-2">
      <ul className="space-y-1 text-[11px] font-mono text-muted">
        {shown.map(t => (
          <li key={t.id} className="flex gap-3">
            <span>{t.date}</span><span className="text-muted">{t.account}</span>
            <span className="truncate flex-1">{t.description}</span>
            <span className="text-ink">{t.direction === 'in' ? '+' : '−'}{formatCents(t.amountCents)}</span>
          </li>
        ))}
      </ul>
      {txns.length > limit && (
        <button className="mt-1 text-[11px] text-accent flex items-center gap-1 cursor-pointer" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {open ? 'Show fewer' : `Show all ${txns.length}`}
        </button>
      )}
    </div>
  );
}

function ReviewCard({ item }: { item: ReviewItem }) {
  const { accounts, people, refresh, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const ids = item.txns.map(t => t.id);

  const answer = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.post('/api/review/answer', body);
      refresh();
    } catch (e: any) { toast(e.message); setBusy(false); }
  };

  return (
    <div className="rounded-lg border border-line bg-page p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-ink">{item.title}</p>
        <p className="text-xs font-mono text-ink-2">{formatCents(item.totalCents)}</p>
      </div>
      <p className="text-xs text-muted mt-1">{item.detail}</p>
      <TxnLines txns={item.txns} />

      <div className="mt-3 pt-3 border-t border-line">
        {item.type === 'unmatched_transfer' && <AssignAccount item={item} busy={busy} onAnswer={answer} accounts={accounts} />}
        {item.type === 'unmatched_transfer' && (
          <div className="flex flex-wrap gap-2 mt-2">
            <Button disabled={busy} onClick={() => answer({ action: 'set_kind', txnIds: ids, kind: item.direction === 'in' ? 'income' : 'spend' })}>
              {item.direction === 'in' ? 'It’s income' : 'It’s actually spending'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => answer({ action: 'keep_transfer', txnIds: ids })}>
              It’s a transfer, I don’t need to say where
            </Button>
          </div>
        )}

        {item.type === 'ambiguous_pair' && (
          <div className="space-y-1.5">
            {item.candidates?.map(c => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-ink-2 font-mono">{c.date} · {c.account} · {c.description}</span>
                <Button disabled={busy} onClick={() => answer({ action: 'link', outId: item.txns[0].id, inId: c.id })}>This one</Button>
              </div>
            ))}
            <Button variant="ghost" disabled={busy} onClick={() => answer({ action: 'keep_transfer', txnIds: ids })}>None of these</Button>
          </div>
        )}

        {item.type === 'p2p_name' && <Household item={item} busy={busy} onAnswer={answer} people={people} />}

      </div>
    </div>
  );
}

function AssignAccount({ item, busy, onAnswer, accounts }: {
  item: ReviewItem; busy: boolean; onAnswer: (b: Record<string, unknown>) => void; accounts: ReturnType<typeof useStore>['accounts'];
}) {
  const [pattern, setPattern] = useState(item.suggestedPattern ?? '');
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('savings');
  const [policy, setPolicy] = useState('will_import');

  const submit = () => onAnswer({
    action: 'assign_account', txnIds: item.txns.map(t => t.id), pattern,
    ...(target === 'new' ? { newAccount: { nickname: name, accountType: type, cardPolicy: policy } } : { accountId: Number(target) }),
  });

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-2">{item.direction === 'in' ? 'Came from' : 'Went to'}</span>
        <select className={inputClass} value={target} onChange={e => setTarget(e.target.value)}>
          <option value="">Choose one of our accounts…</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.label}{a.isTracked ? '' : ' (not imported)'}</option>)}
          <option value="new">+ An account we don’t import…</option>
        </select>
        <span className="text-muted">matching descriptions containing</span>
        <input className={`${inputClass} w-64`} value={pattern} onChange={e => setPattern(e.target.value)} />
      </div>
      {target === 'new' && (
        <div className="flex flex-wrap items-center gap-2 pl-4">
          <input className={`${inputClass} w-48`} placeholder="Name, e.g. Ally Savings" value={name} onChange={e => setName(e.target.value)} />
          <select className={inputClass} value={type} onChange={e => setType(e.target.value)}>
            <option value="savings">Savings</option>
            <option value="checking">Checking at another bank</option>
            <option value="brokerage">Brokerage / retirement</option>
            <option value="credit">Credit card</option>
            <option value="other">Other</option>
          </select>
          {type === 'credit' && (
            <select className={inputClass} value={policy} onChange={e => setPolicy(e.target.value)}>
              <option value="will_import">I’ll import this card later (don’t count payments)</option>
              <option value="payments_are_spending">I won’t import it: count payments as spending</option>
            </select>
          )}
        </div>
      )}
      <Button variant="primary" disabled={busy || !target || pattern.trim().length < 4 || (target === 'new' && !name.trim())} onClick={submit}>
        Save
      </Button>
    </div>
  );
}

function Household({ item, busy, onAnswer, people }: {
  item: ReviewItem; busy: boolean; onAnswer: (b: Record<string, unknown>) => void; people: ReturnType<typeof useStore>['people'];
}) {
  const [personId, setPersonId] = useState('');
  const [newName, setNewName] = useState('');
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-ink-2">Yes, it’s</span>
      <select className={inputClass} value={personId} onChange={e => setPersonId(e.target.value)}>
        <option value="">Choose…</option>
        {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        <option value="new">+ Someone new</option>
      </select>
      {personId === 'new' && <input className={`${inputClass} w-36`} placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)} />}
      <Button variant="primary" disabled={busy || !personId || (personId === 'new' && !newName.trim())}
        onClick={() => onAnswer({ action: 'household', txnIds: item.txns.map(t => t.id), name: item.name,
          ...(personId === 'new' ? { newPersonName: newName } : { personId: Number(personId) }) })}>
        Save
      </Button>
      <Button disabled={busy} onClick={() => onAnswer({ action: 'not_household', name: item.name })}>No, someone else</Button>
    </div>
  );
}
