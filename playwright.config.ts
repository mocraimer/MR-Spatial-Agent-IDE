import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Unique per checkout so concurrent agents don't wipe each other's results.
const dirHash = createHash('sha1').update(fileURLToPath(import.meta.url)).digest('hex').slice(0, 8);

export default defineConfig({
  testDir: '.',
  testMatch: ['host/tests/**/companion.spec.ts', 'view/tests/**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 7000 },
  use: { browserName: 'chromium', headless: true, viewport: { width: 1280, height: 960 }, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } },
  outputDir: `/tmp/spatial-workspace-playwright-results-${dirHash}`,
  reporter: 'list',
});
