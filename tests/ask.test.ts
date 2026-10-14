import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { openDb } from '../src/db.js';
import { finishImports, importCsvContent } from '../src/importer.js';
import { answerQuestion } from '../src/ask.js';
import type { QuestionPlan } from '../src/llm.js';

const fixture = (name: string) => fs.readFileSync(path.resolve(__dirname, 'fixtures', name), 'utf8');

function loadedDb() {
  const db = openDb(':memory:');
  for (const f of ['Chase1234_Activity_20261031.CSV', 'Chase5678_Activity_20261031.CSV']) importCsvContent(db, f, fixture(f));
  finishImports(db);
  return db;
}

const plan = (p: Partial<QuestionPlan>): QuestionPlan => ({
  understood: true, clarification: null, from: '2026-10-01', to: '2026-10-31', periodLabel: 'October 2026',
  categories: [], person: null, merchant: null, ...p,
});

describe('Ask: answers are computed locally from the plan', () => {
  it('Q-01: merchant question nets refunds and compares with the previous month and last year', () => {
    const a = answerQuestion(loadedDb(), plan({ merchant: 'Amazon' }));
    if (!a.understood) throw new Error('expected an answer');
    expect(a.period.cents).toBe(4500 - 2000);
    expect(a.previous).toMatchObject({ label: 'September 2026', from: '2026-09-01', to: '2026-09-30', count: 0 });
    expect(a.lastYear).toMatchObject({ label: 'October 2025', from: '2025-10-01', to: '2025-10-31' });
    expect(a.months).toHaveLength(13);
    expect(a.months[12]).toMatchObject({ month: '2026-10', cents: 2500, inPeriod: true });
    expect(a.headline).toContain('$25.00');
  });

  it('Q-02: a category question only counts that category, and transactions hidden from charts are left out', () => {
    const db = loadedDb();
    const dining = (db.prepare("SELECT id FROM categories WHERE name = 'Dining'").get() as { id: number }).id;
    const expected = (db.prepare(`SELECT SUM(amount_cents) AS s FROM transactions WHERE category_id = ? AND kind IN ('spend','refund','fee')`)
      .get(dining) as { s: number }).s;
    const a = answerQuestion(db, plan({ categories: ['Dining'] }));
    if (!a.understood) throw new Error('expected an answer');
    expect(a.period.cents).toBe(expected);
    expect(a.byCategory).toEqual([]); // a single category needs no breakdown

    db.prepare("UPDATE transactions SET is_one_time = 1 WHERE raw_description LIKE '%SWEETGREEN%'").run();
    const b = answerQuestion(db, plan({ categories: ['Dining'] }));
    if (!b.understood) throw new Error('expected an answer');
    expect(b.period.cents).toBe(expected - 1450);
  });

  it('Q-03: a question that is not about spending gets a friendly suggestion', () => {
    const a = answerQuestion(loadedDb(), plan({ understood: false, clarification: 'Try asking about a category.' }));
    expect(a).toEqual({ understood: false, clarification: 'Try asking about a category.' });
  });
});
