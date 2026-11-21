import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { sha256 } from '../src/kiosk/kiosk-secrets.js';
import { RedisService } from '../src/redis/redis.service.js';
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
import { addOrganizationBAssignment } from './support/time-world.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
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
  managerB: [{ permissions: TIME_PERMISSIONS, scope: 'orgB' as const }],
  /** An account with a role but no time permission. */
  outsider: [{ permissions: ['schedule.read'], scope: 'org' as const }],
};

/** Team A captures at kiosks or by self-service (the default policy is self-service only). */
async function kioskOrSelfService(tx: Tx, fx: SchedulingFixtures) {
  await tx.timeAttendancePolicy.create({
    data: {
      scopeType: 'TEAM',
      organizationId: fx.orgA,
      teamId: fx.teamA,
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      config: {
        clock: { mode: 'LIVE_CLOCK' },
        attendance: { captureMode: 'KIOSK_OR_SELF_SERVICE' },
      },
    },
  });
}

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  http: TimeHttp;
}

/**
 * Batch 4 (PR 4.0) — Time and kiosk routes over HTTP against the real database: the whole
 * AppModule (guards, validation, controllers, services, SQL constraints and triggers) inside a
 * rolled-back transaction, with a fixed clock.
 *
 * These specs describe what production does and must stay green through Batch 4. The timesheet
 * lifecycle spec is the reference for "approved → locked → reopened"; Batch 4A changed it
 * deliberately (decisions D1 and D2: the period must end before submission, only submitted time
 * is approved, the lock keeps the approved snapshot, reopening needs a reason) and updated it.
 */
describe('Time and kiosk routes (database, HTTP)', { timeout: 120_000 }, () => {
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
    extra?: (tx: Tx, fx: SchedulingFixtures) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, [
            ...TIME_PERMISSIONS,
            'time.device.manage',
            'time.credential.manage',
          ]);
          await seedTimePolicy(tx, fx.orgA);
          await extra?.(tx, fx);
          const clock = new FixedClock();
          await withTimeHttp(tx, clock, (http) => run({ tx, fx, clock, http }));
          throw new RollbackFixtures();
        },
        { timeout: 90_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('self-service clock in/out, then a clock-out correction approved by a manager with a note', async () => {
    await scenario(async ({ fx, clock, http, tx }) => {
      const employee = await http.as(fx.selfUser1);
      const manager = await http.as(fx.users.managerA!);

      clock.value = toronto('2027-03-02T09:00');
      await employee
        .post('/time/me/clock-in', {
          employmentAssignmentId: fx.assignmentTeamA,
        })
        .expect(201);
      const open = await employee.get('/time/me/status').expect(200);
      expect(open.body).toMatchObject({ state: 'CLOCKED_IN' });
      // A second clock-in while clocked in changes nothing.
      await employee
        .post('/time/me/clock-in', {
          employmentAssignmentId: fx.assignmentTeamA,
        })
        .expect((response) => expect([201, 409]).toContain(response.status));

      clock.value = toronto('2027-03-02T12:00');
      await employee.post('/time/me/clock-out').expect(201);
      expect(
        (await employee.get('/time/me/status').expect(200)).body,
      ).toMatchObject({ state: 'OFF_CLOCK' });
      expect(
        await tx.timePunch.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(2);

      const entries = await employee.get('/time/me/entries').expect(200);
      const entryId = (entries.body.items as Array<{ id: string }>)[0]!.id;

      clock.value = toronto('2027-03-02T15:00');
      const requested = await employee
        .post('/time/me/corrections', {
          type: 'CHANGE_CLOCK_OUT',
          timeEntryId: entryId,
          clockOutAt: '2027-03-02T13:00',
          reason: 'Stayed for the delivery',
        })
        .expect(201);
      const correctionId = requested.body.id as string;
      expect(requested.body).toMatchObject({ status: 'PENDING' });

      // The employee cannot approve their own request (no permission), and the manager queue
      // lists it.
      await employee
        .post(`/time/corrections/${correctionId}/approve`, {})
        .expect(403);
      const queue = await manager
        .get('/time/manage/corrections?status=PENDING&limit=100')
        .expect(200);
      expect(
        (queue.body.items as Array<{ id: string }>).map((item) => item.id),
      ).toContain(correctionId);

      await manager
        .post(`/time/corrections/${correctionId}/approve`, {
          reviewerNote: 'Confirmed with the site lead',
        })
        .expect(201);
      const entry = await tx.timeEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(entry.clockOutAt).toEqual(toronto('2027-03-02T13:00'));
      const mine = await employee.get('/time/me/corrections').expect(200);
      expect(mine.body.corrections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: correctionId,
            status: 'APPROVED',
            reviewerNote: 'Confirmed with the site lead',
          }),
        ]),
      );
    });
  });

  it('timesheet lifecycle (Batch 4A): submit after the period → approve → lock → reopen with a reason', async () => {
    await scenario(async ({ fx, clock, http, tx }) => {
      const employee = await http.as(fx.selfUser1);
      const manager = await http.as(fx.users.managerA!);
      clock.value = toronto('2027-03-02T09:00');
      await employee
        .post('/time/me/clock-in', {
          employmentAssignmentId: fx.assignmentTeamA,
        })
        .expect(201);
      clock.value = toronto('2027-03-02T12:00');
      await employee.post('/time/me/clock-out').expect(201);

      const generated = await manager
        .post('/time/periods/generate', {
          organizationId: fx.orgA,
          startDate: '2027-03-01',
          cadence: 'WEEKLY',
        })
        .expect(201);
      expect(generated.body).toBeTruthy();
      const period = await tx.timePeriod.findFirstOrThrow({
        where: { organizationId: fx.orgA },
      });
      // Timesheets are created by payroll preparation only (no Time route yet: 4C adds one).
      const sheet = await tx.timesheet.create({
        data: { employeeId: fx.employee1, timePeriodId: period.id },
      });

      // Reading the timesheet refreshes it from the entries.
      const read = await employee
        .get(`/time/me/timesheets/${sheet.id}`)
        .expect(200);
      expect(read.body).toMatchObject({ id: sheet.id, status: 'OPEN' });
      const segments = read.body.segments as Array<{
        id: string;
        employmentAssignmentId: string;
        netWorkedMinutes: number;
        status: string;
      }>;
      expect(segments).toHaveLength(1);
      expect(segments[0]).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
        netWorkedMinutes: 180,
        status: 'PENDING',
      });

      // Batch 4A: never before the period ends; never approved before it is submitted.
      const early = await employee
        .post(`/time/me/timesheets/${sheet.id}/submit`)
        .expect(409);
      expect(early.body).toMatchObject({
        code: 'TIMESHEET_PERIOD_NOT_ENDED',
        periodEndDate: '2027-03-07',
      });
      clock.value = toronto('2027-03-08T09:00');
      const unsubmitted = await manager
        .post(`/time/timesheet-segments/${segments[0]!.id}/approve`, {})
        .expect(409);
      expect(unsubmitted.body).toMatchObject({
        code: 'TIMESHEET_NOT_SUBMITTED',
      });
      await employee
        .post(`/time/me/timesheets/${sheet.id}/submit`)
        .expect(201)
        .expect((response) =>
          expect(response.body).toMatchObject({ status: 'SUBMITTED' }),
        );

      // The employee has no approval permission over their own segment.
      await employee
        .post(`/time/timesheet-segments/${segments[0]!.id}/approve`, {})
        .expect(403);
      // A reviewer who saw other numbers is refused (stale view).
      const stale = await manager
        .post(`/time/timesheet-segments/${segments[0]!.id}/approve`, {
          expectedNetWorkedMinutes: 120,
        })
        .expect(409);
      expect(stale.body).toMatchObject({
        code: 'TIMESHEET_SEGMENT_CHANGED',
        netWorkedMinutes: 180,
      });
      await manager
        .post(`/time/timesheet-segments/${segments[0]!.id}/approve`, {
          note: 'Matches the roster',
          expectedNetWorkedMinutes: 180,
        })
        .expect(201);
      let stored = await tx.timesheet.findUniqueOrThrow({
        where: { id: sheet.id },
        include: { segments: true },
      });
      expect(stored.status).toBe('APPROVED');
      expect(stored.version).toBe(1);
      expect(stored.segments[0]).toMatchObject({
        status: 'APPROVED',
        approvedWorkedMinutes: 180,
        reviewerNote: 'Matches the roster',
      });
      expect(stored.totals).toMatchObject({
        approvedWorkedMinutes: 180,
        payrollWorkDates: [
          expect.objectContaining({
            workDate: '2027-03-02',
            approvedWorkedMinutes: 180,
            finalizationStatus: 'APPROVED',
          }),
        ],
      });

      // Approved time is finalized: a direct correction is refused.
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      const finalized = await manager
        .post(`/time/entries/${entry.id}/correct`, {
          type: 'CHANGE_CLOCK_OUT',
          clockOutAt: '2027-03-02T13:00',
          reason: 'Late correction',
        })
        .expect(409);
      expect(finalized.body).toMatchObject({ code: 'TIME_ENTRY_FINALIZED' });

      // Lock (idempotent; a stale version is refused), then review actions are refused.
      const staleLock = await manager
        .post(`/time/timesheets/${sheet.id}/lock`, { expectedVersion: 2 })
        .expect(409);
      expect(staleLock.body).toMatchObject({
        code: 'TIMESHEET_VERSION_CONFLICT',
      });
      const approvedTotals = stored.totals;
      await manager
        .post(`/time/timesheets/${sheet.id}/lock`, { expectedVersion: 1 })
        .expect(201);
      await manager.post(`/time/timesheets/${sheet.id}/lock`).expect(201);
      stored = await tx.timesheet.findUniqueOrThrow({
        where: { id: sheet.id },
        include: { segments: true },
      });
      expect(stored.status).toBe('LOCKED');
      expect(stored.lockedByUserId).toBe(fx.users.managerA);
      // The approved snapshot exactly, with LOCKED rows.
      const approvedSnapshot = approvedTotals as {
        payrollWorkDates: Array<Record<string, unknown>>;
      };
      expect(stored.totals).toEqual({
        ...approvedSnapshot,
        payrollWorkDates: approvedSnapshot.payrollWorkDates.map((row) => ({
          ...row,
          finalizationStatus: 'LOCKED',
        })),
      });
      expect(stored.totals).toMatchObject({
        payrollWorkDates: [
          expect.objectContaining({
            workDate: '2027-03-02',
            approvedWorkedMinutes: 180,
            finalizationStatus: 'LOCKED',
          }),
        ],
      });
      await manager
        .post(`/time/timesheet-segments/${segments[0]!.id}/request-changes`, {
          note: 'Too late',
        })
        .expect(409);

      // Reopening needs a reason, and makes a new version: OPEN again, segments PENDING.
      const noReason = await manager
        .post(`/time/timesheets/${sheet.id}/reopen`, {})
        .expect(400);
      expect(noReason.body).toMatchObject({
        code: 'TIMESHEET_REASON_REQUIRED',
      });
      const reopenedResponse = await manager
        .post(`/time/timesheets/${sheet.id}/reopen`, {
          note: 'Late correction',
        })
        .expect(201);
      expect(reopenedResponse.body).toMatchObject({
        status: 'OPEN',
        version: 2,
        retroAdjustment: { required: false, finalizedPayrollRunIds: [] },
      });
      const reopened = await tx.timesheet.findUniqueOrThrow({
        where: { id: sheet.id },
        include: { segments: true, events: { orderBy: { occurredAt: 'asc' } } },
      });
      expect(reopened.status).toBe('OPEN');
      expect(reopened.version).toBe(2);
      expect(reopened.segments[0]).toMatchObject({
        status: 'PENDING',
        approvedWorkedMinutes: 0,
      });
      expect(reopened.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(['SUBMITTED', 'LOCKED', 'REOPENED']),
      );
      // ...and the correction now applies.
      await manager
        .post(`/time/entries/${entry.id}/correct`, {
          type: 'CHANGE_CLOCK_OUT',
          clockOutAt: '2027-03-02T13:00',
          reason: 'Late correction',
        })
        .expect(201);
    });
  });

  it('refuses time management to accounts without time permissions and keeps organizations apart', async () => {
    await scenario(async ({ fx, clock, http }) => {
      const employee = await http.as(fx.selfUser1);
      const outsider = await http.as(fx.users.outsider!);
      const managerB = await http.as(fx.users.managerB!);
      clock.value = toronto('2027-03-02T09:00');
      await employee
        .post('/time/me/clock-in', {
          employmentAssignmentId: fx.assignmentTeamA,
        })
        .expect(201);
      clock.value = toronto('2027-03-02T12:00');
      await employee.post('/time/me/clock-out').expect(201);
      const entryId = (
        (await employee.get('/time/me/entries').expect(200)).body
          .items as Array<{
          id: string;
        }>
      )[0]!.id;

      // Unauthenticated.
      await http.anonymous().get('/time/me/status').expect(401);
      await http.anonymous().get('/time/manage/entries').expect(401);
      await http
        .anonymous()
        .post('/time/periods/generate')
        .send({})
        .expect(401);

      // No time permission: lists come back empty, actions are refused.
      for (const user of [outsider, managerB]) {
        const entries = await user
          .get(`/time/manage/entries?search=${fx.suffix}`)
          .expect(200);
        expect(entries.body.items).toEqual([]);
      }
      // Batch 4F (D4): neither holds a correction permission in Organization A, so its entry is
      // answered exactly like a missing one (its existence is not revealed).
      await outsider
        .post(`/time/entries/${entryId}/correct`, {
          type: 'CHANGE_CLOCK_OUT',
          clockOutAt: '2027-03-02T13:00',
          reason: 'Not mine to change',
        })
        .expect(404);
      // Organization B's manager can't act on Organization A's time either.
      await managerB
        .post(`/time/entries/${entryId}/correct`, {
          type: 'CHANGE_CLOCK_OUT',
          clockOutAt: '2027-03-02T13:00',
          reason: 'Not mine to change',
        })
        .expect(404);
      await managerB
        .post('/time/periods/generate', {
          organizationId: fx.orgA,
          startDate: '2027-03-01',
          cadence: 'WEEKLY',
        })
        .expect(403);
      // An employee without a time.clock grant on the assignment can't clock it.
      await outsider
        .post('/time/me/clock-in', {
          employmentAssignmentId: fx.assignmentTeamA,
        })
        .expect((response) => expect([403, 404]).toContain(response.status));
    });
  });

  it('validates request bodies before any service runs', async () => {
    await scenario(async ({ fx, http }) => {
      const employee = await http.as(fx.selfUser1);
      const manager = await http.as(fx.users.managerA!);
      await employee
        .post('/time/me/clock-in', {
          employmentAssignmentId: fx.assignmentTeamA,
          unexpected: true,
        })
        .expect(400);
      await employee
        .post('/time/me/clock-in', { employmentAssignmentId: 'not-a-uuid' })
        .expect(400);
      await employee
        .post('/time/me/corrections', {
          type: 'NOT_A_TYPE',
          reason: 'x',
        })
        .expect(400);
      await employee
        .post('/time/me/corrections', {
          type: 'CHANGE_CLOCK_OUT',
          reason: 'Bad time',
          clockOutAt: '2027-03-02 13:00',
        })
        .expect(400);
      await manager
        .post('/time/periods/generate', {
          organizationId: fx.orgA,
          startDate: '2027-02-30',
          cadence: 'WEEKLY',
        })
        .expect(400);
      await manager
        .post(`/time/employees/${fx.employee1}/entries`, {
          employmentAssignmentId: fx.assignmentTeamA,
          startAt: '2027-03-02T09:00',
          endAt: '2027-03-02T10:00',
        })
        .expect(400);
      await manager
        .post('/time/devices', {
          organizationId: fx.orgA,
          physicalSiteId: fx.physicalSiteToronto,
          name: '',
        })
        .expect(400);
      await manager
        .patch('/time/devices/not-a-uuid', { name: 'x' })
        .expect(400);
    });
  });

  it('a malformed id in the path answers 400 on every time route (Batch 4B; was a 500)', async () => {
    await scenario(async ({ fx, http }) => {
      const employee = await http.as(fx.selfUser1);
      const manager = await http.as(fx.users.managerA!);
      // ParseUUIDPipe on every :id, as /time/devices/:id: the id never reaches the database.
      for (const path of [
        '/time/corrections/not-a-uuid/approve',
        '/time/corrections/not-a-uuid/reject',
        '/time/timesheets/not-a-uuid/lock',
        '/time/timesheets/not-a-uuid/reopen',
        '/time/timesheets/not-a-uuid/submit-on-behalf',
        '/time/timesheet-segments/not-a-uuid/approve',
        '/time/timesheet-segments/not-a-uuid/request-changes',
        '/time/entries/not-a-uuid/correct',
        '/time/entries/not-a-uuid/scheduled-shift',
      ]) {
        await manager.post(path, {}).expect(400);
      }
      await employee.get('/time/me/timesheets/not-a-uuid').expect(400);
      await employee.post('/time/me/timesheets/not-a-uuid/submit').expect(400);
      await employee.post('/time/me/corrections/not-a-uuid/cancel').expect(400);
      await employee
        .post('/time/me/exceptions/not-a-uuid/resolve-missed-clock-out', {})
        .expect(400);
    });
  });

  it('submit on behalf (Batch 4A): the manage permission and a reason, audited', async () => {
    await scenario(async ({ fx, clock, http, tx }) => {
      const employee = await http.as(fx.selfUser1);
      const manager = await http.as(fx.users.managerA!);
      const outsider = await http.as(fx.users.outsider!);
      clock.value = toronto('2027-03-02T09:00');
      await employee
        .post('/time/me/clock-in', {
          employmentAssignmentId: fx.assignmentTeamA,
        })
        .expect(201);
      clock.value = toronto('2027-03-02T12:00');
      await employee.post('/time/me/clock-out').expect(201);
      await manager
        .post('/time/periods/generate', {
          organizationId: fx.orgA,
          startDate: '2027-03-01',
          cadence: 'WEEKLY',
        })
        .expect(201);
      const period = await tx.timePeriod.findFirstOrThrow({
        where: { organizationId: fx.orgA },
      });
      const sheet = await tx.timesheet.create({
        data: { employeeId: fx.employee1, timePeriodId: period.id },
      });
      clock.value = toronto('2027-03-08T09:00');
      const path = `/time/timesheets/${sheet.id}/submit-on-behalf`;
      await http.anonymous().post(path).send({ reason: 'x' }).expect(401);
      // Batch 4B: an account with no timesheet permission in the organization (in it or not)
      // can't tell the timesheet exists: 404, as for an unknown id.
      await outsider.post(path, { reason: 'On leave' }).expect(404);
      const managerB = await http.as(fx.users.managerB!);
      await managerB.post(path, { reason: 'On leave' }).expect(404);
      await managerB.post(`/time/timesheets/${sheet.id}/lock`).expect(404);
      await managerB
        .post(`/time/timesheets/${sheet.id}/reopen`, {
          note: 'Not my organization',
        })
        .expect(404);
      await manager.post(path, {}).expect(400);
      await manager.post(path, { reason: 'On leave this week' }).expect(201);
      expect(
        await tx.timesheet.findUniqueOrThrow({ where: { id: sheet.id } }),
      ).toMatchObject({
        status: 'SUBMITTED',
        submittedByUserId: fx.users.managerA,
      });
      expect(
        await tx.auditLog.count({
          where: {
            entityId: sheet.id,
            action: 'TIMESHEET_SUBMITTED_ON_BEHALF',
          },
        }),
      ).toBe(1);
    });
  });

  it('kiosk: register, enroll, identify by PIN, clock in and out, then disable', async () => {
    await scenario(async ({ fx, clock, http, tx }) => {
      const admin = await http.as(fx.users.managerA!);
      // Enrollment is limited per client address (10 per 15 minutes) in the real Redis; reset
      // this test client's counter so local re-runs don't trip it.
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
      const deviceId = registered.body.device.id as string;
      const enrollmentCode = registered.body.enrollment.code as string;
      expect(deviceId).toEqual(expect.any(String));
      expect(enrollmentCode).toEqual(expect.any(String));

      // The device is enrolled from an untrusted origin: refused.
      await http
        .anonymous()
        .post('/kiosk/enroll')
        .set('Origin', 'https://elsewhere.example')
        .send({ enrollmentCode })
        .expect(403);
      const enrolled = await http
        .anonymous()
        .post('/kiosk/enroll')
        .set('Origin', 'http://web.time-spec.test')
        .send({ enrollmentCode })
        .expect(200);
      const deviceCookie = (
        enrolled.headers['set-cookie'] as unknown as string[]
      )
        .map((cookie) => cookie.split(';')[0]!)
        .find((cookie) => cookie.startsWith('hrms_kiosk='));
      expect(deviceCookie).toBeDefined();
      /** The enrolled browser: the device cookie on every kiosk request. */
      const kiosk = {
        get: (path: string) =>
          http.anonymous().get(path).set('Cookie', deviceCookie!),
        post: (path: string) =>
          http.anonymous().post(path).set('Cookie', deviceCookie!),
      };
      // The code is single use.
      await http
        .anonymous()
        .post('/kiosk/enroll')
        .set('Origin', 'http://web.time-spec.test')
        .send({ enrollmentCode })
        .expect((response) =>
          expect([400, 401, 403, 404]).toContain(response.status),
        );
      await kiosk
        .get('/kiosk/session')
        .set('Origin', 'http://web.time-spec.test')
        .expect(200);
      // Device routes refuse a browser without the device cookie.
      await http.anonymous().get('/kiosk/session').expect(401);

      const issued = await admin
        .post(`/time/employees/${fx.employee1}/attendance-pin`)
        .expect(201);
      const pin = issued.body.pin as string;
      expect(pin).toMatch(/^\d{6}$/);
      const { employeeNumber } = await tx.employee.findUniqueOrThrow({
        where: { id: fx.employee1 },
      });

      // A wrong PIN gets the generic answer.
      const wrong = pin === '000000' ? '111111' : '000000';
      await kiosk
        .post('/kiosk/identify')
        .set('Origin', 'http://web.time-spec.test')
        .send({ employeeNumber, pin: wrong })
        .expect((response) => expect([401, 403]).toContain(response.status));

      clock.value = toronto('2027-03-02T09:00');
      const identified = await kiosk
        .post('/kiosk/identify')
        .set('Origin', 'http://web.time-spec.test')
        .send({ employeeNumber, pin })
        .expect(200);
      const token = identified.body.token as string;
      expect(token).toEqual(expect.any(String));
      await kiosk
        .post('/kiosk/actions')
        .set('Origin', 'http://web.time-spec.test')
        .send({
          token,
          action: 'CLOCK_IN',
          employmentAssignmentId: fx.assignmentTeamA,
        })
        .expect(200);
      // The interaction token is single use.
      await kiosk
        .post('/kiosk/actions')
        .set('Origin', 'http://web.time-spec.test')
        .send({
          token,
          action: 'CLOCK_IN',
          employmentAssignmentId: fx.assignmentTeamA,
        })
        .expect((response) =>
          expect(response.status).toBeGreaterThanOrEqual(400),
        );
      const punch = await tx.timePunch.findFirstOrThrow({
        where: { employeeId: fx.employee1, type: 'CLOCK_IN' },
      });
      expect(punch).toMatchObject({
        source: 'KIOSK',
        attendanceDeviceId: deviceId,
      });

      clock.value = toronto('2027-03-02T17:00');
      const again = await kiosk
        .post('/kiosk/identify')
        .set('Origin', 'http://web.time-spec.test')
        .send({ employeeNumber, pin })
        .expect(200);
      await kiosk
        .post('/kiosk/actions')
        .set('Origin', 'http://web.time-spec.test')
        .send({ token: again.body.token, action: 'CLOCK_OUT' })
        .expect(200);
      expect(
        await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1 },
        }),
      ).toMatchObject({ status: 'CLOSED', source: 'KIOSK' });

      // Disabled: the device is refused immediately.
      await admin.post(`/time/devices/${deviceId}/disable`).expect(201);
      await kiosk
        .post('/kiosk/identify')
        .set('Origin', 'http://web.time-spec.test')
        .send({ employeeNumber, pin })
        .expect(403);
    }, kioskOrSelfService);
  });

  it('kiosk: an organization can register any number of devices (no device cap)', async () => {
    await scenario(async ({ fx, http }) => {
      const admin = await http.as(fx.users.managerA!);
      const count = 30;
      for (let index = 0; index < count; index += 1) {
        await admin
          .post('/time/devices', {
            organizationId: fx.orgA,
            physicalSiteId:
              index % 2 === 0 ? fx.physicalSiteToronto : fx.physicalSiteOttawa,
            name: `Kiosk ${index + 1}`,
          })
          .expect(201);
      }
      const listed = await admin
        .get(`/time/devices?organizationId=${fx.orgA}`)
        .expect(200);
      const devices = Array.isArray(listed.body)
        ? listed.body
        : (listed.body.items as unknown[]);
      expect(devices).toHaveLength(count);
    });
  });

  it('kiosk-only capture refuses self-service clocking over HTTP', async () => {
    await scenario(
      async ({ fx, clock, http, tx }) => {
        const employee = await http.as(fx.selfUser1);
        clock.value = toronto('2027-03-02T09:00');
        const refused = await employee
          .post('/time/me/clock-in', {
            employmentAssignmentId: fx.assignmentTeamA,
          })
          .expect(403);
        expect(JSON.stringify(refused.body)).toContain('KIOSK');
        expect(
          await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
        ).toBe(0);
      },
      async (tx, fx) => {
        await tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'TEAM',
            organizationId: fx.orgA,
            teamId: fx.teamA,
            effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
            config: {
              clock: { mode: 'LIVE_CLOCK' },
              attendance: { captureMode: 'KIOSK_ONLY' },
            },
          },
        });
      },
    );
  });

  it('multi-organization employee: each organization’s manager reaches only that organization’s assignment', async () => {
    let orgB!: { assignmentId: string };
    await scenario(
      async ({ fx, clock, http }) => {
        const employee = await http.as(fx.selfUser1);
        const managerA = await http.as(fx.users.managerA!);
        const managerB = await http.as(fx.users.managerB!);
        clock.value = toronto('2027-03-02T09:00');
        await employee
          .post('/time/me/clock-in', {
            employmentAssignmentId: fx.assignmentTeamA,
          })
          .expect(201);
        clock.value = toronto('2027-03-02T12:00');
        await employee
          .post('/time/me/switch-assignment', {
            employmentAssignmentId: orgB.assignmentId,
          })
          .expect(201);
        clock.value = toronto('2027-03-02T14:00');
        await employee.post('/time/me/clock-out').expect(201);

        const assignmentsSeenBy = async (user: typeof managerA) =>
          (
            (
              await user
                .get(`/time/manage/entries?search=${fx.suffix}`)
                .expect(200)
            ).body.items as Array<{ employmentAssignmentId: string }>
          ).map((item) => item.employmentAssignmentId);
        expect(await assignmentsSeenBy(managerA)).toEqual([fx.assignmentTeamA]);
        expect(await assignmentsSeenBy(managerB)).toEqual([orgB.assignmentId]);
      },
      async (tx, fx) => {
        orgB = await addOrganizationBAssignment(tx, fx);
        // Employee 1 clocks in Organization B too.
        const permission = await tx.permission.findUniqueOrThrow({
          where: { key: 'time.clock' },
        });
        const role = await tx.role.create({
          data: {
            organizationId: fx.orgB,
            code: `CLOCKB-${fx.suffix}`,
            name: 'Clock in B',
          },
        });
        await tx.rolePermission.create({
          data: { roleId: role.id, permissionId: permission.id },
        });
        await tx.roleAssignment.create({
          data: {
            userId: fx.selfUser1,
            roleId: role.id,
            roleOrganizationId: fx.orgB,
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgB,
          },
        });
        // Organization B allows switching between assignments too.
        await tx.timeAttendancePolicy.updateMany({
          where: { organizationId: fx.orgB },
          data: {
            config: {
              clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
              breaks: { mode: 'MANUAL_PUNCH' },
            },
          },
        });
      },
    );
  });

  it('attendance-only lifecycle over HTTP (Batch 4C): periods, materialization and exception review', async () => {
    await scenario(async ({ fx, http, tx }) => {
      const manager = await http.as(fx.users.managerA!);
      const managerB = await http.as(fx.users.managerB!);
      const outsider = await http.as(fx.users.outsider!);
      await tx.timeEntry.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          clockInAt: toronto('2027-03-02T09:00'),
          clockOutAt: toronto('2027-03-02T12:00'),
          timezone: 'America/Toronto',
          workDate: new Date('2027-03-02'),
          status: 'CLOSED',
          source: 'MANUAL',
        },
      });
      const generated = await manager
        .post('/time/periods/generate', {
          organizationId: fx.orgA,
          startDate: '2027-03-01',
          cadence: 'WEEKLY',
          count: 2,
        })
        .expect(201);
      const periodId = generated.body.periods[0].id as string;
      await manager
        .post('/time/periods/generate', {
          organizationId: fx.orgA,
          startDate: '2027-03-03',
          cadence: 'WEEKLY',
        })
        .expect(409)
        .expect((response) =>
          expect(response.body.code).toBe('TIME_PERIOD_OVERLAP'),
        );

      const listed = await manager
        .get(`/time/periods?organizationId=${fx.orgA}&from=2027-03-01&limit=1`)
        .expect(200);
      expect(listed.body.items).toHaveLength(1);
      expect(listed.body.nextAfterId).toEqual(expect.any(String));
      await manager.get('/time/periods?from=03/01/2027').expect(400);
      expect(
        (await outsider.get('/time/periods').expect(200)).body.items,
      ).toEqual([]);

      const path = `/time/periods/${periodId}/materialize-timesheets`;
      await managerB.post(path).expect(404);
      await outsider.post(path).expect(404);
      await manager
        .post('/time/periods/not-a-uuid/materialize-timesheets')
        .expect(400);
      const first = await manager.post(path).expect(201);
      // Both employees of Organization A record time by clock: one timesheet each.
      expect(first.body).toMatchObject({ created: 2, existing: 0 });
      expect((await manager.post(path).expect(201)).body).toMatchObject({
        created: 0,
        existing: 2,
      });

      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      const exception = await tx.attendanceException.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          timeEntryId: entry.id,
          type: 'LATE_ARRIVAL',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
        },
      });
      const resolve = `/time/exceptions/${exception.id}/resolve`;
      await manager.post(resolve, {}).expect(400);
      await manager.post(resolve, { note: '' }).expect(400);
      await managerB.post(resolve, { note: 'Not mine' }).expect(404);
      await manager
        .post('/time/exceptions/not-a-uuid/dismiss', { note: 'x' })
        .expect(400);
      await manager
        .post(`/time/exceptions/${periodId}/dismiss`, { note: 'x' })
        .expect(404);
      const resolved = await manager
        .post(resolve, { note: 'Bus strike' })
        .expect(200);
      expect(resolved.body).toMatchObject({
        status: 'RESOLVED',
        resolutionNote: 'Bus strike',
        resolvedByUserId: fx.users.managerA,
      });
      await manager.post(resolve, { note: 'Again' }).expect(200);
      await manager
        .post(`/time/exceptions/${exception.id}/dismiss`, { note: 'No' })
        .expect(409);
    });
  });
});
