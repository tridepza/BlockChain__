import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

const chromeInstalled = process.platform === 'win32' && [
  process.env.ProgramFiles,
  process.env['ProgramFiles(x86)'],
  process.env.LOCALAPPDATA,
].some(root => root && existsSync(join(root, 'Google/Chrome/Application/chrome.exe')));
const defaultChannel = !existsSync(chromium.executablePath()) && chromeInstalled ? 'chrome' : 'chromium';

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  globalSetup: './tests/start-vite.ts',
  workers: 1,
  timeout: 45_000,
  use: {
    channel: process.env.ESCROW_TEST_BROWSER || defaultChannel,
    trace: 'retain-on-failure',
  },
});
