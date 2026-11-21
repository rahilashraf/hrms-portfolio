/**
 * Batch 11 — guards for the demonstration database.
 *
 * The demo seed writes synthetic data, and `demo reset` drops and recreates a database, so both
 * run only against a database that is *provably* a demonstration database. Each layer is
 * sufficient to refuse on its own:
 *
 * 1. Configuration (`assertDemoDatabaseUrl`): NODE_ENV isn't production; DATABASE_URL is a
 *    PostgreSQL URL whose database name ends in `_demo` (e.g. `hrms_demo`). An ordinary
 *    development database (`hrms`) or a hosted default (`railway`) fails here. The host must be
 *    this machine unless HRMS_DEMO_ALLOW_REMOTE=1 is set (a separate hosted demo database);
 *    reset never accepts a remote host.
 * 2. Identity (`assertDemoIdentity`), read from the database itself: the connection really is
 *    that database, it carries the demo marker (a database comment written only by
 *    `markDemoDatabase`), every account and organization in it is a demo one (accounts at
 *    `@demo.harbourline.test`, organization codes starting `HL-`), every person is a demo
 *    account or a demo organization's employee, and every employee has an assignment in a demo
 *    organization. A production database reached through a tunnel or a mistyped URL fails here:
 *    it has no marker and has real accounts.
 * 3. Marking (`markDemoDatabase`) is itself guarded by layer 1 and marks only a database whose
 *    application tables are all empty (Prisma's `_prisma_migrations` history aside), i.e. freshly
 *    created and migrated. Empty account and organization tables alone are not enough, and an
 *    unmigrated database (which has no tables to be non-empty) is refused: its migration history
 *    must record every repository migration as applied (`assertMigrationsApplied`).
 *
 * Reset (`assertResetAllowed`) additionally requires a local host and an explicit confirmation
 * equal to the database name. There is no code path that resets a remote database.
 *
 * The marker also records the demo's reference date (the Monday the first seed ran), so reruns
 * on later days place every dated record on the same days and never duplicate them.
 */

export const DEMO_MARKER_PREFIX = 'hrms:demo-database';
/** A lowercase identifier ending in `_demo`, e.g. `hrms_demo`. */
export const DEMO_DATABASE_NAME = /^[a-z][a-z0-9_]{0,50}_demo$/;
/** Every demo account uses this reserved (RFC 2606 `.test`) domain. */
export const DEMO_EMAIL_DOMAIN = '@demo.harbourline.test';
/** Every demo organization code starts with this prefix. */
export const DEMO_ORGANIZATION_CODE_PREFIX = 'HL-';

export const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);
/**
 * URL query parameters that change where, or as whom, the driver connects. TLS parameters
 * (`sslmode`, `sslrootcert`, `sslcert`, `sslkey`) stay allowed: they only choose local
 * certificate files and cannot redirect the connection.
 */
export const CONNECTION_OVERRIDES: ReadonlySet<string> = new Set([
  'host',
  'hostaddr',
  'port',
  'dbname',
  'database',
  'user',
  'password',
  'service',
  'options',
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class UnsafeDemoDatabaseError extends Error {
  constructor(reason: string) {
    super(`Refusing to use this database for demonstration data: ${reason}`);
    this.name = 'UnsafeDemoDatabaseError';
  }
}

export interface DemoDatabaseTarget {
  url: string;
  databaseName: string;
  host: string;
  local: boolean;
}

/** Layer 1: the configuration alone. */
export function assertDemoDatabaseUrl(
  environment: NodeJS.ProcessEnv,
): DemoDatabaseTarget {
  if (environment.NODE_ENV === 'production') {
    throw new UnsafeDemoDatabaseError('NODE_ENV is production.');
  }
  const url = environment.DATABASE_URL;
  if (!url) throw new UnsafeDemoDatabaseError('DATABASE_URL is not set.');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeDemoDatabaseError('DATABASE_URL is not a valid URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new UnsafeDemoDatabaseError('DATABASE_URL must be a PostgreSQL URL.');
  }
  // Batch 11C: the driver (pg-connection-string) applies query parameters over the URL itself,
  // so `?host=` (or port, database, user, service…) could send a URL that looks local to another
  // server. Such parameters are never needed for the demo and are refused outright.
  const redirecting = [...parsed.searchParams.keys()].filter((key) =>
    CONNECTION_OVERRIDES.has(key.toLowerCase()),
  );
  if (redirecting.length > 0) {
    throw new UnsafeDemoDatabaseError(
      `DATABASE_URL must not set the connection parameter(s) ${redirecting.join(', ')}; put the host, port, database and user in the URL itself.`,
    );
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!DEMO_DATABASE_NAME.test(databaseName)) {
    throw new UnsafeDemoDatabaseError(
      `the database name must end in "_demo" (got "${databaseName || '(none)'}").`,
    );
  }
  const local = LOCAL_HOSTS.has(parsed.hostname);
  if (!local && environment.HRMS_DEMO_ALLOW_REMOTE !== '1') {
    throw new UnsafeDemoDatabaseError(
      `the host must be this machine (got "${parsed.hostname}"); a separate hosted demo database also needs HRMS_DEMO_ALLOW_REMOTE=1.`,
    );
  }
  return { url, databaseName, host: parsed.hostname, local };
}

/** The marker comment, with the demo's reference date. */
export function demoMarker(referenceDate: string) {
  if (!ISO_DATE.test(referenceDate)) {
    throw new Error(`Invalid demo reference date "${referenceDate}".`);
  }
  return `${DEMO_MARKER_PREFIX};reference=${referenceDate}`;
}

/** The reference date a marker records, or null when the comment isn't a demo marker. */
export function parseDemoMarker(marker: string | null): string | null {
  if (!marker?.startsWith(`${DEMO_MARKER_PREFIX};reference=`)) return null;
  const date = marker.slice(`${DEMO_MARKER_PREFIX};reference=`.length);
  return ISO_DATE.test(date) ? date : null;
}

export interface DemoDatabaseIdentity {
  databaseName: string;
  marker: string | null;
  /** Accounts whose email isn't a demo address. */
  foreignAccounts: number;
  /** Organizations whose code isn't a demo code. */
  foreignOrganizations: number;
  totalAccounts: number;
  totalOrganizations: number;
  /**
   * People who are neither a demo account nor an employee of a demo organization (Batch 11B:
   * application data can exist with no account or organization at all).
   */
  foreignPeople: number;
  /** Employees with no assignment in a demo organization. */
  foreignEmployees: number;
}

/** Layer 2: what the database itself says. Returns the recorded reference date. */
export function assertDemoIdentity(
  identity: DemoDatabaseIdentity,
  expectedDatabaseName: string,
): string {
  if (identity.databaseName !== expectedDatabaseName) {
    throw new UnsafeDemoDatabaseError(
      `connected to "${identity.databaseName}", not "${expectedDatabaseName}".`,
    );
  }
  const referenceDate = parseDemoMarker(identity.marker);
  if (!referenceDate) {
    throw new UnsafeDemoDatabaseError(
      `"${identity.databaseName}" isn't marked as a demonstration database (only a new, migrated, empty database can be marked; see docs/development/demo.md).`,
    );
  }
  if (identity.foreignAccounts > 0 || identity.foreignOrganizations > 0) {
    throw new UnsafeDemoDatabaseError(
      `"${identity.databaseName}" holds ${identity.foreignAccounts} account(s) and ${identity.foreignOrganizations} organization(s) that aren't demonstration data.`,
    );
  }
  if (identity.foreignPeople > 0 || identity.foreignEmployees > 0) {
    throw new UnsafeDemoDatabaseError(
      `"${identity.databaseName}" holds ${identity.foreignPeople} person record(s) and ${identity.foreignEmployees} employee(s) that aren't demonstration data.`,
    );
  }
  return referenceDate;
}

/** The raw-query surface the guards need (PrismaService or a transaction client). */
export interface RawQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Reads the identity. Tables that don't exist yet (an unmigrated database) count as empty. */
export async function readDemoIdentity(
  client: RawQueryClient,
): Promise<DemoDatabaseIdentity> {
  const [row] = await client.$queryRawUnsafe<
    Array<{
      databaseName: string;
      marker: string | null;
      hasUsers: boolean;
      hasOrganizations: boolean;
      hasPeople: boolean;
    }>
  >(
    `SELECT current_database() AS "databaseName",
            shobj_description(d.oid, 'pg_database') AS "marker",
            to_regclass('"User"') IS NOT NULL AS "hasUsers",
            to_regclass('"Organization"') IS NOT NULL AS "hasOrganizations",
            (to_regclass('"Person"') IS NOT NULL
              AND to_regclass('"Employee"') IS NOT NULL
              AND to_regclass('"EmploymentAssignment"') IS NOT NULL
              AND to_regclass('"Position"') IS NOT NULL) AS "hasPeople"
       FROM pg_database d
      WHERE d.datname = current_database()`,
  );
  if (!row) {
    throw new UnsafeDemoDatabaseError('the database could not be identified.');
  }
  const count = async (sql: string, ...values: string[]) =>
    Number(
      (
        await client.$queryRawUnsafe<Array<{ count: bigint | number }>>(
          sql,
          ...values,
        )
      )[0]?.count ?? 0,
    );
  // Only queried once the table is known to exist: PostgreSQL resolves every table a statement
  // names, even in a branch that never runs.
  return {
    databaseName: row.databaseName,
    marker: row.marker,
    foreignAccounts: row.hasUsers
      ? await count(
          `SELECT count(*) AS "count" FROM "User" WHERE lower(email) NOT LIKE '%' || $1`,
          DEMO_EMAIL_DOMAIN,
        )
      : 0,
    foreignOrganizations: row.hasOrganizations
      ? await count(
          `SELECT count(*) AS "count" FROM "Organization" WHERE code NOT LIKE $1 || '%'`,
          DEMO_ORGANIZATION_CODE_PREFIX,
        )
      : 0,
    totalAccounts: row.hasUsers
      ? await count(`SELECT count(*) AS "count" FROM "User"`)
      : 0,
    totalOrganizations: row.hasOrganizations
      ? await count(`SELECT count(*) AS "count" FROM "Organization"`)
      : 0,
    foreignPeople:
      row.hasPeople && row.hasUsers && row.hasOrganizations
        ? await count(
            `SELECT count(*) AS "count" FROM "Person" p
              WHERE NOT EXISTS (SELECT 1 FROM "User" u
                                 WHERE u."personId" = p.id AND lower(u.email) LIKE '%' || $1)
                AND NOT EXISTS (${DEMO_EMPLOYEE_SQL.replace('$EMPLOYEE', 'e."personId" = p.id')})`,
            DEMO_EMAIL_DOMAIN,
            DEMO_ORGANIZATION_CODE_PREFIX,
          )
        : 0,
    foreignEmployees:
      row.hasPeople && row.hasOrganizations
        ? await count(
            `SELECT count(*) AS "count" FROM "Employee" outer_e
              WHERE NOT EXISTS (${DEMO_EMPLOYEE_SQL.replace('$EMPLOYEE', 'e.id = outer_e.id').replace('$2', '$1')})`,
            DEMO_ORGANIZATION_CODE_PREFIX,
          )
        : 0,
  };
}

/** An employee (matching $EMPLOYEE) with an assignment in a demo organization ($2 = prefix). */
const DEMO_EMPLOYEE_SQL = `SELECT 1 FROM "Employee" e
   JOIN "EmploymentAssignment" a ON a."employeeId" = e.id
   JOIN "Position" po ON po.id = a."positionId"
   JOIN "Organization" o ON o.id = po."organizationId"
  WHERE $EMPLOYEE AND o.code LIKE $2 || '%'`;

/**
 * Batch 11B: the application tables that hold any row. Only a database where this is empty
 * (apart from Prisma's own migration history) can be marked: an empty User or Organization
 * table alone doesn't prove the database holds no application data.
 */
export async function readNonEmptyTables(
  client: RawQueryClient,
): Promise<string[]> {
  const tables = await client.$queryRawUnsafe<
    Array<{ schema: string; name: string }>
  >(
    // pg_class rather than information_schema.tables: the latter silently omits tables this role
    // has no privilege on (which would then count as empty), and materialized views. A table
    // the role cannot read now fails the EXISTS below with "permission denied" instead.
    // relkind: r = table (including partitions), p = partitioned table, m = materialized view.
    `SELECT n.nspname AS "schema", c.relname AS "name"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'm')
        AND n.nspname <> 'information_schema'
        AND n.nspname NOT LIKE 'pg\\_%'
        AND c.relname <> '_prisma_migrations'
      ORDER BY 1, 2`,
  );
  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
  const nonEmpty: string[] = [];
  for (const table of tables) {
    const [row] = await client.$queryRawUnsafe<Array<{ found: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM ${quote(table.schema)}.${quote(table.name)}) AS "found"`,
    );
    if (row?.found) nonEmpty.push(`${table.schema}.${table.name}`);
  }
  return nonEmpty;
}

/** A `_prisma_migrations` row, as the guard reads it. */
export interface AppliedMigrationRow {
  name: string;
  finished: boolean;
  rolledBack: boolean;
}

/** Prisma's migration history, or null when the database has none (it was never migrated). */
export async function readMigrationHistory(
  client: RawQueryClient,
): Promise<AppliedMigrationRow[] | null> {
  const [table] = await client.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT to_regclass('_prisma_migrations') IS NOT NULL AS "exists"`,
  );
  if (!table?.exists) return null;
  return client.$queryRawUnsafe<AppliedMigrationRow[]>(
    `SELECT migration_name AS "name",
            finished_at IS NOT NULL AS "finished",
            rolled_back_at IS NOT NULL AS "rolledBack"
       FROM "_prisma_migrations"
      ORDER BY started_at`,
  );
}

/**
 * R5-A: the database is migrated exactly to this repository's migrations, as `prisma migrate
 * deploy` leaves it: every migration directory is recorded as finished (a rolled-back attempt
 * doesn't count; its successful reapplication does), no attempt failed without being rolled
 * back, and nothing was applied that this repository doesn't have.
 */
export function assertMigrationsApplied(
  history: readonly AppliedMigrationRow[] | null,
  expected: readonly string[],
  databaseName: string,
) {
  const advice =
    'run `pnpm db:migrate:deploy` against it first (pnpm demo does this).';
  if (expected.length === 0) {
    throw new UnsafeDemoDatabaseError(
      'no migrations were found in the repository; cannot check the database.',
    );
  }
  if (history === null) {
    throw new UnsafeDemoDatabaseError(
      `"${databaseName}" has not been migrated; ${advice}`,
    );
  }
  const list = (names: string[]) =>
    `${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`;
  const failed = history
    .filter((row) => !row.finished && !row.rolledBack)
    .map((row) => row.name);
  if (failed.length > 0) {
    throw new UnsafeDemoDatabaseError(
      `"${databaseName}" has a failed migration (${list(failed)}); resolve it before marking.`,
    );
  }
  const applied = new Set(
    history.filter((row) => row.finished).map((row) => row.name),
  );
  const known = new Set(expected);
  const unknown = [...applied].filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new UnsafeDemoDatabaseError(
      `"${databaseName}" has migrations unknown to this repository (${list(unknown)}); it was migrated by other code.`,
    );
  }
  const missing = expected.filter((name) => !applied.has(name));
  if (missing.length > 0) {
    throw new UnsafeDemoDatabaseError(
      `"${databaseName}" is not fully migrated: ${missing.length} of ${expected.length} migrations are not applied (${list(missing)}); ${advice}`,
    );
  }
}

/** Layers 1 and 2 against a live connection. Returns the target and the reference date. */
export async function assertDemoDatabase(
  client: RawQueryClient,
  environment: NodeJS.ProcessEnv,
) {
  const target = assertDemoDatabaseUrl(environment);
  const referenceDate = assertDemoIdentity(
    await readDemoIdentity(client),
    target.databaseName,
  );
  return { ...target, referenceDate };
}

/**
 * Layer 3: writes the marker (with the reference date) on a `*_demo` database whose application
 * tables are all empty (Batch 11B: not only accounts and organizations) and whose migration
 * history records exactly `expectedMigrations` (R5-A: the repository's migration directory
 * names) as applied. On a database that is already marked and still holds only demonstration
 * data it changes nothing and returns the recorded reference date.
 */
export async function markDemoDatabase(
  client: RawQueryClient,
  environment: NodeJS.ProcessEnv,
  referenceDate: string,
  expectedMigrations: readonly string[],
) {
  const target = assertDemoDatabaseUrl(environment);
  const identity = await readDemoIdentity(client);
  if (identity.databaseName !== target.databaseName) {
    throw new UnsafeDemoDatabaseError(
      `connected to "${identity.databaseName}", not "${target.databaseName}".`,
    );
  }
  if (parseDemoMarker(identity.marker)) {
    const recorded = assertDemoIdentity(identity, target.databaseName);
    return { ...target, referenceDate: recorded, marked: false };
  }
  if (identity.totalAccounts > 0 || identity.totalOrganizations > 0) {
    throw new UnsafeDemoDatabaseError(
      `"${target.databaseName}" already holds data and has no demo marker; only a new, migrated, empty database can be marked.`,
    );
  }
  // Batch 11B: empty User and Organization tables aren't enough; every application table must
  // be empty (people, employees, payroll… can exist without either).
  const nonEmpty = await readNonEmptyTables(client);
  if (nonEmpty.length > 0) {
    throw new UnsafeDemoDatabaseError(
      `"${target.databaseName}" already holds data (${nonEmpty.slice(0, 5).join(', ')}${nonEmpty.length > 5 ? ', …' : ''}) and has no demo marker; only a new, migrated, empty database can be marked.`,
    );
  }
  // R5-A: an unmigrated database has no application tables, so the check above can't refuse it.
  assertMigrationsApplied(
    await readMigrationHistory(client),
    expectedMigrations,
    target.databaseName,
  );
  // The name matched DEMO_DATABASE_NAME and the marker is built from an ISO date, so both are
  // plain literals; quoted anyway.
  await client.$executeRawUnsafe(
    `COMMENT ON DATABASE "${target.databaseName}" IS '${demoMarker(referenceDate)}'`,
  );
  return { ...target, referenceDate, marked: true };
}

/**
 * Reset precondition (checked before anything is dropped): a local `*_demo` database, an
 * explicit confirmation equal to its name, and — when it exists — the demo marker with only
 * demonstration data inside.
 */
export function assertResetAllowed(
  environment: NodeJS.ProcessEnv,
  confirmation: string | undefined,
  identity: DemoDatabaseIdentity | null,
) {
  const target = assertDemoDatabaseUrl(environment);
  if (!target.local) {
    throw new UnsafeDemoDatabaseError(
      `reset only works on a database on this machine (got "${target.host}"); recreate a hosted demo database through its provider instead.`,
    );
  }
  if (confirmation !== target.databaseName) {
    throw new UnsafeDemoDatabaseError(
      `reset needs the explicit confirmation --confirm ${target.databaseName}.`,
    );
  }
  if (identity) assertDemoIdentity(identity, target.databaseName);
  return target;
}

/** The Monday on or before a date (YYYY-MM-DD), the demo's reference date. */
export function mondayOnOrBefore(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day!));
  const weekday = (value.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  value.setUTCDate(value.getUTCDate() - weekday);
  return value.toISOString().slice(0, 10);
}
