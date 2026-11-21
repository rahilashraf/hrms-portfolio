import { ForbiddenException, HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
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
  // Employee 1 also holds time.correct, to prove one's own attendance is never corrected.
  self1: [
    { permissions: ['time.clock', 'time.correct'], scope: 'org' as const },
  ],
  timeManager: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
  deptBViewer: [
    { permissions: ['time.view', 'time.correct'], scope: 'deptB' as const },
  ],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  svc: ReturnType<typeof timeServices>;
  signIns: AttendanceSignInService;
  kiosk: KioskDevice;
  /** Published Noon (13:00–13:30), Afternoon (16:30–17:00) and Evening (18:30–19:00) on 2027-03-02. */
  sessions: { noon: string; afternoon: string; evening: string };
  scheduleId: string;
}

const body = (error: unknown) => (error as HttpException).getResponse();

/**
 * Phase 9.5 — SIGN_IN_ONLY presence: completed sign-ins (never time entries, never minutes),
 * optionally linked to the published occurrence they attended, several per day, duplicates
 * returned rather than recorded, presence signals only, and corrections by void-and-replace.
 */
describe('Attendance sign-ins (database)', () => {
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
          // Employee 1's Team A assignment (the hall assistant) tracks presence by sign-in.
          await tx.timeAttendancePolicy.create({
            data: {
              scopeType: 'EMPLOYMENT_ASSIGNMENT',
              employmentAssignmentId: fx.assignmentTeamA,
              effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
              config: {
                attendance: {
                  trackingMode: 'SIGN_IN_ONLY',
                  captureMode: 'KIOSK_OR_SELF_SERVICE',
                  signInDuplicateWindowMinutes: 10,
                },
                attendanceInterpretation: {
                  lateArrivalEnabled: true,
                  lateGraceMinutes: 5,
                },
              },
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
          );
          const admin = ctx(fx.users.admin!);
          const schedule = await svc.scheduling.createSchedule(
            {
              scopeType: 'DEPARTMENT',
              organizationId: fx.orgA,
              departmentId: fx.deptA,
              name: 'Sessions',
              type: 'AD_HOC',
              periodStart: '2027-03-01',
              periodEnd: '2027-03-07',
            },
            admin,
          );
          const shift = (start: string, end: string) =>
            svc.scheduling.createShift(
              schedule.id,
              torontoShift(fx.assignmentTeamA, '2027-03-02', start, end),
              admin,
            );
          const sessions = {
            noon: (await shift('13:00', '13:30')).id,
            afternoon: (await shift('16:30', '17:00')).id,
            evening: (await shift('18:30', '19:00')).id,
          };
          await svc.scheduling.publishSchedule(schedule.id, admin);
          const device = await tx.attendanceDevice.create({
            data: {
              organizationId: fx.orgA,
              physicalSiteId: fx.physicalSiteToronto,
              name: 'Hall entrance',
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
            kiosk: {
              id: device.id,
              organizationId: fx.orgA,
              physicalSiteId: fx.physicalSiteToronto,
            },
            sessions,
            scheduleId: schedule.id,
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('records each session as its own completed sign-in, linked to its published occurrence', async () => {
    await scenario(async ({ tx, fx, clock, signIns, kiosk, sessions }) => {
      const at = async (local: string) => {
        clock.value = toronto(local);
        return signIns.kioskSignIn(
          kiosk,
          fx.employee1,
          fx.assignmentTeamA,
          undefined,
          {},
        );
      };
      const noon = await at('2027-03-02T12:55');
      const afternoon = await at('2027-03-02T16:50'); // 20 minutes late (grace 5)
      const evening = await at('2027-03-02T18:31');
      expect(
        [noon, afternoon, evening].map((r) => [
          r.outcome,
          r.signIn.scheduledShiftId,
        ]),
      ).toEqual([
        ['SIGNED_IN', sessions.noon],
        ['SIGNED_IN', sessions.afternoon],
        ['SIGNED_IN', sessions.evening],
      ]);
      expect(noon.signIn).toMatchObject({
        source: 'KIOSK',
        attendanceDeviceId: kiosk.id,
        workDate: '2027-03-02',
        timezone: 'America/Toronto',
        status: 'ACTIVE',
      });
      expect(afternoon.exceptions).toEqual(['LATE_SIGN_IN']);
      expect(noon.exceptions).toEqual([]);
      // No time entry, no punches: presence is never duration.
      expect(
        await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(0);
      expect(
        await tx.timePunch.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(0);
      const late = await tx.attendanceException.findFirstOrThrow({
        where: { attendanceSignInId: afternoon.signIn.id },
      });
      expect(late).toMatchObject({
        type: 'LATE_SIGN_IN',
        severity: 'REVIEW',
        workflowImpact: 'NON_BLOCKING',
      });
      expect(late.metadata).toMatchObject({ minutesLate: 20 });
    });
  });

  it('returns the first sign-in for retries, the same occurrence and quick unscheduled repeats', async () => {
    await scenario(async ({ tx, fx, clock, signIns, kiosk, sessions }) => {
      clock.value = toronto('2027-03-02T12:58');
      const first = await signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        'interaction-0001',
        {},
      );
      // A retried request with the same key.
      const retried = await signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        'interaction-0001',
        {},
      );
      expect(retried).toMatchObject({
        outcome: 'ALREADY_SIGNED_IN',
        signIn: { id: first.signIn.id },
      });
      // A second tap (new interaction) for the same occurrence.
      clock.value = toronto('2027-03-02T13:05');
      const again = await signIns.selfSignIn(
        fx.selfUser1,
        { employmentAssignmentId: fx.assignmentTeamA },
        ctx(fx.selfUser1),
      );
      expect(again).toMatchObject({
        outcome: 'ALREADY_SIGNED_IN',
        signIn: { id: first.signIn.id },
      });
      // A re-tap just after a shift's sign-in window closed (Afternoon ends 17:00) is the same
      // arrival, not a second, unscheduled one.
      clock.value = toronto('2027-03-02T16:59');
      const afternoon = await signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        undefined,
        {},
      );
      expect(afternoon.signIn.scheduledShiftId).toBe(sessions.afternoon);
      clock.value = toronto('2027-03-02T17:02');
      expect(
        await signIns.kioskSignIn(
          kiosk,
          fx.employee1,
          fx.assignmentTeamA,
          undefined,
          {},
        ),
      ).toMatchObject({
        outcome: 'ALREADY_SIGNED_IN',
        signIn: { id: afternoon.signIn.id },
      });
      // Unscheduled (a program at 21:00): recorded once, flagged (WARN); a repeat within 10
      // minutes returns it; after the window a new sign-in is a new occurrence.
      clock.value = toronto('2027-03-02T21:00');
      const program = await signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        undefined,
        {},
      );
      expect(program).toMatchObject({
        outcome: 'SIGNED_IN',
        signIn: { scheduledShiftId: null },
      });
      expect(program.exceptions).toEqual(['UNSCHEDULED_SIGN_IN']);
      clock.value = toronto('2027-03-02T21:08');
      expect(
        (
          await signIns.kioskSignIn(
            kiosk,
            fx.employee1,
            fx.assignmentTeamA,
            undefined,
            {},
          )
        ).signIn.id,
      ).toBe(program.signIn.id);
      clock.value = toronto('2027-03-02T21:30');
      expect(
        (
          await signIns.kioskSignIn(
            kiosk,
            fx.employee1,
            fx.assignmentTeamA,
            undefined,
            {},
          )
        ).outcome,
      ).toBe('SIGNED_IN');
      expect(
        await tx.attendanceSignIn.count({
          where: { employeeId: fx.employee1 },
        }),
      ).toBe(4);
    });
  });

  it('refuses unscheduled sign-ins where a published shift is required, and clock actions on presence', async () => {
    await scenario(async ({ tx, fx, clock, svc, signIns, kiosk }) => {
      await tx.schedulePolicy.create({
        data: {
          scopeType: 'TEAM',
          organizationId: fx.orgA,
          teamId: fx.teamA,
          effectiveFrom: new Date('2026-06-01T00:00:00Z'),
          unscheduledWorkMode: 'REQUIRE_SCHEDULED_SHIFT',
        },
      });
      clock.value = toronto('2027-03-02T21:00');
      expect(
        body(
          await rejection(
            signIns.kioskSignIn(
              kiosk,
              fx.employee1,
              fx.assignmentTeamA,
              undefined,
              {},
            ),
          ),
        ),
      ).toMatchObject({ code: 'SCHEDULED_SHIFT_REQUIRED' });
      // A TIME_CLOCK assignment cannot be signed in for; a SIGN_IN_ONLY one cannot be clocked.
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'America/Toronto' },
      });
      expect(
        body(
          await rejection(
            signIns.selfSignIn(
              fx.selfUser1,
              { employmentAssignmentId: fx.assignmentDeptB },
              ctx(fx.selfUser1),
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_TRACKING_MODE_MISMATCH' });
      expect(
        body(
          await rejection(
            svc.time.clockIn(
              fx.selfUser1,
              fx.assignmentTeamA,
              ctx(fx.selfUser1),
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_TRACKING_MODE_MISMATCH' });
      // Status offers the sign-in, not clocking, for the hall assistant assignment.
      clock.value = toronto('2027-03-02T12:58');
      const status = await svc.time.status(fx.selfUser1);
      expect(status.availableActions).toContain('SIGN_IN');
      expect(status.signInAssignments.map((a: { id: string }) => a.id)).toEqual(
        [fx.assignmentTeamA],
      );
      expect(
        status.eligibleAssignments.map((a: { id: string }) => a.id),
      ).not.toContain(fx.assignmentTeamA);
    });
  });

  it('never produces minutes or clock exceptions, and exposes presence facts without duration', async () => {
    await scenario(async ({ tx, fx, clock, svc, signIns, kiosk }) => {
      clock.value = toronto('2027-03-02T12:58');
      const signIn = await signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        undefined,
        {},
      );
      // The missed clock-out scan never sees presence.
      clock.value = toronto('2027-03-03T12:00');
      await svc.time.scanOpenTimeEntriesForExceptions();
      expect(
        await tx.attendanceException.count({
          where: {
            employeeId: fx.employee1,
            type: { in: ['MISSING_CLOCK_OUT', 'AUTO_CLOSED_CLOCK_OUT'] },
          },
        }),
      ).toBe(0);
      // A timesheet for the week carries no minutes for the sign-in-only assignment.
      await svc.time.generateTimePeriods(
        fx.users.timeManager!,
        { organizationId: fx.orgA, startDate: '2027-03-01', cadence: 'WEEKLY' },
        ctx(fx.users.timeManager!),
      );
      const period = await tx.timePeriod.findFirstOrThrow({
        where: { organizationId: fx.orgA },
      });
      const sheet = await svc.time.materializeTimesheetForEmployeePeriod(
        fx.employee1,
        period.id,
      );
      expect(
        await tx.timesheetSegment.count({ where: { timesheetId: sheet.id } }),
      ).toBe(0);
      const facts = await signIns.presenceFactsBetween({
        employmentAssignmentId: fx.assignmentTeamA,
        from: '2027-03-01',
        to: '2027-03-07',
      });
      expect(facts).toEqual([
        {
          signInId: signIn.signIn.id,
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          workDate: '2027-03-02',
          signedInAt: toronto('2027-03-02T12:58').toISOString(),
          timezone: 'America/Toronto',
          source: 'KIOSK',
          scheduledShiftId: signIn.signIn.scheduledShiftId,
          scheduledShiftRevisionId: signIn.signIn.scheduledShiftRevisionId,
        },
      ]);
      expect(Object.keys(facts[0]!)).not.toContain('minutes');
    });
  });

  it('corrects by void-and-replace, with reasons, never for oneself, and scoped', async () => {
    await scenario(async ({ tx, fx, clock, signIns, kiosk, sessions }) => {
      const manager = ctx(fx.users.timeManager!);
      clock.value = toronto('2027-03-02T16:50');
      const afternoon = await signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        undefined,
        {},
      );
      expect(afternoon.exceptions).toEqual(['LATE_SIGN_IN']);
      // Forgot the kiosk at Noon: a manager records it (MANUAL, linked to the occurrence).
      clock.value = toronto('2027-03-02T20:00');
      const recorded = await signIns.recordManual(
        fx.users.timeManager!,
        {
          employmentAssignmentId: fx.assignmentTeamA,
          signedInAt: '2027-03-02T12:59',
          reason: 'Kiosk was offline at Noon',
        },
        manager,
      );
      expect(recorded.signIn).toMatchObject({
        source: 'MANUAL',
        attendanceDeviceId: null,
        recordedByUserId: fx.users.timeManager,
        scheduledShiftId: sessions.noon,
      });
      // The Afternoon time was wrong: corrected (void + linked replacement); the late signal goes.
      const corrected = await signIns.correctSignIn(
        fx.users.timeManager!,
        afternoon.signIn.id,
        {
          signedInAt: '2027-03-02T16:31',
          reason: 'Signed in on time; kiosk queue',
        },
        manager,
      );
      expect(corrected).toMatchObject({
        replaced: afternoon.signIn.id,
        exceptions: [],
      });
      const original = await tx.attendanceSignIn.findUniqueOrThrow({
        where: { id: afternoon.signIn.id },
      });
      expect(original).toMatchObject({
        status: 'VOIDED',
        voidedByUserId: fx.users.timeManager,
      });
      expect(
        (
          await tx.attendanceException.findFirstOrThrow({
            where: { attendanceSignInId: afternoon.signIn.id },
          })
        ).status,
      ).toBe('SUPERSEDED');
      expect(corrected.signIn).toMatchObject({
        source: 'MANUAL',
        replacesSignInId: afternoon.signIn.id,
        scheduledShiftId: sessions.afternoon,
      });
      // An accidental duplicate is voided with a reason.
      await signIns.voidSignIn(
        fx.users.timeManager!,
        recorded.signIn.id,
        'Recorded twice',
        manager,
      );
      // Never one's own attendance; never without time.correct in scope; never in the future.
      expect(
        body(
          await rejection(
            signIns.voidSignIn(
              fx.selfUser1,
              corrected.signIn.id,
              'mine',
              ctx(fx.selfUser1),
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_SELF_CORRECTION' });
      expect(
        await rejection(
          signIns.voidSignIn(
            fx.users.deptBViewer!,
            corrected.signIn.id,
            'x',
            ctx(fx.users.deptBViewer!),
          ),
        ),
      ).toBeInstanceOf(ForbiddenException);
      expect(
        body(
          await rejection(
            signIns.recordManual(
              fx.users.timeManager!,
              {
                employmentAssignmentId: fx.assignmentTeamA,
                signedInAt: '2027-03-03T12:00',
                reason: 'Later',
              },
              manager,
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_SIGN_IN_IN_FUTURE' });
      // Managers see the scoped list; a Dept B viewer sees none of Team A.
      const listed = await signIns.managedSignIns(fx.users.timeManager!, {
        organizationId: fx.orgA,
        from: '2027-03-01',
        to: '2027-03-07',
        includeVoided: true,
      });
      expect(listed.items.map((item) => item.source).sort()).toEqual([
        'KIOSK',
        'MANUAL',
        'MANUAL',
      ]);
      expect(
        (
          await signIns.managedSignIns(fx.users.deptBViewer!, {
            organizationId: fx.orgA,
            from: '2027-03-01',
            to: '2027-03-07',
          })
        ).items,
      ).toEqual([]);
      expect(
        await tx.auditLog.count({
          where: {
            action: {
              in: [
                'ATTENDANCE_SIGN_IN_RECORDED',
                'ATTENDANCE_SIGN_IN_CORRECTED',
                'ATTENDANCE_SIGN_IN_VOIDED',
              ],
            },
          },
        }),
      ).toBeGreaterThanOrEqual(3);
    });
  });

  it('reports expected occurrences as signed in, missing or pending, and flags schedule changes', async () => {
    await scenario(
      async ({ fx, clock, svc, signIns, kiosk, sessions, scheduleId, tx }) => {
        clock.value = toronto('2027-03-02T12:58');
        const noon = await signIns.kioskSignIn(
          kiosk,
          fx.employee1,
          fx.assignmentTeamA,
          undefined,
          {},
        );
        // At 17:10: Noon attended, Afternoon (ended 17:00) missing, Evening pending.
        clock.value = toronto('2027-03-02T17:10');
        const report = await signIns.expectedSignIns(fx.users.timeManager!, {
          organizationId: fx.orgA,
          from: '2027-03-02',
          to: '2027-03-02',
        });
        expect(
          report.items.map((row) => [row.scheduledShiftId, row.status]),
        ).toEqual([
          [sessions.noon, 'SIGNED_IN'],
          [sessions.afternoon, 'MISSING'],
          [sessions.evening, 'PENDING'],
        ]);
        // Scheduling corrects Noon after the sign-in: the sign-in gets a review signal and keeps
        // the revision it attended.
        await svc.scheduling.correctShift(
          scheduleId,
          sessions.noon,
          {
            startsAt: '2027-03-02T13:15:00-05:00',
            endsAt: '2027-03-02T13:45:00-05:00',
            reason: 'Session time moved',
          },
          ctx(fx.users.admin!),
        );
        const signal = await tx.attendanceException.findFirstOrThrow({
          where: {
            attendanceSignInId: noon.signIn.id,
            type: 'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
          },
        });
        expect(signal).toMatchObject({
          status: 'OPEN',
          workflowImpact: 'NON_BLOCKING',
        });
        expect(
          (
            await tx.attendanceSignIn.findUniqueOrThrow({
              where: { id: noon.signIn.id },
            })
          ).scheduledShiftRevisionId,
        ).toBe(noon.signIn.scheduledShiftRevisionId);
      },
    );
  });
});
