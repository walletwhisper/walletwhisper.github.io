import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from 'recharts';
import type { IncomeMonth, Trends as TrendsData } from '../api';
import { qs } from '../api';
import { useFetch, useStore } from '../store';
import { formatCents, monthLabel, shortMoney, shortMonth, useRoute } from '../lib';
import { Card, Chip, Dot, Empty, Segmented, inputClass, tooltipClass } from '../ui';
import { AskBox } from '../AskBox';
import { CashFlow } from '../CashFlow';

const STACKS = [
  { id: 'category', label: 'Category' },
  { id: 'person', label: 'Person' },
  { id: 'account', label: 'Account' },
] as const;

export function Trends() {
  const { params, navigate } = useRoute();
  const { categories, people, accounts } = useStore();
  const stack = (params.stack as 'category' | 'person' | 'account') || 'category';
  const months = params.months || '12';
  const set = (patch: Record<string, string>) => navigate('trends', { ...params, ...patch });

  const { data } = useFetch<TrendsData>(`/api/trends${qs({
    stack, months, categoryId: params.cat, personId: params.person, accountId: params.acct,
  })}`);

  const rows = (data?.months ?? []).map(m => ({ ...m, ...Object.fromEntries(Object.entries(m.segments).map(([k, v]) => [`s${k}`, v])) }));
  const hiddenTotal = (data?.months ?? []).reduce((a, m) => a + m.hiddenCents, 0);

  const clickSegment = (seriesKey: string, month: string) => {
    const extra: Record<string, string> = { month };
    if (seriesKey !== '-1') {
      if (stack === 'category') extra.cat = seriesKey;
      if (stack === 'person') extra.person = seriesKey === '0' ? 'none' : seriesKey;
      if (stack === 'account') extra.acct = seriesKey;
    }
    for (const k of ['cat', 'person', 'acct'] as const) if (params[k] && !extra[k]) extra[k] = params[k];
    navigate('transactions', extra);
  };

  const cat = categories.find(c => String(c.id) === params.cat);
  const person = people.find(p => String(p.id) === params.person);
  const acct = accounts.find(a => String(a.id) === params.acct);

  return (
    <div className="space-y-6">
      <AskBox />
      {data && <CashFlow data={data} categoryFiltered={!!params.cat}
        onPick={month => navigate('transactions', { kind: 'all', month, person: params.person ?? '', acct: params.acct ?? '' })} />}
      <Card
        title="Spending over time"
        subtitle="Click a bar segment to see those transactions · faded bars are months with missing statements"
        actions={
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Stack by</span>
            <Segmented options={STACKS} value={stack} onChange={id => set({ stack: id })} />
            <select className={inputClass} value={months} onChange={e => set({ months: e.target.value })}>
              <option value="6">6 months</option>
              <option value="12">12 months</option>
              <option value="24">24 months</option>
            </select>
          </div>
        }
      >
        {(cat || person || acct) && (
          <div className="flex flex-wrap gap-2 mb-3">
            {cat && <Chip color={cat.color} onClear={() => set({ cat: '' })}>{cat.name}</Chip>}
            {person && <Chip color={person.color} onClear={() => set({ person: '' })}>{person.name}</Chip>}
            {acct && <Chip onClear={() => set({ acct: '' })}>{acct.label}</Chip>}
          </div>
        )}
        {!data ? <Empty>Loading…</Empty> : rows.length === 0 ? <Empty>No spending yet.</Empty> : (
          <div className="h-96">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ left: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
                <XAxis dataKey="month" tickFormatter={shortMonth} stroke="#8e8e93" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={shortMoney} stroke="#8e8e93" fontSize={11} width={56} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const m = payload[0].payload as (typeof rows)[number];
                  return (
                    <div className={`${tooltipClass} min-w-48`}>
                      <p className="font-semibold text-ink">{monthLabel(String(label))}{!m.complete && <span className="text-warn"> · incomplete</span>}</p>
                      <p className="text-ink mb-1">{formatCents(m.totalCents)}</p>
                      {[...payload].reverse().filter(p => Number(p.value) > 0).map(p => (
                        <p key={String(p.dataKey)} className="flex justify-between gap-4 text-ink-2">
                          <span className="flex items-center gap-1.5"><Dot color={String(p.color)} />{p.name}</span>
                          <span className="font-mono">{formatCents(Number(p.value))}</span>
                        </p>
                      ))}
                      {m.hiddenCents > 0 && <p className="text-muted mt-1">+ {formatCents(m.hiddenCents)} hidden from charts</p>}
                    </div>
                  );
                }} />
                {data.series.map(s => (
                  <Bar key={s.key} dataKey={`s${s.key}`} name={s.name} stackId="a" fill={s.color} cursor="pointer"
                    onClick={(_, i) => clickSegment(s.key, rows[i].month)}>
                    {rows.map(r => <Cell key={r.month} fillOpacity={r.complete ? 1 : 0.35} />)}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {data && (
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs">
            {data.series.map(s => (
              <span key={s.key} className="flex items-center gap-1.5 text-ink-2">
                <Dot color={s.color} />{s.name} <span className="text-muted font-mono">{formatCents(s.totalCents)}</span>
              </span>
            ))}
          </div>
        )}
        {hiddenTotal > 0 && (
          <p className="mt-3 text-xs text-muted">
            {formatCents(hiddenTotal)} of transactions you chose to hide aren't in this chart.{' '}
            <button className="text-accent hover:underline cursor-pointer" onClick={() => navigate('transactions', { hidden: '1' })}>
              See or change them
            </button>
          </p>
        )}
      </Card>

      {data && <MoneyIn months={data.income} onPick={month => navigate('transactions', { kind: 'income', month, person: params.person ?? '', acct: params.acct ?? '' })} />}
    </div>
  );
}

const INCOME_GREEN = '#1f8a3b';

/** Money in per month: one green series (green always means money in across the app). */
function MoneyIn({ months, onPick }: { months: IncomeMonth[]; onPick: (month: string) => void }) {
  const total = months.reduce((s, m) => s + m.cents, 0);
  const withIncome = months.filter(m => m.cents > 0 && m.complete);
  const average = withIncome.length ? Math.round(withIncome.reduce((s, m) => s + m.cents, 0) / withIncome.length) : 0;
  return (
    <Card title="Money in over time" subtitle="Income only, not transfers between your own accounts · click a bar to see those transactions">
      {total === 0 ? <Empty>No income in these months.</Empty> : (
        <>
          <div className="flex flex-wrap gap-x-8 gap-y-1 mb-3 text-xs text-muted">
            <span>Total <b className="text-good font-semibold text-sm">{formatCents(total)}</b></span>
            {average > 0 && <span>Average month <b className="text-ink font-semibold text-sm">{formatCents(average)}</b></span>}
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={months} margin={{ left: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
                <XAxis dataKey="month" tickFormatter={shortMonth} stroke="#8e8e93" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={shortMoney} stroke="#8e8e93" fontSize={11} width={56} tickLine={false} axisLine={false} />
                <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const m = payload[0].payload as IncomeMonth;
                  return (
                    <div className={`${tooltipClass} min-w-48`}>
                      <p className="font-semibold text-ink">{monthLabel(m.month)}{!m.complete && <span className="text-warn"> · incomplete</span>}</p>
                      <p className="text-good font-semibold mb-1">{formatCents(m.cents)}</p>
                      {m.topSources.map(src => (
                        <p key={src.name} className="flex justify-between gap-4 text-ink-2">
                          <span className="truncate max-w-48">{src.name}</span>
                          <span className="font-mono">{formatCents(src.cents)}</span>
                        </p>
                      ))}
                      {m.otherSources > 0 && <p className="text-muted mt-1">+ {m.otherSources} more</p>}
                    </div>
                  );
                }} />
                <Bar dataKey="cents" name="Money in" fill={INCOME_GREEN} radius={[4, 4, 0, 0]} cursor="pointer"
                  onClick={(_, i) => onPick(months[i].month)}>
                  {months.map(m => <Cell key={m.month} fillOpacity={m.complete ? 1 : 0.35} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Card>
  );
}
