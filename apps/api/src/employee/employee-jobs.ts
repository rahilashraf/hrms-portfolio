import { HttpException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { EmployeeAccessService } from './employee-access.service.js';
import { EmployeeDomainService } from './employee-domain.service.js';
import { EmployeeLifecycleService } from './employee-lifecycle.service.js';

/**
 * Background job contract for Core HR assignment lifecycle. The worker routes this job to
 * runActivateDueAssignmentsJob; the API owns the logic (framework-free composition, like the
 * other *-jobs modules, so the worker needs no Nest application).
 *
 * Hourly, every PLANNED assignment whose start date has arrived in its own business timezone
 * becomes ACTIVE through EmployeeDomainService.activateAssignment — the exact transition, lock and
 * EMPLOYMENT_ASSIGNMENT_ACTIVATED audit of the manual API action (source AUTOMATIC, no actor).
 *
 * Safe to run anywhere, any number of times:
 *  - idempotent: an already ACTIVE assignment is a no-op without a second audit entry;
 *  - concurrent workers serialize on the assignment row lock and activate it exactly once;
 *  - missed runs recover by themselves: candidates are every due PLANNED assignment (no lower
 *    bound on the start date), so a worker that was down for days activates them all next run;
 *  - each assignment commits in its own transaction: one failure never undoes the others, and
 *    a run with failures is reported (and retried) while what succeeded stays committed.
 * Assignments that must not be activated (expired, inactive employee, no timezone) are skipped
 * with their reason, never forced.
 */
export const EMPLOYEE_QUEUE = 'hrms-default';
export const ACTIVATE_DUE_ASSIGNMENTS_JOB = 'employee.activate-due-assignments';
/** Stable id of the repeat, so registering it again on every worker start is a no-op. */
export const ACTIVATE_DUE_ASSIGNMENTS_SCHEDULER =
  'employee.activate-due-assignments.hourly';
/** Hourly: each timezone's local midnight is picked up within the hour. */
export const ACTIVATE_DUE_ASSIGNMENTS_CRON = '5 * * * *';

/** Domain refusals that mean "not activatable now", reported as skipped (never retried). */
const SKIP_CODES = new Set([
  'EMPLOYMENT_ASSIGNMENT_NOT_STARTED',
  'EMPLOYMENT_ASSIGNMENT_EXPIRED',
  'EMPLOYMENT_ASSIGNMENT_NOT_PLANNED',
  'EMPLOYEE_NOT_ACTIVE',
  'EMPLOYEE_ASSIGNMENT_TIMEZONE_UNRESOLVED',
  // Batch 5B: never forced into an archived position.
  'POSITION_ARCHIVED',
]);

export interface ActivateDueAssignmentsOutcome {
  scanned: number;
  activated: string[];
  alreadyActive: number;
  skipped: Array<{ employmentAssignmentId: string; code: string }>;
  failed: Array<{ employmentAssignmentId: string; message: string }>;
}

function refusalCode(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const response = error.getResponse();
  return typeof response === 'object' &&
    response !== null &&
    typeof (response as { code?: unknown }).code === 'string'
    ? (response as { code: string }).code
    : null;
}

export async function activateDueAssignments(
  prisma: PrismaService,
  domain: EmployeeDomainService,
  now: Date = new Date(),
): Promise<ActivateDueAssignmentsOutcome> {
  // Timezones run up to 14h ahead of UTC: tomorrow's UTC date bounds every local "today". The
  // domain decides per assignment, in its own timezone, whether the start date has arrived.
  const horizon = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const candidates = await prisma.employmentAssignment.findMany({
    where: { status: 'PLANNED', startDate: { lte: horizon } },
    select: { id: true },
    orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
  });
  const outcome: ActivateDueAssignmentsOutcome = {
    scanned: candidates.length,
    activated: [],
    alreadyActive: 0,
    skipped: [],
    failed: [],
  };
  for (const { id } of candidates) {
    try {
      const result = await domain.activateAssignment(id, {
        source: 'AUTOMATIC',
        context: { userAgent: 'hrms-worker' },
        now,
      });
      if (result.outcome === 'ACTIVATED') outcome.activated.push(id);
      else outcome.alreadyActive += 1;
    } catch (error) {
      const code = refusalCode(error);
      if (code && SKIP_CODES.has(code)) {
        outcome.skipped.push({ employmentAssignmentId: id, code });
      } else {
        outcome.failed.push({
          employmentAssignmentId: id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return outcome;
}

export function parseActivateDueAssignmentsJobData(
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
    throw new Error('Assignment activation takes no parameters.');
  }
  return {};
}

export async function runActivateDueAssignmentsJob(
  data: unknown,
  options: { prisma?: PrismaService; databaseUrl?: string; now?: Date } = {},
): Promise<ActivateDueAssignmentsOutcome> {
  parseActivateDueAssignmentsJobData(data);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl) {
    throw new Error('DATABASE_URL must be configured for employee jobs.');
  }
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await activateDueAssignments(
      prisma,
      new EmployeeDomainService(prisma, new AuditService(prisma)),
      options.now,
    );
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}

// ─── Batch 5A: lifecycle automation (default OFF) ──────────────────────────

/**
 * Batch 5A (K11) — scheduled terminations and assignment ends. Both jobs are scheduled only when
 * EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED is "true" on the worker (removed otherwise), and each run
 * does nothing unless it is: with the switch off, authorized users apply due transitions by hand
 * (R1: the same rules, locks and audit). Both are idempotent, lock per employee, commit per
 * employee or assignment and recover missed runs (no lower date bound). An invalid value stops
 * the worker at start-up.
 */
export const EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED =
  'EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED';

export function employeeLifecycleAutomationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value =
    env[EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED]?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(
    `${EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED} must be "true" or "false".`,
  );
}

export const APPLY_DUE_TERMINATIONS_JOB = 'employee.apply-due-terminations';
export const APPLY_DUE_TERMINATIONS_SCHEDULER =
  'employee.apply-due-terminations.hourly';
/** Hourly: a termination takes effect once its date has passed in each assignment's time zone. */
export const APPLY_DUE_TERMINATIONS_CRON = '10 * * * *';

export const END_DUE_ASSIGNMENTS_JOB = 'employee.end-due-assignments';
export const END_DUE_ASSIGNMENTS_SCHEDULER =
  'employee.end-due-assignments.hourly';
export const END_DUE_ASSIGNMENTS_CRON = '15 * * * *';

function lifecycleService(prisma: PrismaService) {
  const audit = new AuditService(prisma);
  const authorization = new AuthorizationService(prisma);
  return new EmployeeLifecycleService(
    prisma,
    new EmployeeDomainService(prisma, audit),
    new EmployeeAccessService(
      prisma,
      authorization,
      new PositionAuthorizationTargetResolver(prisma),
      audit,
    ),
    authorization,
    audit,
  );
}

function assertNoJobData(data: unknown, job: string) {
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== 'object' || Array.isArray(data))
  ) {
    throw new Error('Job data must be an object.');
  }
  if (data && Object.keys(data).length > 0) {
    throw new Error(`${job} takes no parameters.`);
  }
}

async function withLifecycle<T>(
  options: { prisma?: PrismaService; databaseUrl?: string },
  run: (service: EmployeeLifecycleService) => Promise<T>,
): Promise<T> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl) {
    throw new Error('DATABASE_URL must be configured for employee jobs.');
  }
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await run(lifecycleService(prisma));
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}

type LifecycleJobOptions = {
  prisma?: PrismaService;
  databaseUrl?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
};

export async function runApplyDueTerminationsJob(
  data: unknown,
  options: LifecycleJobOptions = {},
) {
  assertNoJobData(data, 'Applying due terminations');
  if (!employeeLifecycleAutomationEnabled(options.env)) {
    return {
      disabled: true as const,
      scanned: 0,
      completed: [] as string[],
      partiallyApplied: [] as string[],
      notDue: 0,
      blocked: [] as Array<{ terminationId: string; code: string }>,
      failed: [] as Array<{ terminationId: string; message: string }>,
      retentionsExpired: [] as string[],
      retentionsFailed: [] as Array<{ employeeId: string; message: string }>,
    };
  }
  return withLifecycle(options, async (service) => ({
    disabled: false as const,
    ...(await service.processDueTerminations(options.now)),
  }));
}

export async function runEndDueAssignmentsJob(
  data: unknown,
  options: LifecycleJobOptions = {},
) {
  assertNoJobData(data, 'Ending due assignments');
  if (!employeeLifecycleAutomationEnabled(options.env)) {
    return {
      disabled: true as const,
      scanned: 0,
      ended: [] as string[],
      notDue: 0,
      failed: [] as Array<{ employmentAssignmentId: string; message: string }>,
    };
  }
  return withLifecycle(options, async (service) => ({
    disabled: false as const,
    ...(await service.processDueAssignmentEnds(options.now)),
  }));
}

/**
 * Security remediation M3 (decision A) — retained-grant expiry reconciliation. When a grant
 * kept after a termination (an approved KEEP) stops being effective, the login is disabled if
 * nothing else authorizes it (EmployeeLifecycleService.reconcileRetainedGrants). It runs on its
 * own schedule, whatever EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED says, and does nothing else: no
 * termination is applied, no assignment ended, no grant revoked, no payroll or time touched.
 *
 * On by default; RETAINED_GRANT_RECONCILIATION_ENABLED=false removes the schedule on the next
 * worker start (rollback switch). RETAINED_GRANT_RECONCILIATION_CRON may override the interval
 * (five-field cron, UTC). Idempotent and safe to run concurrently; per-employee failures are
 * reported and fail the run, which is retried.
 */
export const RECONCILE_RETAINED_GRANTS_JOB =
  'employee.reconcile-retained-grants';
export const RECONCILE_RETAINED_GRANTS_SCHEDULER =
  'employee.reconcile-retained-grants.quarter-hourly';
/** Every 15 minutes (offset from the other quarter-hourly jobs). */
export const RECONCILE_RETAINED_GRANTS_CRON = '7,22,37,52 * * * *';
export const RETAINED_GRANT_RECONCILIATION_ENABLED =
  'RETAINED_GRANT_RECONCILIATION_ENABLED';
export const RETAINED_GRANT_RECONCILIATION_CRON =
  'RETAINED_GRANT_RECONCILIATION_CRON';
/** Due retained grants handled per run (the next run continues). */
export const RECONCILE_RETAINED_GRANTS_BATCH = 200;

/** On unless explicitly "false" (the M3 security control; the switch exists for rollback). */
export function retainedGrantReconciliationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value =
    env[RETAINED_GRANT_RECONCILIATION_ENABLED]?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(
    `${RETAINED_GRANT_RECONCILIATION_ENABLED} must be "true" or "false".`,
  );
}

/** Minute, hour, day of month, month, day of week (0 and 7 are Sunday). */
const CRON_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** One field: comma-separated `*`, `n` or `a-b`, each with an optional `/step` (step ≥ 1). */
function validCronField(field: string, [min, max]: readonly [number, number]) {
  return field.split(',').every((part) => {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return false;
    const [, , from, to, step] = match;
    if (step !== undefined && Number(step) < 1) return false;
    if (from === undefined) return true;
    const low = Number(from);
    const high = to === undefined ? low : Number(to);
    return low >= min && high <= max && low <= high;
  });
}

/** The schedule: the default, or a validated five-field override (values in range). */
export function retainedGrantReconciliationCron(
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[RETAINED_GRANT_RECONCILIATION_CRON]?.trim();
  if (!value) return RECONCILE_RETAINED_GRANTS_CRON;
  const fields = value.split(/\s+/);
  if (
    fields.length !== 5 ||
    !fields.every((field, index) => validCronField(field, CRON_RANGES[index]!))
  ) {
    throw new Error(
      `${RETAINED_GRANT_RECONCILIATION_CRON} must be a five-field cron expression with values in range.`,
    );
  }
  return fields.join(' ');
}

export interface ReconcileRetainedGrantsOutcome {
  scanned: number;
  handled: string[];
  failed: Array<{ employeeId: string; message: string }>;
}

export async function runReconcileRetainedGrantsJob(
  data: unknown,
  options: LifecycleJobOptions & { limit?: number } = {},
): Promise<ReconcileRetainedGrantsOutcome> {
  assertNoJobData(data, 'Reconciling retained grants');
  return withLifecycle(options, (service) =>
    service.reconcileRetainedGrants(
      options.now,
      options.limit ?? RECONCILE_RETAINED_GRANTS_BATCH,
    ),
  );
}
