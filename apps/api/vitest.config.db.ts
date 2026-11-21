import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.db-spec.ts'],
    // Database scenarios run real transactions (60s transaction timeouts) across parallel
    // files; the 5s default is too tight under that load.
    testTimeout: 60_000,
    // Batch R3.5: hooks build and remove committed fixtures (e.g. the M3 race specs' beforeEach,
    // a fixture transaction that itself allows 60s), under the same parallel load as the tests.
    // Vitest's 10s hook default was shorter than the transaction it wraps, so a slow setup
    // failed as "Hook timed out in 10000ms" while every test body had 60s.
    hookTimeout: 60_000,
  },
});
