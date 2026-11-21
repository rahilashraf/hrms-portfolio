import type { HttpException } from '@nestjs/common';
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
import { payGroup } from './support/payroll-fixtures.js';
import {
  compensation,
  failure,
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

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  ...PAYROLL_WORLD_USERS,
  planAdmin: BENEFIT_USERS.planAdmin!,
  benefitsAdmin: BENEFIT_USERS.benefitsAdmin!,
};

type Ben = ReturnType<typeof benefitsServices>;

/** Deduction lines (amounts) of one assignment in one run. */
async function deductions(tx: Tx, runId: string, assignmentId: string) {
  return (
    await tx.payrollDeductionLine.findMany({
      where: {
        payrollRunId: runId,
        category: 'BENEFIT',
        runAssignment: { employmentAssignmentId: assignmentId },
      },
    })
  ).map((line) => line.amount.toFixed(2));
}

/**
 * Batch 7C — Benefits and Payroll integrity (C2 and the payroll acceptance list). Payroll world:
 * pay group PG, bi-weekly from 2026-10-04; Employee 2 salaried on otherTeamA. HEALTH plan:
 * SINGLE 25.00 employee / 75.00 employer per month.
 */
describe('Batch 7C benefits and payroll (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(run: (w: World, ben: Ben, tx: Tx) => Promise<void>) {
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
          await run(w, ben, tx).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 240_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** Employee 2 enrolled from January; the first period finalized; a second period's run. */
  async function finalizedWithBenefits(w: World, ben: Ben) {
    const { fx, svc, admin, payGroupId } = w;
    const { plan, single, admin: planAdmin } = await healthPlan(ben, fx);
    const hr = ctx(fx.users.benefitsAdmin!);
    const election = await ben.enrollments.enroll(
      {
        employmentAssignmentId: fx.otherTeamA,
        planId: plan.id,
        optionId: single.id,
        coverageStart: '2026-01-01',
      },
      hr,
    );
    const run1 = await svc.runs.createRun(
      { payrollPeriodId: w.periodId, currency: 'CAD' },
      admin,
    );
    await svc.runs.calculate(run1.id, admin);
    await svc.lifecycle.approve(run1.id, ctx(fx.users.approver!));
    await svc.lifecycle.finalize(run1.id, ctx(fx.users.finalizer!));
    await svc.calendars.generatePeriods(
      { payGroupId, throughDate: '2026-10-31' },
      admin,
    );
    const period2 = await w.tx.payrollPeriod.findFirstOrThrow({
      where: { payGroupId, periodStart: new Date('2026-10-18T00:00:00Z') },
    });
    const run2 = await svc.runs.createRun(
      { payrollPeriodId: period2.id, currency: 'CAD' },
      admin,
    );
    /** The sources the PRIOR_PERIOD_SOURCE_CHANGED warnings of run 2 name (after recalculating). */
    const warnings = async () => {
      await svc.runs.calculate(run2.id, admin);
      return (
        await w.tx.payrollValidationIssue.findMany({
          where: {
            payrollRunId: run2.id,
            code: 'PRIOR_PERIOD_SOURCE_CHANGED',
          },
        })
      ).map((issue) => (issue.metadata as { sourceRunId: string }).sourceRunId);
    };
    return { plan, single, planAdmin, hr, election, run1, run2, warnings };
  }

  it('C2/B6: a benefit-only difference is never resolved automatically; HR resolves it explicitly', async () => {
    await scenario(async (w, ben, tx) => {
      const { fx, svc, admin } = w;
      const { single, planAdmin, run1, warnings } = await finalizedWithBenefits(
        w,
        ben,
      );
      const frozen = async () => ({
        lines: await tx.payrollDeductionLine.findMany({
          where: { payrollRunId: run1.id },
          orderBy: { id: 'asc' },
        }),
        snapshots: await tx.payrollBenefitSnapshot.findMany({
          where: { payrollRunId: run1.id },
          orderBy: { id: 'asc' },
        }),
      });
      const before = await frozen();
      // The carrier's rate was wrong: corrected after finalization (gross pay unchanged).
      const rate = await tx.benefitRate.findFirstOrThrow({
        where: { optionId: single.id, supersededAt: null },
      });
      await ben.rates.correctRate(
        rate.id,
        { employeeAmount: '50.00', reason: 'Carrier invoice' },
        planAdmin,
      );
      expect(await warnings()).toEqual([run1.id]);
      const preview = await svc.adjustments.retroPreview(
        run1.id,
        fx.users.payrollReader!,
      );
      const item = preview.items.find(
        (row) => row.employmentAssignmentId === fx.otherTeamA,
      )!;
      expect(item).toMatchObject({
        difference: '0.00',
        benefitDifference: {
          employeeDeductions: '11.54',
          employerContributions: '0.00',
          resolved: false,
        },
        warnings: ['BENEFIT_DIFFERENCE_UNRESOLVED'],
      });
      // The retro tool creates nothing and records no resolution for a benefit difference.
      const retro = await svc.adjustments.createRetroAdjustments(
        run1.id,
        'Monthly retro review',
        admin,
      );
      expect(retro).toMatchObject({
        created: [],
        resolved: [],
        benefitDifferences: [fx.otherTeamA],
      });
      expect(
        await tx.payrollRetroResolution.count({
          where: { payrollRunId: run1.id },
        }),
      ).toBe(0);
      // The warning stays until someone resolves it.
      expect(await warnings()).toEqual([run1.id]);

      // HR resolves it through the authorized manual adjustment workflow.
      const resolve = (
        input: { outcome: unknown; adjustmentId?: string },
        as = admin,
      ) =>
        svc.adjustments.resolveBenefitDifference(
          run1.id,
          {
            employmentAssignmentId: fx.otherTeamA,
            reason: 'Carrier rate corrected',
            ...input,
          },
          as,
        );
      expect(await failure(resolve({ outcome: 'ADJUSTED' }))).toMatchObject({
        status: 400,
      });
      // Payroll readers never resolve.
      expect(
        await failure(
          resolve(
            { outcome: 'NO_ADJUSTMENT_REQUIRED' },
            ctx(fx.users.payrollReader!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      const adjustment = await svc.adjustments.createAdjustment(
        {
          payGroupId: w.payGroupId,
          employmentAssignmentId: fx.otherTeamA,
          currency: 'CAD',
          kind: 'DEDUCTION',
          amount: '11.54',
          description: 'Health premium correction',
          reason: 'Carrier rate corrected',
          sourceRunId: run1.id,
        },
        admin,
      );
      expect(
        await resolve({ outcome: 'ADJUSTED', adjustmentId: adjustment.id }),
      ).toMatchObject({ resolved: true });
      expect(await warnings()).toEqual([]);
      expect(
        (
          await svc.adjustments.retroPreview(run1.id, fx.users.payrollReader!)
        ).items.find((row) => row.employmentAssignmentId === fx.otherTeamA),
      ).toMatchObject({
        benefitDifference: { resolved: true },
        warnings: [],
      });
      // The finalized run never changed.
      expect(await frozen()).toEqual(before);
    });
  });

  it('review fix: the deduction adjustment is created with the resolution, atomically', async () => {
    await scenario(async (w, ben, tx) => {
      const { fx, svc, admin } = w;
      const { single, planAdmin, run1 } = await finalizedWithBenefits(w, ben);
      const rate = await tx.benefitRate.findFirstOrThrow({
        where: { optionId: single.id, supersededAt: null },
      });
      await ben.rates.correctRate(
        rate.id,
        { employeeAmount: '50.00', reason: 'Carrier invoice' },
        planAdmin,
      );
      const resolve = () =>
        svc.adjustments.resolveBenefitDifference(
          run1.id,
          {
            employmentAssignmentId: fx.otherTeamA,
            outcome: 'ADJUSTED',
            reason: 'Carrier rate corrected',
            adjustment: { amount: '11.54' },
          },
          admin,
        );
      expect(await resolve()).toMatchObject({ resolved: true });
      // A retry never adds a second adjustment.
      expect(await resolve()).toMatchObject({ alreadyResolved: true });
      expect(
        await tx.payrollAdjustment.findMany({
          where: { sourceRunId: run1.id },
          select: { kind: true, amount: true },
        }),
      ).toEqual([{ kind: 'DEDUCTION', amount: expect.anything() }]);
      expect(
        (
          await tx.payrollAdjustment.findFirstOrThrow({
            where: { sourceRunId: run1.id },
          })
        ).amount.toFixed(2),
      ).toBe('11.54');
      // No adjustment alongside "none required".
      expect(
        await failure(
          svc.adjustments.resolveBenefitDifference(
            run1.id,
            {
              employmentAssignmentId: fx.otherTeamA,
              outcome: 'NO_ADJUSTMENT_REQUIRED',
              reason: 'x',
              adjustment: { amount: '1' },
            },
            admin,
          ),
        ),
      ).toMatchObject({ status: 400 });
      // Both forms at once are refused.
      expect(
        await failure(
          svc.adjustments.resolveBenefitDifference(
            run1.id,
            {
              employmentAssignmentId: fx.otherTeamA,
              outcome: 'ADJUSTED',
              reason: 'x',
              adjustmentId: '00000000-0000-4000-8000-000000000000',
              adjustment: { amount: '1' },
            },
            admin,
          ),
        ),
      ).toMatchObject({ status: 400 });
    });
  });

  it('suspected (audit F12): a transfer into another pay group never deducts days already paid', async () => {
    await scenario(async (w, ben, tx) => {
      const { fx, svc, admin } = w;
      const { hr, election, run1 } = await finalizedWithBenefits(w, ben);
      // Employee 2's organization-level assignment is paid by a second pay group.
      const group2 = await payGroup(tx, fx.orgA, `PG2-${fx.suffix}`);
      await compensation(tx, fx, fx.orgLevel, {
        payBasis: 'SALARY',
        rateAmount: '26000',
        payGroupId: group2.id,
      });
      await svc.calendars.createCalendar(
        {
          payGroupId: group2.id,
          cadence: 'BIWEEKLY',
          timezone: 'America/Toronto',
          anchorDate: '2026-10-04',
          payDateOffsetDays: 5,
          processingCutoffOffsetDays: 2,
          effectiveFrom: '2026-10-04',
        },
        admin,
      );
      await svc.calendars.generatePeriods(
        { payGroupId: group2.id, throughDate: '2026-10-04' },
        admin,
      );
      // Run 1 (pay group 1, finalized) deducted 2026-10-04 – 10-17 through otherTeamA.
      expect(await deductions(tx, run1.id, fx.otherTeamA)).toEqual(['11.54']);
      // Sponsorship moves to the organization-level assignment from 2026-10-11 (retroactive).
      await ben.enrollments.transfer(
        election.id,
        {
          employmentAssignmentId: fx.orgLevel,
          effectiveDate: '2026-10-11',
          reason: 'Moved to the organization role',
        },
        hr,
      );
      const period = await tx.payrollPeriod.findFirstOrThrow({
        where: { payGroupId: group2.id },
      });
      const run = await svc.runs.createRun(
        { payrollPeriodId: period.id, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);
      // 2026-10-11 – 10-17 were already deducted by run 1: never again; the run says so
      // (blocking, as for any source another run paid) and run 1 shows the difference.
      expect(await deductions(tx, run.id, fx.orgLevel)).toEqual([]);
      const consumed = await tx.payrollValidationIssue.findFirstOrThrow({
        where: {
          payrollRunId: run.id,
          code: 'PAYROLL_SOURCE_ALREADY_CONSUMED',
          runAssignment: { employmentAssignmentId: fx.orgLevel },
        },
      });
      expect(
        (
          consumed.metadata as {
            conflicts: Array<{ kind: string; payrollRunId: string }>;
          }
        ).conflicts[0],
      ).toMatchObject({ kind: 'BENEFIT_DAY', payrollRunId: run1.id });
      expect(
        (
          await svc.adjustments.retroPreview(run1.id, fx.users.payrollReader!)
        ).items.find((row) => row.employmentAssignmentId === fx.otherTeamA),
      ).toMatchObject({
        benefitDifference: { employeeDeductions: '-5.77', resolved: false },
      });
    });
  });

  it('an open run goes stale on a rate correction and refuses to finalize; a rate change within the period is prorated', async () => {
    await scenario(async (w, ben, tx) => {
      const { fx, svc, admin } = w;
      const { plan, single, admin: planAdmin } = await healthPlan(ben, fx);
      await ben.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-01-01',
        },
        ctx(fx.users.benefitsAdmin!),
      );
      const run = await svc.runs.createRun(
        { payrollPeriodId: w.periodId, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
      expect(await deductions(tx, run.id, fx.otherTeamA)).toEqual(['11.54']);
      // A new monthly rate from 2026-10-11, the middle of the period (2026-10-04 – 10-17).
      await ben.rates.addRate(
        single.id,
        {
          effectiveFrom: '2026-10-11',
          frequency: 'MONTHLY',
          employeeAmount: '50',
          employerAmount: '75',
        },
        planAdmin,
      );
      expect(
        await svc.runs.freshness(run.id, fx.users.payrollReader!),
      ).toMatchObject({ stale: true });
      expect(
        await failure(svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!))),
      ).toMatchObject({ status: 409, code: 'PAYROLL_RUN_STALE' });
      // Recalculated: 7 days at each rate (25/month, then 50/month), each once.
      await svc.runs.calculate(run.id, admin);
      expect((await deductions(tx, run.id, fx.otherTeamA)).sort()).toEqual(
        ['11.54', '5.77'].sort(),
      );
      expect(
        await tx.payrollSourceClaim.count({
          where: { payrollRunId: run.id, kind: 'BENEFIT_DAY' },
        }),
      ).toBe(14);
    });
  });
});

/**
 * Committed data: a benefit change racing payroll finalization. Whatever the interleaving, the
 * outcome is one of the two serial orders — the change first (finalization refused as stale)
 * or finalization first (the finalized run keeps what it paid and the change shows as an
 * unresolved benefit difference) — never a finalized run that silently misses it.
 */
describe('Batch 7C benefits racing payroll finalization (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let w: World;
  let ben: Ben;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, USERS),
      { timeout: 60_000 },
    );
    const pay = payrollServices(prisma, new FixedPayrollClock());
    w = await world(prisma as unknown as Tx, fx, pay);
    ben = benefitsServices(prisma, new FixedBenefitsClock());
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  it('a rate correction and finalization at the same time end in a serial outcome', async () => {
    const { plan, single, admin: planAdmin } = await healthPlan(ben, fx);
    await ben.enrollments.enroll(
      {
        employmentAssignmentId: fx.otherTeamA,
        planId: plan.id,
        optionId: single.id,
        coverageStart: '2026-01-01',
      },
      ctx(fx.users.benefitsAdmin!),
    );
    const run = await w.svc.runs.createRun(
      { payrollPeriodId: w.periodId, currency: 'CAD' },
      w.admin,
    );
    await w.svc.runs.calculate(run.id, w.admin);
    await w.svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
    const rate = await prisma.benefitRate.findFirstOrThrow({
      where: { optionId: single.id, supersededAt: null },
    });
    const [finalized, corrected] = await Promise.allSettled([
      w.svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!)),
      ben.rates.correctRate(
        rate.id,
        { employeeAmount: '40.00', reason: 'Carrier invoice' },
        planAdmin,
      ),
    ]);
    expect(corrected.status).toBe('fulfilled');
    const stored = await prisma.payrollRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    if (finalized.status === 'fulfilled' && stored.status === 'FINALIZED') {
      // Finalization first: what it paid stays; the change waits for a person.
      expect(
        await deductions(prisma as unknown as Tx, run.id, fx.otherTeamA),
      ).toEqual(['11.54']);
      const item = (
        await w.svc.adjustments.retroPreview(run.id, fx.users.payrollReader!)
      ).items.find((row) => row.employmentAssignmentId === fx.otherTeamA)!;
      expect(item.warnings).toEqual(['BENEFIT_DIFFERENCE_UNRESOLVED']);
    } else {
      // The change first: finalization was refused as stale (approval withdrawn).
      expect(stored.status).toBe('CALCULATED');
      if (finalized.status === 'rejected') {
        expect((finalized.reason as HttpException).getResponse()).toMatchObject(
          { code: 'PAYROLL_RUN_STALE' },
        );
      }
    }
  });
});
