import { AccountTokenType } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { smtpSettingsFromEnv } from '../email/smtp-mailer.js';
import { googleWorkspaceServices } from '../integrations/google/google-workspace-jobs.js';
import { createAccountEmailService } from './account-email.composition.js';
import { AccountEmailService } from './account-email.service.js';
import { AccountTokenService } from './account-token.service.js';
import {
  EMAIL_VERIFICATION_TOKEN_LIFETIME_MS,
  PASSWORD_RESET_TOKEN_LIFETIME_MS,
} from './auth-constants.js';

/**
 * Batch 2 (D6) — account recovery email through the worker. `POST /auth/forgot-password` and
 * `POST /auth/resend-verification` enqueue exactly one job per accepted request, for known and
 * unknown addresses alike (`userId` is null when no eligible account matched), so the API does
 * the same work and gives the same answer either way. The job never carries a token, an
 * address or a password.
 *
 * The worker re-checks eligibility, skips requests older than the link lifetime, issues a fresh
 * single-use token, sends it (Gmail, then the deployment SMTP server) and audits the outcome.
 * On failure the token is withdrawn and the job retried with backoff; each attempt issues a new
 * token, superseding the previous one. A refused address is permanent (not retried).
 */
export const ACCOUNT_EMAIL_QUEUE = 'hrms-default';
export const DELIVER_ACCOUNT_EMAIL_JOB = 'auth.deliver-account-email';
export const ACCOUNT_EMAIL_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { age: 60 * 60, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 1_000 },
};

export type AccountRecoveryKind = 'password-reset' | 'verification';

export interface AccountEmailJobData {
  kind: AccountRecoveryKind;
  userId: string | null;
  requestedAt: string;
}

/** A job that must not be retried (malformed data, a refused address). */
export class AccountEmailJobError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AccountEmailJobError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAccountEmailJobData(data: unknown): AccountEmailJobData {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new AccountEmailJobError('Job data must be an object.', false);
  const input = data as Record<string, unknown>;
  const unknown = Object.keys(input).filter(
    (key) => !['kind', 'userId', 'requestedAt'].includes(key),
  );
  if (unknown.length > 0)
    throw new AccountEmailJobError(`Unknown parameter: ${unknown[0]}.`, false);
  if (input.kind !== 'password-reset' && input.kind !== 'verification')
    throw new AccountEmailJobError(
      'kind must be password-reset or verification.',
      false,
    );
  if (
    input.userId !== null &&
    (typeof input.userId !== 'string' || !UUID.test(input.userId))
  )
    throw new AccountEmailJobError('userId must be a UUID or null.', false);
  if (
    typeof input.requestedAt !== 'string' ||
    Number.isNaN(Date.parse(input.requestedAt))
  )
    throw new AccountEmailJobError('requestedAt must be a timestamp.', false);
  return {
    kind: input.kind,
    userId: input.userId,
    requestedAt: input.requestedAt,
  };
}

export type AccountEmailJobOutcome =
  | { status: 'SENT' }
  | {
      status: 'SKIPPED';
      reason: 'NO_ACCOUNT' | 'NOT_ELIGIBLE' | 'STALE';
    };

const LIFETIME: Record<AccountRecoveryKind, number> = {
  'password-reset': PASSWORD_RESET_TOKEN_LIFETIME_MS,
  verification: EMAIL_VERIFICATION_TOKEN_LIFETIME_MS,
};

/** One recovery email, as the worker sends it (see the module comment). */
export async function deliverAccountRecoveryEmail(
  prisma: PrismaService,
  emails: AccountEmailService,
  data: AccountEmailJobData,
  now = new Date(),
): Promise<AccountEmailJobOutcome> {
  if (!data.userId) return { status: 'SKIPPED', reason: 'NO_ACCOUNT' };
  if (now.getTime() - Date.parse(data.requestedAt) > LIFETIME[data.kind])
    return { status: 'SKIPPED', reason: 'STALE' };
  const user = await prisma.user.findUnique({
    where: { id: data.userId },
    select: {
      id: true,
      email: true,
      status: true,
      archivedAt: true,
      passwordHash: true,
      emailVerifiedAt: true,
    },
  });
  const eligible =
    user?.status === 'ACTIVE' &&
    user.archivedAt === null &&
    (data.kind === 'password-reset'
      ? user.passwordHash !== null
      : user.emailVerifiedAt === null);
  if (!user || !eligible) return { status: 'SKIPPED', reason: 'NOT_ELIGIBLE' };

  const audit = new AuditService(prisma);
  const tokens = new AccountTokenService(prisma, audit);
  const issued = await tokens.issue(
    user.id,
    data.kind === 'password-reset'
      ? AccountTokenType.PASSWORD_RESET
      : AccountTokenType.EMAIL_VERIFICATION,
    LIFETIME[data.kind],
  );
  const message = {
    email: user.email,
    token: issued.token,
    expiresAt: issued.expiresAt,
    userId: user.id,
  };
  const event = {
    actorUserId: user.id,
    action:
      data.kind === 'password-reset'
        ? 'AUTH_PASSWORD_RESET_REQUESTED'
        : 'AUTH_EMAIL_VERIFICATION_SENT',
    entityType: 'User',
    entityId: user.id,
  };
  try {
    if (data.kind === 'password-reset') await emails.sendPasswordReset(message);
    else await emails.sendVerification(message);
  } catch (error) {
    // Never a usable token for an email nobody received.
    await tokens.withdraw(issued.id);
    await audit.write({ ...event, metadata: { outcome: 'DELIVERY_FAILED' } });
    const status = (error as { getStatus?: () => number }).getStatus?.();
    const code = (
      (error as { getResponse?: () => unknown }).getResponse?.() as
        { code?: unknown } | undefined
    )?.code;
    throw new AccountEmailJobError(
      `Account email (${data.kind}) for user ${user.id} was not delivered: ${
        typeof code === 'string' ? code : 'SEND_FAILED'
      }`,
      // Unconfigured (503 ACCOUNT_EMAIL_UNAVAILABLE) or failed sends may succeed later.
      status === undefined || status >= 500,
    );
  }
  await audit.write({ ...event, metadata: { outcome: 'SENT' } });
  return { status: 'SENT' };
}

/** Fails fast at worker start-up when the email configuration is invalid (no secrets shown). */
export function assertAccountEmailConfiguration(
  env: Record<string, string | undefined> = process.env,
) {
  smtpSettingsFromEnv(env);
}

export async function runDeliverAccountEmailJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    emails?: AccountEmailService;
    env?: Record<string, string | undefined>;
    now?: Date;
  } = {},
): Promise<AccountEmailJobOutcome> {
  const parsed = parseAccountEmailJobData(data);
  const env = options.env ?? process.env;
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  if (!options.prisma && !databaseUrl)
    throw new Error('DATABASE_URL must be configured for account email jobs.');
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    const emails =
      options.emails ??
      (() => {
        const google = googleWorkspaceServices(prisma, { env });
        return createAccountEmailService({
          prisma,
          runtime: google.runtime,
          api: google.api,
          env,
        });
      })();
    return await deliverAccountRecoveryEmail(
      prisma,
      emails,
      parsed,
      options.now,
    );
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}
