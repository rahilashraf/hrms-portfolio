import { describe, expect, it, vi } from 'vitest';
import {
  assertDemoDatabase,
  assertDemoDatabaseUrl,
  assertDemoIdentity,
  assertMigrationsApplied,
  assertResetAllowed,
  demoMarker,
  markDemoDatabase,
  mondayOnOrBefore,
  parseDemoMarker,
  UnsafeDemoDatabaseError,
  type DemoDatabaseIdentity,
  type RawQueryClient,
} from './demo-database.js';

const LOCAL_URL = 'postgresql://hrms:pw@localhost:5436/hrms_demo?schema=public';
const LOCAL_ENV = { DATABASE_URL: LOCAL_URL };
const MARKED = demoMarker('2026-11-09');
/** The repository's migrations (their directory names), in order. */
const MIGRATIONS = [
  '20260101000000_init',
  '20260201000000_people',
  '20260301000000_payroll',
];
/** `_prisma_migrations` rows as `migrate deploy` leaves them: each finished, none rolled back. */
const APPLIED = MIGRATIONS.map((name) => ({
  name,
  finished: true,
  rolledBack: false,
}));
type MigrationRow = (typeof APPLIED)[number];

const CLEAN: DemoDatabaseIdentity = {
  databaseName: 'hrms_demo',
  marker: MARKED,
  foreignAccounts: 0,
  foreignOrganizations: 0,
  totalAccounts: 6,
  totalOrganizations: 2,
  foreignPeople: 0,
  foreignEmployees: 0,
};

/** A new, migrated database: every application table exists and is empty. */
const EMPTY: DemoDatabaseIdentity = {
  ...CLEAN,
  marker: null,
  totalAccounts: 0,
  totalOrganizations: 0,
};

/**
 * A fake connection answering the guards' queries. `tables` lists the application tables and
 * whether each holds a row (the pg_class listing and the per-table EXISTS).
 */
function fakeClient(
  identity: DemoDatabaseIdentity,
  tables: Record<string, boolean> = {
    User: identity.totalAccounts > 0,
    Organization: identity.totalOrganizations > 0,
  },
  /** The migration history; null when `_prisma_migrations` doesn't exist (never migrated). */
  migrations: MigrationRow[] | null = APPLIED,
) {
  const executed: string[] = [];
  const client: RawQueryClient = {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('current_database()')) {
        return [
          {
            databaseName: identity.databaseName,
            marker: identity.marker,
            hasUsers: true,
            hasOrganizations: true,
            hasPeople: true,
          },
        ];
      }
      if (sql.includes("to_regclass('_prisma_migrations')"))
        return [{ exists: migrations !== null }];
      if (sql.includes('FROM "_prisma_migrations"')) return migrations ?? [];
      if (sql.includes('FROM pg_class c')) {
        return Object.keys(tables).map((name) => ({ schema: 'public', name }));
      }
      const exists = sql.match(
        /SELECT EXISTS \(SELECT 1 FROM "public"\."([^"]+)"\)/,
      );
      if (exists) return [{ found: tables[exists[1]!] ?? false }];
      if (sql.includes('FROM "Person" p'))
        return [{ count: BigInt(identity.foreignPeople) }];
      if (sql.includes('FROM "Employee" outer_e')) {
        return [{ count: BigInt(identity.foreignEmployees) }];
      }
      if (sql.includes('FROM "User" WHERE'))
        return [{ count: BigInt(identity.foreignAccounts) }];
      if (sql.includes('FROM "Organization" WHERE')) {
        return [{ count: BigInt(identity.foreignOrganizations) }];
      }
      if (sql.includes('FROM "User"'))
        return [{ count: BigInt(identity.totalAccounts) }];
      if (sql.includes('FROM "Organization"')) {
        return [{ count: BigInt(identity.totalOrganizations) }];
      }
      throw new Error(`unexpected query ${sql}`);
    }) as RawQueryClient['$queryRawUnsafe'],
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      executed.push(sql);
      return 0;
    }),
  };
  return { client, executed };
}

describe('assertDemoDatabaseUrl', () => {
  it('accepts a local *_demo PostgreSQL database', () => {
    expect(assertDemoDatabaseUrl(LOCAL_ENV)).toMatchObject({
      databaseName: 'hrms_demo',
      local: true,
    });
  });

  it.each([
    [{ ...LOCAL_ENV, NODE_ENV: 'production' }, 'NODE_ENV is production'],
    [{}, 'DATABASE_URL is not set'],
    [{ DATABASE_URL: 'not a url' }, 'not a valid URL'],
    [{ DATABASE_URL: 'mysql://localhost/hrms_demo' }, 'PostgreSQL URL'],
    // The ordinary development database, a hosted default and a disposable test database.
    [
      { DATABASE_URL: 'postgresql://hrms:pw@localhost:5436/hrms' },
      'must end in "_demo"',
    ],
    [
      { DATABASE_URL: 'postgresql://u:p@db.railway.internal:5432/railway' },
      'must end in "_demo"',
    ],
    [
      { DATABASE_URL: 'postgresql://u:p@localhost/hrms_e2e_disposable' },
      'must end in "_demo"',
    ],
    [
      { DATABASE_URL: 'postgresql://u:p@localhost/HRMS_DEMO' },
      'must end in "_demo"',
    ],
    [
      { DATABASE_URL: 'postgresql://u:p@db.example.com/hrms_demo' },
      'HRMS_DEMO_ALLOW_REMOTE=1',
    ],
  ])('refuses %j', (environment, message) => {
    expect(() =>
      assertDemoDatabaseUrl(environment as NodeJS.ProcessEnv),
    ).toThrow(UnsafeDemoDatabaseError);
    expect(() =>
      assertDemoDatabaseUrl(environment as NodeJS.ProcessEnv),
    ).toThrow(message);
  });

  // Batch 11C: the PostgreSQL driver (pg-connection-string) lets query parameters override the
  // URL's host, port, database and user, so a URL that *looks* local could connect elsewhere.
  it.each([
    'postgresql://u:p@localhost:5436/hrms_demo?host=db.prod.example.com',
    'postgresql://u:p@localhost:5436/hrms_demo?schema=public&HOST=db.prod.example.com',
    'postgresql://u:p@localhost:5436/hrms_demo?hostaddr=10.0.0.5',
    'postgresql://u:p@localhost:5436/hrms_demo?port=6543',
    'postgresql://u:p@localhost:5436/hrms_demo?dbname=hrms',
    'postgresql://u:p@localhost:5436/hrms_demo?database=hrms',
    'postgresql://u:p@localhost:5436/hrms_demo?user=postgres',
    'postgresql://u:p@localhost:5436/hrms_demo?service=production',
    'postgresql://u:p@localhost:5436/hrms_demo?options=-c%20search_path%3Dprod',
  ])(
    'refuses a URL whose parameters could redirect the connection: %s',
    (url) => {
      for (const extra of [{}, { HRMS_DEMO_ALLOW_REMOTE: '1' }]) {
        expect(() =>
          assertDemoDatabaseUrl({ DATABASE_URL: url, ...extra }),
        ).toThrow(/connection parameter/);
      }
    },
  );

  it('accepts ordinary Prisma and TLS parameters', () => {
    expect(
      assertDemoDatabaseUrl({
        DATABASE_URL:
          'postgresql://u:p@localhost:5436/hrms_demo?schema=public&sslmode=disable&connection_limit=5',
      }),
    ).toMatchObject({ databaseName: 'hrms_demo', local: true });
  });

  it('accepts a remote *_demo database only with HRMS_DEMO_ALLOW_REMOTE=1', () => {
    expect(
      assertDemoDatabaseUrl({
        DATABASE_URL: 'postgresql://u:p@db.example.com/hrms_demo',
        HRMS_DEMO_ALLOW_REMOTE: '1',
      }),
    ).toMatchObject({ local: false, host: 'db.example.com' });
  });
});

describe('markers and dates', () => {
  it('round-trips the reference date and rejects other comments', () => {
    expect(parseDemoMarker(MARKED)).toBe('2026-11-09');
    expect(parseDemoMarker('hrms:disposable-test-database')).toBeNull();
    expect(parseDemoMarker(null)).toBeNull();
    expect(parseDemoMarker('hrms:demo-database;reference=soon')).toBeNull();
    expect(() => demoMarker("2026-11-09'; DROP DATABASE x; --")).toThrow();
  });

  it('places the reference on the Monday of the week', () => {
    expect(mondayOnOrBefore('2026-11-11')).toBe('2026-11-09');
    expect(mondayOnOrBefore('2026-11-09')).toBe('2026-11-09');
    expect(mondayOnOrBefore('2026-11-15')).toBe('2026-11-09');
    expect(mondayOnOrBefore('2027-01-01')).toBe('2026-12-28');
  });
});

describe('assertDemoIdentity', () => {
  it('returns the recorded reference date for a clean, marked demo database', () => {
    expect(assertDemoIdentity(CLEAN, 'hrms_demo')).toBe('2026-11-09');
  });

  it.each([
    [{ ...CLEAN, databaseName: 'hrms' }, 'connected to "hrms"'],
    [{ ...CLEAN, marker: null }, "isn't marked"],
    [{ ...CLEAN, marker: 'hrms:disposable-test-database' }, "isn't marked"],
    [{ ...CLEAN, foreignAccounts: 1 }, "aren't demonstration data"],
    [{ ...CLEAN, foreignOrganizations: 3 }, "aren't demonstration data"],
  ])('refuses %j', (identity, message) => {
    expect(() => assertDemoIdentity(identity, 'hrms_demo')).toThrow(message);
  });
});

describe('markDemoDatabase', () => {
  it('marks a new, empty database with the reference date', async () => {
    const { client, executed } = fakeClient({
      ...CLEAN,
      marker: null,
      totalAccounts: 0,
      totalOrganizations: 0,
    });
    await expect(
      markDemoDatabase(client, LOCAL_ENV, '2026-11-09', MIGRATIONS),
    ).resolves.toMatchObject({
      marked: true,
      referenceDate: '2026-11-09',
    });
    expect(executed).toEqual([
      `COMMENT ON DATABASE "hrms_demo" IS '${MARKED}'`,
    ]);
  });

  it('keeps the recorded reference date on an already-marked demo database', async () => {
    const { client, executed } = fakeClient(CLEAN);
    await expect(
      markDemoDatabase(client, LOCAL_ENV, '2026-12-07', MIGRATIONS),
    ).resolves.toMatchObject({
      marked: false,
      referenceDate: '2026-11-09',
    });
    expect(executed).toEqual([]);
  });

  it('never marks a database that already holds accounts or organizations', async () => {
    for (const identity of [
      { ...CLEAN, marker: null, totalOrganizations: 0 },
      { ...CLEAN, marker: null, totalAccounts: 0 },
    ]) {
      const { client, executed } = fakeClient(identity);
      await expect(
        markDemoDatabase(client, LOCAL_ENV, '2026-11-09', MIGRATIONS),
      ).rejects.toThrow('already holds data');
      expect(executed).toEqual([]);
    }
  });

  it('refuses a marked database that has gained real accounts', async () => {
    const { client, executed } = fakeClient({ ...CLEAN, foreignAccounts: 2 });
    await expect(
      markDemoDatabase(client, LOCAL_ENV, '2026-11-09', MIGRATIONS),
    ).rejects.toThrow("aren't demonstration data");
    expect(executed).toEqual([]);
  });
});

describe('assertDemoDatabase', () => {
  it('refuses before connecting when the URL is unsafe', async () => {
    const { client } = fakeClient(CLEAN);
    await expect(
      assertDemoDatabase(client, {
        DATABASE_URL: 'postgresql://u:p@localhost/hrms',
      }),
    ).rejects.toThrow('must end in "_demo"');
    expect(client.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('assertResetAllowed', () => {
  it('allows a local, marked demo database with the exact confirmation', () => {
    expect(assertResetAllowed(LOCAL_ENV, 'hrms_demo', CLEAN).databaseName).toBe(
      'hrms_demo',
    );
    // A database that doesn't exist yet has no identity to check.
    expect(assertResetAllowed(LOCAL_ENV, 'hrms_demo', null).databaseName).toBe(
      'hrms_demo',
    );
  });

  it.each([
    [LOCAL_ENV, undefined, CLEAN, '--confirm hrms_demo'],
    [LOCAL_ENV, 'yes', CLEAN, '--confirm hrms_demo'],
    [LOCAL_ENV, 'hrms', CLEAN, '--confirm hrms_demo'],
    [
      { ...LOCAL_ENV, NODE_ENV: 'production' },
      'hrms_demo',
      CLEAN,
      'NODE_ENV is production',
    ],
    [
      {
        DATABASE_URL: 'postgresql://u:p@db.example.com/hrms_demo',
        HRMS_DEMO_ALLOW_REMOTE: '1',
      },
      'hrms_demo',
      CLEAN,
      'only works on a database on this machine',
    ],
    [
      { DATABASE_URL: 'postgresql://u:p@localhost/hrms' },
      'hrms',
      CLEAN,
      'must end in "_demo"',
    ],
    [LOCAL_ENV, 'hrms_demo', { ...CLEAN, marker: null }, "isn't marked"],
    [
      LOCAL_ENV,
      'hrms_demo',
      { ...CLEAN, foreignAccounts: 1 },
      "aren't demonstration data",
    ],
  ])('refuses %j / %s', (environment, confirmation, identity, message) => {
    expect(() =>
      assertResetAllowed(
        environment as NodeJS.ProcessEnv,
        confirmation,
        identity,
      ),
    ).toThrow(message);
  });
});

describe('Batch 11B: application data beyond accounts and organizations', () => {
  it('marks a new, migrated database whose application tables are all empty', async () => {
    const { client, executed } = fakeClient(EMPTY, {
      User: false,
      Organization: false,
      Person: false,
      Employee: false,
      PayrollRun: false,
    });
    await expect(
      markDemoDatabase(client, LOCAL_ENV, '2026-11-09', MIGRATIONS),
    ).resolves.toMatchObject({
      marked: true,
    });
    expect(executed).toHaveLength(1);
  });

  it.each([
    ['people and employees with no account', { Person: true, Employee: true }],
    ['payroll records', { PayrollRun: true }],
    ['audit history', { AuditLog: true }],
    ['the permission catalog', { Permission: true }],
  ])(
    'never marks a database with empty User and Organization tables that holds %s',
    async (_label, populated) => {
      const { client, executed } = fakeClient(EMPTY, {
        User: false,
        Organization: false,
        Person: false,
        Employee: false,
        PayrollRun: false,
        AuditLog: false,
        Permission: false,
        ...populated,
      });
      await expect(
        markDemoDatabase(client, LOCAL_ENV, '2026-11-09', MIGRATIONS),
      ).rejects.toThrow('already holds data');
      expect(executed).toEqual([]);
    },
  );

  it('names the non-empty tables it found', async () => {
    const { client } = fakeClient(EMPTY, {
      User: false,
      Person: true,
      PayrollRun: true,
    });
    await expect(
      markDemoDatabase(client, LOCAL_ENV, '2026-11-09', MIGRATIONS),
    ).rejects.toThrow(/public\.Person, public\.PayrollRun/);
  });

  it.each([
    [{ ...CLEAN, foreignPeople: 1 }],
    [{ ...CLEAN, foreignEmployees: 2 }],
  ])(
    'refuses a marked database holding people or employees outside the demo: %j',
    async (identity) => {
      expect(() => assertDemoIdentity(identity, 'hrms_demo')).toThrow(
        "aren't demonstration data",
      );
      const { client, executed } = fakeClient(identity);
      await expect(assertDemoDatabase(client, LOCAL_ENV)).rejects.toThrow(
        "aren't demonstration data",
      );
      await expect(
        markDemoDatabase(client, LOCAL_ENV, '2026-11-09', MIGRATIONS),
      ).rejects.toThrow("aren't demonstration data");
      expect(executed).toEqual([]);
    },
  );

  it('refuses to reset such databases, marked or not', () => {
    expect(() =>
      assertResetAllowed(LOCAL_ENV, 'hrms_demo', {
        ...CLEAN,
        foreignPeople: 3,
      }),
    ).toThrow("aren't demonstration data");
    expect(() =>
      assertResetAllowed(LOCAL_ENV, 'hrms_demo', {
        ...CLEAN,
        foreignEmployees: 1,
      }),
    ).toThrow("aren't demonstration data");
    // Unmarked, with empty User and Organization tables but other data: never resettable.
    expect(() =>
      assertResetAllowed(LOCAL_ENV, 'hrms_demo', { ...EMPTY }),
    ).toThrow("isn't marked");
  });
});

describe('R5-A: only a fully migrated database can be marked', () => {
  const mark = (migrations: MigrationRow[] | null) => {
    const { client, executed } = fakeClient(EMPTY, undefined, migrations);
    return {
      result: markDemoDatabase(client, LOCAL_ENV, '2026-11-09', MIGRATIONS),
      executed,
    };
  };

  it('marks a new database once every repository migration is applied', async () => {
    const { result, executed } = mark(APPLIED);
    await expect(result).resolves.toMatchObject({ marked: true });
    expect(executed).toHaveLength(1);
  });

  it('refuses a new database that was never migrated (no migration history)', async () => {
    const { result, executed } = mark(null);
    await expect(result).rejects.toThrow(UnsafeDemoDatabaseError);
    await expect(result).rejects.toThrow('has not been migrated');
    expect(executed).toEqual([]);
  });

  it('refuses a partly migrated database and names what is missing', async () => {
    const { result, executed } = mark(APPLIED.slice(0, 1));
    await expect(result).rejects.toThrow(
      /2 of 3 migrations are not applied \(20260201000000_people, 20260301000000_payroll\)/,
    );
    expect(executed).toEqual([]);
  });

  it('refuses a database with a failed migration, even if later ones were recorded', async () => {
    const { result, executed } = mark([
      ...APPLIED.slice(0, 2),
      { name: MIGRATIONS[2]!, finished: false, rolledBack: false },
    ]);
    await expect(result).rejects.toThrow(
      /failed migration \(20260301000000_payroll\)/,
    );
    expect(executed).toEqual([]);
  });

  it('does not count a rolled-back attempt as applied, but accepts its later reapplication', async () => {
    const rolledBack = {
      name: MIGRATIONS[2]!,
      finished: false,
      rolledBack: true,
    };
    await expect(
      mark([...APPLIED.slice(0, 2), rolledBack]).result,
    ).rejects.toThrow(/1 of 3 migrations are not applied/);
    await expect(mark([...APPLIED, rolledBack]).result).resolves.toMatchObject({
      marked: true,
    });
  });

  it('refuses a database migrated by another version of the code (unknown migrations)', async () => {
    const { result, executed } = mark([
      ...APPLIED,
      { name: '20270101000000_future', finished: true, rolledBack: false },
    ]);
    await expect(result).rejects.toThrow(
      /unknown to this repository \(20270101000000_future\)/,
    );
    expect(executed).toEqual([]);
  });

  it('still refuses a populated database before looking at migrations', async () => {
    const { client, executed } = fakeClient(
      { ...EMPTY, totalAccounts: 3 },
      undefined,
      null,
    );
    await expect(
      markDemoDatabase(client, LOCAL_ENV, '2026-11-09', MIGRATIONS),
    ).rejects.toThrow('already holds data');
    expect(executed).toEqual([]);
  });

  it('leaves an already-marked demo database as it is', async () => {
    const { client, executed } = fakeClient(CLEAN);
    await expect(
      markDemoDatabase(client, LOCAL_ENV, '2026-12-07', MIGRATIONS),
    ).resolves.toMatchObject({ marked: false, referenceDate: '2026-11-09' });
    expect(executed).toEqual([]);
  });

  it('needs the list of repository migrations', () => {
    expect(() => assertMigrationsApplied(APPLIED, [], 'hrms_demo')).toThrow(
      'no migrations were found',
    );
  });
});
