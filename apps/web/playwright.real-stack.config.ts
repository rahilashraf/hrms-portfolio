import { defineConfig, devices } from '@playwright/test';
import { REAL_STACK_API, REAL_STACK_WEB, realStackApiEnvironment } from './e2e-real/support/stack';

/**
 * Real-stack Playwright (Batch 4, PR 4.0): the browser drives the real web app, which calls the
 * real API, which uses a real PostgreSQL and Redis. Nothing is mocked.
 *
 * Disposable by construction:
 * - The API and web app are started here, on loopback ports, from this checkout.
 * - The database and Redis must be on this machine (CI service containers, or a local
 *   throwaway instance); e2e-real/support/stack.ts and the seed refuse anything else.
 * - Each run seeds a new organization with random names and passwords (global setup), so runs
 *   never depend on or change existing data. No production URL or credential is used.
 *
 * Requirements: `pnpm db:migrate:deploy` and `pnpm --filter api build` beforehand, and
 * DATABASE_URL / REDIS_URL in the environment. The web app runs under `next dev`, because a
 * production build insists on an HTTPS API origin (src/lib/api-config.ts).
 *
 * Run: pnpm --filter web test:e2e:real
 */
export default defineConfig({
  testDir: './e2e-real',
  forbidOnly: Boolean(process.env.CI),
  // One flow at a time: the specs share one API and database and follow one employee.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-real' }]]
    : 'list',
  globalSetup: './e2e-real/support/global-setup.ts',
  use: {
    baseURL: REAL_STACK_WEB,
    ...devices['Desktop Chrome'],
    // A fixed browser timezone, so runs don't depend on the machine's. The organization's own
    // timezone (from the seed) is deliberately a different one: the pages must show its times.
    timezoneId: 'UTC',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
  webServer: [
    {
      // The built API (pnpm --filter api build), started only if its database passes every
      // disposable-database check (local, `*_disposable`, marked, nothing but seed data).
      command:
        'pnpm --dir ../api exec tsx test/real-stack/disposable-database-cli.ts check && node ../api/dist/main.js',
      url: `${REAL_STACK_API}/health`,
      env: realStackApiEnvironment(process.env),
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `pnpm exec next dev --hostname 127.0.0.1 --port ${new URL(REAL_STACK_WEB).port}`,
      url: REAL_STACK_WEB,
      env: { NEXT_PUBLIC_API_URL: REAL_STACK_API, NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
  outputDir: './test-results-real',
});
