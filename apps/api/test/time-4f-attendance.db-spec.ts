import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { sha256 } from '../src/kiosk/kiosk-secrets.js';
import { RedisService } from '../src/redis/redis.service.js';
import { TimeService } from '../src/time/time.service.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  torontoShift,
  ALL_SCHEDULE_PERMISSIONS,
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
import { withTimeHttp, type TimeHttp } from './support/time-http.js';
import {
  grantMinutes,
  LEAVE_PERMISSIONS,
  LEAVE_USERS,
  leaveServices,
  seedLeaveConfig,
} from './support/leave-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const ORIGIN = 'http://web.time-spec.test';

const USERS = {
  /** Employee 1: clocks and requests leave; HR approves leave. */
  self1: LEAVE_USERS.self1,
  hr: LEAVE_USERS.hr,
  admin: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'org' as const }],
  managerA: [
    {
      permissions: [
        ...TIME_PERMISSIONS,
        'time.device.manage',
        'time.credential.manage',
      ],
      scope: 'org' as const,
    },
  ],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  http: TimeHttp;
  svc: ReturnType<typeof timeServices>;
  /** Team A presence sessions (Employee 1): two on Tuesday 2027-03-02, one on Wednesday. */
  shifts: { first: string; second: string; nextDay: string };
  layerId: string;
}

/**
 * Batch 4F — presence attendance hardening:
 *
 * - D2 / Q4: a kiosk offers one explicit choice per occurrence when several are open, records the
 *   one chosen, and a second tap never confirms another occurrence silently;
 * - D3: sign-out is offered exactly when the sign-out action has something to close;
 * - D7 / Q5: presence-only (SIGN_IN_ONLY) shifts get no-show review flags on the same opt-in,
 *   grace, excused, cancelled and idempotency rules, and never any minutes.
 */
describe(
  'Batch 4F presence attendance (database, HTTP)',
  { timeout: 180_000 },
  () => {
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
      presenceConfig: Record<string, unknown> = {},
    ) {
      await expect(
        prisma.$transaction(
          async (tx) => {
            const fx = await createSchedulingFixtures(tx, USERS, [
              ...TIME_PERMISSIONS,
              ...ALL_SCHEDULE_PERMISSIONS,
              'time.device.manage',
              'time.credential.manage',
              ...LEAVE_PERMISSIONS,
            ]);
            await tx.organization.update({
              where: { id: fx.orgA },
              data: { timezone: 'America/Toronto' },
            });
            await seedTimePolicy(tx, fx.orgA);
            const layer = await tx.timeAttendancePolicy.create({
              data: {
                scopeType: 'EMPLOYMENT_ASSIGNMENT',
                employmentAssignmentId: fx.assignmentTeamA,
                effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
                config: {
                  attendance: {
                    trackingMode: 'SIGN_IN_ONLY',
                    captureMode: 'KIOSK_OR_SELF_SERVICE',
                    signInDuplicateWindowMinutes: 5,
                    ...presenceConfig,
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
            const svc = timeServices(rollbackClient(tx), clock);
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
              start: string,
              end: string,
              day = '2027-03-02',
            ) =>
              (
                await svc.scheduling.createShift(
                  schedule.id,
                  torontoShift(fx.assignmentTeamA, day, start, end, '-05:00'),
                  admin,
                )
              ).id;
            const shifts = {
              first: await shift('13:00', '13:30'),
              second: await shift('13:45', '14:15'),
              nextDay: await shift('13:00', '13:30', '2027-03-03'),
            };
            await svc.scheduling.publishSchedule(schedule.id, admin);
            await withTimeHttp(tx, clock, async (http) => {
              try {
                await run({
                  tx,
                  fx,
                  clock,
                  http,
                  svc,
                  shifts,
                  layerId: layer.id,
                });
              } catch (error) {
                console.error('SCENARIO FAILURE', error);
                throw error;
              }
            });
            throw new RollbackFixtures();
          },
          { timeout: 150_000 },
        ),
      ).rejects.toBeInstanceOf(RollbackFixtures);
    }

    /** An enrolled kiosk of Organization A and Employee 1's PIN. */
    async function enrolledKiosk(h: Harness) {
      const { fx, http, tx } = h;
      const admin = await http.as(fx.users.managerA!);
      const redis = http.app.get(RedisService);
      for (const address of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
        await redis.client.del(`kiosk:rate:enroll:${sha256(address)}`);
      }
      const registered = await admin
        .post('/time/devices', {
          organizationId: fx.orgA,
          physicalSiteId: fx.physicalSiteToronto,
          name: 'Front desk',
        })
        .expect(201);
      const enrolled = await http
        .anonymous()
        .post('/kiosk/enroll')
        .set('Origin', ORIGIN)
        .send({ enrollmentCode: registered.body.enrollment.code })
        .expect(200);
      const cookie = (enrolled.headers['set-cookie'] as unknown as string[])
        .map((value) => value.split(';')[0]!)
        .find((value) => value.startsWith('hrms_kiosk='))!;
      const { pin } = (
        await admin
          .post(`/time/employees/${fx.employee1}/attendance-pin`)
          .expect(201)
      ).body as { pin: string };
      const { employeeNumber } = await tx.employee.findUniqueOrThrow({
        where: { id: fx.employee1 },
      });
      const post = (path: string, body: object) =>
        http
          .anonymous()
          .post(path)
          .set('Cookie', cookie)
          .set('Origin', ORIGIN)
          .send(body);
      return {
        identify: async () =>
          (await post('/kiosk/identify', { employeeNumber, pin }).expect(200))
            .body as {
            token: string;
            actions: Array<{
              action: string;
              employmentAssignmentId: string | null;
              scheduledShiftId?: string;
              label: string;
            }>;
          },
        act: (body: object) => post('/kiosk/actions', body),
      };
    }

    it('D2: the kiosk offers each open occurrence, records the chosen one, and never confirms another silently', async () => {
      await scenario(async (h) => {
        const { fx, clock, shifts, tx } = h;
        const kiosk = await enrolledKiosk(h);
        clock.value = toronto('2027-03-02T13:20');
        let view = await kiosk.identify();
        const signIns = view.actions.filter((a) => a.action === 'SIGN_IN');
        // One explicit, labelled choice per open occurrence; no ambiguous plain "Sign in".
        expect(signIns.map((a) => a.scheduledShiftId)).toEqual([
          shifts.first,
          shifts.second,
        ]);
        expect(signIns[0]!.label).toMatch(/^Sign in — .+ · /);
        // A shift not offered for this interaction is refused.
        await kiosk
          .act({
            token: view.token,
            action: 'SIGN_IN',
            employmentAssignmentId: fx.assignmentTeamA,
          })
          .expect(401);
        view = await kiosk.identify();
        await kiosk
          .act({
            token: view.token,
            action: 'SIGN_IN',
            employmentAssignmentId: fx.assignmentTeamA,
            scheduledShiftId: shifts.second,
            idempotencyKey: 'kiosk-second-1',
          })
          .expect(200)
          .expect((r) =>
            expect(r.body).toMatchObject({ outcome: 'SIGNED_IN' }),
          );
        expect(
          await tx.attendanceSignIn.findFirstOrThrow({
            where: { employeeId: fx.employee1 },
          }),
        ).toMatchObject({ scheduledShiftId: shifts.second, source: 'KIOSK' });

        // The next tap: only the occurrence not yet confirmed is offered, explicitly.
        view = await kiosk.identify();
        expect(
          view.actions
            .filter((a) => a.action === 'SIGN_IN')
            .map((a) => a.scheduledShiftId),
        ).toEqual([shifts.first]);
        // A sign-in without a choice (another client) within the window is the same arrival;
        // after it, the server asks for the occurrence instead of picking the other one.
        clock.value = toronto('2027-03-02T13:22');
        await (
          await h.http.as(fx.selfUser1)
        )
          .post('/time/me/sign-in', {
            employmentAssignmentId: fx.assignmentTeamA,
          })
          .expect(201)
          .expect((r) =>
            expect(r.body).toMatchObject({ outcome: 'ALREADY_SIGNED_IN' }),
          );
        clock.value = toronto('2027-03-02T13:27');
        await (
          await h.http.as(fx.selfUser1)
        )
          .post('/time/me/sign-in', {
            employmentAssignmentId: fx.assignmentTeamA,
          })
          .expect(409)
          .expect((r) =>
            expect(r.body).toMatchObject({
              code: 'ATTENDANCE_OCCURRENCE_CHOICE_REQUIRED',
            }),
          );
        expect(
          await tx.attendanceSignIn.count({
            where: { employeeId: fx.employee1, status: 'ACTIVE' },
          }),
        ).toBe(1);
        // The explicit kiosk choice records the first occurrence.
        view = await kiosk.identify();
        await kiosk
          .act({
            token: view.token,
            action: 'SIGN_IN',
            employmentAssignmentId: fx.assignmentTeamA,
            scheduledShiftId: shifts.first,
          })
          .expect(200);
        expect(
          (
            await tx.attendanceSignIn.findMany({
              where: { employeeId: fx.employee1, status: 'ACTIVE' },
              select: { scheduledShiftId: true },
              orderBy: { signedInAt: 'asc' },
            })
          ).map((row) => row.scheduledShiftId),
        ).toEqual([shifts.second, shifts.first]);
        // Both confirmed: a plain sign-in answers with an existing one, nothing new.
        view = await kiosk.identify();
        const plain = view.actions.filter((a) => a.action === 'SIGN_IN');
        expect(plain).toHaveLength(1);
        expect(plain[0]!.scheduledShiftId).toBeUndefined();
      });
    });

    it('D3: offers sign-out only when the latest sign-in is still open (what the action closes)', async () => {
      await scenario(
        async (h) => {
          const { fx, clock, tx } = h;
          const employee = await h.http.as(fx.selfUser1);
          const status = async () =>
            (await employee.get('/time/me/status').expect(200)).body
              .availableActions as string[];
          // An older open sign-in, then a later one that is already signed out.
          const older = await tx.attendanceSignIn.create({
            data: {
              employeeId: fx.employee1,
              employmentAssignmentId: fx.assignmentTeamA,
              signedInAt: toronto('2027-03-02T08:00'),
              timezone: 'America/Toronto',
              workDate: new Date('2027-03-02T00:00:00.000Z'),
              source: 'MANUAL',
              recordedByUserId: fx.users.managerA!,
              reason: 'Seeded',
            },
          });
          clock.value = toronto('2027-03-02T13:20');
          await employee
            .post('/time/me/sign-in', {
              employmentAssignmentId: fx.assignmentTeamA,
              scheduledShiftId: h.shifts.first,
            })
            .expect(201);
          clock.value = toronto('2027-03-02T13:25');
          expect(await status()).toContain('SIGN_OUT');
          await employee
            .post('/time/me/sign-out', {
              employmentAssignmentId: fx.assignmentTeamA,
            })
            .expect(201)
            .expect((r) =>
              expect(r.body).toMatchObject({ outcome: 'SIGNED_OUT' }),
            );
          // The older one is still open, but the action would only answer "already signed out".
          clock.value = toronto('2027-03-02T13:30');
          expect(await status()).not.toContain('SIGN_OUT');
          expect(
            await tx.attendanceSignOut.count({ where: { signInId: older.id } }),
          ).toBe(0);
        },
        { signOutEnabled: true },
      );
    });

    it('Batch 5A: presence no-shows stop at the assignment end date while lifecycle automation is off', async () => {
      await scenario(async (h) => {
        const { fx, clock, shifts, tx } = h;
        const time = h.http.app.get(TimeService);
        await tx.timeAttendancePolicy.update({
          where: { id: h.layerId },
          data: {
            config: {
              attendance: {
                trackingMode: 'SIGN_IN_ONLY',
                captureMode: 'KIOSK_OR_SELF_SERVICE',
              },
              noShow: { enabled: true, graceMinutes: 30 },
            },
          },
        });
        // The assignment's last day is Tuesday 2027-03-02. Lifecycle automation is off, so the
        // stored status stays ACTIVE (nothing has ended it).
        await tx.employmentAssignment.update({
          where: { id: fx.assignmentTeamA },
          data: { endDate: new Date('2027-03-02T00:00:00.000Z') },
        });
        // Wednesday after the next-day session and its grace: nobody signed in to anything.
        clock.value = toronto('2027-03-03T15:00');
        expect(await time.detectNoShows()).toMatchObject({ detected: 2 });
        const flagged = await tx.attendanceException.findMany({
          where: { type: 'NO_SHOW', employeeId: fx.employee1 },
          select: { scheduledShiftId: true },
        });
        // Both sessions on the last day are flagged; the session after it is not.
        expect(flagged.map((row) => row.scheduledShiftId)).toEqual(
          expect.arrayContaining([shifts.first, shifts.second]),
        );
        expect(flagged).toHaveLength(2);
        expect(
          (
            await tx.employmentAssignment.findUniqueOrThrow({
              where: { id: fx.assignmentTeamA },
            })
          ).status,
        ).toBe('ACTIVE');
        // Repeat runs stay quiet; the session after the end is never flagged.
        expect(await time.detectNoShows()).toMatchObject({ detected: 0 });
        expect(
          await tx.attendanceException.count({
            where: { type: 'NO_SHOW', scheduledShiftId: shifts.nextDay },
          }),
        ).toBe(0);
      });
    });

    it('D7: judges presence per occurrence: opt-in, linked or in-window unlinked sign-ins, grace, leave, once, superseded, never minutes', async () => {
      await scenario(async (h) => {
        const { fx, clock, shifts, tx } = h;
        // The API's TimeService (Leave's approved absences and Scheduling bound, as the worker).
        const time = h.http.app.get(TimeService);
        const flags = () =>
          tx.attendanceException.findMany({
            where: { type: 'NO_SHOW', employeeId: fx.employee1 },
            select: { scheduledShiftId: true, status: true, metadata: true },
            orderBy: { detectedAt: 'asc' },
          });
        const policy = (noShow: { enabled: boolean; graceMinutes?: number }) =>
          tx.timeAttendancePolicy.update({
            where: { id: h.layerId },
            data: {
              config: {
                attendance: {
                  trackingMode: 'SIGN_IN_ONLY',
                  captureMode: 'KIOSK_OR_SELF_SERVICE',
                },
                noShow,
              },
            },
          });
        const revisionOf = async (shiftId: string) =>
          (
            await tx.scheduledShiftRevision.findFirstOrThrow({
              where: { scheduledShiftId: shiftId },
            })
          ).id;
        const signIn = async (at: string, shiftId: string | null) =>
          tx.attendanceSignIn.create({
            data: {
              employeeId: fx.employee1,
              employmentAssignmentId: fx.assignmentTeamA,
              ...(shiftId
                ? {
                    scheduledShiftId: shiftId,
                    scheduledShiftRevisionId: await revisionOf(shiftId),
                  }
                : {}),
              signedInAt: toronto(at),
              timezone: 'America/Toronto',
              workDate: new Date(`${at.slice(0, 10)}T00:00:00.000Z`),
              source: 'MANUAL',
              recordedByUserId: fx.users.managerA!,
              reason: 'Seeded',
            },
          });
        const voidAll = () =>
          tx.attendanceSignIn.updateMany({
            where: { employeeId: fx.employee1, status: 'ACTIVE' },
            data: {
              status: 'VOIDED',
              voidedAt: clock.now(),
              voidedByUserId: fx.users.managerA!,
              voidReason: 'Reset for the next scenario',
            },
          });

        // Opt-in: with no-show detection off, nothing at all.
        await policy({ enabled: false });
        clock.value = toronto('2027-03-02T15:00');
        expect(await time.detectNoShows()).toMatchObject({ detected: 0 });
        await policy({ enabled: true, graceMinutes: 30 });

        // Grace boundary (second session 13:45, grace 30): not before 14:15, then once.
        await signIn('2027-03-02T13:05', shifts.first);
        clock.value = toronto('2027-03-02T14:14');
        expect(await time.detectNoShows()).toMatchObject({ detected: 0 });
        clock.value = toronto('2027-03-02T14:15');
        // Two sessions on one date: the first is confirmed, the second is not.
        expect(await time.detectNoShows()).toMatchObject({ detected: 1 });
        // Repeat execution creates nothing more.
        expect(await time.detectNoShows()).toMatchObject({ detected: 0 });
        expect(
          (await flags()).map((row) => [row.scheduledShiftId, row.status]),
        ).toEqual([[shifts.second, 'OPEN']]);
        expect((await flags())[0]!.metadata).toMatchObject({
          trackingMode: 'SIGN_IN_ONLY',
          workDate: '2027-03-02',
        });

        // A sign-in LINKED to the first session never counts for the second, even inside the
        // second's window (it opens 30 minutes early: 13:15).
        await voidAll();
        await tx.attendanceException.deleteMany({
          where: { type: 'NO_SHOW', employeeId: fx.employee1 },
        });
        await signIn('2027-03-02T13:20', shifts.first);
        clock.value = toronto('2027-03-02T15:00');
        expect(await time.detectNoShows()).toMatchObject({ detected: 1 });
        expect((await flags()).map((row) => row.scheduledShiftId)).toEqual([
          shifts.second,
        ]);

        // Later attendance: an UNLINKED sign-in inside the second's window (recorded by a
        // manager without choosing the shift) supersedes the flag on the next run.
        await signIn('2027-03-02T13:50', null);
        expect(await time.detectNoShows()).toMatchObject({
          detected: 0,
          superseded: 1,
        });
        expect((await flags()).map((row) => row.status)).toEqual([
          'SUPERSEDED',
        ]);

        // Unlinked sign-ins count only inside an occurrence's window: one at 10:00 (before
        // every window) or at 14:20 (after the second ended) leaves both sessions unattended.
        await voidAll();
        await tx.attendanceException.deleteMany({
          where: { type: 'NO_SHOW', employeeId: fx.employee1 },
        });
        await signIn('2027-03-02T10:00', null);
        await signIn('2027-03-02T14:20', null);
        expect(await time.detectNoShows()).toMatchObject({ detected: 2 });
        // An unlinked sign-in inside a window prevents the flag in the first place.
        await voidAll();
        await tx.attendanceException.deleteMany({
          where: { type: 'NO_SHOW', employeeId: fx.employee1 },
        });
        await signIn('2027-03-02T12:40', null);
        expect(await time.detectNoShows()).toMatchObject({ detected: 1 });
        expect((await flags()).map((row) => row.scheduledShiftId)).toEqual([
          shifts.second,
        ]);

        // Approved leave excuses the occurrence it covers (Wednesday), not other dates.
        const leave = leaveServices(rollbackClient(tx));
        const types = await seedLeaveConfig(tx, fx, leave);
        await grantMinutes(
          leave,
          fx,
          fx.assignmentTeamA,
          types.vacation.id,
          4800,
        );
        const vacation = await leave.requests.submitOwn(
          fx.selfUser1,
          {
            employmentAssignmentId: fx.assignmentTeamA,
            leaveTypeId: types.vacation.id,
            startDate: '2027-03-03',
            endDate: '2027-03-03',
          },
          ctx(fx.selfUser1),
        );
        await leave.requests.approve(
          fx.users.hr!,
          vacation.requestId,
          {},
          ctx(fx.users.hr!),
        );
        clock.value = toronto('2027-03-03T15:00');
        expect(await time.detectNoShows()).toMatchObject({ detected: 0 });
        expect(
          (await flags()).some(
            (row) => row.scheduledShiftId === shifts.nextDay,
          ),
        ).toBe(false);

        // Presence never records minutes: no time entry or punch was created.
        expect(
          await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
        ).toBe(0);
        expect(
          await tx.timePunch.count({ where: { employeeId: fx.employee1 } }),
        ).toBe(0);
      });
    });
  },
);
