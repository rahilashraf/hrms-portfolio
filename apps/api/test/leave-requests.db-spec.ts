import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  FixedClock,
  grantMinutes,
  LEAVE_PERMISSIONS,
  LEAVE_USERS,
  leaveServices,
  seedLeaveConfig,
  TIME_PERMISSIONS,
  type LeaveServices,
} from './support/leave-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  torontoShift,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** America/Toronto is EST (-05:00) until 2027-03-14 and EDT (-04:00) after. */
const est = (local: string) => new Date(`${local}:00-05:00`);

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  svc: LeaveServices;
  clock: FixedClock;
  types: Awaited<ReturnType<typeof seedLeaveConfig>>;
  hr: ReturnType<typeof ctx>;
  self1: ReturnType<typeof ctx>;
  self2: ReturnType<typeof ctx>;
  /** A published Dept A schedule for the week of 2027-03-01 with Team A shifts. */
  publishWeek: (shifts: ReturnType<typeof torontoShift>[]) => Promise<string[]>;
}

const errorBody = (error: unknown) =>
  (error as { getResponse(): Record<string, unknown> }).getResponse();

describe('Leave requests (database)', () => {
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
    policy: Record<string, unknown> = {},
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, LEAVE_USERS, [
            ...LEAVE_PERMISSIONS,
            ...TIME_PERMISSIONS,
          ]);
          const client = rollbackClient(tx);
          const clock = new FixedClock();
          const svc = leaveServices(client, clock);
          const types = await seedLeaveConfig(tx, fx, svc, policy);
          const admin = ctx(fx.users.admin!);
          await (async () =>
            run({
              tx,
              fx,
              svc,
              clock,
              types,
              hr: ctx(fx.users.hr!),
              self1: ctx(fx.selfUser1),
              self2: ctx(fx.selfUser2),
              publishWeek: async (shifts) => {
                const schedule = await svc.scheduling.createSchedule(
                  {
                    scopeType: 'DEPARTMENT',
                    organizationId: fx.orgA,
                    departmentId: fx.deptA,
                    name: 'Week',
                    type: 'STANDARD',
                    periodStart: '2027-03-01',
                    periodEnd: '2027-03-07',
                  },
                  admin,
                );
                const ids = [];
                for (const shift of shifts) {
                  ids.push(
                    (
                      await svc.scheduling.createShift(
                        schedule.id,
                        shift,
                        admin,
                      )
                    ).id,
                  );
                }
                await svc.scheduling.publishSchedule(schedule.id, admin);
                return ids;
              },
            }))().catch((error: unknown) => {
            // Surface the real failure (the outer assertion only sees "not RollbackFixtures").
            console.error(
              'SCENARIO FAILURE:',
              error instanceof Error ? error.message : error,
            );
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const request = (
    assignment: string,
    leaveTypeId: string,
    startDate: string,
    endDate = startDate,
    extra = {},
  ) => ({
    employmentAssignmentId: assignment,
    leaveTypeId,
    startDate,
    endDate,
    ...extra,
  });

  // ─── Sizing ────────────────────────────────────────────────────────────────

  it('sizes standard workdays, excluding weekends and holidays', async () => {
    await scenario(async ({ fx, svc, types, hr, self1 }) => {
      await svc.holidays.create(
        {
          organizationId: fx.orgA,
          date: '2027-03-03',
          name: 'Founders Day',
          kind: 'CLOSURE',
        },
        hr,
      );
      const preview = await svc.requests.previewOwn(
        fx.selfUser1,
        request(
          fx.assignmentDeptB,
          types.vacation.id,
          '2027-03-01',
          '2027-03-07',
        ),
      );
      expect(preview.totalMinutes).toBe(4 * 480);
      expect(
        preview.days.map((d) => [d.date, d.minutes, d.amountSource]),
      ).toEqual([
        ['2027-03-01', 480, 'STANDARD_DAY'],
        ['2027-03-02', 480, 'STANDARD_DAY'],
        ['2027-03-03', 0, 'HOLIDAY_EXCLUDED'],
        ['2027-03-04', 480, 'STANDARD_DAY'],
        ['2027-03-05', 480, 'STANDARD_DAY'],
        ['2027-03-06', 0, 'NON_WORKDAY'],
        ['2027-03-07', 0, 'NON_WORKDAY'],
      ]);
      expect(preview.days[2]!.holidayName).toBe('Founders Day');
      // Dept B has no WorkLocation: the organization timezone applies, never UTC.
      expect(preview.timezone).toBe('America/Toronto');
      expect(preview.days[0]!.windowStart).toBe(
        est('2027-03-01T00:00').toISOString(),
      );
      expect(preview.balance).toMatchObject({
        availableMinutes: 0,
        sufficient: false,
      });
      void self1;
    });
  });

  it('sizes from published shifts when a published schedule covers the date', async () => {
    await scenario(async ({ fx, svc, types, publishWeek }) => {
      await publishWeek([
        torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        torontoShift(
          fx.assignmentTeamA,
          '2027-03-03',
          '22:00',
          '06:00',
          '-05:00',
          '2027-03-04',
        ),
      ]);
      const preview = await svc.requests.previewOwn(
        fx.selfUser1,
        request(
          fx.assignmentTeamA,
          types.vacation.id,
          '2027-03-01',
          '2027-03-08',
        ),
      );
      expect(
        preview.days.map((d) => [d.date, d.minutes, d.amountSource]),
      ).toEqual([
        // A published schedule covers Mon–Sun: no shift means a day off, not a standard day.
        ['2027-03-01', 0, 'NON_WORKDAY'],
        ['2027-03-02', 480, 'SCHEDULE'],
        ['2027-03-03', 480, 'SCHEDULE'],
        ['2027-03-04', 0, 'NON_WORKDAY'],
        ['2027-03-05', 0, 'NON_WORKDAY'],
        ['2027-03-06', 0, 'NON_WORKDAY'],
        ['2027-03-07', 0, 'NON_WORKDAY'],
        // No published schedule covers the next Monday: the standard day applies.
        ['2027-03-08', 480, 'STANDARD_DAY'],
      ]);
      // The overnight shift belongs to Wednesday; its absence runs to Thursday 06:00.
      expect(preview.days[2]).toMatchObject({
        absenceStart: est('2027-03-03T00:00').toISOString(),
        absenceEnd: est('2027-03-04T06:00').toISOString(),
      });
    });
  });

  it('treats only a rostered assignment as schedule-driven, never one its schedule scope merely contains', async () => {
    await scenario(async ({ fx, svc, types, publishWeek }) => {
      // A Dept A roster that lists only Employee 1 (Team A); Employee 2 is also in Team A.
      await publishWeek([
        torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
      ]);
      const omitted = await svc.requests.previewOwn(
        fx.selfUser2,
        request(fx.otherTeamA, types.vacation.id, '2027-03-01', '2027-03-02'),
      );
      expect(
        omitted.days.map((d) => [d.date, d.minutes, d.amountSource]),
      ).toEqual([
        ['2027-03-01', 480, 'STANDARD_DAY'],
        ['2027-03-02', 480, 'STANDARD_DAY'],
      ]);
      const rostered = await svc.requests.previewOwn(
        fx.selfUser1,
        request(
          fx.assignmentTeamA,
          types.vacation.id,
          '2027-03-01',
          '2027-03-02',
        ),
      );
      expect(
        rostered.days.map((d) => [d.date, d.minutes, d.amountSource]),
      ).toEqual([
        ['2027-03-01', 0, 'NON_WORKDAY'],
        ['2027-03-02', 480, 'SCHEDULE'],
      ]);
    });
  });

  it('lets an AD_HOC schedule decide only the dates of its own shifts', async () => {
    await scenario(async ({ fx, svc, types }) => {
      const admin = ctx(fx.users.admin!);
      const event = await svc.scheduling.createSchedule(
        {
          scopeType: 'DEPARTMENT',
          organizationId: fx.orgA,
          departmentId: fx.deptA,
          name: 'Saturday event',
          type: 'AD_HOC',
          periodStart: '2027-03-01',
          periodEnd: '2027-03-07',
        },
        admin,
      );
      await svc.scheduling.createShift(
        event.id,
        torontoShift(fx.assignmentTeamA, '2027-03-06', '10:00', '14:00'),
        admin,
      );
      await svc.scheduling.publishSchedule(event.id, admin);
      const preview = await svc.requests.previewOwn(
        fx.selfUser1,
        request(
          fx.assignmentTeamA,
          types.vacation.id,
          '2027-03-05',
          '2027-03-07',
        ),
      );
      expect(
        preview.days.map((d) => [d.date, d.minutes, d.amountSource]),
      ).toEqual([
        ['2027-03-05', 480, 'STANDARD_DAY'],
        ['2027-03-06', 240, 'SCHEDULE'],
        ['2027-03-07', 0, 'NON_WORKDAY'],
      ]);
    });
  });

  it('handles partial days from shifts or the standard day, and DST-length days', async () => {
    await scenario(async ({ fx, svc, types, hr, publishWeek }) => {
      await publishWeek([
        torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
      ]);
      const scheduled = await svc.requests.previewOwn(
        fx.selfUser1,
        request(
          fx.assignmentTeamA,
          types.personal.id,
          '2027-03-02',
          '2027-03-02',
          {
            startLocalTime: '08:00',
            endLocalTime: '10:00',
          },
        ),
      );
      expect(scheduled.totalMinutes).toBe(60);
      const standard = await svc.requests.previewOwn(
        fx.selfUser1,
        request(
          fx.assignmentDeptB,
          types.personal.id,
          '2027-03-04',
          '2027-03-04',
          {
            startLocalTime: '13:00',
            endLocalTime: '15:30',
          },
        ),
      );
      expect(standard.totalMinutes).toBe(150);
      expect(standard.days[0]).toMatchObject({
        windowStart: est('2027-03-04T13:00').toISOString(),
        windowEnd: est('2027-03-04T15:30').toISOString(),
      });
      // A seven-day policy shows the 23-hour spring-forward day and 25-hour fall-back day.
      const daily = await svc.config.createType(
        {
          organizationId: fx.orgA,
          code: 'DAILY',
          name: 'Daily',
          classification: 'UNPAID',
          tracksBalance: false,
        },
        hr,
      );
      await svc.config.createPolicy(
        {
          leaveTypeId: daily.id,
          organizationId: fx.orgA,
          scopeType: 'ORGANIZATION',
          effectiveFrom: '2026-01-01',
          standardWorkdays: [
            'MONDAY',
            'TUESDAY',
            'WEDNESDAY',
            'THURSDAY',
            'FRIDAY',
            'SATURDAY',
            'SUNDAY',
          ],
        } as never,
        hr,
      );
      const spring = await svc.requests.previewOwn(
        fx.selfUser1,
        request(fx.assignmentDeptB, daily.id, '2027-03-14'),
      );
      const fall = await svc.requests.previewOwn(
        fx.selfUser1,
        request(fx.assignmentDeptB, daily.id, '2027-11-07'),
      );
      const hours = (d: { windowStart: string; windowEnd: string }) =>
        (Date.parse(d.windowEnd) - Date.parse(d.windowStart)) / 3_600_000;
      expect(hours(spring.days[0]!)).toBe(23);
      expect(hours(fall.days[0]!)).toBe(25);
      expect(spring.totalMinutes).toBe(480);
      const error = await rejection(
        svc.requests.previewOwn(
          fx.selfUser1,
          request(fx.assignmentDeptB, daily.id, '2027-03-14', '2027-03-14', {
            startLocalTime: '02:15',
            endLocalTime: '04:00',
          }),
        ),
      );
      expect(errorBody(error)).toMatchObject({
        code: 'LOCAL_TIME_NONEXISTENT',
      });
    });
  });

  it('resolves the most specific policy and refuses ineligible or unresolvable assignments', async () => {
    await scenario(async ({ tx, fx, svc, types, hr }) => {
      // A PART_TIME-specific org policy beats the all-types org policy for the Dept B assignment.
      await svc.config.createPolicy(
        {
          leaveTypeId: types.vacation.id,
          organizationId: fx.orgA,
          scopeType: 'ORGANIZATION',
          effectiveFrom: '2026-01-01',
          employmentTypes: ['PART_TIME'],
          standardWorkdayMinutes: 240,
        } as never,
        hr,
      );
      const partTime = await svc.requests.previewOwn(
        fx.selfUser1,
        request(fx.assignmentDeptB, types.vacation.id, '2027-03-01'),
      );
      expect(partTime.totalMinutes).toBe(240);
      const fullTime = await svc.requests.previewOwn(
        fx.selfUser1,
        request(fx.assignmentTeamA, types.vacation.id, '2027-03-08'),
      );
      expect(fullTime.totalMinutes).toBe(480);
      // An assignment-scoped policy wins over everything and can make it ineligible.
      await svc.config.createPolicy(
        {
          leaveTypeId: types.vacation.id,
          organizationId: fx.orgA,
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentDeptB,
          effectiveFrom: '2027-03-01',
          eligible: false,
        } as never,
        hr,
      );
      const ineligible = await rejection(
        svc.requests.previewOwn(
          fx.selfUser1,
          request(fx.assignmentDeptB, types.vacation.id, '2027-03-01'),
        ),
      );
      expect(errorBody(ineligible)).toMatchObject({
        code: 'LEAVE_NOT_ELIGIBLE',
      });
      // Before the assignment starts.
      const outside = await rejection(
        svc.requests.previewOwn(
          fx.selfUser1,
          request(fx.assignmentTeamA, types.vacation.id, '2025-12-31'),
        ),
      );
      expect(errorBody(outside)).toMatchObject({
        code: 'LEAVE_OUTSIDE_ASSIGNMENT',
      });
      // No WorkLocation and no organization timezone: refused, never UTC.
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: null },
      });
      const unresolved = await rejection(
        svc.requests.previewOwn(
          fx.selfUser1,
          request(fx.assignmentDeptB, types.personal.id, '2027-03-01'),
        ),
      );
      expect(errorBody(unresolved)).toMatchObject({
        code: 'LEAVE_TIMEZONE_UNRESOLVED',
      });
    });
  });

  // ─── Lifecycle and balances ────────────────────────────────────────────────

  it('approves into future-dated usage: available drops now, scheduled shows it', async () => {
    await scenario(async ({ tx, fx, svc, types, hr }) => {
      await grantMinutes(svc, fx, fx.assignmentDeptB, types.vacation.id, 2400);
      const submitted = await svc.requests.submitOwn(
        fx.selfUser1,
        request(
          fx.assignmentDeptB,
          types.vacation.id,
          '2027-03-01',
          '2027-03-02',
        ),
        ctx(fx.selfUser1),
      );
      let me = await svc.views.me(fx.selfUser1);
      const vacationRow = () =>
        me.assignments
          .find((a) => a.employmentAssignmentId === fx.assignmentDeptB)!
          .leaveTypes.find((t) => t.leaveType.id === types.vacation.id)!;
      expect(vacationRow().balance).toEqual({
        currentMinutes: 2400,
        scheduledMinutes: 0,
        availableMinutes: 2400,
        pendingMinutes: 960,
      });
      const approved = await svc.requests.approve(
        fx.users.hr!,
        submitted.requestId,
        { note: 'Enjoy' },
        hr,
      );
      expect(approved).toMatchObject({
        status: 'APPROVED',
        approvedMinutes: 960,
      });
      me = await svc.views.me(fx.selfUser1);
      expect(vacationRow().balance).toEqual({
        currentMinutes: 2400,
        scheduledMinutes: 960,
        availableMinutes: 1440,
        pendingMinutes: 0,
      });
      const usage = await tx.leaveLedgerEntry.findMany({
        where: { leaveRequestId: submitted.requestId },
        orderBy: { effectiveDate: 'asc' },
      });
      expect(
        usage.map((u) => [
          u.entryType,
          u.amountMinutes,
          u.effectiveDate.toISOString().slice(0, 10),
        ]),
      ).toEqual([
        ['USAGE', -480, '2027-03-01'],
        ['USAGE', -480, '2027-03-02'],
      ]);
      // Approving twice is refused; nothing is posted twice.
      const again = await rejection(
        svc.requests.approve(fx.users.hr!, submitted.requestId, {}, hr),
      );
      expect(errorBody(again)).toMatchObject({
        code: 'LEAVE_REQUEST_NOT_PENDING',
      });
      expect(
        await tx.leaveLedgerEntry.count({
          where: { leaveRequestId: submitted.requestId },
        }),
      ).toBe(2);
      // Events and audit.
      const events = await tx.leaveRequestEvent.findMany({
        where: { requestId: submitted.requestId },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((e) => e.type)).toEqual(['SUBMITTED', 'APPROVED']);
      expect(
        await tx.auditLog.count({
          where: {
            entityId: submitted.requestId,
            action: 'LEAVE_REQUEST_APPROVED',
          },
        }),
      ).toBe(1);
    });
  });

  it('enforces balance, the negative-balance limit and approver overrides', async () => {
    await scenario(async ({ fx, svc, types, hr }) => {
      await grantMinutes(svc, fx, fx.assignmentDeptB, types.vacation.id, 480);
      const tooMuch = await rejection(
        svc.requests.submitOwn(
          fx.selfUser1,
          request(
            fx.assignmentDeptB,
            types.vacation.id,
            '2027-03-01',
            '2027-03-02',
          ),
          ctx(fx.selfUser1),
        ),
      );
      expect(errorBody(tooMuch)).toMatchObject({
        code: 'LEAVE_INSUFFICIENT_BALANCE',
        availableMinutes: 480,
      });
      // A Dept B policy allowing one day of overdraft is more specific than the org policy.
      await svc.config.createPolicy(
        {
          leaveTypeId: types.vacation.id,
          organizationId: fx.orgA,
          scopeType: 'DEPARTMENT',
          departmentId: fx.deptB,
          effectiveFrom: '2026-01-01',
          negativeBalanceLimitMinutes: 480,
        } as never,
        hr,
      );
      const ok = await svc.requests.submitOwn(
        fx.selfUser1,
        request(
          fx.assignmentDeptB,
          types.vacation.id,
          '2027-03-01',
          '2027-03-02',
        ),
        ctx(fx.selfUser1),
      );
      // An override needs a date of the request and a reason; the result is frozen.
      const bad = await rejection(
        svc.requests.approve(
          fx.users.hr!,
          ok.requestId,
          { dayOverrides: [{ date: '2027-03-09', minutes: 60, reason: 'x' }] },
          hr,
        ),
      );
      expect(errorBody(bad)).toMatchObject({ code: 'LEAVE_OVERRIDE_INVALID' });
      await svc.requests.approve(
        fx.users.hr!,
        ok.requestId,
        {
          dayOverrides: [
            { date: '2027-03-02', minutes: 240, reason: 'Half day agreed' },
          ],
        },
        hr,
      );
      const detail = await svc.views.requestDetail(fx.users.hr!, ok.requestId);
      expect(detail.approvedMinutes).toBe(720);
      expect(detail.days[1]).toMatchObject({
        minutes: 240,
        amountSource: 'MANUAL_OVERRIDE',
        overrideReason: 'Half day agreed',
      });
      expect(detail.balance).toMatchObject({ availableMinutes: -240 });
    });
  });

  it('refuses overlapping leave across types but allows disjoint partial days', async () => {
    await scenario(async ({ fx, svc, types, hr }) => {
      await grantMinutes(svc, fx, fx.assignmentDeptB, types.vacation.id, 4800);
      const first = await svc.requests.submitOwn(
        fx.selfUser1,
        request(
          fx.assignmentDeptB,
          types.vacation.id,
          '2027-03-01',
          '2027-03-03',
        ),
        ctx(fx.selfUser1),
      );
      const overlap = await rejection(
        svc.requests.submitOwn(
          fx.selfUser1,
          request(fx.assignmentDeptB, types.personal.id, '2027-03-03'),
          ctx(fx.selfUser1),
        ),
      );
      expect(errorBody(overlap)).toMatchObject({
        code: 'LEAVE_REQUEST_OVERLAP',
        conflictingRequestIds: [first.requestId],
        dates: ['2027-03-03'],
      });
      // Another assignment of the same employee is a separate work context.
      await svc.requests.submitOwn(
        fx.selfUser1,
        request(fx.assignmentTeamA, types.personal.id, '2027-03-03'),
        ctx(fx.selfUser1),
      );
      // Disjoint partial windows on one date coexist; overlapping ones do not.
      await svc.requests.submitOwn(
        fx.selfUser1,
        request(
          fx.assignmentDeptB,
          types.personal.id,
          '2027-03-08',
          '2027-03-08',
          { startLocalTime: '09:00', endLocalTime: '10:00' },
        ),
        ctx(fx.selfUser1),
      );
      await svc.requests.submitOwn(
        fx.selfUser1,
        request(
          fx.assignmentDeptB,
          types.personal.id,
          '2027-03-08',
          '2027-03-08',
          { startLocalTime: '13:00', endLocalTime: '14:00' },
        ),
        ctx(fx.selfUser1),
      );
      const partialClash = await rejection(
        svc.requests.submitOwn(
          fx.selfUser1,
          request(
            fx.assignmentDeptB,
            types.personal.id,
            '2027-03-08',
            '2027-03-08',
            { startLocalTime: '09:30', endLocalTime: '11:00' },
          ),
          ctx(fx.selfUser1),
        ),
      );
      expect(errorBody(partialClash)).toMatchObject({
        code: 'LEAVE_REQUEST_OVERLAP',
      });
      // Rejected leave no longer blocks the dates.
      await svc.requests.reject(
        fx.users.hr!,
        first.requestId,
        { note: 'Busy week' },
        hr,
      );
      await svc.requests.submitOwn(
        fx.selfUser1,
        request(fx.assignmentDeptB, types.personal.id, '2027-03-02'),
        ctx(fx.selfUser1),
      );
    });
  });

  it('scopes decisions, refuses self-approval and records leave on behalf', async () => {
    await scenario(async ({ fx, svc, types, hr, self2 }) => {
      // Employee 2 approves Team A leave, but never their own.
      const own = await svc.requests.submitOwn(
        fx.selfUser2,
        request(fx.otherTeamA, types.personal.id, '2027-03-01'),
        self2,
      );
      const selfApproval = await rejection(
        svc.requests.approve(fx.selfUser2, own.requestId, {}, self2),
      );
      expect(selfApproval).toBeInstanceOf(ForbiddenException);
      expect(errorBody(selfApproval)).toMatchObject({
        code: 'LEAVE_SELF_APPROVAL',
      });
      await svc.requests.approve(
        fx.users.teamApprover!,
        own.requestId,
        {},
        ctx(fx.users.teamApprover!),
      );
      // Team A approvers cannot decide Dept B leave; outsiders cannot even see it.
      const deptB = await svc.requests.submitOwn(
        fx.selfUser1,
        request(fx.assignmentDeptB, types.personal.id, '2027-03-01'),
        ctx(fx.selfUser1),
      );
      await expect(
        svc.requests.approve(
          fx.users.teamApprover!,
          deptB.requestId,
          {},
          ctx(fx.users.teamApprover!),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.views.requestDetail(fx.users.outsider!, deptB.requestId),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Without leave.request an employee cannot submit.
      await expect(
        svc.requests.submitOwn(
          fx.users.hr!,
          request(fx.assignmentDeptB, types.personal.id, '2027-03-05'),
          hr,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // HR records and approves leave for Employee 1 in one step.
      const recorded = await svc.requests.createOnBehalf(
        fx.users.hr!,
        {
          ...request(fx.assignmentTeamA, types.personal.id, '2027-03-09'),
          approve: true,
          note: 'Called in sick',
        },
        hr,
      );
      expect(recorded.status).toBe('APPROVED');
      const detail = await svc.views.requestDetail(
        fx.users.hr!,
        recorded.requestId,
      );
      expect(detail.requestedByUserId).toBe(fx.users.hr);
      // Recording one's own leave on behalf is refused.
      const selfRecord = await rejection(
        svc.requests.createOnBehalf(
          fx.selfUser2,
          {
            ...request(fx.otherTeamA, types.personal.id, '2027-03-10'),
            approve: true,
          },
          self2,
        ),
      );
      expect(errorBody(selfRecord)).toMatchObject({
        code: 'LEAVE_SELF_APPROVAL',
      });
    });
  });

  // ─── Cancellation and amendment ────────────────────────────────────────────

  it('cancels own pending and future approved leave with exact reversals', async () => {
    await scenario(async ({ tx, fx, svc, types, hr, self1 }) => {
      await grantMinutes(svc, fx, fx.assignmentDeptB, types.vacation.id, 2400);
      const pending = await svc.requests.submitOwn(
        fx.selfUser1,
        request(fx.assignmentDeptB, types.vacation.id, '2027-03-08'),
        self1,
      );
      expect(
        await svc.requests.cancelOwn(
          fx.selfUser1,
          pending.requestId,
          {},
          self1,
        ),
      ).toMatchObject({ status: 'CANCELLED' });
      const approved = await svc.requests.submitOwn(
        fx.selfUser1,
        request(
          fx.assignmentDeptB,
          types.vacation.id,
          '2027-03-01',
          '2027-03-03',
        ),
        self1,
      );
      await svc.requests.approve(fx.users.hr!, approved.requestId, {}, hr);
      const result = await svc.requests.cancelOwn(
        fx.selfUser1,
        approved.requestId,
        { reason: 'Plans changed' },
        self1,
      );
      expect(result).toMatchObject({
        status: 'CANCELLED',
        cancelledMinutes: 1440,
      });
      const entries = await tx.leaveLedgerEntry.findMany({
        where: { leaveRequestId: approved.requestId },
      });
      const reversals = entries.filter((e) => e.entryType === 'REVERSAL');
      expect(reversals).toHaveLength(3);
      for (const reversal of reversals) {
        const original = entries.find(
          (e) => e.id === reversal.reversesEntryId,
        )!;
        expect(original.entryType).toBe('USAGE');
        expect(reversal.amountMinutes).toBe(-original.amountMinutes);
        expect(reversal.effectiveDate).toEqual(original.effectiveDate);
      }
      // The balance is restored exactly, never beyond the entitlement.
      const me = await svc.views.me(fx.selfUser1);
      expect(
        me.assignments
          .find((a) => a.employmentAssignmentId === fx.assignmentDeptB)!
          .leaveTypes.find((t) => t.leaveType.id === types.vacation.id)!
          .balance,
      ).toEqual({
        currentMinutes: 2400,
        scheduledMinutes: 0,
        availableMinutes: 2400,
        pendingMinutes: 0,
      });
      // Cancelling again has nothing left to do.
      const again = await rejection(
        svc.requests.cancelOwn(fx.selfUser1, approved.requestId, {}, self1),
      );
      expect(errorBody(again)).toMatchObject({
        code: 'LEAVE_REQUEST_NOT_CANCELLABLE',
      });
    });
  });

  it('lets approvers shorten and cancel approved leave, and policy can forbid self-cancel', async () => {
    await scenario(async ({ tx, fx, svc, types, hr, self1 }) => {
      await svc.config.createPolicy(
        {
          leaveTypeId: types.vacation.id,
          organizationId: fx.orgA,
          scopeType: 'DEPARTMENT',
          departmentId: fx.deptB,
          effectiveFrom: '2026-01-01',
          employeeMayCancelApprovedFuture: false,
        } as never,
        hr,
      );
      await grantMinutes(svc, fx, fx.assignmentDeptB, types.vacation.id, 4800);
      const leave = await svc.requests.submitOwn(
        fx.selfUser1,
        request(
          fx.assignmentDeptB,
          types.vacation.id,
          '2027-03-01',
          '2027-03-05',
        ),
        self1,
      );
      await svc.requests.approve(fx.users.hr!, leave.requestId, {}, hr);
      const selfCancel = await rejection(
        svc.requests.cancelOwn(fx.selfUser1, leave.requestId, {}, self1),
      );
      expect(errorBody(selfCancel)).toMatchObject({
        code: 'LEAVE_SELF_CANCEL_NOT_ALLOWED',
      });
      const shortened = await svc.requests.amend(
        fx.users.hr!,
        leave.requestId,
        { reason: 'Back early', cancelFrom: '2027-03-04' },
        hr,
      );
      expect(shortened).toMatchObject({
        status: 'APPROVED',
        cancelledMinutes: 960,
      });
      const invalid = await rejection(
        svc.requests.amend(
          fx.users.hr!,
          leave.requestId,
          { reason: 'x', cancelDates: ['2027-03-04'] },
          hr,
        ),
      );
      expect(errorBody(invalid)).toMatchObject({
        code: 'LEAVE_AMEND_DATES_INVALID',
      });
      await svc.requests.amend(
        fx.users.hr!,
        leave.requestId,
        { reason: 'Partial', cancelDates: ['2027-03-01'] },
        hr,
      );
      const detail = await svc.views.requestDetail(
        fx.users.hr!,
        leave.requestId,
      );
      expect(detail.activeMinutes).toBe(960);
      expect(detail.amendments.map((a) => a.type)).toEqual([
        'SHORTEN',
        'SHORTEN',
      ]);
      expect(detail.balance).toMatchObject({
        scheduledMinutes: 960,
        availableMinutes: 4800 - 960,
      });
      await svc.requests.amend(
        fx.users.hr!,
        leave.requestId,
        { reason: 'Cancelled entirely' },
        hr,
      );
      const cancelled = await svc.views.requestDetail(
        fx.users.hr!,
        leave.requestId,
      );
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.balance).toMatchObject({
        scheduledMinutes: 0,
        availableMinutes: 4800,
      });
      expect(
        await tx.leaveLedgerEntry.count({
          where: { leaveRequestId: leave.requestId, entryType: 'REVERSAL' },
        }),
      ).toBe(5);
    });
  });

  it('refuses leave changes inside locked time periods', async () => {
    await scenario(async ({ tx, fx, svc, types, hr, self1 }) => {
      await grantMinutes(svc, fx, fx.assignmentDeptB, types.vacation.id, 4800);
      const leave = await svc.requests.submitOwn(
        fx.selfUser1,
        request(
          fx.assignmentDeptB,
          types.vacation.id,
          '2027-03-01',
          '2027-03-02',
        ),
        self1,
      );
      await svc.requests.approve(fx.users.hr!, leave.requestId, {}, hr);
      const period = await tx.timePeriod.create({
        data: {
          organizationId: fx.orgA,
          startDate: new Date('2027-03-01T00:00:00.000Z'),
          endDate: new Date('2027-03-07T00:00:00.000Z'),
          status: 'LOCKED',
          cadence: 'WEEKLY',
          openedAt: new Date(),
          closedAt: new Date(),
          lockedAt: new Date(),
        },
      });
      const amend = await rejection(
        svc.requests.amend(
          fx.users.hr!,
          leave.requestId,
          { reason: 'Too late' },
          hr,
        ),
      );
      expect(amend).toBeInstanceOf(ConflictException);
      expect(errorBody(amend)).toMatchObject({
        code: 'LEAVE_PERIOD_LOCKED',
        dates: ['2027-03-01', '2027-03-02'],
      });
      // The read model's actions agree with the endpoint.
      expect(
        (await svc.views.requestDetail(fx.users.hr!, leave.requestId)).actions
          .canAmend,
      ).toBe(false);
      const submit = await rejection(
        svc.requests.submitOwn(
          fx.selfUser1,
          request(fx.assignmentDeptB, types.vacation.id, '2027-03-04'),
          self1,
        ),
      );
      expect(errorBody(submit)).toMatchObject({ code: 'LEAVE_PERIOD_LOCKED' });
      // Before locking, normal reversal semantics apply; an employee's LOCKED timesheet also locks.
      await tx.timePeriod.update({
        where: { id: period.id },
        data: { status: 'OPEN', closedAt: null, lockedAt: null },
      });
      await tx.timesheet.create({
        data: {
          employeeId: fx.employee1,
          timePeriodId: period.id,
          status: 'LOCKED',
          lockedAt: new Date(),
          lockedByUserId: fx.users.hr!,
        },
      });
      const sheetLocked = await rejection(
        svc.requests.amend(fx.users.hr!, leave.requestId, { reason: 'x' }, hr),
      );
      expect(errorBody(sheetLocked)).toMatchObject({
        code: 'LEAVE_PERIOD_LOCKED',
      });
      await tx.timesheet.updateMany({
        where: { timePeriodId: period.id },
        data: { status: 'OPEN', lockedAt: null, lockedByUserId: null },
      });
      expect(
        (await svc.views.requestDetail(fx.users.hr!, leave.requestId)).actions
          .canAmend,
      ).toBe(true);
      expect(
        await svc.requests.amend(
          fx.users.hr!,
          leave.requestId,
          { reason: 'Unlocked now' },
          hr,
        ),
      ).toMatchObject({ status: 'CANCELLED' });
    });
  });

  it('keeps queue, detail and self-service actions in line with locked periods', async () => {
    await scenario(async ({ tx, fx, svc, types, hr, self1 }) => {
      await grantMinutes(svc, fx, fx.assignmentDeptB, types.vacation.id, 4800);
      // 03-05 (Fri) .. 03-09 (Tue): working days 03-05, 03-08, 03-09; the week 03-01..03-07 locks.
      const leave = await svc.requests.submitOwn(
        fx.selfUser1,
        request(
          fx.assignmentDeptB,
          types.vacation.id,
          '2027-03-05',
          '2027-03-09',
        ),
        self1,
      );
      await svc.requests.approve(fx.users.hr!, leave.requestId, {}, hr);
      const queueRow = async () =>
        (
          await svc.views.queue(fx.users.hr!, {
            organizationId: fx.orgA,
            status: 'APPROVED',
          })
        ).items.find((r) => r.id === leave.requestId)!;
      const mine = async () =>
        (await svc.views.myRequests(fx.selfUser1, {})).items.find(
          (r) => r.id === leave.requestId,
        )!;
      expect((await queueRow()).actions.canAmend).toBe(true);
      expect((await mine()).actions.canCancel).toBe(true);

      const period = await tx.timePeriod.create({
        data: {
          organizationId: fx.orgA,
          startDate: new Date('2027-03-01T00:00:00.000Z'),
          endDate: new Date('2027-03-07T00:00:00.000Z'),
          status: 'LOCKED',
          cadence: 'WEEKLY',
          openedAt: new Date(),
          closedAt: new Date(),
          lockedAt: new Date(),
        },
      });
      // Partly locked: approvers may still shorten the unlocked days, the employee may not
      // cancel (self-cancel takes every remaining future day, including the locked one).
      expect((await queueRow()).actions.canAmend).toBe(true);
      expect((await mine()).actions.canCancel).toBe(false);
      const detail = await svc.views.requestDetail(
        fx.users.hr!,
        leave.requestId,
      );
      expect(detail.days.map((d) => [d.date, d.locked])).toEqual([
        ['2027-03-05', true],
        ['2027-03-06', true],
        ['2027-03-07', true],
        ['2027-03-08', false],
        ['2027-03-09', false],
      ]);
      expect(
        errorBody(
          await rejection(
            svc.requests.cancelOwn(fx.selfUser1, leave.requestId, {}, self1),
          ),
        ),
      ).toMatchObject({
        code: 'LEAVE_PERIOD_LOCKED',
      });

      // Fully locked: nothing can change, and every view says so.
      await tx.timePeriod.update({
        where: { id: period.id },
        data: { endDate: new Date('2027-03-14T00:00:00.000Z') },
      });
      expect((await queueRow()).actions.canAmend).toBe(false);
      expect(
        (await svc.views.requestDetail(fx.users.hr!, leave.requestId)).actions
          .canAmend,
      ).toBe(false);
      expect(
        (await svc.views.requestDetail(fx.selfUser1, leave.requestId)).actions
          .canCancel,
      ).toBe(false);
      for (const input of [
        { reason: 'x' },
        { reason: 'x', cancelFrom: '2027-03-08' },
        { reason: 'x', cancelDates: ['2027-03-09'] },
      ]) {
        expect(
          errorBody(
            await rejection(
              svc.requests.amend(fx.users.hr!, leave.requestId, input, hr),
            ),
          ),
        ).toMatchObject({
          code: 'LEAVE_PERIOD_LOCKED',
        });
      }
      // An employee's LOCKED timesheet locks too (and only for that employee).
      await tx.timePeriod.update({
        where: { id: period.id },
        data: { status: 'OPEN', closedAt: null, lockedAt: null },
      });
      expect((await queueRow()).actions.canAmend).toBe(true);
      await tx.timesheet.create({
        data: {
          employeeId: fx.employee1,
          timePeriodId: period.id,
          status: 'LOCKED',
          lockedAt: new Date(),
          lockedByUserId: fx.users.hr!,
        },
      });
      expect((await queueRow()).actions.canAmend).toBe(false);
    });
  });

  it('keeps ledger, events, amendments and decided days immutable', async () => {
    await scenario(async ({ tx, fx, svc, types, hr, self1 }) => {
      await grantMinutes(svc, fx, fx.assignmentDeptB, types.vacation.id, 2400);
      const leave = await svc.requests.submitOwn(
        fx.selfUser1,
        request(fx.assignmentDeptB, types.vacation.id, '2027-03-01'),
        self1,
      );
      await svc.requests.approve(fx.users.hr!, leave.requestId, {}, hr);
      const entry = await tx.leaveLedgerEntry.findFirstOrThrow({
        where: { leaveRequestId: leave.requestId },
      });
      const day = await tx.leaveRequestDay.findFirstOrThrow({
        where: { requestId: leave.requestId },
      });
      const event = await tx.leaveRequestEvent.findFirstOrThrow({
        where: { requestId: leave.requestId },
      });
      expect(
        await violation(tx, () =>
          tx.leaveLedgerEntry.update({
            where: { id: entry.id },
            data: { amountMinutes: -1 },
          }),
        ),
      ).toMatchObject({
        message: expect.stringContaining('LeaveLedgerEntry rows are immutable'),
      });
      expect(
        await violation(tx, () =>
          tx.leaveLedgerEntry.delete({ where: { id: entry.id } }),
        ),
      ).toMatchObject({ message: expect.stringContaining('immutable') });
      expect(
        await violation(tx, () =>
          tx.leaveRequestDay.update({
            where: { id: day.id },
            data: { minutes: 1 },
          }),
        ),
      ).toMatchObject({
        message: expect.stringContaining('decided request are immutable'),
      });
      expect(
        await violation(tx, () =>
          tx.leaveRequestDay.delete({ where: { id: day.id } }),
        ),
      ).toMatchObject({ message: expect.stringContaining('immutable') });
      expect(
        await violation(tx, () =>
          tx.leaveRequestEvent.delete({ where: { id: event.id } }),
        ),
      ).toMatchObject({ message: expect.stringContaining('immutable') });
      // A reversal must negate exactly, and only once.
      expect(
        await violation(tx, () =>
          tx.leaveLedgerEntry.create({
            data: {
              accountId: entry.accountId,
              employeeId: entry.employeeId,
              employmentAssignmentId: entry.employmentAssignmentId,
              leaveTypeId: entry.leaveTypeId,
              entryType: 'REVERSAL',
              amountMinutes: 100,
              effectiveDate: entry.effectiveDate,
              sourceType: 'MANUAL',
              reversesEntryId: entry.id,
              idempotencyKey: 'manual-bad-reversal',
              reason: 'x',
            },
          }),
        ),
      ).toMatchObject({ message: expect.stringContaining('exactly negate') });
      // Usage is reversed only by amending the leave.
      const viaLedger = await rejection(
        svc.ledger.reverse(entry.id, { reason: 'nope' }, hr),
      );
      expect(errorBody(viaLedger)).toMatchObject({
        code: 'LEAVE_USAGE_REVERSAL_VIA_AMENDMENT',
      });
      const grant = await tx.leaveLedgerEntry.findFirstOrThrow({
        where: { accountId: entry.accountId, entryType: 'ADJUSTMENT' },
      });
      await svc.ledger.reverse(grant.id, { reason: 'Entered twice' }, hr);
      const twice = await rejection(
        svc.ledger.reverse(grant.id, { reason: 'again' }, hr),
      );
      expect(errorBody(twice)).toMatchObject({
        code: 'LEAVE_ENTRY_ALREADY_REVERSED',
      });
      // Nobody adjusts their own balance.
      const own = await rejection(
        svc.ledger.adjust(
          {
            employmentAssignmentId: fx.otherTeamA,
            leaveTypeId: types.vacation.id,
            amountMinutes: 60,
            effectiveDate: '2027-01-01',
            reason: 'self',
          },
          ctx(fx.selfUser2),
        ),
      );
      expect(own).toBeInstanceOf(ForbiddenException);
    });
  });

  it('makes adjustments idempotent by client key', async () => {
    await scenario(async ({ tx, fx, svc, types, hr }) => {
      const body = {
        employmentAssignmentId: fx.assignmentTeamA,
        leaveTypeId: types.vacation.id,
        amountMinutes: 600,
        effectiveDate: '2027-01-01',
        reason: 'Opening balance',
        idempotencyKey: 'opening-2027-a1',
      };
      const first = await svc.ledger.adjust(body, hr);
      const second = await svc.ledger.adjust(body, hr);
      expect(first.created).toBe(true);
      expect(second).toMatchObject({
        created: false,
        entry: { id: first.entry.id },
      });
      expect(
        await tx.leaveLedgerEntry.count({
          where: { accountId: first.entry.accountId },
        }),
      ).toBe(1);
      // The same client key on another account is a conflict, not a silent no-op.
      const reused = await rejection(
        svc.ledger.adjust(
          { ...body, employmentAssignmentId: fx.assignmentDeptB },
          hr,
        ),
      );
      expect(errorBody(reused)).toMatchObject({
        code: 'LEAVE_IDEMPOTENCY_KEY_REUSED',
      });
      // Untracked leave types have no balance to adjust.
      await expect(
        svc.ledger.adjust(
          {
            ...body,
            leaveTypeId: types.personal.id,
            idempotencyKey: undefined,
          },
          hr,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── Time & Attendance integration ─────────────────────────────────────────

  it('re-interprets only the leave days of its assignment and never finalized time', async () => {
    await scenario(
      async ({ tx, fx, svc, clock, types, hr, self1, publishWeek }) => {
        const policy = await tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgA,
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            config: {
              clock: { mode: 'LIVE_CLOCK' },
              attendanceInterpretation: {
                mode: 'BASIC',
                lateArrivalEnabled: true,
                lateGraceMinutes: 5,
              },
            },
          },
        });
        await publishWeek([
          torontoShift(fx.assignmentTeamA, '2027-03-01', '09:00', '17:00'),
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
          torontoShift(fx.assignmentTeamA, '2027-03-03', '09:00', '17:00'),
        ]);
        const clockDay = async (date: string) => {
          clock.value = est(`${date}T10:30`);
          await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self1);
          clock.value = est(`${date}T17:00`);
          await svc.time.clockOut(fx.selfUser1, self1);
        };
        await clockDay('2027-03-01');
        await clockDay('2027-03-03');
        const openLate = async (date: string) =>
          tx.attendanceException.count({
            where: {
              employeeId: fx.employee1,
              type: 'LATE_ARRIVAL',
              status: 'OPEN',
              timeEntry: { workDate: new Date(`${date}T00:00:00.000Z`) },
            },
          });
        expect([
          await openLate('2027-03-01'),
          await openLate('2027-03-03'),
        ]).toEqual([1, 1]);
        // A later policy change would excuse the lateness if those days were re-interpreted.
        await tx.timeAttendancePolicy.update({
          where: { id: policy.id },
          data: {
            config: {
              clock: { mode: 'LIVE_CLOCK' },
              attendanceInterpretation: {
                mode: 'BASIC',
                lateArrivalEnabled: true,
                lateGraceMinutes: 120,
              },
            },
          },
        });
        // Wednesday's timesheet is approved: finalized time.
        const period = await tx.timePeriod.create({
          data: {
            organizationId: fx.orgA,
            startDate: new Date('2027-03-03T00:00:00.000Z'),
            endDate: new Date('2027-03-03T00:00:00.000Z'),
            status: 'OPEN',
            cadence: 'CUSTOM',
            openedAt: new Date(),
          },
        });
        await tx.timesheet.create({
          data: {
            employeeId: fx.employee1,
            timePeriodId: period.id,
            status: 'APPROVED',
            approvedAt: new Date(),
            approvedByUserId: fx.users.hr!,
          },
        });
        // Leave on Tuesday only: Monday (adjacent) and Wednesday (adjacent, finalized) keep theirs.
        const tuesday = await svc.requests.submitOwn(
          fx.selfUser1,
          request(fx.assignmentTeamA, types.personal.id, '2027-03-02'),
          self1,
        );
        await svc.requests.approve(fx.users.hr!, tuesday.requestId, {}, hr);
        expect([
          await openLate('2027-03-01'),
          await openLate('2027-03-03'),
        ]).toEqual([1, 1]);
        // Leave covering the finalized Wednesday morning leaves its interpretation alone too.
        const wednesday = await svc.requests.submitOwn(
          fx.selfUser1,
          request(
            fx.assignmentTeamA,
            types.personal.id,
            '2027-03-03',
            '2027-03-03',
            {
              startLocalTime: '09:00',
              endLocalTime: '11:00',
            },
          ),
          self1,
        );
        await svc.requests.approve(fx.users.hr!, wednesday.requestId, {}, hr);
        expect(await openLate('2027-03-03')).toBe(1);
        // Monday itself, once on leave, is re-interpreted (with the policy now in force).
        const monday = await svc.requests.submitOwn(
          fx.selfUser1,
          request(
            fx.assignmentTeamA,
            types.personal.id,
            '2027-03-01',
            '2027-03-01',
            {
              startLocalTime: '09:00',
              endLocalTime: '10:00',
            },
          ),
          self1,
        );
        await svc.requests.approve(fx.users.hr!, monday.requestId, {}, hr);
        expect(await openLate('2027-03-01')).toBe(0);
      },
    );
  });

  it('trims only the absent part of expected work and re-interprets on every decision', async () => {
    await scenario(
      async ({ tx, fx, svc, clock, types, hr, self1, publishWeek }) => {
        await tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'ORGANIZATION',
            organizationId: fx.orgA,
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            config: {
              clock: { mode: 'LIVE_CLOCK' },
              attendanceInterpretation: {
                mode: 'BASIC',
                lateArrivalEnabled: true,
                earlyDepartureEnabled: true,
                lateGraceMinutes: 5,
              },
            },
          },
        });
        await publishWeek([
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        ]);
        clock.value = est('2027-03-02T10:30');
        await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self1);
        const entry = await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1 },
        });
        const late = () =>
          tx.attendanceException.findMany({
            where: {
              timeEntryId: entry.id,
              type: 'LATE_ARRIVAL',
              status: 'OPEN',
            },
          });
        expect(await late()).toHaveLength(1);
        // A morning appointment 09:00–11:00, approved after the fact: 10:30 is no longer late.
        const appointment = await svc.requests.submitOwn(
          fx.selfUser1,
          request(
            fx.assignmentTeamA,
            types.personal.id,
            '2027-03-02',
            '2027-03-02',
            { startLocalTime: '09:00', endLocalTime: '11:00' },
          ),
          self1,
        );
        await svc.requests.approve(fx.users.hr!, appointment.requestId, {}, hr);
        expect(await late()).toHaveLength(0);
        // Leaving at 15:00 is still an early departure: only the morning was absent.
        clock.value = est('2027-03-02T15:00');
        await svc.time.clockOut(fx.selfUser1, self1);
        expect(
          await tx.attendanceException.count({
            where: {
              timeEntryId: entry.id,
              type: 'EARLY_DEPARTURE',
              status: 'OPEN',
            },
          }),
        ).toBe(1);
        // Cancelling the appointment re-interprets again: lateness returns.
        await svc.requests.amend(
          fx.users.hr!,
          appointment.requestId,
          { reason: 'Did not happen' },
          hr,
        );
        const back = await late();
        expect(back).toHaveLength(1);
        expect(back[0]!.metadata).toMatchObject({
          expectedAt: est('2027-03-02T09:00').toISOString(),
          varianceMinutes: 90,
        });
        // Leave never creates worked time or punches.
        expect(
          await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
        ).toBe(1);
        expect(
          await tx.timePunch.count({ where: { employeeId: fx.employee1 } }),
        ).toBe(2);
        // The absence source reports approved, uncancelled days only, with classification.
        const vacation = await svc.requests.createOnBehalf(
          fx.users.hr!,
          {
            ...request(fx.assignmentTeamA, types.personal.id, '2027-03-09'),
            approve: true,
          },
          hr,
        );
        const absences = await svc.absences.approvedAbsences({
          employeeId: fx.employee1,
          start: est('2027-03-01T00:00').toISOString(),
          end: est('2027-03-12T00:00').toISOString(),
        });
        // The cancelled appointment is gone; the approved 03-09 day remains.
        expect(absences).toEqual([
          expect.objectContaining({
            classification: 'UNPAID',
            employmentAssignmentId: fx.assignmentTeamA,
          }),
        ]);
        expect(vacation.status).toBe('APPROVED');
      },
    );
  });

  // ─── Read models ───────────────────────────────────────────────────────────

  it('serves coverage impact, a scoped queue, balances and the absence calendar', async () => {
    await scenario(
      async ({ fx, svc, types, hr, self1, self2, publishWeek }) => {
        const [tuesday] = await publishWeek([
          torontoShift(fx.assignmentTeamA, '2027-03-02', '09:00', '17:00'),
        ]);
        await grantMinutes(
          svc,
          fx,
          fx.assignmentTeamA,
          types.vacation.id,
          2400,
        );
        const teamA = await svc.requests.submitOwn(
          fx.selfUser1,
          request(fx.assignmentTeamA, types.vacation.id, '2027-03-02'),
          self1,
        );
        const deptB = await svc.requests.submitOwn(
          fx.selfUser1,
          request(fx.assignmentDeptB, types.personal.id, '2027-03-04'),
          self1,
        );
        await svc.requests.submitOwn(
          fx.selfUser2,
          request(fx.otherTeamA, types.personal.id, '2027-03-08'),
          self2,
        );
        const detail = await svc.views.requestDetail(
          fx.users.hr!,
          teamA.requestId,
        );
        expect(detail.coverage).toMatchObject({
          leaveRequestId: teamA.requestId,
          totalOverlapMinutes: 480,
          coveredShifts: [
            expect.objectContaining({
              scheduledShiftId: tuesday,
              overlapMinutes: 480,
            }),
          ],
        });
        expect(detail.actions).toEqual({
          canApprove: true,
          canReject: true,
          canAmend: false,
          canCancel: false,
        });
        // The team approver sees Team A only; Employee 2's own request is visible but not decidable by them.
        const queue = await svc.views.queue(fx.users.teamApprover!, {
          organizationId: fx.orgA,
          status: 'PENDING',
        });
        expect(queue.items.map((i) => i.id).sort()).toHaveLength(2);
        expect(queue.items.some((i) => i.id === deptB.requestId)).toBe(false);
        const ownQueue = await svc.views.queue(fx.selfUser2, {
          organizationId: fx.orgA,
          status: 'PENDING',
        });
        const ownRow = ownQueue.items.find(
          (i) => i.employee.id === fx.employee2,
        )!;
        expect(ownRow.actions.canApprove).toBe(false);
        expect(
          (
            await svc.views.queue(fx.users.outsider!, {
              organizationId: fx.orgA,
            })
          ).items,
        ).toEqual([]);
        // Dept B reader sees Dept B only.
        const deptBQueue = await svc.views.queue(fx.users.deptBReader!, {
          organizationId: fx.orgA,
        });
        expect(deptBQueue.items.map((i) => i.id)).toEqual([deptB.requestId]);
        expect(deptBQueue.items[0]!.actions.canApprove).toBe(false);
        await svc.requests.approve(fx.users.hr!, teamA.requestId, {}, hr);
        const calendar = await svc.views.calendar(fx.users.hr!, {
          organizationId: fx.orgA,
          from: '2027-03-01',
          to: '2027-03-10',
        });
        expect(calendar.entries.map((e) => e.requestId)).toEqual([
          teamA.requestId,
        ]);
        const withPending = await svc.views.calendar(fx.users.hr!, {
          organizationId: fx.orgA,
          from: '2027-03-01',
          to: '2027-03-10',
          includePending: true,
        });
        expect(withPending.entries).toHaveLength(3);
        expect(
          (
            await svc.views.calendar(fx.users.outsider!, {
              organizationId: fx.orgA,
              from: '2027-03-01',
              to: '2027-03-07',
            })
          ).entries,
        ).toEqual([]);
        await expect(
          svc.views.calendar(fx.users.hr!, {
            organizationId: fx.orgA,
            from: '2027-01-01',
            to: '2027-06-01',
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        const balances = await svc.views.balances(fx.users.hr!, {
          organizationId: fx.orgA,
          leaveTypeId: types.vacation.id,
        });
        expect(balances.items).toEqual([
          expect.objectContaining({
            employmentAssignmentId: fx.assignmentTeamA,
            balance: {
              currentMinutes: 2400,
              scheduledMinutes: 480,
              availableMinutes: 1920,
              pendingMinutes: 0,
            },
            actions: { canAdjust: true },
          }),
        ]);
        expect(
          (
            await svc.views.balances(fx.users.deptBReader!, {
              organizationId: fx.orgA,
            })
          ).items,
        ).toEqual([]);
        // The employee's own ledger is readable by them (never adjustable); out of scope it is hidden.
        const accountId = balances.items[0]!.accountId;
        expect(
          (await svc.ledger.ledger(fx.selfUser1, accountId)).actions.canAdjust,
        ).toBe(false);
        await expect(
          svc.ledger.ledger(fx.users.deptBReader!, accountId),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          svc.ledger.ledger(fx.users.outsider!, accountId),
        ).rejects.toBeInstanceOf(NotFoundException);
      },
    );
  });
  it('lists management organizations with backend-computed actions per scope', async () => {
    await scenario(async ({ fx, svc }) => {
      const hr = await svc.views.organizations(fx.users.hr!);
      expect(hr.items.map((o) => o.id)).toEqual([fx.orgA]);
      expect(hr.items[0]).toMatchObject({
        timezone: 'America/Toronto',
        actions: {
          canReadRequests: true,
          canApprove: true,
          canAdjust: true,
          canManageTypes: true,
          canManagePolicies: true,
          canReadHolidays: true,
          canManageHolidays: true,
        },
      });
      // A team-scoped approver reaches the organization without organization-level rights.
      const team = await svc.views.organizations(fx.users.teamApprover!);
      expect(team.items).toEqual([
        expect.objectContaining({
          id: fx.orgA,
          actions: expect.objectContaining({
            canReadRequests: true,
            canApprove: true,
            canAdjust: false,
            canManageTypes: false,
            // A team-scoped reader reads the holidays of its area (scoped list).
            canReadHolidays: true,
            canManageHolidays: false,
          }),
        }),
      ]);
      expect(
        (await svc.views.organizations(fx.users.outsider!)).items.map(
          (o) => o.id,
        ),
      ).toEqual([fx.orgB]);
      // leave.request alone opens no management view.
      expect((await svc.views.organizations(fx.selfUser1)).items).toEqual([]);
    });
  });
});
