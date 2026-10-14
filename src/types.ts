export type TransactionKind = 'spend' | 'refund' | 'income' | 'transfer' | 'fee';

export type Direction = 'out' | 'in';

export type CategorySource = 'bank' | 'default_rule' | 'user_rule' | 'manual' | 'ai' | 'uncategorized';

/** How a transaction became a transfer: paired with another imported row, matched to an
 *  untracked own account, P2P with a household member, flagged by the bank only, or set by us. */
export type TransferVia = 'pair' | 'account' | 'household' | 'bank' | 'manual';

export type CardPolicy = 'will_import' | 'payments_are_spending';

export interface ParsedRow {
  date: string; // YYYY-MM-DD
  rawDescription: string;
  amountCents: number; // positive for spend/debit, negative for refund/credit back; transfers/income positive
  kind: TransactionKind;
  direction: Direction; // whether money left or arrived in this account
  bankCategory?: string;
}

export interface BankProfile {
  id: string;
  bank: string;
  accountType: 'credit' | 'checking';
  matches(headers: string[]): boolean;
  /** Last 4 digits of the account from the export filename, if the bank includes them. */
  last4FromFilename?(filename: string): string | null;
  parseRow(row: Record<string, string>): ParsedRow | null;
}
