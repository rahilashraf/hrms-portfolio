import type { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  BENEFIT_USERS,
  benefitsServices,
  FixedBenefitsClock,
  type BenefitsServices,
} from './support/benefits-fixtures.js';
import { d } from './support/payroll-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const failure = async (promise: Promise<unknown>) => {
  const error = (await rejection(promise)) as HttpException;
  const body = error.getResponse?.() as { code?: string } | undefined;
  return { status: error.getStatus?.(), code: body?.code };
};

/**
 * Fixtures: Employee 1 has assignmentTeamA (FULL_TIME, Team A in Dept A, under the child unit)
 * and assignmentDeptB (PART_TIME, Dept B). Employee 2 has otherTeamA (FULL_TIME) and orgLevel
 * (PART_TIME, no unit). Everyone was hired 2026-01-01; the clock is 2026-03-15.
 */
describe('Benefit eligibility (database)', () => {
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
      tx: Tx,
      fx: SchedulingFixtures,
      svc: BenefitsServices,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, BENEFIT_USERS);
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'America/Toronto' },
          });
          const svc = benefitsServices(
            rollbackClient(tx),
            new FixedBenefitsClock(),
          );
          await run(tx, fx, svc).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  async function activePlan(
    svc: BenefitsServices,
    fx: SchedulingFixtures,
    code: string,
  ) {
    const admin = ctx(fx.users.planAdmin!);
    const plan = await svc.plans.create(
      {
        organizationId: fx.orgA,
        code,
        name: code,
        benefitType: 'HEALTH',
        currency: 'CAD',
        effectiveFrom: '2026-01-01',
      },
      admin,
    );
    await svc.plans.addOption(
      plan.id,
      { code: 'SINGLE', name: 'Single', coverageLevel: 'EMPLOYEE_ONLY' },
      admin,
    );
    await svc.plans.transition(plan.id, 'ACTIVE', admin);
    return plan;
  }

  it('evaluates rules per assignment from Core HR facts', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.planAdmin!);
      await activePlan(svc, fx, 'OPEN');
      const fullTime = await activePlan(svc, fx, 'FULL-TIME');
      await svc.eligibility.addRule(
        fullTime.id,
        {
          effectiveFrom: '2026-01-01',
          employmentTypes: ['FULL_TIME'],
          organizationalUnitId: fx.unitRoot,
          minimumServiceDays: 60,
        },
        admin,
      );
      const result = await svc.eligibility.forAssignment(
        fx.users.reader!,
        fx.assignmentTeamA,
      );
      expect(result.date).toBe('2026-03-15');
      const byCode = Object.fromEntries(
        result.plans.map((plan) => [plan.code, plan]),
      );
      expect(byCode.OPEN!.eligibility.eligible).toBe(true);
      expect(byCode['FULL-TIME']!.eligibility).toMatchObject({
        eligible: true,
      });
      // Service is not yet long enough on Feb 28 (day 59).
      expect(
        (
          await svc.eligibility.forAssignment(
            fx.users.reader!,
            fx.assignmentTeamA,
            '2026-02-28',
          )
        ).plans.find((plan) => plan.code === 'FULL-TIME')!.eligibility.rules[0]!
          .failed,
      ).toEqual(['SERVICE']);
      // The part-time Dept B assignment of the same employee is not offered the full-time plan.
      const partTime = await svc.eligibility.forAssignment(
        fx.users.reader!,
        fx.assignmentDeptB,
      );
      const failed = partTime.plans.find(
        (plan) => plan.code === 'FULL-TIME',
      )!.eligibility;
      expect(failed.eligible).toBe(false);
      expect(failed.rules[0]!.failed).toEqual(['UNIT', 'EMPLOYMENT_TYPE']);
      // The engine's verdict matches the one used for elections.
      expect(
        (
          await svc.eligibility.evaluate(
            tx,
            fx.assignmentDeptB,
            fullTime.id,
            d('2026-03-15'),
          )
        ).eligible,
      ).toBe(false);
    });
  });

  it('keeps rule history: ended rules explain past eligibility', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.planAdmin!);
      const plan = await activePlan(svc, fx, 'DEPT-A');
      const rule = await svc.eligibility.addRule(
        plan.id,
        { effectiveFrom: '2026-01-01', departmentId: fx.deptA },
        admin,
      );
      await svc.eligibility.endRule(rule.id, '2026-02-28', admin);
      expect(
        await failure(svc.eligibility.endRule(rule.id, '2026-03-31', admin)),
      ).toEqual({ status: 400, code: 'BENEFIT_RULE_END_INVALID' });
      await svc.eligibility.addRule(
        plan.id,
        { effectiveFrom: '2026-03-01', departmentId: fx.deptB },
        admin,
      );
      const feb = await svc.eligibility.evaluate(
        tx,
        fx.assignmentTeamA,
        plan.id,
        d('2026-02-15'),
      );
      const mar = await svc.eligibility.evaluate(
        tx,
        fx.assignmentTeamA,
        plan.id,
        d('2026-03-15'),
      );
      expect([feb.eligible, mar.eligible]).toEqual([true, false]);
      expect(
        (
          await svc.eligibility.evaluate(
            tx,
            fx.assignmentDeptB,
            plan.id,
            d('2026-03-15'),
          )
        ).eligible,
      ).toBe(true);
      expect(
        await tx.auditLog.count({
          where: {
            action: {
              in: [
                'BENEFIT_ELIGIBILITY_RULE_ADDED',
                'BENEFIT_ELIGIBILITY_RULE_ENDED',
              ],
            },
            entityId: rule.id,
          },
        }),
      ).toBe(2);
    });
  });

  it('guards rule targets, permissions and self-service', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.planAdmin!);
      const plan = await activePlan(svc, fx, 'GUARDED');
      const orgBUnit = await tx.organizationalUnit.create({
        data: { organizationId: fx.orgB, name: 'B', code: `UB${fx.suffix}` },
      });
      expect(
        await failure(
          svc.eligibility.addRule(
            plan.id,
            { effectiveFrom: '2026-01-01', organizationalUnitId: orgBUnit.id },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'BENEFIT_ELIGIBILITY_TARGET_INVALID' });
      expect(
        await failure(
          svc.eligibility.addRule(
            plan.id,
            { effectiveFrom: '2026-01-01' },
            ctx(fx.users.reader!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      // Reads need benefit.read on the assignment: HR and other-team managers are refused.
      expect(
        await failure(
          svc.eligibility.forAssignment(fx.users.hr!, fx.assignmentTeamA),
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(
          svc.eligibility.forAssignment(
            fx.users.teamManager!,
            fx.assignmentDeptB,
          ),
        ),
      ).toMatchObject({ status: 403 });
      await svc.eligibility.forAssignment(
        fx.users.teamManager!,
        fx.assignmentTeamA,
      );
      // Self-service: one's own assignments and their eligible active plans only.
      const mine = await svc.eligibility.mine(fx.selfUser1);
      expect(mine.items.map((item) => item.assignmentId).sort()).toEqual(
        [fx.assignmentTeamA, fx.assignmentDeptB].sort(),
      );
      expect(mine.items[0]!.plans.map((p) => p.code)).toEqual(['GUARDED']);
      expect(await failure(svc.eligibility.mine(fx.users.reader!))).toEqual({
        status: 403,
        code: 'BENEFIT_NOT_AN_EMPLOYEE',
      });
    });
  });
});
