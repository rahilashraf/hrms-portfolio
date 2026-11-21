import { BadRequestException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { ScheduleAttendanceService } from '../src/scheduling/schedule-attendance.service.js';
import { SchedulingViewService } from '../src/scheduling/scheduling-view.service.js';
import { ScheduleVarianceService } from '../src/time/schedule-variance.service.js';
import { TimeDomainService } from '../src/time/time-domain.service.js';
import { SystemClock, TimeService } from '../src/time/time.service.js';
import {
  ALL_SCHEDULE_PERMISSIONS,
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  schedulingServices,
  torontoShift,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  admin: [
    {
      permissions: [...ALL_SCHEDULE_PERMISSIONS, 'time.view'],
      scope: 'org' as const,
    },
  ],
  deptBReader: [
    { permissions: ['schedule.read', 'time.view'], scope: 'deptB' as const },
  ],
  timeOnly: [{ permissions: ['time.view'], scope: 'org' as const }],
  outsider: [
    {
      permissions: [...ALL_SCHEDULE_PERMISSIONS, 'time.view'],
      scope: 'orgB' as const,
    },
  ],
};

const at = (local: string, offset = '-05:00') =>
  new Date(`${local}:00${offset}`);

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  svc: ReturnType<typeof schedulingServices>;
  views: SchedulingViewService;
  variance: ScheduleVarianceService;
  attendance: ScheduleAttendanceService;
  shifts: Record<string, string>;
  schedules: Record<string, string>;
}

describe('Scheduling reports and hardening (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /**
   * Week of 2027-03-01 (EST): Dept A published (Team A shifts of both employees, one cancelled),
   * Dept A draft, Dept B published; plus a DST week schedule with an overnight shift across the
   * 2027-03-14 spring-forward.
   */
  async function scenario(run: (h: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, ['time.view']);
          const client = rollbackClient(tx);
          const svc = schedulingServices(client);
          const admin = ctx(fx.users.admin!);
          const schedule = async (
            scope: {
              scopeType: 'DEPARTMENT' | 'ORGANIZATION';
              departmentId?: string;
            },
            name: string,
            periodStart = '2027-03-01',
            periodEnd = '2027-03-07',
          ) =>
            (
              await svc.scheduling.createSchedule(
                {
                  ...scope,
                  organizationId: fx.orgA,
                  name,
                  type: 'AD_HOC',
                  periodStart,
                  periodEnd,
                },
                admin,
              )
            ).id;
          const schedules = {
            deptA: await schedule(
              { scopeType: 'DEPARTMENT', departmentId: fx.deptA },
              'A',
            ),
            draftA: await schedule(
              { scopeType: 'DEPARTMENT', departmentId: fx.deptA },
              'A draft',
            ),
            deptB: await schedule(
              { scopeType: 'DEPARTMENT', departmentId: fx.deptB },
              'B',
            ),
            dst: await schedule(
              { scopeType: 'DEPARTMENT', departmentId: fx.deptA },
              'DST',
              '2027-03-08',
              '2027-03-14',
            ),
            org: await schedule({ scopeType: 'ORGANIZATION' }, 'Org'),
          };
          const add = async (
            scheduleId: string,
            input: ReturnType<typeof torontoShift>,
          ) => (await svc.scheduling.createShift(scheduleId, input, admin)).id;
          const shifts = {
            e1Tue: await add(
              schedules.deptA,
              torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
            ),
            e1Wed: await add(
              schedules.deptA,
              torontoShift(fx.assignmentTeamA, '2027-03-03', '09:00', '13:00'),
            ),
            e1Cancelled: await add(
              schedules.deptA,
              torontoShift(fx.assignmentTeamA, '2027-03-04', '09:00', '17:00'),
            ),
            e2Tue: await add(
              schedules.deptA,
              torontoShift(fx.otherTeamA, '2027-03-02', '10:00', '16:00'),
            ),
            draft: await add(
              schedules.draftA,
              torontoShift(fx.otherTeamA, '2027-03-05', '09:00', '17:00'),
            ),
            e1DeptB: await add(
              schedules.deptB,
              torontoShift(fx.assignmentDeptB, '2027-03-05', '18:00', '22:00'),
            ),
            // 22:00 EST → 06:00 EDT across the spring-forward gap: 7 hours, not 8.
            dstOvernight: await add(schedules.dst, {
              ...torontoShift(
                fx.assignmentTeamA,
                '2027-03-13',
                '22:00',
                '06:00',
              ),
              endsAt: '2027-03-14T06:00:00-04:00',
            }),
            orgE1: await add(
              schedules.org,
              torontoShift(fx.assignmentTeamA, '2027-03-06', '09:00', '12:00'),
            ),
          };
          for (const id of [
            schedules.deptA,
            schedules.deptB,
            schedules.dst,
            schedules.org,
          ]) {
            await svc.scheduling.publishSchedule(id, admin);
          }
          await svc.scheduling.cancelShift(
            schedules.deptA,
            shifts.e1Cancelled,
            { reason: 'Closed' },
            admin,
          );
          const attendance = new ScheduleAttendanceService(
            client,
            svc.targets,
            svc.policyResolver,
          );
          const time = new TimeService(
            client,
            new TimeDomainService(),
            svc.authorization,
            svc.targets,
            svc.audit,
            new SystemClock(),
            attendance,
          );
          await run({
            tx,
            fx,
            svc,
            shifts,
            schedules,
            attendance,
            views: new SchedulingViewService(
              client,
              svc.domain,
              svc.authorization,
              svc.targets,
              svc.policyResolver,
            ),
            variance: new ScheduleVarianceService(
              client,
              new TimeDomainService(),
              svc.authorization,
              svc.targets,
              time,
            ),
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const MARCH = { from: '2027-03-01', to: '2027-03-31' };

  // ─── Scheduled hours ──────────────────────────────────────────────────────

  it('sums exact scheduled minutes by dimension over published ACTIVE shifts', async () => {
    await scenario(async ({ fx, views }) => {
      const byEmployee = await views.scheduledHours(fx.users.admin!, {
        ...MARCH,
        organizationId: fx.orgA,
        groupBy: 'employee',
      });
      const minutes = Object.fromEntries(
        byEmployee.groups.map((group) => [group.key, group]),
      );
      // Employee 1: 480 + 240 + 240 (Dept B) + 420 (DST overnight) + 180 (org); cancelled excluded.
      expect(minutes[fx.employee1]).toEqual({
        key: fx.employee1,
        shiftCount: 5,
        scheduledMinutes: 1560,
      });
      // Employee 2: 360; the draft shift is planning, not expected work.
      expect(minutes[fx.employee2]).toMatchObject({
        shiftCount: 1,
        scheduledMinutes: 360,
      });

      const byDate = await views.scheduledHours(fx.users.admin!, {
        ...MARCH,
        organizationId: fx.orgA,
        groupBy: 'workDate',
        employeeId: fx.employee1,
      });
      expect(byDate.groups).toContainEqual({
        key: '2027-03-13',
        shiftCount: 1,
        scheduledMinutes: 420,
      });

      const byTeam = await views.scheduledHours(fx.users.admin!, {
        ...MARCH,
        organizationId: fx.orgA,
        groupBy: 'team',
      });
      // Positions without a team group under a null key, ordered first.
      expect(byTeam.groups[0]).toEqual({
        key: null,
        shiftCount: 1,
        scheduledMinutes: 240,
      });
      expect(byTeam.groups.at(-1)).toEqual({
        key: fx.teamA,
        shiftCount: 5,
        scheduledMinutes: 1680,
      });
    });
  });

  it('reports cancelled and draft hours only when asked', async () => {
    await scenario(async ({ fx, views, shifts }) => {
      const cancelled = await views.scheduledHours(fx.users.admin!, {
        ...MARCH,
        organizationId: fx.orgA,
        groupBy: 'status',
        status: 'CANCELLED',
      });
      expect(cancelled.groups).toEqual([
        { key: 'CANCELLED', shiftCount: 1, scheduledMinutes: 480 },
      ]);
      const draft = await views.scheduledHours(fx.users.admin!, {
        ...MARCH,
        organizationId: fx.orgA,
        groupBy: 'sourceType',
        scheduleStatus: 'DRAFT',
      });
      expect(draft.groups).toEqual([
        { key: 'MANUAL', shiftCount: 1, scheduledMinutes: 480 },
      ]);
      expect(shifts.draft).toBeDefined();
    });
  });

  it('is scoped by Schedule visibility and filters by unit subtree', async () => {
    await scenario(async ({ fx, views, schedules }) => {
      const deptB = await views.scheduledHours(fx.users.deptBReader!, {
        ...MARCH,
        organizationId: fx.orgA,
        groupBy: 'schedule',
      });
      expect(deptB.groups).toEqual([
        { key: schedules.deptB, shiftCount: 1, scheduledMinutes: 240 },
      ]);
      const outsider = await views.scheduledHours(fx.users.outsider!, {
        ...MARCH,
        organizationId: fx.orgA,
        groupBy: 'employee',
      });
      expect(outsider.groups).toEqual([]);
      // unitRoot includes the child unit, where Team A's position sits.
      const unit = await views.scheduledHours(fx.users.admin!, {
        ...MARCH,
        organizationId: fx.orgA,
        groupBy: 'organizationalUnit',
        organizationalUnitId: fx.unitRoot,
      });
      expect(unit.groups).toEqual([
        { key: fx.unitChild, shiftCount: 5, scheduledMinutes: 1680 },
      ]);
    });
  });

  it('pages groups by key and bounds the range', async () => {
    await scenario(async ({ fx, views }) => {
      const first = await views.scheduledHours(fx.users.admin!, {
        ...MARCH,
        organizationId: fx.orgA,
        groupBy: 'workDate',
        limit: 2,
      });
      expect(first.groups.map((group) => group.key)).toEqual([
        '2027-03-02',
        '2027-03-03',
      ]);
      expect(first.nextAfterKey).toBe('2027-03-03');
      const second = await views.scheduledHours(fx.users.admin!, {
        ...MARCH,
        organizationId: fx.orgA,
        groupBy: 'workDate',
        limit: 2,
        afterKey: first.nextAfterKey!,
      });
      expect(second.groups.map((group) => group.key)).toEqual([
        '2027-03-05',
        '2027-03-06',
      ]);
      await expect(
        views.scheduledHours(fx.users.admin!, {
          from: '2027-01-01',
          to: '2027-03-31',
          organizationId: fx.orgA,
          groupBy: 'employee',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── Scheduled vs actual ──────────────────────────────────────────────────

  it('compares published expected work with authoritative actual work', async () => {
    await scenario(async ({ tx, fx, variance, shifts }) => {
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          config: { breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 15 } },
        },
      });
      const revision = await tx.scheduledShiftRevision.findFirstOrThrow({
        where: { scheduledShiftId: shifts.e1Tue },
      });
      const entry = (data: Record<string, unknown>) =>
        tx.timeEntry.create({
          data: {
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentTeamA,
            timezone: 'America/Toronto',
            status: 'CLOSED',
            source: 'MANUAL',
            ...data,
          } as never,
        });
      const linked = await entry({
        clockInAt: at('2027-03-02T09:10'),
        clockOutAt: at('2027-03-02T17:00'),
        workDate: new Date('2027-03-02T00:00:00.000Z'),
        scheduledShiftId: shifts.e1Tue,
        scheduledShiftRevisionId: revision.id,
      });
      await tx.breakEntry.create({
        data: {
          timeEntryId: linked.id,
          startAt: at('2027-03-02T12:00'),
          endAt: at('2027-03-02T12:30'),
          payType: 'UNPAID',
        },
      });
      await entry({
        clockInAt: at('2027-03-02T18:00'),
        clockOutAt: at('2027-03-02T19:00'),
        workDate: new Date('2027-03-02T00:00:00.000Z'),
      });
      await entry({
        clockInAt: at('2027-03-03T09:00'),
        clockOutAt: null,
        status: 'OPEN',
        workDate: new Date('2027-03-03T00:00:00.000Z'),
      });

      const report = await variance.scheduledVsActual(fx.users.admin!, {
        organizationId: fx.orgA,
        from: '2027-03-02',
        to: '2027-03-03',
        employeeId: fx.employee1,
      });
      expect(report.rows).toEqual([
        {
          workDate: '2027-03-02',
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          scheduledShiftCount: 1,
          scheduledMinutes: 480,
          scheduledShiftIds: [shifts.e1Tue],
          // Batch 4F (Q8): who and where, for the view.
          employeeNumber: expect.any(String),
          employeeName: expect.any(String),
          positionName: expect.any(String),
          closedEntryCount: 2,
          openEntryCount: 0,
          grossMinutes: 470 + 60,
          // Same rule as timesheets (Batch 4D, D-G): gross − unpaid breaks − the day's one
          // auto-deduction, which the 30 recorded unpaid minutes already cover (15 ≤ 30).
          actualMinutes: 470 - 30 + 60,
          linkedActualMinutes: 440,
          unscheduledActualMinutes: 60,
          varianceMinutes: 500 - 480,
        },
        expect.objectContaining({
          workDate: '2027-03-03',
          scheduledMinutes: 240,
          openEntryCount: 1,
          actualMinutes: 0,
          varianceMinutes: -240,
        }),
      ]);
    });
  });

  it('requires time.view and schedule read on the position, and pages rows', async () => {
    await scenario(async ({ fx, variance }) => {
      const query = {
        organizationId: fx.orgA,
        from: '2027-03-01',
        to: '2027-03-07',
      };
      expect(
        (await variance.scheduledVsActual(fx.users.timeOnly!, query)).rows,
      ).toEqual([]);
      expect(
        (await variance.scheduledVsActual(fx.users.outsider!, query)).rows,
      ).toEqual([]);
      const deptB = await variance.scheduledVsActual(
        fx.users.deptBReader!,
        query,
      );
      expect(deptB.rows.map((row) => row.employmentAssignmentId)).toEqual([
        fx.assignmentDeptB,
      ]);
      const first = await variance.scheduledVsActual(fx.users.admin!, {
        ...query,
        limit: 2,
      });
      expect(first.rows).toHaveLength(2);
      const rest = await variance.scheduledVsActual(fx.users.admin!, {
        ...query,
        afterKey: first.nextAfterKey!,
      });
      expect(rest.rows.map((row) => row.workDate)).toEqual([
        '2027-03-03',
        '2027-03-05',
        '2027-03-06',
      ]);
      await expect(
        variance.scheduledVsActual(fx.users.admin!, {
          ...query,
          to: '2027-04-15',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── Expected-work contract ───────────────────────────────────────────────

  it('serves published expected work from the latest immutable revision', async () => {
    await scenario(async ({ fx, svc, attendance, shifts, schedules }) => {
      await svc.scheduling.correctShift(
        schedules.deptA,
        shifts.e1Tue,
        { endsAt: '2027-03-02T16:00:00-05:00', reason: 'Early close' },
        ctx(fx.users.admin!),
      );
      const facts = await attendance.publishedExpectedWork({
        employeeId: fx.employee1,
        start: at('2027-03-02T00:00').toISOString(),
        end: at('2027-03-05T00:00').toISOString(),
      });
      expect(facts.map((fact) => fact.scheduledShiftId)).toEqual([
        shifts.e1Tue,
        shifts.e1Wed,
      ]);
      expect(facts[0]).toMatchObject({
        revisionNumber: 2,
        scheduledMinutes: 420,
        workDate: '2027-03-02',
        employmentAssignmentId: fx.assignmentTeamA,
      });
      const dst = await attendance.publishedExpectedWork({
        employeeId: fx.employee1,
        employmentAssignmentId: fx.assignmentTeamA,
        start: '2027-03-14T00:00:00.000Z',
        end: '2027-03-15T00:00:00.000Z',
      });
      expect(dst).toEqual([
        expect.objectContaining({
          scheduledShiftId: shifts.dstOvernight,
          scheduledMinutes: 420,
        }),
      ]);
      await expect(
        attendance.publishedExpectedWork({
          employeeId: fx.employee1,
          start: '2027-01-01T00:00:00.000Z',
          end: '2027-06-01T00:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── Hardening ────────────────────────────────────────────────────────────

  it('never reassigns a published shift to another employee', async () => {
    await scenario(async ({ fx, svc, shifts, schedules }) => {
      const admin = ctx(fx.users.admin!);
      const error = await rejection(
        svc.scheduling.correctShift(
          schedules.org,
          shifts.orgE1,
          { employmentAssignmentId: fx.orgLevel, reason: 'Cover' },
          admin,
        ),
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'PUBLISHED_SHIFT_REASSIGNMENT_NOT_ALLOWED',
      });
      // The same employee's other assignment is a legitimate correction.
      const moved = await svc.scheduling.correctShift(
        schedules.org,
        shifts.orgE1,
        { employmentAssignmentId: fx.assignmentDeptB, reason: 'Other job' },
        admin,
      );
      expect(moved.shift.employmentAssignmentId).toBe(fx.assignmentDeptB);
      expect(moved.revision.revisionNumber).toBe(2);
    });
  });
});
