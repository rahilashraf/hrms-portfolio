import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  createSchedulingFixtures,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  FixedClock,
  seedTimePolicy,
  TIME_PERMISSIONS,
  toronto,
} from './support/time-fixtures.js';
import { withTimeHttp, type TimeHttp } from './support/time-http.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const ADMIN = [
  ...TIME_PERMISSIONS,
  'time.device.manage',
  'time.credential.manage',
  'time.manage_policy',
];

const USERS = {
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  managerA: [{ permissions: ADMIN, scope: 'org' as const }],
  managerB: [{ permissions: ADMIN, scope: 'orgB' as const }],
  /** Can see Organization A's corrections (time.correct) but not decide them. */
  correctorA: [{ permissions: ['time.correct'], scope: 'org' as const }],
  /** time.view over Team A only: reads exclude Department B in the query. */
  teamViewer: [{ permissions: ['time.view'], scope: 'teamA' as const }],
  /** Reads Organization A's time (lists, effective policy) but may change nothing. */
  viewerA: [{ permissions: ['time.view'], scope: 'org' as const }],
  /** A role in Organization A without any time permission. */
  outsider: [{ permissions: ['schedule.read'], scope: 'org' as const }],
};

const MISSING = '00000000-0000-4000-8000-000000000000';

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  http: TimeHttp;
}

/**
 * Batch 4F — security regressions over HTTP against the real database (rolled back):
 *
 * - D1: a decided correction (approved, rejected or cancelled) is never returned, nor its status
 *   revealed, before the caller is authorized to decide it;
 * - D4: a record of an organization the caller cannot see at all is answered 404 exactly like a
 *   missing one; inside a visible organization, a missing permission stays 403;
 * - D5: list routes authorize first (no feature-state answer to outsiders) and apply the
 *   caller's scope in the query, and report truncation.
 */
describe('Batch 4F security (database, HTTP)', { timeout: 180_000 }, () => {
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
            ...ADMIN,
            'schedule.read',
          ]);
          await seedTimePolicy(tx, fx.orgA);
          await seedTimePolicy(tx, fx.orgB);
          const clock = new FixedClock();
          await withTimeHttp(tx, clock, async (http) => {
            try {
              await run({ tx, fx, clock, http });
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

  /** A closed self-service entry of Employee 1 with one correction request per state. */
  async function correctionsInEveryState(h: Harness) {
    const { fx, clock, http } = h;
    const employee = await http.as(fx.selfUser1);
    const manager = await http.as(fx.users.managerA!);
    clock.value = toronto('2027-03-02T09:00');
    await employee
      .post('/time/me/clock-in', { employmentAssignmentId: fx.assignmentTeamA })
      .expect(201);
    clock.value = toronto('2027-03-02T12:00');
    await employee.post('/time/me/clock-out').expect(201);
    const entryId = (
      (await employee.get('/time/me/entries').expect(200)).body.items as Array<{
        id: string;
      }>
    )[0]!.id;
    clock.value = toronto('2027-03-02T15:00');
    const request = async (clockOutAt: string) =>
      (
        await employee
          .post('/time/me/corrections', {
            type: 'CHANGE_CLOCK_OUT',
            timeEntryId: entryId,
            clockOutAt,
            reason: 'Stayed later',
          })
          .expect(201)
      ).body.id as string;
    // One pending request per entry at a time: each is decided before the next.
    const rejected = await request('2027-03-02T12:45');
    await manager
      .post(`/time/corrections/${rejected}/reject`, { reviewerNote: 'No' })
      .expect(201);
    const cancelled = await request('2027-03-02T12:50');
    await employee.post(`/time/me/corrections/${cancelled}/cancel`).expect(201);
    const approved = await request('2027-03-02T13:00');
    await manager
      .post(`/time/corrections/${approved}/approve`, { reviewerNote: 'Ok' })
      .expect(201);
    const pending = await request('2027-03-02T13:30');
    return { entryId, pending, approved, rejected, cancelled };
  }

  it('D1: never returns or reveals a correction request before the caller may decide it', async () => {
    await scenario(async (h) => {
      const { fx, http } = h;
      const ids = await correctionsInEveryState(h);
      const states = {
        PENDING: ids.pending,
        APPROVED: ids.approved,
        REJECTED: ids.rejected,
        CANCELLED: ids.cancelled,
      };
      const leaks = (body: Record<string, unknown>) =>
        'employeeId' in body ||
        'requestedValues' in body ||
        'reviewerNote' in body ||
        'status' in body;

      for (const [state, id] of Object.entries(states)) {
        for (const verb of ['approve', 'reject'] as const) {
          // Organizations they cannot see: 404, exactly like a missing request.
          for (const user of [fx.users.outsider!, fx.users.managerB!]) {
            const response = await (
              await http.as(user)
            )
              .post(`/time/corrections/${id}/${verb}`, {})
              .expect(404);
            expect(leaks(response.body), `${state} ${verb}`).toBe(false);
          }
          await (
            await http.as(fx.users.managerB!)
          )
            .post(`/time/corrections/${MISSING}/${verb}`, {})
            .expect(404);
          // Visible (time.correct) but not allowed to decide: 403, nothing returned.
          const corrector = await (
            await http.as(fx.users.correctorA!)
          )
            .post(`/time/corrections/${id}/${verb}`, {})
            .expect(403);
          expect(leaks(corrector.body), `${state} ${verb}`).toBe(false);
          // The requestor (the employee) sees it in My Time, but may never decide it.
          const self = await (
            await http.as(fx.selfUser1)
          )
            .post(`/time/corrections/${id}/${verb}`, {})
            .expect(403);
          expect(leaks(self.body), `${state} ${verb}`).toBe(false);
        }
      }

      // The authorized manager: an idempotent replay of the same decision, 409 otherwise.
      const manager = await http.as(fx.users.managerA!);
      await manager
        .post(`/time/corrections/${ids.approved}/approve`, {})
        .expect(201)
        .expect((r) => expect(r.body).toMatchObject({ status: 'APPROVED' }));
      await manager
        .post(`/time/corrections/${ids.rejected}/reject`, {})
        .expect(201)
        .expect((r) => expect(r.body).toMatchObject({ status: 'REJECTED' }));
      await manager
        .post(`/time/corrections/${ids.cancelled}/approve`, {})
        .expect(409);
      await manager
        .post(`/time/corrections/${ids.approved}/reject`, {})
        .expect(409);
      // The refused attempts changed nothing.
      expect(
        await h.tx.timeCorrectionRequest.findUniqueOrThrow({
          where: { id: ids.pending },
          select: { status: true, reviewerUserId: true },
        }),
      ).toEqual({ status: 'PENDING', reviewerUserId: null });
    });
  });

  it('D4: answers 404 for records of organizations the caller cannot see, 403 inside a visible one', async () => {
    await scenario(async (h) => {
      const { fx, http, tx } = h;
      const managerA = await http.as(fx.users.managerA!);
      const managerB = await http.as(fx.users.managerB!);
      const outsider = await http.as(fx.users.outsider!);
      const corrector = await http.as(fx.users.correctorA!);

      // Devices: Organization A's device, as Organization B's administrator.
      const registered = await managerA
        .post('/time/devices', {
          organizationId: fx.orgA,
          physicalSiteId: fx.physicalSiteToronto,
          name: 'Front desk',
        })
        .expect(201);
      const deviceId = registered.body.device?.id ?? registered.body.id;
      expect(deviceId).toBeTruthy();
      for (const id of [deviceId, MISSING]) {
        await managerB.patch(`/time/devices/${id}`, { name: 'X' }).expect(404);
        for (const action of ['rotate', 'disable', 'enable']) {
          await managerB.post(`/time/devices/${id}/${action}`).expect(404);
        }
        await managerB
          .post(`/time/devices/${id}/revoke`, { reason: 'Probe' })
          .expect(404);
      }
      // Visible organization, no device permission: still 404 (devices are administered at
      // organization scope only, so time.device.manage is what makes them visible).
      await corrector.post(`/time/devices/${deviceId}/disable`).expect(404);
      expect(
        (
          await tx.attendanceDevice.findUniqueOrThrow({
            where: { id: deviceId },
          })
        ).status,
      ).toBe('ACTIVE');

      // PINs: an employee who works only in Organization A.
      for (const id of [fx.employee2, MISSING]) {
        await managerB.get(`/time/employees/${id}/attendance-pin`).expect(404);
        await managerB.post(`/time/employees/${id}/attendance-pin`).expect(404);
        await managerB
          .post(`/time/employees/${id}/attendance-pin/revoke`, {
            reason: 'Probe',
          })
          .expect(404);
      }
      await managerA
        .get(`/time/employees/${fx.employee2}/attendance-pin`)
        .expect(200);

      // Entries: direct correction, direct entry and the scheduled-shift link.
      const ids = await correctionsInEveryState(h);
      for (const user of [managerB, outsider]) {
        await user
          .post(`/time/entries/${ids.entryId}/correct`, {
            type: 'CHANGE_CLOCK_OUT',
            clockOutAt: '2027-03-02T13:30',
            reason: 'Probe',
          })
          .expect(404);
        await user
          .post(`/time/entries/${ids.entryId}/scheduled-shift`, {
            scheduledShiftId: null,
            reason: 'Probe',
          })
          .expect(404);
        await user
          .post(`/time/employees/${fx.employee2}/entries`, {
            employmentAssignmentId: fx.otherTeamA,
            startAt: '2027-03-01T09:00',
            endAt: '2027-03-01T10:00',
            reason: 'Probe',
          })
          .expect(404);
      }
      await managerB
        .post(`/time/entries/${MISSING}/correct`, {
          type: 'CHANGE_CLOCK_OUT',
          clockOutAt: '2027-03-02T13:30',
          reason: 'Probe',
        })
        .expect(404);

      // Sign-ins: void, correct, record a sign-out, void a sign-out.
      const signIn = await tx.attendanceSignIn.create({
        data: {
          employeeId: fx.employee2,
          employmentAssignmentId: fx.otherTeamA,
          signedInAt: toronto('2027-03-01T09:00'),
          timezone: 'America/Toronto',
          workDate: new Date('2027-03-01T00:00:00.000Z'),
          source: 'MANUAL',
          recordedByUserId: fx.users.managerA!,
          reason: 'Seeded',
        },
      });
      for (const id of [signIn.id, MISSING]) {
        await managerB
          .post(`/time/sign-ins/${id}/void`, { reason: 'Probe' })
          .expect(404);
        await managerB
          .post(`/time/sign-ins/${id}/correct`, {
            signedInAt: '2027-03-01T09:05',
            reason: 'Probe',
          })
          .expect(404);
        await managerB
          .post(`/time/sign-ins/${id}/sign-out`, {
            signedOutAt: '2027-03-01T12:00',
            reason: 'Probe',
          })
          .expect(404);
      }
      await managerB
        .post(`/time/sign-outs/${MISSING}/void`, { reason: 'Probe' })
        .expect(404);
      await managerB
        .post('/time/sign-ins', {
          employmentAssignmentId: fx.otherTeamA,
          signedInAt: '2027-03-01T10:00',
          reason: 'Probe',
        })
        .expect(404);
      expect(
        (
          await tx.attendanceSignIn.findUniqueOrThrow({
            where: { id: signIn.id },
          })
        ).status,
      ).toBe('ACTIVE');

      // Policies: Organization A's layer.
      const policy = await tx.timeAttendancePolicy.findFirstOrThrow({
        where: { organizationId: fx.orgA, scopeType: 'ORGANIZATION' },
      });
      for (const id of [policy.id, MISSING]) {
        await managerB
          .post(`/time/policies/${id}/end`, { effectiveTo: '2027-12-31' })
          .expect(404);
        await managerB.post(`/time/policies/${id}/archive`).expect(404);
      }
      // Visible organization (time.correct) but not the policy permission: still 404, since
      // only time.manage_policy makes a policy layer visible for management.
      await corrector.post(`/time/policies/${policy.id}/archive`).expect(404);
    });
  });

  it('D4/Q2: a time.view reader gets 403 on records it can see; editors act; outsiders and missing ids get 404', async () => {
    await scenario(async (h) => {
      const { fx, http, tx } = h;
      const ids = await correctionsInEveryState(h);
      const viewer = await http.as(fx.users.viewerA!);
      const managerA = await http.as(fx.users.managerA!);
      const managerB = await http.as(fx.users.managerB!);
      const signIn = await tx.attendanceSignIn.create({
        data: {
          employeeId: fx.employee2,
          employmentAssignmentId: fx.otherTeamA,
          signedInAt: toronto('2027-03-01T09:00'),
          timezone: 'America/Toronto',
          workDate: new Date('2027-03-01T00:00:00.000Z'),
          source: 'MANUAL',
          recordedByUserId: fx.users.managerA!,
          reason: 'Seeded',
        },
      });
      const signOut = await tx.attendanceSignOut.create({
        data: {
          signInId: signIn.id,
          employeeId: fx.employee2,
          employmentAssignmentId: fx.otherTeamA,
          signedOutAt: toronto('2027-03-01T12:00'),
          source: 'MANUAL',
          recordedByUserId: fx.users.managerA!,
          reason: 'Seeded',
        },
      });
      const policy = await tx.timeAttendancePolicy.findFirstOrThrow({
        where: { organizationId: fx.orgA, scopeType: 'ORGANIZATION' },
      });
      const supersede = {
        effectiveFrom: '2027-06-01',
        config: {},
        expectedUpdatedAt: policy.updatedAt.toISOString(),
      };
      // Every route family, with a valid body: [path, body].
      const routes = (target: {
        entry: string;
        employee: string;
        assignment: string;
        signIn: string;
        signOut: string;
        policy: string;
      }): Array<[string, object]> => [
        [
          `/time/entries/${target.entry}/correct`,
          {
            type: 'CHANGE_CLOCK_OUT',
            clockOutAt: '2027-03-02T13:40',
            reason: 'Probe',
          },
        ],
        [
          `/time/entries/${target.entry}/scheduled-shift`,
          { scheduledShiftId: null, reason: 'Probe' },
        ],
        [
          `/time/employees/${target.employee}/entries`,
          {
            employmentAssignmentId: target.assignment,
            startAt: '2027-03-01T13:00',
            endAt: '2027-03-01T14:00',
            reason: 'Probe',
          },
        ],
        [
          '/time/sign-ins',
          {
            employmentAssignmentId: target.assignment,
            signedInAt: '2027-03-01T10:00',
            reason: 'Probe',
          },
        ],
        [`/time/sign-ins/${target.signIn}/void`, { reason: 'Probe' }],
        [
          `/time/sign-ins/${target.signIn}/correct`,
          { signedInAt: '2027-03-01T09:05', reason: 'Probe' },
        ],
        [
          `/time/sign-ins/${target.signIn}/sign-out`,
          { signedOutAt: '2027-03-01T12:30', reason: 'Probe' },
        ],
        [`/time/sign-outs/${target.signOut}/void`, { reason: 'Probe' }],
        [`/time/policies/${target.policy}/end`, { effectiveTo: '2027-12-31' }],
        [`/time/policies/${target.policy}/archive`, {}],
        [`/time/policies/${target.policy}/supersede`, supersede],
      ];
      const real = {
        entry: ids.entryId,
        employee: fx.employee2,
        assignment: fx.otherTeamA,
        signIn: signIn.id,
        signOut: signOut.id,
        policy: policy.id,
      };
      // Visible through time.view, not changeable: 403 on every family.
      for (const [path, body] of routes(real)) {
        const response = await viewer.post(path, body);
        expect(response.status, path).toBe(403);
      }
      // Another organization's administrator: 404, as for missing ids.
      for (const [path, body] of routes(real)) {
        const response = await managerB.post(path, body);
        expect(response.status, path).toBe(404);
      }
      for (const [path, body] of routes({
        entry: MISSING,
        employee: MISSING,
        assignment: MISSING,
        signIn: MISSING,
        signOut: MISSING,
        policy: MISSING,
      })) {
        if (path === '/time/sign-ins') continue; // no id in the path
        const response = await viewer.post(path, body);
        expect(response.status, path).toBe(404);
      }
      // Nothing changed through the refusals.
      expect(
        (
          await tx.attendanceSignIn.findUniqueOrThrow({
            where: { id: signIn.id },
          })
        ).status,
      ).toBe('ACTIVE');
      // Authorized editors still act (mutation authorization unchanged).
      await managerA
        .post(`/time/sign-outs/${signOut.id}/void`, { reason: 'Wrong time' })
        .expect(201);
      await managerA
        .post(`/time/sign-ins/${signIn.id}/void`, { reason: 'Recorded twice' })
        .expect(201);
      await managerA
        .post(`/time/policies/${policy.id}/end`, { effectiveTo: '2027-12-31' })
        .expect(201);
    });
  });

  it('Q3/D5: applies scope before the limit and says when the sign-in list was cut off', async () => {
    await scenario(async (h) => {
      const { fx, http, tx } = h;
      const start = toronto('2027-03-01T00:00').getTime();
      // Team A's only sign-in is the oldest; Department B has 1001 newer ones.
      await tx.attendanceSignIn.create({
        data: {
          employeeId: fx.employee2,
          employmentAssignmentId: fx.otherTeamA,
          signedInAt: new Date(start - 60_000),
          timezone: 'America/Toronto',
          workDate: new Date('2027-02-28T00:00:00.000Z'),
          source: 'MANUAL',
          recordedByUserId: fx.users.managerA!,
          reason: 'Seeded',
        },
      });
      await tx.attendanceSignIn.createMany({
        data: Array.from({ length: 1001 }, (_, index) => ({
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentDeptB,
          signedInAt: new Date(start + index * 60_000),
          timezone: 'America/Toronto',
          workDate: new Date('2027-03-01T00:00:00.000Z'),
          source: 'MANUAL' as const,
          recordedByUserId: fx.users.managerA!,
          reason: 'Seeded',
        })),
      });
      const range = `organizationId=${fx.orgA}&from=2027-02-28&to=2027-03-01`;
      const full = await (
        await http.as(fx.users.managerA!)
      )
        .get(`/time/manage/sign-ins?${range}`)
        .expect(200);
      expect(full.body.items).toHaveLength(1000);
      expect(full.body).toMatchObject({ truncated: true, limit: 1000 });
      // Before 4F the 1000 newest rows were read and then filtered, losing Team A's row.
      const team = await (
        await http.as(fx.users.teamViewer!)
      )
        .get(`/time/manage/sign-ins?${range}`)
        .expect(200);
      expect(
        (team.body.items as Array<{ employmentAssignmentId: string }>).map(
          (row) => row.employmentAssignmentId,
        ),
      ).toEqual([fx.otherTeamA]);
      expect(team.body.truncated).toBe(false);
    });
  });

  it('D5: authorizes list routes before revealing feature state and scopes them in the query', async () => {
    await scenario(async (h) => {
      const { fx, http, tx } = h;
      const signInFor = (assignment: string, employee: string, at: string) =>
        tx.attendanceSignIn.create({
          data: {
            employeeId: employee,
            employmentAssignmentId: assignment,
            signedInAt: toronto(at),
            timezone: 'America/Toronto',
            workDate: new Date(`${at.slice(0, 10)}T00:00:00.000Z`),
            source: 'MANUAL',
            recordedByUserId: fx.users.managerA!,
            reason: 'Seeded',
          },
        });
      await signInFor(fx.assignmentTeamA, fx.employee1, '2027-03-01T09:00');
      await signInFor(fx.assignmentDeptB, fx.employee1, '2027-03-01T13:00');
      const range = `organizationId=${fx.orgA}&from=2027-03-01&to=2027-03-02`;

      // Team A's viewer sees Team A only (scoped in the query), and is told nothing is cut off.
      const team = await (
        await http.as(fx.users.teamViewer!)
      )
        .get(`/time/manage/sign-ins?${range}`)
        .expect(200);
      expect(
        (team.body.items as Array<{ employmentAssignmentId: string }>).map(
          (row) => row.employmentAssignmentId,
        ),
      ).toEqual([fx.assignmentTeamA]);
      expect(team.body).toMatchObject({ truncated: false, limit: 1000 });
      const manager = await (
        await http.as(fx.users.managerA!)
      )
        .get(`/time/manage/sign-ins?${range}`)
        .expect(200);
      expect(manager.body.items).toHaveLength(2);

      // Attendance disabled in A: outsiders learn nothing about it (403 permission), the
      // organization's own viewer gets the feature answer.
      await tx.organizationModuleSetting.upsert({
        where: {
          organizationId_module: {
            organizationId: fx.orgA,
            module: 'ATTENDANCE',
          },
        },
        create: {
          organizationId: fx.orgA,
          module: 'ATTENDANCE',
          enabled: false,
        },
        update: { enabled: false, version: { increment: 1 } },
      });
      for (const path of ['manage/sign-ins', 'manage/expected-sign-ins']) {
        for (const user of [fx.users.managerB!, fx.users.outsider!]) {
          const response = await (
            await http.as(user)
          )
            .get(`/time/${path}?${range}`)
            .expect(403);
          expect(response.body.code).not.toBe('FEATURE_DISABLED');
        }
        const own = await (
          await http.as(fx.users.teamViewer!)
        )
          .get(`/time/${path}?${range}`)
          .expect(403);
        expect(own.body).toMatchObject({ code: 'FEATURE_DISABLED' });
      }
      // Scheduled vs actual: an outsider gets the empty report, not the feature state.
      const variance = await (
        await http.as(fx.users.managerB!)
      )
        .get(
          `/time/manage/scheduled-vs-actual?organizationId=${fx.orgA}&from=2027-03-01&to=2027-03-02`,
        )
        .expect(200);
      expect(variance.body.rows).toEqual([]);
    });
  });
});
