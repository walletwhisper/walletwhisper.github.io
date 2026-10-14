import type { BankProfile, ParsedRow } from '../types.js';
import { chaseLast4, field, parseAmount, parseUsDate, toCents } from './common.js';

/**
 * Chase Checking Profile
 * Header: Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
 *
 * Rules:
 * - Date: Posting Date (MM/DD/YYYY -> YYYY-MM-DD)
 * - Amount sign: debits are negative (-120.00 -> 12000 cents spend), credits positive.
 * - Transfers: Type ACCT_XFER / LOAN_PMT, or a description that looks like a card payment or
 *   an account-to-account transfer. These are only a first guess: the transfer matcher
 *   confirms them by pairing with the other account, and unexplained ones go to review.
 *   P2P payments to other people (Zelle/Venmo) are spending, not transfers.
 * - Income: money in that is not a transfer.
 * - Trailing comma tolerance: data rows have one more field than the header.
 */
const CARD_PAYMENT =
  /\b(CAPITAL ONE|DISCOVER|CITI|CITIBANK|AMEX|AMERICAN EXPRESS|BANK OF AMERICA|BK OF AMER|BARCLAYCARD|BARCLAYS|SYNCHRONY|APPLECARD|APPLE CARD|GSBANK|WELLS FARGO CARD|US BANK|TD BANK|TARGET CARD)\b.*\b(PMT|PAYMENT|E-?PAYMENT|AUTOPAY|AUTO PAY|CRCARDPMT|ONLINE PMT|MOBILE PMT|BILL PAY)\b/;

export function looksLikeTransfer(descUpper: string, typeUpper = ''): boolean {
  return (
    typeUpper.includes('ACCT_XFER') ||
    typeUpper.includes('LOAN_PMT') ||
    descUpper.includes('AUTOPAY') ||
    descUpper.includes('PAYMENT TO CHASE CARD') ||
    descUpper.includes('CHASE CREDIT CRD') ||
    descUpper.includes('EPAY') ||
    descUpper.includes('ONLINE TRANSFER') ||
    descUpper.includes('REALTIME TRANSFER') ||
    descUpper.includes('VENMO CASHOUT') ||
    descUpper.includes('TRANSFER TO') ||
    descUpper.includes('TRANSFER FROM') ||
    CARD_PAYMENT.test(descUpper)
  );
}

export const chaseCheckingProfile: BankProfile = {
  id: 'chase_checking',
  bank: 'Chase',
  accountType: 'checking',

  matches(headers: string[]): boolean {
    const normalized = headers.map(h => h.trim().toLowerCase());
    const required = ['details', 'posting date', 'description', 'amount', 'type', 'balance'];
    return required.every(req => normalized.includes(req));
  },

  last4FromFilename: chaseLast4,

  parseRow(row: Record<string, string>): ParsedRow | null {
    const date = parseUsDate(field(row, 'Posting Date'));
    const amount = parseAmount(field(row, 'Amount'));
    if (!date || amount === null) return null;

    const rawDescription = field(row, 'Description').trim();
    const details = field(row, 'Details').trim().toUpperCase();
    const type = field(row, 'Type').trim().toUpperCase();
    const direction = amount > 0 || details === 'CREDIT' ? 'in' : 'out';

    if (looksLikeTransfer(rawDescription.toUpperCase(), type)) {
      return { date, rawDescription, amountCents: toCents(Math.abs(amount)), kind: 'transfer', direction };
    }
    if (direction === 'in') {
      return { date, rawDescription, amountCents: toCents(Math.abs(amount)), kind: 'income', direction };
    }
    return { date, rawDescription, amountCents: toCents(-amount), kind: 'spend', direction };
  }
};
