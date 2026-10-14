import { useCallback, useEffect, useState } from 'react';

export const formatCents = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/** $1.2k style for chart axes. */
export const shortMoney = (cents: number) => {
  const d = cents / 100;
  if (Math.abs(d) >= 1000) return `$${(d / 1000).toFixed(d >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(d)}`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (ym: string, withYear = true) => {
  const [y, m] = ym.split('-').map(Number);
  return withYear ? `${MONTHS[m - 1]} ${y}` : MONTHS[m - 1];
};
export const shortMonth = (ym: string) => {
  const [y, m] = ym.split('-');
  return `${MONTHS[Number(m) - 1]} '${y.slice(2)}`;
};

export const shiftMonth = (ym: string, delta: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
};

export const monthEnd = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// ---------- Routing: #/screen?filters, so views can be bookmarked and survive a refresh ----------

export type Screen = 'overview' | 'trends' | 'transactions' | 'review' | 'accounts';
const SCREENS: Screen[] = ['overview', 'trends', 'transactions', 'review', 'accounts'];

export type Params = Record<string, string>;

function readHash(): { screen: Screen; params: Params } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const screen = (SCREENS.includes(path as Screen) ? path : 'overview') as Screen;
  return { screen, params: Object.fromEntries(new URLSearchParams(query)) };
}

export function useRoute() {
  const [route, setRoute] = useState(readHash);
  useEffect(() => {
    const on = () => setRoute(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const navigate = useCallback((screen: Screen, params: Params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== undefined)).toString();
    window.location.hash = `#/${screen}${q ? `?${q}` : ''}`;
  }, []);
  return { ...route, navigate };
}

/** Date presets for the Transactions screen, resolved against the latest data date. */
export const PRESETS: { id: string; label: string }[] = [
  { id: 'all', label: 'All time' },
  { id: 'this_month', label: 'Latest month' },
  { id: 'last_3', label: 'Last 3 months' },
  { id: 'last_12', label: 'Last 12 months' },
  { id: 'ytd', label: 'Year to date' },
];

export function presetRange(id: string, latest: string | null): { from?: string; to?: string } {
  if (!latest || id === 'all') return {};
  const ym = latest.slice(0, 7);
  if (id === 'this_month') return { from: `${ym}-01`, to: monthEnd(ym) };
  if (id === 'last_3') return { from: `${shiftMonth(ym, -2)}-01`, to: monthEnd(ym) };
  if (id === 'last_12') return { from: `${shiftMonth(ym, -11)}-01`, to: monthEnd(ym) };
  if (id === 'ytd') return { from: `${ym.slice(0, 4)}-01-01`, to: monthEnd(ym) };
  return {};
}
