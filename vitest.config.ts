import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests must never open the real database or the real ~/.walletwhisper settings
    env: {
      SPENDING_DB_PATH: ':memory:',
      WALLETWHISPER_CONFIG: path.join(os.tmpdir(), `walletwhisper-test-${process.pid}`, 'config.json'),
      WALLETWHISPER_LEGACY_DIR: path.join(os.tmpdir(), `walletwhisper-test-${process.pid}`, 'no-legacy-data'),
    },
    include: ['tests/**/*.test.ts']
  }
});
