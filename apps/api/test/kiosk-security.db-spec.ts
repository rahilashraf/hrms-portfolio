import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { AttendanceCredentialService } from '../src/kiosk/attendance-credential.service.js';
import { AttendanceDeviceService } from '../src/kiosk/attendance-device.service.js';
import { AttendanceKioskService } from '../src/kiosk/attendance-kiosk.service.js';
import { KioskRateLimiterService } from '../src/kiosk/kiosk-rate-limiter.service.js';
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
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
  toronto,
} from './support/time-fixtures.js';
import { addOrganizationBAssignment } from './support/time-world.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  self1: [
    { permissions: ['time.clock'], scope: 'org' as const },
    { permissions: ['time.clock'], scope: 'orgB' as const },
  ],
  deviceAdmin: [{ permissions: ['time.device.manage'], scope: 'org' as const }],
  /** PIN administrators of one organization each, and of both. */
  pinAdminA: [
    { permissions: ['time.credential.manage'], scope: 'org' as const },
  ],
  pinAdminB: [
    { permissions: ['time.credential.manage'], scope: 'orgB' as const },
  ],
  pinAdminAB: [
    { permissions: ['time.credential.manage'], scope: 'org' as const },
    { permissions: ['time.credential.manage'], scope: 'orgB' as const },
  ],
  /** Gets time.credential.manage at System scope in the recovery test. */
  recovery: [{ permissions: ['time.view'], scope: 'org' as const }],
};

/** Low limits so the tests run quickly (the same keys an operator sets in production). */
const LIMITS: Record<string, number> = {
  KIOSK_DEVICE_FAILURE_LIMIT: 3,
  KIOSK_DEVICE_EMPLOYEE_FAILURE_LIMIT: 3,
  KIOSK_EMPLOYEE_FAILURE_LIMIT: 4,
  KIOSK_ORGANIZATION_FAILURE_LIMIT: 50,
};

const testConfig = {
  getOrThrow: (key: string) => {
    const value = process.env[key];
    if (value === undefined) throw new Error(`${key} missing`);
    return key.startsWith('ARGON2_') ? Number(value) : value;
  },
  get: (key: string) => LIMITS[key],
} as unknown as ConfigService;

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  devices: AttendanceDeviceService;
  credentials: AttendanceCredentialService;
  kiosk: AttendanceKioskService;
  svc: ReturnType<typeof timeServices>;
  orgB: { assignmentId: string };
}

const body = (error: unknown) =>
  (error as HttpException).getResponse() as Record<string, unknown>;
const status = (error: unknown) => (error as HttpException).getStatus();

/**
 * Batch 4B (decisions D4 and D6) — kiosk credential security and kiosk hardening.
 *
 * One PIN per employee works in every organization they work in, so changing it is an act on
 * all of them: an administrator of only some of them can't reset or revoke it, a System-scope
 * holder can (audited as such), and an administrator's revocation can't be undone through
 * self-service. Identification limits count failures only; a kiosk's cancel and actions reach
 * only its own interactions; a disabled device can't enroll.
 */
describe('Kiosk credential security and hardening (Batch 4B, database)', () => {
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
          const orgB = await addOrganizationBAssignment(tx, fx);
          // Team A captures at kiosks only.
          await tx.timeAttendancePolicy.create({
            data: {
              scopeType: 'EMPLOYMENT_ASSIGNMENT',
              employmentAssignmentId: fx.assignmentTeamA,
              effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
              config: { attendance: { captureMode: 'KIOSK_ONLY' } },
            },
          });
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
            new KioskRateLimiterService(redis, testConfig),
            credentials,
            svc.time,
            signIns,
            svc.audit,
          );
          await run({
            tx,
            fx,
            clock,
            devices,
            credentials,
            kiosk,
            svc,
            orgB,
          }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  async function enrolledKiosk(h: Harness, name: string) {
    const registered = await h.devices.register(
      h.fx.users.deviceAdmin!,
      {
        organizationId: h.fx.orgA,
        physicalSiteId: h.fx.physicalSiteToronto,
        name,
      },
      ctx(h.fx.users.deviceAdmin!),
    );
    const { secret } = await h.devices.enroll(registered.enrollment.code, {});
    const device = await h.devices.authenticate(secret, {});
    return {
      id: device.id,
      organizationId: device.organizationId,
      physicalSiteId: device.physicalSiteId,
    };
  }

  const numberOf = (h: Harness, employeeId: string) =>
    h.tx.employee
      .findUniqueOrThrow({ where: { id: employeeId } })
      .then((employee) => employee.employeeNumber);

  const activePins = (h: Harness, employeeId: string) =>
    h.tx.attendanceCredential.findMany({
      where: { employeeId, status: 'ACTIVE' },
      select: { id: true },
    });

  it('lets only an administrator of every organization the PIN works in, or System scope, reset or revoke a shared PIN', async () => {
    await scenario(async (h) => {
      const { fx, credentials, tx } = h;
      const number = await numberOf(h, fx.employee1);
      const issued = await credentials.issuePin(
        fx.users.pinAdminAB!,
        fx.employee1,
        ctx(fx.users.pinAdminAB!),
      );
      const original = await activePins(h, fx.employee1);

      // An administrator of only one of the employee's organizations can't reset or revoke it,
      // in either direction; nothing changes and the PIN still works in both organizations.
      for (const admin of [fx.users.pinAdminA!, fx.users.pinAdminB!]) {
        for (const attempt of [
          () => credentials.issuePin(admin, fx.employee1, ctx(admin)),
          () =>
            credentials.revokePin(admin, fx.employee1, 'Lost card', ctx(admin)),
        ]) {
          const error = await rejection(attempt());
          expect(status(error)).toBe(403);
          expect(body(error)).toMatchObject({
            code: 'ATTENDANCE_PIN_SHARED_SCOPE',
          });
        }
      }
      expect(await activePins(h, fx.employee1)).toEqual(original);
      for (const organizationId of [fx.orgA, fx.orgB]) {
        expect(
          await credentials.verifyPin(number, issued.pin, organizationId, {}),
        ).toMatchObject({ employeeId: fx.employee1 });
      }
      // An administrator of neither organization cannot see the employee at all (Batch 4F, D4).
      expect(
        status(
          await rejection(
            credentials.issuePin(
              fx.users.deviceAdmin!,
              fx.employee1,
              ctx(fx.users.deviceAdmin!),
            ),
          ),
        ),
      ).toBe(404);

      // An administrator of both organizations can, audited with the organizations covered.
      const reset = await credentials.issuePin(
        fx.users.pinAdminAB!,
        fx.employee1,
        ctx(fx.users.pinAdminAB!),
      );
      expect(reset.reset).toBe(true);
      const audit = await tx.auditLog.findFirstOrThrow({
        where: {
          action: 'ATTENDANCE_PIN_RESET',
          actorUserId: fx.users.pinAdminAB!,
        },
      });
      expect(audit.metadata).toMatchObject({
        employeeId: fx.employee1,
        authority: 'ASSIGNMENTS',
        organizationIds: [fx.orgA, fx.orgB].sort(),
      });
      // The single-organization rule is unchanged: Employee 2 works only in A.
      await credentials.issuePin(
        fx.users.pinAdminA!,
        fx.employee2,
        ctx(fx.users.pinAdminA!),
      );
      expect(await activePins(h, fx.employee2)).toHaveLength(1);
    });
  });

  it('recovers a shared PIN through System scope only, audited as such', async () => {
    await scenario(async (h) => {
      const { fx, credentials, tx } = h;
      const recovery = fx.users.recovery!;
      // Without time.credential.manage anywhere the employee is not visible (Batch 4F, D4).
      expect(
        status(
          await rejection(
            credentials.issuePin(recovery, fx.employee1, ctx(recovery)),
          ),
        ),
      ).toBe(404);
      const role =
        (await tx.role.findFirst({ where: { isSystemOwner: true } })) ??
        (await tx.role.create({
          data: {
            organizationId: null,
            code: 'SYSTEM_OWNER',
            name: 'System Owner',
            isSystemOwner: true,
          },
        }));
      const permission = await tx.permission.findUniqueOrThrow({
        where: { key: 'time.credential.manage' },
      });
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: permission.id },
        },
        create: { roleId: role.id, permissionId: permission.id },
        update: {},
      });
      await tx.roleAssignment.create({
        data: { userId: recovery, roleId: role.id, scopeType: 'SYSTEM' },
      });

      const { pin } = await credentials.issuePin(
        recovery,
        fx.employee1,
        ctx(recovery),
      );
      expect(
        await credentials.verifyPin(
          await numberOf(h, fx.employee1),
          pin,
          fx.orgB,
          {},
        ),
      ).toMatchObject({ employeeId: fx.employee1 });
      await credentials.revokePin(
        recovery,
        fx.employee1,
        'Recovery: compromised',
        ctx(recovery),
      );
      for (const action of [
        'ATTENDANCE_PIN_ISSUED',
        'ATTENDANCE_PIN_REVOKED',
      ]) {
        expect(
          (
            await tx.auditLog.findFirstOrThrow({
              where: { action, actorUserId: recovery },
            })
          ).metadata,
        ).toMatchObject({ authority: 'SYSTEM' });
      }
    });
  });

  it('keeps an administrator’s revocation until an authorized administrator issues a new PIN', async () => {
    await scenario(async (h) => {
      const { fx, credentials } = h;
      const admin = fx.users.pinAdminAB!;
      const self = fx.selfUser1;
      await credentials.issuePin(admin, fx.employee1, ctx(admin));
      await credentials.revokePin(
        admin,
        fx.employee1,
        'Shared with a coworker',
        ctx(admin),
      );

      // Self-service can't bring the PIN back...
      const refused = await rejection(
        credentials.changeOwnPin(self, { newPin: '482915' }, ctx(self)),
      );
      expect(status(refused)).toBe(403);
      expect(body(refused)).toMatchObject({
        code: 'ATTENDANCE_PIN_ADMIN_REVOKED',
      });
      expect(await activePins(h, fx.employee1)).toEqual([]);
      // ...nor can an administrator of only one of the organizations.
      expect(
        body(
          await rejection(
            credentials.issuePin(
              fx.users.pinAdminB!,
              fx.employee1,
              ctx(fx.users.pinAdminB!),
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_PIN_SHARED_SCOPE' });

      // An authorized administrator re-enables it by issuing a new PIN; the employee may then
      // replace it with one of their own (with the current one), as always.
      const { pin } = await credentials.issuePin(
        admin,
        fx.employee1,
        ctx(admin),
      );
      await credentials.changeOwnPin(
        self,
        { currentPin: pin, newPin: '482915' },
        ctx(self),
      );
      expect(await activePins(h, fx.employee1)).toHaveLength(1);
      // Their own change is not an administrator's revocation: they can change it again.
      await credentials.changeOwnPin(
        self,
        { currentPin: '482915', newPin: '739264' },
        ctx(self),
      );
      expect(await activePins(h, fx.employee1)).toHaveLength(1);
    });
  });

  it('never throttles successful identifications at a busy kiosk; failures are limited per device, per employee number and across kiosks', async () => {
    await scenario(async (h) => {
      const { fx, credentials, kiosk } = h;
      const admin = fx.users.pinAdminAB!;
      const device = await enrolledKiosk(h, 'Busy entrance');
      const second = await enrolledKiosk(h, 'Side entrance');
      const third = await enrolledKiosk(h, 'Loading dock');
      const pins = new Map<string, string>();
      for (const employeeId of [fx.employee1, fx.employee2]) {
        pins.set(
          employeeId,
          (await credentials.issuePin(admin, employeeId, ctx(admin))).pin,
        );
      }
      const one = await numberOf(h, fx.employee1);
      const two = await numberOf(h, fx.employee2);
      const identify = (
        at: typeof device,
        employeeNumber: string,
        pin: string,
      ) => kiosk.identify(at, { employeeNumber, pin }, {});
      const wrong = (pin: string) => (pin === '000000' ? '111111' : '000000');

      // Twelve successful identifications on one kiosk with a device limit of 3: all succeed.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const employeeId = attempt % 2 === 0 ? fx.employee1 : fx.employee2;
        const identified = await identify(
          device,
          employeeId === fx.employee1 ? one : two,
          pins.get(employeeId)!,
        );
        await kiosk.cancel(device, identified.token);
      }

      // Failures count: two wrong PINs for Employee 2 and one unknown number reach the device
      // limit (3); the next attempt at this kiosk is refused, even with a correct PIN.
      for (const attempt of [
        () => identify(device, two, wrong(pins.get(fx.employee2)!)),
        () => identify(device, two, wrong(pins.get(fx.employee2)!)),
        () => identify(device, `NOPE-${fx.suffix}`, '123456'),
      ]) {
        expect(status(await rejection(attempt()))).toBe(401);
      }
      expect(
        body(await rejection(identify(device, one, pins.get(fx.employee1)!))),
      ).toMatchObject({ code: 'KIOSK_RATE_LIMITED' });
      // Another kiosk is unaffected by that device's failures.
      await identify(second, one, pins.get(fx.employee1)!);

      // Employee 2's number has 2 failures; 2 more at the second kiosk reach the limit for the
      // number across kiosks (4), so it is refused there too. (That kiosk has now had 3 failed
      // attempts itself; Employee 1 still identifies at a third.)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(
          status(
            await rejection(
              identify(second, two, wrong(pins.get(fx.employee2)!)),
            ),
          ),
        ).toBe(401);
      }
      expect(
        body(await rejection(identify(second, two, pins.get(fx.employee2)!))),
      ).toMatchObject({ code: 'KIOSK_RATE_LIMITED' });
      await identify(third, one, pins.get(fx.employee1)!);
    });
  });

  it('cancels and acts on an interaction only at the kiosk that started it; kiosk-only capture still holds', async () => {
    await scenario(async (h) => {
      const { fx, credentials, kiosk, svc, clock, tx } = h;
      const admin = fx.users.pinAdminAB!;
      const device = await enrolledKiosk(h, 'Front desk');
      const other = await enrolledKiosk(h, 'Back desk');
      const { pin } = await credentials.issuePin(
        admin,
        fx.employee1,
        ctx(admin),
      );
      const number = await numberOf(h, fx.employee1);
      clock.value = toronto('2027-03-02T09:00');

      // Team A is KIOSK_ONLY: self-service clock-in is refused.
      expect(
        status(
          await rejection(
            svc.time.clockIn(
              fx.selfUser1,
              fx.assignmentTeamA,
              ctx(fx.selfUser1),
            ),
          ),
        ),
      ).toBe(403);

      const identified = await kiosk.identify(
        device,
        { employeeNumber: number, pin },
        {},
      );
      // Another kiosk presenting the token discards nothing...
      expect(await kiosk.cancel(other, identified.token)).toEqual({
        cancelled: false,
      });
      // ...so the employee can still act at the kiosk where they identified.
      await kiosk.act(
        device,
        {
          token: identified.token,
          action: 'CLOCK_IN',
          employmentAssignmentId: fx.assignmentTeamA,
        },
        {},
      );
      expect(
        await tx.timeEntry.count({
          where: { employeeId: fx.employee1, status: 'OPEN' },
        }),
      ).toBe(1);

      // The kiosk that started an interaction cancels it, and then it is gone.
      clock.value = toronto('2027-03-02T12:00');
      const again = await kiosk.identify(
        device,
        { employeeNumber: number, pin },
        {},
      );
      expect(await kiosk.cancel(device, again.token)).toEqual({
        cancelled: true,
      });
      expect(
        body(
          await rejection(
            kiosk.act(device, { token: again.token, action: 'CLOCK_OUT' }, {}),
          ),
        ),
      ).toMatchObject({ code: 'KIOSK_INTERACTION_EXPIRED' });
    });
  });

  it('refuses enrollment of a disabled device until it is enabled again', async () => {
    await scenario(async (h) => {
      const { fx, devices } = h;
      const admin = fx.users.deviceAdmin!;
      const registered = await devices.register(
        admin,
        {
          organizationId: fx.orgA,
          physicalSiteId: fx.physicalSiteToronto,
          name: 'Warehouse',
        },
        ctx(admin),
      );
      await devices.setEnabled(admin, registered.device.id, false, ctx(admin));
      const refused = await rejection(
        devices.enroll(registered.enrollment.code, {}),
      );
      expect(status(refused)).toBe(401);
      expect(body(refused)).toMatchObject({ code: 'KIOSK_ENROLLMENT_INVALID' });

      // Enabled again, the same (unexpired) code enrolls the device; rotation still works.
      await devices.setEnabled(admin, registered.device.id, true, ctx(admin));
      const { deviceId } = await devices.enroll(registered.enrollment.code, {});
      expect(deviceId).toBe(registered.device.id);
      const rotated = await devices.rotate(
        admin,
        registered.device.id,
        ctx(admin),
      );
      await devices.enroll(rotated.enrollment.code, {});
    });
  });
});
