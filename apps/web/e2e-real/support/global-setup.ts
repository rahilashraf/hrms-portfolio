import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { disposableDatabaseUrl } from './stack';
import { SEED_FILE } from './seed';

/**
 * Seeds a new, uniquely named organization for this run through the API package's seed script
 * (apps/api/test/real-stack/seed.ts), which itself refuses anything but a marked, local
 * `*_disposable` database. REAL_STACK_REFERENCE_INSTANT and REAL_STACK_TIMEZONE pass through,
 * to reproduce a run at a given instant or in another timezone.
 */
export default function globalSetup() {
  const databaseUrl = disposableDatabaseUrl(process.env.DATABASE_URL);
  execFileSync('pnpm', ['exec', 'tsx', 'test/real-stack/seed.ts'], {
    cwd: resolve(__dirname, '../../../api'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'test',
      REAL_STACK_E2E: '1',
      REAL_STACK_SEED_FILE: SEED_FILE,
    },
    stdio: 'inherit',
  });
  // Batch 8: bootstrap the event notification checkpoints now, so the flows that follow are
  // notified (history before a checkpoint never is).
  execFileSync('pnpm', ['exec', 'tsx', 'test/real-stack/notifications-cli.ts', 'publish'], {
    cwd: resolve(__dirname, '../../../api'),
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test', REAL_STACK_E2E: '1' },
    stdio: 'inherit',
  });
}
