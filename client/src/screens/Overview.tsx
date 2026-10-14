import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { ChevronLeft, ChevronRight, ArrowUpRight, ArrowDownRight, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { Slice, Summary, Trends } from '../api';
import { qs } from '../api';
import { useFetch } from '../store';
import { formatCents, median, monthEnd, monthLabel, useRoute } from '../lib';
import { Button, Card, Dot, Empty, Stat, tooltipClass } from '../ui';
import { AskBox } from '../AskBox';

export function Overview() {
  const { params, navigate } = useRoute();
  const all = useFetch<Summary>('/api/summary');
  const latest = all.data?.dataRange.max?.slice(0, 7) ?? null;
  const month = params.month || latest;
  const months = all.data?.byMonth.map(m => m.month) ?? [];

  const summary = useFetch<Summary>(month ? `/api/summary${qs({ month })}` : null);
  const trends = useFetch<Trends>(month ? `/api/trends${qs({ months: 7, stack: 'category', to: monthEnd(month) })}` : null);

  const changes = useMemo(() => {
    if (!trends.data || !month) return [];
    const cur = trends.data.months.find(m => m.month === month);
    const prior = trends.data.months.filter(m => m.month < month && m.complete);
    if (!cur || prior.length === 0) return [];
    return trends.data.series
      .map(s => {
        const now = cur.segments[s.key] || 0;
        const typical = median(prior.map(m => m.segments[s.key] || 0));
        return { ...s, now, typical, diff: now - typical };
      })
      .filter(c => Math.abs(c.diff) >= 1000)
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
      .slice(0, 5);
  }, [trends.data, month]);

  if (all.data && !all.data.dataRange.max) {
    return <Card><Empty>No transactions yet. Use <b>Import</b> (top right) or drop your bank CSV files anywhere on this page.</Empty></Card>;
  }
  if (!month || !summary.data) return <Card><Empty>Loading…</Empty></Card>;

  const s = summary.data;
  const monthInfo = all.data?.byMonth.find(m => m.month === month);
  const complete = monthInfo?.complete ?? true;
  const typical = s.typicalMonthCents;
  const delta = typical > 0 ? Math.round(((s.totalSpend - typical) / typical) * 100) : null;
  const idx = months.indexOf(month);

  const goTxns = (extra: Record<string, string>) => navigate('transactions', { month, ...extra });

  return (
    <div className="space-y-6">
      <AskBox />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" disabled={idx <= 0} onClick={() => navigate('overview', { month: months[idx - 1] })} aria-label="Previous month">
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <h2 className="text-xl font-semibold text-ink w-36 text-center">{monthLabel(month)}</h2>
          <Button variant="ghost" disabled={idx < 0 || idx >= months.length - 1} onClick={() => navigate('overview', { month: months[idx + 1] })} aria-label="Next month">
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
        {complete ? (
          <span className="text-xs text-good flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> All accounts imported for this month</span>
        ) : (
          <button onClick={() => navigate('accounts')} className="text-xs text-warn flex items-center gap-1.5 cursor-pointer hover:underline">
            <AlertTriangle className="w-4 h-4" /> Incomplete month: some account statements are missing. See coverage
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Spent" value={formatCents(s.totalSpend)} hint={`${s.totalTxnCount} transactions`} />
        <Stat
          label="vs. typical month"
          value={delta === null ? '—' : `${delta > 0 ? '▲' : delta < 0 ? '▼' : ''} ${Math.abs(delta)}%`}
          tone={delta === null ? undefined : delta > 10 ? 'warn' : 'good'}
          hint={typical ? `Typical: ${formatCents(typical)} (median of ${s.typicalMonthBasis.length} complete months)` : 'Needs earlier complete months'}
        />
        <Stat label="Money in" value={formatCents(s.moneyIn)} tone="good" hint="Income, not transfers between your accounts" />
        <Stat
          label={s.reviewCount ? 'Needs review' : 'Hidden from charts'}
          value={s.reviewCount ? s.reviewCount : formatCents(s.hiddenCents)}
          tone={s.reviewCount ? 'warn' : undefined}
          hint={s.reviewCount
            ? <button className="underline cursor-pointer" onClick={() => navigate('review')}>Answer a few questions so totals are right</button>
            : <button className="underline cursor-pointer" onClick={() => navigate('transactions', { hidden: '1' })}>
                {s.hiddenCount ? `${s.hiddenCount} transaction${s.hiddenCount === 1 ? '' : 's'} you left out` : 'Untick any transaction to leave it out'}
              </button>}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <Card className="lg:col-span-3" title="Where the money went" subtitle="Hover for details · click a slice to see its transactions">
          <CategoryDonut slices={s.byCategory} onPick={c => goTxns({ cat: String(c.id) })} />
        </Card>
        <Card className="lg:col-span-2" title="Biggest changes" subtitle="This month vs. your typical month">
          {changes.length === 0 ? (
            <Empty>Not enough earlier complete months to compare yet.</Empty>
          ) : (
            <ul className="space-y-3">
              {changes.map(c => (
                <li key={c.key}>
                  <button className="w-full text-left cursor-pointer group" onClick={() => c.key !== '-1' && goTxns({ cat: c.key })}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 text-ink group-hover:text-ink"><Dot color={c.color} />{c.name}</span>
                      <span className={c.diff > 0 ? 'text-warn flex items-center' : 'text-good flex items-center'}>
                        {c.diff > 0 ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
                        {formatCents(Math.abs(c.diff))}
                      </span>
                    </div>
                    <div className="text-xs text-muted mt-0.5">{formatCents(c.now)} this month · typical {formatCents(c.typical)}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="By person" subtitle="Mark who spent what on the Transactions screen">
          <Bars slices={s.byPerson} total={s.totalSpend} onPick={p => goTxns({ person: p.id === null ? 'none' : String(p.id) })} />
        </Card>
        <Card title="By account">
          <Bars slices={s.byAccount.map((a, i) => ({ ...a, color: ACCOUNT_COLORS[i % ACCOUNT_COLORS.length] }))} total={s.totalSpend} onPick={a => goTxns({ acct: String(a.id) })} />
        </Card>
      </div>
    </div>
  );
}

const ACCOUNT_COLORS = ['#005594', '#EE8D3D', '#4398D3', '#C5362F', '#34C759', '#5856D6'];

export function CategoryDonut({ slices, onPick, selectedId }: { slices: Slice[]; onPick: (s: Slice) => void; selectedId?: number }) {
  if (slices.length === 0) return <Empty>No spending in this period.</Empty>;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="cents" nameKey="name" innerRadius="58%" outerRadius="90%" paddingAngle={2} cursor="pointer"
              onClick={(_, i) => onPick(slices[i])}>
              {slices.map(s => (
                <Cell key={String(s.id)} fill={s.color} stroke="#ffffff" strokeWidth={2}
                  opacity={selectedId && selectedId !== s.id ? 0.35 : 1} />
              ))}
            </Pie>
            <Tooltip content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0].payload as Slice;
              return (
                <div className={tooltipClass}>
                  <p className="font-semibold text-ink flex items-center gap-2"><Dot color={d.color} />{d.name}</p>
                  <p className="text-ink mt-1">{formatCents(d.cents)} · {d.pct}%</p>
                  <p className="text-muted">{d.count} transactions</p>
                </div>
              );
            }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
        {slices.map(s => (
          <li key={String(s.id)}>
            <button onClick={() => onPick(s)} className="w-full flex items-center justify-between gap-2 text-xs px-2 py-1 rounded hover:bg-fill cursor-pointer">
              <span className="flex items-center gap-2 text-ink truncate"><Dot color={s.color} />{s.name}</span>
              <span className="text-muted font-mono whitespace-nowrap">{formatCents(s.cents)} <span className="text-muted">{s.pct}%</span></span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Bars({ slices, total, onPick }: { slices: Slice[]; total: number; onPick: (s: Slice) => void }) {
  if (slices.length === 0) return <Empty>No spending in this period.</Empty>;
  return (
    <ul className="space-y-3">
      {slices.map(s => (
        <li key={String(s.id)}>
          <button className="w-full text-left cursor-pointer group" onClick={() => onPick(s)}>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-ink group-hover:text-ink flex items-center gap-2"><Dot color={s.color} />{s.name}</span>
              <span className="text-muted font-mono">{formatCents(s.cents)} · {s.pct}%</span>
            </div>
            <div className="h-2.5 bg-fill rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${total > 0 ? Math.max(1, (s.cents / total) * 100) : 0}%`, backgroundColor: s.color }} />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
