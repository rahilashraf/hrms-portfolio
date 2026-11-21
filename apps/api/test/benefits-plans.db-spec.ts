import type { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  BENEFIT_USERS,
  benefitsServices,
  election,
  FixedBenefitsClock,
  type BenefitsServices,
} from './support/benefits-fixtures.js';
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

const planInput = (fx: SchedulingFixtures, overrides = {}) => ({
  organizationId: fx.orgA,
  code: 'health-basic',
  name: 'Basic health',
  benefitType: 'HEALTH' as const,
  currency: 'cad',
  effectiveFrom: '2026-01-01',
  providerName: 'Example Insurance',
  dependentChildMaxAge: 21,
  ...overrides,
});

describe('Benefit plans and options (database)', () => {
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

  it('configures a plan through its lifecycle with organization-scoped permission', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.planAdmin!);
      // Only benefit.plan.manage at the organization configures plans.
      for (const user of [
        'reader',
        'teamManager',
        'teamPlanManage',
        'hr',
        'orgBAdmin',
      ]) {
        expect(
          await failure(svc.plans.create(planInput(fx), ctx(fx.users[user]!))),
        ).toMatchObject({ status: 403 });
      }
      const plan = await svc.plans.create(planInput(fx), admin);
      expect(plan).toMatchObject({
        code: 'HEALTH-BASIC',
        currency: 'CAD',
        status: 'DRAFT',
        dependentChildMaxAge: 21,
      });
      expect(await failure(svc.plans.create(planInput(fx), admin))).toEqual({
        status: 409,
        code: 'BENEFIT_PLAN_CODE_TAKEN',
      });
      expect(
        await failure(
          svc.plans.create(
            planInput(fx, { code: 'X2', currency: 'ZZZ' }),
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'BENEFIT_CURRENCY_INVALID' });
      expect(
        await failure(
          svc.plans.create(
            planInput(fx, { code: 'X3', effectiveTo: '2025-12-31' }),
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'BENEFIT_DATE_RANGE_INVALID' });

      // Activation needs a coverage option.
      expect(
        await failure(svc.plans.transition(plan.id, 'ACTIVE', admin)),
      ).toEqual({
        status: 409,
        code: 'BENEFIT_PLAN_HAS_NO_OPTIONS',
      });
      const single = await svc.plans.addOption(
        plan.id,
        {
          code: 'single',
          name: 'Employee only',
          coverageLevel: 'EMPLOYEE_ONLY',
        },
        admin,
      );
      await svc.plans.addOption(
        plan.id,
        {
          code: 'family',
          name: 'Family',
          coverageLevel: 'FAMILY',
          sortOrder: 2,
        },
        admin,
      );
      expect(
        await failure(
          svc.plans.addOption(
            plan.id,
            { code: 'SINGLE', name: 'Dup', coverageLevel: 'EMPLOYEE_ONLY' },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_OPTION_CODE_TAKEN' });
      // A draft's start moves; an active plan's does not.
      await svc.plans.update(plan.id, { effectiveFrom: '2026-02-01' }, admin);
      await svc.plans.transition(plan.id, 'ACTIVE', admin);
      expect(
        await failure(
          svc.plans.update(plan.id, { effectiveFrom: '2026-01-01' }, admin),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_PLAN_NOT_DRAFT' });
      await svc.plans.update(
        plan.id,
        { name: 'Health', providerReference: 'GRP-1' },
        admin,
      );
      await svc.plans.transition(plan.id, 'CLOSED', admin);
      expect(
        await failure(svc.plans.transition(plan.id, 'CLOSED', admin)),
      ).toEqual({
        status: 409,
        code: 'BENEFIT_PLAN_STATUS',
      });
      await svc.plans.transition(plan.id, 'ACTIVE', admin);

      // Reads: any benefit permission reaching into the organization; never HR or another org.
      for (const user of ['reader', 'teamManager', 'planAdmin']) {
        const list = await svc.plans.list(fx.users[user]!, {
          organizationId: fx.orgA,
        });
        expect(list.items.map((item) => item.code)).toEqual(['HEALTH-BASIC']);
      }
      expect(
        (await svc.plans.list(fx.users.reader!, { organizationId: fx.orgA }))
          .items[0]!.actions.canEdit,
      ).toBe(false);
      for (const user of ['hr', 'orgBAdmin']) {
        expect(
          await failure(
            svc.plans.list(fx.users[user]!, { organizationId: fx.orgA }),
          ),
        ).toMatchObject({ status: 403 });
      }
      const detail = await svc.plans.detail(fx.users.reader!, plan.id);
      expect(detail.options.map((option) => option.code)).toEqual([
        'SINGLE',
        'FAMILY',
      ]);
      expect(detail).toMatchObject({
        name: 'Health',
        providerReference: 'GRP-1',
        status: 'ACTIVE',
      });
      expect(
        (await svc.access.organizations(fx.users.teamManager!)).items.map(
          (org) => org.id,
        ),
      ).toEqual([fx.orgA]);

      // An option or plan with current coverage cannot be archived; history keeps it.
      await election(tx, fx, {
        planId: plan.id,
        optionId: single.id,
        coverageStart: '2026-03-01',
      });
      expect(await failure(svc.plans.archiveOption(single.id, admin))).toEqual({
        status: 409,
        code: 'BENEFIT_OPTION_HAS_COVERAGE',
      });
      expect(await failure(svc.plans.archive(plan.id, admin))).toEqual({
        status: 409,
        code: 'BENEFIT_PLAN_HAS_COVERAGE',
      });
      expect(
        await tx.auditLog.count({
          where: { entityId: plan.id, action: { startsWith: 'BENEFIT_PLAN_' } },
        }),
      ).toBe(6);
    });
  });

  it('archives plans and options once their coverage is in the past', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.planAdmin!);
      const plan = await svc.plans.create(planInput(fx), admin);
      const option = await svc.plans.addOption(
        plan.id,
        { code: 'single', name: 'Single', coverageLevel: 'EMPLOYEE_ONLY' },
        admin,
      );
      const spare = await svc.plans.addOption(
        plan.id,
        { code: 'spare', name: 'Spare', coverageLevel: 'CUSTOM' },
        admin,
      );
      await svc.plans.transition(plan.id, 'ACTIVE', admin);
      await svc.plans.archiveOption(spare.id, admin);
      expect(
        await failure(
          svc.plans.updateOption(spare.id, { name: 'Again' }, admin),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_ARCHIVED' });
      // Coverage that ended before today (clock: 2026-03-15) does not hold the plan.
      await election(tx, fx, {
        planId: plan.id,
        optionId: option.id,
        coverageStart: '2026-01-01',
        coverageEnd: '2026-02-28',
      });
      const archived = await svc.plans.archive(plan.id, admin);
      expect(archived).toMatchObject({ archived: true, status: 'CLOSED' });
      expect(
        (await svc.plans.list(fx.users.reader!, { organizationId: fx.orgA }))
          .items,
      ).toEqual([]);
      expect(
        (
          await svc.plans.list(fx.users.reader!, {
            organizationId: fx.orgA,
            includeArchived: true,
          })
        ).items.map((item) => item.archived),
      ).toEqual([true]);
      expect(
        await failure(svc.plans.update(plan.id, { name: 'X' }, admin)),
      ).toEqual({
        status: 409,
        code: 'BENEFIT_ARCHIVED',
      });
      // History stays readable.
      expect(
        (await svc.plans.detail(fx.users.reader!, plan.id)).options,
      ).toHaveLength(2);
    });
  });
});
