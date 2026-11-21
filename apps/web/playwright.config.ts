import { defineConfig, devices } from '@playwright/test';
import { API } from './e2e/support/api-origin';

/**
 * The specs mock the whole API (`page.route`). They run against a production build by default
 * (`next build` then `next start`, as deployed), which needs no API to exist: the build calls
 * the never-resolving origin in e2e/support/api-origin.ts. PLAYWRIGHT_DEV_SERVER=1 uses
 * `next dev` instead, for quicker local iteration.
 */
const devServer = process.env.PLAYWRIGHT_DEV_SERVER === '1';

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    ...devices['Desktop Chrome'],
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
  webServer: {
    command: devServer
      ? 'pnpm exec next dev --hostname 127.0.0.1 --port 3100'
      : 'pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100',
    env: { NEXT_PUBLIC_API_URL: API, NEXT_TELEMETRY_DISABLED: '1' },
    reuseExistingServer: false,
    timeout: devServer ? 120_000 : 600_000,
  },
  outputDir: './test-results',
});
