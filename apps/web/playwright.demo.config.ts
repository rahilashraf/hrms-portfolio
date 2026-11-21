import { defineConfig, devices } from '@playwright/test';

/**
 * Batch 11 — the demo smoke suite (e2e-demo/) against a running local demo (`pnpm demo`):
 * every demo account signs in and reaches its pages with the seeded data, and organization
 * isolation holds. It starts no server and never seeds: run `pnpm demo` first.
 *
 *   pnpm --filter web test:e2e:demo
 *
 * DEMO_WEB_URL overrides the web address (default http://localhost:3000).
 */
export default defineConfig({
  testDir: './e2e-demo',
  // One sign-in per account, in order: the API limits sign-ins to 10 a minute per address.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: {
    baseURL: process.env.DEMO_WEB_URL ?? 'http://localhost:3000',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    trace: 'off',
  },
  outputDir: './test-results-demo',
});
