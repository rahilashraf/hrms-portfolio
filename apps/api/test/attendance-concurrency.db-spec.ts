import type { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { AttendanceCredentialService } from '../src/kiosk/attendance-credential.service.js';
import { PasswordHasherService } from '../src/security/password-hasher.service.js';
import { AttendanceSignInService } from '../src/time/attendance-sign-in.service.js';
import { TimeDomainService } from '../src/time/time-domain.service.js';
import type { KioskDevice } from '../src/time/time.service.js';
import {
  ALL_SCHEDULE_PERMISSIONS,
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  torontoShift,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  FixedClock,
  TIME_PERMISSIONS,
  timeServices,
  toronto,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

const USERS = {
  admin: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'org' as const }],
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  deviceAdmin: [
    {
      permissions: ['time.device.manage', 'time.credential.manage'],
      scope: 'org' as const,
    },
  ],
};

const testConfig = {
  getOrThrow: (key: string) =>
    key.startsWith('ARGON2_') ? Number(process.env[key]) : process.env[key],
} as unknown as ConfigService;

const codeOf = (error: unknown) =>
  (error as { getResponse?: () => { code?: string } }).getResponse?.().code ??
  String(error);

/**
 * Phase 9.5 concurrency on committed data with real concurrent transactions. Each transaction
 * pauses after reading sign-ins, widening the window in which an unserialized duplicate check
 * would pass twice. `unlocked` drops the application's advisory lock, proving the database alone
 * still keeps one sign-in per occurrence.
 */
function pausingTx(tx: Tx, pauseMs: number, unlocked: boolean): Tx {
  const signIns = new Proxy(tx.attendanceSignIn, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        !['findMany', 'findFirst', 'findUnique'].includes(String(property)) ||
        typeof value !== 'function'
      ) {
        return value;
      }
      return async (...args: unknown[]) => {
        const result = await (
          value as (...a: unknown[]) => Promise<unknown>
        ).apply(target, args);
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
        return result;
      };
    },
  });
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'attendanceSignIn') return signIns;
      if (unlocked && property === '$executeRaw') {
        const executeRaw = Reflect.get(target, property, receiver) as (
          ...a: unknown[]
        ) => Promise<unknown>;
        return (query: { sql?: string }, ...rest: unknown[]) =>
          String(query?.sql ?? '').includes('pg_advisory_xact_lock')
            ? Promise.resolve(0)
            : executeRaw.call(target, query, ...rest);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('Attendance concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let kiosk: KioskDevice;
  const clock = new FixedClock();
  const shifts: Record<string, string> = {};
  let extraPresence = '';

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      async (tx) => {
        const created = await createSchedulingFixtures(tx, USERS, [
          ...TIME_PERMISSIONS,
          'time.device.manage',
          'time.credential.manage',
        ]);
        await tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'ORGANIZATION',
            organizationId: created.orgA,
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            config: {
              clock: { mode: 'LIVE_CLOCK' },
              attendance: { captureMode: 'KIOSK_OR_SELF_SERVICE' },
            },
          },
        });
        // Employee 1's Team A assignment tracks presence; Employee 2's clocks time.
        await tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'EMPLOYMENT_ASSIGNMENT',
            employmentAssignmentId: created.assignmentTeamA,
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            config: {
              attendance: {
                trackingMode: 'SIGN_IN_ONLY',
                signOutEnabled: true,
              },
            },
          },
        });
        // Batch 4D: a second presence assignment of Employee 1, for sign-out key reuse.
        extraPresence = (
          await tx.employmentAssignment.create({
            data: {
              employeeId: created.employee1,
              positionId: created.positionOrg,
              employmentType: 'PART_TIME',
              status: 'ACTIVE',
              isPrimary: false,
              startDate: new Date('2026-01-01T00:00:00.000Z'),
            },
          })
        ).id;
        await tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'EMPLOYMENT_ASSIGNMENT',
            employmentAssignmentId: extraPresence,
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            config: {
              attendance: {
                trackingMode: 'SIGN_IN_ONLY',
                signOutEnabled: true,
              },
            },
          },
        });
        return created;
      },
      { timeout: 60_000 },
    );
    const svc = timeServices(prisma, clock);
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
    for (const [name, start, end] of [
      ['noon', '13:00', '13:30'],
      ['afternoon', '16:30', '17:00'],
      ['evening', '18:30', '19:00'],
      // Batch 4E-3 (C7): only the chosen-occurrence race below uses it.
      ['night', '21:00', '21:30'],
    ] as const) {
      shifts[name] = (
        await svc.scheduling.createShift(
          schedule.id,
          torontoShift(fx.assignmentTeamA, '2027-03-02', start, end),
          admin,
        )
      ).id;
    }
    await svc.scheduling.publishSchedule(schedule.id, admin);
    const device = await prisma.attendanceDevice.create({
      data: {
        organizationId: fx.orgA,
        physicalSiteId: fx.physicalSiteToronto,
        name: `Concurrency kiosk ${fx.suffix}`,
        credentialHash: `concurrency-${fx.suffix}`,
        credentialIssuedAt: new Date(),
      },
    });
    kiosk = {
      id: device.id,
      organizationId: fx.orgA,
      physicalSiteId: fx.physicalSiteToronto,
    };
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  function racing({ pauseMs = 200, unlocked = false } = {}) {
    const client = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === '$transaction') {
          return (run: (tx: Tx) => Promise<unknown>, options?: object) =>
            target.$transaction((tx) => run(pausingTx(tx, pauseMs, unlocked)), {
              ...options,
              timeout: 60_000,
            });
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as PrismaService;
    const svc = timeServices(client, clock);
    return {
      svc,
      signIns: new AttendanceSignInService(
        client,
        svc.time,
        new TimeDomainService(),
        svc.audit,
        clock,
        svc.schedules,
      ),
    };
  }

  async function settle<T>(...operations: Promise<T>[]) {
    const results = await Promise.allSettled(operations);
    return {
      fulfilled: results
        .filter(
          (r): r is PromiseFulfilledResult<Awaited<T>> =>
            r.status === 'fulfilled',
        )
        .map((r) => r.value),
      rejected: results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => codeOf(r.reason)),
    };
  }

  it('records one sign-in when the same occurrence is signed for twice at once', async () => {
    clock.value = toronto('2027-03-02T12:58');
    const { signIns } = racing();
    const result = await settle(
      signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        undefined,
        {},
      ),
      signIns.selfSignIn(
        fx.selfUser1,
        { employmentAssignmentId: fx.assignmentTeamA },
        ctx(fx.selfUser1),
      ),
    );
    expect(result.rejected).toEqual([]);
    expect(result.fulfilled.map((r) => r.outcome).sort()).toEqual([
      'ALREADY_SIGNED_IN',
      'SIGNED_IN',
    ]);
    expect(
      await prisma.attendanceSignIn.count({
        where: { scheduledShiftId: shifts.noon, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('records one sign-in for a retried request with the same key', async () => {
    clock.value = toronto('2027-03-02T16:29');
    const { signIns } = racing();
    const result = await settle(
      signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        'retry-key-0001',
        {},
      ),
      signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        'retry-key-0001',
        {},
      ),
    );
    expect(result.rejected).toEqual([]);
    expect(new Set(result.fulfilled.map((r) => r.signIn.id)).size).toBe(1);
    expect(
      await prisma.attendanceSignIn.count({
        where: { scheduledShiftId: shifts.afternoon },
      }),
    ).toBe(1);
  });

  it('still keeps one sign-in per occurrence in the database without the service lock (mutation check)', async () => {
    clock.value = toronto('2027-03-02T18:29');
    const { signIns } = racing({ unlocked: true });
    const result = await settle(
      signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        undefined,
        {},
      ),
      signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        undefined,
        {},
      ),
    );
    // Both pass the application's duplicate check; the partial unique index refuses the second.
    expect(result.fulfilled).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatch(
      /Unique constraint|P2002|AttendanceSignIn_one_active_per_shift_key/,
    );
    expect(
      await prisma.attendanceSignIn.count({
        where: { scheduledShiftId: shifts.evening, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('opens one entry when the kiosk and self-service clock in at once', async () => {
    clock.value = toronto('2027-03-02T09:00');
    await prisma.organization.update({
      where: { id: fx.orgA },
      data: { timezone: 'America/Toronto' },
    });
    const { svc } = racing();
    // Employee 1's Dept B assignment clocks time (TIME_CLOCK, either channel).
    const result = await settle<unknown>(
      svc.time.kioskClockIn(kiosk, fx.employee1, fx.assignmentDeptB, {}),
      svc.time.clockIn(fx.selfUser1, fx.assignmentDeptB, ctx(fx.selfUser1)),
    );
    expect(result.fulfilled.length + result.rejected.length).toBe(2);
    expect(
      await prisma.timeEntry.count({
        where: { employeeId: fx.employee1, status: 'OPEN' },
      }),
    ).toBe(1);
  });

  it('never records kiosk attendance after the device is revoked', async () => {
    clock.value = toronto('2027-03-02T14:00');
    const device = await prisma.attendanceDevice.create({
      data: {
        organizationId: fx.orgA,
        physicalSiteId: fx.physicalSiteToronto,
        name: `Racing kiosk ${fx.suffix}`,
        credentialHash: `racing-${fx.suffix}`,
        credentialIssuedAt: new Date(),
      },
    });
    const racer = {
      id: device.id,
      organizationId: fx.orgA,
      physicalSiteId: fx.physicalSiteToronto,
    };
    const { signIns } = racing({ pauseMs: 300 });
    const revoke = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "AttendanceDevice" WHERE "id" = ${device.id}::uuid FOR UPDATE`;
        await tx.attendanceDevice.update({
          where: { id: device.id },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            revokedReason: 'Stolen',
            credentialHash: null,
            credentialIssuedAt: null,
          },
        });
      });
    })();
    const [signIn] = await Promise.allSettled([
      signIns.kioskSignIn(
        racer,
        fx.employee1,
        fx.assignmentTeamA,
        undefined,
        {},
      ),
      revoke,
    ]);
    const revoked = await prisma.attendanceDevice.findUniqueOrThrow({
      where: { id: device.id },
    });
    const recorded = await prisma.attendanceSignIn.findMany({
      where: { attendanceDeviceId: device.id },
    });
    // Either the sign-in committed first (the revocation waited for its share lock), or the
    // revocation won and the sign-in was refused. Never a sign-in created after revocation.
    if (signIn.status === 'fulfilled') {
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.createdAt.getTime()).toBeLessThanOrEqual(
        revoked.revokedAt!.getTime(),
      );
    } else {
      expect(recorded).toHaveLength(0);
      expect(codeOf(signIn.reason)).toBe('KIOSK_DEVICE_INACTIVE');
    }
  });

  it('counts concurrent wrong PINs exactly and locks once', async () => {
    const svc = timeServices(prisma, clock);
    const credentials = new AttendanceCredentialService(
      prisma,
      svc.authorization,
      svc.targets,
      svc.audit,
      new PasswordHasherService(testConfig),
    );
    const { pin } = await credentials.issuePin(
      fx.users.deviceAdmin!,
      fx.employee2,
      ctx(fx.users.deviceAdmin!),
    );
    const number = (
      await prisma.employee.findUniqueOrThrow({ where: { id: fx.employee2 } })
    ).employeeNumber;
    const wrong = pin === '000000' ? '111111' : '000000';
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        credentials.verifyPin(number, wrong, fx.orgA, {}),
      ),
    );
    expect(results).toEqual([null, null, null, null, null]);
    const credential = await prisma.attendanceCredential.findFirstOrThrow({
      where: { employeeId: fx.employee2, status: 'ACTIVE' },
    });
    expect(credential.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(credential.failedAttempts).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: 'ATTENDANCE_PIN_LOCKED', entityId: credential.id },
      }),
    ).toBe(1);
  });

  // ─── Batch 4D: sign-out ─────────────────────────────────────────────────────

  async function signedIn(local: string, assignmentId = fx.assignmentTeamA) {
    await prisma.organization.update({
      where: { id: fx.orgA },
      data: { timezone: 'America/Toronto' },
    });
    clock.value = toronto(local);
    const { signIns } = racing({ pauseMs: 0 });
    const result = await signIns.selfSignIn(
      fx.selfUser1,
      { employmentAssignmentId: assignmentId },
      ctx(fx.selfUser1),
    );
    return result.signIn.id;
  }

  it('never lets one sign-in key record two assignments at once: the second is a 409', async () => {
    await prisma.organization.update({
      where: { id: fx.orgA },
      data: { timezone: 'America/Toronto' },
    });
    clock.value = toronto('2027-03-06T09:00');
    const { signIns } = racing();
    const result = await settle(
      signIns.selfSignIn(
        fx.selfUser1,
        {
          employmentAssignmentId: fx.assignmentTeamA,
          idempotencyKey: 'sign-in-key-x',
        },
        ctx(fx.selfUser1),
      ),
      signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        extraPresence,
        'sign-in-key-x',
        {},
      ),
    );
    expect(result.fulfilled.map((r) => r.outcome)).toEqual(['SIGNED_IN']);
    expect(result.rejected).toEqual(['ATTENDANCE_IDEMPOTENCY_KEY_REUSED']);
    expect(
      await prisma.attendanceSignIn.count({
        where: { employeeId: fx.employee1, idempotencyKey: 'sign-in-key-x' },
      }),
    ).toBe(1);
  });

  it('replays one sign-in when a kiosk and a self-service retry with the same key race', async () => {
    clock.value = toronto('2027-03-06T11:00');
    const { signIns } = racing();
    const result = await settle(
      signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        extraPresence,
        'sign-in-key-y',
        {},
      ),
      signIns.selfSignIn(
        fx.selfUser1,
        {
          employmentAssignmentId: extraPresence,
          idempotencyKey: 'sign-in-key-y',
        },
        ctx(fx.selfUser1),
      ),
    );
    expect(result.rejected).toEqual([]);
    expect(result.fulfilled.map((r) => r.outcome).sort()).toEqual([
      'ALREADY_SIGNED_IN',
      'SIGNED_IN',
    ]);
    expect(new Set(result.fulfilled.map((r) => r.signIn.id)).size).toBe(1);
  });

  it('records one sign-out when a kiosk and a self-service retry with the same key race', async () => {
    const signInId = await signedIn('2027-03-03T09:00');
    clock.value = toronto('2027-03-03T10:00');
    const { signIns } = racing();
    const result = await settle(
      signIns.kioskSignOut(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        'sign-out-key-1',
        {},
      ),
      signIns.selfSignOut(
        fx.selfUser1,
        {
          employmentAssignmentId: fx.assignmentTeamA,
          idempotencyKey: 'sign-out-key-1',
        },
        ctx(fx.selfUser1),
      ),
    );
    expect(result.rejected).toEqual([]);
    expect(result.fulfilled.map((r) => r.outcome).sort()).toEqual([
      'ALREADY_SIGNED_OUT',
      'SIGNED_OUT',
    ]);
    expect(new Set(result.fulfilled.map((r) => r.signOut.id)).size).toBe(1);
    expect(await prisma.attendanceSignOut.count({ where: { signInId } })).toBe(
      1,
    );
  });

  it('never lets one key sign out two assignments at once: the second is a 409', async () => {
    const teamA = await signedIn('2027-03-04T09:00');
    const extra = await signedIn('2027-03-04T09:01', extraPresence);
    clock.value = toronto('2027-03-04T10:00');
    const { signIns } = racing();
    const signOut = (employmentAssignmentId: string) =>
      signIns.selfSignOut(
        fx.selfUser1,
        { employmentAssignmentId, idempotencyKey: 'sign-out-key-2' },
        ctx(fx.selfUser1),
      );
    const result = await settle(
      signOut(fx.assignmentTeamA),
      signOut(extraPresence),
    );
    expect(result.fulfilled.map((r) => r.outcome)).toEqual(['SIGNED_OUT']);
    expect(result.rejected).toEqual(['ATTENDANCE_IDEMPOTENCY_KEY_REUSED']);
    const rows = await prisma.attendanceSignOut.findMany({
      where: { signInId: { in: [teamA, extra] } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBe('sign-out-key-2');
  });

  it('still keeps one active sign-out per sign-in in the database without the service lock (mutation check)', async () => {
    const signInId = await signedIn('2027-03-05T09:00');
    clock.value = toronto('2027-03-05T10:00');
    const { signIns } = racing({ unlocked: true });
    const signOut = (idempotencyKey: string) =>
      signIns.selfSignOut(
        fx.selfUser1,
        { employmentAssignmentId: fx.assignmentTeamA, idempotencyKey },
        ctx(fx.selfUser1),
      );
    const result = await settle(
      signOut('sign-out-key-3a'),
      signOut('sign-out-key-3b'),
    );
    expect(result.fulfilled).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatch(
      /Unique constraint|P2002|AttendanceSignOut_one_active_per_sign_in_key/,
    );
    expect(
      await prisma.attendanceSignOut.count({
        where: { signInId, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });
  it('records one sign-in when the same chosen occurrence is confirmed twice at once, and with the kiosk (Batch 4E-3, C7)', async () => {
    clock.value = toronto('2027-03-02T20:58');
    const { signIns } = racing();
    const chosen = (key: string) =>
      signIns.selfSignIn(
        fx.selfUser1,
        {
          employmentAssignmentId: fx.assignmentTeamA,
          scheduledShiftId: shifts.night,
          idempotencyKey: key,
        },
        ctx(fx.selfUser1),
      );
    const result = await settle(
      chosen('chosen-one-aaaa'),
      chosen('chosen-two-bbbb'),
      signIns.kioskSignIn(
        kiosk,
        fx.employee1,
        fx.assignmentTeamA,
        undefined,
        {},
      ),
    );
    expect(result.rejected).toEqual([]);
    expect(result.fulfilled.map((r) => r.outcome).sort()).toEqual([
      'ALREADY_SIGNED_IN',
      'ALREADY_SIGNED_IN',
      'SIGNED_IN',
    ]);
    expect(
      await prisma.attendanceSignIn.count({
        where: { scheduledShiftId: shifts.night, status: 'ACTIVE' },
      }),
    ).toBe(1);
    // Committed data: the last race here (the others look for later sign-ins); afterAll removes it.
  });
});
