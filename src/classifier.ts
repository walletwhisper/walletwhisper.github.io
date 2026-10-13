import { Database } from 'sql.js';
import { CHASE_CATEGORY_MAP } from './taxonomy.js';

export interface ClassificationResult {
  categoryId: number;
  categorySource: 'manual' | 'user_rule' | 'default_rule' | 'bank' | 'uncategorized';
}

/** True if `keyword` appears in `text` as a whole word/phrase (not inside another word). */
export function matchesWholeWord(text: string, keyword: string): boolean {
  if (!keyword) return false;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text);
}

/**
 * Classify a transaction using the priority hierarchy:
 * 1. Transfers (kind === 'transfer') -> 'Transfer' category
 * 2. User Rules (priority 10, exact/partial merchant match)
 * 3. Default Rules (priority 1, keywords)
 * 4. Bank Category (if provided by Chase or other bank)
 * 5. Fallback -> 'Uncategorized'
 */
export function classifyTransaction(
  db: Database,
  merchant: string,
  kind: string,
  bankCategory?: string
): ClassificationResult {
  // Build category lookup cache
  const catRows = db.exec("SELECT id, name FROM categories");
  const nameToId = new Map<string, number>();
  for (const row of catRows[0].values) {
    nameToId.set((row[1] as string).toLowerCase(), row[0] as number);
  }

  // 1. Check if kind is transfer
  if (kind === 'transfer') {
    const transferId = nameToId.get('transfer');
    if (transferId) return { categoryId: transferId, categorySource: 'default_rule' };
  }

  // 1b. Check if kind is income
  if (kind === 'income') {
    const incomeId = nameToId.get('income');
    if (incomeId) return { categoryId: incomeId, categorySource: 'default_rule' };
  }

  const merchantLower = merchant.toLowerCase();

  // 2. User rules (priority = 10)
  const userRules = db.exec(
    "SELECT pattern, category_id FROM rules WHERE source = 'user' ORDER BY priority DESC, id DESC"
  );
  if (userRules.length > 0 && userRules[0].values.length > 0) {
    for (const [pattern, catId] of userRules[0].values) {
      const p = (pattern as string).toLowerCase();
      if (merchantLower.includes(p) || p.includes(merchantLower)) {
        return { categoryId: catId as number, categorySource: 'user_rule' };
      }
    }
  }

  // 3. Default rules (priority = 1)
  // Whole-word match only (e.g. "mobil" must not match "Mobile"), longest keyword first
  const defaultRules = db.exec(
    "SELECT pattern, category_id FROM rules WHERE source = 'default' ORDER BY LENGTH(pattern) DESC"
  );
  if (defaultRules.length > 0 && defaultRules[0].values.length > 0) {
    for (const [pattern, catId] of defaultRules[0].values) {
      if (matchesWholeWord(merchantLower, (pattern as string).toLowerCase())) {
        return { categoryId: catId as number, categorySource: 'default_rule' };
      }
    }
  }

  // 4. Bank category mapping
  if (bankCategory) {
    const mappedName = CHASE_CATEGORY_MAP[bankCategory.trim().toLowerCase()];
    if (mappedName) {
      const catId = nameToId.get(mappedName.toLowerCase());
      if (catId) {
        return { categoryId: catId, categorySource: 'bank' };
      }
    }
  }

  // 5. Fallback
  const uncatId = nameToId.get('uncategorized') || 1;
  return { categoryId: uncatId, categorySource: 'uncategorized' };
}
