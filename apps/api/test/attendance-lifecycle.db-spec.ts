import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { runPrepareAttendancePeriodsJob } from '../src/time/time-jobs.js';
import { TimePolicyService } from '../src/time/time-policy.service.js';
import {
  FixedPayrollClock,
  PAYROLL_PERMISSION_KEYS,
  payGroup,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
  grantMinutes,
  LEAVE_PERMISSIONS,
  LEAVE_USERS,
  leaveServices,
  seedLeaveConfig,
} from './support/leave-fixtures.js';
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
  /** Employee 1's own account: clocks in both organizations, and approves time in A. */
  self1: [
    { permissions: TIME_PERMISSIONS, scope: 'org' as const },
    { permissions: ['time.clock'], scope: 'orgB' as const },
  ],
  managerA: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
  managerB: [{ permissions: TIME_PERMISSIONS, scope: 'orgB' as const }],
  managerTeamA: [{ permissions: TIME_PERMISSIONS, scope: 'teamA' as const }],
  /** Reads time in A, may not manage timesheets. */
  viewerA: [{ permissions: ['time.view'], scope: 'org' as const }],
  outsider: [{ permissions: ['schedule.read'], scope: 'org' as const }],
  payrollB: [{ permissions: PAYROLL_PERMISSION_KEYS, scope: 'orgB' as const }],
  /** Leave: Employee 2 requests their own; HR approves. */
  self2: LEAVE_USERS.self2,
  hr: LEAVE_USERS.hr,
};

/** Organization A's policy: live clock, and no-show detection after 15 minutes. */
const POLICY = {
  ...LIVE_TIME_POLICY,
  noShow: { enabled: true, graceMinutes: 15 },
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  svc: ReturnType<typeof timeServices>;
  orgB: { assignmentId: string };
}

const body = (error: unknown) =>
  (error as { getResponse?: () => Record<string, unknown> }).getResponse?.() ??
  {};
const status = (error: unknown) =>
  (error as { getStatus?: () => number }).getStatus?.();

/**
 * Batch 4C — the attendance-only lifecycle (periods and timesheets without payroll), exception
 * review and no-show detection. Organization A here has no pay group, payroll calendar or
 * compensation: Time & attendance runs on its own.
 */
describe('Attendance-only lifecycle (Batch 4C, database)', () => {
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
          const fx = await createSchedulingFixtures(tx, USERS, [
            ...TIME_PERMISSIONS,
            ...LEAVE_PERMISSIONS,
          ]);
          await seedTimePolicy(tx, fx.orgA, POLICY);
          const orgB = await addOrganizationBAssignment(tx, fx);
          const clock = new FixedClock();
          const svc = timeServices(rollbackClient(tx), clock, {
            absences: true,
          });
          await run({ tx, fx, clock, svc, orgB }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const generate = (
    h: Harness,
    organizationId: string,
    startDate: string,
    cadence: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY',
    count = 1,
    actor = h.fx.users.managerA!,
  ) =>
    h.svc.time.generateTimePeriods(
      actor,
      { organizationId, startDate, cadence, count },
      ctx(actor),
    );

  // ─── 1. Periods ─────────────────────────────────────────────────────────────────────────

  it('generates periods without payroll, refuses overlaps and lists them with filters, paging and authorization', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx } = h;
      // No payroll anywhere in Organization A.
      expect(
        await tx.payGroup.count({ where: { organizationId: fx.orgA } }),
      ).toBe(0);
      const weeks = await generate(h, fx.orgA, '2027-03-01', 'WEEKLY', 3);
      expect(
        weeks.periods.map((period) => [period.startDate, period.endDate]),
      ).toEqual([
        ['2027-03-01', '2027-03-07'],
        ['2027-03-08', '2027-03-14'],
        ['2027-03-15', '2027-03-21'],
      ]);
      // The same request again reuses them (no duplicates).
      await generate(h, fx.orgA, '2027-03-01', 'WEEKLY', 3);
      expect(
        await tx.timePeriod.count({ where: { organizationId: fx.orgA } }),
      ).toBe(3);

      // A period sharing any date with a different one is refused, and nothing is created.
      const overlap = await rejection(
        generate(h, fx.orgA, '2027-03-22', 'BIWEEKLY', 1).then(() =>
          generate(h, fx.orgA, '2027-03-29', 'WEEKLY', 1),
        ),
      );
      expect(status(overlap)).toBe(409);
      expect(body(overlap)).toMatchObject({
        code: 'TIME_PERIOD_OVERLAP',
        conflictingPeriod: { startDate: '2027-03-22', endDate: '2027-04-04' },
      });
      const partial = await rejection(
        generate(h, fx.orgA, '2027-04-05', 'WEEKLY', 3).then(() =>
          generate(h, fx.orgA, '2027-04-19', 'BIWEEKLY', 2),
        ),
      );
      expect(body(partial)).toMatchObject({ code: 'TIME_PERIOD_OVERLAP' });
      // The refused request created nothing (one transaction).
      expect(
        await tx.timePeriod.count({
          where: { organizationId: fx.orgA, startDate: new Date('2027-05-03') },
        }),
      ).toBe(0);
      // A monthly period starts on day 1–28.
      expect(
        body(await rejection(generate(h, fx.orgA, '2027-05-29', 'MONTHLY'))),
      ).toMatchObject({ code: 'TIME_PERIOD_START_INVALID' });
      // Another organization's periods are independent.
      await generate(
        h,
        fx.orgB,
        '2027-03-01',
        'BIWEEKLY',
        1,
        fx.users.managerB!,
      );

      // Listing: newest first, filtered, paged; each reader sees their organizations only.
      const list = (userId: string, query: Record<string, unknown> = {}) =>
        svc.time.listTimePeriods(userId, query);
      const ofA = await list(fx.users.managerA!, { limit: 100 });
      expect(
        ofA.items.every((period) => period.organizationId === fx.orgA),
      ).toBe(true);
      expect(ofA.items.map((period) => period.startDate)).toEqual([
        '2027-04-19',
        '2027-04-12',
        '2027-04-05',
        '2027-03-22',
        '2027-03-15',
        '2027-03-08',
        '2027-03-01',
      ]);
      expect(ofA.items[0]).toMatchObject({
        payrollManaged: false,
        timesheetCount: 0,
        status: 'OPEN',
      });
      expect(
        (
          await list(fx.users.managerA!, {
            from: '2027-03-10',
            to: '2027-03-20',
          })
        ).items.map((period) => period.startDate),
      ).toEqual(['2027-03-15', '2027-03-08']);
      const seen: string[] = [];
      let afterId: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = await list(fx.users.viewerA!, {
          limit: 2,
          ...(afterId ? { afterId } : {}),
        });
        seen.push(...result.items.map((period) => period.startDate!));
        if (!result.nextAfterId) break;
        afterId = result.nextAfterId;
      }
      expect(seen).toEqual(ofA.items.map((period) => period.startDate));
      expect((await list(fx.users.managerB!, { limit: 100 })).items).toEqual([
        expect.objectContaining({ organizationId: fx.orgB }),
      ]);
      expect(
        (await list(fx.users.managerB!, { organizationId: fx.orgA })).items,
      ).toEqual([]);
      expect((await list(fx.users.outsider!)).items).toEqual([]);
    });
  });

  // ─── 2. Materialization ─────────────────────────────────────────────────────────────────

  it('materializes timesheets for the period’s organization only, idempotently, never changing approved ones', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx, orgB } = h;
      const manager = fx.users.managerA!;
      // Employee 1: Team A and Dept B (multi-assignment), and Organization B. Employee 2: Team A.
      for (const [employeeId, assignmentId, day] of [
        [fx.employee1, fx.assignmentTeamA, '2027-03-02'],
        [fx.employee1, fx.assignmentDeptB, '2027-03-03'],
        [fx.employee1, orgB.assignmentId, '2027-03-04'],
        [fx.employee2, fx.otherTeamA, '2027-03-02'],
      ] as const) {
        await closedEntry(tx, {
          employeeId,
          employmentAssignmentId: assignmentId,
          clockInAt: toronto(`${day}T09:00`),
          clockOutAt: toronto(`${day}T12:00`),
          workDate: day,
        });
      }
      const [period] = (await generate(h, fx.orgA, '2027-03-01', 'WEEKLY'))
        .periods;
      const first = await svc.time.materializeTimesheets(
        manager,
        period!.id,
        ctx(manager),
      );
      expect(first).toMatchObject({ created: 2, existing: 0, finalized: 0 });
      const sheets = await tx.timesheet.findMany({
        where: { timePeriodId: period!.id },
        include: { segments: true },
        orderBy: { employeeId: 'asc' },
      });
      expect(sheets.map((sheet) => sheet.employeeId).sort()).toEqual(
        [fx.employee1, fx.employee2].sort(),
      );
      // Organization A's sheet of Employee 1 holds both A assignments, never B's.
      const mine = sheets.find((sheet) => sheet.employeeId === fx.employee1)!;
      expect(
        mine.segments.map((segment) => segment.employmentAssignmentId).sort(),
      ).toEqual([fx.assignmentDeptB, fx.assignmentTeamA].sort());
      expect(
        await tx.auditLog.count({
          where: {
            action: 'TIME_TIMESHEETS_MATERIALIZED',
            entityId: period!.id,
          },
        }),
      ).toBe(1);

      // Approve Employee 2's timesheet; later materializations never change it.
      h.clock.value = toronto('2027-03-08T09:00');
      const theirs = sheets.find((sheet) => sheet.employeeId === fx.employee2)!;
      await svc.time.submitTimesheetOnBehalf(
        manager,
        theirs.id,
        'Away this week',
        ctx(manager),
      );
      for (const segment of theirs.segments) {
        await svc.time.approveTimesheetSegment(
          manager,
          segment.id,
          undefined,
          ctx(manager),
        );
      }
      const approved = await tx.timesheet.findUniqueOrThrow({
        where: { id: theirs.id },
        include: { segments: true },
      });
      expect(approved.status).toBe('APPROVED');
      // More time on the approved week, then materialize again: nothing new, nothing changed.
      await closedEntry(tx, {
        employeeId: fx.employee2,
        employmentAssignmentId: fx.otherTeamA,
        clockInAt: toronto('2027-03-05T09:00'),
        clockOutAt: toronto('2027-03-05T11:00'),
        workDate: '2027-03-05',
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          await svc.time.materializeTimesheets(
            manager,
            period!.id,
            ctx(manager),
          ),
        ).toMatchObject({ created: 0, existing: 2, finalized: 1 });
      }
      expect(
        await tx.timesheet.findUniqueOrThrow({
          where: { id: theirs.id },
          include: { segments: true },
        }),
      ).toEqual(approved);
      expect(
        await tx.timesheet.count({ where: { timePeriodId: period!.id } }),
      ).toBe(2);

      // Authorization: viewers and other organizations can't; unknown periods are 404.
      expect(
        status(
          await rejection(
            svc.time.materializeTimesheets(
              fx.users.viewerA!,
              period!.id,
              ctx(fx.users.viewerA!),
            ),
          ),
        ),
      ).toBe(403);
      expect(
        status(
          await rejection(
            svc.time.materializeTimesheets(
              fx.users.managerB!,
              period!.id,
              ctx(fx.users.managerB!),
            ),
          ),
        ),
      ).toBe(404);
    });
  });

  // ─── 3. Exception review ────────────────────────────────────────────────────────────────

  it('resolves and dismisses exceptions with a note, reviewer and audit, idempotently, within permissions; punches never change', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx } = h;
      const manager = fx.users.managerA!;
      const entry = await closedEntry(tx, {
        employeeId: fx.employee2,
        employmentAssignmentId: fx.orgLevel,
        clockInAt: toronto('2027-03-02T09:20'),
        clockOutAt: toronto('2027-03-02T17:00'),
        workDate: '2027-03-02',
      });
      const raise = (type: 'LATE_ARRIVAL' | 'EARLY_DEPARTURE') =>
        tx.attendanceException.create({
          data: {
            employeeId: fx.employee2,
            employmentAssignmentId: fx.orgLevel,
            timeEntryId: entry.id,
            type,
            severity: 'REVIEW',
            workflowImpact: 'NON_BLOCKING',
          },
        });
      const late = await raise('LATE_ARRIVAL');
      const early = await raise('EARLY_DEPARTURE');
      const entryBefore = await tx.timeEntry.findUniqueOrThrow({
        where: { id: entry.id },
        include: { punches: true, breaks: true },
      });

      // A note is required.
      expect(
        body(
          await rejection(
            svc.time.reviewException(
              manager,
              late.id,
              'RESOLVE',
              '  ',
              ctx(manager),
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIME_EXCEPTION_NOTE_REQUIRED' });
      // Another organization's manager: 404. A Team A manager (not this position): 403.
      expect(
        status(
          await rejection(
            svc.time.reviewException(
              fx.users.managerB!,
              late.id,
              'RESOLVE',
              'Traffic',
              ctx(fx.users.managerB!),
            ),
          ),
        ),
      ).toBe(404);
      expect(
        status(
          await rejection(
            svc.time.reviewException(
              fx.users.managerTeamA!,
              late.id,
              'RESOLVE',
              'Traffic',
              ctx(fx.users.managerTeamA!),
            ),
          ),
        ),
      ).toBe(403);

      const resolved = await svc.time.reviewException(
        manager,
        late.id,
        'RESOLVE',
        'Discussed: transit delay',
        ctx(manager),
      );
      expect(resolved).toMatchObject({
        id: late.id,
        status: 'RESOLVED',
        resolutionMethod: 'MANAGER_RESOLUTION',
        resolvedByUserId: manager,
        resolutionNote: 'Discussed: transit delay',
        employeeName: expect.any(String),
      });
      // Repeating the same action returns it unchanged (one audit); the other action is 409.
      expect(
        await svc.time.reviewException(
          manager,
          late.id,
          'RESOLVE',
          'Again',
          ctx(manager),
        ),
      ).toMatchObject({
        status: 'RESOLVED',
        resolutionNote: 'Discussed: transit delay',
      });
      expect(
        body(
          await rejection(
            svc.time.reviewException(
              manager,
              late.id,
              'DISMISS',
              'No',
              ctx(manager),
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIME_EXCEPTION_NOT_OPEN', status: 'RESOLVED' });
      await svc.time.reviewException(
        manager,
        early.id,
        'DISMISS',
        'Left with approval',
        ctx(manager),
      );
      expect(
        await tx.auditLog.findMany({
          where: { entityId: { in: [late.id, early.id] } },
          select: { action: true, actorUserId: true, metadata: true },
          orderBy: { occurredAt: 'asc' },
        }),
      ).toEqual([
        {
          action: 'TIME_EXCEPTION_RESOLVED',
          actorUserId: manager,
          metadata: expect.objectContaining({
            type: 'LATE_ARRIVAL',
            withNote: true,
          }),
        },
        {
          action: 'TIME_EXCEPTION_DISMISSED',
          actorUserId: manager,
          metadata: expect.objectContaining({ type: 'EARLY_DEPARTURE' }),
        },
      ]);
      // Reviews never touch the entry, its punches or breaks.
      expect(
        await tx.timeEntry.findUniqueOrThrow({
          where: { id: entry.id },
          include: { punches: true, breaks: true },
        }),
      ).toEqual(entryBefore);
      // Both stay listed (traceable), with their reviews.
      const listed = (
        await svc.time.managementExceptions(manager, { limit: 100 })
      ).items as Array<{
        id: string;
        status: string;
        resolvedByUserId: string;
      }>;
      expect(
        listed
          .filter((item) => [late.id, early.id].includes(item.id))
          .map((item) => [item.status, item.resolvedByUserId])
          .sort(),
      ).toEqual([
        ['DISMISSED', manager],
        ['RESOLVED', manager],
      ]);

      // An exception the system already resolved is a conflict, never a silent success.
      const auto = await tx.attendanceException.create({
        data: {
          employeeId: fx.employee2,
          employmentAssignmentId: fx.orgLevel,
          timeEntryId: entry.id,
          type: 'LONG_SHIFT',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
          status: 'RESOLVED',
          resolutionMethod: 'SYSTEM_AUTO_RESOLUTION',
          resolvedAt: toronto('2027-03-02T18:00'),
        },
      });
      expect(
        body(
          await rejection(
            svc.time.reviewException(
              manager,
              auto.id,
              'RESOLVE',
              'Ok',
              ctx(manager),
            ),
          ),
        ),
      ).toMatchObject({
        code: 'TIME_EXCEPTION_NOT_OPEN',
        status: 'RESOLVED',
        resolutionMethod: 'SYSTEM_AUTO_RESOLUTION',
      });

      // Never on one's own time; a blocking missed clock-out can't be reviewed while open.
      const own = await tx.attendanceException.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          timeEntryId: (
            await closedEntry(tx, {
              employeeId: fx.employee1,
              employmentAssignmentId: fx.assignmentTeamA,
              clockInAt: toronto('2027-03-03T09:20'),
              clockOutAt: toronto('2027-03-03T17:00'),
              workDate: '2027-03-03',
            })
          ).id,
          type: 'LATE_ARRIVAL',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
        },
      });
      expect(
        body(
          await rejection(
            svc.time.reviewException(
              fx.selfUser1,
              own.id,
              'DISMISS',
              'Mine',
              ctx(fx.selfUser1),
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIME_SELF_TARGET_FORBIDDEN' });
      const open = await tx.timeEntry.create({
        data: {
          employeeId: fx.employee2,
          employmentAssignmentId: fx.orgLevel,
          clockInAt: toronto('2027-03-04T09:00'),
          timezone: 'America/Toronto',
          workDate: new Date('2027-03-04'),
          status: 'OPEN',
          source: 'MANUAL',
        },
      });
      const missing = await tx.attendanceException.create({
        data: {
          employeeId: fx.employee2,
          employmentAssignmentId: fx.orgLevel,
          timeEntryId: open.id,
          type: 'MISSING_CLOCK_OUT',
          severity: 'ACTION_REQUIRED',
          workflowImpact: 'SUBMISSION_BLOCKING',
        },
      });
      expect(
        body(
          await rejection(
            svc.time.reviewException(
              manager,
              missing.id,
              'DISMISS',
              'Forgot',
              ctx(manager),
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIME_EXCEPTION_CONDITION_PRESENT' });
    });
  });

  // ─── 4. No-show detection ───────────────────────────────────────────────────────────────

  /** A PUBLISHED schedule with one ACTIVE shift (and its baseline revision). */
  async function publishedShift(
    h: Harness,
    assignmentId: string,
    start: string,
    end: string,
    organizationId = h.fx.orgA,
  ) {
    const workDate = start.slice(0, 10);
    const schedule = await h.tx.schedule.create({
      data: {
        scopeType: 'ORGANIZATION',
        organizationId,
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
        employmentAssignmentId: assignmentId,
        workDate: new Date(workDate),
        startsAt: toronto(start),
        endsAt: toronto(end),
        timezone: 'America/Toronto',
      },
    });
    const revision = await h.tx.scheduledShiftRevision.create({
      data: {
        scheduledShiftId: shift.id,
        revisionNumber: 1,
        revisionType: 'PUBLISHED_BASELINE',
        employmentAssignmentId: assignmentId,
        workDate: new Date(workDate),
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        timezone: 'America/Toronto',
        status: 'ACTIVE',
        sourceType: 'MANUAL',
        changedByUserId: h.fx.users.managerA!,
      },
    });
    return { schedule, shift, revision };
  }

  const noShows = (h: Harness) =>
    h.tx.attendanceException.findMany({
      where: {
        type: 'NO_SHOW',
        employee: { id: { in: [h.fx.employee1, h.fx.employee2] } },
      },
      select: {
        scheduledShiftId: true,
        scheduledShiftRevisionId: true,
        status: true,
        workflowImpact: true,
        severity: true,
      },
      orderBy: { detectedAt: 'asc' },
    });

  it('raises one non-blocking NO_SHOW per published shift revision after the grace period, and never creates time', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx, clock } = h;
      const { shift, revision } = await publishedShift(
        h,
        fx.assignmentTeamA,
        '2027-03-02T09:00',
        '2027-03-02T17:00',
      );
      // Overnight (22:00–06:00) for Employee 2.
      const night = await publishedShift(
        h,
        fx.otherTeamA,
        '2027-03-02T22:00',
        '2027-03-03T06:00',
      );
      // Within the grace period: nothing.
      clock.value = toronto('2027-03-02T09:10');
      expect(await svc.time.detectNoShows()).toMatchObject({ detected: 0 });
      // After it: one, non-blocking, for review.
      clock.value = toronto('2027-03-02T09:20');
      expect(await svc.time.detectNoShows()).toMatchObject({ detected: 1 });
      expect(await noShows(h)).toEqual([
        {
          scheduledShiftId: shift.id,
          scheduledShiftRevisionId: revision.id,
          status: 'OPEN',
          workflowImpact: 'NON_BLOCKING',
          severity: 'REVIEW',
        },
      ]);
      // Retries add nothing.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(await svc.time.detectNoShows()).toMatchObject({ detected: 0 });
      }
      // The overnight shift, after midnight Toronto time.
      clock.value = toronto('2027-03-03T00:30');
      expect(await svc.time.detectNoShows()).toMatchObject({ detected: 1 });
      expect((await noShows(h)).map((row) => row.scheduledShiftId)).toEqual([
        shift.id,
        night.shift.id,
      ]);
      // A dismissed no-show is not raised again.
      const exception = await tx.attendanceException.findFirstOrThrow({
        where: { scheduledShiftId: night.shift.id },
      });
      await svc.time.reviewException(
        fx.users.managerA!,
        exception.id,
        'DISMISS',
        'Swapped informally with a coworker',
        ctx(fx.users.managerA!),
      );
      expect(await svc.time.detectNoShows()).toMatchObject({ detected: 0 });
      // Detection never creates entries, punches or timesheets.
      expect(
        await tx.timeEntry.count({
          where: { employeeId: { in: [fx.employee1, fx.employee2] } },
        }),
      ).toBe(0);
      expect(
        await tx.timesheet.count({
          where: { employeeId: { in: [fx.employee1, fx.employee2] } },
        }),
      ).toBe(0);
      expect(
        await tx.auditLog.count({
          where: { action: 'TIME_NO_SHOW_DETECTED', entityId: exception.id },
        }),
      ).toBe(1);
    });
  });

  it('never raises a no-show for attended, covered, on-leave, cancelled, unpublished, signed-in or opted-out shifts, and supersedes stale ones', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx, clock, orgB } = h;
      // Attended: a clock-in 10 minutes late overlaps the shift.
      await publishedShift(
        h,
        fx.assignmentTeamA,
        '2027-03-02T09:00',
        '2027-03-02T17:00',
      );
      await closedEntry(tx, {
        employeeId: fx.employee1,
        employmentAssignmentId: fx.assignmentTeamA,
        clockInAt: toronto('2027-03-02T09:10'),
        clockOutAt: toronto('2027-03-02T17:00'),
        workDate: '2027-03-02',
      });
      // Covered: Employee 1 clocked into Team A, covering Dept B at the same time.
      await publishedShift(
        h,
        fx.assignmentDeptB,
        '2027-03-02T09:00',
        '2027-03-02T12:00',
      );
      const covering = await tx.timeEntry.findFirstOrThrow({
        where: { employmentAssignmentId: fx.assignmentTeamA },
      });
      await tx.timeEntryAssignmentCoverage.create({
        data: {
          timeEntryId: covering.id,
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentDeptB,
        },
      });
      // Cancelled shift, and a shift in a DRAFT schedule.
      const cancelled = await publishedShift(
        h,
        fx.otherTeamA,
        '2027-03-02T09:00',
        '2027-03-02T17:00',
      );
      await tx.scheduledShift.update({
        where: { id: cancelled.shift.id },
        data: { status: 'CANCELLED' },
      });
      const draft = await publishedShift(
        h,
        fx.orgLevel,
        '2027-03-02T09:00',
        '2027-03-02T17:00',
      );
      await tx.schedule.update({
        where: { id: draft.schedule.id },
        data: { status: 'DRAFT', publishedAt: null, publishedByUserId: null },
      });
      // Organization B never enabled no-show detection.
      await publishedShift(
        h,
        orgB.assignmentId,
        '2027-03-02T09:00',
        '2027-03-02T17:00',
        fx.orgB,
      );
      clock.value = toronto('2027-03-02T18:00');
      expect(await svc.time.detectNoShows()).toMatchObject({ detected: 0 });

      // Sign-in-only attendance (Batch 4F, D7: presence no-shows exist now): a sign-in on the
      // shift's work date is attendance, so no no-show.
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.orgLevel,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          config: { attendance: { trackingMode: 'SIGN_IN_ONLY' } },
        },
      });
      await publishedShift(
        h,
        fx.orgLevel,
        '2027-03-03T09:00',
        '2027-03-03T17:00',
      );
      await tx.attendanceSignIn.create({
        data: {
          employeeId: fx.employee2,
          employmentAssignmentId: fx.orgLevel,
          signedInAt: toronto('2027-03-03T09:20'),
          timezone: 'America/Toronto',
          workDate: new Date('2027-03-03T00:00:00.000Z'),
          source: 'MANUAL',
          recordedByUserId: fx.users.managerA!,
          reason: 'Signed in on paper',
        },
      });
      // Approved leave on Employee 2's Team A shift.
      const leave = leaveServices(rollbackClient(tx));
      const types = await seedLeaveConfig(tx, fx, leave);
      await grantMinutes(leave, fx, fx.otherTeamA, types.vacation.id, 4800);
      await publishedShift(
        h,
        fx.otherTeamA,
        '2027-03-04T09:00',
        '2027-03-04T17:00',
      );
      const vacation = await leave.requests.submitOwn(
        fx.selfUser2,
        {
          employmentAssignmentId: fx.otherTeamA,
          leaveTypeId: types.vacation.id,
          startDate: '2027-03-04',
          endDate: '2027-03-04',
        },
        ctx(fx.selfUser2),
      );
      await leave.requests.approve(
        fx.users.hr!,
        vacation.requestId,
        {},
        ctx(fx.users.hr!),
      );
      clock.value = toronto('2027-03-04T18:00');
      expect(await svc.time.detectNoShows({ lookbackHours: 72 })).toMatchObject(
        {
          detected: 0,
        },
      );
      expect(await noShows(h)).toEqual([]);

      // Supersede: a no-show whose shift is then cancelled, or then attended.
      const later = await publishedShift(
        h,
        fx.assignmentTeamA,
        '2027-03-05T09:00',
        '2027-03-05T17:00',
      );
      const moved = await publishedShift(
        h,
        fx.otherTeamA,
        '2027-03-05T09:00',
        '2027-03-05T17:00',
      );
      clock.value = toronto('2027-03-05T10:00');
      expect(await svc.time.detectNoShows()).toMatchObject({ detected: 2 });
      await tx.scheduledShift.update({
        where: { id: later.shift.id },
        data: { status: 'CANCELLED' },
      });
      // A manager adds the time Employee 2 actually worked (a late manual entry).
      await closedEntry(tx, {
        employeeId: fx.employee2,
        employmentAssignmentId: fx.otherTeamA,
        clockInAt: toronto('2027-03-05T09:45'),
        clockOutAt: toronto('2027-03-05T17:00'),
        workDate: '2027-03-05',
      });
      expect(await svc.time.detectNoShows()).toMatchObject({
        detected: 0,
        superseded: 2,
      });
      expect(
        (await noShows(h)).map((row) => [row.scheduledShiftId, row.status]),
      ).toEqual(
        expect.arrayContaining([
          [later.shift.id, 'SUPERSEDED'],
          [moved.shift.id, 'SUPERSEDED'],
        ]),
      );
    });
  });

  // ─── 5. Timesheet review ────────────────────────────────────────────────────────────────

  it('shows employee names to managers, records the timesheet approval and refuses a stale reviewer', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx } = h;
      const manager = fx.users.managerA!;
      await closedEntry(tx, {
        employeeId: fx.employee2,
        employmentAssignmentId: fx.otherTeamA,
        clockInAt: toronto('2027-03-02T09:00'),
        clockOutAt: toronto('2027-03-02T12:00'),
        workDate: '2027-03-02',
      });
      const [period] = (await generate(h, fx.orgA, '2027-03-01', 'WEEKLY'))
        .periods;
      await svc.time.materializeTimesheets(manager, period!.id, ctx(manager));
      const sheet = await tx.timesheet.findFirstOrThrow({
        where: { timePeriodId: period!.id, employeeId: fx.employee2 },
        include: { segments: true },
      });
      const listed = (
        (await svc.time.managementTimesheets(manager, { limit: 100 }))
          .items as Array<{ id: string; employee: Record<string, string> }>
      ).find((item) => item.id === sheet.id)!;
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: fx.employee2 },
        include: { person: true },
      });
      expect(listed.employee).toEqual({
        id: fx.employee2,
        employeeNumber: employee.employeeNumber,
        name: expect.stringContaining(employee.person.lastName!),
      });
      // Employees see their own timesheet without that management field.
      expect(
        (await svc.time.selfTimesheets(fx.selfUser2)).timesheets[0],
      ).not.toHaveProperty('employee');

      h.clock.value = toronto('2027-03-08T09:00');
      await svc.time.submitTimesheet(fx.selfUser2, sheet.id, ctx(fx.selfUser2));
      // A reviewer who saw version 2 (stale) is refused; the current version approves.
      expect(
        body(
          await rejection(
            svc.time.approveTimesheetSegment(
              manager,
              sheet.segments[0]!.id,
              undefined,
              ctx(manager),
              { expectedVersion: 2 },
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIMESHEET_VERSION_CONFLICT', version: 1 });
      await svc.time.approveTimesheetSegment(
        manager,
        sheet.segments[0]!.id,
        undefined,
        ctx(manager),
        { expectedVersion: 1, expectedNetWorkedMinutes: 180 },
      );
      expect(
        (
          await tx.timesheetEvent.findMany({
            where: { timesheetId: sheet.id },
            orderBy: { occurredAt: 'asc' },
          })
        ).map((event) => event.type),
      ).toEqual(['SUBMITTED', 'SEGMENT_APPROVED', 'APPROVED']);
      expect(
        await tx.auditLog.findFirstOrThrow({
          where: { action: 'TIMESHEET_APPROVED', entityId: sheet.id },
        }),
      ).toMatchObject({
        actorUserId: manager,
        metadata: expect.objectContaining({
          version: 1,
          approvedWorkedMinutes: 180,
        }),
      });
    });
  });

  // ─── 6. Automation (opt-in) ─────────────────────────────────────────────────────────────

  it('generates periods and timesheets automatically only for opted-in attendance-only organizations, never for payroll-managed ones', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx, clock } = h;
      // The job does nothing at all unless the worker's switch is on.
      expect(
        await runPrepareAttendancePeriodsJob({}, { env: {} }),
      ).toMatchObject({ disabled: true, periodsCreated: 0 });
      clock.value = toronto('2027-03-10T12:00');
      // Nobody opted in yet: nothing.
      expect(await svc.time.prepareAttendancePeriods()).toMatchObject({
        organizations: 0,
        periodsCreated: 0,
      });

      // Organization A opts in: weekly from Monday 2027-01-04, 10 days ahead, with timesheets.
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
          effectiveFrom: new Date('2027-03-01'),
          config: {
            ...POLICY,
            periods: {
              autoGenerate: true,
              cadence: 'WEEKLY',
              anchorDate: '2027-01-04',
              leadDays: 10,
              autoMaterialize: true,
            },
          },
        },
      });
      // Organization B opts in too, but payroll prepares its periods (a payroll calendar).
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgB,
          effectiveFrom: new Date('2027-03-01'),
          config: {
            periods: {
              autoGenerate: true,
              cadence: 'WEEKLY',
              anchorDate: '2027-01-04',
            },
          },
        },
      });
      const payroll = payrollServices(
        rollbackClient(tx),
        new FixedPayrollClock(),
      );
      const group = await payGroup(tx, fx.orgB, `PGB-${fx.suffix}`);
      await payroll.calendars.createCalendar(
        {
          payGroupId: group.id,
          cadence: 'BIWEEKLY',
          timezone: 'America/Toronto',
          anchorDate: '2027-03-07',
          payDateOffsetDays: 5,
          processingCutoffOffsetDays: 2,
          effectiveFrom: '2027-03-07',
        },
        ctx(fx.users.payrollB!),
      );
      await closedEntry(tx, {
        employeeId: fx.employee1,
        employmentAssignmentId: fx.assignmentTeamA,
        clockInAt: toronto('2027-03-09T09:00'),
        clockOutAt: toronto('2027-03-09T12:00'),
        workDate: '2027-03-09',
      });

      const run = await svc.time.prepareAttendancePeriods();
      expect(run).toMatchObject({
        organizations: 1,
        periodsCreated: 2,
        skippedPayrollManaged: [fx.orgB],
        failed: [],
      });
      // The week containing today (Mar 8–14) and the next one starting within 10 days; none earlier.
      expect(
        (
          await tx.timePeriod.findMany({
            where: { organizationId: fx.orgA },
            orderBy: { startDate: 'asc' },
          })
        ).map((period) => period.startDate.toISOString().slice(0, 10)),
      ).toEqual(['2027-03-08', '2027-03-15']);
      expect(
        await tx.timePeriod.count({ where: { organizationId: fx.orgB } }),
      ).toBe(0);
      // Timesheets for the current week (both Organization A employees record by clock).
      expect(run.timesheetsCreated).toBe(2);
      // Idempotent.
      expect(await svc.time.prepareAttendancePeriods()).toMatchObject({
        periodsCreated: 0,
        timesheetsCreated: 0,
      });
      // Narrower policy layers may not set periods.
      expect(
        body(
          await rejection(
            new TimePolicyService(
              rollbackClient(tx),
              svc.authorization,
              svc.targets,
              svc.audit,
            ).create(
              fx.users.managerA!,
              {
                scopeType: 'TEAM',
                organizationId: fx.orgA,
                teamId: fx.teamA,
                effectiveFrom: '2027-04-01',
                config: { periods: { autoGenerate: true } },
              } as never,
              ctx(fx.users.managerA!),
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIME_POLICY_SECTION_SCOPE' });
    });
  });
});
