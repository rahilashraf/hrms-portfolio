import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  assertDisposableDatabase,
  assertDisposableDatabaseUrl,
  DISPOSABLE_DATABASE_MARKER,
  markDisposableDatabase,
  readDatabaseIdentity,
} from './real-stack/disposable-database.js';

config({ path: '../../.env' });

/** The same server and credentials, another database. */
function withDatabase(url: string, database: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Batch 4.0 hardening: the real-stack guards against real PostgreSQL. The ordinary test database
 * this suite runs on (named `hrms`, unmarked, shared with the other specs) must be refused by
 * every layer and by the seed command itself, without anything being written. A scratch
 * `*_disposable` database created here is refused until it is marked, and again once its marker
 * is changed. The scratch database is dropped afterwards.
 */
describe('Real-stack disposable database guard (database)', () => {
  const ordinaryUrl = process.env.DATABASE_URL!;
  const scratchName = `hrms_guard_${randomUUID().replaceAll('-', '').slice(0, 10)}_disposable`;
  const scratchUrl = withDatabase(ordinaryUrl, scratchName);
  let ordinary: PrismaService;
  let scratch: PrismaService | undefined;

  beforeAll(async () => {
    ordinary = new PrismaService(ordinaryUrl);
    await ordinary.$connect();
    await ordinary.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    scratch = new PrismaService(scratchUrl);
    await scratch.$connect();
  });

  afterAll(async () => {
    await scratch?.$disconnect();
    await ordinary
      ?.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`,
      )
      .catch(() => undefined);
    await ordinary?.$disconnect();
  });

  it('refuses the ordinary test database at every layer', async () => {
    const environment = { REAL_STACK_E2E: '1', DATABASE_URL: ordinaryUrl };
    expect(() => assertDisposableDatabaseUrl(environment)).toThrow(
      /_disposable/,
    );
    await expect(
      assertDisposableDatabase(ordinary, environment),
    ).rejects.toThrow(/_disposable/);
    await expect(markDisposableDatabase(ordinary, environment)).rejects.toThrow(
      /_disposable/,
    );
    const identity = await readDatabaseIdentity(ordinary);
    expect(identity.marker).not.toBe(DISPOSABLE_DATABASE_MARKER);
  });

  it('the seed command refuses the ordinary test database and writes nothing', () => {
    const before = organizationsCreatedBySeed();
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'test/real-stack/seed.ts'],
      {
        env: {
          ...process.env,
          REAL_STACK_E2E: '1',
          NODE_ENV: 'test',
          DATABASE_URL: ordinaryUrl,
          REAL_STACK_SEED_FILE: `/tmp/real-stack-guard-${randomUUID()}.json`,
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Refusing to use this database for real-stack tests',
    );
    return before.then(async (count) =>
      expect(await organizationsCreatedBySeed()).toBe(count),
    );
  });

  it('refuses a *_disposable database until it is marked, and after its marker changes', async () => {
    const environment = { REAL_STACK_E2E: '1', DATABASE_URL: scratchUrl };
    // Correctly named, but unmarked: refused.
    await expect(
      assertDisposableDatabase(scratch!, environment),
    ).rejects.toThrow(/isn't marked/);
    // The seed command refuses it too.
    const seeded = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'test/real-stack/seed.ts'],
      {
        env: {
          ...process.env,
          REAL_STACK_E2E: '1',
          NODE_ENV: 'test',
          DATABASE_URL: scratchUrl,
          REAL_STACK_SEED_FILE: `/tmp/real-stack-guard-${randomUUID()}.json`,
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(seeded.status).not.toBe(0);
    expect(`${seeded.stdout}${seeded.stderr}`).toContain("isn't marked");

    // Marked (it holds no accounts): accepted.
    await expect(
      markDisposableDatabase(scratch!, environment),
    ).resolves.toEqual({
      databaseName: scratchName,
      marked: true,
    });
    await expect(
      assertDisposableDatabase(scratch!, environment),
    ).resolves.toBeUndefined();

    // Someone changes the comment: refused again.
    await scratch!.$executeRawUnsafe(
      `COMMENT ON DATABASE "${scratchName}" IS 'not disposable'`,
    );
    await expect(
      assertDisposableDatabase(scratch!, environment),
    ).rejects.toThrow(/isn't marked/);

    // A URL naming the scratch database cannot vouch for a connection to another one.
    await expect(
      assertDisposableDatabase(ordinary, environment),
    ).rejects.toThrow(/connected to/);
  });

  function organizationsCreatedBySeed() {
    return ordinary.organization.count({
      where: { code: { startsWith: 'RS-' } },
    });
  }
});
