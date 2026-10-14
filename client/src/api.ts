// Thin client for the local API. Every write sends the per-session token the server
// hands only to its own page (see src/security.ts).

let tokenPromise: Promise<string> | null = null;

function token(): Promise<string> {
  tokenPromise ??= fetch('/api/session').then(r => r.json()).then(d => d.token as string);
  return tokenPromise;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-App-Token'] = await token();
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

/** Download the backup file (all data, optionally password-protected) and hand it to the browser to save. */
export async function downloadBackup(password: string): Promise<void> {
  const res = await fetch('/api/backup/export', {
    method: 'POST',
    headers: { 'X-App-Token': await token(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: password || undefined }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Export failed (${res.status})`);
  const name = res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'walletwhisper-backup.wwbackup';
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface BackupInfo { transactions: number; accounts: number; people: number; from: string | null; to: string | null }

/** Send a backup file to the server: `inspect` only reads it, `restore` replaces the data. */
export function sendBackup<T>(action: 'inspect' | 'restore', file: File, password: string, confirm = false): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  if (password) form.append('password', password);
  if (confirm) form.append('confirm', 'REPLACE');
  return request<T>('POST', `/api/backup/${action}`, form);
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export interface Settings {
  dataFolder: string | null;
  aiConfigured: boolean;
  aiProvider: string | null;
  aiKeyInEnvFile: boolean;
}

export interface SetupInfo {
  configured: boolean;
  suggestedFolder: string;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---------- Types returned by the API ----------

export interface Slice { id: number | null; name: string; color: string; cents: number; count: number; pct: number; }
export interface MonthTotal { month: string; cents: number; hiddenCents: number; complete: boolean; }

export interface Summary {
  totalSpend: number;
  totalTxnCount: number;
  /** Spending the user left out of the charts */
  hiddenCents: number;
  hiddenCount: number;
  moneyIn: number;
  byCategory: Slice[];
  byPerson: Slice[];
  byAccount: Slice[];
  byMonth: MonthTotal[];
  typicalMonthCents: number;
  typicalMonthBasis: string[];
  reviewCount: number;
  dataRange: { min: string | null; max: string | null };
}

export interface Trends {
  stack: 'category' | 'person' | 'account';
  months: { month: string; complete: boolean; totalCents: number; hiddenCents: number; segments: Record<string, number> }[];
  series: { key: string; name: string; color: string; totalCents: number }[];
  income: IncomeMonth[];
}

export interface IncomeMonth {
  month: string;
  complete: boolean;
  cents: number;
  topSources: { name: string; cents: number }[];
  otherSources: number;
}

export interface Txn {
  id: number;
  date: string;
  rawDescription: string;
  merchant: string;
  amountCents: number;
  kind: string;
  kindSource: string;
  transferVia: string | null;
  direction: string | null;
  categoryId: number;
  categorySource: string;
  categoryName: string;
  categoryColor: string;
  personId: number | null;
  personSource: string | null;
  personName: string | null;
  personColor: string | null;
  /** Left out of every chart and total ("Show in charts" unticked) */
  hidden: boolean;
  accountId: number;
  account: string;
  counterparty: string | null;
  linkId: number | null;
  linkMethod: string | null;
  partnerDate: string | null;
}

export interface TxnList { transactions: Txn[]; count: number; sumCents: number; hiddenCents: number; hiddenCount: number; truncated: boolean; }

export interface Category { id: number; name: string; color: string; }
export interface Person { id: number; name: string; color: string; aliases: string[]; txnCount: number; }

export interface Account {
  id: number;
  profileId: string;
  bank: string;
  accountType: string;
  nickname: string | null;
  last4: string | null;
  label: string;
  isTracked: boolean;
  cardPolicy: 'will_import' | 'payments_are_spending' | null;
  matchPatterns: string[];
  defaultPersonId: number | null;
  txnCount: number;
  counterpartyCount: number;
}

export interface ReviewTxn { id: number; date: string; account: string; description: string; amountCents: number; direction: string; }
export interface ReviewItem {
  key: string;
  type: 'unmatched_transfer' | 'ambiguous_pair' | 'p2p_name';
  title: string;
  detail: string;
  direction?: 'out' | 'in';
  count: number;
  totalCents: number;
  txns: ReviewTxn[];
  suggestedPattern?: string;
  name?: string;
  candidates?: ReviewTxn[];
}

export interface Coverage {
  months: string[];
  accounts: { id: number; name: string; tracked: boolean; cardPolicy: string | null; expectedFrom: string | null;
    ranges: { from: string; to: string }[]; months: Record<string, 'full' | 'partial' | 'missing' | 'n/a'>; gapMonths: string[] }[];
}

export interface ImportRecord {
  id: number; filename: string; importedAt: string; rowsAdded: number; rowsSkipped: number;
  minDate: string | null; maxDate: string | null; account: string;
}

export interface Preview {
  filename: string;
  error?: string;
  profileId?: string;
  bank?: string;
  accountType?: string;
  last4?: string | null;
  suggestedAccountId?: number | null;
  needsAccountChoice?: boolean;
  accountOptions?: { id: number; label: string }[];
  rows?: number;
  newRows?: number;
  duplicates?: number;
  minDate?: string;
  maxDate?: string;
}

export interface ImportResponse {
  results: { filename: string; bank: string; accountType: string; rowsAdded: number; rowsSkipped: number; error?: string }[];
  matched: { pairsLinked: number; accountMatches: number; householdTransfers: number };
  reviewCount: number;
}

export interface PeriodTotal { label: string; from: string; to: string; cents: number; count: number; }
export type AskAnswer =
  | { understood: false; clarification: string }
  | {
      understood: true;
      headline: string;
      subject: string;
      period: PeriodTotal;
      previous: PeriodTotal;
      lastYear: PeriodTotal;
      months: { month: string; cents: number; inPeriod: boolean }[];
      topMerchants: { merchant: string; cents: number; count: number }[];
      byCategory: { id: number; name: string; color: string; cents: number }[];
      filters: { categoryIds: number[]; personId: number | null; merchant: string | null };
      notes: string[];
    };
