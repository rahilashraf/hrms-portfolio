import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  noticesOf,
  primeEventCheckpoints,
  publishEvents,
  transactionStart,
} from './support/event-notification-fixtures.js';
import {
  ALL_SCHEDULE_PERMISSIONS,
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  torontoShift,
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
import { addOrganizationBAssignment } from './support/time-world.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const CORRECTION = 'events.time-correction';
const TIMESHEET = 'events.timesheet';
const SCHEDULE = 'events.schedule-published';
const REVISION = 'events.shift-revision';

/** Past every event a scenario records (corrections are reviewed at the fixed 2027 clock). */
const FAR_HORIZON = new Date('2028-01-01T00:00:00.000Z');
/** Before every correction review of these scenarios (the fixed clock starts in March 2027). */
const CORRECTIONS_FROM = new Date('2027-03-01T00:00:00.000Z');

const USERS = {
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  /** Employee 2's own account schedules (and publishes) Department A. */
  self2: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'org' as const }],
  managerA: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
  admin: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'org' as const }],
  /** Organization B administrator (time and scheduling). */
  hrB: [
    {
      permissions: [...TIME_PERMISSIONS, ...ALL_SCHEDULE_PERMISSIONS],
      scope: 'orgB' as const,
    },
  ],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  svc: ReturnType<typeof timeServices>;
  start: Date;
}

const localDay = (instant: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

const sourceOutcome = (
  outcome: Awaited<ReturnType<typeof publishEvents>>,
  key: string,
) => outcome.sources.find((source) => source.source === key)!;

/**
 * Batch 8 (N6) — durable event notifications of Time (correction decisions, timesheet changes
 * requested / approved) and Scheduling (schedule published, shift corrected / cancelled):
 * recipients, content, dedupe, module gates and organization isolation.
 */
describe('Batch 8 event notifications: Time and Scheduling (database)', () => {
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
          await seedTimePolicy(tx, fx.orgA, LIVE_TIME_POLICY);
          // Department B's position has no work location: its zone is the organization's.
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'America/Toronto' },
          });
          const clock = new FixedClock();
          const svc = timeServices(rollbackClient(tx), clock);
          const start = await transactionStart(tx);
          await run({ tx, fx, clock, svc, start }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 180_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** Employee 1 clocks in and out (Toronto local times). */
  async function work(
    h: Harness,
    assignmentId: string,
    from: string,
    to: string,
  ) {
    h.clock.value = toronto(from);
    await h.svc.time.clockIn(h.fx.selfUser1, assignmentId, ctx(h.fx.selfUser1));
    h.clock.value = toronto(to);
    await h.svc.time.clockOut(h.fx.selfUser1, ctx(h.fx.selfUser1));
    return h.tx.timeEntry.findFirstOrThrow({
      where: {
        employeeId: h.fx.employee1,
        workDate: new Date(`${from.slice(0, 10)}T00:00:00.000Z`),
        employmentAssignmentId: assignmentId,
      },
    });
  }

  async function correctionRequest(h: Harness, entryId: string, at: string) {
    return (await h.svc.time.requestCorrection(
      h.fx.selfUser1,
      {
        type: 'CHANGE_CLOCK_OUT',
        timeEntryId: entryId,
        clockOutAt: at,
        reason: 'SECRET-REASON stayed for the delivery',
      },
      ctx(h.fx.selfUser1),
    )) as { id: string; status: string };
  }

  /** Employee 1's timesheet for the week of Monday 2027-03-01. */
  async function weeklySheet(h: Harness) {
    const manager = h.fx.users.managerA!;
    await h.svc.time.generateTimePeriods(
      manager,
      { organizationId: h.fx.orgA, startDate: '2027-03-01', cadence: 'WEEKLY' },
      ctx(manager),
    );
    const period = await h.tx.timePeriod.findFirstOrThrow({
      where: { organizationId: h.fx.orgA },
    });
    return (
      await h.svc.time.materializeTimesheetForEmployeePeriod(
        h.fx.employee1,
        period.id,
      )
    ).id;
  }

  async function departmentSchedule(
    h: Harness,
    name: string,
    periodStart: string,
    periodEnd: string,
  ) {
    return (
      await h.svc.scheduling.createSchedule(
        {
          scopeType: 'DEPARTMENT',
          organizationId: h.fx.orgA,
          departmentId: h.fx.deptA,
          name,
          type: 'STANDARD',
          periodStart,
          periodEnd,
        },
        ctx(h.fx.users.admin!),
      )
    ).id;
  }

  async function draftShift(
    h: Harness,
    scheduleId: string,
    input: ReturnType<typeof torontoShift>,
  ) {
    return (
      (await h.svc.scheduling.createShift(
        scheduleId,
        input,
        ctx(h.fx.users.admin!),
      )) as { id: string }
    ).id;
  }

  /** An extra Team A employee (optionally with a self-service account). */
  async function extraEmployee(h: Harness, index: number, withUser = true) {
    const { tx, fx } = h;
    const person = await tx.person.create({
      data: { firstName: `Extra${index}`, lastName: fx.suffix },
    });
    const employee = await tx.employee.create({
      data: {
        personId: person.id,
        employeeNumber: `X${index}-${fx.suffix}`,
        hireDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const assignment = await tx.employmentAssignment.create({
      data: {
        employeeId: employee.id,
        positionId: fx.positionTeamA,
        employmentType: 'FULL_TIME',
        status: 'ACTIVE',
        isPrimary: true,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const user = withUser
      ? (
          await tx.user.create({
            data: {
              personId: person.id,
              email: `b8-x${index}-${fx.suffix.toLowerCase()}@example.com`,
              status: 'ACTIVE',
            },
          })
        ).id
      : null;
    return { employeeId: employee.id, assignmentId: assignment.id, user };
  }

  // ─── Time corrections ───────────────────────────────────────────────────────

  it('time corrections: a reviewer decision notifies the requester (approved / declined), an automatic approval nobody; no values, reason or note; republishing creates nothing', async () => {
    await scenario(async (h) => {
      const { tx, fx, svc, start } = h;
      const manager = fx.users.managerA!;
      await primeEventCheckpoints(tx, [CORRECTION], CORRECTIONS_FROM);
      // Department B corrections are approved automatically by policy.
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentDeptB,
          effectiveFrom: new Date('2027-03-01T00:00:00.000Z'),
          config: {
            correction: {
              employeeRequestsEnabled: true,
              approvalMode: 'NO_APPROVAL_REQUIRED',
            },
          },
        },
      });
      const first = await work(
        h,
        fx.assignmentTeamA,
        '2027-03-02T09:00',
        '2027-03-02T12:00',
      );
      const second = await work(
        h,
        fx.assignmentTeamA,
        '2027-03-03T09:00',
        '2027-03-03T12:00',
      );
      const third = await work(
        h,
        fx.assignmentDeptB,
        '2027-03-04T09:00',
        '2027-03-04T11:00',
      );
      h.clock.value = toronto('2027-03-04T15:00');
      const approved = await correctionRequest(h, first.id, '2027-03-02T12:30');
      const declined = await correctionRequest(
        h,
        second.id,
        '2027-03-03T12:45',
      );
      const automatic = await correctionRequest(
        h,
        third.id,
        '2027-03-04T11:15',
      );
      expect(approved.status).toBe('PENDING');
      expect(declined.status).toBe('PENDING');
      expect(automatic.status).toBe('APPROVED');
      await svc.time.approveCorrection(
        manager,
        approved.id,
        'SECRET-NOTE approved',
        ctx(manager),
      );
      await svc.time.rejectCorrection(
        manager,
        declined.id,
        'SECRET-NOTE declined',
        ctx(manager),
      );
      // Still pending: no decision, no notice.
      await work(h, fx.assignmentTeamA, '2027-03-05T09:00', '2027-03-05T12:00');
      const pendingEntry = await tx.timeEntry.findFirstOrThrow({
        where: {
          employeeId: fx.employee1,
          workDate: new Date('2027-03-05T00:00:00.000Z'),
        },
      });
      h.clock.value = toronto('2027-03-05T15:00');
      await correctionRequest(h, pendingEntry.id, '2027-03-05T12:20');

      const outcome = sourceOutcome(
        await publishEvents(rollbackClient(tx), [CORRECTION], {
          horizon: FAR_HORIZON,
        }),
        CORRECTION,
      );
      expect(outcome).toMatchObject({
        events: 3,
        created: 2,
        skipped: 0,
        failed: [],
      });

      const notices = await noticesOf(tx, fx.orgA, 'time.correction-decided');
      expect(notices).toHaveLength(2);
      const requestedOn = localDay(start, 'America/Toronto');
      const byRequest = new Map(notices.map((n) => [n.sourceEntityId, n]));
      expect(byRequest.get(approved.id)).toMatchObject({
        recipientUserId: fx.selfUser1,
        category: 'TIME',
        sourceDomain: 'TIME',
        sourceEntityType: 'TimeCorrectionRequest',
        link: '/time?tab=requests',
        title: 'Your time correction was approved',
        body: `Your time correction request submitted on ${requestedOn} was approved.`,
        dedupeKey: `time.correction-decided:${approved.id}`,
      });
      expect(byRequest.get(declined.id)).toMatchObject({
        recipientUserId: fx.selfUser1,
        link: '/time?tab=requests',
        title: 'Your time correction was declined',
        body: `Your time correction request submitted on ${requestedOn} was declined.`,
      });
      expect(byRequest.has(automatic.id)).toBe(false);
      for (const notice of notices) {
        const text = `${notice.title} ${notice.body}`;
        expect(text).not.toMatch(/SECRET|12:30|12:45|delivery/);
        expect(notice.deliveries.map((d) => [d.channel, d.status])).toEqual(
          expect.arrayContaining([['IN_APP', 'SENT']]),
        );
      }
      // Nobody else (the reviewer included) was notified.
      expect(
        await tx.notification.count({
          where: {
            type: 'time.correction-decided',
            recipientUserId: { not: fx.selfUser1 },
            organizationId: { in: [fx.orgA, fx.orgB] },
          },
        }),
      ).toBe(0);

      // Republishing: the checkpoint moved on; replaying from the start dedupes.
      expect(
        sourceOutcome(
          await publishEvents(rollbackClient(tx), [CORRECTION], {
            horizon: FAR_HORIZON,
          }),
          CORRECTION,
        ),
      ).toMatchObject({ events: 0, created: 0 });
      await primeEventCheckpoints(tx, [CORRECTION], CORRECTIONS_FROM);
      expect(
        sourceOutcome(
          await publishEvents(rollbackClient(tx), [CORRECTION], {
            horizon: FAR_HORIZON,
          }),
          CORRECTION,
        ),
      ).toMatchObject({ events: 3, created: 0, existing: 2 });
      expect(
        await noticesOf(tx, fx.orgA, 'time.correction-decided'),
      ).toHaveLength(2);
    });
  });

  // ─── Timesheets ─────────────────────────────────────────────────────────────

  it('timesheets: changes requested and each whole-timesheet approval notify the employee once (not per segment); a reopen and re-approval is a new notice; never the acting employee', async () => {
    await scenario(async (h) => {
      const { tx, fx, svc, start } = h;
      const manager = fx.users.managerA!;
      await primeEventCheckpoints(tx, [TIMESHEET], start);
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      await work(h, fx.assignmentDeptB, '2027-03-03T09:00', '2027-03-03T11:00');
      const sheetId = await weeklySheet(h);
      afterPeriodEnd(h.clock, '2027-03-07');
      const submit = () =>
        svc.time.submitTimesheet(fx.selfUser1, sheetId, ctx(fx.selfUser1));
      const segments = await tx.timesheetSegment.findMany({
        where: { timesheetId: sheetId },
      });
      expect(segments).toHaveLength(2);
      const teamA = segments.find(
        (s) => s.employmentAssignmentId === fx.assignmentTeamA,
      )!;
      const deptB = segments.find(
        (s) => s.employmentAssignmentId === fx.assignmentDeptB,
      )!;
      const approveSegment = (id: string) =>
        svc.time.approveTimesheetSegment(manager, id, undefined, ctx(manager));

      await submit();
      await approveSegment(teamA.id);
      await svc.time.requestTimesheetChanges(
        manager,
        deptB.id,
        'SECRET-NOTE add the delivery break',
        ctx(manager),
      );
      await submit();
      await approveSegment(deptB.id);
      expect(
        (await tx.timesheet.findUniqueOrThrow({ where: { id: sheetId } }))
          .status,
      ).toBe('APPROVED');

      const link = `/time?tab=timesheets&timesheet=${sheetId}`;
      let outcome = sourceOutcome(
        await publishEvents(rollbackClient(tx), [TIMESHEET]),
        TIMESHEET,
      );
      expect(outcome).toMatchObject({ events: 2, created: 2, failed: [] });
      const changes = await noticesOf(
        tx,
        fx.orgA,
        'time.timesheet-changes-requested',
      );
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        recipientUserId: fx.selfUser1,
        link,
        sourceEntityType: 'Timesheet',
        sourceEntityId: sheetId,
        title: 'Changes requested on your timesheet',
        body: 'Changes were requested on your timesheet for 2027-03-01 to 2027-03-07. Please review and resubmit it.',
      });
      expect(changes[0]!.body).not.toContain('SECRET');
      let approvals = await noticesOf(tx, fx.orgA, 'time.timesheet-approved');
      // Two segment approvals, one timesheet approval: one notice.
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({
        recipientUserId: fx.selfUser1,
        link,
        title: 'Your timesheet was approved',
        body: 'Your timesheet for 2027-03-01 to 2027-03-07 was approved.',
      });

      // Reopen and re-approve: a new APPROVED event, a new notice.
      await svc.time.reopenTimesheet(
        manager,
        sheetId,
        'Late hours',
        ctx(manager),
      );
      await submit();
      for (const segment of await tx.timesheetSegment.findMany({
        where: { timesheetId: sheetId },
      }))
        await approveSegment(segment.id);
      outcome = sourceOutcome(
        await publishEvents(rollbackClient(tx), [TIMESHEET]),
        TIMESHEET,
      );
      expect(outcome).toMatchObject({ events: 1, created: 1 });
      approvals = await noticesOf(tx, fx.orgA, 'time.timesheet-approved');
      expect(approvals).toHaveLength(2);
      expect(new Set(approvals.map((n) => n.dedupeKey)).size).toBe(2);
      expect(approvals.every((n) => n.recipientUserId === fx.selfUser1)).toBe(
        true,
      );

      // An event acted by the employee themself notifies nobody.
      await tx.timesheetEvent.create({
        data: {
          timesheetId: sheetId,
          actorUserId: fx.selfUser1,
          type: 'APPROVED',
        },
      });
      await tx.timesheetEvent.create({
        data: {
          timesheetId: sheetId,
          actorUserId: fx.selfUser1,
          type: 'CHANGES_REQUESTED',
        },
      });
      outcome = sourceOutcome(
        await publishEvents(rollbackClient(tx), [TIMESHEET]),
        TIMESHEET,
      );
      expect(outcome).toMatchObject({ events: 2, created: 0 });
      expect(
        await noticesOf(tx, fx.orgA, 'time.timesheet-approved'),
      ).toHaveLength(2);

      // Replaying everything dedupes; the manager never received anything.
      await primeEventCheckpoints(tx, [TIMESHEET], start);
      expect(
        sourceOutcome(
          await publishEvents(rollbackClient(tx), [TIMESHEET]),
          TIMESHEET,
        ),
      ).toMatchObject({ created: 0, existing: 3 });
      expect(
        await tx.notification.count({ where: { recipientUserId: manager } }),
      ).toBe(0);
    });
  });

  // ─── Schedule published ─────────────────────────────────────────────────────

  it('schedule published: one notice per employee with active shifts and their own shift count (fan-out), never the publisher or employees without shifts; organization isolated; dedupes', async () => {
    await scenario(async (h) => {
      const { tx, fx, svc, start } = h;
      await primeEventCheckpoints(tx, [SCHEDULE], start);
      await addOrganizationBAssignment(tx, fx);
      const scheduleId = await departmentSchedule(
        h,
        'Fan-out week',
        '2027-03-01',
        '2027-03-07',
      );
      const day = (n: number) => `2027-03-0${n}`;
      const shifts = async (assignmentId: string, count: number) => {
        for (let n = 1; n <= count; n += 1)
          await draftShift(
            h,
            scheduleId,
            torontoShift(assignmentId, day(n), '09:00', '13:00'),
          );
      };
      // Employee 1: 3 shifts over two assignments; Employee 2 (the publisher): 2.
      await shifts(fx.assignmentTeamA, 2);
      await draftShift(
        h,
        scheduleId,
        torontoShift(fx.assignmentTeamA, day(3), '14:00', '18:00'),
      );
      await shifts(fx.otherTeamA, 2);
      const expected = new Map<string, number>([[fx.selfUser1, 3]]);
      // Six more employees with 1..6 shifts each.
      for (let index = 1; index <= 6; index += 1) {
        const extra = await extraEmployee(h, index);
        await shifts(extra.assignmentId, index);
        expected.set(extra.user!, index);
      }
      // An employee with an account and no shift, and one with shifts and no account.
      const idle = await extraEmployee(h, 7);
      const noAccount = await extraEmployee(h, 8, false);
      await shifts(noAccount.assignmentId, 2);
      expect(await tx.scheduledShift.count({ where: { scheduleId } })).toBe(28);

      await svc.scheduling.publishSchedule(scheduleId, ctx(fx.selfUser2));

      // Organization B publishes its own schedule with an Employee 1 shift.
      const orgBAssignment = await tx.employmentAssignment.findFirstOrThrow({
        where: {
          employeeId: fx.employee1,
          position: { organizationId: fx.orgB },
        },
      });
      const orgBSchedule = (
        await svc.scheduling.createSchedule(
          {
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgB,
            name: 'Org B week',
            type: 'STANDARD',
            periodStart: '2027-03-01',
            periodEnd: '2027-03-07',
          },
          ctx(fx.users.hrB!),
        )
      ).id;
      await svc.scheduling.createShift(
        orgBSchedule,
        torontoShift(orgBAssignment.id, day(5), '09:00', '12:00'),
        ctx(fx.users.hrB!),
      );
      await svc.scheduling.publishSchedule(orgBSchedule, ctx(fx.users.hrB!));

      const outcome = sourceOutcome(
        await publishEvents(rollbackClient(tx), [SCHEDULE]),
        SCHEDULE,
      );
      expect(outcome).toMatchObject({
        events: 2,
        created: 8,
        skipped: 0,
        failed: [],
      });

      const notices = await noticesOf(
        tx,
        fx.orgA,
        'scheduling.schedule-published',
      );
      expect(notices).toHaveLength(7);
      expect(new Set(notices.map((n) => n.recipientUserId)).size).toBe(7);
      for (const notice of notices) {
        const count = expected.get(notice.recipientUserId);
        expect(count).toBeDefined();
        expect(notice).toMatchObject({
          organizationId: fx.orgA,
          category: 'SCHEDULING',
          sourceDomain: 'SCHEDULING',
          link: '/schedule',
          sourceEntityType: 'Schedule',
          sourceEntityId: scheduleId,
          title: 'Your schedule is published',
          body: `A schedule for 2027-03-01 to 2027-03-07 was published with ${count} shift(s) for you.`,
        });
      }
      expect(notices.map((n) => n.recipientUserId).sort()).toEqual(
        [...expected.keys()].sort(),
      );
      for (const absent of [fx.selfUser2, idle.user!, fx.users.admin!])
        expect(
          await tx.notification.count({ where: { recipientUserId: absent } }),
        ).toBe(0);

      // Organization B: Employee 1 only, with the Organization B shift; Organization A users
      // never see it, Organization B users never see Organization A's.
      const orgB = await noticesOf(
        tx,
        fx.orgB,
        'scheduling.schedule-published',
      );
      expect(orgB).toHaveLength(1);
      expect(orgB[0]).toMatchObject({
        recipientUserId: fx.selfUser1,
        sourceEntityId: orgBSchedule,
        body: 'A schedule for 2027-03-01 to 2027-03-07 was published with 1 shift(s) for you.',
      });
      expect(
        await tx.notification.count({
          where: { recipientUserId: fx.users.hrB! },
        }),
      ).toBe(0);
      expect(
        await tx.notification.count({
          where: {
            sourceEntityId: orgBSchedule,
            recipientUserId: { not: fx.selfUser1 },
          },
        }),
      ).toBe(0);

      // Republishing from the start creates nothing new.
      await primeEventCheckpoints(tx, [SCHEDULE], start);
      expect(
        sourceOutcome(
          await publishEvents(rollbackClient(tx), [SCHEDULE]),
          SCHEDULE,
        ),
      ).toMatchObject({ events: 2, created: 0, existing: 8 });
      expect(
        await noticesOf(tx, fx.orgA, 'scheduling.schedule-published'),
      ).toHaveLength(7);
    });
  });

  // ─── Shift corrected / cancelled ────────────────────────────────────────────

  it('shift corrected / cancelled: the shift employee, past shifts included, local HH:mm times; never the actor; a move to another employee cancels it for the previous one', async () => {
    await scenario(async (h) => {
      const { tx, fx, svc, start } = h;
      const admin = ctx(fx.users.admin!);
      // A past week (EDT, -04:00).
      const scheduleId = await departmentSchedule(
        h,
        'Past week',
        '2026-10-05',
        '2026-10-11',
      );
      const edt = (
        assignment: string,
        date: string,
        from: string,
        to: string,
      ) => torontoShift(assignment, date, from, to, '-04:00');
      const corrected = await draftShift(
        h,
        scheduleId,
        edt(fx.assignmentTeamA, '2026-10-06', '09:00', '17:00'),
      );
      const cancelled = await draftShift(
        h,
        scheduleId,
        edt(fx.assignmentTeamA, '2026-10-07', '09:00', '17:00'),
      );
      const ownCancel = await draftShift(
        h,
        scheduleId,
        edt(fx.otherTeamA, '2026-10-08', '08:00', '12:00'),
      );
      const moved = await draftShift(
        h,
        scheduleId,
        edt(fx.assignmentTeamA, '2026-10-09', '09:00', '17:00'),
      );
      await svc.scheduling.publishSchedule(scheduleId, admin);
      await primeEventCheckpoints(tx, [REVISION], start);

      await svc.scheduling.correctShift(
        scheduleId,
        corrected,
        { startsAt: '2026-10-06T10:30:00-04:00', reason: 'SECRET-REASON late' },
        admin,
      );
      await svc.scheduling.cancelShift(
        scheduleId,
        cancelled,
        { reason: 'SECRET-REASON closed' },
        admin,
      );
      // Employee 2 cancels their own shift: not notified.
      await svc.scheduling.cancelShift(
        scheduleId,
        ownCancel,
        { reason: 'Own change' },
        ctx(fx.selfUser2),
      );
      // The service refuses moving a published shift to another employee...
      const refused = await violation(tx, () =>
        svc.scheduling.correctShift(
          scheduleId,
          moved,
          { employmentAssignmentId: fx.otherTeamA, reason: 'Cover' },
          admin,
        ),
      );
      expect(
        (refused as { getResponse(): unknown }).getResponse(),
      ).toMatchObject({ code: 'PUBLISHED_SHIFT_REASSIGNMENT_NOT_ALLOWED' });
      // ...so such a correction (e.g. recorded before that rule) is written directly.
      const shift = await tx.scheduledShift.update({
        where: { id: moved },
        data: {
          employmentAssignmentId: fx.otherTeamA,
          startsAt: new Date('2026-10-09T11:00:00-04:00'),
        },
      });
      await tx.scheduledShiftRevision.create({
        data: {
          scheduledShiftId: moved,
          revisionNumber: 2,
          revisionType: 'CORRECTED',
          employmentAssignmentId: shift.employmentAssignmentId,
          workLocationId: shift.workLocationId,
          workDate: shift.workDate,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          timezone: shift.timezone,
          status: shift.status,
          sourceType: shift.sourceType,
          reason: 'Cover',
          changedByUserId: fx.users.admin!,
        },
      });

      const outcome = sourceOutcome(
        await publishEvents(rollbackClient(tx), [REVISION]),
        REVISION,
      );
      expect(outcome).toMatchObject({ events: 4, created: 4, failed: [] });

      const correctedNotices = await noticesOf(
        tx,
        fx.orgA,
        'scheduling.shift-corrected',
      );
      const cancelledNotices = await noticesOf(
        tx,
        fx.orgA,
        'scheduling.shift-cancelled',
      );
      const summary = (rows: typeof correctedNotices) =>
        rows
          .map((n) => [n.recipientUserId, n.sourceEntityId, n.body])
          .sort((a, b) => String(a[2]).localeCompare(String(b[2])));
      expect(summary(correctedNotices)).toEqual(
        [
          [
            fx.selfUser1,
            corrected,
            'Your shift on 2026-10-06 is now 10:30 to 17:00 (America/Toronto).',
          ],
          [
            fx.selfUser2,
            moved,
            'Your shift on 2026-10-09 is now 11:00 to 17:00 (America/Toronto).',
          ],
        ].sort((a, b) => a[2]!.localeCompare(b[2]!)),
      );
      expect(summary(cancelledNotices)).toEqual(
        [
          [
            fx.selfUser1,
            cancelled,
            'Your shift on 2026-10-07 from 09:00 to 17:00 (America/Toronto) was cancelled.',
          ],
          [
            fx.selfUser1,
            moved,
            'Your shift on 2026-10-09 from 09:00 to 17:00 (America/Toronto) was cancelled.',
          ],
        ].sort((a, b) => a[2]!.localeCompare(b[2]!)),
      );
      for (const notice of [...correctedNotices, ...cancelledNotices]) {
        expect(notice).toMatchObject({
          link: '/schedule',
          sourceEntityType: 'ScheduledShift',
          category: 'SCHEDULING',
        });
        expect(`${notice.title} ${notice.body}`).not.toMatch(
          /SECRET|Toronto Site|Cover/,
        );
      }
      expect(correctedNotices[0]!.title).toMatch(
        /^Your shift on 2026-10-0\d changed$/,
      );
      expect(
        await tx.notification.count({
          where: { sourceEntityId: ownCancel },
        }),
      ).toBe(0);
      expect(
        await tx.notification.count({
          where: { recipientUserId: fx.users.admin! },
        }),
      ).toBe(0);

      // Republishing from the start creates nothing new.
      await primeEventCheckpoints(tx, [REVISION], start);
      expect(
        sourceOutcome(
          await publishEvents(rollbackClient(tx), [REVISION]),
          REVISION,
        ),
      ).toMatchObject({ events: 4, created: 0, existing: 4 });
    });
  });

  // ─── Module gates ───────────────────────────────────────────────────────────

  it('module gates: TIME notices follow Attendance, scheduling notices follow Scheduling; a disabled module publishes nothing', async () => {
    await scenario(async (h) => {
      const { tx, fx, svc, start } = h;
      await primeEventCheckpoints(tx, [CORRECTION], CORRECTIONS_FROM);
      await primeEventCheckpoints(tx, [TIMESHEET, SCHEDULE, REVISION], start);
      const manager = fx.users.managerA!;
      // A decided correction and a changes request (TIME).
      const entry = await work(
        h,
        fx.assignmentTeamA,
        '2027-03-02T09:00',
        '2027-03-02T12:00',
      );
      h.clock.value = toronto('2027-03-02T15:00');
      const request = await correctionRequest(h, entry.id, '2027-03-02T12:30');
      await svc.time.approveCorrection(
        manager,
        request.id,
        undefined,
        ctx(manager),
      );
      const sheetId = await weeklySheet(h);
      afterPeriodEnd(h.clock, '2027-03-07');
      await svc.time.submitTimesheet(fx.selfUser1, sheetId, ctx(fx.selfUser1));
      const [segment] = await tx.timesheetSegment.findMany({
        where: { timesheetId: sheetId },
      });
      await svc.time.requestTimesheetChanges(
        manager,
        segment!.id,
        'Fix',
        ctx(manager),
      );
      // A published schedule and a cancelled shift (SCHEDULING).
      const scheduleId = await departmentSchedule(
        h,
        'Gate week',
        '2027-03-08',
        '2027-03-14',
      );
      const shift = await draftShift(
        h,
        scheduleId,
        torontoShift(fx.assignmentTeamA, '2027-03-09', '09:00', '17:00'),
      );
      await draftShift(
        h,
        scheduleId,
        torontoShift(fx.assignmentTeamA, '2027-03-10', '09:00', '17:00'),
      );
      await svc.scheduling.publishSchedule(scheduleId, ctx(fx.users.admin!));
      await svc.scheduling.cancelShift(
        scheduleId,
        shift,
        { reason: 'Closed' },
        ctx(fx.users.admin!),
      );

      const setModule = (
        module: 'ATTENDANCE' | 'SCHEDULING',
        enabled: boolean,
      ) =>
        tx.organizationModuleSetting.upsert({
          where: { organizationId_module: { organizationId: fx.orgA, module } },
          create: { organizationId: fx.orgA, module, enabled },
          update: { enabled, version: { increment: 1 } },
        });

      // Attendance disabled: no TIME notices; scheduling ones still published.
      await setModule('ATTENDANCE', false);
      let outcome = await publishEvents(
        rollbackClient(tx),
        [CORRECTION, TIMESHEET, SCHEDULE],
        { horizon: FAR_HORIZON },
      );
      expect(sourceOutcome(outcome, CORRECTION)).toMatchObject({
        events: 1,
        created: 0,
        skipped: 1,
      });
      expect(sourceOutcome(outcome, TIMESHEET)).toMatchObject({
        events: 1,
        created: 0,
        skipped: 1,
      });
      expect(sourceOutcome(outcome, SCHEDULE)).toMatchObject({
        events: 1,
        created: 1,
      });
      for (const type of [
        'time.correction-decided',
        'time.timesheet-changes-requested',
      ])
        expect(await noticesOf(tx, fx.orgA, type)).toHaveLength(0);
      expect(
        await noticesOf(tx, fx.orgA, 'scheduling.schedule-published'),
      ).toMatchObject([
        {
          recipientUserId: fx.selfUser1,
          body: 'A schedule for 2027-03-08 to 2027-03-14 was published with 1 shift(s) for you.',
        },
      ]);

      // Scheduling disabled (Attendance back on): no scheduling notices.
      await setModule('ATTENDANCE', true);
      await setModule('SCHEDULING', false);
      outcome = await publishEvents(rollbackClient(tx), [REVISION]);
      expect(sourceOutcome(outcome, REVISION)).toMatchObject({
        events: 1,
        created: 0,
        skipped: 1,
      });
      expect(
        await noticesOf(tx, fx.orgA, 'scheduling.shift-cancelled'),
      ).toHaveLength(0);
      expect(
        await tx.notification.count({ where: { organizationId: fx.orgA } }),
      ).toBe(1);
    });
  });
});
