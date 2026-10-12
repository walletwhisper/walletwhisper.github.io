export type TransactionKind = 'spend' | 'refund' | 'income' | 'transfer' | 'fee';

export type CategorySource = 'bank' | 'default_rule' | 'user_rule' | 'manual';

export interface ParsedRow {
  date: string; // YYYY-MM-DD
  rawDescription: string;
  amountCents: number; // positive for spend/debit, negative for refund/credit back
  kind: TransactionKind;
  bankCategory?: string;
}

export interface BankProfile {
  id: string;
  bank: string;
  accountType: 'credit' | 'checking';
  matches(headers: string[]): boolean;
  parseRow(row: Record<string, string>): ParsedRow | null;
}

export interface Transaction {
  id: number;
  importId: number;
  accountId: number;
  txnDate: string;
  rawDescription: string;
  merchant: string;
  amountCents: number;
  kind: TransactionKind;
  categoryId: number;
  categorySource: CategorySource;
  bankCategory?: string;
  fingerprint: string;
}

export interface Category {
  id: number;
  name: string;
  color: string;
  isSystem: boolean;
}

export interface Rule {
  id: number;
  pattern: string; // merchant lowercase match
  categoryId: number;
  priority: number;
  source: 'default' | 'user';
}
