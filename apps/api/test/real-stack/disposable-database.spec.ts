import { describe, expect, it, vi } from 'vitest';
import {
  assertDisposableDatabase,
  assertDisposableDatabaseUrl,
  assertDisposableIdentity,
  DISPOSABLE_DATABASE_MARKER,
  markDisposableDatabase,
  UnsafeDatabaseError,
  type DatabaseIdentity,
  type RawQueryClient,
} from './disposable-database.js';

const SAFE_URL =
  'postgresql://hrms:pw@localhost:5436/hrms_e2e_disposable?schema=public';
const SAFE_ENV = { REAL_STACK_E2E: '1', DATABASE_URL: SAFE_URL };

const SAFE_IDENTITY: DatabaseIdentity = {
  databaseName: 'hrms_e2e_disposable',
  marker: DISPOSABLE_DATABASE_MARKER,
  foreignAccounts: 0,
  foreignOrganizations: 0,
  totalAccounts: 0,
};

/** A fake connection answering the guard's queries from an identity and an account count. */
function fakeClient(identity: DatabaseIdentity, accounts = 0) {
  const executed: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('current_database()')) {
      return [
        {
          databaseName: identity.databaseName,
          marker: identity.marker,
          hasUsers: true,
          hasOrganizations: true,
        },
      ];
    }
    if (sql.includes('FROM "User" WHERE email NOT LIKE')) {
      return [{ count: BigInt(identity.foreignAccounts) }];
    }
    if (sql.trim().endsWith('FROM "User"')) {
      return [{ count: BigInt(accounts) }];
    }
    if (sql.includes('FROM "Organization"')) {
      return [{ count: BigInt(identity.foreignOrganizations) }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const client: RawQueryClient = {
    $queryRawUnsafe: query as RawQueryClient['$queryRawUnsafe'],
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      executed.push(sql);
      return 0;
    }),
  };
  return { client, executed, query };
}

describe('real-stack disposable database guard', () => {
  describe('configuration (layer 1)', () => {
    it('accepts a local *_disposable PostgreSQL database with REAL_STACK_E2E=1', () => {
      expect(assertDisposableDatabaseUrl(SAFE_ENV)).toEqual({
        url: SAFE_URL,
        databaseName: 'hrms_e2e_disposable',
      });
      for (const host of ['127.0.0.1', '[::1]']) {
        expect(
          assertDisposableDatabaseUrl({
            ...SAFE_ENV,
            DATABASE_URL: SAFE_URL.replace('localhost', host),
          }).databaseName,
        ).toBe('hrms_e2e_disposable');
      }
    });

    it.each([
      [
        'without REAL_STACK_E2E',
        { DATABASE_URL: SAFE_URL },
        /REAL_STACK_E2E=1/,
      ],
      [
        'with REAL_STACK_E2E set to anything but 1',
        { ...SAFE_ENV, REAL_STACK_E2E: 'true' },
        /REAL_STACK_E2E=1/,
      ],
      [
        'in production',
        { ...SAFE_ENV, NODE_ENV: 'production' },
        /NODE_ENV is production/,
      ],
      ['without DATABASE_URL', { REAL_STACK_E2E: '1' }, /not set/],
      [
        'with an invalid URL',
        { ...SAFE_ENV, DATABASE_URL: 'not a url' },
        /not a valid URL/,
      ],
      [
        'with another database engine',
        {
          ...SAFE_ENV,
          DATABASE_URL: 'mysql://u:p@localhost:3306/hrms_e2e_disposable',
        },
        /PostgreSQL/,
      ],
      [
        'on a remote host',
        {
          ...SAFE_ENV,
          DATABASE_URL:
            'postgresql://u:p@db.example.com:5432/hrms_e2e_disposable',
        },
        /this machine/,
      ],
      [
        'on a host that only looks local',
        {
          ...SAFE_ENV,
          DATABASE_URL:
            'postgresql://u:p@localhost.example.com:5432/hrms_e2e_disposable',
        },
        /this machine/,
      ],
      [
        'on the ordinary development database (.env.example)',
        {
          ...SAFE_ENV,
          DATABASE_URL:
            'postgresql://hrms:hrms_dev_password@localhost:5436/hrms?schema=public',
        },
        /_disposable/,
      ],
      [
        'on a hosted database reached through a local tunnel',
        {
          ...SAFE_ENV,
          DATABASE_URL: 'postgresql://postgres:pw@127.0.0.1:15432/railway',
        },
        /_disposable/,
      ],
      [
        'on a name that merely contains "disposable"',
        {
          ...SAFE_ENV,
          DATABASE_URL:
            'postgresql://u:p@localhost:5436/hrms_disposable_backup',
        },
        /_disposable/,
      ],
      [
        'without a database name',
        { ...SAFE_ENV, DATABASE_URL: 'postgresql://u:p@localhost:5436' },
        /_disposable/,
      ],
    ])('refuses %s', (_label, environment, reason) => {
      expect(() => assertDisposableDatabaseUrl(environment)).toThrow(
        UnsafeDatabaseError,
      );
      expect(() => assertDisposableDatabaseUrl(environment)).toThrow(reason);
    });
  });

  describe('identity (layer 2)', () => {
    it('accepts the marked database holding only real-stack seed data', () => {
      expect(() =>
        assertDisposableIdentity(SAFE_IDENTITY, 'hrms_e2e_disposable'),
      ).not.toThrow();
    });

    it.each([
      [
        'a connection to another database than the URL names',
        { ...SAFE_IDENTITY, databaseName: 'hrms' },
        /connected to "hrms"/,
      ],
      [
        'a database without the marker (e.g. a production database behind a tunnel)',
        { ...SAFE_IDENTITY, marker: null },
        /isn't marked/,
      ],
      [
        'a database with another comment',
        { ...SAFE_IDENTITY, marker: 'production' },
        /isn't marked/,
      ],
      [
        'a marked database holding real accounts',
        { ...SAFE_IDENTITY, foreignAccounts: 3 },
        /3 account/,
      ],
      [
        'a marked database holding other organizations',
        { ...SAFE_IDENTITY, foreignOrganizations: 1 },
        /1 organization/,
      ],
    ])('refuses %s', (_label, identity, reason) => {
      expect(() =>
        assertDisposableIdentity(identity, 'hrms_e2e_disposable'),
      ).toThrow(reason);
    });

    it('checks the configuration before querying the connection', async () => {
      const { client, query } = fakeClient(SAFE_IDENTITY);
      await expect(
        assertDisposableDatabase(client, { DATABASE_URL: SAFE_URL }),
      ).rejects.toThrow(/REAL_STACK_E2E=1/);
      expect(query).not.toHaveBeenCalled();
      await expect(
        assertDisposableDatabase(client, SAFE_ENV),
      ).resolves.toBeUndefined();
    });
  });

  describe('marking (layer 3)', () => {
    it('marks a new, empty *_disposable database', async () => {
      const { client, executed } = fakeClient({
        ...SAFE_IDENTITY,
        marker: null,
      });
      await expect(markDisposableDatabase(client, SAFE_ENV)).resolves.toEqual({
        databaseName: 'hrms_e2e_disposable',
        marked: true,
      });
      expect(executed).toEqual([
        `COMMENT ON DATABASE "hrms_e2e_disposable" IS '${DISPOSABLE_DATABASE_MARKER}'`,
      ]);
    });

    it('leaves an already marked database as it is', async () => {
      const { client, executed } = fakeClient(SAFE_IDENTITY, 2);
      await expect(markDisposableDatabase(client, SAFE_ENV)).resolves.toEqual({
        databaseName: 'hrms_e2e_disposable',
        marked: false,
      });
      expect(executed).toEqual([]);
    });

    it('refuses to mark a database that already holds accounts', async () => {
      const { client, executed } = fakeClient(
        { ...SAFE_IDENTITY, marker: null },
        1,
      );
      await expect(markDisposableDatabase(client, SAFE_ENV)).rejects.toThrow(
        /already holds data/,
      );
      expect(executed).toEqual([]);
    });

    it('refuses to mark a database the configuration rejects, without connecting', async () => {
      const { client, executed, query } = fakeClient({
        ...SAFE_IDENTITY,
        databaseName: 'hrms',
        marker: null,
      });
      await expect(
        markDisposableDatabase(client, {
          ...SAFE_ENV,
          DATABASE_URL: 'postgresql://hrms:pw@localhost:5436/hrms',
        }),
      ).rejects.toThrow(/_disposable/);
      expect(query).not.toHaveBeenCalled();
      expect(executed).toEqual([]);
    });

    it('refuses to mark when the connection reaches another database', async () => {
      const { client, executed } = fakeClient({
        ...SAFE_IDENTITY,
        databaseName: 'hrms',
        marker: null,
      });
      await expect(markDisposableDatabase(client, SAFE_ENV)).rejects.toThrow(
        /connected to "hrms"/,
      );
      expect(executed).toEqual([]);
    });
  });
});
