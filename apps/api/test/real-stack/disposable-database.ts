/**
 * Guards for the real-stack Playwright database (Batch 4, PR 4.0).
 *
 * The real-stack seed writes to a database and the real-stack API serves from it, so both run
 * only against a database that is *provably* a disposable test database. Three independent
 * layers, each sufficient to refuse on its own:
 *
 * 1. Configuration (`assertDisposableDatabaseUrl`): REAL_STACK_E2E=1, NODE_ENV isn't
 *    production, the host is this machine, and the database name ends in `_disposable`. An
 *    ordinary development database (`hrms` in .env.example) or a hosted one (`railway`) fails here.
 * 2. Identity (`assertDisposableIdentity`), read from the database itself: the connection really
 *    is that database, it carries the disposable-test marker (a database comment written only by
 *    `markDisposableDatabase`), and it holds no account or organization other than the real-stack
 *    seed's own. A production database reached through a local tunnel (which passes the host check)
 *    fails here: it has no marker and has real accounts.
 * 3. Marking (`markDisposableDatabase`) is itself guarded by layer 1 and only marks a database
 *    with no accounts at all, i.e. freshly created and migrated. CI runs it on the job's own
 *    service container.
 *
 * Nothing here deletes or changes data except the marker comment. Seeded data persists until the
 * disposable database is dropped or recreated.
 */

export const DISPOSABLE_DATABASE_MARKER = 'hrms:disposable-test-database';
/** A lowercase identifier ending in `_disposable`, e.g. `hrms_e2e_disposable`. */
export const DISPOSABLE_DATABASE_NAME = /^[a-z][a-z0-9_]{0,50}_disposable$/;
/** Accounts the real-stack seed creates (and the only ones a disposable database may hold). */
export const REAL_STACK_EMAIL_DOMAIN = '@real-stack.test';
/** Organization codes the real-stack seed creates. */
export const REAL_STACK_ORGANIZATION_CODE_PREFIX = 'RS-';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class UnsafeDatabaseError extends Error {
  constructor(reason: string) {
    super(`Refusing to use this database for real-stack tests: ${reason}`);
    this.name = 'UnsafeDatabaseError';
  }
}

/** Layer 1: the configuration alone. Returns the URL and the database it names. */
export function assertDisposableDatabaseUrl(environment: NodeJS.ProcessEnv) {
  if (environment.REAL_STACK_E2E !== '1') {
    throw new UnsafeDatabaseError('REAL_STACK_E2E=1 is required.');
  }
  if (environment.NODE_ENV === 'production') {
    throw new UnsafeDatabaseError('NODE_ENV is production.');
  }
  const url = environment.DATABASE_URL;
  if (!url) throw new UnsafeDatabaseError('DATABASE_URL is not set.');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeDatabaseError('DATABASE_URL is not a valid URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new UnsafeDatabaseError('DATABASE_URL must be a PostgreSQL URL.');
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new UnsafeDatabaseError(
      `the host must be this machine (got "${parsed.hostname}").`,
    );
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!DISPOSABLE_DATABASE_NAME.test(databaseName)) {
    throw new UnsafeDatabaseError(
      `the database name must end in "_disposable" (got "${databaseName || '(none)'}").`,
    );
  }
  return { url, databaseName };
}

export interface DatabaseIdentity {
  /** current_database() as the server reports it. */
  databaseName: string;
  /** The database's comment (null when it has none). */
  marker: string | null;
  /** Accounts whose email isn't a real-stack seed address. */
  foreignAccounts: number;
  /** Organizations whose code isn't a real-stack seed code. */
  foreignOrganizations: number;
  /** Every account, seeded or not (marking requires none). */
  totalAccounts: number;
}

/** Layer 2: what the database itself says. */
export function assertDisposableIdentity(
  identity: DatabaseIdentity,
  expectedDatabaseName: string,
) {
  if (identity.databaseName !== expectedDatabaseName) {
    throw new UnsafeDatabaseError(
      `connected to "${identity.databaseName}", not "${expectedDatabaseName}".`,
    );
  }
  if (identity.marker !== DISPOSABLE_DATABASE_MARKER) {
    throw new UnsafeDatabaseError(
      `"${identity.databaseName}" isn't marked as a disposable test database (on a new, migrated database, run: tsx test/real-stack/disposable-database-cli.ts mark).`,
    );
  }
  if (identity.foreignAccounts > 0 || identity.foreignOrganizations > 0) {
    throw new UnsafeDatabaseError(
      `"${identity.databaseName}" holds ${identity.foreignAccounts} account(s) and ${identity.foreignOrganizations} organization(s) the real-stack seed didn't create.`,
    );
  }
}

/** The raw-query surface the guards need (PrismaService or a transaction client). */
export interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Reads the identity. Tables that don't exist yet (an unmigrated database) count as empty. */
export async function readDatabaseIdentity(
  client: RawQueryClient,
): Promise<DatabaseIdentity> {
  const [row] = await client.$queryRawUnsafe<
    Array<{
      databaseName: string;
      marker: string | null;
      hasUsers: boolean;
      hasOrganizations: boolean;
    }>
  >(
    `SELECT current_database() AS "databaseName",
            shobj_description(d.oid, 'pg_database') AS "marker",
            to_regclass('"User"') IS NOT NULL AS "hasUsers",
            to_regclass('"Organization"') IS NOT NULL AS "hasOrganizations"
       FROM pg_database d
      WHERE d.datname = current_database()`,
  );
  if (!row)
    throw new UnsafeDatabaseError('the database could not be identified.');
  const count = async (sql: string, ...values: string[]) =>
    Number(
      (
        await client.$queryRawUnsafe<Array<{ count: bigint | number }>>(
          sql,
          ...values,
        )
      )[0]?.count ?? 0,
    );
  return {
    databaseName: row.databaseName,
    marker: row.marker,
    foreignAccounts: row.hasUsers
      ? await count(
          `SELECT count(*) AS "count" FROM "User" WHERE email NOT LIKE '%' || $1`,
          REAL_STACK_EMAIL_DOMAIN,
        )
      : 0,
    foreignOrganizations: row.hasOrganizations
      ? await count(
          `SELECT count(*) AS "count" FROM "Organization" WHERE code NOT LIKE $1 || '%'`,
          REAL_STACK_ORGANIZATION_CODE_PREFIX,
        )
      : 0,
    // Only queried once the table is known to exist: PostgreSQL resolves every table a
    // statement names, even in a branch that never runs.
    totalAccounts: row.hasUsers
      ? await count(`SELECT count(*) AS "count" FROM "User"`)
      : 0,
  };
}

/** Layers 1 and 2 against a live connection. */
export async function assertDisposableDatabase(
  client: RawQueryClient,
  environment: NodeJS.ProcessEnv,
) {
  const { databaseName } = assertDisposableDatabaseUrl(environment);
  assertDisposableIdentity(await readDatabaseIdentity(client), databaseName);
}

/**
 * Layer 3: writes the marker on a local `*_disposable` database that holds no accounts at all.
 * Idempotent on a database that is already marked and still holds only seed data.
 */
export async function markDisposableDatabase(
  client: RawQueryClient,
  environment: NodeJS.ProcessEnv,
) {
  const { databaseName } = assertDisposableDatabaseUrl(environment);
  const identity = await readDatabaseIdentity(client);
  if (identity.databaseName !== databaseName) {
    throw new UnsafeDatabaseError(
      `connected to "${identity.databaseName}", not "${databaseName}".`,
    );
  }
  if (identity.marker === DISPOSABLE_DATABASE_MARKER) {
    assertDisposableIdentity(identity, databaseName);
    return { databaseName, marked: false };
  }
  if (identity.totalAccounts > 0 || identity.foreignOrganizations > 0) {
    throw new UnsafeDatabaseError(
      `"${databaseName}" already holds data; only a new, migrated database can be marked.`,
    );
  }
  // The name matched DISPOSABLE_DATABASE_NAME (lowercase letters, digits, underscores), so it is
  // a plain identifier; quoted anyway.
  await client.$executeRawUnsafe(
    `COMMENT ON DATABASE "${databaseName}" IS '${DISPOSABLE_DATABASE_MARKER}'`,
  );
  return { databaseName, marked: true };
}
