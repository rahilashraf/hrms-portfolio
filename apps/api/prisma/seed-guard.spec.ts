import { describe, expect, it } from 'vitest';
import {
  assertLocalSeedDatabase,
  assertSeedIdentity,
  assertSeedMayCreate,
  UnsafeSeedDatabaseError,
} from './seed-guard.js';

const env = (DATABASE_URL: string | undefined, NODE_ENV = 'development') =>
  ({ DATABASE_URL, NODE_ENV }) as NodeJS.ProcessEnv;

describe('local development seed guard (R5-A)', () => {
  it('accepts databases on this machine: Docker Compose, CI service containers, IPv6', () => {
    for (const url of [
      'postgresql://hrms:hrms_dev_password@localhost:5436/hrms?schema=public',
      'postgresql://postgres:postgres@127.0.0.1:5432/hrms_dev',
      'postgres://hrms@[::1]:5432/hrms',
      'postgresql://hrms@localhost/hrms?sslmode=disable',
    ]) {
      expect(assertLocalSeedDatabase(env(url))).toEqual({
        host: new URL(url).hostname,
        databaseName: new URL(url).pathname.slice(1),
      });
    }
    expect(
      assertLocalSeedDatabase(env('postgresql://u@localhost/hrms', 'test')),
    ).toEqual({
      host: 'localhost',
      databaseName: 'hrms',
    });
  });

  it('refuses a remote host, a hosted database and production', () => {
    for (const url of [
      'postgresql://u:p@db.example.com:5432/hrms',
      'postgresql://u:p@postgres.railway.internal:5432/railway',
      'postgresql://u:p@10.0.0.5:5432/hrms',
      'postgresql://u:p@localhost.example.com/hrms',
    ]) {
      expect(() => assertLocalSeedDatabase(env(url))).toThrow(
        UnsafeSeedDatabaseError,
      );
    }
    expect(() =>
      assertLocalSeedDatabase(
        env('postgresql://u@localhost/hrms', 'production'),
      ),
    ).toThrow(/NODE_ENV is production/);
  });

  it('refuses query parameters that would redirect a local-looking URL', () => {
    for (const parameter of [
      'host=db.example.com',
      'HOST=db.example.com',
      'hostaddr=10.0.0.5',
      'port=6543',
      'dbname=prod',
      'user=admin',
      'service=prod',
    ]) {
      expect(() =>
        assertLocalSeedDatabase(
          env(`postgresql://u@localhost/hrms?${parameter}`),
        ),
      ).toThrow(/connection parameter/);
    }
  });

  it('refuses a missing, malformed or non-PostgreSQL URL', () => {
    expect(() => assertLocalSeedDatabase(env(undefined))).toThrow(/not set/);
    expect(() => assertLocalSeedDatabase(env('not a url'))).toThrow(
      /not a valid URL/,
    );
    expect(() =>
      assertLocalSeedDatabase(env('mysql://u@localhost/hrms')),
    ).toThrow(/PostgreSQL/);
  });

  // R5-B: a local host is not proof of a development database (a tunnel to production listens
  // on localhost too), so the database name must also be a development one.
  it('accepts only "hrms" and "<name>_dev" database names', () => {
    for (const name of ['hrms', 'hrms_dev', 'payroll_dev', 'a_dev']) {
      expect(
        assertLocalSeedDatabase(env(`postgresql://u@localhost/${name}`))
          .databaseName,
      ).toBe(name);
    }
    for (const name of [
      'railway',
      'postgres',
      'hrms_prod',
      'hrms_demo',
      'hrms_e2e_disposable',
      'hrms_test',
      'HRMS',
      'hrms_dev_old',
      '_dev',
      'my-db_dev',
      '',
    ]) {
      expect(() =>
        assertLocalSeedDatabase(env(`postgresql://u@localhost/${name}`)),
      ).toThrow(/database name must be "hrms" or end in "_dev"/);
    }
  });

  it('decodes the database name before checking it, and refuses malformed encodings', () => {
    // %73 is "s": the decoded name is the one PostgreSQL would use.
    expect(() =>
      assertLocalSeedDatabase(env('postgresql://u@localhost/hrm%73_x')),
    ).toThrow(/got "hrms_x"/);
    expect(
      assertLocalSeedDatabase(env('postgresql://u@localhost/hrm%73'))
        .databaseName,
    ).toBe('hrms');
    expect(() =>
      assertLocalSeedDatabase(env('postgresql://u@localhost/hrms%ZZ')),
    ).toThrow(/database name in DATABASE_URL is not valid/);
  });

  it('refuses a connection that reached another database than the URL names', () => {
    expect(() => assertSeedIdentity('hrms', 'hrms')).not.toThrow();
    expect(() => assertSeedIdentity('railway', 'hrms')).toThrow(
      /connected to "railway", not "hrms"/,
    );
    expect(() => assertSeedIdentity(undefined, 'hrms')).toThrow(
      UnsafeSeedDatabaseError,
    );
  });

  it('creates the account in a database with other accounts only with the exact confirmation', () => {
    const state = { databaseName: 'hrms', otherAccounts: 3 };
    expect(() =>
      assertSeedMayCreate({ databaseName: 'hrms', otherAccounts: 0 }, {}),
    ).not.toThrow();
    expect(() => assertSeedMayCreate(state, {})).toThrow(
      /already holds 3 account\(s\).*HRMS_DEV_SEED_CONFIRM=hrms pnpm db:seed/,
    );
    for (const value of ['1', 'true', 'yes', 'HRMS', 'hrms_dev', ' hrms']) {
      expect(() =>
        assertSeedMayCreate(state, { HRMS_DEV_SEED_CONFIRM: value }),
      ).toThrow(UnsafeSeedDatabaseError);
    }
    expect(() =>
      assertSeedMayCreate(state, { HRMS_DEV_SEED_CONFIRM: 'hrms' }),
    ).not.toThrow();
  });
});
