import { useState } from 'react';
import type { FormEvent } from 'react';
import { BarChart, Bar, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowDownRight, ArrowUpRight, Lock, MessageCircleQuestion, Minus, X } from 'lucide-react';
import { api } from './api';
import type { AskAnswer, PeriodTotal, Settings } from './api';
import { useFetch } from './store';
import { formatCents, monthLabel, shortMoney, shortMonth, useRoute } from './lib';
import { Button, Dot, inputClass, tooltipClass } from './ui';

const EXAMPLES = [
  'How much did we spend on dining last month?',
  'Groceries this year',
  'What did we spend at Amazon in September?',
];

const MUTED_BAR = '#c7c7cc';

/** "Ask about your spending": the question goes to the AI only to be understood; numbers are computed locally. */
export function AskBox() {
  const settings = useFetch<Settings>('/api/settings').data;
  const { navigate } = useRoute();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (q: string) => {
    if (!q.trim()) return;
    setQuestion(q);
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.post<AskAnswer>('/api/ask', { question: q }));
    } catch (e: any) {
      setError(e.message);
      setAnswer(null);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); ask(question); };

  if (!settings) return null;
  const ready = settings.aiConfigured;

  return (
    <section className="bg-surface rounded-card shadow-card p-5">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
        <MessageCircleQuestion className="w-5 h-5 text-accent shrink-0" />
        <input value={question} onChange={e => setQuestion(e.target.value)} disabled={!ready || busy} maxLength={300}
          placeholder={ready ? 'Ask about your spending, e.g. "How much did we spend on dining last month?"' : 'Ask about your spending (turn on AI in Settings first)'}
          className={`${inputClass} flex-1 min-w-60 !text-sm !py-2`} />
        {ready
          ? <Button variant="primary" type="submit" disabled={busy || !question.trim()}>{busy ? 'Thinking…' : 'Ask'}</Button>
          : <Button type="button" onClick={() => navigate('settings')}>Set up AI</Button>}
      </form>

      {ready && !answer && !error && (
        <div className="flex flex-wrap gap-2 mt-3">
          {EXAMPLES.map(x => (
            <button key={x} onClick={() => ask(x)} disabled={busy}
              className="text-xs text-accent bg-accent/8 hover:bg-accent/15 px-3 py-1 rounded-full cursor-pointer disabled:opacity-40">
              {x}
            </button>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted mt-3 flex items-center gap-1.5">
        <Lock className="w-3 h-3" />
        {ready
          ? 'Only your question is sent to your AI provider, to understand it. All numbers are worked out on this computer.'
          : 'AI is optional. Add your own AI key in Settings to ask questions in plain English.'}
      </p>

      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      {answer && <AnswerView answer={answer} onClose={() => setAnswer(null)} />}
    </section>
  );
}

function AnswerView({ answer, onClose }: { answer: AskAnswer; onClose: () => void }) {
  const { navigate } = useRoute();
  if (!answer.understood) {
    return (
      <div className="mt-4 rounded-[10px] bg-page p-4 text-sm text-ink-2 flex justify-between gap-3">
        <span>{answer.clarification}</span>
        <CloseButton onClick={onClose} />
      </div>
    );
  }

  const seeTransactions = () => {
    const p: Record<string, string> = { from: answer.period.from, to: answer.period.to };
    if (answer.filters.categoryIds.length === 1) p.cat = String(answer.filters.categoryIds[0]);
    if (answer.filters.personId !== null) p.person = String(answer.filters.personId);
    if (answer.filters.merchant) p.q = answer.filters.merchant;
    navigate('transactions', p);
  };

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex justify-between gap-3">
        <p className="text-[15px] text-ink leading-relaxed">{answer.headline}</p>
        <CloseButton onClick={onClose} />
      </div>
      {answer.notes.map(n => <p key={n} className="text-xs text-warn mt-1">{n}</p>)}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
        <PeriodTile title="This period" p={answer.period} />
        <PeriodTile title="Period before" p={answer.previous} compareTo={answer.period} />
        <PeriodTile title="Same time last year" p={answer.lastYear} compareTo={answer.period} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 mt-5">
        <div className="lg:col-span-3">
          <p className="text-xs font-medium text-muted mb-2">Last 13 months {answer.subject === 'in total' ? '' : answer.subject}</p>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={answer.months} margin={{ left: 0, right: 0, top: 4 }} barCategoryGap={3}>
                <XAxis dataKey="month" tickFormatter={shortMonth} stroke="#8e8e93" fontSize={10} tickLine={false} axisLine={false} interval={1} />
                <YAxis tickFormatter={shortMoney} stroke="#8e8e93" fontSize={10} width={44} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const m = payload[0].payload as { month: string; cents: number };
                  return (
                    <div className={tooltipClass}>
                      <p className="font-semibold text-ink">{monthLabel(m.month)}</p>
                      <p className="text-ink-2">{formatCents(m.cents)}</p>
                    </div>
                  );
                }} />
                <Bar dataKey="cents" radius={[4, 4, 0, 0]}>
                  {answer.months.map(m => <Cell key={m.month} fill={m.inPeriod ? '#007aff' : MUTED_BAR} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-2 space-y-4">
          {answer.topMerchants.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted mb-2">Where it went</p>
              <ul className="space-y-1.5 text-xs">
                {answer.topMerchants.map(m => (
                  <li key={m.merchant} className="flex justify-between gap-3">
                    <span className="text-ink truncate">{m.merchant} <span className="text-muted">×{m.count}</span></span>
                    <span className="font-mono text-ink-2">{formatCents(m.cents)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {answer.byCategory.length > 1 && (
            <div>
              <p className="text-xs font-medium text-muted mb-2">By category</p>
              <ul className="space-y-1.5 text-xs">
                {answer.byCategory.map(c => (
                  <li key={c.id} className="flex justify-between gap-3">
                    <span className="text-ink flex items-center gap-2"><Dot color={c.color} />{c.name}</span>
                    <span className="font-mono text-ink-2">{formatCents(c.cents)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {answer.period.count > 0 && (
            <Button onClick={seeTransactions}>See the {answer.period.count} transaction{answer.period.count === 1 ? '' : 's'}</Button>
          )}
        </div>
      </div>
    </div>
  );
}

function PeriodTile({ title, p, compareTo }: { title: string; p: PeriodTotal; compareTo?: PeriodTotal }) {
  let change = null;
  if (compareTo && p.count > 0 && p.cents > 0) {
    const diff = compareTo.cents - p.cents;
    const pct = Math.round((Math.abs(diff) / p.cents) * 100);
    const Icon = Math.abs(diff) < 100 ? Minus : diff > 0 ? ArrowUpRight : ArrowDownRight;
    change = (
      <span className="flex items-center gap-1 text-xs text-ink-2">
        <Icon className="w-3.5 h-3.5" />
        {Math.abs(diff) < 100 ? 'About the same now' : `Now ${pct}% ${diff > 0 ? 'higher' : 'lower'}`}
      </span>
    );
  }
  return (
    <div className="rounded-[10px] bg-page p-3.5">
      <div className="text-xs text-muted">{title} · {p.label}</div>
      <div className="text-xl font-bold tracking-tight text-ink mt-0.5">{p.count === 0 ? '—' : formatCents(p.cents)}</div>
      <div className="mt-0.5">{p.count === 0 ? <span className="text-xs text-muted">No spending recorded</span> : change ?? <span className="text-xs text-muted">{p.count} transactions</span>}</div>
    </div>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-muted hover:text-ink cursor-pointer self-start" aria-label="Close answer">
      <X className="w-4 h-4" />
    </button>
  );
}
