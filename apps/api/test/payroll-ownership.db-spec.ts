import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  d,
  FixedPayrollClock,
  payGroup,
  payrollServices,
  closeCompensation,
} from './support/payroll-fixtures.js';
import {
  compensation,
  failure,
  issueCodes,
  PAYROLL_WORLD_USERS,
  world,
  type World,
} from './support/payroll-world.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  afterPeriodEnd,
  FixedClock,
  seedTimePolicy,
  timeServices,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = PAYROLL_WORLD_USERS;

/**
 * Phase 10 hardening — an assignment's approved time, leave and salaried days are paid by the
 * pay group owning each date (the compensation effective on it), exactly once.
 *
 * The world: pay group PG, bi-weekly from 2026-10-04, pays Employee 1 hourly (24.50) on
 * assignmentTeamA and Employee 2 a 52,000 salary on otherTeamA. Employee 2's second assignment
 * (orgLevel) and the second pay group vary per case.
 */
async function secondGroup(
  w: World,
  cadence: 'BIWEEKLY' | 'MONTHLY',
): Promise<{ payGroupId: string; periodId: string }> {
  const group = await payGroup(w.tx, w.fx.orgA, `PG2-${w.fx.suffix}`);
  const anchor = cadence === 'MONTHLY' ? '2026-10-01' : '2026-10-04';
  await w.svc.calendars.createCalendar(
    {
      payGroupId: group.id,
      cadence,
      timezone: 'America/Toronto',
      anchorDate: anchor,
      payDateOffsetDays: 5,
      processingCutoffOffsetDays: 2,
      effectiveFrom: anchor,
    },
    w.admin,
  );
  await w.svc.calendars.generatePeriods(
    { payGroupId: group.id, throughDate: anchor },
    w.admin,
  );
  const period = await w.tx.payrollPeriod.findFirstOrThrow({
    where: { payGroupId: group.id },
  });
  return { payGroupId: group.id, periodId: period.id };
}

/** Clocks a shift (Toronto local hours) on an assignment. */
async function shift(
  w: World,
  time: ReturnType<typeof timeServices>['time'],
  clock: FixedClock,
  userId: string,
  assignmentId: string,
  date: string,
  hours: number,
) {
  clock.value = new Date(`${date}T13:00:00.000Z`); // 09:00 EDT
  await time.clockIn(userId, assignmentId, ctx(userId));
  clock.value = new Date(
    new Date(`${date}T13:00:00.000Z`).getTime() + hours * 3_600_000,
  );
  await time.clockOut(userId, ctx(userId));
}

/** Prepares, submits and approves an employee's timesheet of a payroll period's TimePeriod. */
async function approveSheet(
  w: World,
  time: ReturnType<typeof timeServices>['time'],
  clock: FixedClock,
  periodId: string,
  employeeId: string,
  userId: string,
) {
  await w.svc.timeOrchestration.materialize(periodId, w.admin);
  const period = await w.tx.payrollPeriod.findUniqueOrThrow({
    where: { id: periodId },
  });
  const sheet = await w.tx.timesheet.findFirstOrThrow({
    where: { employeeId, timePeriodId: period.timePeriodId },
    include: { segments: true },
  });
  afterPeriodEnd(clock, period.periodEnd);
  await time.submitTimesheet(userId, sheet.id, ctx(userId));
  for (const segment of sheet.segments) {
    await time.approveTimesheetSegment(
      w.fx.users.hr!,
      segment.id,
      undefined,
      ctx(w.fx.users.hr!),
    );
  }
  return w.tx.timesheet.findUniqueOrThrow({ where: { id: sheet.id } });
}

const paid = async (tx: Tx, runId: string) =>
  (
    await tx.payrollEarningLine.findMany({
      where: { payrollRunId: runId },
      include: { runAssignment: true },
      orderBy: [{ type: 'asc' }, { workDate: 'asc' }],
    })
  ).map((line) => [
    line.runAssignment.employmentAssignmentId,
    line.type,
    line.workDate ? line.workDate.toISOString().slice(0, 10) : null,
    line.amount.toFixed(2),
  ]);

const claims = async (tx: Tx, runId: string) =>
  (
    await tx.payrollSourceClaim.findMany({
      where: { payrollRunId: runId },
      orderBy: [{ employmentAssignmentId: 'asc' }, { workDate: 'asc' }],
    })
  ).map(
    (row) =>
      `${row.employmentAssignmentId}:${row.kind}:${row.workDate.toISOString().slice(0, 10)}`,
  );

describe('Payroll pay-group ownership (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (
      w: World,
      time: ReturnType<typeof timeServices>['time'],
      clock: FixedClock,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const svc = payrollServices(
            rollbackClient(tx),
            new FixedPayrollClock(),
          );
          const w = await world(tx, fx, svc);
          await seedTimePolicy(tx, fx.orgA);
          const clock = new FixedClock();
          const time = timeServices(rollbackClient(tx), clock).time;
          await run(w, time, clock).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 180_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('A: pays two assignments of one employee in the same pay group once each', async () => {
    await scenario(async (w, time, clock) => {
      const { tx, fx, svc, admin, periodId, payGroupId } = w;
      await compensation(tx, fx, fx.orgLevel, {
        payBasis: 'HOURLY',
        rateAmount: '20',
        payGroupId,
      });
      await shift(w, time, clock, fx.selfUser2, fx.orgLevel, '2026-10-06', 8);
      await approveSheet(w, time, clock, periodId, fx.employee2, fx.selfUser2);
      const run = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);
      expect(await paid(tx, run.id)).toEqual([
        [fx.orgLevel, 'REGULAR_HOURLY', '2026-10-06', '160.00'],
        [fx.otherTeamA, 'REGULAR_SALARY', null, '2000.00'],
      ]);
      const employee = await tx.payrollRunEmployee.findFirstOrThrow({
        where: { payrollRunId: run.id, employeeId: fx.employee2 },
        include: { assignments: true },
      });
      expect(employee.assignments).toHaveLength(2);
      expect(employee.grossAmount.toFixed(2)).toBe('2160.00');
      expect(
        (await claims(tx, run.id)).filter((key) => key.startsWith(fx.orgLevel)),
      ).toEqual([`${fx.orgLevel}:WORKED_TIME:2026-10-06`]);
    });
  });

  it('B: same-dated pay groups share a TimePeriod but each pays only its own assignments', async () => {
    await scenario(async (w, time, clock) => {
      const { tx, fx, svc, admin, periodId } = w;
      const second = await secondGroup(w, 'BIWEEKLY');
      const [first, other] = await Promise.all([
        tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId } }),
        tx.payrollPeriod.findUniqueOrThrow({ where: { id: second.periodId } }),
      ]);
      expect(other.timePeriodId).toBe(first.timePeriodId);
      await compensation(tx, fx, fx.orgLevel, {
        payBasis: 'HOURLY',
        rateAmount: '20',
        payGroupId: second.payGroupId,
      });
      await shift(w, time, clock, fx.selfUser2, fx.orgLevel, '2026-10-06', 8);
      await approveSheet(w, time, clock, periodId, fx.employee2, fx.selfUser2);
      const run1 = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      const run2 = await svc.runs.createRun(
        { payrollPeriodId: second.periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run1.id, admin);
      await svc.runs.calculate(run2.id, admin);
      expect(await paid(tx, run1.id)).toEqual([
        [fx.otherTeamA, 'REGULAR_SALARY', null, '2000.00'],
      ]);
      expect(await paid(tx, run2.id)).toEqual([
        [fx.orgLevel, 'REGULAR_HOURLY', '2026-10-06', '160.00'],
      ]);
    });
  });

  it('C: different cadences pay each assignment only from its own pay group period', async () => {
    await scenario(async (w, time, clock) => {
      const { tx, fx, svc, admin, periodId } = w;
      const monthly = await secondGroup(w, 'MONTHLY');
      await compensation(tx, fx, fx.orgLevel, {
        payBasis: 'HOURLY',
        rateAmount: '20',
        payGroupId: monthly.payGroupId,
      });
      await shift(w, time, clock, fx.selfUser2, fx.orgLevel, '2026-10-02', 4);
      await shift(w, time, clock, fx.selfUser2, fx.orgLevel, '2026-10-06', 8);
      await shift(
        w,
        time,
        clock,
        fx.selfUser1,
        fx.assignmentTeamA,
        '2026-10-06',
        8,
      );
      // Both TimePeriods hold Employee 2's Oct 6 time: it is approved in both timesheets.
      const biweeklySheet = await approveSheet(
        w,
        time,
        clock,
        periodId,
        fx.employee2,
        fx.selfUser2,
      );
      const monthlySheet = await approveSheet(
        w,
        time,
        clock,
        monthly.periodId,
        fx.employee2,
        fx.selfUser2,
      );
      expect(biweeklySheet.timePeriodId).not.toBe(monthlySheet.timePeriodId);
      for (const sheet of [biweeklySheet, monthlySheet]) {
        const outputs = (
          sheet.totals as { payrollWorkDates: Array<{ workDate: string }> }
        ).payrollWorkDates;
        expect(outputs.map((output) => output.workDate)).toContain(
          '2026-10-06',
        );
      }
      await approveSheet(w, time, clock, periodId, fx.employee1, fx.selfUser1);

      const biweekly = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      const month = await svc.runs.createRun(
        { payrollPeriodId: monthly.periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(biweekly.id, admin);
      await svc.runs.calculate(month.id, admin);
      expect(await paid(tx, biweekly.id)).toEqual([
        [fx.assignmentTeamA, 'REGULAR_HOURLY', '2026-10-06', '196.00'],
        [fx.otherTeamA, 'REGULAR_SALARY', null, '2000.00'],
      ]);
      expect(await paid(tx, month.id)).toEqual([
        [fx.orgLevel, 'REGULAR_HOURLY', '2026-10-02', '80.00'],
        [fx.orgLevel, 'REGULAR_HOURLY', '2026-10-06', '160.00'],
      ]);
      expect(await issueCodes(tx, biweekly.id)).not.toContain(
        'ERROR:PAYROLL_SOURCE_ALREADY_CONSUMED',
      );
    });
  });

  it('D–G: a mid-period pay-group change splits dates; finalized sources are never paid twice', async () => {
    await scenario(async (w, time, clock) => {
      const { tx, fx, svc, admin, periodId, payGroupId } = w;
      const monthly = await secondGroup(w, 'MONTHLY');
      // D: Employee 1 moves from PG (bi-weekly) to the monthly pay group on Oct 11.
      const original = await tx.compensationRecord.findFirstOrThrow({
        where: { employmentAssignmentId: fx.assignmentTeamA },
      });
      await closeCompensation(tx, original.id, d('2026-10-10'), fx.users.hr!);
      const moved = await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.assignmentTeamA,
          organizationId: fx.orgA,
          recordType: 'CHANGE',
          payBasis: 'HOURLY',
          rateAmount: '30',
          currency: 'CAD',
          effectiveFrom: d('2026-10-11'),
          payGroupId: monthly.payGroupId,
        },
      });
      await shift(
        w,
        time,
        clock,
        fx.selfUser1,
        fx.assignmentTeamA,
        '2026-10-06',
        8,
      );
      await shift(
        w,
        time,
        clock,
        fx.selfUser1,
        fx.assignmentTeamA,
        '2026-10-13',
        4,
      );
      await approveSheet(w, time, clock, periodId, fx.employee1, fx.selfUser1);
      await approveSheet(
        w,
        time,
        clock,
        monthly.periodId,
        fx.employee1,
        fx.selfUser1,
      );

      const biweekly = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      const month = await svc.runs.createRun(
        { payrollPeriodId: monthly.periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(biweekly.id, admin);
      await svc.runs.calculate(month.id, admin);
      const employee1Lines = (rows: unknown[][]) =>
        rows.filter((row) => row[0] === fx.assignmentTeamA);
      expect(employee1Lines(await paid(tx, biweekly.id))).toEqual([
        [fx.assignmentTeamA, 'REGULAR_HOURLY', '2026-10-06', '196.00'],
      ]);
      expect(employee1Lines(await paid(tx, month.id))).toEqual([
        [fx.assignmentTeamA, 'REGULAR_HOURLY', '2026-10-13', '120.00'],
      ]);
      expect(await issueCodes(tx, biweekly.id, fx.employee1)).toContain(
        'WARNING:PAY_GROUP_CHANGE_IN_PERIOD',
      );

      // Explainable from the run's own snapshots: the line points at the PG record, and the
      // snapshots show the monthly record taking over on Oct 11.
      const line = await tx.payrollEarningLine.findFirstOrThrow({
        where: { payrollRunId: biweekly.id, type: 'REGULAR_HOURLY' },
        include: { compensationSnapshot: true, timeSnapshot: true },
      });
      expect(line.compensationSnapshot).toMatchObject({
        compensationRecordId: original.id,
        payGroupId,
      });
      const snapshots = await tx.payrollCompensationSnapshot.findMany({
        where: {
          payrollRunId: biweekly.id,
          compensationRecordId: { in: [original.id, moved.id] },
        },
      });
      expect(
        snapshots
          .map((row) => row.payGroupId)
          .sort((a, b) => String(a).localeCompare(String(b))),
      ).toEqual(
        [payGroupId, monthly.payGroupId].sort((a, b) => a.localeCompare(b)),
      );
      expect(
        await tx.payrollTimeSnapshot.count({
          where: {
            payrollRunId: biweekly.id,
            runAssignment: { employmentAssignmentId: fx.assignmentTeamA },
          },
        }),
      ).toBe(1);

      // G: recalculating the same run replaces its own claims, never a false conflict.
      const before = await claims(tx, biweekly.id);
      await svc.runs.calculate(biweekly.id, admin);
      expect(await claims(tx, biweekly.id)).toEqual(before);
      expect(await issueCodes(tx, biweekly.id)).not.toContain(
        'ERROR:PAYROLL_SOURCE_ALREADY_CONSUMED',
      );

      // E: the bi-weekly run is finalized. A retroactive correction then moves Oct 6 to the
      // monthly pay group: the monthly run must not pay that source a second time.
      await svc.lifecycle.approve(biweekly.id, ctx(fx.users.approver!));
      await svc.lifecycle.finalize(biweekly.id, ctx(fx.users.finalizer!));
      const finalizedLines = await paid(tx, biweekly.id);
      await closeCompensation(tx, original.id, d('2026-10-05'), fx.users.hr!);
      await tx.compensationRecord.update({
        where: { id: moved.id },
        data: { supersededAt: new Date() },
      });
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.assignmentTeamA,
          organizationId: fx.orgA,
          recordType: 'CORRECTION',
          payBasis: 'HOURLY',
          rateAmount: '30',
          currency: 'CAD',
          effectiveFrom: d('2026-10-06'),
          payGroupId: monthly.payGroupId,
          supersedesRecordId: moved.id,
          reason: 'Transfer was effective earlier',
        },
      });
      await svc.runs.calculate(month.id, admin);
      expect(await issueCodes(tx, month.id, fx.employee1)).toContain(
        'ERROR:PAYROLL_SOURCE_ALREADY_CONSUMED',
      );
      const conflict = await tx.payrollValidationIssue.findFirstOrThrow({
        where: {
          payrollRunId: month.id,
          code: 'PAYROLL_SOURCE_ALREADY_CONSUMED',
        },
      });
      expect(conflict.metadata).toMatchObject({
        conflicts: [
          {
            kind: 'WORKED_TIME',
            workDate: '2026-10-06',
            payrollRunId: biweekly.id,
            payrollRunStatus: 'FINALIZED',
          },
        ],
      });
      expect(employee1Lines(await paid(tx, month.id))).toEqual([]);
      expect(
        await failure(svc.lifecycle.approve(month.id, ctx(fx.users.approver!))),
      ).toEqual({ status: 409, code: 'PAYROLL_RUN_HAS_ERRORS' });
      // The database refuses a second claim on the finalized source outright.
      const target = await tx.payrollRunAssignment.findFirstOrThrow({
        where: {
          payrollRunId: month.id,
          employmentAssignmentId: fx.assignmentTeamA,
        },
      });
      await violation(tx, () =>
        tx.payrollSourceClaim.create({
          data: {
            payrollRunId: month.id,
            payrollRunAssignmentId: target.id,
            employmentAssignmentId: fx.assignmentTeamA,
            kind: 'WORKED_TIME',
            workDate: d('2026-10-06'),
          },
        }),
      );
      await violation(tx, () =>
        tx.payrollSourceClaim.deleteMany({
          where: { payrollRunId: biweekly.id },
        }),
      );

      // F: the finalized run is unchanged; the difference shows as a retroactive correction.
      expect(await paid(tx, biweekly.id)).toEqual(finalizedLines);
      const preview = await svc.adjustments.retroPreview(
        biweekly.id,
        fx.users.payrollReader!,
      );
      expect(
        preview.items.find(
          (item) => item.employmentAssignmentId === fx.assignmentTeamA,
        ),
      ).toMatchObject({
        finalizedGross: '196.00',
        blocked: true,
        blockingCodes: ['PAY_GROUP_OWNERSHIP_CHANGED'],
        difference: '0.00',
      });
      expect(
        (
          await svc.adjustments.createRetroAdjustments(
            biweekly.id,
            'Transfer correction',
            admin,
          )
        ).blocked,
      ).toContain(fx.assignmentTeamA);
    });
  });

  it('releases a voided run sources to the run that replaces it', async () => {
    await scenario(async (w) => {
      const { tx, svc, admin, periodId } = w;
      const run = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);
      const held = await claims(tx, run.id);
      expect(held.length).toBe(14); // Employee 2's salaried days
      await svc.lifecycle.void(run.id, 'Wrong setup', admin);
      expect(await claims(tx, run.id)).toEqual([]);
      const again = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(again.id, admin);
      expect(await claims(tx, again.id)).toEqual(held);
    });
  });
});

describe('Payroll duplicate-pay race (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let w: World;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, USERS),
      { timeout: 60_000 },
    );
    const svc = payrollServices(prisma, new FixedPayrollClock());
    w = await world(prisma as unknown as Tx, fx, svc);
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  it('never lets two runs claim, approve or finalize the same salaried days', async () => {
    const client = prisma as unknown as Tx;
    const monthly = await secondGroup({ ...w, tx: client }, 'MONTHLY');
    const biweekly = await w.svc.runs.createRun(
      { payrollPeriodId: w.periodId, currency: 'CAD' },
      w.admin,
    );
    await w.svc.runs.calculate(biweekly.id, w.admin); // claims Oct 4–17 for Employee 2

    // Employee 2's salary moves to the monthly pay group from Oct 11 (a correction).
    const original = await prisma.compensationRecord.findFirstOrThrow({
      where: { employmentAssignmentId: fx.otherTeamA },
    });
    await closeCompensation(prisma, original.id, d('2026-10-10'), fx.users.hr!);
    await prisma.compensationRecord.create({
      data: {
        employmentAssignmentId: fx.otherTeamA,
        organizationId: fx.orgA,
        recordType: 'CHANGE',
        payBasis: 'SALARY',
        rateAmount: '52000',
        currency: 'CAD',
        effectiveFrom: d('2026-10-11'),
        payGroupId: monthly.payGroupId,
      },
    });
    const month = await w.svc.runs.createRun(
      { payrollPeriodId: monthly.periodId, currency: 'CAD' },
      w.admin,
    );
    // Concurrently: the bi-weekly run gives up Oct 11–17 while the monthly run claims them.
    await Promise.all([
      w.svc.runs.calculate(biweekly.id, w.admin),
      w.svc.runs.calculate(month.id, w.admin),
    ]);
    // Whatever the order, the monthly run either paid Oct 11–31 or is blocked; recalculating
    // after the bi-weekly run released them always succeeds.
    await w.svc.runs.calculate(month.id, w.admin);
    const rows = await prisma.payrollSourceClaim.findMany({
      where: {
        employmentAssignmentId: fx.otherTeamA,
        payrollRunId: { in: [biweekly.id, month.id] },
      },
    });
    const dates = rows.map((row) => row.workDate.toISOString().slice(0, 10));
    expect(new Set(dates).size).toBe(dates.length);
    expect(rows.filter((row) => row.payrollRunId === biweekly.id)).toHaveLength(
      7,
    );
    expect(rows.filter((row) => row.payrollRunId === month.id)).toHaveLength(
      21,
    );

    // Both approve and finalize concurrently; together they pay each salaried day once.
    await Promise.all([
      w.svc.lifecycle.approve(biweekly.id, ctx(fx.users.approver!)),
      w.svc.lifecycle.approve(month.id, ctx(fx.users.approver!)),
    ]);
    await Promise.all([
      w.svc.lifecycle.finalize(biweekly.id, ctx(fx.users.finalizer!)),
      w.svc.lifecycle.finalize(month.id, ctx(fx.users.finalizer!)),
    ]);
    const salary = await prisma.payrollEarningLine.findMany({
      where: {
        payrollRunId: { in: [biweekly.id, month.id] },
        type: 'REGULAR_SALARY',
        runAssignment: { employmentAssignmentId: fx.otherTeamA },
      },
    });
    expect(
      salary.map((line) => [line.quantity?.toString(), line.amount.toFixed(2)]),
    ).toEqual(
      expect.arrayContaining([
        ['7', '1000.00'],
        ['21', '2935.48'],
      ]),
    );
    // A finalized source can never be claimed again, even directly.
    const target = await prisma.payrollRunAssignment.findFirstOrThrow({
      where: {
        payrollRunId: biweekly.id,
        employmentAssignmentId: fx.otherTeamA,
      },
    });
    await expect(
      prisma.payrollSourceClaim.create({
        data: {
          payrollRunId: biweekly.id,
          payrollRunAssignmentId: target.id,
          employmentAssignmentId: fx.otherTeamA,
          kind: 'SALARY_DAY',
          workDate: d('2026-10-05'),
        },
      }),
    ).rejects.toThrow();
  });
});
