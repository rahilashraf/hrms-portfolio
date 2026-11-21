import { ConflictException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { runScanOpenTimeEntriesJob } from '../src/time/time-jobs.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  FixedClock,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
  toronto,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  timeManager: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  svc: ReturnType<typeof timeServices>;
}

const body = (error: unknown) => (error as ConflictException).getResponse();

/**
 * Phase 9.5 Batch 0 — Time hardening ahead of the kiosk: corrections never change finalized
 * (payroll-sensitive) time (D1), Time never falls back to a silent UTC (D2), and missed
 * clock-outs are detected by a background job (D3).
 */
describe('Time hardening (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(run: (h: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(
            tx,
            USERS,
            TIME_PERMISSIONS,
          );
          await seedTimePolicy(tx, fx.orgA);
          const clock = new FixedClock();
          const svc = timeServices(rollbackClient(tx), clock);
          await run({ tx, fx, clock, svc });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** A closed Team A entry 09:00–12:00 on 2027-03-02, then the week approved (finalized). */
  async function approvedWeek(h: Harness) {
    const { fx, svc, clock } = h;
    clock.value = toronto('2027-03-02T09:00');
    await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, ctx(fx.selfUser1));
    clock.value = toronto('2027-03-02T12:00');
    await svc.time.clockOut(fx.selfUser1, ctx(fx.selfUser1));
    const entry = await h.tx.timeEntry.findFirstOrThrow({
      where: { employeeId: fx.employee1 },
    });
    await svc.time.generateTimePeriods(
      fx.users.timeManager!,
      { organizationId: fx.orgA, startDate: '2027-03-01', cadence: 'WEEKLY' },
      ctx(fx.users.timeManager!),
    );
    const period = await h.tx.timePeriod.findFirstOrThrow({
      where: { organizationId: fx.orgA },
    });
    const sheet = await svc.time.materializeTimesheetForEmployeePeriod(
      fx.employee1,
      period.id,
    );
    clock.value = toronto('2027-03-08T09:00');
    await svc.time.submitTimesheet(fx.selfUser1, sheet.id, ctx(fx.selfUser1));
    for (const segment of await h.tx.timesheetSegment.findMany({
      where: { timesheetId: sheet.id },
    })) {
      await svc.time.approveTimesheetSegment(
        fx.users.timeManager!,
        segment.id,
        undefined,
        ctx(fx.users.timeManager!),
      );
    }
    return { entry, sheet };
  }

  it('D1: refuses direct corrections, approvals and added entries on approved time until reopened', async () => {
    await scenario(async (h) => {
      const { fx, svc } = h;
      const { entry, sheet } = await approvedWeek(h);
      const payrollBefore = await svc.time.approvedPayrollTimeOutputs(sheet.id);
      const manager = ctx(fx.users.timeManager!);

      // A direct correction of the approved entry.
      const direct = await rejection(
        svc.time.correctEntry(
          fx.users.timeManager!,
          entry.id,
          {
            type: 'CHANGE_CLOCK_OUT',
            reason: 'Left later',
            clockOutAt: '2027-03-02T13:00',
          },
          manager,
        ),
      );
      expect(direct).toBeInstanceOf(ConflictException);
      expect(body(direct)).toMatchObject({
        code: 'TIME_ENTRY_FINALIZED',
        timesheetId: sheet.id,
      });

      // An employee request to add a missing entry in the approved week. Batch 4E-3 (C5): it
      // could never be approved, so it is refused when filed (it used to stay pending and block
      // the employee's timesheet); nothing is recorded.
      const missing = {
        type: 'ADD_MISSING_TIME_ENTRY' as const,
        reason: 'Forgot to clock the afternoon',
        employmentAssignmentId: fx.assignmentTeamA,
        startAt: '2027-03-03T13:00',
        endAt: '2027-03-03T15:00',
      };
      expect(
        body(
          await rejection(
            svc.time.requestCorrection(
              fx.selfUser1,
              missing,
              ctx(fx.selfUser1),
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIME_ENTRY_FINALIZED' });
      expect(
        await h.tx.timeCorrectionRequest.count({
          where: { employeeId: fx.employee1 },
        }),
      ).toBe(0);
      expect(
        await h.tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(1);
      expect(await svc.time.approvedPayrollTimeOutputs(sheet.id)).toEqual(
        payrollBefore,
      );

      // Reopened, the request is accepted and approved.
      await svc.time.reopenTimesheet(
        fx.users.timeManager!,
        sheet.id,
        'Late correction',
        manager,
      );
      const request = await svc.time.requestCorrection(
        fx.selfUser1,
        missing,
        ctx(fx.selfUser1),
      );
      await svc.time.approveCorrection(
        fx.users.timeManager!,
        (request as { id: string }).id,
        undefined,
        manager,
      );
      expect(
        await h.tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(2);
    });
  });

  it('D2: resolves Time timezones from the work location, then the organization, never UTC', async () => {
    await scenario(async (h) => {
      const { fx, svc, clock, tx } = h;
      const self = ctx(fx.selfUser1);
      // Dept B's position has no work location and Org A no timezone: not clockable, not offered.
      clock.value = toronto('2027-03-02T09:00');
      const status = await svc.time.status(fx.selfUser1);
      expect(
        status.eligibleAssignments.map((a: { id: string }) => a.id),
      ).not.toContain(fx.assignmentDeptB);
      const error = await rejection(
        svc.time.clockIn(fx.selfUser1, fx.assignmentDeptB, self),
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect(body(error)).toMatchObject({ code: 'TIME_TIMEZONE_UNRESOLVED' });
      expect(
        await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(0);

      // With an organization timezone the work date follows it (23:30 in Regina is still
      // March 2 there, though already March 3 in UTC). Regina keeps UTC-6 all year, so the
      // expectation doesn't depend on the runtime's time zone database version.
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'America/Regina' },
      });
      clock.value = new Date('2027-03-03T05:30:00.000Z');
      await svc.time.clockIn(fx.selfUser1, fx.assignmentDeptB, self);
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      expect(entry.timezone).toBe('America/Regina');
      expect(entry.workDate.toISOString().slice(0, 10)).toBe('2027-03-02');
    });
  });

  it('D3: the background job flags missed clock-outs and reports failures per entry', async () => {
    await scenario(async (h) => {
      const { fx, svc, clock, tx } = h;
      clock.value = toronto('2027-03-02T08:00');
      await svc.time.clockIn(
        fx.selfUser1,
        fx.assignmentTeamA,
        ctx(fx.selfUser1),
      );
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      // Open 11 hours later (threshold 600 minutes); the job runs on the real clock, so age the
      // entry instead of the clock.
      await tx.$executeRaw`UPDATE "TimeEntry" SET "clockInAt" = now() - interval '11 hours' WHERE "id" = ${entry.id}::uuid`;
      await tx.$executeRaw`UPDATE "TimeEntry" SET "workDate" = (now() AT TIME ZONE 'America/Toronto')::date WHERE "id" = ${entry.id}::uuid`;
      const outcome = await runScanOpenTimeEntriesJob(
        {},
        { prisma: rollbackClient(tx) as never },
      );
      // (The scan covers every open entry it can see; assert only on this scenario's.)
      expect(
        outcome.failed.filter((failure) => failure.timeEntryId === entry.id),
      ).toEqual([]);
      expect(
        await tx.attendanceException.count({
          where: {
            timeEntryId: entry.id,
            type: 'MISSING_CLOCK_OUT',
            status: 'OPEN',
          },
        }),
      ).toBe(1);
      // Idempotent: a second run never duplicates the exception.
      await runScanOpenTimeEntriesJob(
        {},
        { prisma: rollbackClient(tx) as never },
      );
      expect(
        await tx.attendanceException.count({
          where: { timeEntryId: entry.id, type: 'MISSING_CLOCK_OUT' },
        }),
      ).toBe(1);
      await expect(
        runScanOpenTimeEntriesJob({ unexpected: true }),
      ).rejects.toThrow(/takes no parameters/);
    });
  });
});
