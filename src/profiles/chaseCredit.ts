import { BankProfile, ParsedRow } from '../types.js';
import { chaseLast4, field, parseAmount, parseUsDate, toCents } from './common.js';

/**
 * Chase Credit Card Profile
 * Header: Transaction Date,Post Date,Description,Category,Type,Amount,Memo
 *
 * Rules:
 * - Date: Transaction Date (MM/DD/YYYY -> YYYY-MM-DD)
 * - Amount sign: charges are negative (-78.45), payments/returns positive.
 *   We invert so positive = spend (7845 cents).
 * - Type:
 *   - 'Sale': 'spend'
 *   - 'Return': 'refund' (amountCents is negative so it nets out category total)
 *   - 'Payment': 'transfer' (money arriving from the account that paid the bill)
 *   - 'Fee' / 'Adjustment': 'fee'
 */
export const chaseCreditProfile: BankProfile = {
  id: 'chase_credit',
  bank: 'Chase',
  accountType: 'credit',

  matches(headers: string[]): boolean {
    const normalized = headers.map(h => h.trim().toLowerCase());
    const required = ['transaction date', 'post date', 'description', 'category', 'type', 'amount'];
    return required.every(req => normalized.includes(req));
  },

  last4FromFilename: chaseLast4,

  parseRow(row: Record<string, string>): ParsedRow | null {
    const date = parseUsDate(field(row, 'Transaction Date'));
    const amount = parseAmount(field(row, 'Amount'));
    if (!date || amount === null) return null;

    const rawDescription = field(row, 'Description').trim();
    const rawType = field(row, 'Type').trim().toLowerCase();
    const bankCategory = field(row, 'Category').trim() || undefined;
    const direction = amount > 0 ? 'in' : 'out';

    if (rawType === 'payment') {
      return { date, rawDescription, amountCents: toCents(Math.abs(amount)), kind: 'transfer', direction, bankCategory };
    }
    if (rawType === 'return') {
      // Returns reduce category spending: represented as negative cents
      return { date, rawDescription, amountCents: -toCents(Math.abs(amount)), kind: 'refund', direction, bankCategory };
    }
    if (rawType === 'fee' || rawType === 'adjustment') {
      return { date, rawDescription, amountCents: toCents(Math.abs(amount)), kind: 'fee', direction, bankCategory };
    }
    // Sale: -50 -> +5000 cents. A positive "sale" keeps a consistent (negative) sign.
    return { date, rawDescription, amountCents: toCents(-amount), kind: 'spend', direction, bankCategory };
  }
};
