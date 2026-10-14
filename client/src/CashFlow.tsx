import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { TrendingDown, TrendingUp } from 'lucide-react';
import type { Trends } from './api';
import { formatCents, monthLabel, shortMoney, shortMonth } from './lib';
import { Card, Empty, tooltipClass } from './ui';

// Same greens/reds as the rest of the app: green = money kept, red = more went out than came in
const POSITIVE = '#1f8a3b';
const NEGATIVE = '#c5362f';

interface FlowMonth { month: string; complete: boolean; inCents: number; outCents: number; net: number }

const signed = (cents: number) => `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${formatCents(Math.abs(cents))}`;

/** Money in minus spending, per month, from the same numbers as the spending and money-in charts. */
export function CashFlow({ data, categoryFiltered, onPick }: {
  data: Trends;
  categoryFiltered: boolean;
  onPick: (month: string) => void;
}) {
  if (categoryFiltered) {
    return (
      <Card title="Cash flow">
        <p className="text-sm text-muted">Cash flow compares all your spending with what came in. Clear the category filter to see it.</p>
      </Card>
    );
  }

  const months: FlowMonth[] = data.months.map((m, i) => {
    const inCents = data.income[i]?.cents ?? 0;
    return { month: m.month, complete: m.complete, inCents, outCents: m.totalCents, net: inCents - m.totalCents };
  });
  if (months.every(m => m.inCents === 0 && m.outCents === 0)) {
    return <Card title="Cash flow"><Empty>No money in or out in these months.</Empty></Card>;
  }

  const totalIn = months.reduce((s, m) => s + m.inCents, 0);
  const totalOut = months.reduce((s, m) => s + m.outCents, 0);
  const net = totalIn - totalOut;
  const keptPct = totalIn > 0 ? Math.round((net / totalIn) * 100) : null;
  const counted = months.filter(m => m.complete && (m.inCents || m.outCents));
  const positive = counted.filter(m => m.net > 0).length;
  const best = counted.length ? counted.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  const worst = counted.length ? counted.reduce((a, b) => (b.net < a.net ? b : a)) : null;
  const span = months.length === 1 ? monthLabel(months[0].month) : `the last ${months.length} months`;
  const Icon = net >= 0 ? TrendingUp : TrendingDown;

  return (
    <Card title="Cash flow" subtitle="Money in minus spending. Moving money between your own accounts (like into savings) isn't counted either way.">
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 min-w-10 rounded-full flex items-center justify-center ${net >= 0 ? 'bg-good/10 text-good' : 'bg-bad/10 text-bad'}`}>
          <Icon className="w-5 h-5" />
        </div>
        <p className="text-[15px] text-ink leading-relaxed">
          In {span}, <b className="text-good">{formatCents(totalIn)}</b> came in and <b className="text-bad">{formatCents(totalOut)}</b> went out on spending.{' '}
          {net >= 0
            ? <>You kept <b className="text-good">{formatCents(net)}</b>{keptPct !== null && <>, {keptPct}% of what came in</>}.</>
            : <>You spent <b className="text-bad">{formatCents(-net)}</b> more than came in.</>}
        </p>
      </div>

      {counted.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
          <Fact label="Positive months" value={`${positive} of ${counted.length}`} />
          {best && <Fact label={`Best month · ${monthLabel(best.month)}`} value={signed(best.net)} tone={best.net >= 0 ? 'good' : 'bad'} />}
          {worst && <Fact label={`Toughest month · ${monthLabel(worst.month)}`} value={signed(worst.net)} tone={worst.net >= 0 ? 'good' : 'bad'} />}
        </div>
      )}

      <div className="h-56 mt-5">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={months} margin={{ left: 8, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e5ea" vertical={false} />
            <XAxis dataKey="month" tickFormatter={shortMonth} stroke="#8e8e93" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis tickFormatter={shortMoney} stroke="#8e8e93" fontSize={11} width={56} tickLine={false} axisLine={false} />
            <ReferenceLine y={0} stroke="#8e8e93" />
            <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const m = payload[0].payload as FlowMonth;
              return (
                <div className={`${tooltipClass} min-w-44`}>
                  <p className="font-semibold text-ink">{monthLabel(m.month)}{!m.complete && <span className="text-warn"> · incomplete</span>}</p>
                  <p className="flex justify-between gap-4 text-ink-2 mt-1"><span>Money in</span><span className="font-mono text-good">{formatCents(m.inCents)}</span></p>
                  <p className="flex justify-between gap-4 text-ink-2"><span>Spending</span><span className="font-mono text-bad">{formatCents(m.outCents)}</span></p>
                  <p className="flex justify-between gap-4 font-semibold text-ink border-t border-line mt-1 pt-1">
                    <span>{m.net >= 0 ? 'Kept' : 'Overspent'}</span><span className="font-mono">{signed(m.net)}</span>
                  </p>
                </div>
              );
            }} />
            <Bar dataKey="net" radius={[4, 4, 0, 0]} cursor="pointer" onClick={(_, i) => onPick(months[i].month)}>
              {months.map(m => <Cell key={m.month} fill={m.net >= 0 ? POSITIVE : NEGATIVE} fillOpacity={m.complete ? 1 : 0.35} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {months.some(m => !m.complete) && (
        <p className="text-xs text-muted mt-2">Faded months are missing a statement, so their cash flow isn't final. They're left out of the facts above.</p>
      )}
    </Card>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-[10px] bg-page p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-lg font-bold tracking-tight mt-0.5 ${tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : 'text-ink'}`}>{value}</div>
    </div>
  );
}
