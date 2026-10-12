/**
 * Merchant Cleaner:
 * Cleans noisy bank description strings (e.g., 'SQ *BLUE BOTTLE #12 SAN FRANCISCO CA')
 * into concise, stable merchant names ('Blue Bottle') for clean display and rule matching.
 */
export function cleanMerchant(raw: string): string {
  if (!raw || !raw.trim()) return 'Unknown';

  let cleaned = raw.trim();

  // Strip common bank/payment gateway prefixes
  const prefixes = [
    /^SQ\s*\*\s*/i,
    /^TST\s*\*\s*/i,
    /^SP\s*\*\s*/i,
    /^PAYPAL\s*\*\s*/i,
    /^POS\s+(?:DEBIT\s+)?/i,
    /^DEBIT\s+CARD\s+PURCHASE\s+(?:-\s+)?/i,
    /^CHECKCARD\s+\d*\s*/i,
    /^PURCHASE\s+AUTHORIZED\s+ON\s+\d+\/\d+\s*/i,
    /^ONLINE\s+TRANSFER\s+(?:TO|FROM)\s+/i,
    /^AUTOMATIC\s+PAYMENT\s+-\s+THANK\s+YOU\s*/i,
    /^PAYMENT\s+THANK\s+YOU\s*/i,
  ];

  for (const p of prefixes) {
    cleaned = cleaned.replace(p, '');
  }

  // Remove trailing city and state pattern, e.g. "SAN FRANCISCO CA", "NEW YORK NY", "SEATTLE WA"
  cleaned = cleaned.replace(/\s+[A-Z\s]{2,16}\s+[A-Z]{2}$/i, '');

  // Remove standalone trailing state code if still present
  cleaned = cleaned.replace(/\s+[A-Z]{2}$/i, '');

  // Remove store numbers or terminal IDs like #1234 or numbers like 041, 1234
  cleaned = cleaned.replace(/#\s*\d+/g, '');
  cleaned = cleaned.replace(/\b\d+\b/g, '');

  // Remove alphanumeric junk like *2A345
  cleaned = cleaned.replace(/\*[A-Z0-9]+/gi, '');

  // Remove URLs or domains (e.g., .COM, .NET)
  cleaned = cleaned.replace(/\.(COM|NET|ORG|IO|CO)\b/gi, '');

  // Normalize whitespace and punctuation
  cleaned = cleaned.replace(/[*_~\-]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Title case conversion
  if (cleaned.length > 0) {
    cleaned = cleaned
      .toLowerCase()
      .split(' ')
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  return cleaned || raw.trim();
}
