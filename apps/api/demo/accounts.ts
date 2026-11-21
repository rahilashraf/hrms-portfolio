import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../src/database/prisma.service.js';
import type { PasswordHasherService } from '../src/security/password-hasher.service.js';
import { DEMO_ACCOUNTS, type DemoAccountKey } from './dataset.js';

/**
 * Batch 11 — the demo's sign-in accounts. A deployment creates its first account with
 * `authz:create-initial-user` and everyone else through emailed invitations; a local demo has no
 * mailbox to receive them, so this creates the demo accounts directly in the same shape as
 * `createInitialUser` (an ACTIVE, email-verified user with an Argon2id password hash from the
 * API's own hasher). Everything else in the demo goes through the HTTP API.
 *
 * Passwords are never hardcoded:
 * - `DEMO_PASSWORD` (optional, at least 12 characters) sets one shared password, convenient for
 *   a local demo;
 * - otherwise each account gets a random password when it is first created.
 * Existing accounts keep their password on a rerun unless `resetPasswords` is set; the
 * passwords that were set are returned so the CLI can write them to the git-ignored
 * credentials file.
 */

export interface DemoCredential {
  key: DemoAccountKey;
  email: string;
  /** Null when the account already existed and its password was kept. */
  password: string | null;
}

export function generateDemoPassword() {
  // 18 random bytes → 24 base64url characters, plus a fixed tail that reads as a demo value.
  return `Demo-${randomBytes(18).toString('base64url')}`;
}

export function demoPasswordFor(environment: NodeJS.ProcessEnv) {
  const shared = environment.DEMO_PASSWORD;
  if (shared === undefined || shared === '') return null;
  if (Array.from(shared).length < 12 || Array.from(shared).length > 128) {
    throw new Error('DEMO_PASSWORD must be between 12 and 128 characters.');
  }
  return shared;
}

export async function ensureDemoAccounts(
  prisma: PrismaService,
  passwords: PasswordHasherService,
  options: {
    sharedPassword: string | null;
    resetPasswords: boolean;
    now: Date;
  },
): Promise<{
  credentials: DemoCredential[];
  userIds: Record<DemoAccountKey, string>;
}> {
  const credentials: DemoCredential[] = [];
  const userIds = {} as Record<DemoAccountKey, string>;
  for (const account of DEMO_ACCOUNTS) {
    const existing = await prisma.user.findUnique({
      where: { email: account.email },
      select: { id: true },
    });
    if (existing && !options.resetPasswords) {
      userIds[account.key] = existing.id;
      credentials.push({
        key: account.key,
        email: account.email,
        password: null,
      });
      continue;
    }
    const password = options.sharedPassword ?? generateDemoPassword();
    // Hash outside the transaction (Argon2id is deliberately slow).
    const passwordHash = await passwords.hashPassword(password);
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          passwordChangedAt: options.now,
          mustChangePassword: false,
        },
      });
      userIds[account.key] = existing.id;
    } else {
      const user = await prisma.$transaction(async (tx) => {
        const person = await tx.person.create({
          data: { firstName: account.firstName, lastName: account.lastName },
          select: { id: true },
        });
        return tx.user.create({
          data: {
            personId: person.id,
            email: account.email,
            passwordHash,
            status: 'ACTIVE',
            emailVerifiedAt: options.now,
            passwordChangedAt: options.now,
            mustChangePassword: false,
          },
          select: { id: true },
        });
      });
      userIds[account.key] = user.id;
    }
    credentials.push({ key: account.key, email: account.email, password });
  }
  return { credentials, userIds };
}

/** The Person behind each demo account (the employee record links to it). */
export async function demoPersonIds(prisma: PrismaService) {
  const users = await prisma.user.findMany({
    where: { email: { in: DEMO_ACCOUNTS.map((account) => account.email) } },
    select: { email: true, personId: true },
  });
  const byEmail = new Map(users.map((user) => [user.email, user.personId]));
  return Object.fromEntries(
    DEMO_ACCOUNTS.map((account) => [
      account.key,
      byEmail.get(account.email) ?? null,
    ]),
  ) as Record<DemoAccountKey, string | null>;
}
