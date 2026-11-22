import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['host/tests/**/companion.spec.ts', 'view/tests/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 7000 },
  use: { browserName: 'chromium', headless: true, viewport: { width: 1280, height: 960 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: '/tmp/spatial-workspace-playwright-results',
  reporter: 'list',
});
