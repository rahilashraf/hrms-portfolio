import { CONNECTION_OVERRIDES, LOCAL_HOSTS } from '../demo/demo-database.js';

/**
 * R5-A / R5-B — the local development seed (`pnpm db:seed`) creates a known test account
 * (`admin@local.test` with a published password), so it runs only against a database that looks
 * like a local development database, checked in layers:
 *
 * 1. Configuration (`assertLocalSeedDatabase`): never NODE_ENV=production; a PostgreSQL URL whose
 *    host is localhost / 127.0.0.1 / ::1, with no connection parameters in the query string that
 *    could send a local-looking URL elsewhere (`?host=`, `?port=`, `?dbname=`…); and a database
 *    named `hrms` or `<name>_dev`. That refuses the hosted default (`railway`), `postgres`, the
 *    demo (`*_demo`) and the disposable test databases (`*_disposable`, `*_test`).
 * 2. Identity (`assertSeedIdentity`): the database the connection actually reached
 *    (`current_database()`, read on the same connection the seed writes with) is the one the URL
 *    names.
 * 3. Existing accounts (`assertSeedMayCreate`): before creating the account, a database that
 *    already holds other accounts is refused unless `HRMS_DEV_SEED_CONFIRM` equals its name, since
 *    it may not be a development database at all.
 *
 * A local host does not make a database disposable: a tunnel or proxy on localhost can lead to a
 * remote or production database. These checks reduce accidental writes; they do not prove a
 * database is a development one. Docker Compose and the CI service containers are reached on
 * localhost and use `hrms`, so both keep working.
 */
export class UnsafeSeedDatabaseError extends Error {
  constructor(reason: string) {
    super(`Refusing to run the local development seed: ${reason}`);
    this.name = 'UnsafeSeedDatabaseError';
  }
}

/** `hrms` (the documented development database) or a lowercase name ending in `_dev`. */
export const DEV_DATABASE_NAME = /^(?:hrms|[a-z][a-z0-9_]{0,50}_dev)$/;

/** The environment variable that confirms seeding a database that already holds accounts. */
export const SEED_CONFIRM_VARIABLE = 'HRMS_DEV_SEED_CONFIRM';

export function assertLocalSeedDatabase(environment: NodeJS.ProcessEnv): {
  host: string;
  databaseName: string;
} {
  if (environment.NODE_ENV === 'production') {
    throw new UnsafeSeedDatabaseError('NODE_ENV is production.');
  }
  const url = environment.DATABASE_URL;
  if (!url) throw new UnsafeSeedDatabaseError('DATABASE_URL is not set.');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeSeedDatabaseError('DATABASE_URL is not a valid URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new UnsafeSeedDatabaseError('DATABASE_URL must be a PostgreSQL URL.');
  }
  const redirecting = [...parsed.searchParams.keys()].filter((key) =>
    CONNECTION_OVERRIDES.has(key.toLowerCase()),
  );
  if (redirecting.length > 0) {
    throw new UnsafeSeedDatabaseError(
      `DATABASE_URL must not set the connection parameter(s) ${redirecting.join(', ')}.`,
    );
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new UnsafeSeedDatabaseError(
      `the database host must be this machine (got "${parsed.hostname || '(none)'}").`,
    );
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    throw new UnsafeSeedDatabaseError(
      'the database name in DATABASE_URL is not valid.',
    );
  }
  if (!DEV_DATABASE_NAME.test(databaseName)) {
    throw new UnsafeSeedDatabaseError(
      `the database name must be "hrms" or end in "_dev" (got "${databaseName || '(none)'}").`,
    );
  }
  return { host: parsed.hostname, databaseName };
}

/** Layer 2: the connection reached the database the URL names. */
export function assertSeedIdentity(
  connectedDatabase: string | null | undefined,
  expectedDatabase: string,
) {
  if (connectedDatabase !== expectedDatabase) {
    throw new UnsafeSeedDatabaseError(
      `connected to "${connectedDatabase ?? '(unknown)'}", not "${expectedDatabase}".`,
    );
  }
}

/**
 * Layer 3, checked only when the account is about to be created: a database that already holds
 * other accounts needs `HRMS_DEV_SEED_CONFIRM=<its exact name>` (a generic value such as `1` or
 * `true` is not a confirmation).
 */
export function assertSeedMayCreate(
  state: { databaseName: string; otherAccounts: number },
  environment: NodeJS.ProcessEnv,
) {
  if (state.otherAccounts === 0) return;
  if (environment[SEED_CONFIRM_VARIABLE] === state.databaseName) return;
  throw new UnsafeSeedDatabaseError(
    `"${state.databaseName}" already holds ${state.otherAccounts} account(s) and no admin@local.test, so it may not be a development database. To seed it anyway, run: ${SEED_CONFIRM_VARIABLE}=${state.databaseName} pnpm db:seed`,
  );
}
