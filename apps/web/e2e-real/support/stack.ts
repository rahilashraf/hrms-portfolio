import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Loopback origins of the real-stack servers (never a deployed environment). */
export const REAL_STACK_WEB = 'http://127.0.0.1:3200';
export const REAL_STACK_API = 'http://127.0.0.1:3201';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The URL, if it names a service on this machine; throws otherwise. */
export function localServiceUrl(name: string, value: string | undefined) {
  if (!value) throw new Error(`${name} is required for the real-stack tests.`);
  const host = new URL(value).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run the real-stack tests: ${name} must point at this machine (got "${host}").`,
    );
  }
  return value;
}

/**
 * The database URL, if it names a local `*_disposable` database; throws otherwise. A first, quick
 * check only: the authoritative ones (the marker and the database's contents, read from the
 * database itself) run before seeding and before the API starts
 * (apps/api/test/real-stack/disposable-database.ts).
 */
export function disposableDatabaseUrl(value: string | undefined) {
  const url = localServiceUrl('DATABASE_URL', value);
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/^[a-z][a-z0-9_]{0,50}_disposable$/.test(name)) {
    throw new Error(
      `Refusing to run the real-stack tests: DATABASE_URL must name a "*_disposable" database (got "${name || '(none)'}").`,
    );
  }
  return url;
}

// One throwaway signing secret per test process; the API and nothing else ever sees it.
const jwtSecret = `rs-${randomBytes(32).toString('base64url')}`;
// Batch 9: uploaded document files go to local storage in a throwaway directory, with a
// throwaway download-link signing key (never S3, never a real bucket or credential).
const documentUrlSigningKey = randomBytes(32).toString('base64url');
export const REAL_STACK_DOCUMENT_DIR = join(tmpdir(), 'hrms-real-stack-documents');

function documentDirectory() {
  mkdirSync(REAL_STACK_DOCUMENT_DIR, { recursive: true, mode: 0o700 });
  return REAL_STACK_DOCUMENT_DIR;
}

/**
 * The API's environment: local database and Redis only, a throwaway JWT secret, the loopback
 * web origin, local document storage in a throwaway directory, and no email, Google, S3 or other
 * outside service configured.
 */
export function realStackApiEnvironment(environment: NodeJS.ProcessEnv) {
  return {
    NODE_ENV: 'test',
    PORT: new URL(REAL_STACK_API).port,
    DATABASE_URL: disposableDatabaseUrl(environment.DATABASE_URL),
    // The API is started only after the disposable-database check passes (see the config).
    REAL_STACK_E2E: '1',
    REDIS_URL: localServiceUrl('REDIS_URL', environment.REDIS_URL),
    JWT_ACCESS_SECRET: environment.REAL_STACK_JWT_SECRET ?? jwtSecret,
    WEB_ORIGIN: REAL_STACK_WEB,
    TRUST_PROXY_HOPS: '0',
    LOG_FORMAT: 'text',
    ARGON2_MEMORY_COST_KIB: environment.ARGON2_MEMORY_COST_KIB ?? '65536',
    ARGON2_TIME_COST: environment.ARGON2_TIME_COST ?? '3',
    ARGON2_PARALLELISM: environment.ARGON2_PARALLELISM ?? '1',
    DOCUMENT_STORAGE_DRIVER: 'local',
    DOCUMENT_STORAGE_LOCAL_DIR: documentDirectory(),
    DOCUMENT_URL_SIGNING_KEY: documentUrlSigningKey,
  };
}
