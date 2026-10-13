/** MM/DD/YYYY -> YYYY-MM-DD, or null if malformed. */
export function parseUsDate(raw: string): string | null {
  const parts = raw.trim().split('/');
  if (parts.length !== 3) return null;
  const [month, day, year] = parts;
  if (!/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day) || !/^\d{4}$/.test(year)) return null;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** "$1,234.56" / "-78.45" -> signed number, or null. */
export function parseAmount(raw: string): number | null {
  const n = parseFloat(raw.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function toCents(n: number): number {
  return Math.round(n * 100);
}

/** Chase exports are named like "Chase1234_Activity_20261011.CSV". */
export function chaseLast4(filename: string): string | null {
  const m = filename.match(/^Chase(\d{4})_/i);
  return m ? m[1] : null;
}

/** Case-insensitive lookup that tolerates header capitalization differences. */
export function field(row: Record<string, string>, name: string): string {
  if (row[name] !== undefined) return row[name];
  const key = Object.keys(row).find(k => k.trim().toLowerCase() === name.toLowerCase());
  return key ? row[key] : '';
}
