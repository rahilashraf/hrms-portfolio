import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { ScheduleAttendanceService } from '../src/scheduling/schedule-attendance.service.js';
import { TimeDomainService } from '../src/time/time-domain.service.js';
import { SystemClock, TimeService } from '../src/time/time.service.js';
import {
  ALL_SCHEDULE_PERMISSIONS,
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  schedulingServices,
  torontoShift,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const TIME_PERMISSIONS = [
  'time.clock',
  'time.view',
  'time.correct',
  'time.approve',
  'time.timesheet.approve',
  'time.timesheet.manage',
] as const;

const USERS = {
  admin: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'org' as const }],
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  timeManager: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
  // Can correct Team A time only; the Dept B target assignment is out of scope.
  teamACorrector: [{ permissions: ['time.correct'], scope: 'teamA' as const }],
};

/** America/Toronto is EST (-05:00) for the week of 2027-03-01. */
const at = (local: string) => new Date(`${local}:00-05:00`);

const TIME_POLICY = {
  clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
  breaks: { mode: 'MANUAL_PUNCH' },
  missedPunch: {
    enabled: true,
    maxOpenDurationMinutes: 960,
    employeeResolutionEnabled: true,
  },
  correction: { employeeRequestsEnabled: true },
};

class FixedClock extends SystemClock {
  value = at('2027-03-02T09:00');
  override now() {
    return new Date(this.value);
  }
}

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  time: TimeService;
  svc: ReturnType<typeof schedulingServices>;
  shift: string;
  manager: ReturnType<typeof ctx>;
  self: ReturnType<typeof ctx>;
}

/**
 * Regression for the Phase 6 defect where CHANGE_ASSIGNMENT on an entry with punches failed:
 * the punch → entry foreign key included the assignment and cascaded the change into the
 * immutable TimePunch rows. Punches are raw evidence and keep the assignment they recorded.
 */
describe('CHANGE_ASSIGNMENT with immutable punches (database)', () => {
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
          // Some positions have no work location: Time falls back to the organization's
          // timezone (never a silent UTC), so these scenarios run with an explicit UTC one.
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'UTC' },
          });
          await tx.timeAttendancePolicy.create({
            data: {
              scopeType: 'ORGANIZATION',
              organizationId: fx.orgA,
              effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
              config: TIME_POLICY,
            },
          });
          const client = rollbackClient(tx);
          const svc = schedulingServices(client);
          const clock = new FixedClock();
          const time = new TimeService(
            client,
            new TimeDomainService(),
            svc.authorization,
            svc.targets,
            svc.audit,
            clock,
            new ScheduleAttendanceService(
              client,
              svc.targets,
              svc.policyResolver,
            ),
          );
          const admin = ctx(fx.users.admin!);
          const schedule = await svc.scheduling.createSchedule(
            {
              scopeType: 'DEPARTMENT',
              organizationId: fx.orgA,
              departmentId: fx.deptA,
              name: 'A',
              type: 'AD_HOC',
              periodStart: '2027-03-01',
              periodEnd: '2027-03-07',
            },
            admin,
          );
          const shift = await svc.scheduling.createShift(
            schedule.id,
            torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
            admin,
          );
          await svc.scheduling.publishSchedule(schedule.id, admin);
          await run({
            tx,
            fx,
            clock,
            time,
            svc,
            shift: shift.id,
            manager: ctx(fx.users.timeManager!),
            self: ctx(fx.selfUser1),
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** A live-clocked Team A entry 09:00–12:00 with CLOCK_IN/CLOCK_OUT punches, schedule-linked. */
  async function punchedEntry(h: Harness) {
    h.clock.value = at('2027-03-02T09:00');
    await h.time.clockIn(h.fx.selfUser1, h.fx.assignmentTeamA, h.self);
    h.clock.value = at('2027-03-02T12:00');
    await h.time.clockOut(h.fx.selfUser1, h.self);
    const entry = await h.tx.timeEntry.findFirstOrThrow({
      where: {
        employeeId: h.fx.employee1,
        source: 'LIVE_CLOCK',
        clockInAt: at('2027-03-02T09:00'),
      },
    });
    const punches = await punchesOf(h.tx, entry.id);
    expect(punches.map((punch) => punch.type)).toEqual([
      'CLOCK_IN',
      'CLOCK_OUT',
    ]);
    return { entry, punches };
  }

  const punchesOf = (tx: Tx, timeEntryId: string) =>
    tx.timePunch.findMany({
      where: { timeEntryId },
      orderBy: { occurredAt: 'asc' },
    });

  const changeAssignment = (h: Harness, timeEntryId: string, target: string) =>
    h.time.correctEntry(
      h.fx.users.timeManager!,
      timeEntryId,
      {
        type: 'CHANGE_ASSIGNMENT',
        reason: 'Worked the other job',
        targetEmploymentAssignmentId: target,
      },
      h.manager,
    );

  it('moves a punched entry to another assignment and leaves every punch untouched', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const { entry, punches } = await punchedEntry(h);
      expect(entry).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
        scheduledShiftId: h.shift,
      });

      const adjustment = await changeAssignment(
        h,
        entry.id,
        fx.assignmentDeptB,
      );

      // Raw evidence is unchanged: same rows, same recorded assignment, time, type and source.
      expect(await punchesOf(tx, entry.id)).toEqual(punches);
      for (const punch of punches) {
        expect(punch).toMatchObject({
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          timeEntryId: entry.id,
          source: 'LIVE_CLOCK',
        });
      }

      // The interpreted entry moved, and its Team A shift link ended with it.
      const moved = await tx.timeEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(moved).toMatchObject({
        employmentAssignmentId: fx.assignmentDeptB,
        clockInAt: entry.clockInAt,
        clockOutAt: entry.clockOutAt,
        scheduledShiftId: null,
        scheduledShiftRevisionId: null,
      });

      // The correction records old → new assignment.
      const row = await tx.timeAdjustment.findUniqueOrThrow({
        where: { id: adjustment.id },
      });
      expect(row).toMatchObject({
        type: 'CHANGE_ASSIGNMENT',
        source: 'MANAGER_DIRECT',
        timeEntryId: entry.id,
        employmentAssignmentId: fx.assignmentDeptB,
        reason: 'Worked the other job',
      });
      expect(row.previousValues).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
      });
      expect(row.newValues).toMatchObject({
        targetEmploymentAssignmentId: fx.assignmentDeptB,
        employmentAssignmentId: fx.assignmentDeptB,
        clearedScheduleLink: { scheduledShiftId: h.shift },
      });

      // One adjustment audit plus the direct-correction audit, as before.
      expect(
        await tx.auditLog.count({
          where: {
            action: 'TIME_DIRECT_ADJUSTMENT_APPLIED',
            entityId: adjustment.id,
          },
        }),
      ).toBe(1);
      expect(
        await tx.auditLog.count({
          where: {
            action: 'TIME_DIRECT_CORRECTION_APPLIED',
            entityId: adjustment.id,
          },
        }),
      ).toBe(1);

      // No entry anywhere is left linked to a shift of a different assignment.
      const mismatched = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT e."id" FROM "TimeEntry" e
        JOIN "ScheduledShift" s ON s."id" = e."scheduledShiftId"
        WHERE e."employeeId" = ${fx.employee1}::uuid
          AND s."employmentAssignmentId" <> e."employmentAssignmentId"`;
      expect(mismatched).toEqual([]);
    });
  });

  it('keeps TimePunch immutable: updates and deletes still fail and both triggers stay enabled', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const { entry, punches } = await punchedEntry(h);
      await changeAssignment(h, entry.id, fx.assignmentDeptB);
      const punch = punches[0]!;
      expect(
        await violation(tx, () =>
          tx.timePunch.update({
            where: { id: punch.id },
            data: { employmentAssignmentId: fx.assignmentDeptB },
          }),
        ),
      ).toMatchObject({
        message: expect.stringContaining('TimePunch rows are immutable'),
      });
      expect(
        await violation(tx, () =>
          tx.timePunch.update({
            where: { id: punch.id },
            data: { occurredAt: at('2027-03-02T08:00') },
          }),
        ),
      ).toMatchObject({
        message: expect.stringContaining('TimePunch rows are immutable'),
      });
      expect(
        await violation(tx, () =>
          tx.timePunch.delete({ where: { id: punch.id } }),
        ),
      ).toMatchObject({
        message: expect.stringContaining('TimePunch rows are immutable'),
      });
      const triggers = await tx.$queryRaw<
        Array<{ tgname: string; tgenabled: string }>
      >`
        SELECT tgname::text AS tgname, tgenabled::text AS tgenabled FROM pg_trigger
        WHERE tgrelid = '"TimePunch"'::regclass AND NOT tgisinternal
        ORDER BY tgname`;
      expect(triggers).toEqual([
        // Phase 9.5: kiosk punches come from an active device (insert-only check).
        { tgname: 'TimePunch_kiosk_device', tgenabled: 'O' },
        { tgname: 'TimePunch_prevent_delete', tgenabled: 'O' },
        { tgname: 'TimePunch_prevent_update', tgenabled: 'O' },
        // Batch 4A: one CLOCK_OUT punch per entry.
        { tgname: 'TimePunch_single_clock_out', tgenabled: 'O' },
      ]);
    });
  });

  it('still ties every punch to its entry and employee', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const { entry } = await punchedEntry(h);
      const base = {
        employmentAssignmentId: fx.otherTeamA,
        type: 'CLOCK_IN' as const,
        occurredAt: at('2027-03-02T09:00'),
        timezone: 'America/Toronto',
      };
      // Another employee's punch cannot point at this employee's entry.
      await expect(
        violation(tx, () =>
          tx.timePunch.create({
            data: { ...base, employeeId: fx.employee2, timeEntryId: entry.id },
          }),
        ),
      ).resolves.toMatchObject({
        message: expect.stringMatching(/foreign key/i),
      });
      // A punch's assignment must still belong to the punch's employee.
      await expect(
        violation(tx, () =>
          tx.timePunch.create({
            data: { ...base, employeeId: fx.employee1, timeEntryId: entry.id },
          }),
        ),
      ).resolves.toMatchObject({
        message: expect.stringMatching(/foreign key/i),
      });
      // An entry's employee cannot change underneath its punches.
      await expect(
        violation(tx, () =>
          tx.timeEntry.update({
            where: { id: entry.id },
            data: {
              employeeId: fx.employee2,
              employmentAssignmentId: fx.otherTeamA,
            },
          }),
        ),
      ).resolves.toBeDefined();
    });
  });

  it('still corrects punch-less manual entries and through the request/approval path', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      // Batch 4A: a missing entry can't be in the future; the request is made the day after.
      h.clock.value = at('2027-03-04T09:00');
      const request = (await h.time.requestCorrection(
        fx.selfUser1,
        {
          type: 'ADD_MISSING_TIME_ENTRY',
          reason: 'Forgot to clock',
          employmentAssignmentId: fx.assignmentTeamA,
          startAt: '2027-03-03T09:00',
          endAt: '2027-03-03T11:00',
        },
        h.self,
      )) as { id: string };
      await h.time.approveCorrection(
        fx.users.timeManager!,
        request.id,
        undefined,
        h.manager,
      );
      const manual = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1, source: 'MANUAL' },
      });
      expect(await punchesOf(tx, manual.id)).toEqual([]);
      await changeAssignment(h, manual.id, fx.assignmentDeptB);
      expect(
        (await tx.timeEntry.findUniqueOrThrow({ where: { id: manual.id } }))
          .employmentAssignmentId,
      ).toBe(fx.assignmentDeptB);

      // An employee-requested CHANGE_ASSIGNMENT on a punched entry, approved by a manager.
      const { entry, punches } = await punchedEntry(h);
      const change = (await h.time.requestCorrection(
        fx.selfUser1,
        {
          type: 'CHANGE_ASSIGNMENT',
          reason: 'Wrong job selected',
          timeEntryId: entry.id,
          targetEmploymentAssignmentId: fx.assignmentDeptB,
        },
        h.self,
      )) as { id: string };
      await h.time.approveCorrection(
        fx.users.timeManager!,
        change.id,
        undefined,
        h.manager,
      );
      expect(
        (await tx.timeEntry.findUniqueOrThrow({ where: { id: entry.id } }))
          .employmentAssignmentId,
      ).toBe(fx.assignmentDeptB);
      expect(await punchesOf(tx, entry.id)).toEqual(punches);
      expect(
        await tx.auditLog.count({
          where: { action: 'TIME_CORRECTION_APPROVED', entityId: change.id },
        }),
      ).toBe(1);
    });
  });

  it('keeps authorization, ownership and assignment-date validation', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const { entry, punches } = await punchedEntry(h);
      const body = {
        type: 'CHANGE_ASSIGNMENT' as const,
        reason: 'Move',
        targetEmploymentAssignmentId: fx.assignmentDeptB,
      };
      // No time.correct at all.
      await expect(
        h.time.correctEntry(fx.selfUser1, entry.id, body, h.self),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // time.correct on Team A only: the Dept B target is out of scope.
      await expect(
        h.time.correctEntry(
          fx.users.teamACorrector!,
          entry.id,
          body,
          ctx(fx.users.teamACorrector!),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Never to another employee's assignment.
      await expect(
        changeAssignment(h, entry.id, fx.otherTeamA),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // The target assignment must cover the entry's interval.
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentDeptB },
        data: { endDate: new Date('2027-02-28T00:00:00.000Z') },
      });
      const ended = await rejection(
        changeAssignment(h, entry.id, fx.assignmentDeptB),
      );
      expect(ended).toBeInstanceOf(BadRequestException);

      const unchanged = await tx.timeEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(unchanged).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
        scheduledShiftId: h.shift,
      });
      expect(await punchesOf(tx, entry.id)).toEqual(punches);
      expect(
        await tx.timeAdjustment.count({ where: { timeEntryId: entry.id } }),
      ).toBe(0);
    });
  });

  it('refuses to correct finalized time: approved segments and payroll output stay as approved', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const { entry } = await punchedEntry(h);
      await h.time.generateTimePeriods(
        fx.users.timeManager!,
        { organizationId: fx.orgA, startDate: '2027-03-01', cadence: 'WEEKLY' },
        h.manager,
      );
      const period = await tx.timePeriod.findFirstOrThrow({
        where: { organizationId: fx.orgA },
      });
      const sheet = await h.time.materializeTimesheetForEmployeePeriod(
        fx.employee1,
        period.id,
      );
      h.clock.value = at('2027-03-08T09:00');
      await h.time.submitTimesheet(fx.selfUser1, sheet.id, h.self);
      for (const segment of await tx.timesheetSegment.findMany({
        where: { timesheetId: sheet.id },
      })) {
        await h.time.approveTimesheetSegment(
          fx.users.timeManager!,
          segment.id,
          undefined,
          h.manager,
        );
      }
      const before = await h.time.approvedPayrollTimeOutputs(sheet.id);
      const segmentsBefore = await tx.timesheetSegment.findMany({
        where: { timesheetId: sheet.id },
        orderBy: { id: 'asc' },
      });
      expect(before.workDateOutputs).toEqual([
        expect.objectContaining({
          employmentAssignmentId: fx.assignmentTeamA,
          approvedWorkedMinutes: 180,
        }),
      ]);

      // A correction of approved (payroll-sensitive) time is refused until the timesheet is
      // reopened; nothing about the entry, its segments or the payroll output changes.
      const error = await rejection(
        changeAssignment(h, entry.id, fx.assignmentDeptB),
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'TIME_ENTRY_FINALIZED',
        timesheetId: sheet.id,
      });
      expect(
        (await tx.timeEntry.findUniqueOrThrow({ where: { id: entry.id } }))
          .employmentAssignmentId,
      ).toBe(fx.assignmentTeamA);

      expect(await h.time.approvedPayrollTimeOutputs(sheet.id)).toEqual(before);
      expect(
        await tx.timesheetSegment.findMany({
          where: { timesheetId: sheet.id },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(segmentsBefore);
      expect(
        (await tx.timesheet.findUniqueOrThrow({ where: { id: sheet.id } }))
          .status,
      ).toBe('APPROVED');
    });
  });

  it('recalculates mutable timesheets onto the corrected assignment', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      const { entry } = await punchedEntry(h);
      await h.time.generateTimePeriods(
        fx.users.timeManager!,
        { organizationId: fx.orgA, startDate: '2027-03-01', cadence: 'WEEKLY' },
        h.manager,
      );
      const period = await tx.timePeriod.findFirstOrThrow({
        where: { organizationId: fx.orgA },
      });
      const sheet = await h.time.materializeTimesheetForEmployeePeriod(
        fx.employee1,
        period.id,
      );
      await changeAssignment(h, entry.id, fx.assignmentDeptB);
      const segments = await tx.timesheetSegment.findMany({
        where: { timesheetId: sheet.id },
      });
      const minutes = Object.fromEntries(
        segments.map((segment) => [
          segment.employmentAssignmentId,
          segment.netWorkedMinutes,
        ]),
      );
      expect(minutes).toEqual({
        [fx.assignmentTeamA]: 0,
        [fx.assignmentDeptB]: 180,
      });
    });
  });

  it('leaves clocking, breaks, missed-punch resolution and other corrections working', async () => {
    await scenario(async (h) => {
      const { tx, fx } = h;
      h.clock.value = at('2027-03-02T09:00');
      await h.time.clockIn(fx.selfUser1, fx.assignmentTeamA, h.self);
      h.clock.value = at('2027-03-02T10:00');
      await h.time.startBreak(fx.selfUser1, h.self);
      h.clock.value = at('2027-03-02T10:15');
      await h.time.endBreak(fx.selfUser1, h.self);
      const open = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1, status: 'OPEN' },
      });
      expect(
        await tx.breakEntry.count({ where: { timeEntryId: open.id } }),
      ).toBe(1);

      // Missed clock-out is detected and resolved by the employee.
      h.clock.value = at('2027-03-03T03:00');
      await h.time.scanOpenTimeEntriesForExceptions();
      const missed = await tx.attendanceException.findFirstOrThrow({
        where: {
          timeEntryId: open.id,
          type: 'MISSING_CLOCK_OUT',
          status: 'OPEN',
        },
      });
      await h.time.resolveMissedClockOut(
        fx.selfUser1,
        missed.id,
        '2027-03-02T17:00',
        h.self,
      );
      const closed = await tx.timeEntry.findUniqueOrThrow({
        where: { id: open.id },
      });
      expect(closed).toMatchObject({
        status: 'CLOSED',
        clockOutAt: at('2027-03-02T17:00'),
      });

      // Another correction type on the punched entry, then the assignment change.
      await h.time.correctEntry(
        fx.users.timeManager!,
        open.id,
        {
          type: 'CHANGE_CLOCK_IN',
          reason: 'Badge',
          clockInAt: '2027-03-02T08:55',
        },
        h.manager,
      );
      const punches = await punchesOf(tx, open.id);
      await changeAssignment(h, open.id, fx.assignmentDeptB);
      expect(await punchesOf(tx, open.id)).toEqual(punches);
      expect(
        punches.every(
          (punch) => punch.employmentAssignmentId === fx.assignmentTeamA,
        ),
      ).toBe(true);

      // New clocking on the corrected assignment records its own immutable punches.
      h.clock.value = at('2027-03-03T09:00');
      await h.time.clockIn(fx.selfUser1, fx.assignmentDeptB, h.self);
      h.clock.value = at('2027-03-03T10:00');
      await h.time.clockOut(fx.selfUser1, h.self);
      const next = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1, clockInAt: at('2027-03-03T09:00') },
      });
      expect(
        (await punchesOf(tx, next.id)).map((punch) => [
          punch.type,
          punch.employmentAssignmentId,
        ]),
      ).toEqual([
        ['CLOCK_IN', fx.assignmentDeptB],
        ['CLOCK_OUT', fx.assignmentDeptB],
      ]);
    });
  });
});
