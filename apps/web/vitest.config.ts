import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    env: { NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001' },
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    restoreMocks: true,
  },
});
