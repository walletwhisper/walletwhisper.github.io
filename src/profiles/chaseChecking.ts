import { BankProfile, ParsedRow } from '../types.js';

/**
 * Chase Checking Profile
 * Header: Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
 *
 * Rules:
 * - Date: Posting Date (MM/DD/YYYY -> YYYY-MM-DD)
 * - Amount sign: debits/withdrawals are negative (-120.00 -> 12000 cents spend).
 * - Credits/deposits are positive.
 * - Transfers:
 *   - Type 'ACCT_XFER', 'LOAN_PMT', or Description matching card autopay/transfer -> 'transfer'
 * - Income:
 *   - Details === 'CREDIT' and not a transfer -> 'income'
 * - Trailing comma tolerance: Chase checking data rows often have an extra comma at the end.
 */
export const chaseCheckingProfile: BankProfile = {
  id: 'chase_checking',
  bank: 'Chase',
  accountType: 'checking',

  matches(headers: string[]): boolean {
    const normalized = headers.map(h => h.trim().toLowerCase());
    const required = [
      'details',
      'posting date',
      'description',
      'amount',
      'type',
      'balance'
    ];
    return required.every(req => normalized.includes(req));
  },

  parseRow(row: Record<string, string>): ParsedRow | null {
    const rawDate = row['Posting Date'] || row['posting date'] || '';
    const rawDesc = row['Description'] || row['description'] || '';
    const rawAmount = row['Amount'] || row['amount'] || '';
    const rawDetails = (row['Details'] || row['details'] || '').trim().toUpperCase();
    const rawType = (row['Type'] || row['type'] || '').trim().toUpperCase();

    if (!rawDate || !rawAmount) return null;

    const dateParts = rawDate.split('/');
    if (dateParts.length !== 3) return null;
    const [month, day, year] = dateParts;
    const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

    const parsedNum = parseFloat(rawAmount.replace(/[$,]/g, ''));
    if (isNaN(parsedNum)) return null;

    const descUpper = rawDesc.toUpperCase();
    const isTransferPattern = 
      rawType.includes('ACCT_XFER') ||
      rawType.includes('LOAN_PMT') ||
      descUpper.includes('AUTOPAY') ||
      descUpper.includes('PAYMENT TO CHASE CARD') ||
      descUpper.includes('CHASE CREDIT CRD') ||
      descUpper.includes('EPAY') ||
      descUpper.includes('ONLINE TRANSFER') ||
      descUpper.includes('ZELLE TO') ||
      descUpper.includes('VENMO CASHOUT') ||
      descUpper.includes('TRANSFER TO') ||
      // Payments to other banks' credit cards (e.g. "CAPITAL ONE MOBILE PMT", "DISCOVER E-PAYMENT")
      /\b(CAPITAL ONE|DISCOVER|CITI|CITIBANK|AMEX|AMERICAN EXPRESS|BANK OF AMERICA|BK OF AMER|BARCLAYCARD|BARCLAYS|SYNCHRONY|APPLECARD|APPLE CARD|GSBANK|WELLS FARGO CARD|US BANK|TD BANK)\b.*\b(PMT|PAYMENT|E-?PAYMENT|AUTOPAY|AUTO PAY|CRCARDPMT|ONLINE PMT|MOBILE PMT)\b/.test(descUpper);

    let kind: ParsedRow['kind'] = 'spend';
    let amountCents = 0;

    if (isTransferPattern) {
      kind = 'transfer';
      amountCents = Math.round(Math.abs(parsedNum) * 100);
    } else if (rawDetails === 'CREDIT' || parsedNum > 0) {
      kind = 'income';
      amountCents = Math.round(Math.abs(parsedNum) * 100);
    } else {
      kind = 'spend';
      // Debits are negative in Chase checking, invert to positive cents
      amountCents = Math.round(-parsedNum * 100);
    }

    return {
      date: isoDate,
      rawDescription: rawDesc.trim(),
      amountCents,
      kind,
    };
  }
};
