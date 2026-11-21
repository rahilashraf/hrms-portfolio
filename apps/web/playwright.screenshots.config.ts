import { defineConfig, devices } from '@playwright/test';

/**
 * Batch 11 — the portfolio screenshot capture (e2e-demo/*.capture.ts) against a running local
 * demo (`pnpm demo`). Not a test suite: it writes docs/assets/screenshots/ and asserts nothing
 * beyond each page having loaded.
 *
 *   pnpm --filter web screenshots:demo
 */
export default defineConfig({
  testDir: './e2e-demo',
  testMatch: '*.capture.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  reporter: 'list',
  use: {
    baseURL: process.env.DEMO_WEB_URL ?? 'http://localhost:3000',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    trace: 'off',
  },
  outputDir: './test-results-demo',
});
