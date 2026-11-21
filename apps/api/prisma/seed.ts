import { ConfigService } from '@nestjs/config';
import { validateEnvironment } from '@hrms/config';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { advisoryLock } from '../src/common/domain-support.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { PasswordHasherService } from '../src/security/password-hasher.service.js';
import { normalizeEmail } from '../src/users/users.service.js';
import {
  assertLocalSeedDatabase,
  assertSeedIdentity,
  assertSeedMayCreate,
} from './seed-guard.js';

/**
 * Local-development seed: one predictable test identity to sign in with. It runs only when
 * invoked explicitly (`pnpm db:seed`); it is not registered with Prisma migrations and is not
 * part of the API build. Authorization is not touched: grant the reserved owner role through
 * `authz:bootstrap-owner` as usual. No organization is created.
 *
 * Idempotent: an existing account is left exactly as it is (its password is not reset), and a
 * Person already carrying the email is reused instead of duplicated.
 */
config({ path: '../../.env' });

export const LOCAL_ADMIN = {
  firstName: 'Local',
  lastName: 'Admin',
  email: 'admin@local.test',
  password: 'Admin123!',
} as const;

export type LocalSeedOutcome = 'CREATED' | 'EXISTS';

export interface SeedOptions {
  /** The database name `assertLocalSeedDatabase` read from DATABASE_URL. */
  databaseName: string;
  /** Read for HRMS_DEV_SEED_CONFIRM. */
  environment: NodeJS.ProcessEnv;
  now?: Date;
  /** Tests only: another account than admin@local.test. */
  account?: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  };
}

export async function seedLocalAdmin(
  prisma: PrismaService,
  passwords: PasswordHasherService,
  options: SeedOptions,
): Promise<{ outcome: LocalSeedOutcome; userId: string }> {
  const account = options.account ?? LOCAL_ADMIN;
  const now = options.now ?? new Date();
  const email = normalizeEmail(account.email);
  // Hash outside the transaction (Argon2id is deliberately slow); unused if the account exists.
  const passwordHash = await passwords.hashPassword(account.password);
  return prisma.$transaction(async (tx) => {
    // R5-B: identity on the very connection that writes, before anything is written.
    const [connected] = await tx.$queryRaw<Array<{ name: string }>>`
      SELECT current_database() AS name`;
    assertSeedIdentity(connected?.name, options.databaseName);
    await advisoryLock(tx, `local-seed:user:${email}`);
    const existing = await tx.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) return { outcome: 'EXISTS' as const, userId: existing.id };
    // R5-B: a database with other accounts and no seed account may not be a development one.
    assertSeedMayCreate(
      {
        databaseName: options.databaseName,
        otherAccounts: await tx.user.count(),
      },
      options.environment,
    );

    const person =
      (await tx.person.findFirst({
        where: { personalEmail: email, user: null, archivedAt: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      })) ??
      (await tx.person.create({
        data: {
          firstName: account.firstName,
          lastName: account.lastName,
          personalEmail: email,
        },
        select: { id: true },
      }));
    const user = await tx.user.create({
      data: {
        personId: person.id,
        email,
        passwordHash,
        status: 'ACTIVE',
        emailVerifiedAt: now,
        mustChangePassword: false,
        passwordChangedAt: now,
      },
      select: { id: true },
    });
    return { outcome: 'CREATED' as const, userId: user.id };
  });
}

async function main(): Promise<void> {
  // Never production, only a development database on this machine (see seed-guard.ts).
  const { databaseName } = assertLocalSeedDatabase(process.env);
  // The same validated configuration as the API, so the Argon2id parameters match exactly.
  const environment = validateEnvironment(process.env);
  const prisma = new PrismaService(environment.DATABASE_URL);
  try {
    await prisma.$connect();
    const result = await seedLocalAdmin(
      prisma,
      new PasswordHasherService(new ConfigService(environment)),
      { databaseName, environment: process.env },
    );
    console.info(
      result.outcome === 'CREATED'
        ? `Created local test account ${LOCAL_ADMIN.email} (user ${result.userId}).`
        : `Local test account ${LOCAL_ADMIN.email} already exists (user ${result.userId}); left unchanged.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Runs only when executed (`pnpm db:seed`), so tests can import seedLocalAdmin. Real paths on both
// sides: through a symlinked directory argv[1] keeps the link while import.meta.url is resolved.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    await main();
  } catch (error) {
    console.error(
      'Local seed failed:',
      error instanceof Error && error.name === 'UnsafeSeedDatabaseError'
        ? error.message
        : error,
    );
    process.exitCode = 1;
  }
}
