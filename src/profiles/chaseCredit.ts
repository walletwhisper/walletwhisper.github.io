import { BankProfile, ParsedRow } from '../types.js';

/**
 * Chase Credit Card Profile
 * Header: Transaction Date,Post Date,Description,Category,Type,Amount,Memo
 *
 * Rules:
 * - Date: Transaction Date (MM/DD/YYYY -> YYYY-MM-DD)
 * - Amount sign: In Chase Credit export, charges/purchases are negative (e.g. -78.45).
 *   We invert so positive = spend (7845 cents).
 * - Type:
 *   - 'Sale': 'spend'
 *   - 'Return': 'refund' (amountCents is negative so it nets out category total)
 *   - 'Payment': 'transfer' (excluded from spending charts)
 *   - 'Fee' / 'Adjustment': 'fee'
 */
export const chaseCreditProfile: BankProfile = {
  id: 'chase_credit',
  bank: 'Chase',
  accountType: 'credit',

  matches(headers: string[]): boolean {
    const normalized = headers.map(h => h.trim().toLowerCase());
    const required = [
      'transaction date',
      'post date',
      'description',
      'category',
      'type',
      'amount'
    ];
    return required.every(req => normalized.includes(req));
  },

  parseRow(row: Record<string, string>): ParsedRow | null {
    const rawDate = row['Transaction Date'] || row['transaction date'] || '';
    const rawDesc = row['Description'] || row['description'] || '';
    const rawAmount = row['Amount'] || row['amount'] || '';
    const rawType = (row['Type'] || row['type'] || '').trim().toLowerCase();
    const bankCategory = row['Category'] || row['category'] || undefined;

    if (!rawDate || !rawAmount) return null;

    // Parse date MM/DD/YYYY to YYYY-MM-DD
    const dateParts = rawDate.split('/');
    if (dateParts.length !== 3) return null;
    const [month, day, year] = dateParts;
    const isoDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

    // Parse amount to cents
    const parsedNum = parseFloat(rawAmount.replace(/[$,]/g, ''));
    if (isNaN(parsedNum)) return null;

    // In Chase credit: charges are negative, payments/returns are positive
    // When spend: -78.45 -> positive 7845 cents
    let kind: ParsedRow['kind'] = 'spend';
    let amountCents = Math.round(-parsedNum * 100);

    if (rawType === 'payment') {
      kind = 'transfer';
      amountCents = Math.round(Math.abs(parsedNum) * 100);
    } else if (rawType === 'return') {
      kind = 'refund';
      // Returns reduce category spending: represented as negative cents
      amountCents = -Math.round(Math.abs(parsedNum) * 100);
    } else if (rawType === 'fee' || rawType === 'adjustment') {
      kind = 'fee';
      amountCents = Math.round(Math.abs(parsedNum) * 100);
    } else {
      kind = 'spend';
      // If parsedNum was negative (-50), amountCents is +5000
      // If parsedNum was positive (unusual for sale), keep sign consistent
      amountCents = Math.round(-parsedNum * 100);
    }

    return {
      date: isoDate,
      rawDescription: rawDesc.trim(),
      amountCents,
      kind,
      bankCategory: bankCategory?.trim() || undefined,
    };
  }
};
