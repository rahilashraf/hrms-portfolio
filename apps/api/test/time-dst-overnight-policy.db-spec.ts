import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { AttendanceSignInService } from '../src/time/attendance-sign-in.service.js';
import { TimeDomainService } from '../src/time/time-domain.service.js';
import { TimePolicyService } from '../src/time/time-policy.service.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
  violation,
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
import {
  addOrganizationBAssignment,
  closedEntry,
} from './support/time-world.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  self1: [
    { permissions: ['time.clock'], scope: 'org' as const },
    { permissions: ['time.clock'], scope: 'orgB' as const },
  ],
  self2: [{ permissions: ['time.clock'], scope: 'org' as const }],
  managerA: [
    {
      permissions: [...TIME_PERMISSIONS, 'time.manage_policy'],
      scope: 'org' as const,
    },
  ],
  managerB: [{ permissions: TIME_PERMISSIONS, scope: 'orgB' as const }],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  svc: ReturnType<typeof timeServices>;
  signIns: AttendanceSignInService;
}

const body = (error: unknown) =>
  (error as { getResponse?: () => Record<string, unknown> }).getResponse?.() ??
  {};
const byKey = (a: unknown[], b: unknown[]) =>
  JSON.stringify(a).localeCompare(JSON.stringify(b));
const status = (error: unknown) =>
  (error as { getStatus?: () => number }).getStatus?.();

/**
 * Batch 4D — time zones, daylight saving, overnight shifts, automatic break deduction and
 * optional sign-out (decisions D-A to D-I).
 */
describe('DST, overnight shifts, auto-deduction and sign-out (Batch 4D, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (h: Harness) => Promise<void>,
    policy: Record<string, unknown> = LIVE_TIME_POLICY,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, [
            ...TIME_PERMISSIONS,
            'time.manage_policy',
          ]);
          await seedTimePolicy(tx, fx.orgA, policy);
          const clock = new FixedClock();
          const client = rollbackClient(tx);
          const svc = timeServices(client, clock, { absences: true });
          const signIns = new AttendanceSignInService(
            client,
            svc.time,
            new TimeDomainService(),
            svc.audit,
            clock,
            svc.schedules,
          );
          await run({ tx, fx, clock, svc, signIns }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const clockIn = (h: Harness, at: Date, assignment = h.fx.assignmentTeamA) => {
    h.clock.value = at;
    return h.svc.time.clockIn(h.fx.selfUser1, assignment, ctx(h.fx.selfUser1));
  };
  const clockOut = (h: Harness, at: Date) => {
    h.clock.value = at;
    return h.svc.time.clockOut(h.fx.selfUser1, ctx(h.fx.selfUser1));
  };
  const openEntry = (h: Harness) =>
    h.tx.timeEntry.findFirstOrThrow({
      where: { employeeId: h.fx.employee1, status: 'OPEN' },
    });
  const exceptionsOf = (h: Harness, type: string) =>
    h.tx.attendanceException.findMany({
      where: { employeeId: h.fx.employee1, type: type as never },
      select: { status: true, timeEntryId: true, metadata: true },
    });

  // ─── D-A: time zone aliases ───────────────────────────────────────────────────────────

  it('records attendance in organizations whose time zone is a current IANA alias (Asia/Kolkata)', async () => {
    await scenario(async (h) => {
      const { fx, tx, svc } = h;
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'Asia/Kolkata' },
      });
      // Employee 2's org-level position has no work location: the organization's zone applies.
      h.clock.value = new Date('2027-03-02T03:45:00.000Z'); // 09:15 IST
      await svc.time.clockIn(fx.selfUser2, fx.orgLevel, ctx(fx.selfUser2));
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee2, status: 'OPEN' },
      });
      expect(entry).toMatchObject({
        timezone: 'Asia/Kolkata',
        workDate: new Date('2027-03-02'),
      });
    });
  });

  // ─── D-B: policy times across daylight saving never refuse a punch ───────────────────

  it('never refuses a clock-in or clock-out for an expected time inside a DST gap or overlap, and resolves it deterministically', async () => {
    await scenario(
      async (h) => {
        // Toronto spring-forward, 2027-03-14 02:00 → 03:00: the expected 02:30 is 03:30 EDT.
        await clockIn(h, new Date('2027-03-14T07:25:00.000Z')); // 03:25 EDT
        await clockOut(h, new Date('2027-03-14T12:00:00.000Z'));
        expect(await exceptionsOf(h, 'LATE_ARRIVAL')).toEqual([]);
        await clockIn(h, new Date('2027-03-15T07:45:00.000Z')); // 03:45, 75 min late
        await clockOut(h, new Date('2027-03-15T12:00:00.000Z'));
        expect(await exceptionsOf(h, 'LATE_ARRIVAL')).toHaveLength(1);
      },
      {
        ...LIVE_TIME_POLICY,
        attendanceInterpretation: {
          lateArrivalEnabled: true,
          lateGraceMinutes: 5,
          expectedStartLocalTime: '02:30',
        },
      },
    );
    await scenario(
      async (h) => {
        // Toronto fall-back, 2027-11-07 02:00 → 01:00: the expected 01:30 is its first (EDT)
        // occurrence, 05:30Z; a clock-in at 01:20 EST (06:20Z) is 50 minutes late.
        await clockIn(h, new Date('2027-11-07T06:20:00.000Z'));
        await clockOut(h, new Date('2027-11-07T10:00:00.000Z'));
        expect(await exceptionsOf(h, 'LATE_ARRIVAL')).toHaveLength(1);
      },
      {
        ...LIVE_TIME_POLICY,
        attendanceInterpretation: {
          lateArrivalEnabled: true,
          lateGraceMinutes: 5,
          expectedStartLocalTime: '01:30',
        },
      },
    );
  });

  it('handles Adelaide’s daylight saving (+09:30/+10:30) for clock-ins in an Adelaide work location', async () => {
    await scenario(
      async (h) => {
        const { tx, fx } = h;
        const position = await tx.position.findFirstOrThrow({
          where: { assignments: { some: { id: fx.assignmentTeamA } } },
          include: { workLocation: true },
        });
        await tx.workLocation.update({
          where: { id: position.workLocationId! },
          data: { timezone: 'Australia/Adelaide' },
        });
        // 2026-10-04 02:00 → 03:00 (+09:30 → +10:30): the expected 02:15 is 03:15.
        await clockIn(h, new Date('2026-10-03T16:50:00.000Z')); // 03:20 ACDT
        await clockOut(h, new Date('2026-10-03T22:00:00.000Z'));
        const entry = await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1 },
        });
        expect(entry).toMatchObject({
          timezone: 'Australia/Adelaide',
          workDate: new Date('2026-10-04'),
        });
        expect(await exceptionsOf(h, 'LATE_ARRIVAL')).toEqual([]);
      },
      {
        ...LIVE_TIME_POLICY,
        attendanceInterpretation: {
          lateArrivalEnabled: true,
          lateGraceMinutes: 10,
          expectedStartLocalTime: '02:15',
        },
      },
    );
  });

  // ─── D-B: overnight auto-close by the configured window, never by the clock-in ────────

  it('auto-closes an overnight entry at the next day’s expected end, but never turns a late daytime arrival into a 24-hour shift', async () => {
    const policy = (start: string, end: string) => ({
      ...LIVE_TIME_POLICY,
      missedPunch: {
        enabled: true,
        maxOpenDurationMinutes: 600,
        detectionGraceMinutes: 0,
        allowAutoCloseFromExpectedEnd: true,
        expectedEndLocalTime: end,
      },
      attendanceInterpretation: { expectedStartLocalTime: start },
    });
    await scenario(
      async (h) => {
        // Window 22:00–06:00 (crosses midnight): an entry from 22:00 closes at 06:00 next day.
        await clockIn(h, toronto('2027-03-02T22:00'));
        h.clock.value = toronto('2027-03-03T08:30');
        await h.svc.time.scanOpenTimeEntriesForExceptions();
        const entry = await h.tx.timeEntry.findFirstOrThrow({
          where: { employeeId: h.fx.employee1 },
        });
        expect(entry).toMatchObject({
          status: 'CLOSED',
          clockOutAt: toronto('2027-03-03T06:00'),
          workDate: new Date('2027-03-02'),
        });
      },
      policy('22:00', '06:00'),
    );
    await scenario(
      async (h) => {
        // Window 09:00–17:00: a late arrival at 18:00 is NOT auto-closed at 17:00 the next day
        // (a 23-hour shift); it is flagged as a missed clock-out for review instead.
        await clockIn(h, toronto('2027-03-02T18:00'));
        h.clock.value = toronto('2027-03-03T18:30');
        await h.svc.time.scanOpenTimeEntriesForExceptions();
        expect(await openEntry(h)).toMatchObject({ clockOutAt: null });
        expect(await exceptionsOf(h, 'MISSING_CLOCK_OUT')).toHaveLength(1);
      },
      policy('09:00', '17:00'),
    );
  });

  // ─── D-E: a late clock-in after midnight stays on its shift's work date ───────────────

  async function publishedShift(h: Harness, start: string, end: string) {
    const workDate = start.slice(0, 10);
    const schedule = await h.tx.schedule.create({
      data: {
        scopeType: 'ORGANIZATION',
        organizationId: h.fx.orgA,
        name: `Week of ${workDate}`,
        periodStart: new Date(workDate),
        periodEnd: new Date(end.slice(0, 10)),
        type: 'STANDARD',
        status: 'PUBLISHED',
        publishedAt: toronto(`${workDate}T00:00`),
        publishedByUserId: h.fx.users.managerA!,
      },
    });
    const shift = await h.tx.scheduledShift.create({
      data: {
        scheduleId: schedule.id,
        employmentAssignmentId: h.fx.assignmentTeamA,
        workDate: new Date(workDate),
        startsAt: toronto(start),
        endsAt: toronto(end),
        timezone: 'America/Toronto',
      },
    });
    await h.tx.scheduledShiftRevision.create({
      data: {
        scheduledShiftId: shift.id,
        revisionNumber: 1,
        revisionType: 'PUBLISHED_BASELINE',
        employmentAssignmentId: h.fx.assignmentTeamA,
        workDate: new Date(workDate),
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        timezone: 'America/Toronto',
        status: 'ACTIVE',
        sourceType: 'MANUAL',
        changedByUserId: h.fx.users.managerA!,
      },
    });
    return shift;
  }

  it('dates an entry linked to a published shift by the shift’s work date, and auto-closes it at the shift’s end', async () => {
    await scenario(
      async (h) => {
        const shift = await publishedShift(
          h,
          '2027-03-02T23:30',
          '2027-03-03T07:30',
        );
        // 35 minutes late, after midnight: linked to the shift, dated Mar 2 (the shift's day).
        await clockIn(h, toronto('2027-03-03T00:05'));
        const entry = await openEntry(h);
        expect(entry).toMatchObject({
          scheduledShiftId: shift.id,
          workDate: new Date('2027-03-02'),
        });
        // An unlinked clock-in keeps its own local date.
        await clockOut(h, toronto('2027-03-03T07:30'));
        await clockIn(h, toronto('2027-03-03T12:00'));
        expect((await openEntry(h)).workDate).toEqual(new Date('2027-03-03'));
        await clockOut(h, toronto('2027-03-03T13:00'));
        // The linked overnight shift's open entry is closed at the shift's end by the scan.
        await publishedShift(h, '2027-03-04T22:00', '2027-03-05T06:00');
        await clockIn(h, toronto('2027-03-04T22:05'));
        h.clock.value = toronto('2027-03-05T08:30');
        await h.svc.time.scanOpenTimeEntriesForExceptions();
        expect(
          await h.tx.timeEntry.findFirstOrThrow({
            where: {
              employeeId: h.fx.employee1,
              workDate: new Date('2027-03-04'),
            },
          }),
        ).toMatchObject({
          status: 'CLOSED',
          clockOutAt: toronto('2027-03-05T06:00'),
        });
      },
      {
        ...LIVE_TIME_POLICY,
        missedPunch: {
          enabled: true,
          maxOpenDurationMinutes: 600,
          detectionGraceMinutes: 0,
          allowAutoCloseFromExpectedEnd: true,
        },
      },
    );
  });

  // ─── D-C: typed times on DST days ─────────────────────────────────────────────────────

  it('refuses a typed time in a DST gap, lists both occurrences of a repeated one, and accepts the chosen offset', async () => {
    await scenario(async (h) => {
      const { svc, fx } = h;
      const manager = fx.users.managerA!;
      h.clock.value = toronto('2027-11-10T09:00');
      const add = (startAt: string, endAt: string) =>
        svc.time.addEntry(
          manager,
          fx.employee1,
          {
            employmentAssignmentId: fx.assignmentTeamA,
            startAt,
            endAt,
            reason: 'Paper timesheet',
          },
          ctx(manager),
        );
      const ambiguous = await rejection(
        add('2027-11-07T01:30', '2027-11-07T05:00'),
      );
      expect(status(ambiguous)).toBe(409);
      expect(body(ambiguous)).toMatchObject({
        code: 'TIME_LOCAL_TIME_AMBIGUOUS',
        occurrences: [
          { value: '2027-11-07T01:30-04:00' },
          { value: '2027-11-07T01:30-05:00' },
        ],
      });
      const gap = await rejection(add('2027-03-14T02:30', '2027-03-14T05:00'));
      expect(body(gap)).toMatchObject({ code: 'TIME_LOCAL_TIME_NONEXISTENT' });
      const mismatch = await rejection(
        add('2027-11-07T01:30+01:00', '2027-11-07T05:00'),
      );
      expect(body(mismatch)).toMatchObject({
        code: 'TIME_LOCAL_TIME_OFFSET_MISMATCH',
      });
      // The second 01:30 (EST): from 06:30Z to 10:00Z, 210 minutes.
      await add('2027-11-07T01:30-05:00', '2027-11-07T05:00');
      const entry = await h.tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      expect(entry.clockInAt.toISOString()).toBe('2027-11-07T06:30:00.000Z');
      expect(entry.clockOutAt!.toISOString()).toBe('2027-11-07T10:00:00.000Z');
    });
  });

  // ─── D-G: automatic deduction once per employee, organization and work date ───────────

  const AUTO = (minutes: number, after?: number) => ({
    ...LIVE_TIME_POLICY,
    breaks: {
      mode: 'AUTO_DEDUCT',
      autoDeductMinutes: minutes,
      ...(after === undefined ? {} : { autoDeductAfterMinutes: after }),
    },
  });

  async function weekSheet(h: Harness, organizationId = h.fx.orgA) {
    await h.svc.time.generateTimePeriods(
      organizationId === h.fx.orgA
        ? h.fx.users.managerA!
        : h.fx.users.managerB!,
      { organizationId, startDate: '2027-03-01', cadence: 'WEEKLY' },
      ctx(
        organizationId === h.fx.orgA
          ? h.fx.users.managerA!
          : h.fx.users.managerB!,
      ),
    );
    const period = await h.tx.timePeriod.findFirstOrThrow({
      where: { organizationId, startDate: new Date('2027-03-01') },
    });
    return h.svc.time.materializeTimesheetForEmployeePeriod(
      h.fx.employee1,
      period.id,
    );
  }

  const work = (
    h: Harness,
    assignmentId: string,
    day: string,
    from: string,
    to: string,
    unpaidBreak?: [string, string],
  ) =>
    closedEntry(h.tx, {
      employeeId: h.fx.employee1,
      employmentAssignmentId: assignmentId,
      clockInAt: toronto(`${day}T${from}`),
      clockOutAt: toronto(`${day}T${to}`),
      workDate: day,
    }).then(async (entry) => {
      if (unpaidBreak) {
        await h.tx.breakEntry.create({
          data: {
            timeEntryId: entry.id,
            startAt: toronto(`${day}T${unpaidBreak[0]}`),
            endAt: toronto(`${day}T${unpaidBreak[1]}`),
            payType: 'UNPAID',
          },
        });
      }
      return entry;
    });

  it('deducts once per day across split assignments, counts recorded breaks, never exceeds gross, and payroll rows match the totals', async () => {
    await scenario(async (h) => {
      const { fx, tx, svc } = h;
      const segmentsOf = async (sheetId: string) =>
        Object.fromEntries(
          (
            await tx.timesheetSegment.findMany({
              where: { timesheetId: sheetId },
            })
          ).map((segment) => [
            segment.employmentAssignmentId,
            [
              segment.grossMinutes,
              segment.policyDeductionMinutes,
              segment.netWorkedMinutes,
            ],
          ]),
        );
      // Mar 2: Team A 09:00–13:00 (240) then Dept B 13:00–16:00 (180): one 30-minute deduction,
      // on Team A (the most gross). Before 4D each entry was deducted (60).
      await work(h, fx.assignmentTeamA, '2027-03-02', '09:00', '13:00');
      await work(h, fx.assignmentDeptB, '2027-03-02', '13:00', '16:00');
      // Mar 3: Team A 09:00–17:00 with a recorded 20-minute unpaid break: 10 more deducted.
      await work(h, fx.assignmentTeamA, '2027-03-03', '09:00', '17:00', [
        '12:00',
        '12:20',
      ]);
      // Mar 4: Team A 15 minutes and Dept B 10 minutes (25 gross): the deduction stops at 25.
      await work(h, fx.assignmentTeamA, '2027-03-04', '09:00', '09:15');
      await work(h, fx.assignmentDeptB, '2027-03-04', '10:00', '10:10');
      const sheet = await weekSheet(h);
      expect(await segmentsOf(sheet.id)).toEqual({
        [fx.assignmentTeamA]: [240 + 480 + 15, 30 + 10 + 15, 210 + 450 + 0],
        [fx.assignmentDeptB]: [180 + 10, 0 + 10, 180 + 0],
      });
      // Approved, the payroll snapshot rows carry the same deduction per assignment and date.
      afterPeriodEnd(h.clock, '2027-03-07');
      await svc.time.submitTimesheetOnBehalf(
        fx.users.managerA!,
        sheet.id,
        'Away',
        ctx(fx.users.managerA!),
      );
      for (const segment of await tx.timesheetSegment.findMany({
        where: { timesheetId: sheet.id },
      })) {
        await svc.time.approveTimesheetSegment(
          fx.users.managerA!,
          segment.id,
          undefined,
          ctx(fx.users.managerA!),
        );
      }
      const approved = await tx.timesheet.findUniqueOrThrow({
        where: { id: sheet.id },
      });
      expect(approved.status).toBe('APPROVED');
      const rows = (
        approved.totals as {
          payrollWorkDates: Array<{
            employmentAssignmentId: string;
            workDate: string;
            policyDeductionMinutes: number;
            approvedWorkedMinutes: number;
          }>;
        }
      ).payrollWorkDates
        .map((row) => [
          row.employmentAssignmentId === fx.assignmentTeamA ? 'A' : 'B',
          row.workDate,
          row.policyDeductionMinutes,
          row.approvedWorkedMinutes,
        ])
        .sort(byKey);
      expect(rows).toEqual(
        [
          ['A', '2027-03-02', 30, 210],
          ['B', '2027-03-02', 0, 180],
          ['A', '2027-03-03', 10, 450],
          ['A', '2027-03-04', 15, 0],
          ['B', '2027-03-04', 10, 0],
        ].sort(byKey),
      );
      // Approved: a later policy change never recalculates it.
      const frozen = await tx.timesheet.findUniqueOrThrow({
        where: { id: sheet.id },
        include: { segments: true },
      });
      await tx.timeAttendancePolicy.updateMany({
        where: { organizationId: fx.orgA, scopeType: 'ORGANIZATION' },
        data: { archivedAt: new Date() },
      });
      await seedTimePolicy(tx, fx.orgA, AUTO(60));
      await svc.time.selfTimesheet(fx.selfUser1, sheet.id);
      expect(
        await tx.timesheet.findUniqueOrThrow({
          where: { id: sheet.id },
          include: { segments: true },
        }),
      ).toEqual(frozen);
      // Payroll reads the stored snapshot. Locking it, and same-day work in another
      // organization, change none of its minutes.
      const payrollFact = () =>
        svc.time.payrollTimesheet(
          { employeeId: fx.employee1, timePeriodId: frozen.timePeriodId },
          tx,
        );
      const payrollBefore = (await payrollFact())!.workDates;
      const orgB = await addOrganizationBAssignment(tx, fx);
      await work(h, orgB.assignmentId, '2027-03-02', '17:00', '23:00');
      await svc.time.lockTimesheet(
        fx.users.managerA!,
        sheet.id,
        ctx(fx.users.managerA!),
      );
      const locked = await tx.timesheet.findUniqueOrThrow({
        where: { id: sheet.id },
        include: { segments: true },
      });
      expect(locked.status).toBe('LOCKED');
      // Locking copies the approved rows; only their finalizationStatus changes.
      const frozenTotals = frozen.totals as {
        payrollWorkDates: Array<Record<string, unknown>>;
      };
      expect(locked.totals).toEqual({
        ...frozenTotals,
        payrollWorkDates: frozenTotals.payrollWorkDates.map((row) => ({
          ...row,
          finalizationStatus: 'LOCKED',
        })),
      });
      expect(locked.segments).toEqual(frozen.segments);
      const strip = (rows: Array<Record<string, unknown>>) =>
        rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([key]) => key !== 'finalizationStatus'),
          ),
        );
      expect(strip((await payrollFact())!.workDates as never)).toEqual(
        strip(payrollBefore as never),
      );
      expect(payrollBefore.length).toBe(5);
    }, AUTO(30));
  });

  it('applies the threshold (new layers default to 360) and deducts per organization separately', async () => {
    await scenario(async (h) => {
      const { fx, tx } = h;
      const orgB = await addOrganizationBAssignment(tx, fx);
      // A new AUTO_DEDUCT layer without a threshold is saved with 360 explicitly.
      await tx.timeAttendancePolicy.updateMany({
        where: { organizationId: fx.orgA, scopeType: 'ORGANIZATION' },
        data: { archivedAt: new Date() },
      });
      const policies = new TimePolicyService(
        rollbackClient(tx),
        h.svc.authorization,
        h.svc.targets,
        h.svc.audit,
      );
      const created = await policies.create(
        fx.users.managerA!,
        {
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
          effectiveFrom: '2027-03-01',
          config: {
            clock: { mode: 'LIVE_CLOCK' },
            breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30 },
          },
        } as never,
        ctx(fx.users.managerA!),
      );
      expect(
        (
          await tx.timeAttendancePolicy.findUniqueOrThrow({
            where: { id: (created as { id: string }).id },
          })
        ).config,
      ).toMatchObject({ breaks: { autoDeductAfterMinutes: 360 } });
      // Organization B deducts by its own policy (no threshold set: 0).
      await tx.timeAttendancePolicy.updateMany({
        where: { organizationId: fx.orgB, scopeType: 'ORGANIZATION' },
        data: { archivedAt: new Date() },
      });
      await seedTimePolicy(tx, fx.orgB, AUTO(15));
      // Mar 2: 5 h in A (under 360: none) and 2 h in B (B deducts 15 on its own).
      await work(h, fx.assignmentTeamA, '2027-03-02', '08:00', '13:00');
      await work(h, orgB.assignmentId, '2027-03-02', '14:00', '16:00');
      // Mar 3: 7 h in A (over 360: 30).
      await work(h, fx.assignmentTeamA, '2027-03-03', '08:00', '15:00');
      const a = await weekSheet(h);
      const b = await weekSheet(h, fx.orgB);
      const deduction = async (sheetId: string) =>
        (
          await tx.timesheetSegment.findMany({
            where: { timesheetId: sheetId },
          })
        ).reduce((sum, segment) => sum + segment.policyDeductionMinutes, 0);
      expect(await deduction(a.id)).toBe(30);
      expect(await deduction(b.id)).toBe(15);
    });
  });

  it('with different amounts, thresholds and eligibility per assignment, deducts once by the deciding assignment’s rules, spills without going negative, and never across organizations', async () => {
    await scenario(async (h) => {
      const { fx, tx } = h;
      const layer = (assignmentId: string, breaks: Record<string, unknown>) =>
        tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'EMPLOYMENT_ASSIGNMENT',
            employmentAssignmentId: assignmentId,
            effectiveFrom: new Date('2026-01-01'),
            config: { breaks } as never,
          },
        });
      // Organization A: 30 minutes from the first minute. Team A: 45 after 6 hours.
      // Dept B: no automatic deduction. A third assignment inherits the organization's rule.
      await layer(fx.assignmentTeamA, {
        mode: 'AUTO_DEDUCT',
        autoDeductMinutes: 45,
        autoDeductAfterMinutes: 360,
      });
      await layer(fx.assignmentDeptB, { mode: 'MANUAL_PUNCH' });
      const extra = (
        await tx.employmentAssignment.create({
          data: {
            employeeId: fx.employee1,
            positionId: fx.positionOrg,
            employmentType: 'PART_TIME',
            status: 'ACTIVE',
            isPrimary: false,
            startDate: new Date('2026-01-01'),
          },
        })
      ).id;
      const orgB = await addOrganizationBAssignment(tx, fx);
      await tx.timeAttendancePolicy.updateMany({
        where: { organizationId: fx.orgB, scopeType: 'ORGANIZATION' },
        data: { archivedAt: new Date() },
      });
      await seedTimePolicy(tx, fx.orgB, AUTO(60));

      // Mar 2: Team A decides (most gross): 45 after 360; the day's 420 gross minutes in
      // Organization A (Dept B's included) reach it. Organization B's 8 hours don't count here.
      await work(h, fx.assignmentTeamA, '2027-03-02', '09:00', '13:00');
      await work(h, extra, '2027-03-02', '13:00', '15:00');
      await work(h, fx.assignmentDeptB, '2027-03-02', '15:00', '16:00');
      await work(h, orgB.assignmentId, '2027-03-02', '17:00', '23:00');
      // Mar 3: the inheriting assignment decides: 30 from the first minute, on itself.
      await work(h, fx.assignmentTeamA, '2027-03-03', '09:00', '10:00');
      await work(h, extra, '2027-03-03', '10:00', '14:00');
      await work(h, fx.assignmentDeptB, '2027-03-03', '14:00', '15:00');
      // Mar 4: Team A decides; 320 gross minutes are under its 360: nothing, even though the
      // other assignment's own rule would have deducted.
      await work(h, fx.assignmentTeamA, '2027-03-04', '09:00', '14:00');
      await work(h, extra, '2027-03-04', '14:00', '14:20');
      // Mar 5: the inheriting assignment decides (25 > 20 gross): 30, of which it can take its
      // 25; the remaining 5 spill to Team A. Nobody goes below zero.
      await work(h, extra, '2027-03-05', '10:00', '10:25');
      await work(h, fx.assignmentTeamA, '2027-03-05', '11:00', '11:20');

      const segments = async (sheetId: string) =>
        Object.fromEntries(
          (
            await tx.timesheetSegment.findMany({
              where: { timesheetId: sheetId },
            })
          ).map((segment) => [
            segment.employmentAssignmentId,
            [
              segment.grossMinutes,
              segment.policyDeductionMinutes,
              segment.netWorkedMinutes,
            ],
          ]),
        );
      expect(await segments((await weekSheet(h)).id)).toEqual({
        [fx.assignmentTeamA]: [240 + 60 + 300 + 20, 45 + 5, 570],
        [extra]: [120 + 240 + 20 + 25, 30 + 25, 350],
        [fx.assignmentDeptB]: [60 + 60, 0, 120],
      });
      expect(await segments((await weekSheet(h, fx.orgB)).id)).toEqual({
        [orgB.assignmentId]: [360, 60, 300],
      });
      // Per entry, too: no payable minutes below zero.
      for (const entry of await tx.timeEntry.findMany({
        where: { employeeId: fx.employee1 },
        include: {
          breaks: true,
          employmentAssignment: {
            include: { position: { include: { organization: true } } },
          },
        },
      })) {
        const minutes = await h.svc.time.workedMinutesForEntry(
          { ...entry, clockOutAt: entry.clockOutAt! } as never,
          rollbackClient(tx),
        );
        expect(minutes.netWorkedMinutes).toBeGreaterThanOrEqual(0);
      }
    }, AUTO(30));
  });

  // ─── D-H: optional sign-out ───────────────────────────────────────────────────────────

  it('lets sign-in-only staff sign out where the policy enables it, never as payable time, with manager corrections', async () => {
    await scenario(async (h) => {
      const { fx, tx, signIns } = h;
      const presence = (config: Record<string, unknown>) =>
        tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'EMPLOYMENT_ASSIGNMENT',
            employmentAssignmentId: fx.orgLevel,
            effectiveFrom: new Date('2026-01-01'),
            config: { attendance: config } as never,
          },
        });
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'America/Toronto' },
      });
      const layer = await presence({ trackingMode: 'SIGN_IN_ONLY' });
      const self = ctx(fx.selfUser2);
      h.clock.value = toronto('2027-03-02T08:55');
      await signIns.selfSignIn(
        fx.selfUser2,
        { employmentAssignmentId: fx.orgLevel },
        self,
      );
      h.clock.value = toronto('2027-03-02T13:00');
      const signOut = () =>
        signIns.selfSignOut(
          fx.selfUser2,
          { employmentAssignmentId: fx.orgLevel },
          self,
        );
      // Off by default.
      expect(body(await rejection(signOut()))).toMatchObject({
        code: 'ATTENDANCE_SIGN_OUT_DISABLED',
      });
      await tx.timeAttendancePolicy.update({
        where: { id: layer.id },
        data: { archivedAt: new Date() },
      });
      const enabled = await presence({
        trackingMode: 'SIGN_IN_ONLY',
        signOutEnabled: true,
      });
      const first = await signOut();
      expect(first).toMatchObject({
        outcome: 'SIGNED_OUT',
        signOut: {
          source: 'LIVE_CLOCK',
          signedOutAt: toronto('2027-03-02T13:00').toISOString(),
        },
      });
      expect(await signOut()).toMatchObject({ outcome: 'ALREADY_SIGNED_OUT' });
      // Never payable: no time entries, no timesheet minutes for the presence assignment.
      expect(
        await tx.timeEntry.count({ where: { employeeId: fx.employee2 } }),
      ).toBe(0);
      // A manager corrects it: void, then record the right time; never their own.
      const manager = fx.users.managerA!;
      await signIns.voidSignOut(
        manager,
        first.signOut.id,
        'Wrong button',
        ctx(manager),
      );
      const signInId = (
        await tx.attendanceSignIn.findFirstOrThrow({
          where: { employeeId: fx.employee2 },
        })
      ).id;
      await signIns.recordManualSignOut(
        manager,
        signInId,
        { signedOutAt: '2027-03-02T12:30', reason: 'Left after the session' },
        ctx(manager),
      );
      expect(
        body(
          await rejection(
            signIns.recordManualSignOut(
              manager,
              signInId,
              { signedOutAt: '2027-03-02T12:45', reason: 'Twice' },
              ctx(manager),
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_ALREADY_SIGNED_OUT' });
      // Batch 4F (D5): the organization is required (as over HTTP) and scopes the query.
      const listed = await signIns.managedSignIns(manager, {
        organizationId: fx.orgA,
        from: '2027-03-02',
        to: '2027-03-02',
      });
      expect(
        (listed as { items: Array<{ signOut: unknown }> }).items[0],
      ).toMatchObject({
        signOut: {
          source: 'MANUAL',
          reason: 'Left after the session',
          signedOutAt: toronto('2027-03-02T12:30').toISOString(),
        },
      });
      expect(
        await tx.auditLog.count({
          where: {
            entityId: signInId,
            action: {
              in: [
                'ATTENDANCE_SIGNED_OUT',
                'ATTENDANCE_SIGN_OUT_VOIDED',
                'ATTENDANCE_SIGN_OUT_RECORDED',
              ],
            },
          },
        }),
      ).toBe(3);
      // KIOSK_ONLY capture: self-service sign-out is refused like self-service sign-in.
      await tx.timeAttendancePolicy.update({
        where: { id: enabled.id },
        data: { archivedAt: new Date() },
      });
      await presence({
        trackingMode: 'SIGN_IN_ONLY',
        signOutEnabled: true,
        captureMode: 'KIOSK_ONLY',
      });
      h.clock.value = toronto('2027-03-03T13:00');
      expect(status(await rejection(signOut()))).toBe(403);
    });
  });

  it('keeps sign-out history append-only: corrections void and add, never rewrite or delete', async () => {
    await scenario(async (h) => {
      const { fx, tx, signIns } = h;
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'America/Toronto' },
      });
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.orgLevel,
          effectiveFrom: new Date('2026-01-01'),
          config: {
            attendance: { trackingMode: 'SIGN_IN_ONLY', signOutEnabled: true },
          } as never,
        },
      });
      h.clock.value = toronto('2027-03-02T08:55');
      const { signIn } = await signIns.selfSignIn(
        fx.selfUser2,
        { employmentAssignmentId: fx.orgLevel },
        ctx(fx.selfUser2),
      );
      h.clock.value = toronto('2027-03-02T13:00');
      const { signOut } = await signIns.selfSignOut(
        fx.selfUser2,
        { employmentAssignmentId: fx.orgLevel },
        ctx(fx.selfUser2),
      );
      const manager = fx.users.managerA!;
      // Never rewritten or deleted, even directly in the database.
      for (const attempt of [
        // Raw SQL, so the trigger's own message is visible.
        () =>
          tx.$executeRaw`UPDATE "AttendanceSignOut" SET "signedOutAt" = "signedOutAt" - interval '1 hour' WHERE "id" = ${signOut.id}::uuid`,
        () =>
          tx.$executeRaw`DELETE FROM "AttendanceSignOut" WHERE "id" = ${signOut.id}::uuid`,
        // A second active sign-out for the same sign-in.
        () =>
          tx.attendanceSignOut.create({
            data: {
              signInId: signIn.id,
              employeeId: fx.employee2,
              employmentAssignmentId: fx.orgLevel,
              signedOutAt: toronto('2027-03-02T12:30'),
              source: 'LIVE_CLOCK',
            },
          }),
        // Before its sign-in.
        () =>
          tx.attendanceSignOut.create({
            data: {
              signInId: signIn.id,
              employeeId: fx.employee2,
              employmentAssignmentId: fx.orgLevel,
              signedOutAt: toronto('2027-03-02T08:00'),
              source: 'MANUAL',
              recordedByUserId: manager,
              reason: 'Backdated',
            },
          }),
      ]) {
        expect(String(await violation(tx, attempt))).toMatch(
          /only be voided, once|never deleted|Unique constraint|after its sign-in/,
        );
      }
      // A correction: void (once), then record the right time; both stay in history.
      await signIns.voidSignOut(
        manager,
        signOut.id,
        'Wrong time',
        ctx(manager),
      );
      expect(
        body(
          await rejection(
            signIns.voidSignOut(manager, signOut.id, 'Again', ctx(manager)),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_SIGN_OUT_VOIDED' });
      expect(
        String(
          await violation(
            tx,
            () =>
              tx.$executeRaw`UPDATE "AttendanceSignOut" SET "status" = 'ACTIVE', "voidedAt" = NULL, "voidedByUserId" = NULL, "voidReason" = NULL WHERE "id" = ${signOut.id}::uuid`,
          ),
        ),
      ).toMatch(/only be voided, once/);
      const corrected = await signIns.recordManualSignOut(
        manager,
        signIn.id,
        { signedOutAt: '2027-03-02T12:15', reason: 'Per front desk log' },
        ctx(manager),
      );
      const history = await tx.attendanceSignOut.findMany({
        where: { signInId: signIn.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        history.map((row) => [row.id, row.status, row.source, row.signedOutAt]),
      ).toEqual([
        [signOut.id, 'VOIDED', 'LIVE_CLOCK', toronto('2027-03-02T13:00')],
        [corrected.id, 'ACTIVE', 'MANUAL', toronto('2027-03-02T12:15')],
      ]);
      expect(history[0]).toMatchObject({
        voidedByUserId: manager,
        voidReason: 'Wrong time',
      });
      // The employee can't correct their own.
      expect(
        status(
          await rejection(
            signIns.voidSignOut(
              fx.selfUser2,
              corrected.id,
              'Mine',
              ctx(fx.selfUser2),
            ),
          ),
        ),
      ).toBe(403);
    });
  });

  it('replays a sign-in only for its own operation: a key reused for another assignment or another occurrence is a 409', async () => {
    await scenario(async (h) => {
      const { fx, tx, signIns } = h;
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'America/Toronto' },
      });
      // Employee 2's two assignments, and Employee 1's Team A, track presence.
      for (const assignmentId of [
        fx.orgLevel,
        fx.otherTeamA,
        fx.assignmentTeamA,
      ]) {
        await tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'EMPLOYMENT_ASSIGNMENT',
            employmentAssignmentId: assignmentId,
            effectiveFrom: new Date('2026-01-01'),
            config: {
              attendance: {
                trackingMode: 'SIGN_IN_ONLY',
                captureMode: 'KIOSK_OR_SELF_SERVICE',
              },
            } as never,
          },
        });
      }
      const device = await tx.attendanceDevice.create({
        data: {
          organizationId: fx.orgA,
          physicalSiteId: fx.physicalSiteToronto,
          name: `4D sign-in kiosk ${fx.suffix}`,
          credentialHash: `4d-in-${fx.suffix}`,
          credentialIssuedAt: new Date(),
        },
      });
      const kiosk = {
        id: device.id,
        organizationId: fx.orgA,
        physicalSiteId: fx.physicalSiteToronto,
      };
      const selfIn = (
        user: string,
        assignmentId: string,
        idempotencyKey: string,
      ) =>
        signIns.selfSignIn(
          user,
          { employmentAssignmentId: assignmentId, idempotencyKey },
          ctx(user),
        );
      const reused = async (operation: Promise<unknown>) => {
        const error = await rejection(operation);
        expect(status(error)).toBe(409);
        expect(body(error)).toMatchObject({
          code: 'ATTENDANCE_IDEMPOTENCY_KEY_REUSED',
        });
      };
      const signInsOf = (employeeId: string) =>
        tx.attendanceSignIn.findMany({
          where: { employeeId },
          orderBy: { signedInAt: 'asc' },
        });

      // Unscheduled: a retry (either channel) replays the original sign-in.
      h.clock.value = toronto('2027-03-02T08:55');
      const first = await selfIn(fx.selfUser2, fx.orgLevel, 'in-0001');
      expect(first.outcome).toBe('SIGNED_IN');
      h.clock.value = toronto('2027-03-02T08:56');
      expect(await selfIn(fx.selfUser2, fx.orgLevel, 'in-0001')).toEqual({
        outcome: 'ALREADY_SIGNED_IN',
        signIn: first.signIn,
        exceptions: [],
      });
      expect(
        await signIns.kioskSignIn(
          kiosk,
          fx.employee2,
          fx.orgLevel,
          'in-0001',
          {},
        ),
      ).toMatchObject({ outcome: 'ALREADY_SIGNED_IN', signIn: first.signIn });
      // Another assignment: 409 from either channel, and nothing recorded for it.
      await reused(selfIn(fx.selfUser2, fx.otherTeamA, 'in-0001'));
      await reused(
        signIns.kioskSignIn(kiosk, fx.employee2, fx.otherTeamA, 'in-0001', {}),
      );
      expect(await signInsOf(fx.employee2)).toHaveLength(1);
      expect(
        (await selfIn(fx.selfUser2, fx.otherTeamA, 'in-0002')).outcome,
      ).toBe('SIGNED_IN');
      // The next day is another occurrence: 409; a new key signs in.
      h.clock.value = toronto('2027-03-03T08:55');
      await reused(selfIn(fx.selfUser2, fx.orgLevel, 'in-0001'));
      expect((await selfIn(fx.selfUser2, fx.orgLevel, 'in-0003')).outcome).toBe(
        'SIGNED_IN',
      );
      expect(await signInsOf(fx.employee2)).toHaveLength(3);

      // Scheduled: Employee 1's Team A has two published shifts on Mar 4.
      const noonShift = await publishedShift(
        h,
        '2027-03-04T13:00',
        '2027-03-04T13:30',
      );
      const afternoonShift = await publishedShift(
        h,
        '2027-03-04T16:30',
        '2027-03-04T17:00',
      );
      // Unscheduled in the morning, then the same key once a shift is open: another occurrence.
      h.clock.value = toronto('2027-03-04T08:00');
      const morning = await selfIn(
        fx.selfUser1,
        fx.assignmentTeamA,
        'shift-0001',
      );
      expect(morning.signIn.scheduledShiftId).toBeNull();
      h.clock.value = toronto('2027-03-04T12:58');
      await reused(selfIn(fx.selfUser1, fx.assignmentTeamA, 'shift-0001'));
      const noon = await selfIn(fx.selfUser1, fx.assignmentTeamA, 'shift-0002');
      expect(noon.signIn.scheduledShiftId).toBe(noonShift.id);
      // A retry inside the shift's window replays it. The morning key is history now (a later
      // sign-in of the assignment exists), even on its own day.
      h.clock.value = toronto('2027-03-04T13:10');
      await reused(selfIn(fx.selfUser1, fx.assignmentTeamA, 'shift-0001'));
      expect(
        await signIns.kioskSignIn(
          kiosk,
          fx.employee1,
          fx.assignmentTeamA,
          'shift-0002',
          {},
        ),
      ).toMatchObject({ outcome: 'ALREADY_SIGNED_IN', signIn: noon.signIn });
      // The same key for the afternoon shift: 409, never the noon sign-in; the shift stays open.
      h.clock.value = toronto('2027-03-04T16:29');
      await reused(selfIn(fx.selfUser1, fx.assignmentTeamA, 'shift-0002'));
      expect(
        await tx.attendanceSignIn.count({
          where: { scheduledShiftId: afternoonShift.id },
        }),
      ).toBe(0);
      const afternoon = await selfIn(
        fx.selfUser1,
        fx.assignmentTeamA,
        'shift-0003',
      );
      expect(afternoon.signIn.scheduledShiftId).toBe(afternoonShift.id);
    });
  });

  it('replays a sign-out only for its own operation: a key reused for another assignment or a later sign-in is a 409', async () => {
    await scenario(async (h) => {
      const { fx, tx, signIns } = h;
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'America/Toronto' },
      });
      // Both of Employee 2's assignments track presence and allow sign-out.
      for (const assignmentId of [fx.orgLevel, fx.otherTeamA]) {
        await tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'EMPLOYMENT_ASSIGNMENT',
            employmentAssignmentId: assignmentId,
            effectiveFrom: new Date('2026-01-01'),
            config: {
              attendance: {
                trackingMode: 'SIGN_IN_ONLY',
                signOutEnabled: true,
                captureMode: 'KIOSK_OR_SELF_SERVICE',
              },
            } as never,
          },
        });
      }
      const device = await tx.attendanceDevice.create({
        data: {
          organizationId: fx.orgA,
          physicalSiteId: fx.physicalSiteToronto,
          name: `4D kiosk ${fx.suffix}`,
          credentialHash: `4d-${fx.suffix}`,
          credentialIssuedAt: new Date(),
        },
      });
      const kiosk = {
        id: device.id,
        organizationId: fx.orgA,
        physicalSiteId: fx.physicalSiteToronto,
      };
      const self = ctx(fx.selfUser2);
      const signIn = (assignmentId: string) =>
        signIns.selfSignIn(
          fx.selfUser2,
          { employmentAssignmentId: assignmentId },
          self,
        );
      const signOut = (assignmentId: string, idempotencyKey: string) =>
        signIns.selfSignOut(
          fx.selfUser2,
          { employmentAssignmentId: assignmentId, idempotencyKey },
          self,
        );
      const signOutRows = () =>
        tx.attendanceSignOut.findMany({
          where: { employeeId: fx.employee2 },
          orderBy: { createdAt: 'asc' },
        });

      h.clock.value = toronto('2027-03-02T08:55');
      await signIn(fx.orgLevel);
      await signIn(fx.otherTeamA);
      h.clock.value = toronto('2027-03-02T13:00');
      const first = await signOut(fx.orgLevel, 'key-0001');
      expect(first.outcome).toBe('SIGNED_OUT');
      // A retry of the same operation, from either channel, replays it.
      h.clock.value = toronto('2027-03-02T13:01');
      expect(await signOut(fx.orgLevel, 'key-0001')).toEqual({
        outcome: 'ALREADY_SIGNED_OUT',
        signOut: first.signOut,
      });
      expect(
        await signIns.kioskSignOut(
          kiosk,
          fx.employee2,
          fx.orgLevel,
          'key-0001',
          {},
        ),
      ).toEqual({ outcome: 'ALREADY_SIGNED_OUT', signOut: first.signOut });
      // The same key for the other assignment: 409, and that assignment stays signed in.
      const crossAssignment = await rejection(
        signOut(fx.otherTeamA, 'key-0001'),
      );
      expect(status(crossAssignment)).toBe(409);
      expect(body(crossAssignment)).toMatchObject({
        code: 'ATTENDANCE_IDEMPOTENCY_KEY_REUSED',
      });
      expect(
        body(
          await rejection(
            signIns.kioskSignOut(
              kiosk,
              fx.employee2,
              fx.otherTeamA,
              'key-0001',
              {},
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_IDEMPOTENCY_KEY_REUSED' });
      expect(await signOutRows()).toHaveLength(1);
      expect(await signOut(fx.otherTeamA, 'key-0002')).toMatchObject({
        outcome: 'SIGNED_OUT',
      });
      // The next day's sign-in is another operation: the old key is refused, a new one works.
      h.clock.value = toronto('2027-03-03T08:55');
      await signIn(fx.orgLevel);
      h.clock.value = toronto('2027-03-03T13:00');
      expect(
        body(await rejection(signOut(fx.orgLevel, 'key-0001'))),
      ).toMatchObject({ code: 'ATTENDANCE_IDEMPOTENCY_KEY_REUSED' });
      expect(await signOutRows()).toHaveLength(2);
      const second = await signOut(fx.orgLevel, 'key-0003');
      expect(second.outcome).toBe('SIGNED_OUT');
      expect(second.signOut.id).not.toBe(first.signOut.id);
      expect(
        (await signOutRows()).map((row) => [
          row.employmentAssignmentId,
          row.idempotencyKey,
        ]),
      ).toEqual([
        [fx.orgLevel, 'key-0001'],
        [fx.otherTeamA, 'key-0002'],
        [fx.orgLevel, 'key-0003'],
      ]);
    });
  });
});
