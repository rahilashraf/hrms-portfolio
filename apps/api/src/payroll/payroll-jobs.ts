import { AuditService } from '../audit/audit.service.js';
import { FeatureGateService } from '../features/feature-gate.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { addDays, localDateOf } from '../common/domain-support.js';
import { CompensationPayrollSource } from '../compensation/compensation-payroll.source.js';
import { PrismaService } from '../database/prisma.service.js';
import { createTimeService } from '../time/time-jobs.js';
import { PayrollAccessService } from './payroll-access.service.js';
import { PayrollCalendarService } from './payroll-calendar.service.js';
import { PayrollClock } from './payroll-common.js';
import { PayrollTimeOrchestrationService } from './payroll-time-orchestration.service.js';

/**
 * Background job contract for Payroll (Phase 10). The worker routes this job to
 * runPreparePayrollPeriodsJob; the API owns the logic. Framework-free composition, like the
 * time, leave and scheduling jobs, so the worker needs no Nest application.
 *
 * Preparation only: for every active pay group with a calendar it generates the upcoming pay
 * periods (with their TimePeriods), then asks Time to materialize the timesheets of every open
 * period. It never calculates, approves or finalizes payroll, never creates deductions and never
 * applies adjustments: financially consequential steps stay explicit. Idempotent: a retry only
 * creates what is still missing.
 */
export const PAYROLL_QUEUE = 'hrms-default';
export const PREPARE_PAYROLL_PERIODS_JOB = 'payroll.prepare-periods';
/** Stable id of the repeat, so registering it again on every worker start is a no-op. */
export const PREPARE_PAYROLL_PERIODS_SCHEDULER =
  'payroll.prepare-periods.daily';
export const PREPARE_PAYROLL_PERIODS_CRON = '20 6 * * *';
/** How far ahead periods are kept generated. */
export const PAYROLL_PERIOD_LOOKAHEAD_DAYS = 62;

export function createPayrollJobServices(
  prisma: PrismaService,
  clock = new PayrollClock(),
) {
  const access = new PayrollAccessService(
    prisma,
    new AuthorizationService(prisma),
  );
  const audit = new AuditService(prisma);
  const time = createTimeService(prisma);
  return {
    calendars: new PayrollCalendarService(prisma, access, audit, clock, time),
    timeOrchestration: new PayrollTimeOrchestrationService(
      prisma,
      access,
      audit,
      clock,
      time,
      new CompensationPayrollSource(prisma),
    ),
  };
}

export function parsePreparePayrollPeriodsJobData(
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
    throw new Error('Payroll period preparation takes no parameters.');
  }
  return {};
}

export interface PreparePayrollPeriodsOutcome {
  payGroups: number;
  periodsCreated: number;
  periodsMaterialized: number;
  /** Phase 18: organizations skipped because Payroll is disabled for them. */
  skippedOrganizations: string[];
  failed: Array<{
    payGroupId?: string;
    payrollPeriodId?: string;
    message: string;
  }>;
}

export async function preparePayrollPeriods(
  prisma: PrismaService,
  clock = new PayrollClock(),
): Promise<PreparePayrollPeriodsOutcome> {
  const services = createPayrollJobServices(prisma, clock);
  const context = { userAgent: 'hrms-worker' };
  const now = clock.now();
  const through = addDays(
    localDateOf(now, 'UTC'),
    PAYROLL_PERIOD_LOOKAHEAD_DAYS,
  );
  const outcome: PreparePayrollPeriodsOutcome = {
    payGroups: 0,
    periodsCreated: 0,
    periodsMaterialized: 0,
    skippedOrganizations: [
      ...(await new FeatureGateService(prisma).disabledOrganizations(
        'PAYROLL',
      )),
    ].sort(),
    failed: [],
  };
  const payGroups = await prisma.payGroup.findMany({
    where: {
      archivedAt: null,
      payrollCalendars: { some: {} },
      organizationId: { notIn: outcome.skippedOrganizations },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  for (const payGroup of payGroups) {
    outcome.payGroups += 1;
    try {
      const created = await prisma.$transaction(
        (tx) =>
          services.calendars.ensurePeriods(tx, payGroup.id, through, context),
        { timeout: 60_000 },
      );
      outcome.periodsCreated += created.length;
    } catch (error) {
      outcome.failed.push({
        payGroupId: payGroup.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Open (started, not yet finalized) periods get their timesheets in Time.
  const periods = await prisma.payrollPeriod.findMany({
    where: {
      status: { in: ['OPEN', 'PROCESSING'] },
      payGroup: { archivedAt: null },
      organizationId: { notIn: outcome.skippedOrganizations },
      periodStart: { lte: addDays(localDateOf(now, 'UTC'), 1) },
    },
    select: { id: true },
    orderBy: { periodStart: 'asc' },
  });
  for (const period of periods) {
    const result = await services.timeOrchestration.materializePeriod(
      period.id,
      context,
    );
    if (result.failed.length === 0) {
      outcome.periodsMaterialized += 1;
    } else {
      outcome.failed.push(
        ...result.failed.map((failure) => ({
          payrollPeriodId: period.id,
          message: `${failure.employeeId}: ${failure.message}`,
        })),
      );
    }
  }
  return outcome;
}

export async function runPreparePayrollPeriodsJob(
  data: unknown,
  options: { prisma?: PrismaService; databaseUrl?: string } = {},
) {
  parsePreparePayrollPeriodsJobData(data);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl) {
    throw new Error('DATABASE_URL must be configured for payroll jobs.');
  }
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await preparePayrollPeriods(prisma);
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}
