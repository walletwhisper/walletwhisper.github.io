import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests must never open the real data/app.db
    env: { SPENDING_DB_PATH: ':memory:' },
    include: ['tests/**/*.test.ts']
  }
});
