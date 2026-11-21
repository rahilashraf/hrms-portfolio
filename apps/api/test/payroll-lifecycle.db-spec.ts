import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { LEAVE_USERS } from './support/leave-fixtures.js';
import {
  d,
  FixedPayrollClock,
  PAYROLL_PERMISSION_KEYS,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
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

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** Employee 2 (self2) also administers payroll: nobody approves or adjusts their own pay. */
const USERS = {
  ...PAYROLL_WORLD_USERS,
  self2: [
    ...LEAVE_USERS.self2,
    { permissions: PAYROLL_PERMISSION_KEYS, scope: 'org' as const },
  ],
};

/** Corrects Employee 2's salary (52,000 → `rate`) by superseding the record, as Compensation does. */
async function correctSalary(
  client: Tx,
  fx: SchedulingFixtures,
  payGroupId: string,
  rate: string,
) {
  const original = await client.compensationRecord.findFirstOrThrow({
    where: { employmentAssignmentId: fx.otherTeamA, supersededAt: null },
  });
  await client.compensationRecord.update({
    where: { id: original.id },
    data: { supersededAt: new Date() },
  });
  await client.compensationRecord.create({
    data: {
      employmentAssignmentId: fx.otherTeamA,
      organizationId: fx.orgA,
      recordType: 'CORRECTION',
      payBasis: 'SALARY',
      rateAmount: rate,
      currency: 'CAD',
      effectiveFrom: original.effectiveFrom,
      payGroupId,
      supersedesRecordId: original.id,
      reason: 'Mis-keyed salary',
    },
  });
}

const runRow = (tx: Tx, id: string) =>
  tx.payrollRun.findUniqueOrThrow({ where: { id } });

const employee2Assignment = (tx: Tx, fx: SchedulingFixtures, runId: string) =>
  tx.payrollRunAssignment.findFirstOrThrow({
    where: { payrollRunId: runId, employmentAssignmentId: fx.otherTeamA },
  });

const earnings = async (tx: Tx, runId: string, employeeId: string) =>
  (
    await tx.payrollEarningLine.findMany({
      where: { payrollRunId: runId, runAssignment: { employeeId } },
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
    })
  ).map((line) => [line.type, line.amount.toFixed(2)]);

describe('Payroll lifecycle and adjustments (database)', () => {
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

  it('approves and finalizes with separate permissions; finalized payroll never changes', async () => {
    await scenario(async ({ tx, fx, svc, admin, periodId, payGroupId }) => {
      const approver = ctx(fx.users.approver!);
      const finalizer = ctx(fx.users.finalizer!);
      const run = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      expect(await failure(svc.lifecycle.approve(run.id, approver))).toEqual({
        status: 409,
        code: 'PAYROLL_RUN_STATUS',
      });
      await svc.runs.calculate(run.id, admin);
      expect(
        await failure(
          svc.lifecycle.approve(run.id, ctx(fx.users.payrollReader!)),
        ),
      ).toMatchObject({ status: 403 });
      expect(await failure(svc.lifecycle.finalize(run.id, finalizer))).toEqual({
        status: 409,
        code: 'PAYROLL_RUN_STATUS',
      });
      await svc.lifecycle.approve(run.id, approver);
      expect(await runRow(tx, run.id)).toMatchObject({
        status: 'APPROVED',
        approvedByUserId: fx.users.approver,
      });
      expect(await failure(svc.lifecycle.approve(run.id, approver))).toEqual({
        status: 409,
        code: 'PAYROLL_RUN_STATUS',
      });
      expect(
        await failure(svc.lifecycle.finalize(run.id, approver)),
      ).toMatchObject({ status: 403 });
      await svc.lifecycle.finalize(run.id, finalizer);
      const finalized = await runRow(tx, run.id);
      expect(finalized).toMatchObject({
        status: 'FINALIZED',
        finalizedByUserId: fx.users.finalizer,
        statutoryStatus: 'NOT_CALCULATED',
      });
      expect(finalized.grossAmount?.toFixed(2)).toBe('2000.00');
      expect(
        (await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId } }))
          .status,
      ).toBe('FINALIZED');
      for (const action of ['PAYROLL_RUN_APPROVED', 'PAYROLL_RUN_FINALIZED']) {
        expect(
          await tx.auditLog.count({ where: { entityId: run.id, action } }),
        ).toBe(1);
      }

      // Nothing about a finalized run changes, through the services or the database.
      expect(await failure(svc.runs.calculate(run.id, admin))).toEqual({
        status: 409,
        code: 'PAYROLL_RUN_FINAL',
      });
      expect(
        await failure(svc.lifecycle.void(run.id, 'Wrong period', admin)),
      ).toEqual({ status: 409, code: 'PAYROLL_RUN_FINAL' });
      const target = await employee2Assignment(tx, fx, run.id);
      expect(
        await failure(
          svc.adjustments.addManualLine(
            run.id,
            {
              payrollRunAssignmentId: target.id,
              kind: 'EARNING',
              amount: '10.00',
              description: 'Bonus',
              reason: 'Late bonus',
            },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'PAYROLL_RUN_FINAL' });
      await violation(tx, () =>
        tx.payrollEarningLine.create({
          data: {
            payrollRunId: run.id,
            payrollRunAssignmentId: target.id,
            origin: 'CALCULATED',
            type: 'REGULAR_SALARY',
            description: 'Injected',
            amount: '1.00',
            currency: 'CAD',
            calculationRule: 'X',
            calculationRuleVersion: 1,
          },
        }),
      );
      await violation(tx, () =>
        tx.payrollRun.update({
          where: { id: run.id },
          data: { grossAmount: '1.00' },
        }),
      );
      await violation(tx, () =>
        tx.payrollEarningLine.deleteMany({ where: { payrollRunId: run.id } }),
      );
      expect(
        await svc.lifecycle.statutoryStatus(run.id, fx.users.payrollReader!),
      ).toMatchObject({
        statutoryStatus: 'NOT_CALCULATED',
        status: 'NOT_CALCULATED',
      });

      // Employees read their own finalized pay by identity; nobody else's, nothing unfinalized.
      const mine = await svc.self.myPay(fx.selfUser2);
      expect(mine.items).toEqual([
        expect.objectContaining({
          grossAmount: '2000.00',
          netAmount: null,
          payDate: '2026-10-22',
        }),
      ]);
      const slip = await svc.self.payslip(fx.selfUser2, mine.items[0]!.id);
      expect(slip).toMatchObject({
        currency: 'CAD',
        totals: { grossAmount: '2000.00', netAmount: null },
        yearToDate: { grossAmount: '2000.00' },
      });
      expect(slip.earnings.map((line) => line.type)).toEqual([
        'REGULAR_SALARY',
      ]);
      expect(
        await failure(svc.self.payslip(fx.selfUser1, mine.items[0]!.id)),
      ).toMatchObject({ status: 404 });
      expect((await svc.self.myPay(fx.selfUser1)).items).toHaveLength(1);
      expect(await failure(svc.self.myPay(fx.users.payrollAdmin!))).toEqual({
        status: 403,
        code: 'PAYROLL_NOT_AN_EMPLOYEE',
      });

      // A later source change leaves the finalized run explainable as it was paid...
      await correctSalary(tx, fx, payGroupId, '65000');
      const detail = await svc.reads.run(fx.users.payrollReader!, run.id);
      expect(detail.totals.grossAmount).toBe('2000.00');
      expect(
        await svc.runs.freshness(run.id, fx.users.payrollReader!),
      ).toMatchObject({ stale: true, changedAssignmentIds: [fx.otherTeamA] });

      // ...and becomes a retroactive adjustment, linked to the line it corrects.
      const preview = await svc.adjustments.retroPreview(
        run.id,
        fx.users.payrollReader!,
      );
      const salaried = preview.items.find(
        (item) => item.employmentAssignmentId === fx.otherTeamA,
      )!;
      expect(salaried).toMatchObject({
        finalizedGross: '2000.00',
        currentGross: '2500.00',
        difference: '500.00',
        blocked: false,
      });
      expect(salaried.lines).toEqual([
        expect.objectContaining({
          type: 'REGULAR_SALARY',
          date: '2026-10-04',
          finalizedAmount: '2000.00',
          currentAmount: '2500.00',
          difference: '500.00',
        }),
      ]);
      expect(
        preview.items.find(
          (item) => item.employmentAssignmentId === fx.assignmentTeamA,
        )?.difference,
      ).toBe('0.00');
      expect(
        await failure(
          svc.adjustments.createRetroAdjustments(
            run.id,
            'Salary correction',
            approver,
          ),
        ),
      ).toMatchObject({ status: 403 });
      const retro = await svc.adjustments.createRetroAdjustments(
        run.id,
        'Salary correction',
        admin,
      );
      expect(retro.created).toHaveLength(1);
      expect(
        (
          await svc.adjustments.createRetroAdjustments(
            run.id,
            'Salary correction',
            admin,
          )
        ).created,
      ).toEqual([]);
      const adjustment = await tx.payrollAdjustment.findUniqueOrThrow({
        where: { id: retro.created[0]! },
      });
      const salaryLine = await tx.payrollEarningLine.findFirstOrThrow({
        where: { payrollRunId: run.id, type: 'REGULAR_SALARY' },
      });
      expect(adjustment).toMatchObject({
        status: 'PENDING',
        kind: 'EARNING',
        sourceRunId: run.id,
        sourceEarningLineId: salaryLine.id,
        payrollRunId: null,
      });
      expect(adjustment.amount.toFixed(2)).toBe('500.00');

      // The next period's run carries it at the new rate, and finalization applies it.
      await svc.calendars.generatePeriods(
        { payGroupId, throughDate: '2026-10-18' },
        admin,
      );
      const next = await tx.payrollPeriod.findFirstOrThrow({
        where: { payGroupId, periodStart: d('2026-10-18') },
      });
      const run2 = await svc.runs.createRun(
        { payrollPeriodId: next.id, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run2.id, admin);
      expect(await earnings(tx, run2.id, fx.employee2)).toEqual([
        ['REGULAR_SALARY', '2500.00'],
        ['RETRO_ADJUSTMENT', '500.00'],
      ]);
      const codes = await issueCodes(tx, run2.id, fx.employee2);
      expect(codes).toContain('INFO:ADJUSTMENT_INCLUDED');
      expect(codes).not.toContain('WARNING:PRIOR_PERIOD_SOURCE_CHANGED');
      await svc.lifecycle.approve(run2.id, approver);
      await svc.lifecycle.finalize(run2.id, finalizer);
      const applied = await tx.payrollAdjustment.findUniqueOrThrow({
        where: { id: adjustment.id },
      });
      expect(applied).toMatchObject({
        status: 'APPLIED',
        payrollRunId: run2.id,
      });
      expect(applied.appliedAt).not.toBeNull();
      const slips = await svc.self.myPay(fx.selfUser2);
      expect(slips.items.map((item) => item.grossAmount)).toEqual([
        '3000.00',
        '2000.00',
      ]);
      const latest = await svc.self.payslip(fx.selfUser2, slips.items[0]!.id);
      expect(latest.yearToDate.grossAmount).toBe('5000.00');
      expect(latest.earnings.map((line) => [line.type, line.amount])).toEqual([
        ['REGULAR_SALARY', '2500.00'],
        ['RETRO_ADJUSTMENT', '500.00'],
      ]);
      expect(
        await failure(
          svc.adjustments.cancelAdjustment(adjustment.id, 'Oops', admin),
        ),
      ).toEqual({ status: 409, code: 'PAYROLL_ADJUSTMENT_NOT_PENDING' });
      await violation(tx, () =>
        tx.payrollAdjustment.delete({ where: { id: adjustment.id } }),
      );
    });
  });

  it('refuses stale approval and finalization, withdrawing a stale approval', async () => {
    await scenario(async ({ tx, fx, svc, admin, periodId, payGroupId }) => {
      const approver = ctx(fx.users.approver!);
      const run = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);
      await svc.lifecycle.approve(run.id, approver);
      await correctSalary(tx, fx, payGroupId, '65000');
      expect(
        await failure(svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!))),
      ).toEqual({ status: 409, code: 'PAYROLL_RUN_STALE' });
      expect(await runRow(tx, run.id)).toMatchObject({
        status: 'CALCULATED',
        approvedAt: null,
        approvedByUserId: null,
      });
      expect(await issueCodes(tx, run.id)).toContain('ERROR:STALE_SOURCE_DATA');
      expect(
        await tx.auditLog.count({
          where: { entityId: run.id, action: 'PAYROLL_RUN_STALE_DETECTED' },
        }),
      ).toBe(1);
      expect(await failure(svc.lifecycle.approve(run.id, approver))).toEqual({
        status: 409,
        code: 'PAYROLL_RUN_HAS_ERRORS',
      });
      await svc.runs.calculate(run.id, admin);
      expect(await earnings(tx, run.id, fx.employee2)).toEqual([
        ['REGULAR_SALARY', '2500.00'],
      ]);

      // A change before approval is caught at approval too.
      await correctSalary(tx, fx, payGroupId, '78000');
      expect(await failure(svc.lifecycle.approve(run.id, approver))).toEqual({
        status: 409,
        code: 'PAYROLL_RUN_STALE',
      });
      await svc.runs.calculate(run.id, admin);
      await svc.lifecycle.approve(run.id, approver);

      // Voiding needs payroll.manage and a reason, and reopens the period for a new run.
      expect(
        await failure(svc.lifecycle.void(run.id, 'Redo', approver)),
      ).toMatchObject({ status: 403 });
      expect(await failure(svc.lifecycle.void(run.id, '  ', admin))).toEqual({
        status: 400,
        code: 'PAYROLL_TEXT_INVALID',
      });
      await svc.lifecycle.void(run.id, 'Redo after corrections', admin);
      expect(await runRow(tx, run.id)).toMatchObject({
        status: 'VOIDED',
        voidReason: 'Redo after corrections',
      });
      expect(
        (await tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId } }))
          .status,
      ).toBe('OPEN');
      expect(await failure(svc.lifecycle.void(run.id, 'Again', admin))).toEqual(
        { status: 409, code: 'PAYROLL_RUN_FINAL' },
      );
      const again = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      expect(again.id).not.toBe(run.id);
    });
  });

  it('adds and reverses manual lines, carries adjustments, and blocks own-pay changes', async () => {
    await scenario(async ({ tx, fx, svc, admin, periodId, payGroupId }) => {
      const run = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);
      const target = await employee2Assignment(tx, fx, run.id);
      const line = (
        kind: 'EARNING' | 'DEDUCTION' | 'CONTRIBUTION',
        amount: string,
        actor = admin,
        code?: string,
      ) =>
        svc.adjustments.addManualLine(
          run.id,
          {
            payrollRunAssignmentId: target.id,
            kind,
            amount,
            description: `Manual ${kind.toLowerCase()}`,
            reason: 'Agreed with the employee',
            code,
          },
          actor,
        );
      const bonus = await line('EARNING', '150.00');
      await line('DEDUCTION', '50', admin, 'uniform');
      await line('CONTRIBUTION', '25.5');
      expect(await runRow(tx, run.id)).toMatchObject({ status: 'CALCULATED' });
      let stored = await runRow(tx, run.id);
      expect([
        stored.grossAmount?.toFixed(2),
        stored.deductionAmount?.toFixed(2),
        stored.employerContributionAmount?.toFixed(2),
      ]).toEqual(['2150.00', '50.00', '25.50']);
      expect(
        (
          await tx.payrollDeductionLine.findFirstOrThrow({
            where: { payrollRunId: run.id },
          })
        ).code,
      ).toBe('UNIFORM');
      const codes = await issueCodes(tx, run.id, fx.employee2);
      expect(codes).toEqual(
        expect.arrayContaining([
          'WARNING:MANUAL_EARNING_PRESENT',
          'WARNING:MANUAL_DEDUCTION_PRESENT',
          'WARNING:MANUAL_CONTRIBUTION_PRESENT',
        ]),
      );
      expect(await failure(line('EARNING', '0'))).toEqual({
        status: 400,
        code: 'PAYROLL_AMOUNT_INVALID',
      });
      expect(await failure(line('DEDUCTION', '-5'))).toEqual({
        status: 400,
        code: 'PAYROLL_AMOUNT_INVALID',
      });
      expect(
        await failure(line('EARNING', '1', ctx(fx.users.approver!))),
      ).toMatchObject({ status: 403 });
      expect(await failure(line('EARNING', '1', ctx(fx.selfUser2)))).toEqual({
        status: 403,
        code: 'PAYROLL_SELF_ADJUSTMENT',
      });
      expect(
        await failure(svc.lifecycle.approve(run.id, ctx(fx.selfUser2))),
      ).toEqual({ status: 403, code: 'PAYROLL_SELF_APPROVAL' });

      // Recalculation keeps manual lines; reversal negates without editing.
      await svc.runs.calculate(run.id, admin);
      expect(await earnings(tx, run.id, fx.employee2)).toEqual([
        ['REGULAR_SALARY', '2000.00'],
        ['MANUAL_EARNING', '150.00'],
      ]);
      await svc.adjustments.reverseManualLine(
        run.id,
        { lineId: bonus.id, kind: 'EARNING', reason: 'Entered twice' },
        admin,
      );
      expect(
        await failure(
          svc.adjustments.reverseManualLine(
            run.id,
            { lineId: bonus.id, kind: 'EARNING', reason: 'Again' },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'PAYROLL_LINE_ALREADY_REVERSED' });
      stored = await runRow(tx, run.id);
      expect(stored.grossAmount?.toFixed(2)).toBe('2000.00');
      expect(await issueCodes(tx, run.id, fx.employee2)).not.toContain(
        'WARNING:MANUAL_EARNING_PRESENT',
      );
      await violation(tx, () =>
        tx.payrollEarningLine.update({
          where: { id: bonus.id },
          data: { amount: '1.00' },
        }),
      );

      // Deductions above gross block approval.
      const big = await line('DEDUCTION', '5000');
      expect(await issueCodes(tx, run.id, fx.employee2)).toContain(
        'ERROR:DEDUCTIONS_EXCEED_GROSS',
      );
      expect(
        await failure(svc.lifecycle.approve(run.id, ctx(fx.users.approver!))),
      ).toEqual({ status: 409, code: 'PAYROLL_RUN_HAS_ERRORS' });
      await svc.adjustments.reverseManualLine(
        run.id,
        { lineId: big.id, kind: 'DEDUCTION', reason: 'Typo' },
        admin,
      );
      expect(await issueCodes(tx, run.id, fx.employee2)).not.toContain(
        'ERROR:DEDUCTIONS_EXCEED_GROSS',
      );

      // A negative adjustment larger than the period's pay blocks; cancelling it unblocks.
      const adjust = (amount: string, actor = admin) =>
        svc.adjustments.createAdjustment(
          {
            payGroupId,
            employmentAssignmentId: fx.otherTeamA,
            currency: 'CAD',
            kind: 'EARNING',
            amount,
            description: 'Overpayment recovery',
            reason: 'Paid twice in September',
          },
          actor,
        );
      expect(await failure(adjust('-1', ctx(fx.selfUser2)))).toEqual({
        status: 403,
        code: 'PAYROLL_SELF_ADJUSTMENT',
      });
      const recovery = await adjust('-2500');
      expect(
        await svc.runs.freshness(run.id, fx.users.payrollAdmin!),
      ).toMatchObject({ stale: true });
      await svc.runs.calculate(run.id, admin);
      expect(await earnings(tx, run.id, fx.employee2)).toEqual(
        expect.arrayContaining([['RETRO_ADJUSTMENT', '-2500.00']]),
      );
      expect(await issueCodes(tx, run.id, fx.employee2)).toContain(
        'ERROR:NEGATIVE_GROSS_PAY',
      );
      await svc.adjustments.cancelAdjustment(
        recovery.id,
        'Recover over two periods instead',
        admin,
      );
      expect(
        await tx.payrollAdjustment.findUniqueOrThrow({
          where: { id: recovery.id },
        }),
      ).toMatchObject({ status: 'CANCELLED', payrollRunId: null });
      expect(await issueCodes(tx, run.id, fx.employee2)).not.toContain(
        'ERROR:NEGATIVE_GROSS_PAY',
      );
      expect((await runRow(tx, run.id)).grossAmount?.toFixed(2)).toBe(
        '2000.00',
      );
      expect(
        await svc.runs.freshness(run.id, fx.users.payrollAdmin!),
      ).toMatchObject({ stale: true });

      // An approved run's adjustment is not cancelled under it; voiding releases it.
      const pending = await adjust('-100');
      await svc.runs.calculate(run.id, admin);
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
      expect(
        await failure(
          svc.adjustments.cancelAdjustment(pending.id, 'No', admin),
        ),
      ).toEqual({ status: 409, code: 'PAYROLL_ADJUSTMENT_IN_APPROVED_RUN' });
      await svc.lifecycle.void(run.id, 'Restart', admin);
      expect(
        await tx.payrollAdjustment.findUniqueOrThrow({
          where: { id: pending.id },
        }),
      ).toMatchObject({ status: 'PENDING', payrollRunId: null });
      expect(
        await tx.payrollEarningLine.count({
          where: { payrollRunId: run.id, origin: 'ADJUSTMENT' },
        }),
      ).toBe(0);
      const rerun = await svc.runs.createRun(
        { payrollPeriodId: periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(rerun.id, admin);
      expect(
        await tx.payrollAdjustment.findUniqueOrThrow({
          where: { id: pending.id },
        }),
      ).toMatchObject({ payrollRunId: rerun.id });
      expect(
        await failure(
          svc.adjustments.createAdjustment(
            {
              payGroupId,
              employmentAssignmentId: fx.otherTeamA,
              currency: 'CAD',
              kind: 'EARNING',
              amount: '10',
              description: 'Correction',
              reason: 'Not a finalized run',
              sourceRunId: rerun.id,
            },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'PAYROLL_ADJUSTMENT_SOURCE_INVALID' });
      const listed = await svc.adjustments.listAdjustments(
        fx.users.payrollReader!,
        { organizationId: fx.orgA },
      );
      expect(listed.items.map((item) => item.status).sort()).toEqual([
        'CANCELLED',
        'PENDING',
      ]);
    });
  });
});

describe('Payroll finalization concurrency (committed data)', () => {
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

  it('finalizes once when two administrators finalize at the same time, and retro adjusts once', async () => {
    const run = await w.svc.runs.createRun(
      { payrollPeriodId: w.periodId, currency: 'CAD' },
      w.admin,
    );
    await w.svc.runs.calculate(run.id, w.admin);
    await w.svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
    const outcomes = await Promise.allSettled([
      w.svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!)),
      w.svc.lifecycle.finalize(run.id, w.admin),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected');
    expect(
      (rejected as PromiseRejectedResult).reason.getResponse(),
    ).toMatchObject({ code: 'PAYROLL_RUN_FINAL' });
    expect(
      await prisma.auditLog.count({
        where: { entityId: run.id, action: 'PAYROLL_RUN_FINALIZED' },
      }),
    ).toBe(1);

    await correctSalary(prisma as unknown as Tx, fx, w.payGroupId, '65000');
    const created = await Promise.all([
      w.svc.adjustments.createRetroAdjustments(run.id, 'Correction', w.admin),
      w.svc.adjustments.createRetroAdjustments(run.id, 'Correction', w.admin),
    ]);
    expect(created.flatMap((result) => result.created)).toHaveLength(1);
    expect(
      await prisma.payrollAdjustment.count({ where: { sourceRunId: run.id } }),
    ).toBe(1);
  });
});
