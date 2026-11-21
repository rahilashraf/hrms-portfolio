import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { LeaveAccessService } from './leave-access.service.js';
import { parseDateOnly } from './leave-common.js';
import {
  LeaveEntitlementService,
  MAX_ENTITLEMENT_LOOKBACK_DAYS,
} from './leave-entitlement.service.js';
import { LeaveLedgerService } from './leave-ledger.service.js';

/**
 * Background job contract for leave entitlements (Phase 8). The worker routes this job to
 * runLeaveEntitlementsJob; the API owns the logic. Framework-free composition, like the
 * scheduling generation job, so the worker needs no Nest application.
 */
export const LEAVE_QUEUE = 'hrms-default';
export const PROCESS_LEAVE_ENTITLEMENTS_JOB = 'leave.process-entitlements';
/** Stable id of the daily repeat, so registering it again on every worker start is a no-op. */
export const PROCESS_LEAVE_ENTITLEMENTS_SCHEDULER =
  'leave.process-entitlements.daily';
export const PROCESS_LEAVE_ENTITLEMENTS_CRON = '30 2 * * *';

export interface ProcessLeaveEntitlementsJobData {
  /** Local date (YYYY-MM-DD) to process as of; defaults to each assignment's today. */
  asOf?: string;
  /** Limits the run to one organization; defaults to all. */
  organizationId?: string;
  lookbackDays?: number;
}

export function createLeaveEntitlementService(prisma: PrismaService) {
  const audit = new AuditService(prisma);
  const access = new LeaveAccessService(
    prisma,
    new AuthorizationService(prisma),
  );
  return new LeaveEntitlementService(
    prisma,
    new LeaveLedgerService(prisma, access, audit),
  );
}

export function parseProcessLeaveEntitlementsJobData(
  data: unknown,
): ProcessLeaveEntitlementsJobData {
  const input = (data ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Job data must be an object.');
  }
  if (input.asOf !== undefined) {
    if (typeof input.asOf !== 'string')
      throw new Error('asOf must be a YYYY-MM-DD date.');
    try {
      parseDateOnly(input.asOf, 'asOf');
    } catch {
      throw new Error('asOf must be a YYYY-MM-DD date.');
    }
  }
  if (
    input.organizationId !== undefined &&
    (typeof input.organizationId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(input.organizationId))
  ) {
    throw new Error('organizationId must be a UUID.');
  }
  if (
    input.lookbackDays !== undefined &&
    (typeof input.lookbackDays !== 'number' ||
      !Number.isInteger(input.lookbackDays) ||
      input.lookbackDays < 1 ||
      input.lookbackDays > MAX_ENTITLEMENT_LOOKBACK_DAYS)
  ) {
    throw new Error(
      `lookbackDays must be an integer from 1 to ${MAX_ENTITLEMENT_LOOKBACK_DAYS}.`,
    );
  }
  return {
    ...(input.asOf ? { asOf: input.asOf as string } : {}),
    ...(input.organizationId
      ? { organizationId: input.organizationId as string }
      : {}),
    ...(input.lookbackDays
      ? { lookbackDays: input.lookbackDays as number }
      : {}),
  };
}

/**
 * Posts every grant, accrual, carryover forfeiture and carryover expiry that is due. Idempotent
 * and retry-safe: every posting has a deterministic key, so a rerun posts only what is missing.
 */
export async function runLeaveEntitlementsJob(
  data: unknown,
  options: { prisma?: PrismaService; databaseUrl?: string } = {},
) {
  const input = parseProcessLeaveEntitlementsJobData(data);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl) {
    throw new Error('DATABASE_URL must be configured for leave jobs.');
  }
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await createLeaveEntitlementService(prisma).processEntitlements({
      ...(input.asOf ? { asOf: parseDateOnly(input.asOf, 'asOf') } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.lookbackDays ? { lookbackDays: input.lookbackDays } : {}),
    });
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}
