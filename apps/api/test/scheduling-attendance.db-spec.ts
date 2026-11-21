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
import type {
  ApprovedAbsenceInterval,
  ApprovedAbsenceSource,
} from '../src/time/time-integration.contracts.js';
import { SystemClock, TimeService } from '../src/time/time.service.js';
import {
  ALL_SCHEDULE_PERMISSIONS,
  cleanupSchedulingFixtures,
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
  self2: [{ permissions: ['time.clock'], scope: 'org' as const }],
  timeManager: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
  deptBCorrector: [{ permissions: ['time.correct'], scope: 'deptB' as const }],
};

/** America/Toronto is EST (-05:00) for the whole week of 2027-03-01. */
const at = (local: string) => new Date(`${local}:00-05:00`);

const TIME_POLICY = {
  clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
  breaks: { mode: 'MANUAL_PUNCH' },
  missedPunch: { enabled: true, maxOpenDurationMinutes: 960 },
  correction: { employeeRequestsEnabled: true },
  attendanceInterpretation: {
    mode: 'BASIC',
    lateArrivalEnabled: true,
    earlyDepartureEnabled: true,
    lateGraceMinutes: 5,
    earlyDepartureGraceMinutes: 5,
    // Ignored for a schedule-linked entry: its published revision is the expectation.
    expectedStartLocalTime: '06:00',
    expectedEndLocalTime: '12:00',
  },
};

class FixedClock extends SystemClock {
  value = new Date('2027-03-02T14:00:00.000Z');
  override now() {
    return new Date(this.value);
  }
}

class StubAbsences implements ApprovedAbsenceSource {
  rows: ApprovedAbsenceInterval[] = [];
  async approvedAbsences() {
    return this.rows;
  }
}

function attendanceServices(
  prisma: PrismaService,
  clock: FixedClock,
  absences?: ApprovedAbsenceSource,
  attendance?: ScheduleAttendanceService,
) {
  const svc = schedulingServices(prisma);
  const schedules =
    attendance ??
    new ScheduleAttendanceService(prisma, svc.targets, svc.policyResolver);
  const time = new TimeService(
    prisma,
    new TimeDomainService(),
    svc.authorization,
    svc.targets,
    svc.audit,
    clock,
    schedules,
    absences,
  );
  return { ...svc, schedules, time };
}

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  absences: StubAbsences;
  svc: ReturnType<typeof attendanceServices>;
  admin: ReturnType<typeof ctx>;
  /** Dept A (Team A assignments) and Dept B published schedules for 2027-03-01..07. */
  deptA: string;
  deptB: string;
  draftA: string;
  publish: (
    scheduleId: string,
    input: ReturnType<typeof torontoShift>,
  ) => Promise<string>;
  draft: (input: ReturnType<typeof torontoShift>) => Promise<string>;
  schedulePolicy: (settings: Record<string, unknown>) => Promise<void>;
  self: (user?: string) => ReturnType<typeof ctx>;
}

describe('Scheduling ↔ attendance integration (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function seedWorld(tx: Tx, fx: SchedulingFixtures) {
    // Positions without a work location use the organization's timezone (never a silent UTC).
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
  }

  async function scenario(run: (h: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(
            tx,
            USERS,
            TIME_PERMISSIONS,
          );
          await seedWorld(tx, fx);
          const client = rollbackClient(tx);
          const clock = new FixedClock();
          const absences = new StubAbsences();
          const svc = attendanceServices(client, clock, absences);
          const admin = ctx(fx.users.admin!);
          const schedule = async (departmentId: string, name: string) =>
            (
              await svc.scheduling.createSchedule(
                {
                  scopeType: 'DEPARTMENT',
                  organizationId: fx.orgA,
                  departmentId,
                  name,
                  type: 'AD_HOC',
                  periodStart: '2027-03-01',
                  periodEnd: '2027-03-07',
                },
                admin,
              )
            ).id;
          const deptA = await schedule(fx.deptA, 'A');
          const deptB = await schedule(fx.deptB, 'B');
          const draftA = await schedule(fx.deptA, 'A draft');
          // Publication needs at least one shift; seed far-away placeholders.
          await svc.scheduling.createShift(
            deptA,
            torontoShift(fx.otherTeamA, '2027-03-07', '09:00', '10:00'),
            admin,
          );
          await svc.scheduling.createShift(
            deptB,
            torontoShift(fx.assignmentDeptB, '2027-03-07', '18:00', '19:00'),
            admin,
          );
          await svc.scheduling.publishSchedule(deptA, admin);
          await svc.scheduling.publishSchedule(deptB, admin);
          await run({
            tx,
            fx,
            clock,
            absences,
            svc,
            admin,
            deptA,
            deptB,
            draftA,
            publish: async (scheduleId, input) =>
              (
                await svc.scheduling.addPublishedShift(
                  scheduleId,
                  { ...input, reason: 'Staffing' },
                  admin,
                )
              ).shift.id,
            draft: async (input) =>
              (await svc.scheduling.createShift(draftA, input, admin)).id,
            schedulePolicy: async (settings) => {
              await svc.policies.createPolicy(
                {
                  scopeType: 'ORGANIZATION',
                  organizationId: fx.orgA,
                  effectiveFrom: '2027-01-01',
                  ...settings,
                } as never,
                admin,
              );
            },
            self: (user = fx.selfUser1) => ctx(user),
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const entriesOf = (tx: Tx, employeeId: string) =>
    tx.timeEntry.findMany({
      where: { employeeId },
      orderBy: { clockInAt: 'asc' },
    });
  const openExceptions = (tx: Tx, timeEntryId: string, type?: string) =>
    tx.attendanceException.findMany({
      where: {
        timeEntryId,
        status: 'OPEN',
        ...(type ? { type: type as never } : {}),
      },
    });
  const latestRevision = (tx: Tx, scheduledShiftId: string) =>
    tx.scheduledShiftRevision.findFirstOrThrow({
      where: { scheduledShiftId },
      orderBy: { revisionNumber: 'desc' },
    });

  // ─── Clock-in matching ────────────────────────────────────────────────────

  it('links the one published shift and its latest revision, preselecting the assignment', async () => {
    await scenario(async ({ tx, fx, clock, svc, deptA, publish, self }) => {
      const shift = await publish(
        deptA,
        torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
      );
      clock.value = at('2027-03-02T08:50');
      const before = await svc.time.status(fx.selfUser1);
      expect(before).toMatchObject({
        state: 'OFF_CLOCK',
        preselectedScheduledShiftId: shift,
        preselectedEmploymentAssignmentId: fx.assignmentTeamA,
        scheduledShiftSelectionRequired: false,
      });
      expect(before.scheduledShiftOptions).toEqual([
        expect.objectContaining({
          scheduledShiftId: shift,
          revisionNumber: 1,
          clockInOpensAt: at('2027-03-02T08:00').toISOString(),
          clockInClosesAt: at('2027-03-02T11:00').toISOString(),
        }),
      ]);

      const status = await svc.time.clockIn(fx.selfUser1, undefined, self());
      const revision = await latestRevision(tx, shift);
      expect(status.currentTimeEntry).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
        scheduledShiftId: shift,
        scheduledShiftRevisionId: revision.id,
      });
      const [entry] = await entriesOf(tx, fx.employee1);
      expect(entry).toMatchObject({
        scheduledShiftId: shift,
        scheduledShiftRevisionId: revision.id,
        source: 'LIVE_CLOCK',
      });
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'TIME_CLOCKED_IN', entityId: entry!.id },
      });
      expect(audit.metadata).toMatchObject({
        scheduleSelection: 'PRESELECTED_SHIFT',
        scheduledShiftId: shift,
        scheduledShiftRevisionNumber: 1,
      });
      // A repeated request is idempotent.
      await svc.time.clockIn(fx.selfUser1, undefined, self());
      expect(await entriesOf(tx, fx.employee1)).toHaveLength(1);
    });
  });

  it('never matches draft or cancelled shifts, or another employee’s shift', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, deptA, publish, draft, admin, self }) => {
        // Cancelled shifts take no part in conflicts, so the draft may overlap it.
        const cancelled = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:30', '12:00'),
        );
        await svc.scheduling.cancelShift(
          deptA,
          cancelled,
          { reason: 'Closed' },
          admin,
        );
        await draft(
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        );
        const others = await publish(
          deptA,
          torontoShift(fx.otherTeamA, '2027-03-02', '09:00', '17:00'),
        );
        clock.value = at('2027-03-02T09:00');
        expect(
          (await svc.time.status(fx.selfUser1)).scheduledShiftOptions,
        ).toEqual([]);

        const error = await rejection(
          svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self(), others),
        );
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'SCHEDULED_SHIFT_NOT_ELIGIBLE',
        });
        const cancelledError = await rejection(
          svc.time.clockIn(fx.selfUser1, undefined, self(), cancelled),
        );
        expect(
          (cancelledError as BadRequestException).getResponse(),
        ).toMatchObject({
          code: 'SCHEDULED_SHIFT_NOT_ELIGIBLE',
        });

        await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self());
        const [entry] = await entriesOf(tx, fx.employee1);
        expect(entry).toMatchObject({
          scheduledShiftId: null,
          scheduledShiftRevisionId: null,
        });
      },
    );
  });

  it('opens the window early/late by policy minutes, capped at the shift end', async () => {
    await scenario(
      async ({ fx, clock, svc, deptA, publish, schedulePolicy }) => {
        const shift = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '10:00'),
        );
        const options = async (local: string) => {
          clock.value = at(local);
          return (
            (await svc.time.status(fx.selfUser1)).scheduledShiftOptions ?? []
          ).map(
            (option: { scheduledShiftId: string }) => option.scheduledShiftId,
          );
        };
        // Defaults: 60 minutes early, 120 late, but never after endsAt (10:00).
        expect(await options('2027-03-02T07:59')).toEqual([]);
        expect(await options('2027-03-02T08:00')).toEqual([shift]);
        expect(await options('2027-03-02T09:59')).toEqual([shift]);
        expect(await options('2027-03-02T10:00')).toEqual([]);

        await schedulePolicy({
          clockInEarlyMinutes: 15,
          clockInLateMinutes: 30,
        });
        expect(await options('2027-03-02T08:44')).toEqual([]);
        expect(await options('2027-03-02T08:45')).toEqual([shift]);
        expect(await options('2027-03-02T09:30')).toEqual([shift]);
        expect(await options('2027-03-02T09:31')).toEqual([]);
      },
    );
  });

  it('matches an overnight shift by its instants, not by workDate', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, deptA, publish, schedulePolicy, self }) => {
        await schedulePolicy({ clockInLateMinutes: 180 });
        const overnight = await publish(
          deptA,
          torontoShift(
            fx.assignmentTeamA,
            '2027-03-02',
            '22:00',
            '06:00',
            '-05:00',
            '2027-03-03',
          ),
        );
        // 00:30 on 2027-03-03 is still inside the 22:00 + 180 minute window.
        clock.value = at('2027-03-03T00:30');
        await svc.time.clockIn(fx.selfUser1, undefined, self());
        const [entry] = await entriesOf(tx, fx.employee1);
        expect(entry!.scheduledShiftId).toBe(overnight);
        // Batch 4D (D-E): a linked entry takes its shift's work date, not the clock-in's.
        expect(entry!.workDate.toISOString().slice(0, 10)).toBe('2027-03-02');
        // Lateness is judged against the revision's 22:00 start: 150 minutes late.
        const [late] = await openExceptions(tx, entry!.id, 'LATE_ARRIVAL');
        expect(late!.metadata).toMatchObject({
          expectedAt: at('2027-03-02T22:00').toISOString(),
          varianceMinutes: 150,
          expectedSourceType: 'SCHEDULE',
        });
        // Clocking out at 05:00 is early against the 06:00 end on the next day.
        clock.value = at('2027-03-03T05:00');
        await svc.time.clockOut(fx.selfUser1, self());
        const [early] = await openExceptions(tx, entry!.id, 'EARLY_DEPARTURE');
        expect(early!.metadata).toMatchObject({
          expectedAt: at('2027-03-03T06:00').toISOString(),
          varianceMinutes: 60,
        });
      },
    );
  });

  it('requires an explicit choice among several eligible shifts and honours it', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, deptA, deptB, publish, self }) => {
        // Back-to-back shifts on two assignments; their clock-in windows overlap at 09:00.
        const teamShift = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '08:00', '09:30'),
        );
        const deptBShift = await publish(
          deptB,
          torontoShift(fx.assignmentDeptB, '2027-03-02', '09:45', '12:00'),
        );
        clock.value = at('2027-03-02T09:00');
        const status = await svc.time.status(fx.selfUser1);
        expect(status.scheduledShiftSelectionRequired).toBe(true);
        expect(status.preselectedScheduledShiftId).toBeNull();
        expect(status.preselectedEmploymentAssignmentId).toBeNull();

        const error = await rejection(
          svc.time.clockIn(fx.selfUser1, undefined, self()),
        );
        expect(error).toBeInstanceOf(ConflictException);
        const body = (error as ConflictException).getResponse() as {
          code: string;
          options: Array<{ scheduledShiftId: string }>;
        };
        expect(body.code).toBe('SCHEDULED_SHIFT_SELECTION_REQUIRED');
        expect(
          body.options.map((option) => option.scheduledShiftId).sort(),
        ).toEqual([teamShift, deptBShift].sort());
        expect(await entriesOf(tx, fx.employee1)).toHaveLength(0);

        // A shift on another assignment than the one named is refused.
        const mismatch = await rejection(
          svc.time.clockIn(fx.selfUser1, fx.assignmentDeptB, self(), teamShift),
        );
        expect((mismatch as BadRequestException).getResponse()).toMatchObject({
          code: 'SCHEDULED_SHIFT_NOT_ELIGIBLE',
        });

        // An explicit assignment narrows the match without guessing.
        await svc.time.clockIn(fx.selfUser1, fx.assignmentDeptB, self());
        const [entry] = await entriesOf(tx, fx.employee1);
        expect(entry).toMatchObject({
          employmentAssignmentId: fx.assignmentDeptB,
          scheduledShiftId: deptBShift,
        });
        clock.value = at('2027-03-02T09:05');
        await svc.time.clockOut(fx.selfUser1, self());

        // An explicit shift is linked as chosen.
        clock.value = at('2027-03-02T09:10');
        await svc.time.clockIn(fx.selfUser1, undefined, self(), teamShift);
        const second = (await entriesOf(tx, fx.employee1))[1];
        expect(second).toMatchObject({
          employmentAssignmentId: fx.assignmentTeamA,
          scheduledShiftId: teamShift,
        });
        const audit = await tx.auditLog.findFirstOrThrow({
          where: { action: 'TIME_CLOCKED_IN', entityId: second!.id },
        });
        expect(audit.metadata).toMatchObject({
          scheduleSelection: 'EXPLICIT_SHIFT',
        });
      },
    );
  });

  it('does not override an explicit assignment that has no shift', async () => {
    await scenario(async ({ tx, fx, clock, svc, deptA, publish, self }) => {
      await publish(
        deptA,
        torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
      );
      clock.value = at('2027-03-02T09:00');
      await svc.time.clockIn(fx.selfUser1, fx.assignmentDeptB, self());
      const [entry] = await entriesOf(tx, fx.employee1);
      expect(entry).toMatchObject({
        employmentAssignmentId: fx.assignmentDeptB,
        scheduledShiftId: null,
      });
    });
  });

  it('asks for an assignment when no shift matches and several are eligible', async () => {
    await scenario(async ({ tx, fx, clock, svc, self }) => {
      clock.value = at('2027-03-02T09:00');
      const status = await svc.time.status(fx.selfUser1);
      expect(status.preselectedEmploymentAssignmentId).toBeNull();
      const error = await rejection(
        svc.time.clockIn(fx.selfUser1, undefined, self()),
      );
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'ASSIGNMENT_SELECTION_REQUIRED',
      });
      expect(await entriesOf(tx, fx.employee1)).toHaveLength(0);
    });
  });

  it('ALLOW_UNSCHEDULED records unlinked attendance without a signal', async () => {
    await scenario(async ({ tx, fx, clock, svc, self }) => {
      clock.value = at('2027-03-02T09:00');
      const status = await svc.time.clockIn(
        fx.selfUser1,
        fx.assignmentTeamA,
        self(),
      );
      expect('warnings' in status).toBe(false);
      const [entry] = await entriesOf(tx, fx.employee1);
      expect(
        await openExceptions(tx, entry!.id, 'UNSCHEDULED_WORK'),
      ).toHaveLength(0);
    });
  });

  it('WARN_UNSCHEDULED records attendance with a non-blocking review signal', async () => {
    await scenario(async ({ tx, fx, clock, svc, schedulePolicy, self }) => {
      await schedulePolicy({ unscheduledWorkMode: 'WARN_UNSCHEDULED' });
      clock.value = at('2027-03-02T09:00');
      const status = await svc.time.clockIn(
        fx.selfUser1,
        fx.assignmentTeamA,
        self(),
      );
      expect(status).toMatchObject({
        state: 'CLOCKED_IN',
        warnings: [expect.objectContaining({ code: 'UNSCHEDULED_WORK' })],
      });
      const [entry] = await entriesOf(tx, fx.employee1);
      const [signal] = await openExceptions(tx, entry!.id, 'UNSCHEDULED_WORK');
      expect(signal).toMatchObject({
        severity: 'REVIEW',
        workflowImpact: 'NON_BLOCKING',
      });
      expect(
        await tx.auditLog.count({
          where: {
            action: 'TIME_UNSCHEDULED_WORK_FLAGGED',
            entityId: signal!.id,
          },
        }),
      ).toBe(1);
    });
  });

  it('REQUIRE_SCHEDULED_SHIFT blocks unscheduled self clock-in; the manager path is an audited correction', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, deptA, publish, schedulePolicy, self }) => {
        await schedulePolicy({
          unscheduledWorkMode: 'REQUIRE_SCHEDULED_SHIFT',
        });
        clock.value = at('2027-03-02T09:00');
        expect(
          (await svc.time.status(fx.selfUser1)).unscheduledWorkModes,
        ).toContainEqual({
          employmentAssignmentId: fx.assignmentTeamA,
          mode: 'REQUIRE_SCHEDULED_SHIFT',
        });
        const error = await rejection(
          svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self()),
        );
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'SCHEDULED_SHIFT_REQUIRED',
        });
        expect(await entriesOf(tx, fx.employee1)).toHaveLength(0);

        // The authorized manager path is the existing, audited correction workflow: the employee
        // requests the missing entry and a manager with time.approve approves it.
        const request = await svc.time.requestCorrection(
          fx.selfUser1,
          {
            type: 'ADD_MISSING_TIME_ENTRY',
            reason: 'Called in unscheduled',
            employmentAssignmentId: fx.assignmentTeamA,
            startAt: '2027-03-02T06:00',
            endAt: '2027-03-02T08:00',
          },
          self(),
        );
        await svc.time.approveCorrection(
          fx.users.timeManager!,
          (request as { id: string }).id,
          'Approved override',
          ctx(fx.users.timeManager!),
        );
        const [manual] = await entriesOf(tx, fx.employee1);
        expect(manual).toMatchObject({
          source: 'MANUAL',
          scheduledShiftId: null,
        });

        const shift = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:30', '17:00'),
        );
        await svc.time.clockIn(fx.selfUser1, undefined, self());
        const [entry] = await entriesOf(tx, fx.employee1).then((rows) =>
          rows.filter((row) => row.source === 'LIVE_CLOCK'),
        );
        expect(entry!.scheduledShiftId).toBe(shift);
      },
    );
  });

  it('keeps Phase 6 clock authorization: no time.clock, no clock-in', async () => {
    await scenario(async ({ tx, fx, clock, svc, deptA, publish }) => {
      const stranger = await tx.user.create({
        data: {
          personId: (await tx.person.create({ data: {} })).id,
          email: `p7-stranger-${fx.suffix.toLowerCase()}@example.com`,
          status: 'ACTIVE',
        },
      });
      await publish(
        deptA,
        torontoShift(fx.otherTeamA, '2027-03-02', '09:00', '17:00'),
      );
      clock.value = at('2027-03-02T09:00');
      await expect(
        svc.time.clockIn(stranger.id, undefined, ctx(stranger.id)),
      ).rejects.toThrow();
      // Employee 2 (time.clock) can, and only ever sees their own shift.
      const status = await svc.time.clockIn(
        fx.selfUser2,
        undefined,
        ctx(fx.selfUser2),
      );
      expect(status.currentTimeEntry?.employmentAssignmentId).toBe(
        fx.otherTeamA,
      );
    });
  });

  // ─── Link integrity ───────────────────────────────────────────────────────

  it('enforces both-or-neither links, revision ownership and restricted deletes', async () => {
    await scenario(async ({ tx, fx, deptA, publish }) => {
      const shift = await publish(
        deptA,
        torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
      );
      const other = await publish(
        deptA,
        torontoShift(fx.assignmentTeamA, '2027-03-03', '09:00', '17:00'),
      );
      const otherRevision = await latestRevision(tx, other);
      const base = {
        employeeId: fx.employee1,
        employmentAssignmentId: fx.assignmentTeamA,
        clockInAt: at('2027-03-02T09:00'),
        timezone: 'America/Toronto',
        workDate: new Date('2027-03-02T00:00:00.000Z'),
      };
      expect(
        await violation(tx, () =>
          tx.timeEntry.create({ data: { ...base, scheduledShiftId: shift } }),
        ),
      ).toMatchObject({
        message: expect.stringContaining('scheduled_shift_link_shape'),
      });
      await expect(
        violation(tx, () =>
          tx.timeEntry.create({
            data: {
              ...base,
              scheduledShiftId: shift,
              scheduledShiftRevisionId: otherRevision.id,
            },
          }),
        ),
      ).resolves.toBeDefined();
      const linked = await tx.timeEntry.create({
        data: {
          ...base,
          scheduledShiftId: shift,
          scheduledShiftRevisionId: (await latestRevision(tx, shift)).id,
        },
      });
      expect(linked.scheduledShiftId).toBe(shift);
      await expect(
        violation(tx, () =>
          tx.scheduledShiftRevision.deleteMany({
            where: { scheduledShiftId: shift },
          }),
        ),
      ).resolves.toBeDefined();
      // Unscheduled entries stay supported.
      const unlinked = await tx.timeEntry.create({
        data: {
          ...base,
          clockInAt: at('2027-03-02T18:00'),
          clockOutAt: at('2027-03-02T19:00'),
          status: 'CLOSED',
        },
      });
      expect(unlinked.scheduledShiftRevisionId).toBeNull();
    });
  });

  // ─── Interpretation ───────────────────────────────────────────────────────

  it('interprets lateness from the revision with attendance grace, and eligibility is not lateness', async () => {
    await scenario(async ({ tx, fx, clock, svc, deptA, publish, self }) => {
      await publish(
        deptA,
        torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
      );
      // Early inside the window: eligible, never late (the policy 06:00 expectation is ignored).
      clock.value = at('2027-03-02T08:10');
      await svc.time.clockIn(fx.selfUser1, undefined, self());
      let [entry] = await entriesOf(tx, fx.employee1);
      expect(await openExceptions(tx, entry!.id, 'LATE_ARRIVAL')).toHaveLength(
        0,
      );
      clock.value = at('2027-03-02T17:00');
      await svc.time.clockOut(fx.selfUser1, self());
      expect(
        await openExceptions(tx, entry!.id, 'EARLY_DEPARTURE'),
      ).toHaveLength(0);

      // Within grace (5 minutes) is not late.
      await publish(
        deptA,
        torontoShift(fx.assignmentTeamA, '2027-03-03', '09:00', '17:00'),
      );
      clock.value = at('2027-03-03T09:05');
      await svc.time.clockIn(fx.selfUser1, undefined, self());
      entry = (await entriesOf(tx, fx.employee1))[1];
      expect(await openExceptions(tx, entry!.id, 'LATE_ARRIVAL')).toHaveLength(
        0,
      );
      clock.value = at('2027-03-03T16:50');
      await svc.time.clockOut(fx.selfUser1, self());
      const [early] = await openExceptions(tx, entry!.id, 'EARLY_DEPARTURE');
      expect(early!.metadata).toMatchObject({
        varianceMinutes: 10,
        graceMinutes: 5,
      });

      // Still eligible at 10:30, but late against 09:00.
      const third = await publish(
        deptA,
        torontoShift(fx.assignmentTeamA, '2027-03-04', '09:00', '17:00'),
      );
      clock.value = at('2027-03-04T10:30');
      await svc.time.clockIn(fx.selfUser1, undefined, self());
      entry = (await entriesOf(tx, fx.employee1))[2];
      const [late] = await openExceptions(tx, entry!.id, 'LATE_ARRIVAL');
      expect(late!.metadata).toMatchObject({
        expectedAt: at('2027-03-04T09:00').toISOString(),
        varianceMinutes: 90,
        scheduledShiftId: third,
        scheduledShiftRevisionId: entry!.scheduledShiftRevisionId,
        scheduledShiftRevisionNumber: 1,
      });
    });
  });

  it('keeps Phase 6 policy expectations for unscheduled entries', async () => {
    await scenario(async ({ tx, fx, clock, svc, self }) => {
      clock.value = at('2027-03-02T06:30');
      await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self());
      const [entry] = await entriesOf(tx, fx.employee1);
      const [late] = await openExceptions(tx, entry!.id, 'LATE_ARRIVAL');
      expect(late!.metadata).toMatchObject({
        expectedAt: at('2027-03-02T06:00').toISOString(),
      });
      expect(late!.metadata).not.toHaveProperty('expectedSourceType');
    });
  });

  it('consults the approved-absence hook before interpreting expected work', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, absences, deptA, publish, self }) => {
        await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        );
        absences.rows = [
          {
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentTeamA,
            start: at('2027-03-02T09:00').toISOString(),
            end: at('2027-03-02T11:00').toISOString(),
            classification: 'PAID',
            sourceId: 'future-leave',
          },
        ];
        clock.value = at('2027-03-02T10:55');
        await svc.time.clockIn(fx.selfUser1, undefined, self());
        const [entry] = await entriesOf(tx, fx.employee1);
        expect(entry!.scheduledShiftId).not.toBeNull();
        expect(
          await openExceptions(tx, entry!.id, 'LATE_ARRIVAL'),
        ).toHaveLength(0);
      },
    );
  });

  // ─── Revision history ─────────────────────────────────────────────────────

  it('a correction after attendance raises a review signal and never rewrites the entry', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, deptA, publish, admin, self }) => {
        const shift = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        );
        clock.value = at('2027-03-02T09:30');
        await svc.time.clockIn(fx.selfUser1, undefined, self());
        const [entry] = await entriesOf(tx, fx.employee1);
        const original = entry!.scheduledShiftRevisionId;
        const [late] = await openExceptions(tx, entry!.id, 'LATE_ARRIVAL');
        expect(late!.metadata).toMatchObject({ varianceMinutes: 30 });

        await svc.scheduling.correctShift(
          deptA,
          shift,
          { startsAt: '2027-03-02T10:00:00-05:00', reason: 'Late opening' },
          admin,
        );
        const after = await tx.timeEntry.findUniqueOrThrow({
          where: { id: entry!.id },
        });
        expect(after.scheduledShiftRevisionId).toBe(original);
        // Interpretation is untouched until a manager decides.
        expect(
          await openExceptions(tx, entry!.id, 'LATE_ARRIVAL'),
        ).toHaveLength(1);
        const [signal] = await openExceptions(
          tx,
          entry!.id,
          'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
        );
        expect(signal).toMatchObject({
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
        });
        expect(signal!.metadata).toMatchObject({
          interpretedRevisionId: original,
          interpretedRevisionNumber: 1,
          currentRevisionNumber: 2,
          change: 'CORRECTED',
        });
        const shiftAudit = await tx.auditLog.findFirstOrThrow({
          where: { action: 'SCHEDULED_SHIFT_CORRECTED', entityId: shift },
        });
        expect(shiftAudit.metadata).toMatchObject({ attendanceReviewCount: 1 });

        // A second correction refreshes the single open signal.
        await svc.scheduling.correctShift(
          deptA,
          shift,
          { endsAt: '2027-03-02T16:00:00-05:00', reason: 'Early close' },
          admin,
        );
        const signals = await openExceptions(
          tx,
          entry!.id,
          'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
        );
        expect(signals).toHaveLength(1);
        expect(signals[0]!.metadata).toMatchObject({
          interpretedRevisionNumber: 1,
          currentRevisionNumber: 3,
        });
        expect(
          await tx.auditLog.count({
            where: {
              action: {
                in: [
                  'TIME_SCHEDULE_CHANGE_REVIEW_CREATED',
                  'TIME_SCHEDULE_CHANGE_REVIEW_UPDATED',
                ],
              },
              entityId: signal!.id,
            },
          }),
        ).toBe(2);
        // R4-A.5: the manager's list carries the original and current times and the shift's
        // schedule (to open its revisions); other exceptions have no schedule link.
        const listed = await svc.time.managementExceptions(
          fx.users.timeManager!,
          { limit: 100 },
        );
        const reviewed = listed.items.find((item) => item.id === signal!.id);
        expect(reviewed).toMatchObject({
          changedShiftScheduleId: deptA,
          timezone: 'America/Toronto',
          metadata: expect.objectContaining({
            scheduledShiftId: shift,
            interpretedStartsAt: at('2027-03-02T09:00').toISOString(),
            interpretedEndsAt: at('2027-03-02T17:00').toISOString(),
            currentStartsAt: at('2027-03-02T10:00').toISOString(),
            currentEndsAt: at('2027-03-02T16:00').toISOString(),
            change: 'CORRECTED',
          }),
        });
        expect(
          listed.items.find((item) => item.type === 'LATE_ARRIVAL'),
        ).toMatchObject({ changedShiftScheduleId: null });
        // The revision the entry consumed is immutable history.
        expect(
          await tx.scheduledShiftRevision.findUniqueOrThrow({
            where: { id: original! },
          }),
        ).toMatchObject({
          revisionNumber: 1,
          startsAt: at('2027-03-02T09:00'),
        });
      },
    );
  });

  it('a cancellation after attendance preserves the entry and flags it', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, deptA, publish, admin, self }) => {
        const shift = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        );
        clock.value = at('2027-03-02T09:00');
        await svc.time.clockIn(fx.selfUser1, undefined, self());
        clock.value = at('2027-03-02T12:00');
        await svc.time.clockOut(fx.selfUser1, self());
        await svc.scheduling.cancelShift(
          deptA,
          shift,
          { reason: 'Closed' },
          admin,
        );
        const [entry] = await entriesOf(tx, fx.employee1);
        expect(entry).toMatchObject({
          status: 'CLOSED',
          scheduledShiftId: shift,
          archivedAt: null,
        });
        const [signal] = await openExceptions(
          tx,
          entry!.id,
          'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
        );
        expect(signal!.metadata).toMatchObject({
          change: 'CANCELLED',
          currentStatus: 'CANCELLED',
        });
        // The early departure against the interpreted revision stands until reinterpretation.
        expect(
          await openExceptions(tx, entry!.id, 'EARLY_DEPARTURE'),
        ).toHaveLength(1);

        // Reinterpreting against the cancellation removes the expectation and resolves signals.
        const result = await svc.time.linkScheduledShift(
          fx.users.timeManager!,
          entry!.id,
          { scheduledShiftId: shift, reason: 'Acknowledged cancellation' },
          ctx(fx.users.timeManager!),
        );
        expect(result).toMatchObject({ changed: true, revisionNumber: 2 });
        expect(await openExceptions(tx, entry!.id)).toHaveLength(0);
      },
    );
  });

  it('managers reinterpret, relink and unlink entries with time.correct only', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, deptA, publish, admin, self }) => {
        const shift = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        );
        clock.value = at('2027-03-02T09:30');
        await svc.time.clockIn(fx.selfUser1, undefined, self());
        const [entry] = await entriesOf(tx, fx.employee1);
        await svc.scheduling.correctShift(
          deptA,
          shift,
          { startsAt: '2027-03-02T09:30:00-05:00', reason: 'Late opening' },
          admin,
        );
        const body = { scheduledShiftId: shift, reason: 'Reviewed' };
        await expect(
          svc.time.linkScheduledShift(fx.selfUser1, entry!.id, body, self()),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          svc.time.linkScheduledShift(
            fx.users.deptBCorrector!,
            entry!.id,
            body,
            ctx(fx.users.deptBCorrector!),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        const manager = ctx(fx.users.timeManager!);
        const result = await svc.time.linkScheduledShift(
          fx.users.timeManager!,
          entry!.id,
          body,
          manager,
        );
        const current = await latestRevision(tx, shift);
        expect(result).toMatchObject({
          scheduledShiftRevisionId: current.id,
          revisionNumber: 2,
        });
        // 09:30 is on time against revision 2: lateness auto-resolves, the signal is answered.
        expect(await openExceptions(tx, entry!.id)).toHaveLength(0);
        const signal = await tx.attendanceException.findFirstOrThrow({
          where: {
            timeEntryId: entry!.id,
            type: 'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
          },
        });
        expect(signal).toMatchObject({
          status: 'RESOLVED',
          resolutionMethod: 'MANAGER_RESOLUTION',
        });
        expect(
          (
            await tx.auditLog.findFirstOrThrow({
              where: {
                action: 'TIME_ENTRY_SCHEDULE_LINK_CHANGED',
                entityId: entry!.id,
              },
            })
          ).metadata,
        ).toMatchObject({ reason: 'Reviewed', after: { revisionNumber: 2 } });

        // Repeating the decision is a no-op.
        expect(
          await svc.time.linkScheduledShift(
            fx.users.timeManager!,
            entry!.id,
            body,
            manager,
          ),
        ).toMatchObject({ changed: false });

        // Another assignment's shift is refused; an explicit null unlinks.
        const otherShift = await publish(
          deptA,
          torontoShift(fx.otherTeamA, '2027-03-02', '09:00', '17:00'),
        );
        await expect(
          svc.time.linkScheduledShift(
            fx.users.timeManager!,
            entry!.id,
            { scheduledShiftId: otherShift, reason: 'Wrong' },
            manager,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        await svc.time.linkScheduledShift(
          fx.users.timeManager!,
          entry!.id,
          { scheduledShiftId: null, reason: 'Not this shift' },
          manager,
        );
        expect(
          await tx.timeEntry.findUniqueOrThrow({ where: { id: entry!.id } }),
        ).toMatchObject({
          scheduledShiftId: null,
          scheduledShiftRevisionId: null,
        });
      },
    );
  });

  it('linking an unscheduled entry answers its UNSCHEDULED_WORK signal', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, deptA, publish, schedulePolicy, self }) => {
        await schedulePolicy({ unscheduledWorkMode: 'WARN_UNSCHEDULED' });
        clock.value = at('2027-03-02T09:00');
        await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self());
        const [entry] = await entriesOf(tx, fx.employee1);
        const shift = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        );
        await svc.time.linkScheduledShift(
          fx.users.timeManager!,
          entry!.id,
          { scheduledShiftId: shift, reason: 'Added to schedule' },
          ctx(fx.users.timeManager!),
        );
        expect(
          await openExceptions(tx, entry!.id, 'UNSCHEDULED_WORK'),
        ).toHaveLength(0);
        expect(
          (await tx.timeEntry.findUniqueOrThrow({ where: { id: entry!.id } }))
            .scheduledShiftId,
        ).toBe(shift);
      },
    );
  });

  it('never reinterprets approved time; payroll output is computed from actual attendance', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, deptA, publish, admin, self }) => {
        const shift = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        );
        clock.value = at('2027-03-02T09:00');
        await svc.time.clockIn(fx.selfUser1, undefined, self());
        clock.value = at('2027-03-02T15:00');
        await svc.time.clockOut(fx.selfUser1, self());
        const manager = ctx(fx.users.timeManager!);
        await svc.time.generateTimePeriods(
          fx.users.timeManager!,
          {
            organizationId: fx.orgA,
            startDate: '2027-03-01',
            cadence: 'WEEKLY',
          },
          manager,
        );
        const period = await tx.timePeriod.findFirstOrThrow({
          where: { organizationId: fx.orgA },
        });
        const sheet = await svc.time.materializeTimesheetForEmployeePeriod(
          fx.employee1,
          period.id,
        );
        clock.value = at('2027-03-08T09:00');
        await svc.time.submitTimesheet(fx.selfUser1, sheet.id, self());
        for (const segment of await tx.timesheetSegment.findMany({
          where: { timesheetId: sheet.id },
        })) {
          await svc.time.approveTimesheetSegment(
            fx.users.timeManager!,
            segment.id,
            undefined,
            manager,
          );
        }
        const outputs = await svc.time.approvedPayrollTimeOutputs(sheet.id);
        expect(outputs.workDateOutputs).toEqual([
          expect.objectContaining({
            employmentAssignmentId: fx.assignmentTeamA,
            approvedWorkedMinutes: 360,
            finalizationStatus: 'APPROVED',
          }),
        ]);

        await svc.scheduling.correctShift(
          deptA,
          shift,
          { endsAt: '2027-03-02T15:00:00-05:00', reason: 'Retro' },
          admin,
        );
        const [entry] = await entriesOf(tx, fx.employee1);
        expect(
          await openExceptions(
            tx,
            entry!.id,
            'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
          ),
        ).toHaveLength(1);
        const error = await rejection(
          svc.time.linkScheduledShift(
            fx.users.timeManager!,
            entry!.id,
            { scheduledShiftId: shift, reason: 'Retro' },
            manager,
          ),
        );
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'TIME_ENTRY_FINALIZED',
        });
        expect(await svc.time.approvedPayrollTimeOutputs(sheet.id)).toEqual(
          outputs,
        );
      },
    );
  });

  // ─── Phase 6 regression ───────────────────────────────────────────────────

  it('breaks, switching and corrections keep working on linked entries', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, deptA, deptB, publish, self }) => {
        const teamShift = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '12:00'),
        );
        const deptBShift = await publish(
          deptB,
          torontoShift(fx.assignmentDeptB, '2027-03-02', '12:00', '16:00'),
        );
        clock.value = at('2027-03-02T09:00');
        await svc.time.clockIn(fx.selfUser1, undefined, self());
        clock.value = at('2027-03-02T10:00');
        expect(await svc.time.startBreak(fx.selfUser1, self())).toMatchObject({
          state: 'ON_BREAK',
        });
        clock.value = at('2027-03-02T10:15');
        expect(await svc.time.endBreak(fx.selfUser1, self())).toMatchObject({
          state: 'CLOCKED_IN',
        });

        clock.value = at('2027-03-02T12:00');
        const switched = await svc.time.switchAssignment(
          fx.selfUser1,
          fx.assignmentDeptB,
          self(),
        );
        expect(switched.currentTimeEntry).toMatchObject({
          employmentAssignmentId: fx.assignmentDeptB,
          scheduledShiftId: deptBShift,
        });
        const [first, second] = await entriesOf(tx, fx.employee1);
        expect(first).toMatchObject({
          status: 'CLOSED',
          scheduledShiftId: teamShift,
        });
        expect(
          await tx.breakEntry.count({ where: { timeEntryId: first!.id } }),
        ).toBe(1);

        clock.value = at('2027-03-02T16:00');
        await svc.time.clockOut(fx.selfUser1, self());

        // A time correction keeps the link; moving to another assignment ends it.
        const manager = ctx(fx.users.timeManager!);

        await svc.time.correctEntry(
          fx.users.timeManager!,
          second!.id,
          // The Dept B position has no WorkLocation, so its entries are in UTC.
          {
            type: 'CHANGE_CLOCK_IN',
            reason: 'Badge',
            clockInAt: '2027-03-02T17:05',
          },
          manager,
        );
        expect(
          (await tx.timeEntry.findUniqueOrThrow({ where: { id: second!.id } }))
            .scheduledShiftId,
        ).toBe(deptBShift);
        // Moving a linked entry to another assignment ends its link (punched entries are covered
        // in time-change-assignment.db-spec.ts).
        const nextDay = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-03', '09:00', '12:00'),
        );
        const manual = await tx.timeEntry.create({
          data: {
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentTeamA,
            clockInAt: at('2027-03-03T09:00'),
            clockOutAt: at('2027-03-03T12:00'),
            timezone: 'America/Toronto',
            workDate: new Date('2027-03-03T00:00:00.000Z'),
            status: 'CLOSED',
            source: 'MANUAL',
            scheduledShiftId: nextDay,
            scheduledShiftRevisionId: (await latestRevision(tx, nextDay)).id,
          },
        });
        // Batch 4A: corrections never concern future time; correct it the day after.
        clock.value = at('2027-03-04T09:00');
        await svc.time.correctEntry(
          fx.users.timeManager!,
          manual.id,
          {
            type: 'CHANGE_ASSIGNMENT',
            reason: 'Wrong job',
            targetEmploymentAssignmentId: fx.assignmentDeptB,
          },
          manager,
        );
        const moved = await tx.timeEntry.findUniqueOrThrow({
          where: { id: manual.id },
        });
        expect(moved).toMatchObject({
          employmentAssignmentId: fx.assignmentDeptB,
          scheduledShiftId: null,
          scheduledShiftRevisionId: null,
        });
        const adjustment = await tx.timeAdjustment.findFirstOrThrow({
          where: { timeEntryId: manual.id, type: 'CHANGE_ASSIGNMENT' },
        });
        expect(adjustment.newValues).toMatchObject({
          clearedScheduleLink: { scheduledShiftId: nextDay },
        });
      },
    );
  });

  it('REQUIRE_SCHEDULED_SHIFT also governs switching, and missed punches still detect', async () => {
    await scenario(
      async ({ tx, fx, clock, svc, deptA, publish, schedulePolicy, self }) => {
        const shift = await publish(
          deptA,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        );
        await schedulePolicy({
          unscheduledWorkMode: 'REQUIRE_SCHEDULED_SHIFT',
        });
        clock.value = at('2027-03-02T09:00');
        await svc.time.clockIn(fx.selfUser1, undefined, self());
        clock.value = at('2027-03-02T10:00');
        const error = await rejection(
          svc.time.switchAssignment(fx.selfUser1, fx.assignmentDeptB, self()),
        );
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          code: 'SCHEDULED_SHIFT_REQUIRED',
        });

        clock.value = at('2027-03-03T03:00');
        await svc.time.scanOpenTimeEntriesForExceptions();
        const [entry] = await entriesOf(tx, fx.employee1);
        expect(
          await openExceptions(tx, entry!.id, 'MISSING_CLOCK_OUT'),
        ).toHaveLength(1);
        expect(entry!.scheduledShiftId).toBe(shift);
      },
    );
  });

  // ─── Concurrency ──────────────────────────────────────────────────────────

  it('a reinterpretation racing a correction neither deadlocks nor misses the new revision', async () => {
    const fx = await prisma.$transaction(
      async (tx) => {
        const created = await createSchedulingFixtures(
          tx,
          USERS,
          TIME_PERMISSIONS,
        );
        await seedWorld(tx, created);
        return created;
      },
      { timeout: 60_000 },
    );
    try {
      const clock = new FixedClock();
      const plain = attendanceServices(prisma, clock);
      const admin = ctx(fx.users.admin!);
      const schedule = await plain.scheduling.createSchedule(
        {
          scopeType: 'DEPARTMENT',
          organizationId: fx.orgA,
          departmentId: fx.deptA,
          name: 'Race',
          type: 'AD_HOC',
          periodStart: '2027-03-01',
          periodEnd: '2027-03-07',
        },
        admin,
      );
      const shift = await plain.scheduling.createShift(
        schedule.id,
        torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        admin,
      );
      await plain.scheduling.publishSchedule(schedule.id, admin);
      clock.value = at('2027-03-02T09:00');
      await plain.time.clockIn(fx.selfUser1, undefined, ctx(fx.selfUser1));
      const [entry] = await prisma.timeEntry.findMany({
        where: { employeeId: fx.employee1 },
      });

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let paused!: () => void;
      const reachedPause = new Promise<void>((resolve) => (paused = resolve));
      const base = schedulingServices(prisma);
      class PausingAttendance extends ScheduleAttendanceService {
        override async lockPublishedShift(
          ...args: Parameters<ScheduleAttendanceService['lockPublishedShift']>
        ) {
          // The entry row is already locked; hold here before taking the shift lock.
          paused();
          await gate;
          return super.lockPublishedShift(...args);
        }
      }
      const racing = attendanceServices(
        prisma,
        clock,
        undefined,
        new PausingAttendance(prisma, base.targets, base.policyResolver),
      );
      const reinterpret = racing.time.linkScheduledShift(
        fx.users.timeManager!,
        entry!.id,
        { scheduledShiftId: shift.id, reason: 'Review' },
        ctx(fx.users.timeManager!),
      );
      await reachedPause;
      // The correction raises a signal for the locked entry without waiting on it.
      await plain.scheduling.correctShift(
        schedule.id,
        shift.id,
        { startsAt: '2027-03-02T09:30:00-05:00', reason: 'Race' },
        admin,
      );
      release();
      const result = await reinterpret;
      expect(result).toMatchObject({ revisionNumber: 2, changed: true });
      expect(
        await prisma.attendanceException.count({
          where: { timeEntryId: entry!.id, status: 'OPEN' },
        }),
      ).toBe(0);
    } finally {
      await cleanupSchedulingFixtures(prisma, fx);
    }
  });

  it('a correction racing a clock-in either is seen by the link or flags the entry', async () => {
    const fx = await prisma.$transaction(
      async (tx) => {
        const created = await createSchedulingFixtures(
          tx,
          USERS,
          TIME_PERMISSIONS,
        );
        await seedWorld(tx, created);
        return created;
      },
      { timeout: 60_000 },
    );
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      let paused!: () => void;
      const reachedPause = new Promise<void>((resolve) => (paused = resolve));
      const base = schedulingServices(prisma);
      class PausingAttendance extends ScheduleAttendanceService {
        override async clockInCandidates(
          ...args: Parameters<ScheduleAttendanceService['clockInCandidates']>
        ) {
          const result = await super.clockInCandidates(...args);
          // The second call is the post-lock re-check inside the clock-in transaction.
          if (++calls === 2) {
            paused();
            await gate;
          }
          return result;
        }
      }
      const clock = new FixedClock();
      const svc = attendanceServices(
        prisma,
        clock,
        undefined,
        new PausingAttendance(prisma, base.targets, base.policyResolver),
      );
      const admin = ctx(fx.users.admin!);
      const schedule = await svc.scheduling.createSchedule(
        {
          scopeType: 'DEPARTMENT',
          organizationId: fx.orgA,
          departmentId: fx.deptA,
          name: 'Race',
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

      clock.value = at('2027-03-02T09:00');
      const clockIn = svc.time.clockIn(
        fx.selfUser1,
        undefined,
        ctx(fx.selfUser1),
      );
      await reachedPause;
      let corrected = false;
      const correction = svc.scheduling
        .correctShift(
          schedule.id,
          shift.id,
          { startsAt: '2027-03-02T09:30:00-05:00', reason: 'Race' },
          admin,
        )
        .then((result) => {
          corrected = true;
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The correction waits on the clock-in's share lock on the shift row.
      expect(corrected).toBe(false);
      release();
      await clockIn;
      await correction;

      const [entry] = await prisma.timeEntry.findMany({
        where: { employeeId: fx.employee1 },
      });
      const revisionOne = await prisma.scheduledShiftRevision.findFirstOrThrow({
        where: { scheduledShiftId: shift.id, revisionNumber: 1 },
      });
      expect(entry!.scheduledShiftRevisionId).toBe(revisionOne.id);
      expect(
        await prisma.attendanceException.count({
          where: {
            timeEntryId: entry!.id,
            type: 'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
            status: 'OPEN',
          },
        }),
      ).toBe(1);
    } finally {
      await cleanupSchedulingFixtures(prisma, fx);
    }
  });
});
