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
import {
  cleanupSchedulingFixtures,
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

async function configuredPlan(svc: BenefitsServices, fx: SchedulingFixtures) {
  const admin = ctx(fx.users.planAdmin!);
  const plan = await svc.plans.create(
    {
      organizationId: fx.orgA,
      code: 'DENTAL',
      name: 'Dental',
      benefitType: 'DENTAL',
      currency: 'CAD',
      effectiveFrom: '2026-01-01',
    },
    admin,
  );
  const single = await svc.plans.addOption(
    plan.id,
    { code: 'SINGLE', name: 'Single', coverageLevel: 'EMPLOYEE_ONLY' },
    admin,
  );
  const family = await svc.plans.addOption(
    plan.id,
    { code: 'FAMILY', name: 'Family', coverageLevel: 'FAMILY' },
    admin,
  );
  return { admin, plan, single, family };
}

const rate = (
  from: string,
  employee: string,
  employer: string,
  extra: Record<string, unknown> = {},
) => ({
  effectiveFrom: from,
  frequency: 'MONTHLY' as const,
  employeeAmount: employee,
  employerAmount: employer,
  ...extra,
});

describe('Benefit rates (database)', () => {
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

  it('keeps every amount that ever applied: changes close the previous rate', async () => {
    await scenario(async (tx, fx, svc) => {
      const { admin, plan, single, family } = await configuredPlan(svc, fx);
      expect(
        await failure(
          svc.rates.addRate(
            single.id,
            rate('2026-01-01', '10', '30'),
            ctx(fx.users.reader!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      const first = await svc.rates.addRate(
        single.id,
        rate('2026-01-01', '10', '30'),
        admin,
      );
      expect(first).toMatchObject({
        recordType: 'INITIAL',
        employeeAmount: '10.00',
        employerAmount: '30.00',
        currency: 'CAD',
        effectiveTo: null,
      });
      const raise = await svc.rates.addRate(
        single.id,
        rate('2026-07-01', '12.5', '31', { reason: 'Renewal' }),
        admin,
      );
      expect(raise.recordType).toBe('CHANGE');
      const rows = await tx.benefitRate.findMany({
        where: { optionId: single.id },
        orderBy: { effectiveFrom: 'asc' },
      });
      expect(
        rows.map((row) => [
          row.effectiveFrom.toISOString().slice(0, 10),
          row.effectiveTo?.toISOString().slice(0, 10) ?? null,
          row.employeeAmount.toFixed(2),
        ]),
      ).toEqual([
        ['2026-01-01', '2026-06-30', '10.00'],
        ['2026-07-01', null, '12.50'],
      ]);
      // Adding on or before an existing start is refused: that is a correction.
      expect(
        await failure(
          svc.rates.addRate(single.id, rate('2026-07-01', '1', '1'), admin),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_RATE_EXISTS' });
      expect(
        await failure(
          svc.rates.addRate(single.id, rate('2026-03-01', '1', '1'), admin),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_RATE_FUTURE_EXISTS' });
      // Outside the plan, invalid money.
      expect(
        await failure(
          svc.rates.addRate(family.id, rate('2025-12-01', '1', '1'), admin),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_RATE_OUTSIDE_PLAN' });
      expect(
        await failure(
          svc.rates.addRate(family.id, rate('2026-01-01', '-1', '1'), admin),
        ),
      ).toEqual({ status: 400, code: 'BENEFIT_AMOUNT_INVALID' });
      // Zero cost (an employer-paid-only or free benefit) is valid; a closed range too.
      await svc.rates.addRate(
        family.id,
        rate('2026-01-01', '0', '0', {
          effectiveTo: '2026-12-31',
          frequency: 'ANNUAL',
        }),
        admin,
      );
      const detail = await svc.plans.detail(fx.users.reader!, plan.id);
      expect(detail.rates).toHaveLength(3);
      expect(
        await tx.auditLog.count({
          where: { action: 'BENEFIT_RATE_ADDED', entityId: raise.id },
        }),
      ).toBe(1);
    });
  });

  it('corrects a rate by superseding it, preserving the wrong one as history', async () => {
    await scenario(async (tx, fx, svc) => {
      const { admin, single } = await configuredPlan(svc, fx);
      const first = await svc.rates.addRate(
        single.id,
        rate('2026-01-01', '10', '30'),
        admin,
      );
      const second = await svc.rates.addRate(
        single.id,
        rate('2026-07-01', '12', '30'),
        admin,
      );
      expect(
        await failure(svc.rates.correctRate(first.id, { reason: ' ' }, admin)),
      ).toEqual({ status: 400, code: 'BENEFIT_REASON_REQUIRED' });
      const fixed = await svc.rates.correctRate(
        first.id,
        { employeeAmount: '11.00', reason: 'Carrier invoice was 11.00' },
        admin,
      );
      expect(fixed).toMatchObject({
        recordType: 'CORRECTION',
        supersedesRateId: first.id,
        employeeAmount: '11.00',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-06-30',
      });
      // The superseded rate stays readable and frozen; it cannot be corrected twice.
      const old = await tx.benefitRate.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(old.supersededAt).not.toBeNull();
      expect(old.employeeAmount.toFixed(2)).toBe('10.00');
      expect(
        await failure(
          svc.rates.correctRate(first.id, { reason: 'again' }, admin),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_RATE_SUPERSEDED' });
      // Corrected dates may not overlap another rate.
      expect(
        await failure(
          svc.rates.correctRate(
            fixed.id,
            { effectiveTo: '2026-07-15', reason: 'x' },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_RATE_OVERLAP' });
      expect(
        await tx.benefitRate.count({
          where: { optionId: single.id, supersededAt: null },
        }),
      ).toBe(2);
      expect(second.id).toBeTruthy();
      expect(
        await tx.auditLog.count({
          where: { action: 'BENEFIT_RATE_CORRECTED', entityId: fixed.id },
        }),
      ).toBe(1);
    });
  });
});

describe('Benefit rate concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let svc: BenefitsServices;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, BENEFIT_USERS),
      {
        timeout: 60_000,
      },
    );
    svc = benefitsServices(prisma, new FixedBenefitsClock());
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  it('serializes concurrent rate changes of one option: one timeline, no overlap', async () => {
    const { admin, single } = await configuredPlan(svc, fx);
    await svc.rates.addRate(single.id, rate('2026-01-01', '10', '30'), admin);
    const outcomes = await Promise.allSettled([
      svc.rates.addRate(single.id, rate('2026-04-01', '11', '30'), admin),
      svc.rates.addRate(single.id, rate('2026-04-01', '12', '30'), admin),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rows = await prisma.benefitRate.findMany({
      where: { optionId: single.id, supersededAt: null },
      orderBy: { effectiveFrom: 'asc' },
    });
    expect(
      rows.map((row) => [
        row.effectiveFrom.toISOString().slice(0, 10),
        row.effectiveTo?.toISOString().slice(0, 10) ?? null,
      ]),
    ).toEqual([
      ['2026-01-01', '2026-03-31'],
      ['2026-04-01', null],
    ]);
  });
});
