import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../database/prisma.service.js';
import { SchedulingDomainService } from './scheduling-domain.service.js';
import {
  DEFAULT_GENERATION_HORIZON_DAYS,
  MAX_GENERATION_RANGE_DAYS,
  ShiftGenerationService,
} from './shift-generation.service.js';

/**
 * Background job contract for recurring shift generation (Phase 7 Batch 6). The worker app
 * routes this job to runExtendGeneratedShiftsJob; the API owns the logic. Framework-free
 * composition, like the authorization CLI, so the worker needs no Nest application.
 */
export const SCHEDULING_QUEUE = 'hrms-default';
export const EXTEND_GENERATED_SHIFTS_JOB = 'scheduling.extend-generated-shifts';
/** Stable id of the daily repeat, so registering it again on every worker start is a no-op. */
export const EXTEND_GENERATED_SHIFTS_SCHEDULER =
  'scheduling.extend-generated-shifts.daily';
export const EXTEND_GENERATED_SHIFTS_CRON = '15 2 * * *';

export interface ExtendGeneratedShiftsJobData {
  /** Defaults to the Scheduling default horizon. */
  horizonDays?: number;
  /** ISO instant the run is "as of"; defaults to now. */
  asOf?: string;
  /** Limits the run to one organization's patterns; defaults to all. */
  organizationId?: string;
}

export function createShiftGenerationService(prisma: PrismaService) {
  return new ShiftGenerationService(
    prisma,
    new AuthorizationService(prisma),
    new PositionAuthorizationTargetResolver(prisma),
    new SchedulingDomainService(),
    new AuditService(prisma),
  );
}

export function parseExtendGeneratedShiftsJobData(
  data: unknown,
): ExtendGeneratedShiftsJobData {
  const input = (data ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Job data must be an object.');
  }
  const horizonDays = input.horizonDays ?? DEFAULT_GENERATION_HORIZON_DAYS;
  if (
    typeof horizonDays !== 'number' ||
    !Number.isInteger(horizonDays) ||
    horizonDays < 1 ||
    horizonDays > MAX_GENERATION_RANGE_DAYS
  ) {
    throw new Error(
      `horizonDays must be an integer from 1 to ${MAX_GENERATION_RANGE_DAYS}.`,
    );
  }
  if (
    input.asOf !== undefined &&
    (typeof input.asOf !== 'string' || Number.isNaN(Date.parse(input.asOf)))
  ) {
    throw new Error('asOf must be an ISO-8601 instant.');
  }
  if (
    input.organizationId !== undefined &&
    (typeof input.organizationId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(input.organizationId))
  ) {
    throw new Error('organizationId must be a UUID.');
  }
  return {
    horizonDays,
    ...(input.asOf ? { asOf: input.asOf as string } : {}),
    ...(input.organizationId
      ? { organizationId: input.organizationId as string }
      : {}),
  };
}

/**
 * Extends generated shifts to the rolling horizon for every pattern that needs it. Runs as
 * trusted internal work (no user, no per-run audit); each pattern is its own transaction and
 * failures are reported, not thrown, so one bad pattern never blocks the rest.
 */
export async function runExtendGeneratedShiftsJob(
  data: unknown,
  options: { prisma?: PrismaService; databaseUrl?: string } = {},
) {
  const input = parseExtendGeneratedShiftsJobData(data);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl) {
    throw new Error('DATABASE_URL must be configured for scheduling jobs.');
  }
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await createShiftGenerationService(prisma).extendGeneratedShifts({
      horizonDays: input.horizonDays,
      organizationId: input.organizationId,
      ...(input.asOf ? { asOf: new Date(input.asOf) } : {}),
    });
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}
