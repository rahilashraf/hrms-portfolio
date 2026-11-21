import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';

/**
 * Batch 2 (D3) — retention of sign-in records. `auth.prune-sessions-and-tokens` runs daily and
 * deletes, in bounded batches:
 *
 * - sessions revoked or expired more than 90 days ago (they keep an address and a user agent);
 * - account tokens (invitation, reset and verification links, stored hashed) used or expired
 *   more than 30 days ago.
 *
 * A live session (not revoked, not expired) or a usable token (unused, not expired) can never
 * match: both conditions lie in the past by at least the retention period. The run is
 * idempotent and safe to retry; it records only counts.
 *
 * Rollout switch: the deletion runs only when `AUTH_RECORD_RETENTION_ENABLED=true` on the worker.
 * Unset, empty or `false` keeps the schedule but each run does nothing (no database access), so
 * cleanup can be enabled later by setting the variable, without a code change. The value is read
 * on every run; any other value is refused at worker start-up.
 */
export const AUTH_RETENTION_QUEUE = 'hrms-default';
export const PRUNE_AUTH_RECORDS_JOB = 'auth.prune-sessions-and-tokens';
export const PRUNE_AUTH_RECORDS_SCHEDULER =
  'auth.prune-sessions-and-tokens.daily';
export const PRUNE_AUTH_RECORDS_CRON = '50 3 * * *';
export const SESSION_RETENTION_DAYS = 90;
export const ACCOUNT_TOKEN_RETENTION_DAYS = 30;

export const AUTH_RECORD_RETENTION_ENABLED = 'AUTH_RECORD_RETENTION_ENABLED';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether the deletion is switched on. Throws (naming only the variable) on an invalid value. */
export function authRecordRetentionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[AUTH_RECORD_RETENTION_ENABLED]?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(
    `${AUTH_RECORD_RETENTION_ENABLED} must be "true" or "false".`,
  );
}

/** Batch 2: invalid retention settings stop the worker at start-up. */
export function assertAuthRetentionConfiguration(
  env: Record<string, string | undefined> = process.env,
): void {
  authRecordRetentionEnabled(env);
}

export interface PruneAuthRecordsOutcome {
  /** False when the run was skipped because retention is switched off. */
  enabled?: boolean;
  sessionsDeleted: number;
  tokensDeleted: number;
  complete: boolean;
}

export async function pruneAuthRecords(
  prisma: PrismaService,
  options: { now?: Date; batchSize?: number; maxBatches?: number } = {},
): Promise<PruneAuthRecordsOutcome> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 1_000;
  const maxBatches = options.maxBatches ?? 100;
  const sessionCutoff = new Date(
    now.getTime() - SESSION_RETENTION_DAYS * DAY_MS,
  );
  const tokenCutoff = new Date(
    now.getTime() - ACCOUNT_TOKEN_RETENTION_DAYS * DAY_MS,
  );
  const outcome: PruneAuthRecordsOutcome = {
    sessionsDeleted: 0,
    tokensDeleted: 0,
    complete: false,
  };
  let sessionsDone = false;
  let tokensDone = false;
  for (
    let batch = 0;
    batch < maxBatches && !(sessionsDone && tokensDone);
    batch++
  ) {
    if (!sessionsDone) {
      const deleted = await prisma.$executeRaw`
        DELETE FROM "AuthSession" WHERE "id" IN (
          SELECT "id" FROM "AuthSession"
          WHERE ("revokedAt" IS NOT NULL AND "revokedAt" < ${sessionCutoff}::timestamptz)
             OR "expiresAt" < ${sessionCutoff}::timestamptz
          LIMIT ${batchSize}::int
          FOR UPDATE SKIP LOCKED
        )`;
      outcome.sessionsDeleted += deleted;
      sessionsDone = deleted < batchSize;
    }
    if (!tokensDone) {
      const deleted = await prisma.$executeRaw`
        DELETE FROM "AccountToken" WHERE "id" IN (
          SELECT "id" FROM "AccountToken"
          WHERE ("usedAt" IS NOT NULL AND "usedAt" < ${tokenCutoff}::timestamptz)
             OR "expiresAt" < ${tokenCutoff}::timestamptz
          LIMIT ${batchSize}::int
          FOR UPDATE SKIP LOCKED
        )`;
      outcome.tokensDeleted += deleted;
      tokensDone = deleted < batchSize;
    }
  }
  outcome.complete = sessionsDone && tokensDone;
  if (outcome.sessionsDeleted > 0 || outcome.tokensDeleted > 0) {
    // Not about one account or organization: listed in the audit viewer's System view.
    await new AuditService(prisma).write({
      action: 'AUTH_RECORDS_PRUNED',
      actorUserId: null,
      metadata: {
        sessionsDeleted: outcome.sessionsDeleted,
        tokensDeleted: outcome.tokensDeleted,
      },
    });
  }
  return outcome;
}

export async function runPruneAuthRecordsJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    now?: Date;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<PruneAuthRecordsOutcome> {
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== 'object' || Array.isArray(data))
  )
    throw new Error('Job data must be an object.');
  if (data && Object.keys(data).length > 0)
    throw new Error('Sign-in record retention takes no parameters.');
  if (!authRecordRetentionEnabled(options.env ?? process.env))
    return {
      enabled: false,
      sessionsDeleted: 0,
      tokensDeleted: 0,
      complete: true,
    };
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl)
    throw new Error('DATABASE_URL must be configured for the retention job.');
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return {
      enabled: true,
      ...(await pruneAuthRecords(prisma, { now: options.now })),
    };
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}
