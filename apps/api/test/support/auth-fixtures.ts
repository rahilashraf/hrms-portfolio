import type { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AuditService } from '../../src/audit/audit.service.js';
import {
  AccountEmailService,
  accountEmailDeliveryFailed,
  type AccountEmailMessage,
} from '../../src/auth/account-email.service.js';
import {
  deliverAccountRecoveryEmail,
  type AccountEmailJobData,
} from '../../src/auth/account-email-jobs.js';
import type { AccountRecoveryQueue } from '../../src/auth/account-recovery-queue.service.js';
import { AccountTokenService } from '../../src/auth/account-token.service.js';
import type { AccessTokenService } from '../../src/auth/access-token.service.js';
import { AuthService } from '../../src/auth/auth.service.js';
import type { LoginRateLimiterService } from '../../src/auth/login-rate-limiter.service.js';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { PasswordHasherService } from '../../src/security/password-hasher.service.js';
import { SessionsService } from '../../src/sessions/sessions.service.js';
import { UsersService } from '../../src/users/users.service.js';
import type { SchedulingFixtures, Tx } from './scheduling-fixtures.js';

/** Batch 2: shared helpers for the authentication and account database specs. */
export const PASSWORD = 'Correct-Horse-Battery-42!';
export const NEW_PASSWORD = 'Another-Long-Passphrase-7';
export const META = { ipAddress: '203.0.113.9', userAgent: 'vitest' };
export const FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0';

export const testConfig = {
  getOrThrow: (key: string) => {
    const value = process.env[key];
    if (value === undefined) throw new Error(`${key} missing`);
    return key.startsWith('ARGON2_') ? Number(value) : value;
  },
} as unknown as ConfigService;
export const hasher = new PasswordHasherService(testConfig);

export const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;
export const statusOf = (error: unknown) =>
  (error as HttpException).getStatus?.();

/** Records what would have been emailed; can be told to fail. */
export class RecordingEmails extends AccountEmailService {
  sent: Array<{ kind: string; message: AccountEmailMessage }> = [];
  failing = false;
  assertAvailable() {}
  private async record(kind: string, message: AccountEmailMessage) {
    if (this.failing) throw accountEmailDeliveryFailed();
    this.sent.push({ kind, message });
  }
  sendInvitation(message: AccountEmailMessage) {
    return this.record('invitation', message);
  }
  sendPasswordReset(message: AccountEmailMessage) {
    return this.record('password-reset', message);
  }
  sendVerification(message: AccountEmailMessage) {
    return this.record('verification', message);
  }
}

/**
 * Records the recovery jobs the API would queue; `deliver` runs them as the worker would
 * (Batch 2, D6).
 */
export class RecordingRecoveryQueue {
  jobs: AccountEmailJobData[] = [];
  async enqueue(data: AccountEmailJobData) {
    this.jobs.push(data);
  }
  async deliver(client: PrismaService, emails: AccountEmailService) {
    const jobs = this.jobs.splice(0);
    const outcomes = [];
    for (const job of jobs)
      outcomes.push(await deliverAccountRecoveryEmail(client, emails, job));
    return outcomes;
  }
}

/** An ACTIVE login with a password, linked to a new Person (no employee record). */
export async function createLogin(
  tx: Tx,
  fx: SchedulingFixtures,
  label: string,
  options: {
    mustChangePassword?: boolean;
    password?: string;
    personId?: string;
  } = {},
) {
  const personId =
    options.personId ??
    (
      await tx.person.create({
        data: { firstName: label, lastName: fx.suffix },
      })
    ).id;
  const user = await tx.user.create({
    data: {
      personId,
      email: `b2-${label}-${fx.suffix.toLowerCase()}@example.com`,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      passwordHash: await hasher.hashPassword(options.password ?? PASSWORD),
      mustChangePassword: options.mustChangePassword ?? false,
    },
  });
  return { id: user.id, email: user.email, personId };
}

/** AuthService over a (rollback) client, with the login rate limiter and token signing stubbed. */
export function authServices(
  client: PrismaService,
  options: { passwords?: PasswordHasherService; emails?: RecordingEmails } = {},
) {
  const audit = new AuditService(client);
  const sessions = new SessionsService(client);
  const tokens = new AccountTokenService(client, audit);
  const emails = options.emails ?? new RecordingEmails();
  const passwords = options.passwords ?? hasher;
  const recovery = new RecordingRecoveryQueue();
  const auth = new AuthService(
    client,
    audit,
    new UsersService(client),
    sessions,
    passwords,
    { issue: async () => 'access-token' } as unknown as AccessTokenService,
    tokens,
    emails,
    {
      assertLoginAllowed: async () => undefined,
      assertVerificationResendAllowed: async () => undefined,
    } as unknown as LoginRateLimiterService,
    recovery as unknown as AccountRecoveryQueue,
  );
  return { audit, sessions, tokens, emails, passwords, auth, recovery };
}
