import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  globalSetup: './tests/start-vite.ts',
  workers: 1,
  timeout: 45_000,
  use: {
    channel: process.env.ESCROW_TEST_BROWSER || 'chromium',
    trace: 'retain-on-failure',
  },
});
