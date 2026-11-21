import { HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { LeaveAbsenceSource } from '../src/leave/leave-integration.js';
import { AttendanceSignInService } from '../src/time/attendance-sign-in.service.js';
import { TimeDomainService } from '../src/time/time-domain.service.js';
import type { KioskDevice } from '../src/time/time.service.js';
import {
  ALL_SCHEDULE_PERMISSIONS,
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  torontoShift,
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
  admin: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'org' as const }],
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  self2: [{ permissions: ['time.clock'], scope: 'org' as const }],
  timeManager: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
};

/** Employee 1's published shifts on Tuesday 2027-03-02 (Toronto), by name. */
type Shifts = Record<
  | 'first'
  | 'second'
  | 'evening'
  | 'overnight'
  | 'cancelled'
  | 'foreign'
  | 'timedMorning'
  | 'timedAfternoon'
  | 'timedEarly'
  | 'timedTomorrow',
  string
>;

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  svc: ReturnType<typeof timeServices>;
  signIns: AttendanceSignInService;
  shifts: Shifts;
  scheduleId: string;
  layerId: string;
  kiosk: KioskDevice;
}

const body = (error: unknown) =>
  (error as HttpException).getResponse() as Record<string, unknown>;

/**
 * Batch 4E-3 — presence-only employees confirming specific occurrences (C7), the work date of a
 * sign-in for an overnight occurrence (C9), and the employee's expected attendance (C8). A
 * generic presence role: one assignment signs in for published sessions (two can be open at
 * once); another assignment of the same employee is timed.
 */
describe('Employee occurrences and expected attendance (Batch 4E-3, database)', () => {
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
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'America/Toronto' },
          });
          await seedTimePolicy(tx, fx.orgA);
          // Team A (Employee 1) and Employee 2's position record presence by sign-in.
          const presence = {
            attendance: {
              trackingMode: 'SIGN_IN_ONLY',
              captureMode: 'KIOSK_OR_SELF_SERVICE',
              signInDuplicateWindowMinutes: 10,
            },
            attendanceInterpretation: {
              lateArrivalEnabled: true,
              lateGraceMinutes: 5,
            },
          };
          const layer = await tx.timeAttendancePolicy.create({
            data: {
              scopeType: 'EMPLOYMENT_ASSIGNMENT',
              employmentAssignmentId: fx.assignmentTeamA,
              effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
              config: presence,
            },
          });
          await tx.timeAttendancePolicy.create({
            data: {
              scopeType: 'EMPLOYMENT_ASSIGNMENT',
              employmentAssignmentId: fx.otherTeamA,
              effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
              config: presence,
            },
          });
          await tx.schedulePolicy.create({
            data: {
              scopeType: 'ORGANIZATION',
              organizationId: fx.orgA,
              effectiveFrom: new Date('2026-01-01T00:00:00Z'),
              unscheduledWorkMode: 'WARN_UNSCHEDULED',
              clockInEarlyMinutes: 30,
              clockInLateMinutes: 60,
            },
          });
          const clock = new FixedClock();
          const client = rollbackClient(tx);
          const svc = timeServices(client, clock);
          const signIns = new AttendanceSignInService(
            client,
            svc.time,
            new TimeDomainService(),
            svc.audit,
            clock,
            svc.schedules,
            // Leave's approved absences, as the API binds them (excused shifts).
            new LeaveAbsenceSource(client),
          );
          const admin = ctx(fx.users.admin!);
          const schedule = await svc.scheduling.createSchedule(
            {
              scopeType: 'ORGANIZATION',
              organizationId: fx.orgA,
              name: 'Sessions',
              type: 'AD_HOC',
              periodStart: '2027-03-01',
              periodEnd: '2027-03-07',
            },
            admin,
          );
          const shift = async (
            assignment: string,
            start: string,
            end: string,
            day = '2027-03-02',
            endDay = day,
          ) =>
            (
              await svc.scheduling.createShift(
                schedule.id,
                torontoShift(assignment, day, start, end, '-05:00', endDay),
                admin,
              )
            ).id;
          const shifts: Shifts = {
            first: await shift(fx.assignmentTeamA, '13:00', '13:30'),
            second: await shift(fx.assignmentTeamA, '13:45', '14:15'),
            cancelled: await shift(fx.assignmentTeamA, '14:30', '15:00'),
            evening: await shift(fx.assignmentTeamA, '18:30', '19:00'),
            overnight: await shift(
              fx.assignmentTeamA,
              '23:30',
              '03:30',
              '2027-03-02',
              '2027-03-03',
            ),
            foreign: await shift(fx.otherTeamA, '13:00', '13:30'),
            timedEarly: await shift(fx.assignmentDeptB, '06:00', '08:00'),
            timedMorning: await shift(fx.assignmentDeptB, '09:00', '12:00'),
            timedAfternoon: await shift(fx.assignmentDeptB, '15:00', '17:00'),
            timedTomorrow: await shift(
              fx.assignmentDeptB,
              '09:00',
              '12:00',
              '2027-03-03',
            ),
          };
          await svc.scheduling.publishSchedule(schedule.id, admin);
          await svc.scheduling.cancelShift(
            schedule.id,
            shifts.cancelled,
            { reason: 'Session cancelled' },
            admin,
          );
          const device = await tx.attendanceDevice.create({
            data: {
              organizationId: fx.orgA,
              physicalSiteId: fx.physicalSiteToronto,
              name: 'Front entrance',
              credentialHash: `hash-${fx.suffix}`,
              credentialIssuedAt: new Date(),
            },
          });
          await run({
            tx,
            fx,
            clock,
            svc,
            signIns,
            shifts,
            scheduleId: schedule.id,
            layerId: layer.id,
            kiosk: {
              id: device.id,
              organizationId: fx.orgA,
              physicalSiteId: fx.physicalSiteToronto,
            },
          }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const signIn = (
    h: Harness,
    input: { scheduledShiftId?: string; idempotencyKey?: string } = {},
  ) =>
    h.signIns.selfSignIn(
      h.fx.selfUser1,
      { employmentAssignmentId: h.fx.assignmentTeamA, ...input },
      ctx(h.fx.selfUser1),
    );

  type Status = {
    availableActions: string[];
    signInOptions: Array<{
      scheduledShiftId: string;
      workDate: string;
      startsAt: string;
      endsAt: string;
      timezone: string;
      clockInOpensAt: string;
      clockInClosesAt: string;
      signIn: { id: string; signedInAt: string } | null;
    }>;
  };
  const status = async (h: Harness) =>
    (await h.svc.time.status(h.fx.selfUser1)) as unknown as Status;

  it('offers the occurrences open now and records the one the employee chooses (C7)', async () => {
    await scenario(async (h) => {
      const { clock, shifts, tx } = h;
      clock.value = toronto('2027-03-02T13:20');
      // Two sessions open at once; the cancelled one and later ones are not offered.
      let view = await status(h);
      expect(view.availableActions).toContain('SIGN_IN');
      expect(
        view.signInOptions.map((option) => option.scheduledShiftId),
      ).toEqual([shifts.first, shifts.second]);
      expect(view.signInOptions[0]).toMatchObject({
        workDate: '2027-03-02',
        timezone: 'America/Toronto',
        signIn: null,
      });

      // The employee confirms the second one, although the first is nearer.
      const second = await signIn(h, {
        scheduledShiftId: shifts.second,
        idempotencyKey: 'second-session-key',
      });
      expect(second).toMatchObject({
        outcome: 'SIGNED_IN',
        signIn: { scheduledShiftId: shifts.second, workDate: '2027-03-02' },
      });
      view = await status(h);
      expect(
        view.signInOptions.find(
          (option) => option.scheduledShiftId === shifts.second,
        )?.signIn?.id,
      ).toBe(second.signIn.id);
      // Optional sign-out is off by default: not offered.
      expect(view.availableActions).not.toContain('SIGN_OUT');

      // Batch 4F (D2): without a choice, a tap right after confirming one occurrence is the
      // same arrival (duplicate window), never a silent sign-in for the other one.
      expect(await signIn(h)).toMatchObject({
        outcome: 'ALREADY_SIGNED_IN',
        signIn: { id: second.signIn.id },
      });
      // Choosing the other occurrence explicitly records it.
      const first = await signIn(h, { scheduledShiftId: shifts.first });
      expect(first.signIn.scheduledShiftId).toBe(shifts.first);

      // Choosing a confirmed occurrence again answers with its sign-in, never a second one.
      expect(
        await signIn(h, {
          scheduledShiftId: shifts.first,
          idempotencyKey: 'first-again-key',
        }),
      ).toMatchObject({
        outcome: 'ALREADY_SIGNED_IN',
        signIn: { id: first.signIn.id },
      });
      // A key names one occurrence: replayed for it, refused for another.
      expect(
        await signIn(h, {
          scheduledShiftId: shifts.second,
          idempotencyKey: 'second-session-key',
        }),
      ).toMatchObject({
        outcome: 'ALREADY_SIGNED_IN',
        signIn: { id: second.signIn.id },
      });
      expect(
        body(
          await rejection(
            signIn(h, {
              scheduledShiftId: shifts.first,
              idempotencyKey: 'second-session-key',
            }),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_IDEMPOTENCY_KEY_REUSED' });
      expect(
        await tx.attendanceSignIn.count({
          where: { employeeId: h.fx.employee1, status: 'ACTIVE' },
        }),
      ).toBe(2);

      // Sign-out appears only once the policy enables it (a minute later: the offer is exactly
      // the sign-in the action closes, one strictly before now; Batch 4F, D3).
      clock.value = toronto('2027-03-02T13:21');
      await tx.timeAttendancePolicy.update({
        where: { id: h.layerId },
        data: {
          config: {
            attendance: {
              trackingMode: 'SIGN_IN_ONLY',
              captureMode: 'KIOSK_OR_SELF_SERVICE',
              signOutEnabled: true,
            },
          },
        },
      });
      expect((await status(h)).availableActions).toContain('SIGN_OUT');
    });
  });

  it('requires an explicit occurrence once the duplicate window has passed, never confirming another silently (4F, D2)', async () => {
    await scenario(async (h) => {
      const { clock, shifts, tx } = h;
      await tx.timeAttendancePolicy.update({
        where: { id: h.layerId },
        data: {
          config: {
            attendance: {
              trackingMode: 'SIGN_IN_ONLY',
              captureMode: 'KIOSK_OR_SELF_SERVICE',
              signInDuplicateWindowMinutes: 5,
            },
          },
        },
      });
      clock.value = toronto('2027-03-02T13:20');
      const second = await signIn(h, { scheduledShiftId: shifts.second });
      // Inside the window: the same arrival.
      clock.value = toronto('2027-03-02T13:24');
      expect(await signIn(h)).toMatchObject({
        outcome: 'ALREADY_SIGNED_IN',
        signIn: { id: second.signIn.id },
      });
      // After it, while the other occurrence is still open: a choice is required.
      clock.value = toronto('2027-03-02T13:26');
      expect(body(await rejection(signIn(h)))).toMatchObject({
        code: 'ATTENDANCE_OCCURRENCE_CHOICE_REQUIRED',
      });
      expect(
        await tx.attendanceSignIn.count({
          where: { employeeId: h.fx.employee1, status: 'ACTIVE' },
        }),
      ).toBe(1);
      // The explicit choice is recorded.
      expect(await signIn(h, { scheduledShiftId: shifts.first })).toMatchObject(
        {
          outcome: 'SIGNED_IN',
          signIn: { scheduledShiftId: shifts.first },
        },
      );
    });
  });

  it('refuses foreign, closed, cancelled and other-assignment occurrences, and any remote sign-in on kiosk-only work (C7)', async () => {
    await scenario(async (h) => {
      const { clock, shifts, tx } = h;
      clock.value = toronto('2027-03-02T13:20');
      for (const scheduledShiftId of [
        shifts.foreign, // Employee 2's
        shifts.evening, // not open yet
        shifts.cancelled,
        shifts.timedMorning, // another assignment of the same employee
        randomUUID(),
      ]) {
        expect(
          body(await rejection(signIn(h, { scheduledShiftId }))),
        ).toMatchObject({
          code: 'SCHEDULED_SHIFT_NOT_ELIGIBLE',
          message: 'That occurrence is not open for sign-in now.',
        });
      }
      // Kiosk only: no option, no remote sign-in, chosen or not.
      await tx.timeAttendancePolicy.update({
        where: { id: h.layerId },
        data: {
          config: {
            attendance: {
              trackingMode: 'SIGN_IN_ONLY',
              captureMode: 'KIOSK_ONLY',
            },
          },
        },
      });
      const view = await status(h);
      expect(view.signInOptions).toEqual([]);
      expect(view.availableActions).not.toContain('SIGN_IN');
      for (const input of [{ scheduledShiftId: shifts.first }, {}]) {
        expect(body(await rejection(signIn(h, input)))).toMatchObject({
          code: 'ATTENDANCE_CAPTURE_KIOSK_ONLY',
        });
      }
      expect(
        await tx.attendanceSignIn.count({
          where: { employeeId: h.fx.employee1 },
        }),
      ).toBe(0);
    });
  });

  it('dates a sign-in for an overnight occurrence by the occurrence, and unscheduled ones by the local date (C9)', async () => {
    await scenario(async (h) => {
      const { clock, shifts } = h;
      clock.value = toronto('2027-03-03T00:10');
      const overnight = await signIn(h);
      expect(overnight.signIn).toMatchObject({
        scheduledShiftId: shifts.overnight,
        workDate: '2027-03-02',
      });
      // Chosen explicitly while still open: already confirmed, the same sign-in.
      clock.value = toronto('2027-03-03T00:20');
      expect(
        await signIn(h, { scheduledShiftId: shifts.overnight }),
      ).toMatchObject({ outcome: 'ALREADY_SIGNED_IN' });
      // Unscheduled (no occurrence open): the local date, as before.
      clock.value = toronto('2027-03-03T04:30');
      const unscheduled = await signIn(h);
      expect(unscheduled.signIn).toMatchObject({
        scheduledShiftId: null,
        workDate: '2027-03-03',
      });
    });
  });

  it('shows each published shift with what attendance recorded, never early, never as hours (C8)', async () => {
    await scenario(async (h) => {
      const { clock, shifts, tx, fx, svc } = h;
      const expected = async () => {
        const result = await h.signIns.myExpectedAttendance(fx.selfUser1, {
          from: '2027-03-01',
          to: '2027-03-03',
        });
        return new Map(
          result.items.map((item) => [item.scheduledShiftId, item]),
        );
      };

      // 13:02: the first session confirmed on time; the second not started; the timed
      // afternoon shift not started either.
      clock.value = toronto('2027-03-02T13:02');
      await signIn(h, { scheduledShiftId: shifts.first });
      let view = await expected();
      expect(view.get(shifts.first)).toMatchObject({
        status: 'ATTENDED',
        trackingMode: 'SIGN_IN_ONLY',
        workDate: '2027-03-02',
        minutesAfterStart: 2,
      });
      expect(view.get(shifts.second)?.status).toBe('UPCOMING');
      expect(view.get(shifts.cancelled)).toMatchObject({
        status: 'CANCELLED',
        shiftStatus: 'CANCELLED',
      });
      expect(view.get(shifts.timedMorning)).toMatchObject({
        status: 'NOT_RECORDED',
        trackingMode: 'TIME_CLOCK',
      });
      expect(view.get(shifts.foreign)).toBeUndefined();

      // 13:55: ten minutes late for the second session (grace 5).
      clock.value = toronto('2027-03-02T13:55');
      await signIn(h, { scheduledShiftId: shifts.second });
      // 15:05: clocked in for the timed afternoon shift (linked automatically).
      clock.value = toronto('2027-03-02T15:05');
      view = await expected();
      expect(view.get(shifts.second)).toMatchObject({
        status: 'LATE',
        minutesAfterStart: 10,
      });
      expect(view.get(shifts.timedAfternoon)?.status).toBe('DUE');
      expect(view.get(shifts.evening)?.status).toBe('UPCOMING');
      await svc.time.clockIn(
        fx.selfUser1,
        fx.assignmentDeptB,
        ctx(fx.selfUser1),
      );
      clock.value = toronto('2027-03-02T17:00');
      await svc.time.clockOut(fx.selfUser1, ctx(fx.selfUser1));

      // A recorded no-show (the gated detection) makes the early timed shift missing.
      const revision = await tx.scheduledShiftRevision.findFirstOrThrow({
        where: { scheduledShiftId: shifts.timedEarly },
        orderBy: { revisionNumber: 'desc' },
      });
      await tx.attendanceException.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentDeptB,
          scheduledShiftId: shifts.timedEarly,
          scheduledShiftRevisionId: revision.id,
          type: 'NO_SHOW',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
          status: 'OPEN',
          detectedAt: toronto('2027-03-02T08:30'),
        },
      });

      // The first session moves after it was attended.
      await svc.scheduling.correctShift(
        h.scheduleId,
        shifts.first,
        {
          startsAt: '2027-03-02T13:15:00-05:00',
          endsAt: '2027-03-02T13:45:00-05:00',
          reason: 'Moved',
        },
        ctx(fx.users.admin!),
      );

      // 20:00: the evening session ended unconfirmed (missing); the overnight one is ahead.
      clock.value = toronto('2027-03-02T20:00');
      view = await expected();
      expect(view.get(shifts.evening)?.status).toBe('MISSING');
      expect(view.get(shifts.overnight)).toMatchObject({
        status: 'UPCOMING',
        workDate: '2027-03-02',
      });
      expect(view.get(shifts.timedAfternoon)).toMatchObject({
        status: 'ATTENDED',
        timeEntries: [expect.objectContaining({ status: 'CLOSED' }) as unknown],
      });
      expect(view.get(shifts.timedEarly)?.status).toBe('MISSING');
      expect(view.get(shifts.timedMorning)?.status).toBe('NOT_RECORDED');
      expect(view.get(shifts.timedTomorrow)?.status).toBe('UPCOMING');
      expect(view.get(shifts.first)).toMatchObject({
        status: 'CHANGED_AFTER_ATTENDANCE',
        revisionNumber: 2,
      });
      // Presence never carries minutes worked.
      expect(JSON.stringify([...view.values()])).not.toMatch(
        /payableMinutes|netWorkedMinutes|grossMinutes/,
      );

      // At most 31 days; only the caller's own shifts.
      expect(
        await rejection(
          h.signIns.myExpectedAttendance(fx.selfUser1, {
            from: '2027-01-01',
            to: '2027-03-03',
          }),
        ),
      ).toBeInstanceOf(HttpException);
      const other = await h.signIns.myExpectedAttendance(fx.selfUser2, {
        from: '2027-03-01',
        to: '2027-03-03',
      });
      expect(other.items.map((item) => item.scheduledShiftId)).toEqual([
        shifts.foreign,
      ]);
    });
  });
  it('reports a shift covered by an approved absence as excused, never missing (C8, review)', async () => {
    await scenario(async (h) => {
      const { tx, fx, shifts } = h;
      const leaveType = await tx.leaveType.create({
        data: {
          organizationId: fx.orgA,
          code: `VAC-${fx.suffix}`,
          name: 'Vacation',
          classification: 'PAID',
        },
      });
      const account = await tx.leaveAccount.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          leaveTypeId: leaveType.id,
        },
      });
      // Approved leave covering the evening session and the timed morning shift (not the
      // first session): two approved requests on the same day.
      const requests: string[] = [];
      for (const [from, to] of [
        ['08:30', '12:30'],
        ['18:00', '19:30'],
      ] as const) {
        const request = await tx.leaveRequest.create({
          data: {
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentTeamA,
            leaveTypeId: leaveType.id,
            accountId: account.id,
            status: 'APPROVED',
            startDate: new Date('2027-03-02T00:00:00.000Z'),
            endDate: new Date('2027-03-02T00:00:00.000Z'),
            timezone: 'America/Toronto',
            requestedMinutes: 120,
            approvedMinutes: 120,
            requestedByUserId: fx.selfUser1,
            decidedByUserId: fx.users.timeManager!,
            decidedAt: toronto('2027-02-20T12:00'),
            submittedAt: toronto('2027-02-19T12:00'),
          },
        });
        requests.push(request.id);
        await tx.leaveRequestDay.create({
          data: {
            requestId: request.id,
            date: new Date('2027-03-02T00:00:00.000Z'),
            minutes: 120,
            amountSource: 'STANDARD_DAY',
            windowStart: toronto(`2027-03-02T${from}`),
            windowEnd: toronto(`2027-03-02T${to}`),
            absenceStart: toronto(`2027-03-02T${from}`),
            absenceEnd: toronto(`2027-03-02T${to}`),
          },
        });
      }
      // A recorded no-show on the excused timed shift does not make it missing either.
      const revision = await tx.scheduledShiftRevision.findFirstOrThrow({
        where: { scheduledShiftId: shifts.timedMorning },
        orderBy: { revisionNumber: 'desc' },
      });
      await tx.attendanceException.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentDeptB,
          scheduledShiftId: shifts.timedMorning,
          scheduledShiftRevisionId: revision.id,
          type: 'NO_SHOW',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
          status: 'OPEN',
          detectedAt: toronto('2027-03-02T09:30'),
        },
      });
      h.clock.value = toronto('2027-03-02T20:00');
      const view = new Map(
        (
          await h.signIns.myExpectedAttendance(fx.selfUser1, {
            from: '2027-03-02',
            to: '2027-03-02',
          })
        ).items.map((item) => [item.scheduledShiftId, item.status]),
      );
      expect(view.get(shifts.evening)).toBe('EXCUSED');
      expect(view.get(shifts.timedMorning)).toBe('EXCUSED');
      // Not covered by the absence: still missing once ended (presence rule).
      expect(view.get(shifts.first)).toBe('MISSING');
      // The leave itself is untouched.
      expect(
        (
          await tx.leaveRequest.findMany({ where: { id: { in: requests } } })
        ).map((item) => item.status),
      ).toEqual(['APPROVED', 'APPROVED']);
    });
  });

  it('dates a manager-recorded sign-in after midnight by its overnight occurrence (C9, review)', async () => {
    await scenario(async (h) => {
      const { fx, shifts, clock } = h;
      clock.value = toronto('2027-03-03T09:00');
      const recorded = await h.signIns.recordManual(
        fx.users.timeManager!,
        {
          employmentAssignmentId: fx.assignmentTeamA,
          signedInAt: '2027-03-03T00:20',
          reason: 'Kiosk was offline overnight',
          scheduledShiftId: shifts.overnight,
        },
        ctx(fx.users.timeManager!),
      );
      expect(recorded.signIn).toMatchObject({
        source: 'MANUAL',
        scheduledShiftId: shifts.overnight,
        // The occurrence's date, not the sign-in's local calendar date (March 3).
        workDate: '2027-03-02',
        signedInAt: toronto('2027-03-03T00:20').toISOString(),
      });
      // An unlinked manual record keeps its local date, as before.
      const unlinked = await h.signIns.recordManual(
        fx.users.timeManager!,
        {
          employmentAssignmentId: fx.assignmentTeamA,
          signedInAt: '2027-03-03T05:00',
          reason: 'Unscheduled visit',
        },
        ctx(fx.users.timeManager!),
      );
      expect(unlinked.signIn).toMatchObject({
        scheduledShiftId: null,
        workDate: '2027-03-03',
      });
    });
  });

  it('never offers or accepts a remote sign-out on kiosk-only work, while the kiosk can sign out (review)', async () => {
    await scenario(async (h) => {
      const { tx, fx, clock, kiosk } = h;
      await tx.timeAttendancePolicy.update({
        where: { id: h.layerId },
        data: {
          config: {
            attendance: {
              trackingMode: 'SIGN_IN_ONLY',
              captureMode: 'KIOSK_ONLY',
              signOutEnabled: true,
            },
          },
        },
      });
      clock.value = toronto('2027-03-02T13:05');
      const signedIn = await h.signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        undefined,
        {},
      );
      expect(signedIn.outcome).toBe('SIGNED_IN');
      clock.value = toronto('2027-03-02T13:40');
      const view = (await h.svc.time.status(fx.selfUser1)) as unknown as {
        availableActions: string[];
        signOutAssignments: unknown[];
      };
      expect(view.availableActions).not.toContain('SIGN_OUT');
      expect(view.signOutAssignments).toEqual([]);
      expect(
        body(
          await rejection(
            h.signIns.selfSignOut(
              fx.selfUser1,
              { employmentAssignmentId: fx.assignmentTeamA },
              ctx(fx.selfUser1),
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_CAPTURE_KIOSK_ONLY' });
      expect(
        await tx.attendanceSignOut.count({
          where: { employeeId: fx.employee1 },
        }),
      ).toBe(0);
      // The kiosk still signs out.
      const out = await h.signIns.kioskSignOut(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        undefined,
        {},
      );
      expect(out).toMatchObject({
        outcome: 'SIGNED_OUT',
        signOut: { signInId: signedIn.signIn.id, source: 'KIOSK' },
      });
    });
  });
});
