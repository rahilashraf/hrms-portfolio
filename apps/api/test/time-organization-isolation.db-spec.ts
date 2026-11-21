import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
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
import {
  addOrganizationBAssignment,
  closedEntry,
} from './support/time-world.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/**
 * Batch 4B (decision D3; review findings O1 and O2) — organization isolation of timesheets.
 *
 * A timesheet belongs to one organization's time period, so it holds only that organization's
 * assignments: an employee working in two organizations has two timesheets, each with its own
 * segments, totals, payroll rows, finalization, exceptions and submission checks. These tests
 * invert the 4B defects pinned in Batch 4.0 (time-known-defects.db-spec.ts, now removed).
 */

const USERS = {
  /** Employee 1's own account; clocks in both organizations. */
  self1: [
    { permissions: ['time.clock'], scope: 'org' as const },
    { permissions: ['time.clock'], scope: 'orgB' as const },
  ],
  /** Time manager over all of Organization A. */
  managerA: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
  /** Time manager over all of Organization A and all of Organization B. */
  managerAB: [
    { permissions: TIME_PERMISSIONS, scope: 'org' as const },
    { permissions: TIME_PERMISSIONS, scope: 'orgB' as const },
  ],
  /** Time manager over Team A only (Employee 1's Dept B and Employee 2's positions are outside). */
  managerTeamA: [{ permissions: TIME_PERMISSIONS, scope: 'teamA' as const }],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  svc: ReturnType<typeof timeServices>;
  orgB: { assignmentId: string };
}

const responseOf = (error: unknown) =>
  (error as { getResponse?: () => unknown }).getResponse?.() as
    Record<string, unknown> | undefined;

interface ShapedSheet {
  id: string;
  status: string;
  segments: Array<{
    id: string;
    employmentAssignmentId: string;
    netWorkedMinutes: number;
  }>;
  totals: Record<string, unknown>;
}

describe('Timesheet organization isolation (Batch 4B, database)', () => {
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
            ...TIME_PERMISSIONS,
          ]);
          await seedTimePolicy(tx, fx.orgA);
          const orgB = await addOrganizationBAssignment(tx, fx);
          const clock = new FixedClock();
          const svc = timeServices(rollbackClient(tx), clock);
          await run({ tx, fx, clock, svc, orgB }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 90_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** Employee 1 clocks in and out through self-service at the given Toronto local times. */
  async function work(
    h: Harness,
    assignmentId: string,
    from: string,
    to: string,
  ) {
    h.clock.value = toronto(from);
    await h.svc.time.clockIn(h.fx.selfUser1, assignmentId, ctx(h.fx.selfUser1));
    h.clock.value = toronto(to);
    await h.svc.time.clockOut(h.fx.selfUser1, ctx(h.fx.selfUser1));
  }

  /** The week of 2027-03-01 (Monday) for an organization, and an employee's timesheet in it. */
  async function weeklySheet(
    h: Harness,
    organizationId: string,
    employeeId = h.fx.employee1,
    startDate = '2027-03-01',
  ) {
    await h.svc.time.generateTimePeriods(
      h.fx.users.managerAB!,
      { organizationId, startDate, cadence: 'WEEKLY' },
      ctx(h.fx.users.managerAB!),
    );
    const period = await h.tx.timePeriod.findFirstOrThrow({
      where: { organizationId, startDate: new Date(startDate) },
    });
    const sheet = await h.svc.time.materializeTimesheetForEmployeePeriod(
      employeeId,
      period.id,
    );
    return { period, sheetId: sheet.id };
  }

  async function submitAndApprove(h: Harness, sheetId: string) {
    h.clock.value = toronto('2027-03-08T09:00');
    await h.svc.time.submitTimesheet(
      h.fx.selfUser1,
      sheetId,
      ctx(h.fx.selfUser1),
    );
    const manager = h.fx.users.managerAB!;
    for (const segment of await h.tx.timesheetSegment.findMany({
      where: { timesheetId: sheetId },
    })) {
      await h.svc.time.approveTimesheetSegment(
        manager,
        segment.id,
        undefined,
        ctx(manager),
      );
    }
  }

  const own = async (h: Harness, sheetId: string) =>
    (await h.svc.time.selfTimesheet(
      h.fx.selfUser1,
      sheetId,
    )) as unknown as ShapedSheet;

  it('gives an employee working in two organizations one timesheet per organization, with its own segments, totals and payroll rows', async () => {
    await scenario(async (h) => {
      const { fx, orgB, svc } = h;
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      await work(h, orgB.assignmentId, '2027-03-03T13:00', '2027-03-03T17:00');
      const a = await weeklySheet(h, fx.orgA);
      const b = await weeklySheet(h, fx.orgB);

      // Each sheet holds only its organization's assignment (A: 180 min; B: 240 min).
      const segmentsOf = (sheetId: string) =>
        h.tx.timesheetSegment.findMany({
          where: { timesheetId: sheetId },
          select: { employmentAssignmentId: true, netWorkedMinutes: true },
        });
      expect(await segmentsOf(a.sheetId)).toEqual([
        { employmentAssignmentId: fx.assignmentTeamA, netWorkedMinutes: 180 },
      ]);
      expect(await segmentsOf(b.sheetId)).toEqual([
        { employmentAssignmentId: orgB.assignmentId, netWorkedMinutes: 240 },
      ]);
      expect((await own(h, a.sheetId)).totals).toMatchObject({
        grossMinutes: 180,
        netWorkedMinutes: 180,
      });
      expect((await own(h, b.sheetId)).totals).toMatchObject({
        grossMinutes: 240,
        netWorkedMinutes: 240,
      });

      // Approved separately, each payroll snapshot carries only its own assignment's dates.
      await submitAndApprove(h, a.sheetId);
      await submitAndApprove(h, b.sheetId);
      const payrollRows = async (sheetId: string) =>
        (
          (await h.tx.timesheet.findUniqueOrThrow({ where: { id: sheetId } }))
            .totals as {
            payrollWorkDates: Array<{
              employmentAssignmentId: string;
              workDate: string;
              approvedWorkedMinutes: number;
            }>;
          }
        ).payrollWorkDates.map((row) => [
          row.employmentAssignmentId,
          row.workDate,
          row.approvedWorkedMinutes,
        ]);
      expect(await payrollRows(a.sheetId)).toEqual([
        [fx.assignmentTeamA, '2027-03-02', 180],
      ]);
      expect(await payrollRows(b.sheetId)).toEqual([
        [orgB.assignmentId, '2027-03-03', 240],
      ]);
      // Payroll's timesheet fact (Time's contract) names only the period's organization.
      expect(
        (await svc.time.payrollTimesheet({
          employeeId: fx.employee1,
          timePeriodId: a.period.id,
        }))!.segments.map((segment) => segment.employmentAssignmentId),
      ).toEqual([fx.assignmentTeamA]);
    });
  });

  it('shows managers only their organization’s timesheets, and totals only of the segments they see', async () => {
    await scenario(async (h) => {
      const { fx, orgB, svc } = h;
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      await closedEntry(h.tx, {
        employeeId: fx.employee1,
        employmentAssignmentId: fx.assignmentDeptB,
        clockInAt: toronto('2027-03-02T13:00'),
        clockOutAt: toronto('2027-03-02T14:00'),
        workDate: '2027-03-02',
      });
      await work(h, orgB.assignmentId, '2027-03-03T13:00', '2027-03-03T17:00');
      const a = await weeklySheet(h, fx.orgA);
      const b = await weeklySheet(h, fx.orgB);
      const listed = async (userId: string) =>
        (
          (await svc.time.managementTimesheets(userId, { limit: 100 }))
            .items as unknown as ShapedSheet[]
        ).filter((item) => item.id === a.sheetId || item.id === b.sheetId);

      // Organization A's manager: A's sheet with both A segments (180 + 60), never B's sheet or
      // B's 240 minutes.
      const forA = await listed(fx.users.managerA!);
      expect(forA.map((item) => item.id)).toEqual([a.sheetId]);
      expect(forA[0]!.totals).toMatchObject({
        grossMinutes: 240,
        netWorkedMinutes: 240,
      });
      expect(forA[0]!.totals.limitedToShownSegments).toBeUndefined();

      // A Team A manager sees Team A's segment and totals of that segment only.
      const forTeam = await listed(fx.users.managerTeamA!);
      expect(forTeam[0]!.segments.map((s) => s.employmentAssignmentId)).toEqual(
        [fx.assignmentTeamA],
      );
      expect(forTeam[0]!.totals).toMatchObject({
        grossMinutes: 180,
        netWorkedMinutes: 180,
        limitedToShownSegments: true,
      });

      // The manager of both organizations sees both sheets, each with its own totals.
      const forBoth = await listed(fx.users.managerAB!);
      expect(
        Object.fromEntries(
          forBoth.map((item) => [item.id, item.totals.netWorkedMinutes]),
        ),
      ).toEqual({ [a.sheetId]: 240, [b.sheetId]: 240 });
    });
  });

  it('finalizes time only within its own organization (corrections and their boundaries)', async () => {
    await scenario(async (h) => {
      const { fx, orgB, svc } = h;
      const manager = fx.users.managerAB!;
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      await work(h, orgB.assignmentId, '2027-03-03T13:00', '2027-03-03T17:00');
      const a = await weeklySheet(h, fx.orgA);
      await submitAndApprove(h, a.sheetId);
      const entryOf = (assignmentId: string) =>
        h.tx.timeEntry.findFirstOrThrow({
          where: { employmentAssignmentId: assignmentId },
        });
      const correct = async (assignmentId: string, clockOutAt: string) =>
        svc.time.correctEntry(
          manager,
          (await entryOf(assignmentId)).id,
          { type: 'CHANGE_CLOCK_OUT', reason: 'Left later', clockOutAt },
          ctx(manager),
        );

      // Organization A's approved timesheet finalizes A's time only: B's time is corrected.
      await correct(orgB.assignmentId, '2027-03-03T18:00');
      expect((await entryOf(orgB.assignmentId)).clockOutAt).toEqual(
        toronto('2027-03-03T18:00'),
      );
      // A's own time is finalized, citing A's timesheet.
      expect(
        responseOf(
          await rejection(correct(fx.assignmentTeamA, '2027-03-02T13:00')),
        ),
      ).toMatchObject({ code: 'TIME_ENTRY_FINALIZED', timesheetId: a.sheetId });

      // Once Organization B's own timesheet is approved, B's time is finalized by it.
      const b = await weeklySheet(h, fx.orgB);
      await submitAndApprove(h, b.sheetId);
      expect(
        responseOf(
          await rejection(correct(orgB.assignmentId, '2027-03-03T19:00')),
        ),
      ).toMatchObject({ code: 'TIME_ENTRY_FINALIZED', timesheetId: b.sheetId });
    });
  });

  it('flags time recorded after approval against its own organization’s timesheet only (O1), and a reopen resolves only its own organization’s flags (O2)', async () => {
    await scenario(async (h) => {
      const { fx, orgB, svc, tx } = h;
      const manager = fx.users.managerAB!;
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      await work(h, orgB.assignmentId, '2027-03-03T13:00', '2027-03-03T17:00');
      const a = await weeklySheet(h, fx.orgA);
      const b = await weeklySheet(h, fx.orgB);
      await submitAndApprove(h, a.sheetId);
      const flags = () =>
        tx.attendanceException.findMany({
          where: { employeeId: fx.employee1, type: 'RECORDED_AFTER_APPROVAL' },
          select: {
            employmentAssignmentId: true,
            status: true,
            metadata: true,
          },
          orderBy: { detectedAt: 'asc' },
        });

      // O1: B time recorded while only A's timesheet is approved is not flagged (B's own
      // timesheet is still open); before 4B, A's approved sheet flagged it.
      await work(h, orgB.assignmentId, '2027-03-04T13:00', '2027-03-04T14:00');
      expect(await flags()).toEqual([]);

      // Approve B; then time recorded in each organization is flagged against its own sheet.
      await submitAndApprove(h, b.sheetId);
      await work(h, orgB.assignmentId, '2027-03-05T13:00', '2027-03-05T14:00');
      await work(h, fx.assignmentTeamA, '2027-03-05T09:00', '2027-03-05T10:00');
      const byAssignment = async () =>
        Object.fromEntries(
          (await flags()).map((flag) => [
            flag.employmentAssignmentId,
            [
              flag.status,
              (flag.metadata as { timesheetId: string }).timesheetId,
            ],
          ]),
        );
      expect(await byAssignment()).toEqual({
        [orgB.assignmentId]: ['OPEN', b.sheetId],
        [fx.assignmentTeamA]: ['OPEN', a.sheetId],
      });

      // O2: reopening A's timesheet resolves A's flag and leaves B's open.
      h.clock.value = toronto('2027-03-09T09:00');
      await svc.time.reopenTimesheet(
        manager,
        a.sheetId,
        'Review the late hours',
        ctx(manager),
      );
      expect(await byAssignment()).toEqual({
        [orgB.assignmentId]: ['OPEN', b.sheetId],
        [fx.assignmentTeamA]: ['RESOLVED', a.sheetId],
      });
      // And B's approved timesheet is untouched by A's reopen.
      expect(
        await tx.timesheet.findUniqueOrThrow({
          where: { id: b.sheetId },
          select: { status: true, version: true },
        }),
      ).toEqual({ status: 'APPROVED', version: 1 });
    });
  });

  it('checks submission against its own organization’s open time, exceptions and corrections', async () => {
    await scenario(async (h) => {
      const { fx, orgB, svc } = h;
      await work(h, fx.assignmentTeamA, '2027-03-02T09:00', '2027-03-02T12:00');
      const a = await weeklySheet(h, fx.orgA);
      const b = await weeklySheet(h, fx.orgB);
      // Employee 1 is still clocked in at Organization B (an open entry in the week).
      h.clock.value = toronto('2027-03-06T09:00');
      await svc.time.clockIn(
        fx.selfUser1,
        orgB.assignmentId,
        ctx(fx.selfUser1),
      );
      h.clock.value = toronto('2027-03-08T09:00');
      // A's submission isn't blocked by B's open time...
      await svc.time.submitTimesheet(
        fx.selfUser1,
        a.sheetId,
        ctx(fx.selfUser1),
      );
      // ...but B's is.
      expect(
        responseOf(
          await rejection(
            svc.time.submitTimesheet(
              fx.selfUser1,
              b.sheetId,
              ctx(fx.selfUser1),
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIMESHEET_OPEN_ENTRY' });
    });
  });

  it('pages management entries and timesheets so every readable record appears exactly once', async () => {
    await scenario(async (h) => {
      const { fx, svc, tx } = h;
      // Entries: readable (Team A) and unreadable (Employee 2's org-level position) interleaved,
      // most recent first: R U U R U U U R.
      const layout = [
        ['2027-03-08', true],
        ['2027-03-07', false],
        ['2027-03-06', false],
        ['2027-03-05', true],
        ['2027-03-04', false],
        ['2027-03-03', false],
        ['2027-03-02', false],
        ['2027-03-01', true],
      ] as const;
      for (const [day, readable] of layout) {
        await closedEntry(tx, {
          employeeId: readable ? fx.employee1 : fx.employee2,
          employmentAssignmentId: readable ? fx.assignmentTeamA : fx.orgLevel,
          clockInAt: toronto(`${day}T09:00`),
          clockOutAt: toronto(`${day}T10:00`),
          workDate: day,
        });
      }
      const follow = async (
        list: (afterId?: string) => Promise<{
          items: unknown[];
          nextAfterId: string | null;
        }>,
        key: (item: unknown) => string,
      ) => {
        const seen: string[] = [];
        let afterId: string | undefined;
        for (let page = 0; page < 20; page += 1) {
          const result = await list(afterId);
          seen.push(...result.items.map(key));
          if (!result.nextAfterId) break;
          afterId = result.nextAfterId;
        }
        return seen;
      };
      for (const limit of [1, 2]) {
        expect(
          await follow(
            (afterId) =>
              svc.time.managementEntries(fx.users.managerTeamA!, {
                limit,
                search: fx.suffix,
                ...(afterId ? { afterId } : {}),
              }),
            (item) => (item as { workDate: string }).workDate.slice(0, 10),
          ),
        ).toEqual(['2027-03-08', '2027-03-05', '2027-03-01']);
      }

      // Timesheets: four weeks; Employee 2 (unreadable) has one every week, Employee 1 (Team A)
      // only in weeks 1 and 4.
      const weeks = ['2027-04-26', '2027-04-19', '2027-04-12', '2027-04-05'];
      const readableSheets: string[] = [];
      for (const [index, week] of weeks.entries()) {
        if (index === 0 || index === 3) {
          await closedEntry(tx, {
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentTeamA,
            clockInAt: toronto(`${week}T11:00`),
            clockOutAt: toronto(`${week}T12:00`),
            workDate: week,
          });
        }
        await closedEntry(tx, {
          employeeId: fx.employee2,
          employmentAssignmentId: fx.orgLevel,
          clockInAt: toronto(`${week}T11:00`),
          clockOutAt: toronto(`${week}T12:00`),
          workDate: week,
        });
        const mine = await weeklySheet(h, fx.orgA, fx.employee1, week);
        await weeklySheet(h, fx.orgA, fx.employee2, week);
        if (index === 0 || index === 3) readableSheets.push(mine.sheetId);
      }
      expect(
        await follow(
          (afterId) =>
            svc.time.managementTimesheets(fx.users.managerTeamA!, {
              limit: 1,
              search: fx.suffix,
              ...(afterId ? { afterId } : {}),
            }),
          (item) => (item as { id: string }).id,
        ),
      ).toEqual(readableSheets);
    });
  });
});
