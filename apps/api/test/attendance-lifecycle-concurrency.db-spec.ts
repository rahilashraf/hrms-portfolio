import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  type SchedulingFixtures,
} from './support/scheduling-fixtures.js';
import {
  FixedClock,
  LIVE_TIME_POLICY,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
  toronto,
} from './support/time-fixtures.js';
import { closedEntry } from './support/time-world.js';
import {
  FixedPayrollClock,
  PAYROLL_PERMISSION_KEYS,
  payGroup,
  payrollServices,
} from './support/payroll-fixtures.js';

config({ path: '../../.env' });

const USERS = {
  managerA: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
  managerA2: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
  payrollAdmin: [
    { permissions: PAYROLL_PERMISSION_KEYS, scope: 'org' as const },
  ],
};

/**
 * Batch 4C — concurrency, on committed data (separate connections, like production): period
 * creation is serialized per organization (overlaps refused), timesheet materialization never
 * duplicates, no-show detection raises one exception per shift revision, and two reviewers of
 * one exception can't both decide it. Fixtures are removed in afterAll.
 */
describe('Attendance lifecycle concurrency (Batch 4C, committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures | undefined;
  const clock = new FixedClock();

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      async (tx) => {
        const created = await createSchedulingFixtures(
          tx,
          USERS,
          TIME_PERMISSIONS,
        );
        await seedTimePolicy(tx, created.orgA, {
          ...LIVE_TIME_POLICY,
          noShow: { enabled: true, graceMinutes: 15 },
        });
        return created;
      },
      { timeout: 60_000 },
    );
  });

  afterAll(async () => {
    if (fx) {
      // Periods and the no-show subjects are not part of the shared cleanup.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        await tx.attendanceException.deleteMany({
          where: { employeeId: { in: [fx!.employee1, fx!.employee2] } },
        });
        await tx.timesheetSegment.deleteMany({
          where: { timesheet: { timePeriod: { organizationId: fx!.orgA } } },
        });
        await tx.timesheetEvent.deleteMany({
          where: { timesheet: { timePeriod: { organizationId: fx!.orgA } } },
        });
        await tx.timesheet.deleteMany({
          where: { timePeriod: { organizationId: fx!.orgA } },
        });
        await tx.timePeriod.deleteMany({ where: { organizationId: fx!.orgA } });
        await tx.scheduledShiftRevision.deleteMany({
          where: {
            employmentAssignment: {
              employeeId: { in: [fx!.employee1, fx!.employee2] },
            },
          },
        });
      });
      await cleanupSchedulingFixtures(prisma, fx);
    }
    await prisma?.$disconnect();
  });

  const time = () => timeServices(prisma, clock, { absences: true }).time;

  it('creates overlapping periods of one organization at most once, even when requested at the same time', async () => {
    const f = fx!;
    const request = (startDate: string, cadence: 'WEEKLY' | 'BIWEEKLY') =>
      time().generateTimePeriods(
        f.users.managerA!,
        { organizationId: f.orgA, startDate, cadence },
        ctx(f.users.managerA!),
      );
    // A weekly and a bi-weekly period sharing their first week, at the same time.
    const outcomes = await Promise.allSettled([
      request('2027-03-01', 'WEEKLY'),
      request('2027-03-01', 'BIWEEKLY'),
      request('2027-03-01', 'WEEKLY'),
    ]);
    const periods = await prisma.timePeriod.findMany({
      where: { organizationId: f.orgA },
    });
    expect(periods).toHaveLength(1);
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    // Whichever cadence won, the other request is refused as an overlap.
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    for (const outcome of rejected) {
      expect(
        (
          (outcome as PromiseRejectedResult).reason as {
            getResponse(): { code: string };
          }
        ).getResponse().code,
      ).toBe('TIME_PERIOD_OVERLAP');
    }
  });

  it('materializes each employee’s timesheet once under concurrent requests', async () => {
    const f = fx!;
    for (const [employeeId, assignmentId] of [
      [f.employee1, f.assignmentTeamA],
      [f.employee2, f.otherTeamA],
    ] as const) {
      await closedEntry(prisma as never, {
        employeeId,
        employmentAssignmentId: assignmentId,
        clockInAt: toronto('2027-03-02T09:00'),
        clockOutAt: toronto('2027-03-02T12:00'),
        workDate: '2027-03-02',
      });
    }
    const period = await prisma.timePeriod.findFirstOrThrow({
      where: { organizationId: f.orgA },
    });
    const results = await Promise.all(
      [f.users.managerA!, f.users.managerA2!, f.users.managerA!].map((actor) =>
        time().materializeTimesheets(actor, period.id, ctx(actor)),
      ),
    );
    expect(results.reduce((sum, result) => sum + result.created, 0)).toBe(2);
    expect(
      await prisma.timesheet.count({ where: { timePeriodId: period.id } }),
    ).toBe(2);
  });

  it('raises one no-show per shift revision under concurrent detection, and lets only one reviewer decide it', async () => {
    const f = fx!;
    const schedule = await prisma.schedule.create({
      data: {
        scopeType: 'ORGANIZATION',
        organizationId: f.orgA,
        name: 'Concurrency week',
        periodStart: new Date('2027-03-08'),
        periodEnd: new Date('2027-03-08'),
        type: 'STANDARD',
        status: 'PUBLISHED',
        publishedAt: toronto('2027-03-01T09:00'),
        publishedByUserId: f.users.managerA!,
      },
    });
    const shift = await prisma.scheduledShift.create({
      data: {
        scheduleId: schedule.id,
        employmentAssignmentId: f.otherTeamA,
        workDate: new Date('2027-03-08'),
        startsAt: toronto('2027-03-08T09:00'),
        endsAt: toronto('2027-03-08T17:00'),
        timezone: 'America/Toronto',
      },
    });
    await prisma.scheduledShiftRevision.create({
      data: {
        scheduledShiftId: shift.id,
        revisionNumber: 1,
        revisionType: 'PUBLISHED_BASELINE',
        employmentAssignmentId: f.otherTeamA,
        workDate: shift.workDate,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        timezone: 'America/Toronto',
        status: 'ACTIVE',
        sourceType: 'MANUAL',
        changedByUserId: f.users.managerA!,
      },
    });
    clock.value = toronto('2027-03-08T10:00');
    const runs = await Promise.all([
      time().detectNoShows(),
      time().detectNoShows(),
      time().detectNoShows(),
    ]);
    expect(runs.reduce((sum, run) => sum + run.detected, 0)).toBe(1);
    expect(runs.every((run) => run.failed.length === 0)).toBe(true);
    const exception = await prisma.attendanceException.findFirstOrThrow({
      where: { scheduledShiftId: shift.id, type: 'NO_SHOW' },
    });

    const decisions = await Promise.allSettled([
      time().reviewException(
        f.users.managerA!,
        exception.id,
        'RESOLVE',
        'Called in sick',
        ctx(f.users.managerA!),
      ),
      time().reviewException(
        f.users.managerA2!,
        exception.id,
        'DISMISS',
        'Not scheduled after all',
        ctx(f.users.managerA2!),
      ),
    ]);
    expect(decisions.filter((d) => d.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        (
          decisions.find(
            (d) => d.status === 'rejected',
          ) as PromiseRejectedResult
        ).reason as { getResponse(): { code: string } }
      ).getResponse().code,
    ).toBe('TIME_EXCEPTION_NOT_OPEN');
    expect(
      await prisma.auditLog.count({
        where: {
          entityId: exception.id,
          action: {
            in: ['TIME_EXCEPTION_RESOLVED', 'TIME_EXCEPTION_DISMISSED'],
          },
        },
      }),
    ).toBe(1);
  });

  it('serializes payroll and attendance creating overlapping periods: one wins, the other gets 409 TIME_PERIOD_OVERLAP', async () => {
    const f = fx!;
    const payrollClock = new FixedPayrollClock();
    payrollClock.value = new Date('2027-03-20T12:00:00.000Z');
    const payroll = payrollServices(prisma, payrollClock);
    const group = await payGroup(
      prisma as never,
      f.orgA,
      `PG-RACE-${f.suffix}`,
    );
    const admin = ctx(f.users.payrollAdmin!);
    await payroll.calendars.createCalendar(
      {
        payGroupId: group.id,
        cadence: 'BIWEEKLY',
        timezone: 'America/Toronto',
        anchorDate: '2027-04-04',
        payDateOffsetDays: 5,
        processingCutoffOffsetDays: 2,
        effectiveFrom: '2027-04-04',
      },
      admin,
    );
    // Payroll wants Apr 4–17; attendance wants Apr 4–10 (overlapping, different dates).
    const outcomes = await Promise.allSettled([
      payroll.calendars.generatePeriods(
        { payGroupId: group.id, throughDate: '2027-04-04' },
        admin,
      ),
      time().generateTimePeriods(
        f.users.managerA!,
        { organizationId: f.orgA, startDate: '2027-04-04', cadence: 'WEEKLY' },
        ctx(f.users.managerA!),
      ),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(
      (o) => o.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(
      (rejected.reason as { getResponse(): { code: string } }).getResponse()
        .code,
    ).toBe('TIME_PERIOD_OVERLAP');
    // Exactly one period covers Apr 4–10, and a payroll period exists only if payroll won.
    const april = await prisma.timePeriod.findMany({
      where: {
        organizationId: f.orgA,
        startDate: { lte: new Date('2027-04-10') },
        endDate: { gte: new Date('2027-04-04') },
      },
      include: { payrollPeriods: true },
    });
    expect(april).toHaveLength(1);
    expect(april[0]!.payrollPeriods.length).toBe(
      outcomes[0]!.status === 'fulfilled' ? 1 : 0,
    );
  });
});
