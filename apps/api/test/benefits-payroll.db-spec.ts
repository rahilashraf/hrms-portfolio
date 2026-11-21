import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  BENEFIT_USERS,
  benefitsServices,
  FixedBenefitsClock,
  healthPlan,
} from './support/benefits-fixtures.js';
import {
  FixedPayrollClock,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
  compensation,
  issueCodes,
  PAYROLL_WORLD_USERS,
  world,
} from './support/payroll-world.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  violation,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  ...PAYROLL_WORLD_USERS,
  planAdmin: BENEFIT_USERS.planAdmin!,
  benefitsAdmin: BENEFIT_USERS.benefitsAdmin!,
};

const benefitLines = async (tx: Tx, runId: string, employeeId: string) => {
  const where = {
    payrollRunId: runId,
    category: 'BENEFIT' as const,
    runAssignment: { employeeId },
  };
  const deductions = await tx.payrollDeductionLine.findMany({
    where,
    include: { runAssignment: true },
  });
  const contributions = await tx.payrollEmployerContributionLine.findMany({
    where,
    include: { runAssignment: true },
  });
  return [
    ...deductions.map((l) => [
      'DEDUCTION',
      l.runAssignment.employmentAssignmentId,
      l.amount.toFixed(2),
    ]),
    ...contributions.map((l) => [
      'CONTRIBUTION',
      l.runAssignment.employmentAssignmentId,
      l.amount.toFixed(2),
    ]),
  ];
};

/**
 * Payroll world: pay group PG, bi-weekly 2026-10-04 – 10-17. Employee 1 hourly (no time);
 * Employee 2 salaried (52,000) on otherTeamA. Benefit plan HEALTH: SINGLE 25.00 employee /
 * 75.00 employer per month (per bi-weekly period: 11.54 / 34.62).
 */
describe('Benefits consumed by Payroll (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('deducts benefits once, keeps finalized payroll immutable, and shows later differences', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const pay = payrollServices(
            rollbackClient(tx),
            new FixedPayrollClock(),
          );
          const w = await world(tx, fx, pay);
          const ben = benefitsServices(
            rollbackClient(tx),
            new FixedBenefitsClock(),
          );
          const hr = ctx(fx.users.benefitsAdmin!);
          try {
            // Employee 2 also works a second (hourly) assignment paid by the same pay group.
            await compensation(tx, fx, fx.orgLevel, {
              payBasis: 'HOURLY',
              rateAmount: '20',
              payGroupId: w.payGroupId,
            });
            const { plan, single, admin } = await healthPlan(ben, fx);
            const benefit = await ben.enrollments.enroll(
              {
                employmentAssignmentId: fx.otherTeamA,
                planId: plan.id,
                optionId: single.id,
                coverageStart: '2026-01-01',
              },
              hr,
            );
            // Employee 1 (no earnings this period) joins mid-period.
            const starter = await ben.enrollments.enroll(
              {
                employmentAssignmentId: fx.assignmentTeamA,
                planId: plan.id,
                optionId: single.id,
                coverageStart: '2026-10-11',
              },
              hr,
            );
            const run = await pay.runs.createRun(
              { payrollPeriodId: w.periodId, currency: 'CAD' },
              w.admin,
            );
            await pay.runs.calculate(run.id, w.admin);
            // Once per employee, through the sponsoring assignment only.
            expect(await benefitLines(tx, run.id, fx.employee2)).toEqual([
              ['DEDUCTION', fx.otherTeamA, '11.54'],
              ['CONTRIBUTION', fx.otherTeamA, '34.62'],
            ]);
            // Mid-period start: 7 of 14 days; deductions above gross (no earnings) block.
            expect(await benefitLines(tx, run.id, fx.employee1)).toEqual([
              ['DEDUCTION', fx.assignmentTeamA, '5.77'],
              ['CONTRIBUTION', fx.assignmentTeamA, '17.31'],
            ]);
            expect(await issueCodes(tx, run.id, fx.employee1)).toContain(
              'ERROR:DEDUCTIONS_EXCEED_GROSS',
            );
            expect(
              await tx.payrollSourceClaim.count({
                where: { payrollRunId: run.id, kind: 'BENEFIT_DAY' },
              }),
            ).toBe(14 + 7);
            const snapshot = await tx.payrollBenefitSnapshot.findFirstOrThrow({
              where: { payrollRunId: run.id, benefitEnrollmentId: benefit.id },
            });
            expect(snapshot).toMatchObject({
              planCode: 'HEALTH',
              optionCode: 'SINGLE',
              frequency: 'MONTHLY',
              currency: 'CAD',
            });
            expect(snapshot.employeeAmount.toFixed(2)).toBe('25.00');
            const detail = await pay.reads.employeeDetail(
              run.id,
              (
                await tx.payrollRunEmployee.findFirstOrThrow({
                  where: { payrollRunId: run.id, employeeId: fx.employee2 },
                })
              ).id,
            );
            expect(
              detail.assignments.find(
                (a) => a.employmentAssignmentId === fx.otherTeamA,
              )!.snapshots.benefits,
            ).toHaveLength(1);

            // Benefits changes make the run stale; recalculation picks them up.
            await ben.enrollments.rescind(
              starter.id,
              { reason: 'Entered too early' },
              hr,
            );
            const rate = await tx.benefitRate.findFirstOrThrow({
              where: { optionId: single.id, supersededAt: null },
            });
            await ben.rates.correctRate(
              rate.id,
              { employeeAmount: '30.00', reason: 'Carrier invoice' },
              admin,
            );
            expect(
              await pay.runs.freshness(run.id, fx.users.payrollReader!),
            ).toMatchObject({ stale: true });
            await pay.runs.calculate(run.id, w.admin);
            expect(await benefitLines(tx, run.id, fx.employee1)).toEqual([]);
            expect(await benefitLines(tx, run.id, fx.employee2)).toEqual([
              ['DEDUCTION', fx.otherTeamA, '13.85'],
              ['CONTRIBUTION', fx.otherTeamA, '34.62'],
            ]);
            const stored = await tx.payrollRun.findUniqueOrThrow({
              where: { id: run.id },
            });
            expect(stored.deductionAmount?.toFixed(2)).toBe('13.85');
            expect(stored.employerContributionAmount?.toFixed(2)).toBe('34.62');
            expect(stored.grossAmount?.toFixed(2)).toBe('2000.00');

            await pay.lifecycle.approve(run.id, ctx(fx.users.approver!));
            await pay.lifecycle.finalize(run.id, ctx(fx.users.finalizer!));

            // A later correction never rewrites finalized payroll: it shows as a difference.
            await ben.enrollments.end(
              benefit.id,
              { coverageEnd: '2026-10-10' },
              hr,
            );
            expect(await benefitLines(tx, run.id, fx.employee2)).toEqual([
              ['DEDUCTION', fx.otherTeamA, '13.85'],
              ['CONTRIBUTION', fx.otherTeamA, '34.62'],
            ]);
            expect(
              await pay.runs.freshness(run.id, fx.users.payrollReader!),
            ).toMatchObject({ stale: true });
            const preview = await pay.adjustments.retroPreview(
              run.id,
              fx.users.payrollReader!,
            );
            expect(
              preview.items.find(
                (item) => item.employmentAssignmentId === fx.otherTeamA,
              ),
            ).toMatchObject({
              difference: '0.00',
              benefits: {
                finalizedDeductions: '13.85',
                currentDeductions: '6.92',
                finalizedContributions: '34.62',
                currentContributions: '17.31',
              },
            });
            // No retro deduction is generated automatically (decision 3a).
            const retro = await pay.adjustments.createRetroAdjustments(
              run.id,
              'Benefit correction',
              w.admin,
            );
            expect(retro.created).toEqual([]);

            // The database keeps the finalized benefit lines and claims.
            await violation(tx, () =>
              tx.payrollDeductionLine.deleteMany({
                where: { payrollRunId: run.id, category: 'BENEFIT' },
              }),
            );
            const assignment = await tx.payrollRunAssignment.findFirstOrThrow({
              where: {
                payrollRunId: run.id,
                employmentAssignmentId: fx.otherTeamA,
              },
            });
            await violation(tx, () =>
              tx.payrollSourceClaim.create({
                data: {
                  payrollRunId: run.id,
                  payrollRunAssignmentId: assignment.id,
                  employmentAssignmentId: fx.otherTeamA,
                  kind: 'BENEFIT_DAY',
                  benefitEnrollmentId: benefit.id,
                  workDate: new Date('2026-10-05T00:00:00.000Z'),
                },
              }),
            );
          } catch (error) {
            console.error('SCENARIO FAILURE', error);
            throw error;
          }
          throw new RollbackFixtures();
        },
        { timeout: 180_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });
});
