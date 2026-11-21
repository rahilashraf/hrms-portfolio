import { readFileSync } from 'node:fs';
import { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  afterPeriodEnd,
  FixedClock,
  LIVE_TIME_POLICY,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
  toronto,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  timeAdmin: [{ permissions: [...TIME_PERMISSIONS], scope: 'org' as const }],
  // May correct Team A time only; Dept B is out of scope.
  teamACorrector: [{ permissions: ['time.correct'], scope: 'teamA' as const }],
};

const body = (error: unknown) =>
  (error as HttpException).getResponse() as { code?: string; message?: string };

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  svc: ReturnType<typeof timeServices>;
}

/**
 * Multi-assignment attendance: one physical TimeEntry may cover several assignments of the same
 * employee and organization. The entry's own assignment is the payroll owner; elapsed minutes,
 * breaks, timesheets and payroll count the interval exactly once. Switching assignments still
 * produces separate intervals.
 */
describe('Multi-assignment attendance coverage (database)', () => {
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
          // Dept B's position has no work location: both assignments use the org timezone.
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'America/Toronto' },
          });
          await seedTimePolicy(tx, fx.orgA);
          const clock = new FixedClock();
          const svc = timeServices(rollbackClient(tx), clock);
          await run({ tx, fx, clock, svc }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const self = (h: Harness) => ctx(h.fx.selfUser1);
  const admin = (h: Harness) => ctx(h.fx.users.timeAdmin!);

  const coverageRows = (h: Harness, timeEntryId: string) =>
    h.tx.timeEntryAssignmentCoverage.findMany({
      where: { timeEntryId },
      orderBy: { createdAt: 'asc' },
    });

  /** The week of 2027-03-01 as a time period, with employee 1's timesheet materialized. */
  async function timesheet(h: Harness) {
    const { periods } = await h.svc.time.generateTimePeriods(
      h.fx.users.timeAdmin!,
      { organizationId: h.fx.orgA, startDate: '2027-03-01', cadence: 'WEEKLY' },
      admin(h),
    );
    return h.svc.time.materializeTimesheetForEmployeePeriod(
      h.fx.employee1,
      periods[0]!.id,
      rollbackClient(h.tx),
    );
  }

  async function entriesOfEmployee1(h: Harness) {
    const page = await h.svc.time.managementEntries(h.fx.users.timeAdmin!, {
      employeeId: h.fx.employee1,
    } as never);
    return page.items;
  }

  it('keeps single-assignment clock-in, totals and coverage unchanged', async () => {
    await scenario(async (h) => {
      const { fx, clock, svc } = h;
      clock.value = toronto('2027-03-02T09:00');
      const status = await svc.time.clockIn(
        fx.selfUser1,
        fx.assignmentTeamA,
        self(h),
      );
      expect(status.currentCoverage).toEqual([
        expect.objectContaining({
          employmentAssignmentId: fx.assignmentTeamA,
          isPayrollOwner: true,
        }),
      ]);
      clock.value = toronto('2027-03-02T15:00');
      await svc.time.clockOut(fx.selfUser1, self(h));

      const [entry] = await entriesOfEmployee1(h);
      expect(entry).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
        grossMinutes: 360,
        netWorkedMinutes: 360,
      });
      expect(entry!.coverage).toEqual([
        expect.objectContaining({
          employmentAssignmentId: fx.assignmentTeamA,
          isPayrollOwner: true,
        }),
      ]);
      expect(await coverageRows(h, entry!.id)).toHaveLength(1);
      const sheet = await timesheet(h);
      expect(
        sheet.segments.map((s) => [
          s.employmentAssignmentId,
          s.netWorkedMinutes,
        ]),
      ).toEqual([[fx.assignmentTeamA, 360]]);
      expect(sheet.totals).toMatchObject({
        netWorkedMinutes: 360,
        secondaryCoverage: [],
      });
    });
  });

  it('covers two assignments with one physical interval: 360 minutes once, 330 after a break', async () => {
    await scenario(async (h) => {
      const { tx, fx, clock, svc } = h;
      // Classified breaks, unpaid by default (the existing break policy, unchanged).
      await tx.timeAttendancePolicy.updateMany({
        where: { organizationId: fx.orgA },
        data: {
          config: {
            ...LIVE_TIME_POLICY,
            breaks: {
              mode: 'MANUAL_PUNCH',
              paidUnpaidClassification: true,
              defaultPayType: 'UNPAID',
            },
          },
        },
      });
      clock.value = toronto('2027-03-02T09:00');
      const status = await svc.time.clockIn(
        fx.selfUser1,
        fx.assignmentTeamA,
        self(h),
        undefined,
        [fx.assignmentDeptB],
      );
      expect(status.state).toBe('CLOCKED_IN');
      expect(
        status.currentCoverage.map((c) => [
          c.employmentAssignmentId,
          c.isPayrollOwner,
        ]),
      ).toEqual([
        [fx.assignmentTeamA, true],
        [fx.assignmentDeptB, false],
      ]);
      // One physical interval: one entry, one CLOCK_IN punch.
      expect(
        await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(1);
      expect(
        await tx.timePunch.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(1);

      // The break belongs to the interval, not to each covered assignment.
      clock.value = toronto('2027-03-02T12:00');
      await svc.time.startBreak(fx.selfUser1, self(h));
      clock.value = toronto('2027-03-02T12:30');
      await svc.time.endBreak(fx.selfUser1, self(h));
      clock.value = toronto('2027-03-02T15:00');
      await svc.time.clockOut(fx.selfUser1, self(h));

      const entries = await entriesOfEmployee1(h);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
        grossMinutes: 360,
        unpaidBreakMinutes: 30,
        netWorkedMinutes: 330,
      });
      expect(
        entries[0]!.coverage.map((c) => [
          c.employmentAssignmentId,
          c.isPayrollOwner,
        ]),
      ).toEqual([
        [fx.assignmentTeamA, true],
        [fx.assignmentDeptB, false],
      ]);
      expect(
        await tx.breakEntry.count({ where: { timeEntryId: entries[0]!.id } }),
      ).toBe(1);

      // Timesheet: 330 once, on the payroll owner; Dept B's coverage is shown, never added.
      const sheet = await timesheet(h);
      expect(
        sheet.segments.map((s) => [
          s.employmentAssignmentId,
          s.netWorkedMinutes,
        ]),
      ).toEqual([[fx.assignmentTeamA, 330]]);
      expect(sheet.totals).toMatchObject({
        grossMinutes: 360,
        netWorkedMinutes: 330,
        secondaryCoverage: [
          {
            employmentAssignmentId: fx.assignmentDeptB,
            entries: 1,
            netWorkedMinutes: 330,
          },
        ],
      });

      // The audit names every covered assignment.
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'TIME_CLOCKED_IN', entityId: entries[0]!.id },
      });
      expect(audit.metadata).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
        coveredEmploymentAssignmentIds: [
          fx.assignmentTeamA,
          fx.assignmentDeptB,
        ],
      });
    });
  });

  it('keeps true switching as two intervals: 09:00–12:00 A, 12:00–15:00 B = 180 + 180', async () => {
    await scenario(async (h) => {
      const { fx, clock, svc } = h;
      clock.value = toronto('2027-03-02T09:00');
      await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self(h));
      clock.value = toronto('2027-03-02T12:00');
      const switched = await svc.time.switchAssignment(
        fx.selfUser1,
        fx.assignmentDeptB,
        self(h),
      );
      expect(switched.currentCoverage).toEqual([
        expect.objectContaining({
          employmentAssignmentId: fx.assignmentDeptB,
          isPayrollOwner: true,
        }),
      ]);
      clock.value = toronto('2027-03-02T15:00');
      await svc.time.clockOut(fx.selfUser1, self(h));

      const entries = await entriesOfEmployee1(h);
      expect(
        Object.fromEntries(
          entries.map((e) => [
            e.employmentAssignmentId,
            [e.netWorkedMinutes, e.coverage.length],
          ]),
        ),
      ).toEqual({
        [fx.assignmentTeamA]: [180, 1],
        [fx.assignmentDeptB]: [180, 1],
      });
      const sheet = await timesheet(h);
      expect(
        Object.fromEntries(
          sheet.segments.map((s) => [
            s.employmentAssignmentId,
            s.netWorkedMinutes,
          ]),
        ),
      ).toEqual({ [fx.assignmentTeamA]: 180, [fx.assignmentDeptB]: 180 });
      expect(sheet.totals).toMatchObject({
        netWorkedMinutes: 360,
        secondaryCoverage: [],
      });
    });
  });

  it('validates every covered assignment on the server', async () => {
    await scenario(async (h) => {
      const { tx, fx, clock, svc } = h;
      clock.value = toronto('2027-03-02T09:00');
      const clockIn = (owner: string | undefined, additional: string[]) =>
        svc.time.clockIn(fx.selfUser1, owner, self(h), undefined, additional);

      // Another employee's assignment is never coverable.
      expect(
        (await rejection(
          clockIn(fx.assignmentTeamA, [fx.otherTeamA]),
        )) as HttpException,
      ).toMatchObject({ message: 'Assignment does not belong to employee.' });
      // Several assignments need an explicit payroll owner.
      expect(
        (
          (await rejection(
            clockIn(undefined, [fx.assignmentDeptB]),
          )) as HttpException
        ).getStatus(),
      ).toBe(400);
      // A sign-in-only assignment cannot be covered by clocked time.
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentDeptB,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          config: { attendance: { trackingMode: 'SIGN_IN_ONLY' } },
        },
      });
      expect(
        body(
          await rejection(clockIn(fx.assignmentTeamA, [fx.assignmentDeptB])),
        ),
      ).toMatchObject({
        code: 'ATTENDANCE_TRACKING_MODE_MISMATCH',
      });
      // An assignment of another organization (same employee) is refused.
      const orgBPosition = await tx.position.create({
        data: {
          organizationId: fx.orgB,
          name: 'Org B Associate',
          code: `OB-${fx.suffix}`,
          jobTitleId: (
            await tx.jobTitle.create({
              data: {
                organizationId: fx.orgB,
                name: 'B title',
                code: `JB-${fx.suffix}`,
              },
            })
          ).id,
        },
      });
      const orgBAssignment = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee1,
          positionId: orgBPosition.id,
          employmentType: 'PART_TIME',
          status: 'ACTIVE',
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      expect(
        (
          (await rejection(
            clockIn(fx.assignmentTeamA, [orgBAssignment.id]),
          )) as HttpException
        ).getStatus(),
      ).toBeGreaterThanOrEqual(400);
      // Nothing was recorded by any refusal.
      expect(
        await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(0);

      // A retry with the same coverage is idempotent; different coverage conflicts.
      await tx.timeAttendancePolicy.deleteMany({
        where: { employmentAssignmentId: fx.assignmentDeptB },
      });
      await clockIn(fx.assignmentTeamA, [fx.assignmentDeptB]);
      const again = await clockIn(fx.assignmentTeamA, [fx.assignmentDeptB]);
      expect(again.state).toBe('CLOCKED_IN');
      expect(
        (
          (await rejection(clockIn(fx.assignmentTeamA, []))) as HttpException
        ).getStatus(),
      ).toBe(409);
      expect(
        await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(1);
    });
  });

  it('corrects coverage and the payroll owner with audit, never on finalized time', async () => {
    await scenario(async (h) => {
      const { tx, fx, clock, svc } = h;
      clock.value = toronto('2027-03-02T09:00');
      await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self(h));
      clock.value = toronto('2027-03-02T15:00');
      await svc.time.clockOut(fx.selfUser1, self(h));
      const [entry] = await entriesOfEmployee1(h);

      // Employees cannot request coverage changes; a scoped corrector needs every assignment.
      expect(
        (
          (await rejection(
            svc.time.requestCorrection(
              fx.selfUser1,
              {
                type: 'CHANGE_COVERAGE',
                reason: 'Also taught Dept B',
                timeEntryId: entry!.id,
                additionalEmploymentAssignmentIds: [fx.assignmentDeptB],
              },
              self(h),
            ),
          )) as HttpException
        ).getStatus(),
      ).toBe(400);
      expect(
        (
          (await rejection(
            svc.time.correctEntry(
              fx.users.teamACorrector!,
              entry!.id,
              {
                type: 'CHANGE_COVERAGE',
                reason: 'Also taught Dept B',
                additionalEmploymentAssignmentIds: [fx.assignmentDeptB],
              },
              ctx(fx.users.teamACorrector!),
            ),
          )) as HttpException
        ).getStatus(),
      ).toBe(403);

      // An admin adds Dept B coverage: audited, minutes unchanged.
      const added = await svc.time.correctEntry(
        fx.users.timeAdmin!,
        entry!.id,
        {
          type: 'CHANGE_COVERAGE',
          reason: 'Also taught Dept B',
          additionalEmploymentAssignmentIds: [fx.assignmentDeptB],
        },
        admin(h),
      );
      const adjustment = await tx.timeAdjustment.findUniqueOrThrow({
        where: { id: added.id },
      });
      expect(adjustment).toMatchObject({
        type: 'CHANGE_COVERAGE',
        source: 'MANAGER_DIRECT',
      });
      expect(adjustment.previousValues).toMatchObject({
        additionalEmploymentAssignmentIds: [],
      });
      expect(adjustment.newValues).toMatchObject({
        additionalEmploymentAssignmentIds: [fx.assignmentDeptB],
      });
      expect(
        await tx.auditLog.count({
          where: {
            action: 'TIME_DIRECT_CORRECTION_APPLIED',
            entityId: added.id,
          },
        }),
      ).toBe(1);
      let [read] = await entriesOfEmployee1(h);
      expect(read!.netWorkedMinutes).toBe(360);
      expect(read!.coverage.map((c) => c.employmentAssignmentId)).toEqual([
        fx.assignmentTeamA,
        fx.assignmentDeptB,
      ]);
      expect(
        body(
          await rejection(
            svc.time.correctEntry(
              fx.users.timeAdmin!,
              entry!.id,
              {
                type: 'CHANGE_COVERAGE',
                reason: 'Again',
                additionalEmploymentAssignmentIds: [fx.assignmentDeptB],
              },
              admin(h),
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIME_COVERAGE_UNCHANGED' });

      // Moving the payroll owner to Dept B: Team A drops out, Dept B owns; still one interval.
      await svc.time.correctEntry(
        fx.users.timeAdmin!,
        entry!.id,
        {
          type: 'CHANGE_ASSIGNMENT',
          reason: 'Dept B pays this day',
          targetEmploymentAssignmentId: fx.assignmentDeptB,
        },
        admin(h),
      );
      [read] = await entriesOfEmployee1(h);
      expect(read!.employmentAssignmentId).toBe(fx.assignmentDeptB);
      expect(
        read!.coverage.map((c) => [c.employmentAssignmentId, c.isPayrollOwner]),
      ).toEqual([[fx.assignmentDeptB, true]]);
      // Removed coverage is kept (append-only), never deleted.
      const rows = await coverageRows(h, entry!.id);
      expect(
        rows.map((r) => [r.employmentAssignmentId, r.removedAt !== null]),
      ).toEqual([
        [fx.assignmentTeamA, true],
        [fx.assignmentDeptB, false],
      ]);
      // Punches keep what they recorded.
      expect(
        (
          await tx.timePunch.findMany({ where: { timeEntryId: entry!.id } })
        ).map((p) => p.employmentAssignmentId),
      ).toEqual([fx.assignmentTeamA, fx.assignmentTeamA]);

      // Finalized time is protected: approve the timesheet, then any coverage change is refused.
      const sheet = await timesheet(h);
      afterPeriodEnd(clock, '2027-03-07');
      await svc.time.submitTimesheet(fx.selfUser1, sheet.id, self(h));
      for (const segment of sheet.segments.filter(
        (s) => s.netWorkedMinutes > 0,
      )) {
        await svc.time.approveTimesheetSegment(
          fx.users.timeAdmin!,
          segment.id,
          undefined,
          admin(h),
        );
      }
      expect(
        body(
          await rejection(
            svc.time.correctEntry(
              fx.users.timeAdmin!,
              entry!.id,
              {
                type: 'CHANGE_COVERAGE',
                reason: 'Late fix',
                additionalEmploymentAssignmentIds: [fx.assignmentTeamA],
              },
              admin(h),
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIME_ENTRY_FINALIZED' });
    });
  });

  it('enforces coverage integrity in the database', async () => {
    await scenario(async (h) => {
      const { tx, fx, clock, svc } = h;
      clock.value = toronto('2027-03-02T09:00');
      await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self(h));
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      const [row] = await coverageRows(h, entry.id);
      // One active row per entry and assignment.
      expect(
        await violation(tx, () =>
          tx.timeEntryAssignmentCoverage.create({
            data: {
              timeEntryId: entry.id,
              employeeId: fx.employee1,
              employmentAssignmentId: fx.assignmentTeamA,
            },
          }),
        ),
      ).toBeTruthy();
      // Another employee's assignment (composite foreign key).
      expect(
        await violation(tx, () =>
          tx.timeEntryAssignmentCoverage.create({
            data: {
              timeEntryId: entry.id,
              employeeId: fx.employee1,
              employmentAssignmentId: fx.otherTeamA,
            },
          }),
        ),
      ).toBeTruthy();
      // Append-only: never deleted, never rewritten, removed at most once.
      expect(
        await violation(tx, () =>
          tx.timeEntryAssignmentCoverage.delete({ where: { id: row!.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.timeEntryAssignmentCoverage.update({
            where: { id: row!.id },
            data: { employmentAssignmentId: fx.assignmentDeptB },
          }),
        ),
      ).toBeTruthy();
    });
  });

  it('enforces one organization per interval in the database', async () => {
    await scenario(async (h) => {
      const { tx, fx, clock, svc } = h;
      clock.value = toronto('2027-03-02T09:00');
      await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self(h));
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      const jobTitle = await tx.jobTitle.create({
        data: {
          organizationId: fx.orgB,
          name: 'B title',
          code: `JB-${fx.suffix}`,
        },
      });
      const position = await tx.position.create({
        data: {
          organizationId: fx.orgB,
          name: 'Org B Associate',
          code: `OB-${fx.suffix}`,
          jobTitleId: jobTitle.id,
        },
      });
      const orgB = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee1,
          positionId: position.id,
          employmentType: 'PART_TIME',
          status: 'ACTIVE',
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      expect(
        await violation(tx, () =>
          tx.timeEntryAssignmentCoverage.create({
            data: {
              timeEntryId: entry.id,
              employeeId: fx.employee1,
              employmentAssignmentId: orgB.id,
            },
          }),
        ),
      ).toBeTruthy();
    });
  });

  it('backfills exactly one owner coverage row per existing entry, totals unchanged', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      // Entries recorded before coverage existed (no coverage rows at all).
      const legacy = async (assignment: string, from: string, to: string) =>
        tx.timeEntry.create({
          data: {
            employeeId: fx.employee1,
            employmentAssignmentId: assignment,
            clockInAt: toronto(from),
            clockOutAt: toronto(to),
            timezone: 'America/Toronto',
            workDate: new Date(`${from.slice(0, 10)}T00:00:00.000Z`),
            status: 'CLOSED',
            source: 'MANUAL',
          },
        });
      const first = await legacy(
        fx.assignmentTeamA,
        '2027-03-02T09:00',
        '2027-03-02T12:00',
      );
      const second = await legacy(
        fx.assignmentDeptB,
        '2027-03-02T13:00',
        '2027-03-02T16:00',
      );
      // Legacy entries already read as covered by their owner.
      const before = await entriesOfEmployee1(h);
      expect(before.map((e) => e.coverage.length)).toEqual([1, 1]);
      const totalsBefore = (await timesheet(h)).totals;

      // The migration's own backfill statement, verbatim.
      const sql = readFileSync(
        new URL(
          '../../../prisma/migrations/20270217090000_multi_assignment_attendance_coverage/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const backfill =
        /INSERT INTO "TimeEntryAssignmentCoverage"[\s\S]*?FROM "TimeEntry";/.exec(
          sql,
        );
      expect(backfill).not.toBeNull();
      await tx.$executeRawUnsafe(
        backfill![0].replace(
          'FROM "TimeEntry";',
          `FROM "TimeEntry" WHERE "id" IN ('${first.id}', '${second.id}');`,
        ),
      );
      for (const entry of [first, second]) {
        const rows = await coverageRows(h, entry.id);
        expect(
          rows.map((r) => [r.employmentAssignmentId, r.removedAt]),
        ).toEqual([[entry.employmentAssignmentId, null]]);
      }
      expect(
        (await entriesOfEmployee1(h)).map((e) => e.coverage.length),
      ).toEqual([1, 1]);
      expect((await timesheet(h)).totals).toEqual(totalsBefore);
    });
  });
});
