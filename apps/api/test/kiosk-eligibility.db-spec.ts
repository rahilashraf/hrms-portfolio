import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDateOf } from '../src/common/domain-support.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { AttendanceCredentialService } from '../src/kiosk/attendance-credential.service.js';
import { AttendanceKioskService } from '../src/kiosk/attendance-kiosk.service.js';
import { KioskRateLimiterService } from '../src/kiosk/kiosk-rate-limiter.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { PasswordHasherService } from '../src/security/password-hasher.service.js';
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
  TIME_PERMISSIONS,
  timeServices,
  toronto,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  admin: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'org' as const }],
  pinAdmin: [
    { permissions: ['time.credential.manage'], scope: 'org' as const },
  ],
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
};

const testConfig = {
  getOrThrow: (key: string) => {
    const value = process.env[key];
    if (value === undefined) throw new Error(`${key} missing`);
    return key.startsWith('ARGON2_') ? Number(value) : value;
  },
} as unknown as ConfigService;

/** The production layer: Time clock, kiosk only, any kiosk — but no `clock` section. */
const PRODUCTION_ATTENDANCE = {
  attendance: {
    trackingMode: 'TIME_CLOCK',
    captureMode: 'KIOSK_ONLY',
    kioskLocationRule: 'ANY_IN_ORGANIZATION',
  },
};
const WITH_TIME_CLOCK = {
  ...PRODUCTION_ATTENDANCE,
  clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
};

const body = (error: unknown) =>
  (error as HttpException).getResponse() as { code?: string };

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  svc: ReturnType<typeof timeServices>;
  kiosk: AttendanceKioskService;
  /** Two kiosks of the organization at different physical sites. */
  brothers: KioskDevice;
  sisters: KioskDevice;
  pinFor: (employeeId: string) => Promise<{ number: string; pin: string }>;
}

describe('Kiosk eligibility and explanations (database)', () => {
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

  async function scenario(
    policy: Record<string, unknown>,
    run: (h: Harness) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, [
            ...TIME_PERMISSIONS,
            'time.credential.manage',
          ]);
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'America/Toronto' },
          });
          // Effective October 8, 2026, like the production organization policy.
          await tx.timeAttendancePolicy.create({
            data: {
              scopeType: 'ORGANIZATION',
              organizationId: fx.orgA,
              effectiveFrom: new Date('2026-10-08T00:00:00.000Z'),
              config: policy as object,
            },
          });
          const clock = new FixedClock();
          const client = rollbackClient(tx);
          const svc = timeServices(client, clock);
          const credentials = new AttendanceCredentialService(
            client,
            svc.authorization,
            svc.targets,
            svc.audit,
            hasher,
          );
          const kiosk = new AttendanceKioskService(
            client,
            redis,
            new KioskRateLimiterService(redis),
            credentials,
            svc.time,
            new AttendanceSignInService(
              client,
              svc.time,
              new TimeDomainService(),
              svc.audit,
              clock,
              svc.schedules,
            ),
            svc.audit,
          );
          const device = async (name: string, physicalSiteId: string) => {
            const row = await tx.attendanceDevice.create({
              data: {
                organizationId: fx.orgA,
                physicalSiteId,
                name,
                credentialHash: `hash-${name}-${fx.suffix}`,
                credentialIssuedAt: new Date(),
              },
            });
            return {
              id: row.id,
              organizationId: row.organizationId,
              physicalSiteId: row.physicalSiteId,
            };
          };
          await run({
            tx,
            fx,
            clock,
            svc,
            kiosk,
            brothers: await device('Brother Side', fx.physicalSiteToronto),
            sisters: await device("Sister's Side", fx.physicalSiteOttawa),
            pinFor: async (employeeId) => {
              const { pin } = await credentials.issuePin(
                fx.users.pinAdmin!,
                employeeId,
                ctx(fx.users.pinAdmin!),
              );
              const number = (
                await tx.employee.findUniqueOrThrow({
                  where: { id: employeeId },
                })
              ).employeeNumber;
              return { number, pin };
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

  it('explains why the production policy offers nothing: the time clock (clock.mode) is still off', async () => {
    await scenario(
      PRODUCTION_ATTENDANCE,
      async ({ fx, svc, kiosk, brothers, pinFor }) => {
        const { number, pin } = await pinFor(fx.employee1);
        const view = await kiosk.identify(
          brothers,
          { employeeNumber: number, pin },
          {},
        );
        expect(view.actions).toEqual([]);
        expect(view.notice).toEqual({
          code: 'CLOCK_DISABLED',
          message: expect.stringContaining('Clocking in is not turned on'),
        });
        expect(
          (await svc.time.kioskStatus(brothers, fx.employee1)).availableActions,
        ).toEqual([]);
      },
    );
  });

  it('with the time clock on, either kiosk offers both active assignments; unscheduled clock-in works by default; personal clock-in stays refused', async () => {
    await scenario(
      WITH_TIME_CLOCK,
      async ({ tx, fx, svc, kiosk, sisters, pinFor }) => {
        // Personal account: still kiosk-only.
        const remote = await rejection(
          svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, ctx(fx.selfUser1)),
        );
        expect(body(remote)).toMatchObject({
          code: 'ATTENDANCE_CAPTURE_KIOSK_ONLY',
        });

        const { number, pin } = await pinFor(fx.employee1);
        // The Sister's Side kiosk is at another site than the Team A position's work location.
        const view = await kiosk.identify(
          sisters,
          { employeeNumber: number, pin },
          {},
        );
        expect(view.notice).toBeNull();
        expect(
          view.actions.map((a) => [a.action, a.employmentAssignmentId]),
        ).toEqual([
          ['CLOCK_IN', fx.assignmentTeamA],
          ['CLOCK_IN', fx.assignmentDeptB],
          ['CLOCK_IN', null], // several assignments at once
        ]);
        // No shift exists (ALLOW_UNSCHEDULED is the default): the clock-in is recorded.
        await kiosk.act(
          sisters,
          {
            token: view.token,
            action: 'CLOCK_IN',
            employmentAssignmentId: fx.assignmentDeptB,
          },
          {},
        );
        const entry = await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1 },
        });
        expect(entry).toMatchObject({
          employmentAssignmentId: fx.assignmentDeptB,
          source: 'KIOSK',
          scheduledShiftId: null,
        });
      },
    );
  });

  it('requires a published shift only under REQUIRE_SCHEDULED_SHIFT; draft shifts never count', async () => {
    await scenario(
      WITH_TIME_CLOCK,
      async ({ tx, fx, svc, kiosk, brothers, clock, pinFor }) => {
        const admin = ctx(fx.users.admin!);
        await svc.policies.createPolicy(
          {
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgA,
            effectiveFrom: '2027-01-01',
            unscheduledWorkMode: 'REQUIRE_SCHEDULED_SHIFT',
          } as never,
          admin,
        );
        clock.value = toronto('2027-03-02T09:00');
        const schedule = await svc.scheduling.createSchedule(
          {
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgA,
            name: 'Week of March 1',
            type: 'STANDARD',
            periodStart: '2027-03-01',
            periodEnd: '2027-03-07',
          },
          admin,
        );
        await svc.scheduling.createShift(
          schedule.id,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
          admin,
        );
        const { number, pin } = await pinFor(fx.employee1);
        const clockIn = async () => {
          const view = await kiosk.identify(
            brothers,
            { employeeNumber: number, pin },
            {},
          );
          return kiosk.act(
            brothers,
            {
              token: view.token,
              action: 'CLOCK_IN',
              employmentAssignmentId: fx.assignmentTeamA,
            },
            {},
          );
        };
        // Only a draft shift exists: refused, nothing recorded.
        expect(body(await rejection(clockIn()))).toMatchObject({
          code: 'SCHEDULED_SHIFT_REQUIRED',
        });
        expect(
          await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
        ).toBe(0);

        await svc.scheduling.publishSchedule(schedule.id, admin);
        await clockIn();
        const entry = await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1 },
        });
        expect(entry.scheduledShiftId).not.toBeNull();
        expect(entry.source).toBe('KIOSK');
      },
    );
  });

  it('offers one clock-in per open shift when an assignment has several, and records the one chosen', async () => {
    await scenario(
      WITH_TIME_CLOCK,
      async ({ tx, fx, svc, kiosk, brothers, clock, pinFor }) => {
        const admin = ctx(fx.users.admin!);
        const schedule = await svc.scheduling.createSchedule(
          {
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgA,
            name: 'Week of March 1',
            type: 'STANDARD',
            periodStart: '2027-03-01',
            periodEnd: '2027-03-07',
          },
          admin,
        );
        // Back-to-back shifts on one assignment: their clock-in windows overlap at 09:00.
        const morning = await svc.scheduling.createShift(
          schedule.id,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '08:00', '09:30'),
          admin,
        );
        const late = await svc.scheduling.createShift(
          schedule.id,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:45', '12:00'),
          admin,
        );
        await svc.scheduling.publishSchedule(schedule.id, admin);
        clock.value = toronto('2027-03-02T09:00');
        const { number, pin } = await pinFor(fx.employee1);
        const identify = () =>
          kiosk.identify(brothers, { employeeNumber: number, pin }, {});

        let view = await identify();
        const teamClockIns = view.actions.filter(
          (option) =>
            option.action === 'CLOCK_IN' &&
            option.employmentAssignmentId === fx.assignmentTeamA,
        );
        expect(
          new Set(teamClockIns.map((option) => option.scheduledShiftId)),
        ).toEqual(new Set([morning.id, late.id]));
        expect(teamClockIns.map((option) => option.label)).toEqual(
          expect.arrayContaining([
            expect.stringContaining('08:00–09:30'),
            expect.stringContaining('09:45–12:00'),
          ]),
        );
        expect(teamClockIns).toHaveLength(2);

        // Without a shift, or with one that was not offered, nothing is recorded.
        for (const scheduledShiftId of [
          undefined,
          '00000000-0000-4000-8000-000000000000',
        ]) {
          const refused = await rejection(
            kiosk.act(
              brothers,
              {
                token: view.token,
                action: 'CLOCK_IN',
                employmentAssignmentId: fx.assignmentTeamA,
                scheduledShiftId,
              },
              {},
            ),
          );
          expect(body(refused)).toMatchObject({
            code: 'KIOSK_ACTION_NOT_OFFERED',
          });
          view = await identify();
        }
        expect(
          await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
        ).toBe(0);

        await kiosk.act(
          brothers,
          {
            token: view.token,
            action: 'CLOCK_IN',
            employmentAssignmentId: fx.assignmentTeamA,
            scheduledShiftId: late.id,
          },
          {},
        );
        const entry = await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1 },
        });
        expect(entry).toMatchObject({
          employmentAssignmentId: fx.assignmentTeamA,
          scheduledShiftId: late.id,
          source: 'KIOSK',
        });
      },
    );
  });

  it('lets a multi-assignment clock-in choose the payroll assignment’s shift when it has several open', async () => {
    await scenario(
      WITH_TIME_CLOCK,
      async ({ tx, fx, svc, kiosk, brothers, clock, pinFor }) => {
        const admin = ctx(fx.users.admin!);
        const schedule = await svc.scheduling.createSchedule(
          {
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgA,
            name: 'Week of March 1',
            type: 'STANDARD',
            periodStart: '2027-03-01',
            periodEnd: '2027-03-07',
          },
          admin,
        );
        // The payroll assignment (Team A) has two shifts open for clock-in at 09:00.
        const morning = await svc.scheduling.createShift(
          schedule.id,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '08:00', '09:30'),
          admin,
        );
        const late = await svc.scheduling.createShift(
          schedule.id,
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:45', '12:00'),
          admin,
        );
        await svc.scheduling.publishSchedule(schedule.id, admin);
        clock.value = toronto('2027-03-02T09:00');
        const { number, pin } = await pinFor(fx.employee1);
        const identify = () =>
          kiosk.identify(brothers, { employeeNumber: number, pin }, {});
        const coverage = (view: Awaited<ReturnType<typeof identify>>) =>
          view.actions.find(
            (option) =>
              option.action === 'CLOCK_IN' && option.coverableAssignments,
          )!;

        let view = await identify();
        const teamA = coverage(view).coverableAssignments!.find(
          (assignment) =>
            assignment.employmentAssignmentId === fx.assignmentTeamA,
        )!;
        expect(
          new Set(teamA.shifts!.map((shift) => shift.scheduledShiftId)),
        ).toEqual(new Set([morning.id, late.id]));
        expect(teamA.shifts!.map((shift) => shift.label)).toEqual(
          expect.arrayContaining(['08:00–09:30', '09:45–12:00']),
        );
        // Dept B has no open shift: nothing to choose for it.
        expect(
          coverage(view).coverableAssignments!.find(
            (assignment) =>
              assignment.employmentAssignmentId === fx.assignmentDeptB,
          )!.shifts,
        ).toBeUndefined();

        const coverTeamAandDeptB = (scheduledShiftId?: string) =>
          kiosk.act(
            brothers,
            {
              token: view.token,
              action: 'CLOCK_IN',
              employmentAssignmentId: fx.assignmentTeamA,
              additionalEmploymentAssignmentIds: [fx.assignmentDeptB],
              scheduledShiftId,
            },
            {},
          );
        // Without a shift, with one that was not offered, or with a shift of the covered
        // (non-payroll) assignment: refused, nothing recorded.
        for (const scheduledShiftId of [
          undefined,
          '00000000-0000-4000-8000-000000000000',
        ]) {
          expect(
            body(await rejection(coverTeamAandDeptB(scheduledShiftId))),
          ).toMatchObject({
            code: 'KIOSK_ACTION_NOT_OFFERED',
          });
          view = await identify();
        }
        expect(
          await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
        ).toBe(0);

        await coverTeamAandDeptB(late.id);
        const entry = await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1 },
        });
        expect(entry).toMatchObject({
          employmentAssignmentId: fx.assignmentTeamA,
          scheduledShiftId: late.id,
          source: 'KIOSK',
        });
        expect(
          (
            await tx.timeEntryAssignmentCoverage.findMany({
              where: { timeEntryId: entry.id, removedAt: null },
            })
          )
            .map((row) => row.employmentAssignmentId)
            .sort((a, b) => a.localeCompare(b)),
        ).toEqual(
          [fx.assignmentTeamA, fx.assignmentDeptB].sort((a, b) =>
            a.localeCompare(b),
          ),
        );
      },
    );
  });

  it('tells the employee about a missed clock-out instead of showing an empty screen', async () => {
    await scenario(
      WITH_TIME_CLOCK,
      async ({ tx, fx, svc, kiosk, brothers, clock, pinFor }) => {
        const { number, pin } = await pinFor(fx.employee1);
        clock.value = toronto('2027-03-02T09:00');
        await svc.time.kioskClockIn(
          brothers,
          fx.employee1,
          fx.assignmentTeamA,
          {},
        );
        const entry = await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1 },
        });
        await tx.attendanceException.create({
          data: {
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentTeamA,
            timeEntryId: entry.id,
            type: 'MISSING_CLOCK_OUT',
            severity: 'ACTION_REQUIRED',
            workflowImpact: 'SUBMISSION_BLOCKING',
            status: 'OPEN',
            detectedAt: clock.value,
          },
        });
        // Still clocked in: clock-out is offered, and the missed clock-out is explained.
        let view = await kiosk.identify(
          brothers,
          { employeeNumber: number, pin },
          {},
        );
        expect(view.actions.map((a) => a.action)).toContain('CLOCK_OUT');
        expect(view.notice?.code).toBe('MISSED_CLOCK_OUT');

        // Clocked out, and from tomorrow the time clock is off for both assignments: resolving the
        // missed clock-out is the only server action. It used to be dropped (an empty screen).
        clock.value = toronto('2027-03-02T17:00');
        await svc.time.kioskClockOut(brothers, fx.employee1, {});
        for (const id of [fx.assignmentTeamA, fx.assignmentDeptB]) {
          await tx.timeAttendancePolicy.create({
            data: {
              scopeType: 'EMPLOYMENT_ASSIGNMENT',
              employmentAssignmentId: id,
              effectiveFrom: new Date('2027-03-03T00:00:00.000Z'),
              config: { clock: { mode: 'DISABLED' } },
            },
          });
        }
        clock.value = toronto('2027-03-03T09:00');
        expect(
          (await svc.time.kioskStatus(brothers, fx.employee1)).availableActions,
        ).toEqual(['RESOLVE_MISSED_CLOCK_OUT']);
        view = await kiosk.identify(
          brothers,
          { employeeNumber: number, pin },
          {},
        );
        expect(view.actions).toEqual([]);
        expect(view.notice).toEqual({
          code: 'MISSED_CLOCK_OUT',
          message: expect.stringContaining('missing its clock-out'),
        });
      },
    );
  });

  it('explains a planned assignment, kiosk-excluded capture and site restrictions without changing them', async () => {
    await scenario(
      WITH_TIME_CLOCK,
      async ({ tx, fx, kiosk, brothers, sisters, pinFor }) => {
        // A new hire whose only position starts later passes identification…
        const person = await tx.person.create({
          data: { firstName: 'Newhire', lastName: fx.suffix },
        });
        const hire = await tx.employee.create({
          data: {
            personId: person.id,
            employeeNumber: `NH-${fx.suffix}`,
            hireDate: new Date('2026-01-01'),
          },
        });
        await tx.employmentAssignment.create({
          data: {
            employeeId: hire.id,
            positionId: fx.positionTeamA,
            employmentType: 'PART_TIME',
            status: 'PLANNED',
            isPrimary: true,
            startDate: new Date('2027-06-01T00:00:00.000Z'),
          },
        });
        const planned = await pinFor(hire.id);
        const view = await kiosk.identify(
          brothers,
          { employeeNumber: planned.number, pin: planned.pin },
          {},
        );
        expect(view.actions).toEqual([]);
        expect(view.notice?.code).toBe('ASSIGNMENT_NOT_STARTED');

        // …kiosk capture switched off for Employee 1's assignments…
        const { number, pin } = await pinFor(fx.employee1);
        const layers = [];
        for (const id of [fx.assignmentTeamA, fx.assignmentDeptB]) {
          layers.push(
            await tx.timeAttendancePolicy.create({
              data: {
                scopeType: 'EMPLOYMENT_ASSIGNMENT',
                employmentAssignmentId: id,
                effectiveFrom: new Date('2026-10-08T00:00:00.000Z'),
                config: { attendance: { captureMode: 'SELF_SERVICE' } },
              },
            }),
          );
        }
        expect(
          (await kiosk.identify(brothers, { employeeNumber: number, pin }, {}))
            .notice?.code,
        ).toBe('CAPTURE_NOT_AT_KIOSK');

        // …and the site rule: only the kiosk of the work location's site may record Team A.
        for (const layer of layers) {
          await tx.timeAttendancePolicy.update({
            where: { id: layer.id },
            data: {
              config: {
                attendance: { kioskLocationRule: 'ASSIGNMENT_WORK_LOCATION' },
              },
            },
          });
        }
        expect(
          (await kiosk.identify(sisters, { employeeNumber: number, pin }, {}))
            .notice?.code,
        ).toBe('KIOSK_SITE_NOT_ALLOWED');
        const atOwnSite = await kiosk.identify(
          brothers,
          { employeeNumber: number, pin },
          {},
        );
        expect(atOwnSite.notice).toBeNull();
        expect(atOwnSite.actions.map((a) => a.employmentAssignmentId)).toEqual([
          fx.assignmentTeamA,
        ]);
      },
    );
  });

  /**
   * Batch 5A — with lifecycle automation off, a passed end or termination date is not yet
   * reflected in the stored status (the assignment and the employee stay ACTIVE). Kiosk attendance
   * must follow the dates anyway: the last day still works, the next day does not; beyond the
   * PIN lookup's one-day time-zone margin the employee is not identified at all.
   */
  describe('Batch 5A effective dates at the kiosk (stale ACTIVE status)', () => {
    const TZ = 'America/Toronto';
    const day = (today: Date, offset: number) =>
      new Date(today.getTime() + offset * 86_400_000);
    const clockInOffers = (view: {
      actions: Array<{ action: string; employmentAssignmentId: string | null }>;
    }) =>
      view.actions
        .filter((a) => a.action === 'CLOCK_IN' && a.employmentAssignmentId)
        .map((a) => a.employmentAssignmentId);

    it('stops offering and recording an assignment the day after its end date', async () => {
      await scenario(
        WITH_TIME_CLOCK,
        async ({ tx, fx, clock, kiosk, brothers, pinFor }) => {
          // The PIN lookup uses the real date; keep the kiosk clock on it too.
          clock.value = new Date();
          const today = localDateOf(clock.now(), TZ);
          const { number, pin } = await pinFor(fx.employee1);
          const identify = () =>
            kiosk.identify(brothers, { employeeNumber: number, pin }, {});

          // Last day (end date = today): still offered.
          await tx.employmentAssignment.update({
            where: { id: fx.assignmentDeptB },
            data: { endDate: today },
          });
          expect(clockInOffers(await identify())).toEqual([
            fx.assignmentTeamA,
            fx.assignmentDeptB,
          ]);

          // The day after (end date = yesterday), status still ACTIVE: not offered, not recorded.
          await tx.employmentAssignment.update({
            where: { id: fx.assignmentDeptB },
            data: { endDate: day(today, -1) },
          });
          const view = await identify();
          expect(clockInOffers(view)).toEqual([fx.assignmentTeamA]);
          const refused = await rejection(
            kiosk.act(
              brothers,
              {
                token: view.token,
                action: 'CLOCK_IN',
                employmentAssignmentId: fx.assignmentDeptB,
              },
              {},
            ),
          );
          expect(refused).toBeInstanceOf(HttpException);
          expect(
            await tx.timeEntry.count({
              where: { employmentAssignmentId: fx.assignmentDeptB },
            }),
          ).toBe(0);

          // Every assignment ended beyond the one-day margin: the PIN identifies nobody.
          await tx.employmentAssignment.updateMany({
            where: { employeeId: fx.employee1 },
            data: { endDate: day(today, -3) },
          });
          expect(await rejection(identify())).toBeInstanceOf(HttpException);
          expect(
            await tx.employmentAssignment.count({
              where: { employeeId: fx.employee1, status: 'ACTIVE' },
            }),
          ).toBe(2);
          expect(
            await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
          ).toBe(0);
        },
      );
    });

    it('captures nothing new the day after the employee’s termination date, even while still ACTIVE', async () => {
      await scenario(
        WITH_TIME_CLOCK,
        async ({ tx, fx, clock, svc, kiosk, brothers, pinFor }) => {
          clock.value = new Date();
          const today = localDateOf(clock.now(), TZ);
          const { number, pin } = await pinFor(fx.employee1);
          const identify = () =>
            kiosk.identify(brothers, { employeeNumber: number, pin }, {});

          // Termination date = today (the last day): still offered.
          await tx.employee.update({
            where: { id: fx.employee1 },
            data: { terminationDate: today },
          });
          expect(clockInOffers(await identify())).toContain(fx.assignmentTeamA);

          // The day after, status still ACTIVE. Depending on the hour, the PIN lookup's UTC margin
          // either already refuses identification, or the employee is identified and the clock
          // actions (local date) refuse: either way nothing is offered or recorded.
          await tx.employee.update({
            where: { id: fx.employee1 },
            data: { terminationDate: day(today, -1) },
          });
          const view = await identify().catch((error: unknown) => error);
          if (view instanceof HttpException) {
            expect(view.getStatus()).toBe(401);
          } else {
            const identified = view as Awaited<ReturnType<typeof identify>>;
            expect(clockInOffers(identified)).toEqual([]);
            expect(
              (await svc.time.kioskStatus(brothers, fx.employee1))
                .availableActions,
            ).toEqual([]);
            expect(
              await rejection(
                kiosk.act(
                  brothers,
                  {
                    token: identified.token,
                    action: 'CLOCK_IN',
                    employmentAssignmentId: fx.assignmentTeamA,
                  },
                  {},
                ),
              ),
            ).toBeInstanceOf(HttpException);
          }
          // The capture gate itself (local date), independently of identification.
          expect(
            (await svc.time.kioskStatus(brothers, fx.employee1))
              .availableActions,
          ).toEqual([]);
          expect(
            await rejection(
              svc.time.kioskClockIn(
                brothers,
                fx.employee1,
                fx.assignmentTeamA,
                {},
              ),
            ),
          ).toBeInstanceOf(HttpException);
          expect(
            await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
          ).toBe(0);

          // Beyond the margin: not identified at all.
          await tx.employee.update({
            where: { id: fx.employee1 },
            data: { terminationDate: day(today, -3) },
          });
          expect(await rejection(identify())).toBeInstanceOf(HttpException);
          expect(
            (
              await tx.employee.findUniqueOrThrow({
                where: { id: fx.employee1 },
              })
            ).status,
          ).toBe('ACTIVE');
        },
      );
    });
  });
});
