import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../database/prisma.service.js';
import { LeaveAbsenceSource } from '../leave/leave-integration.js';
import { ScheduleAttendanceService } from '../scheduling/schedule-attendance.service.js';
import { TimeDomainService } from './time-domain.service.js';
import { SystemClock, TimeService } from './time.service.js';

/**
 * Background job contract for Time (Phase 9.5). The worker routes this job to
 * runScanOpenTimeEntriesJob; the API owns the logic. Framework-free composition, like the
 * leave and scheduling jobs, so the worker needs no Nest application.
 *
 * The scan flags open entries past the policy's missed-punch threshold (MISSING_CLOCK_OUT), or
 * auto-closes them at a trusted expected end. It only ever looks at TimeEntry rows, so
 * SIGN_IN_ONLY attendance (which never opens an entry) can never be flagged. Idempotent: an
 * entry already flagged is escalated at most once, never duplicated.
 */
export const TIME_QUEUE = 'hrms-default';
export const SCAN_OPEN_TIME_ENTRIES_JOB = 'time.scan-open-entries';
/** Stable id of the repeat, so registering it again on every worker start is a no-op. */
export const SCAN_OPEN_TIME_ENTRIES_SCHEDULER =
  'time.scan-open-entries.every-15-minutes';
export const SCAN_OPEN_TIME_ENTRIES_CRON = '*/15 * * * *';

export function createTimeService(prisma: PrismaService) {
  const targets = new PositionAuthorizationTargetResolver(prisma);
  return new TimeService(
    prisma,
    new TimeDomainService(),
    new AuthorizationService(prisma),
    targets,
    new AuditService(prisma),
    new SystemClock(),
    new ScheduleAttendanceService(prisma, targets),
    new LeaveAbsenceSource(prisma),
  );
}

export function parseScanOpenTimeEntriesJobData(
  data: unknown,
): Record<string, never> {
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== 'object' || Array.isArray(data))
  ) {
    throw new Error('Job data must be an object.');
  }
  if (data && Object.keys(data).length > 0) {
    throw new Error('The open time entry scan takes no parameters.');
  }
  return {};
}

export async function runScanOpenTimeEntriesJob(
  data: unknown,
  options: { prisma?: PrismaService; databaseUrl?: string } = {},
) {
  parseScanOpenTimeEntriesJobData(data);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl) {
    throw new Error('DATABASE_URL must be configured for time jobs.');
  }
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await createTimeService(prisma).scanOpenTimeEntriesForExceptions({
      userAgent: 'hrms-worker',
    });
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}

// ─── Batch 4C: attendance-only automation (off unless switched on) ─────────────────────────

/**
 * Rollout switch for the Batch 4C attendance automation jobs. The worker registers their
 * schedules only when `TIME_ATTENDANCE_AUTOMATION_ENABLED=true`, and removes them otherwise, so
 * deploying this code schedules nothing. Even when on, each organization opts in through its
 * time policy (periods.autoGenerate, noShow.enabled); both are off by default. Any value other
 * than empty, "true" or "false" stops the worker at start-up.
 */
export const TIME_ATTENDANCE_AUTOMATION_ENABLED =
  'TIME_ATTENDANCE_AUTOMATION_ENABLED';

export function timeAttendanceAutomationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[TIME_ATTENDANCE_AUTOMATION_ENABLED]?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(
    `${TIME_ATTENDANCE_AUTOMATION_ENABLED} must be "true" or "false".`,
  );
}

/** Daily: attendance-only periods (and, if configured, their timesheets); idempotent. */
export const PREPARE_ATTENDANCE_PERIODS_JOB = 'time.prepare-attendance-periods';
export const PREPARE_ATTENDANCE_PERIODS_SCHEDULER =
  'time.prepare-attendance-periods.daily';
/** 02:40 UTC; each organization's "today" is its own timezone's date. */
export const PREPARE_ATTENDANCE_PERIODS_CRON = '40 2 * * *';

/** Every 15 minutes: NO_SHOW review exceptions for published shifts; idempotent. */
export const DETECT_NO_SHOWS_JOB = 'time.detect-no-shows';
export const DETECT_NO_SHOWS_SCHEDULER =
  'time.detect-no-shows.every-15-minutes';
export const DETECT_NO_SHOWS_CRON = '7,22,37,52 * * * *';

async function withTimeService<T>(
  data: unknown,
  options: { prisma?: PrismaService; databaseUrl?: string },
  run: (time: TimeService) => Promise<T>,
) {
  parseScanOpenTimeEntriesJobData(data);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl) {
    throw new Error('DATABASE_URL must be configured for time jobs.');
  }
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await run(createTimeService(prisma));
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}

export async function runPrepareAttendancePeriodsJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    env?: Record<string, string | undefined>;
  } = {},
) {
  if (!timeAttendanceAutomationEnabled(options.env)) {
    return {
      disabled: true as const,
      organizations: 0,
      periodsCreated: 0,
      timesheetsCreated: 0,
      skippedPayrollManaged: [] as string[],
      failed: [] as Array<{ organizationId: string; message: string }>,
    };
  }
  return withTimeService(data, options, async (time) => ({
    disabled: false as const,
    ...(await time.prepareAttendancePeriods({ userAgent: 'hrms-worker' })),
  }));
}

export async function runDetectNoShowsJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    env?: Record<string, string | undefined>;
  } = {},
) {
  if (!timeAttendanceAutomationEnabled(options.env)) {
    return {
      disabled: true as const,
      scanned: 0,
      detected: 0,
      superseded: 0,
      failed: [] as Array<{ scheduledShiftId: string; message: string }>,
    };
  }
  return withTimeService(data, options, async (time) => ({
    disabled: false as const,
    ...(await time.detectNoShows({}, { userAgent: 'hrms-worker' })),
  }));
}
