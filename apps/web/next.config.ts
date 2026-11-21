import type { NextConfig } from 'next';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { getApiBaseUrl } from './src/lib/api-config';
import { securityHeaderRules } from './src/lib/security/page-headers';

const rootEnvPath = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnvPath)) {
  loadEnvFile(rootEnvPath);
}

const apiOrigin = new URL(getApiBaseUrl()).origin;

const nextConfig: NextConfig = {
  /**
   * Phase 20 — the application has two root layouts (app and kiosk), so unmatched URLs use
   * app/global-not-found.tsx.
   */
  experimental: { globalNotFound: true },
  /** Development only: `next dev` does not generate rule files in this directory. */
  agentRules: false,
  /**
   * Batch R2: a Content Security Policy and baseline headers on every page; Phase 9.5 kiosk and
   * Batch 2 sign-in, recovery and account pages are also never cached or indexed and send no
   * referrer (src/lib/security/page-headers.ts). `next dev` adds what React Refresh needs.
   */
  async headers() {
    return securityHeaderRules({
      apiOrigin,
      development: process.env.NODE_ENV === 'development',
    });
  },
};

export default nextConfig;
