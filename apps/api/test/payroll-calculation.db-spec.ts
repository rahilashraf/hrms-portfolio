import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  grantMinutes,
  leaveServices,
  seedLeaveConfig,
} from './support/leave-fixtures.js';
import {
  d,
  FixedPayrollClock,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
  compensation,
  failure,
  issueCodes,
  lines,
  PAYROLL_WORLD_USERS,
  world,
  type World,
} from './support/payroll-world.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rollbackClient,
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

describe('Payroll calculation (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(run: (w: World) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const svc = payrollServices(
            rollbackClient(tx),
            new FixedPayrollClock(),
          );
          await run(await world(tx, fx, svc)).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('pays hourly time only once approved, from the frozen timesheet, with snapshots', async () => {
    await scenario(async ({ tx, fx, svc, admin, periodId }) => {
      await seedTimePolicy(tx, fx.orgA);
      const clock = new FixedClock();
      const time = timeServices(rollbackClient(tx), clock).time;
      clock.value = new Date('2026-10-05T13:00:00.000Z'); // 09:00 EDT
      await time.clockIn(fx.selfUser1, fx.assignmentTeamA, ctx(fx.selfUser1));
      clock.value = new Date('2026-10-05T21:00:00.000Z'); // 17:00 EDT
      await time.clockOut(fx.selfUser1, ctx(fx.selfUser1));
      await svc.timeOrchestration.materialize(periodId, admin);
      const run = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'cad' },
        admin,
      );
      expect(run).toMatchObject({ status: 'DRAFT', currency: 'CAD' });
      expect(
        (await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId } }))
          .status,
      ).toBe('PROCESSING');

      // Not yet approved: blocked for employee 1, never guessed; the salaried employee is paid.
      await svc.runs.calculate(run.id, admin);
      expect(await issueCodes(tx, run.id, fx.employee1)).toContain(
        'ERROR:TIMESHEET_NOT_FINAL',
      );
      expect(await lines(tx, run.id, fx.employee1)).toEqual([]);
      expect(
        (await lines(tx, run.id, fx.employee2)).map((l) => [
          l.type,
          l.amount.toFixed(2),
        ]),
      ).toEqual([['REGULAR_SALARY', '2000.00']]);
      expect(await issueCodes(tx, run.id)).toContain(
        'INFO:NET_PAY_NOT_CALCULATED',
      );

      // Approve the time, recalculate: paid from the frozen approved minutes.
      const sheet = await tx.timesheet.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
        include: { segments: true },
      });
      afterPeriodEnd(
        clock,
        (await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId } }))
          .periodEnd,
      );
      await time.submitTimesheet(fx.selfUser1, sheet.id, ctx(fx.selfUser1));
      await time.approveTimesheetSegment(
        fx.users.hr!,
        sheet.segments[0]!.id,
        undefined,
        ctx(fx.users.hr!),
      );
      await svc.runs.calculate(run.id, admin);
      const hourly = await lines(tx, run.id, fx.employee1);
      expect(
        hourly.map((l) => [
          l.type,
          l.workDate?.toISOString().slice(0, 10),
          l.quantity?.toString(),
          l.rateAmount?.toFixed(4),
          l.amount.toFixed(2),
        ]),
      ).toEqual([['REGULAR_HOURLY', '2026-10-05', '480', '24.5000', '196.00']]);
      expect(hourly[0]!.timeSnapshot).toMatchObject({
        timesheetId: sheet.id,
        timesheetVersion: 1,
        finalizationStatus: 'APPROVED',
        approvedWorkedMinutes: 480,
      });
      expect(hourly[0]!.compensationSnapshot).toMatchObject({
        payBasis: 'HOURLY',
        currency: 'CAD',
      });
      const stored = await tx.payrollRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(stored).toMatchObject({
        status: 'CALCULATED',
        calculationVersion: 'PAYROLL_GROSS_V1',
        statutoryStatus: 'NOT_CALCULATED',
      });
      expect(stored.grossAmount?.toFixed(2)).toBe('2196.00');
      expect(
        await tx.auditLog.count({
          where: { entityId: run.id, action: 'PAYROLL_RUN_RECALCULATED' },
        }),
      ).toBe(1);
      const detail = await svc.reads.run(fx.users.payrollAdmin!, run.id);
      expect(detail.totals).toMatchObject({
        grossAmount: '2196.00',
        netAmount: null,
        netStatus: 'STATUTORY_NOT_CALCULATED',
      });

      // Reopening the timesheet changes the sources: the run is stale until recalculated.
      expect(
        await svc.runs.freshness(run.id, fx.users.payrollReader!),
      ).toMatchObject({ stale: false });
      await time.reopenTimesheet(
        fx.users.hr!,
        sheet.id,
        'Fix a punch',
        ctx(fx.users.hr!),
      );
      const stale = await svc.runs.freshness(run.id, fx.users.payrollReader!);
      expect(stale).toMatchObject({ stale: true });
      expect(stale.changedAssignmentIds).toEqual([fx.assignmentTeamA]);
      await svc.runs.calculate(run.id, admin);
      expect(
        await svc.runs.freshness(run.id, fx.users.payrollReader!),
      ).toMatchObject({ stale: false });
      expect(await issueCodes(tx, run.id, fx.employee1)).toContain(
        'ERROR:TIMESHEET_NOT_FINAL',
      );
    });
  });

  it('pays one multi-assignment interval once, to its payroll owner only', async () => {
    await scenario(async ({ tx, fx, svc, admin, periodId, payGroupId }) => {
      await seedTimePolicy(tx, fx.orgA);
      // Dept B is also hourly in the pay group (at another rate): covering it must not pay it.
      await compensation(tx, fx, fx.assignmentDeptB, {
        payBasis: 'HOURLY',
        rateAmount: '30',
        payGroupId,
      });
      const clock = new FixedClock();
      const time = timeServices(rollbackClient(tx), clock).time;
      // 09:00–15:00 EDT: employee 1 (hourly) covers Team A + Dept B, employee 2 (salaried)
      // covers its two assignments.
      clock.value = new Date('2026-10-05T13:00:00.000Z');
      await time.clockIn(
        fx.selfUser1,
        fx.assignmentTeamA,
        ctx(fx.selfUser1),
        undefined,
        [fx.assignmentDeptB],
      );
      await time.clockIn(
        fx.selfUser2,
        fx.otherTeamA,
        ctx(fx.selfUser2),
        undefined,
        [fx.orgLevel],
      );
      clock.value = new Date('2026-10-05T19:00:00.000Z');
      await time.clockOut(fx.selfUser1, ctx(fx.selfUser1));
      await time.clockOut(fx.selfUser2, ctx(fx.selfUser2));
      await svc.timeOrchestration.materialize(periodId, admin);
      for (const [employeeId, user] of [
        [fx.employee1, fx.selfUser1],
        [fx.employee2, fx.selfUser2],
      ] as const) {
        const sheet = await tx.timesheet.findFirstOrThrow({
          where: { employeeId },
          include: { segments: true },
        });
        // One segment: the payroll owner's, with the 360 minutes once.
        expect(sheet.segments.map((s) => s.netWorkedMinutes)).toEqual([360]);
        afterPeriodEnd(
          clock,
          (
            await tx.payrollPeriod.findUniqueOrThrow({
              where: { id: periodId },
            })
          ).periodEnd,
        );
        await time.submitTimesheet(user, sheet.id, ctx(user));
        await time.approveTimesheetSegment(
          fx.users.hr!,
          sheet.segments[0]!.id,
          undefined,
          ctx(fx.users.hr!),
        );
      }
      const run = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'cad' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);

      // Hourly: 360 minutes once, at the owner's rate; nothing for the covered Dept B.
      const hourly = await lines(tx, run.id, fx.employee1);
      expect(
        hourly.map((l) => [
          l.type,
          l.workDate?.toISOString().slice(0, 10),
          l.quantity?.toString(),
          l.rateAmount?.toFixed(4),
          l.amount.toFixed(2),
        ]),
      ).toEqual([['REGULAR_HOURLY', '2026-10-05', '360', '24.5000', '147.00']]);
      const claims = await tx.payrollSourceClaim.findMany({
        where: { payrollRunId: run.id, kind: 'WORKED_TIME' },
      });
      expect(claims.map((c) => c.employmentAssignmentId)).toEqual([
        fx.assignmentTeamA,
      ]);
      // Salaried: covering a second assignment never duplicates the salary.
      expect(
        (await lines(tx, run.id, fx.employee2)).map((l) => [
          l.type,
          l.amount.toFixed(2),
        ]),
      ).toEqual([['REGULAR_SALARY', '2000.00']]);
    });
  });

  it('pays hourly paid leave, and blocks unpaid salaried leave until a rule is configured', async () => {
    await scenario(async ({ tx, fx, svc, admin, periodId, calendarId }) => {
      const leave = leaveServices(rollbackClient(tx));
      const types = await seedLeaveConfig(tx, fx, leave);
      await grantMinutes(
        leave,
        fx,
        fx.assignmentTeamA,
        types.vacation.id,
        4800,
      );
      const vacation = await leave.requests.submitOwn(
        fx.selfUser1,
        {
          employmentAssignmentId: fx.assignmentTeamA,
          leaveTypeId: types.vacation.id,
          startDate: '2026-10-06',
          endDate: '2026-10-06',
        },
        ctx(fx.selfUser1),
      );
      await leave.requests.approve(
        fx.users.hr!,
        vacation.requestId,
        {},
        ctx(fx.users.hr!),
      );
      const personal = await leave.requests.submitOwn(
        fx.selfUser2,
        {
          employmentAssignmentId: fx.otherTeamA,
          leaveTypeId: types.personal.id,
          startDate: '2026-10-07',
          endDate: '2026-10-07',
        },
        ctx(fx.selfUser2),
      );
      await leave.requests.approve(
        fx.users.hr!,
        personal.requestId,
        {},
        ctx(fx.users.hr!),
      );
      const paidDay = await tx.leaveRequestDay.findFirstOrThrow({
        where: { requestId: vacation.requestId },
      });
      const unpaidDay = await tx.leaveRequestDay.findFirstOrThrow({
        where: { requestId: personal.requestId },
      });
      expect(paidDay.minutes).toBeGreaterThan(0);

      const run = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);
      const paid = await lines(tx, run.id, fx.employee1);
      const expected = ((paidDay.minutes * 24.5) / 60).toFixed(2);
      expect(paid.map((l) => [l.type, l.amount.toFixed(2)])).toEqual([
        ['PAID_LEAVE', expected],
      ]);
      expect(paid[0]!.leaveSnapshot).toMatchObject({
        leaveRequestDayId: paidDay.id,
        classification: 'PAID',
        minutes: paidDay.minutes,
      });
      expect(await issueCodes(tx, run.id, fx.employee2)).toContain(
        'ERROR:SALARY_UNPAID_LEAVE_REQUIRES_RULE',
      );
      expect(await lines(tx, run.id, fx.employee2)).toEqual([]);

      // The explicit rule: unpaid minutes at the salary's hourly equivalent.
      await svc.calendars.setSalaryUnpaidLeaveRule(
        calendarId,
        { rule: 'HOURLY_EQUIVALENT', standardAnnualHours: '2080' },
        admin,
      );
      expect(
        await svc.runs.freshness(run.id, fx.users.payrollAdmin!),
      ).toMatchObject({ stale: true });
      await svc.runs.calculate(run.id, admin);
      const reduction = -((unpaidDay.minutes * 25) / 60);
      expect(
        (await lines(tx, run.id, fx.employee2)).map((l) => [
          l.type,
          l.amount.toFixed(2),
        ]),
      ).toEqual([
        ['REGULAR_SALARY', '2000.00'],
        ['UNPAID_LEAVE_REDUCTION', reduction.toFixed(2)],
      ]);
      expect(
        (await tx.payrollRun.findUniqueOrThrow({ where: { id: run.id } }))
          .salaryUnpaidLeaveRule,
      ).toBe('HOURLY_EQUIVALENT');
      // The blocking error is gone once the rule applies.
      expect(await issueCodes(tx, run.id, fx.employee2)).not.toContain(
        'ERROR:SALARY_UNPAID_LEAVE_REQUIRES_RULE',
      );
    });
  });

  it('lets only payroll managers set the unpaid leave rule, with valid standard hours', async () => {
    await scenario(async ({ tx, fx, svc, admin, calendarId }) => {
      expect(
        await failure(
          svc.calendars.setSalaryUnpaidLeaveRule(
            calendarId,
            { rule: 'HOURLY_EQUIVALENT', standardAnnualHours: '2080' },
            ctx(fx.users.payrollReader!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      for (const standardAnnualHours of ['0', '9000', null]) {
        expect(
          await failure(
            svc.calendars.setSalaryUnpaidLeaveRule(
              calendarId,
              { rule: 'HOURLY_EQUIVALENT', standardAnnualHours },
              admin,
            ),
          ),
        ).toMatchObject({
          status: 400,
          code: 'PAYROLL_UNPAID_LEAVE_RULE_INVALID',
        });
      }
      expect(
        (
          await tx.payrollCalendar.findUniqueOrThrow({
            where: { id: calendarId },
          })
        ).salaryUnpaidLeaveRule,
      ).toBe('UNCONFIGURED');
      await svc.calendars.setSalaryUnpaidLeaveRule(
        calendarId,
        { rule: 'HOURLY_EQUIVALENT', standardAnnualHours: '2080' },
        admin,
      );
      expect(
        await tx.auditLog.count({
          where: {
            action: 'PAYROLL_CALENDAR_UNPAID_LEAVE_RULE_SET',
            entityId: calendarId,
          },
        }),
      ).toBe(1);
    });
  });

  it('snapshots contract-total salary arrangement metadata used by payroll', async () => {
    await scenario(async ({ tx, fx, svc, admin, periodId, payGroupId }) => {
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.orgLevel,
          organizationId: fx.orgA,
          recordType: 'INITIAL',
          payBasis: 'SALARY',
          rateAmount: '1000',
          salaryArrangement: 'CONTRACT_TOTAL',
          salaryContractAmount: '1000',
          salaryPeriodStart: d('2026-10-04'),
          salaryPeriodEnd: d('2026-10-17'),
          currency: 'CAD',
          effectiveFrom: d('2026-10-04'),
          effectiveTo: d('2026-10-17'),
          payGroupId,
        },
      });
      const assignment = await tx.employmentAssignment.findUniqueOrThrow({
        where: { id: fx.orgLevel },
      });
      const run = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);
      const paid = await lines(tx, run.id, assignment.employeeId);
      const contractLine = paid.find(
        (line) => line.calculationRule === 'CONTRACT_TOTAL_PERIODIZATION',
      );
      expect(contractLine).toBeDefined();
      expect(contractLine!.type).toBe('REGULAR_SALARY');
      expect(contractLine?.amount.toFixed(2)).toBe('1000.00');
      expect(contractLine!.compensationSnapshot).toMatchObject({
        payBasis: 'SALARY',
        salaryArrangement: 'CONTRACT_TOTAL',
      });
      expect(
        contractLine!.compensationSnapshot?.salaryContractAmount?.toFixed(4),
      ).toBe('1000.0000');
      expect(
        contractLine!.compensationSnapshot?.salaryPeriodEnd?.toISOString(),
      ).toBe('2026-10-17T00:00:00.000Z');
    });
  });

  it('validates sign-in-only hourly work, currencies, duplicates and permissions', async () => {
    await scenario(async ({ tx, fx, svc, admin, periodId, payGroupId }) => {
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentTeamA,
          effectiveFrom: d('2026-01-01'),
          config: { attendance: { trackingMode: 'SIGN_IN_ONLY' } },
        },
      });
      // Employee 2's second assignment is paid in USD by the same pay group.
      await compensation(tx, fx, fx.orgLevel, {
        payBasis: 'SALARY',
        rateAmount: '26000',
        payGroupId,
        currency: 'USD',
      });
      expect(
        await failure(
          svc.runs.createRun(
            { payrollPeriodId: periodId, currency: 'CAD' },
            ctx(fx.users.payrollReader!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      const cad = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      expect(
        await failure(
          svc.runs.createRun(
            { payrollPeriodId: periodId, currency: 'CAD' },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'PAYROLL_RUN_EXISTS' });
      expect(
        await failure(
          svc.runs.createRun(
            { payrollPeriodId: periodId, currency: 'XX' },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'PAYROLL_CURRENCY_INVALID' });
      expect(
        await failure(svc.runs.calculate(cad.id, ctx(fx.users.approver!))),
      ).toMatchObject({ status: 403 });
      await svc.runs.calculate(cad.id, admin);
      expect(await issueCodes(tx, cad.id, fx.employee1)).toContain(
        'ERROR:HOURLY_SIGN_IN_ONLY_UNSUPPORTED',
      );
      const cadAssignments = await tx.payrollRunAssignment.findMany({
        where: { payrollRunId: cad.id },
      });
      expect(
        cadAssignments.map((a) => a.employmentAssignmentId).sort(),
      ).toEqual([fx.assignmentTeamA, fx.otherTeamA].sort());
      const usd = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'USD' },
        admin,
      );
      await svc.runs.calculate(usd.id, admin);
      const usdLines = await tx.payrollEarningLine.findMany({
        where: { payrollRunId: usd.id },
      });
      expect(usdLines.map((l) => [l.currency, l.amount.toFixed(2)])).toEqual([
        ['USD', '1000.00'],
      ]);
    });
  });
});

describe('Payroll calculation concurrency (committed data)', () => {
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

  it('serializes concurrent calculations of one run: one consistent result', async () => {
    const run = await w.svc.runs.createRun(
      { payrollPeriodId: w.periodId, currency: 'CAD' },
      w.admin,
    );
    await Promise.all([
      w.svc.runs.calculate(run.id, w.admin),
      w.svc.runs.calculate(run.id, w.admin),
    ]);
    const rows = await prisma.payrollEarningLine.findMany({
      where: { payrollRunId: run.id },
    });
    expect(rows.map((row) => [row.type, row.amount.toFixed(2)])).toEqual([
      ['REGULAR_SALARY', '2000.00'],
    ]);
    expect(
      await prisma.payrollRunAssignment.count({
        where: { payrollRunId: run.id },
      }),
    ).toBe(2);
    expect(
      await prisma.auditLog.count({
        where: {
          entityId: run.id,
          action: {
            in: ['PAYROLL_RUN_CALCULATED', 'PAYROLL_RUN_RECALCULATED'],
          },
        },
      }),
    ).toBe(2);
  });
});
