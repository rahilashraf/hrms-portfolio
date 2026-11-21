import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { AttendanceCredentialService } from '../src/kiosk/attendance-credential.service.js';
import { AttendanceDeviceService } from '../src/kiosk/attendance-device.service.js';
import { AttendanceKioskService } from '../src/kiosk/attendance-kiosk.service.js';
import { KioskRateLimiterService } from '../src/kiosk/kiosk-rate-limiter.service.js';
import { sha256 } from '../src/kiosk/kiosk-secrets.js';
import { RedisService } from '../src/redis/redis.service.js';
import { PasswordHasherService } from '../src/security/password-hasher.service.js';
import { AttendanceSignInService } from '../src/time/attendance-sign-in.service.js';
import { TimeDomainService } from '../src/time/time-domain.service.js';
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

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  deviceAdmin: [{ permissions: ['time.device.manage'], scope: 'org' as const }],
  pinAdmin: [
    { permissions: ['time.credential.manage'], scope: 'teamA' as const },
  ],
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  outsider: [
    {
      permissions: ['time.device.manage', 'time.credential.manage'],
      scope: 'orgB' as const,
    },
  ],
};

const testConfig = {
  getOrThrow: (key: string) => {
    const value = process.env[key];
    if (value === undefined) throw new Error(`${key} missing`);
    return key.startsWith('ARGON2_') ? Number(value) : value;
  },
} as unknown as ConfigService;

const body = (error: unknown) => (error as HttpException).getResponse();
const status = (error: unknown) => (error as HttpException).getStatus();

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  devices: AttendanceDeviceService;
  credentials: AttendanceCredentialService;
  kiosk: AttendanceKioskService;
  svc: ReturnType<typeof timeServices>;
}

/**
 * Phase 9.5 — trusted devices, attendance PINs and the kiosk flow: enrollment and revocation,
 * hashed PINs with lockout and one generic failure, single-use interaction tokens bound to the
 * device, and a minimal view that exposes nothing beyond a first name and the actions.
 */
describe('Attendance kiosk (database)', () => {
  let prisma: PrismaService;
  let redis: RedisService;
  const hasher = new PasswordHasherService(testConfig);

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    redis = new RedisService(testConfig);
    await redis.client.connect();
  });

  afterAll(async () => {
    redis?.client.disconnect();
    await prisma?.$disconnect();
  });

  async function scenario(run: (h: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, [
            ...TIME_PERMISSIONS,
            'time.device.manage',
            'time.credential.manage',
          ]);
          await seedTimePolicy(tx, fx.orgA);
          const clock = new FixedClock();
          const client = rollbackClient(tx);
          const svc = timeServices(client, clock);
          const devices = new AttendanceDeviceService(
            client,
            svc.authorization,
            svc.audit,
          );
          const credentials = new AttendanceCredentialService(
            client,
            svc.authorization,
            svc.targets,
            svc.audit,
            hasher,
          );
          const signIns = new AttendanceSignInService(
            client,
            svc.time,
            new TimeDomainService(),
            svc.audit,
            clock,
            svc.schedules,
          );
          const kiosk = new AttendanceKioskService(
            client,
            redis,
            new KioskRateLimiterService(redis),
            credentials,
            svc.time,
            signIns,
            svc.audit,
          );
          await run({ tx, fx, clock, devices, credentials, kiosk, svc });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** A registered and enrolled kiosk at the Toronto physical site, with its device secret. */
  async function enrolledKiosk(h: Harness, name = 'Front desk') {
    const admin = ctx(h.fx.users.deviceAdmin!);
    const registered = await h.devices.register(
      h.fx.users.deviceAdmin!,
      {
        organizationId: h.fx.orgA,
        physicalSiteId: h.fx.physicalSiteToronto,
        name,
      },
      admin,
    );
    const { secret } = await h.devices.enroll(
      registered.enrollment.code.toLowerCase(),
      {},
    );
    const device = await h.devices.authenticate(secret, {});
    return {
      secret,
      registered,
      device: {
        id: device.id,
        organizationId: device.organizationId,
        physicalSiteId: device.physicalSiteId,
      },
    };
  }

  const employeeNumber = (h: Harness, employeeId: string) =>
    h.tx.employee
      .findUniqueOrThrow({ where: { id: employeeId } })
      .then((e) => e.employeeNumber);

  it('registers, enrolls once, rotates, disables and revokes devices', async () => {
    await scenario(async (h) => {
      const { tx, fx, devices } = h;
      const admin = ctx(fx.users.deviceAdmin!);
      const { secret, registered, device } = await enrolledKiosk(h);
      expect(registered.enrollment.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      expect(registered.device).toMatchObject({
        status: 'ACTIVE',
        enrolled: false,
        enrollmentPending: true,
      });
      // Only hashes are stored; the code is single-use.
      const row = await tx.attendanceDevice.findUniqueOrThrow({
        where: { id: device.id },
      });
      expect(row.credentialHash).toBe(sha256(secret));
      expect(row.enrollmentCodeHash).toBeNull();
      expect(
        body(await rejection(devices.enroll(registered.enrollment.code, {}))),
      ).toMatchObject({
        code: 'KIOSK_ENROLLMENT_INVALID',
      });
      // Rotation invalidates the current secret until the device is enrolled again.
      const rotated = await devices.rotate(
        fx.users.deviceAdmin!,
        device.id,
        admin,
      );
      expect(
        body(await rejection(devices.authenticate(secret, {}))),
      ).toMatchObject({
        code: 'KIOSK_DEVICE_UNAUTHENTICATED',
      });
      const { secret: renewed } = await devices.enroll(
        rotated.enrollment.code,
        {},
      );
      // Disabled: known but inactive. Revoked: final and unauthenticated.
      await devices.setEnabled(fx.users.deviceAdmin!, device.id, false, admin);
      expect(
        body(await rejection(devices.authenticate(renewed, {}))),
      ).toMatchObject({
        code: 'KIOSK_DEVICE_INACTIVE',
      });
      await devices.setEnabled(fx.users.deviceAdmin!, device.id, true, admin);
      await devices.authenticate(renewed, {});
      await devices.revoke(
        fx.users.deviceAdmin!,
        device.id,
        'Tablet lost',
        admin,
      );
      expect(
        body(await rejection(devices.authenticate(renewed, {}))),
      ).toMatchObject({
        code: 'KIOSK_DEVICE_UNAUTHENTICATED',
      });
      expect(
        body(
          await rejection(
            devices.rotate(fx.users.deviceAdmin!, device.id, admin),
          ),
        ),
      ).toMatchObject({
        code: 'KIOSK_DEVICE_REVOKED',
      });
      // Only time.device.manage on the organization; never another organization's devices.
      expect(
        await rejection(
          devices.register(
            fx.users.outsider!,
            {
              organizationId: fx.orgA,
              physicalSiteId: fx.physicalSiteToronto,
              name: 'X',
            },
            ctx(fx.users.outsider!),
          ),
        ),
      ).toBeInstanceOf(ForbiddenException);
      expect(
        await rejection(devices.list(fx.users.pinAdmin!, fx.orgA)),
      ).toBeInstanceOf(ForbiddenException);
      const foreignSite = await tx.physicalSite.create({
        data: { organizationId: fx.orgB, name: `Foreign ${fx.suffix}` },
      });
      expect(
        status(
          await rejection(
            devices.register(
              fx.users.deviceAdmin!,
              {
                organizationId: fx.orgA,
                physicalSiteId: foreignSite.id,
                name: 'Foreign site tablet',
              },
              admin,
            ),
          ),
        ),
      ).toBe(404);
      // An archived physical site cannot host a kiosk.
      const archivedSite = await tx.physicalSite.create({
        data: {
          organizationId: fx.orgA,
          name: `Closed site ${fx.suffix}`,
          archivedAt: new Date(),
        },
      });
      expect(
        body(
          await rejection(
            devices.register(
              fx.users.deviceAdmin!,
              {
                organizationId: fx.orgA,
                physicalSiteId: archivedSite.id,
                name: 'Y',
              },
              admin,
            ),
          ),
        ),
      ).toMatchObject({ code: 'KIOSK_LOCATION_UNUSABLE' });
      expect(
        (
          await tx.auditLog.findMany({
            where: { entityId: device.id },
            select: { action: true },
          })
        )
          .map((entry) => entry.action)
          .sort(),
      ).toEqual(
        [
          'ATTENDANCE_DEVICE_DISABLED',
          'ATTENDANCE_DEVICE_ENABLED',
          'ATTENDANCE_DEVICE_ENROLLED',
          'ATTENDANCE_DEVICE_ENROLLED',
          'ATTENDANCE_DEVICE_REGISTERED',
          'ATTENDANCE_DEVICE_REVOKED',
          'ATTENDANCE_DEVICE_ROTATED',
        ].sort(),
      );
    });
  });

  it('issues hashed PINs shown once, resets and revokes them, and lets employees change their own', async () => {
    await scenario(async (h) => {
      const { tx, fx, credentials } = h;
      const pinAdmin = ctx(fx.users.pinAdmin!);
      const issued = await credentials.issuePin(
        fx.users.pinAdmin!,
        fx.employee1,
        pinAdmin,
      );
      expect(issued.pin).toMatch(/^\d{6}$/);
      expect(issued.reset).toBe(false);
      const stored = await tx.attendanceCredential.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      expect(stored.secretHash).toMatch(/^\$argon2id\$/);
      expect(stored.secretHash).not.toContain(issued.pin);
      // The status never reveals the PIN.
      const view = await credentials.status(fx.users.pinAdmin!, fx.employee1);
      expect(view).toEqual({
        employeeId: fx.employee1,
        hasPin: true,
        issuedAt: expect.any(String),
        lastUsedAt: null,
        locked: false,
      });
      // A reset revokes the old PIN (history kept); the new one replaces it.
      const reset = await credentials.issuePin(
        fx.users.pinAdmin!,
        fx.employee1,
        pinAdmin,
      );
      expect(reset.reset).toBe(true);
      expect(
        await tx.attendanceCredential.count({
          where: { employeeId: fx.employee1 },
        }),
      ).toBe(2);
      expect(
        await credentials.verifyPin(
          await employeeNumber(h, fx.employee1),
          issued.pin,
          fx.orgA,
          {},
        ),
      ).toBeNull();
      expect(
        await credentials.verifyPin(
          await employeeNumber(h, fx.employee1),
          reset.pin,
          fx.orgA,
          {},
        ),
      ).not.toBeNull();
      // The employee changes it through their account: current PIN needed, weak PINs refused.
      const self = ctx(fx.selfUser1);
      expect(
        body(
          await rejection(
            credentials.changeOwnPin(fx.selfUser1, { newPin: '482915' }, self),
          ),
        ),
      ).toMatchObject({
        code: 'ATTENDANCE_PIN_INCORRECT',
      });
      expect(
        body(
          await rejection(
            credentials.changeOwnPin(
              fx.selfUser1,
              { currentPin: reset.pin, newPin: '123456' },
              self,
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_PIN_WEAK' });
      await credentials.changeOwnPin(
        fx.selfUser1,
        { currentPin: reset.pin, newPin: '482915' },
        self,
      );
      expect(
        await credentials.verifyPin(
          await employeeNumber(h, fx.employee1),
          '482915',
          fx.orgA,
          {},
        ),
      ).not.toBeNull();
      // Scoped: the Team A administrator manages Employee 1 (Team A); Org B's administrator cannot.
      await credentials.revokePin(
        fx.users.pinAdmin!,
        fx.employee1,
        'Left the hall',
        pinAdmin,
      );
      expect(
        (await credentials.status(fx.users.pinAdmin!, fx.employee1)).hasPin,
      ).toBe(false);
      // Batch 4F (D4): an administrator of another organization only cannot see the employee.
      expect(
        await rejection(
          credentials.issuePin(
            fx.users.outsider!,
            fx.employee1,
            ctx(fx.users.outsider!),
          ),
        ),
      ).toBeInstanceOf(NotFoundException);
      expect(
        (
          await tx.auditLog.findMany({
            where: { entityType: 'AttendanceCredential' },
            select: { action: true },
          })
        ).map((entry) => entry.action),
      ).toEqual(
        expect.arrayContaining([
          'ATTENDANCE_PIN_ISSUED',
          'ATTENDANCE_PIN_RESET',
          'ATTENDANCE_PIN_CHANGED',
          'ATTENDANCE_PIN_REVOKED',
        ]),
      );
      // No audit entry ever contains a PIN.
      const audits = await tx.auditLog.findMany({
        where: { entityType: 'AttendanceCredential' },
      });
      for (const entry of audits) {
        for (const secret of [issued.pin, reset.pin, '482915']) {
          expect(JSON.stringify(entry.metadata)).not.toContain(secret);
        }
      }
    });
  });

  it('locks a PIN after repeated failures and answers every failure the same way', async () => {
    await scenario(async (h) => {
      const { tx, fx, credentials, kiosk } = h;
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentTeamA,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          config: { attendance: { captureMode: 'KIOSK_ONLY' } },
        },
      });
      const { device } = await enrolledKiosk(h);
      const { pin } = await credentials.issuePin(
        fx.users.pinAdmin!,
        fx.employee1,
        ctx(fx.users.pinAdmin!),
      );
      const number = await employeeNumber(h, fx.employee1);
      const wrong = pin === '000000' ? '111111' : '000000';
      const failures = [];
      // An unknown number, a wrong PIN and a malformed PIN are indistinguishable.
      failures.push(
        await rejection(
          kiosk.identify(device, { employeeNumber: 'NOPE-404', pin }, {}),
        ),
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        failures.push(
          await rejection(
            kiosk.identify(device, { employeeNumber: number, pin: wrong }, {}),
          ),
        );
      }
      for (const failure of failures) {
        expect(status(failure)).toBe(401);
        expect(body(failure)).toEqual({
          statusCode: 401,
          error: 'Unauthorized',
          code: 'KIOSK_IDENTIFICATION_FAILED',
          message: 'Employee number or PIN not recognized.',
        });
      }
      // The fifth wrong PIN locked the credential (temporarily, atomically, audited).
      const locked = await tx.attendanceCredential.findFirstOrThrow({
        where: { employeeId: fx.employee1, status: 'ACTIVE' },
      });
      expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      // A sixth attempt for the number at this device is rate-limited (5 per 15 minutes).
      expect(
        status(
          await rejection(
            kiosk.identify(device, { employeeNumber: number, pin }, {}),
          ),
        ),
      ).toBe(429);
      // Even the right PIN fails while locked, with the same answer.
      expect(await credentials.verifyPin(number, pin, fx.orgA, {})).toBeNull();
      expect(
        await tx.auditLog.count({
          where: { action: 'ATTENDANCE_PIN_LOCKED', entityId: locked.id },
        }),
      ).toBe(1);
    });
  });

  it('never lets another organization, a stale check or self-service get past a PIN lockout', async () => {
    await scenario(async (h) => {
      const { tx, fx, credentials } = h;
      const { pin } = await credentials.issuePin(
        fx.users.pinAdmin!,
        fx.employee1,
        ctx(fx.users.pinAdmin!),
      );
      const number = await employeeNumber(h, fx.employee1);
      const wrong = pin === '000000' ? '111111' : '000000';
      const active = () =>
        tx.attendanceCredential.findFirstOrThrow({
          where: { employeeId: fx.employee1, status: 'ACTIVE' },
        });

      // A kiosk of an organization the employee does not work in never counts failures, and
      // even the right PIN identifies no one there.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        expect(
          await credentials.verifyPin(number, wrong, fx.orgB, {}),
        ).toBeNull();
      }
      expect(await credentials.verifyPin(number, pin, fx.orgB, {})).toBeNull();
      expect(await active()).toMatchObject({
        failedAttempts: 0,
        lockedUntil: null,
        lastUsedAt: null,
      });

      // A correct PIN checked against a snapshot taken before a concurrent lock fails and
      // leaves the lock in place.
      const snapshot = await active();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await credentials.verifyPin(number, wrong, fx.orgA, {});
      }
      const verifyAgainst = (
        credentials as unknown as {
          verifyAgainst(
            credential: typeof snapshot,
            pin: string,
            context: object,
          ): Promise<boolean>;
        }
      ).verifyAgainst.bind(credentials);
      expect(await verifyAgainst(snapshot, pin, {})).toBe(false);
      const locked = await active();
      expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // Changing one's own PIN is refused while locked, even with the right current PIN.
      expect(
        body(
          await rejection(
            credentials.changeOwnPin(
              fx.selfUser1,
              { currentPin: pin, newPin: '482915' },
              ctx(fx.selfUser1),
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_PIN_LOCKED' });
      expect((await active()).id).toBe(locked.id);
    });
  });

  it('runs the kiosk flow with a minimal view and single-use, device-bound interactions', async () => {
    await scenario(async (h) => {
      const { tx, fx, credentials, kiosk, clock } = h;
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentTeamA,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          config: { attendance: { captureMode: 'KIOSK_ONLY' } },
        },
      });
      const { device } = await enrolledKiosk(h);
      const { device: other } = await enrolledKiosk(h, 'Side door');
      const { pin } = await credentials.issuePin(
        fx.users.pinAdmin!,
        fx.employee1,
        ctx(fx.users.pinAdmin!),
      );
      const number = await employeeNumber(h, fx.employee1);
      clock.value = toronto('2027-03-02T09:00');

      const identified = await kiosk.identify(
        device,
        { employeeNumber: number.toLowerCase(), pin },
        {},
      );
      // Only a first name, actions and (when needed) a fixed explanation: no number, no
      // profile, no pay, no leave, no history.
      expect(Object.keys(identified).sort()).toEqual([
        'actions',
        'employee',
        'expiresInSeconds',
        'notice',
        'state',
        'token',
      ]);
      expect(identified.notice).toBeNull();
      expect(identified.employee).toEqual({ firstName: expect.any(String) });
      expect(identified.state).toBe('OFF_CLOCK');
      expect(identified.actions).toEqual([
        {
          action: 'CLOCK_IN',
          employmentAssignmentId: fx.assignmentTeamA,
          label: expect.stringContaining('Clock in'),
        },
      ]);
      expect(JSON.stringify(identified)).not.toContain(number);

      // The token works once, only at the device that issued it, only for offered actions.
      expect(
        body(
          await rejection(
            kiosk.act(
              other,
              {
                token: identified.token,
                action: 'CLOCK_IN',
                employmentAssignmentId: fx.assignmentTeamA,
              },
              {},
            ),
          ),
        ),
      ).toMatchObject({ code: 'KIOSK_INTERACTION_EXPIRED' });
      const again = await kiosk.identify(
        device,
        { employeeNumber: number, pin },
        {},
      );
      expect(
        body(
          await rejection(
            kiosk.act(device, { token: again.token, action: 'CLOCK_OUT' }, {}),
          ),
        ),
      ).toMatchObject({ code: 'KIOSK_ACTION_NOT_OFFERED' });
      const third = await kiosk.identify(
        device,
        { employeeNumber: number, pin },
        {},
      );
      const done = await kiosk.act(
        device,
        {
          token: third.token,
          action: 'CLOCK_IN',
          employmentAssignmentId: fx.assignmentTeamA,
        },
        {},
      );
      expect(done).toMatchObject({ action: 'CLOCK_IN', outcome: 'RECORDED' });
      expect(
        body(
          await rejection(
            kiosk.act(
              device,
              {
                token: third.token,
                action: 'CLOCK_IN',
                employmentAssignmentId: fx.assignmentTeamA,
              },
              {},
            ),
          ),
        ),
      ).toMatchObject({ code: 'KIOSK_INTERACTION_EXPIRED' });
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      expect(entry.source).toBe('KIOSK');

      // Next identification offers clocking out; a credential revoked in between is refused.
      clock.value = toronto('2027-03-02T12:00');
      const out = await kiosk.identify(
        device,
        { employeeNumber: number, pin },
        {},
      );
      expect(out.state).toBe('CLOCKED_IN');
      expect(out.actions.map((option) => option.action)).toContain('CLOCK_OUT');
      await credentials.revokePin(
        fx.users.pinAdmin!,
        fx.employee1,
        'Lost',
        ctx(fx.users.pinAdmin!),
      );
      expect(
        body(
          await rejection(
            kiosk.act(device, { token: out.token, action: 'CLOCK_OUT' }, {}),
          ),
        ),
      ).toMatchObject({ code: 'KIOSK_IDENTIFICATION_FAILED' });

      // An employee of another organization is indistinguishable from a wrong PIN.
      const orgBSite = await tx.physicalSite.create({
        data: {
          organizationId: fx.orgB,
          name: `B site ${fx.suffix}`,
        },
      });
      const orgBDevice = await tx.attendanceDevice.create({
        data: {
          organizationId: fx.orgB,
          physicalSiteId: orgBSite.id,
          name: 'B kiosk',
        },
      });
      const { pin: pin2 } = await credentials.issuePin(
        fx.users.pinAdmin!,
        fx.employee2,
        ctx(fx.users.pinAdmin!),
      );
      expect(
        body(
          await rejection(
            kiosk.identify(
              {
                id: orgBDevice.id,
                organizationId: fx.orgB,
                physicalSiteId: orgBSite.id,
              },
              {
                employeeNumber: await employeeNumber(h, fx.employee2),
                pin: pin2,
              },
              {},
            ),
          ),
        ),
      ).toMatchObject({ code: 'KIOSK_IDENTIFICATION_FAILED' });
    });
  });

  it('reports a clock-in warning at the kiosk by code only (R4-A.3)', async () => {
    await scenario(async (h) => {
      const { tx, fx, credentials, kiosk, clock } = h;
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentTeamA,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          config: { attendance: { captureMode: 'KIOSK_ONLY' } },
        },
      });
      // Work with no published shift is recorded and flagged.
      await tx.schedulePolicy.create({
        data: {
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
          effectiveFrom: new Date('2027-01-01T00:00:00.000Z'),
          unscheduledWorkMode: 'WARN_UNSCHEDULED',
        },
      });
      const { device } = await enrolledKiosk(h);
      const { pin } = await credentials.issuePin(
        fx.users.pinAdmin!,
        fx.employee1,
        ctx(fx.users.pinAdmin!),
      );
      const number = await employeeNumber(h, fx.employee1);
      clock.value = toronto('2027-03-02T09:00');
      const identified = await kiosk.identify(
        device,
        { employeeNumber: number, pin },
        {},
      );
      const done = await kiosk.act(
        device,
        {
          token: identified.token,
          action: 'CLOCK_IN',
          employmentAssignmentId: fx.assignmentTeamA,
        },
        {},
      );
      expect(done).toMatchObject({
        action: 'CLOCK_IN',
        outcome: 'RECORDED',
        warnings: [{ code: 'UNSCHEDULED_WORK' }],
      });
      // Nothing but the code reaches the shared screen (no record id, no message).
      expect(done).toHaveProperty('warnings', [{ code: 'UNSCHEDULED_WORK' }]);
      const exception = await tx.attendanceException.findFirstOrThrow({
        where: { employeeId: fx.employee1, type: 'UNSCHEDULED_WORK' },
      });
      expect(JSON.stringify(done)).not.toContain(exception.id);

      // Without a warning, the result has no warnings key (unchanged contract).
      const back = await kiosk.identify(
        device,
        { employeeNumber: number, pin },
        {},
      );
      clock.value = toronto('2027-03-02T12:00');
      const out = await kiosk.act(
        device,
        { token: back.token, action: 'CLOCK_OUT' },
        {},
      );
      expect(out).not.toHaveProperty('warnings');
    });
  });

  it('clocks in once for several assignments at the kiosk, only where each one may be captured', async () => {
    await scenario(async (h) => {
      const { tx, fx, credentials, kiosk, clock } = h;
      // Dept B's position has no work location: the org timezone makes it clockable at all.
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'America/Toronto' },
      });
      await tx.timeAttendancePolicy.updateMany({
        where: { organizationId: fx.orgA },
        data: {
          config: {
            ...LIVE_TIME_POLICY,
            attendance: {
              captureMode: 'KIOSK_OR_SELF_SERVICE',
              kioskLocationRule: 'ASSIGNMENT_WORK_LOCATION',
            },
          },
        },
      });
      const { device } = await enrolledKiosk(h); // Toronto physical site
      const { pin } = await credentials.issuePin(
        fx.users.pinAdmin!,
        fx.employee1,
        ctx(fx.users.pinAdmin!),
      );
      const number = await employeeNumber(h, fx.employee1);
      const identify = () =>
        kiosk.identify(device, { employeeNumber: number, pin }, {});
      clock.value = toronto('2027-03-02T09:00');

      // One eligible assignment (Dept B has no site here): the one-tap clock-in, nothing more.
      const single = await identify();
      expect(single.actions).toEqual([
        {
          action: 'CLOCK_IN',
          employmentAssignmentId: fx.assignmentTeamA,
          label: expect.stringContaining('Clock in'),
        },
      ]);
      // Dept B was not offered, so it cannot be claimed.
      expect(
        body(
          await rejection(
            kiosk.act(
              device,
              {
                token: single.token,
                action: 'CLOCK_IN',
                employmentAssignmentId: fx.assignmentTeamA,
                additionalEmploymentAssignmentIds: [fx.assignmentDeptB],
              },
              {},
            ),
          ),
        ),
      ).toMatchObject({ code: 'KIOSK_ACTION_NOT_OFFERED' });

      // Both assignments at this site: each one-tap option plus one multi-assignment option.
      await tx.position.update({
        where: { id: fx.positionDeptB },
        data: { workLocationId: fx.workLocationToronto },
      });
      const both = await identify();
      expect(both.actions).toEqual([
        expect.objectContaining({
          action: 'CLOCK_IN',
          employmentAssignmentId: fx.assignmentTeamA,
        }),
        expect.objectContaining({
          action: 'CLOCK_IN',
          employmentAssignmentId: fx.assignmentDeptB,
        }),
        {
          action: 'CLOCK_IN',
          employmentAssignmentId: null,
          coverableAssignments: [
            {
              employmentAssignmentId: fx.assignmentTeamA,
              name: expect.any(String),
            },
            {
              employmentAssignmentId: fx.assignmentDeptB,
              name: expect.any(String),
            },
          ],
          label: 'Clock in — several assignments',
        },
      ]);
      // Another employee's assignment is never claimable.
      expect(
        body(
          await rejection(
            kiosk.act(
              device,
              {
                token: both.token,
                action: 'CLOCK_IN',
                employmentAssignmentId: fx.assignmentTeamA,
                additionalEmploymentAssignmentIds: [fx.otherTeamA],
              },
              {},
            ),
          ),
        ),
      ).toMatchObject({ code: 'KIOSK_ACTION_NOT_OFFERED' });

      // The site rule is enforced server-side at capture: Dept B moved to Ottawa since the offer.
      const stale = await identify();
      await tx.position.update({
        where: { id: fx.positionDeptB },
        data: { workLocationId: fx.workLocationOttawa },
      });
      expect(
        body(
          await rejection(
            kiosk.act(
              device,
              {
                token: stale.token,
                action: 'CLOCK_IN',
                employmentAssignmentId: fx.assignmentTeamA,
                additionalEmploymentAssignmentIds: [fx.assignmentDeptB],
              },
              {},
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_KIOSK_LOCATION_NOT_ALLOWED' });
      expect(
        await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(0);

      // Same physical site: one physical clock-in covering both, Team A owning payroll.
      await tx.position.update({
        where: { id: fx.positionDeptB },
        data: { workLocationId: fx.workLocationToronto },
      });
      const ok = await identify();
      expect(
        await kiosk.act(
          device,
          {
            token: ok.token,
            action: 'CLOCK_IN',
            employmentAssignmentId: fx.assignmentTeamA,
            additionalEmploymentAssignmentIds: [fx.assignmentDeptB],
          },
          {},
        ),
      ).toMatchObject({ action: 'CLOCK_IN', outcome: 'RECORDED' });
      const entries = await tx.timeEntry.findMany({
        where: { employeeId: fx.employee1 },
        include: { assignmentCoverages: true, punches: true },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
        source: 'KIOSK',
      });
      expect(entries[0]!.punches).toHaveLength(1);
      expect(
        entries[0]!.assignmentCoverages
          .map((row) => row.employmentAssignmentId)
          .sort(),
      ).toEqual([fx.assignmentTeamA, fx.assignmentDeptB].sort());

      // Clocking out closes the one interval.
      clock.value = toronto('2027-03-02T15:00');
      const out = await identify();
      expect(out.state).toBe('CLOCKED_IN');
      await kiosk.act(device, { token: out.token, action: 'CLOCK_OUT' }, {});
      const closed = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      expect(closed.status).toBe('CLOSED');
      expect(
        (closed.clockOutAt!.getTime() - closed.clockInAt.getTime()) / 60_000,
      ).toBe(360);
    });
  });
});
