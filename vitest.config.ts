import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Loads SQLite (WebAssembly) before the tests; every test uses an in-memory database, never real data
    setupFiles: ['tests/setup-sqlite.ts'],
    include: ['tests/**/*.test.ts']
  }
});
