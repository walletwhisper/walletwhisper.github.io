import type { Db } from './db.js';
import { CHASE_CATEGORY_MAP } from './taxonomy.js';
import type { CategorySource } from './types.js';

export interface ClassificationResult {
  categoryId: number;
  categorySource: CategorySource;
}

/** True if `keyword` appears in `text` as a whole word/phrase (not inside another word). */
export function matchesWholeWord(text: string, keyword: string): boolean {
  if (!keyword) return false;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text);
}

export type Classifier = (merchant: string, kind: string, bankCategory?: string | null) => ClassificationResult;

/**
 * Build a classifier that applies, in order:
 * 1. kind = transfer / income -> 'Transfer' / 'Income'
 * 2. User rules (merchant match)
 * 3. Default keyword rules (whole word, longest keyword first)
 * 4. Bank category mapping
 * 5. 'Uncategorized'
 * Rules are loaded once, so build one per batch rather than per row.
 */
export function createClassifier(db: Db): Classifier {
  const nameToId = new Map<string, number>();
  for (const row of db.prepare('SELECT id, name FROM categories').all() as { id: number; name: string }[]) {
    nameToId.set(row.name.toLowerCase(), row.id);
  }
  const userRules = db.prepare(
    "SELECT pattern, category_id FROM rules WHERE source = 'user' ORDER BY priority DESC, id DESC"
  ).all() as { pattern: string; category_id: number }[];
  const defaultRules = db.prepare(
    "SELECT pattern, category_id FROM rules WHERE source = 'default' ORDER BY LENGTH(pattern) DESC"
  ).all() as { pattern: string; category_id: number }[];
  const uncategorized = nameToId.get('uncategorized') ?? 1;

  return (merchant, kind, bankCategory) => {
    if (kind === 'transfer') {
      const id = nameToId.get('transfer');
      if (id) return { categoryId: id, categorySource: 'default_rule' };
    }
    if (kind === 'income') {
      const id = nameToId.get('income');
      if (id) return { categoryId: id, categorySource: 'default_rule' };
    }

    const merchantLower = merchant.toLowerCase();

    for (const r of userRules) {
      const p = r.pattern.toLowerCase();
      if (merchantLower === p || matchesWholeWord(merchantLower, p)) {
        return { categoryId: r.category_id, categorySource: 'user_rule' };
      }
    }

    for (const r of defaultRules) {
      if (matchesWholeWord(merchantLower, r.pattern.toLowerCase())) {
        return { categoryId: r.category_id, categorySource: 'default_rule' };
      }
    }

    if (bankCategory) {
      const mapped = CHASE_CATEGORY_MAP[bankCategory.trim().toLowerCase()];
      const id = mapped ? nameToId.get(mapped.toLowerCase()) : undefined;
      if (id) return { categoryId: id, categorySource: 'bank' };
    }

    return { categoryId: uncategorized, categorySource: 'uncategorized' };
  };
}

export function categoryIdByName(db: Db, name: string): number {
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number } | undefined;
  if (!row) throw new Error(`Missing system category "${name}"`);
  return row.id;
}
