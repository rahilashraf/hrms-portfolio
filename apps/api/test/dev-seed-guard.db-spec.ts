import type { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedLocalAdmin } from '../prisma/seed.js';
import { UnsafeSeedDatabaseError } from '../prisma/seed-guard.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { PasswordHasherService } from '../src/security/password-hasher.service.js';

config({ path: '../../.env' });

const testConfig = {
  getOrThrow: (key: string) => {
    const value = process.env[key];
    if (value === undefined) throw new Error(`${key} missing`);
    return key.startsWith('ARGON2_') ? Number(value) : value;
  },
} as unknown as ConfigService;

/**
 * R5-B — the development seed's database checks against a real connection: the identity check
 * runs on the connection that writes, a database with other accounts needs the exact
 * confirmation, refused runs write nothing, and an existing seed account is left alone. Each
 * test seeds its own throwaway account (not admin@local.test) and removes it afterwards.
 */
describe('development seed: database identity and existing accounts (R5-B)', () => {
  let prisma: PrismaService;
  let passwords: PasswordHasherService;
  let databaseName: string;
  const emails: string[] = [];

  const account = () => {
    const email = `seed-guard-${randomUUID()}@example.test`;
    emails.push(email);
    return {
      firstName: 'Seed',
      lastName: 'Guard',
      email,
      password: 'Seed-Guard-1!',
    };
  };
  const exists = async (email: string) =>
    (await prisma.user.count({ where: { email } })) +
    (await prisma.person.count({ where: { personalEmail: email } }));

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    passwords = new PasswordHasherService(testConfig);
    const [row] = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT current_database() AS name`;
    databaseName = row!.name;
    // At least one other account exists (database specs create many; make sure of one here).
    const other = account();
    const person = await prisma.person.create({
      data: {
        firstName: 'Other',
        lastName: 'Account',
        personalEmail: other.email,
      },
    });
    await prisma.user.create({
      data: { personId: person.id, email: other.email, status: 'ACTIVE' },
    });
  });
  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true, personId: true },
    });
    await prisma.authSession.deleteMany({
      where: { userId: { in: users.map((user) => user.id) } },
    });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await prisma.person.deleteMany({
      where: { personalEmail: { in: emails } },
    });
    await prisma?.$disconnect();
  });

  it('refuses when the connection reached another database than the URL names, and writes nothing', async () => {
    const target = account();
    await expect(
      seedLocalAdmin(prisma, passwords, {
        databaseName: `${databaseName}_elsewhere`,
        environment: { HRMS_DEV_SEED_CONFIRM: `${databaseName}_elsewhere` },
        account: target,
      }),
    ).rejects.toThrow(/connected to ".*", not ".*_elsewhere"/);
    expect(await exists(target.email)).toBe(0);
  });

  it('refuses to add the account to a database that already holds accounts without the exact confirmation, and writes nothing', async () => {
    for (const environment of [
      {},
      { HRMS_DEV_SEED_CONFIRM: '1' },
      { HRMS_DEV_SEED_CONFIRM: 'true' },
      { HRMS_DEV_SEED_CONFIRM: `${databaseName}_dev` },
    ]) {
      const target = account();
      const refused = seedLocalAdmin(prisma, passwords, {
        databaseName,
        environment,
        account: target,
      });
      await expect(refused).rejects.toBeInstanceOf(UnsafeSeedDatabaseError);
      await expect(refused).rejects.toThrow(
        new RegExp(`HRMS_DEV_SEED_CONFIRM=${databaseName} pnpm db:seed`),
      );
      expect(await exists(target.email)).toBe(0);
    }
  });

  it('creates the account with the exact confirmation, then leaves it unchanged without one (idempotent)', async () => {
    const target = account();
    const created = await seedLocalAdmin(prisma, passwords, {
      databaseName,
      environment: { HRMS_DEV_SEED_CONFIRM: databaseName },
      account: target,
    });
    expect(created.outcome).toBe('CREATED');
    const before = await prisma.user.findUniqueOrThrow({
      where: { email: target.email },
    });
    // The account exists now: a rerun needs no confirmation and changes nothing.
    const again = await seedLocalAdmin(prisma, passwords, {
      databaseName,
      environment: {},
      account: target,
    });
    expect(again).toEqual({ outcome: 'EXISTS', userId: created.userId });
    expect(
      await prisma.user.findUniqueOrThrow({ where: { email: target.email } }),
    ).toEqual(before);
    expect(
      await prisma.person.count({ where: { personalEmail: target.email } }),
    ).toBe(1);
  });
});
