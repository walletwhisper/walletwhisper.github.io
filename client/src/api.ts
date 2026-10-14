// The screens talk to WalletWhisper through these calls. There is no server: each call is handled
// inside this page by the engine in src/app.ts, using the data saved in this browser.
import { ApiError } from '../../src/app';
import type { UploadedFile } from '../../src/app';
import { boot } from './local/engine';

async function toBody(body: unknown): Promise<Record<string, unknown> | undefined> {
  if (!(body instanceof FormData)) return body as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {};
  const files: UploadedFile[] = [];
  for (const [k, v] of body.entries()) {
    if (v instanceof File) files.push({ name: v.name, bytes: new Uint8Array(await v.arrayBuffer()) });
    else out[k] = v;
  }
  return { ...out, files };
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const started = await boot();
  if (started.status !== 'ready') throw new Error('WalletWhisper is open in another tab.');
  try {
    return (await started.api.handle({ method, url, body: await toBody(body) })) as T;
  } catch (err) {
    if (err instanceof ApiError) throw new Error(err.message);
    throw err;
  }
}

/** Save a file the browser hands to the user (a backup they download). */
export function saveFile(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Download the backup file (all data, optionally password-protected). */
export async function downloadBackup(password: string): Promise<void> {
  const r = await request<{ filename: string; bytes: Uint8Array }>('POST', '/api/backup/export', { password: password || undefined });
  saveFile(r.bytes, r.filename);
}

export interface BackupInfo { transactions: number; accounts: number; people: number; from: string | null; to: string | null }

/** Open a backup file: `inspect` only reads it, `compare` checks it against the data here, `restore` replaces the data. */
export function sendBackup<T>(action: 'inspect' | 'restore' | 'compare', file: File, password: string, confirm = false): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  if (password) form.append('password', password);
  if (confirm) form.append('confirm', 'REPLACE');
  return request<T>('POST', `/api/backup/${action}`, form);
}

export interface MergeConflict {
  id: string;
  kind: 'transaction' | 'rule' | 'person_rule' | 'account';
  title: string;
  detail: string;
  field: string;
  mine: string;
  theirs: string;
  mineChangedAt: string | null;
  theirsChangedAt: string | null;
  suggested: 'mine' | 'theirs';
}

export interface MergePreview {
  identical: boolean;
  newTransactions: number;
  localOnlyTransactions: number;
  localOnlySample: { date: string; merchant: string; amountCents: number }[];
  newPeople: string[];
  newAccounts: string[];
  newRules: number;
  editsFromBackup: number;
  conflicts: MergeConflict[];
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export interface Settings {
  aiConfigured: boolean;
  aiProvider: string | null;
}

export interface SetupInfo {
  configured: boolean;
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
