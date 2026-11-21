import type { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BenefitOptionsService } from '../src/benefits/benefit-options.service.js';
import { BenefitsAccessService } from '../src/benefits/benefits-access.service.js';
import { benefitConstraintCode } from '../src/benefits/benefits-constraint.filter.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import {
  BENEFIT_PERMISSION_KEYS,
  BENEFIT_USERS,
  benefitsServices,
  FixedBenefitsClock,
  healthPlan,
  type BenefitsServices,
} from './support/benefits-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  ...BENEFIT_USERS,
  self1: [{ permissions: BENEFIT_PERMISSION_KEYS, scope: 'org' as const }],
};

const failure = async (promise: Promise<unknown>) => {
  const error = (await rejection(promise)) as HttpException;
  const body = error.getResponse?.() as { code?: string } | undefined;
  return { status: error.getStatus?.(), code: body?.code };
};

/**
 * Batch 7C — Benefits functional fixes and API additions: action flags that match the service
 * (B13), rate gaps (B17), trigger refusals as conflicts (B11), named eligibility rules and the
 * picker options (C7), and the audit's minor findings. Clock: 2026-03-15 (Toronto).
 */
describe('Batch 7C benefits backend (database)', () => {
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
      clock: FixedBenefitsClock,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'America/Toronto' },
          });
          const clock = new FixedBenefitsClock();
          const svc = benefitsServices(rollbackClient(tx), clock);
          await run(tx, fx, svc, clock).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('B13: plan, option, rate and election flags match what the service accepts', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.planAdmin!);
      const draft = await svc.plans.create(
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
      // No option yet: activation is not offered (and is refused).
      expect(
        (await svc.plans.detail(fx.users.planAdmin!, draft.id)).actions,
      ).toMatchObject({
        canActivate: false,
        canEditStart: true,
        canArchive: true,
      });
      expect(
        await failure(svc.plans.transition(draft.id, 'ACTIVE', admin)),
      ).toMatchObject({ status: 409 });
      const { plan, single, family } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const election = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        hr,
      );
      const detail = await svc.plans.detail(fx.users.planAdmin!, plan.id);
      // Live coverage: archiving is not offered (and is refused).
      expect(detail.actions).toMatchObject({
        canArchive: false,
        canEditStart: false,
      });
      expect(await failure(svc.plans.archive(plan.id, admin))).toMatchObject({
        status: 409,
      });
      expect(
        detail.rates.every(
          (rate) => rate.actions.canCorrect === !rate.supersededAt,
        ),
      ).toBe(true);
      // Employee 2 has a second assignment (organization level) to move to.
      const asHr = await svc.enrollments.employee(
        fx.users.benefitsAdmin!,
        fx.employee2,
      );
      expect(asHr.items[0]!.actions).toMatchObject({
        canChange: true,
        canTransfer: true,
        canCorrect: true,
      });
      // A Team A manager reaches no other assignment of Employee 2: no transfer offered.
      const asTeam = await svc.enrollments.employee(
        fx.users.teamManager!,
        fx.employee2,
      );
      expect(asTeam.items[0]!.actions).toMatchObject({ canTransfer: false });
      // An archived dependent on the election: correction is not offered (it would be refused).
      const spouse = await svc.dependents.create(
        fx.employee2,
        { firstName: 'Sam', lastName: 'Spouse', relationship: 'SPOUSE' },
        hr,
      );
      const withSpouse = await svc.enrollments.change(
        election.id,
        {
          effectiveDate: '2026-03-01',
          optionId: family.id,
          dependentIds: [spouse.id],
        },
        hr,
      );
      await svc.enrollments.end(
        withSpouse.id,
        { coverageEnd: '2026-03-10', reason: 'Separation' },
        hr,
      );
      await svc.dependents.archive(spouse.id, hr);
      const after = (
        await svc.enrollments.employee(fx.users.benefitsAdmin!, fx.employee2)
      ).items.find((row) => row.id === withSpouse.id)!;
      expect(after.actions).toMatchObject({ canCorrect: false });
      expect(
        await failure(
          svc.enrollments.correct(
            withSpouse.id,
            { reason: 'Wrong end', coverageEnd: '2026-03-09' },
            hr,
          ),
        ),
      ).toMatchObject({ status: 409 });
    });
  });

  it('B17: a gap with no rate is filled by a rate that fits in it', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.planAdmin!);
      const plan = await svc.plans.create(
        {
          organizationId: fx.orgA,
          code: 'VISION',
          name: 'Vision',
          benefitType: 'VISION',
          currency: 'CAD',
          effectiveFrom: '2026-01-01',
        },
        admin,
      );
      const option = await svc.plans.addOption(
        plan.id,
        { code: 'SINGLE', name: 'Single', coverageLevel: 'EMPLOYEE_ONLY' },
        admin,
      );
      const rate = (from: string, to: string | null, amount: string) =>
        svc.rates.addRate(
          option.id,
          {
            effectiveFrom: from,
            effectiveTo: to,
            frequency: 'MONTHLY',
            employeeAmount: amount,
            employerAmount: '0',
          },
          admin,
        );
      // A rate from April only: January–March has none.
      await rate('2026-04-01', null, '10');
      expect(await failure(rate('2026-01-01', null, '8'))).toEqual({
        status: 409,
        code: 'BENEFIT_RATE_GAP_EXCEEDED',
      });
      expect(await failure(rate('2026-01-01', '2026-04-15', '8'))).toEqual({
        status: 409,
        code: 'BENEFIT_RATE_GAP_EXCEEDED',
      });
      await rate('2026-01-01', '2026-03-31', '8');
      const rates = await tx.benefitRate.findMany({
        where: { optionId: option.id, supersededAt: null },
        orderBy: { effectiveFrom: 'asc' },
      });
      expect(
        rates.map((r) => [
          r.effectiveFrom.toISOString().slice(0, 10),
          r.effectiveTo?.toISOString().slice(0, 10) ?? null,
          r.employeeAmount.toFixed(2),
        ]),
      ).toEqual([
        ['2026-01-01', '2026-03-31', '8.00'],
        ['2026-04-01', null, '10.00'],
      ]);
      // Covered dates still refuse a second rate (overlap rules hold).
      expect(
        await failure(rate('2026-02-01', '2026-02-28', '9')),
      ).toMatchObject({ status: 409 });
    });
  });

  it('B11: a draft plan’s start never passes its rates; trigger refusals map to conflicts', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.planAdmin!);
      const plan = await svc.plans.create(
        {
          organizationId: fx.orgA,
          code: 'LIFE',
          name: 'Life',
          benefitType: 'LIFE',
          currency: 'CAD',
          effectiveFrom: '2026-01-01',
        },
        admin,
      );
      const option = await svc.plans.addOption(
        plan.id,
        { code: 'BASIC', name: 'Basic', coverageLevel: 'EMPLOYEE_ONLY' },
        admin,
      );
      await svc.rates.addRate(
        option.id,
        {
          effectiveFrom: '2026-01-01',
          frequency: 'MONTHLY',
          employeeAmount: '5',
          employerAmount: '5',
        },
        admin,
      );
      expect(
        await failure(
          svc.plans.update(plan.id, { effectiveFrom: '2026-02-01' }, admin),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_PLAN_START_AFTER_RATE' });
      // The database's own refusal (here forced past the service) is a known conflict.
      const error = await violation(tx, () =>
        tx.benefitRate.create({
          data: {
            planId: plan.id,
            optionId: option.id,
            effectiveFrom: new Date('2025-06-01T00:00:00Z'),
            frequency: 'MONTHLY',
            employeeAmount: '1',
            employerAmount: '1',
            recordType: 'CHANGE',
          },
        }),
      );
      expect(benefitConstraintCode(error)).toBe('BENEFIT_RATE_OUTSIDE_PLAN');
      // Anything else is not mapped (it stays a server error).
      expect(
        benefitConstraintCode(
          new Prisma.PrismaClientKnownRequestError('connection reset', {
            code: 'P1001',
            clientVersion: 'x',
          }),
        ),
      ).toBeNull();
      expect(
        benefitConstraintCode(
          new Error("A benefit rate must stay within its plan's dates"),
        ),
      ).toBeNull();
    });
  });

  it('C7: picker options are module-scoped, named and never the caller’s own', async () => {
    await scenario(async (tx, fx, svc) => {
      const authorization = new AuthorizationService(rollbackClient(tx));
      const access = new BenefitsAccessService(
        rollbackClient(tx),
        authorization,
      );
      const options = new BenefitOptionsService(rollbackClient(tx), access);
      const q = (
        kind: 'employee' | 'assignment' | 'unit' | 'department' | 'position',
        extra = {},
      ) => ({
        organizationId: fx.orgA,
        kind,
        ...extra,
      });
      const ids = (page: { items: Array<{ id: string }> }) =>
        page.items.map((item) => item.id).sort();
      // A Team A manager: Team A assignments only.
      expect(
        ids(await options.options(fx.users.teamManager!, q('assignment'))),
      ).toEqual([fx.assignmentTeamA, fx.otherTeamA].sort());
      // Employee 1 (self1, a benefits administrator) never sees their own assignments.
      const own = ids(await options.options(fx.selfUser1, q('assignment')));
      expect(own).not.toContain(fx.assignmentTeamA);
      expect(own).toContain(fx.otherTeamA);
      // Transfer targets: one employee's assignments.
      expect(
        ids(
          await options.options(
            fx.users.benefitsAdmin!,
            q('assignment', { employeeId: fx.employee2 }),
          ),
        ),
      ).toEqual([fx.otherTeamA, fx.orgLevel].sort());
      // Structures for eligibility rules: plan managers only.
      const departments = await options.options(
        fx.users.planAdmin!,
        q('department'),
      );
      expect(ids(departments)).toEqual([fx.deptA, fx.deptB].sort());
      expect(departments.items[0]).toHaveProperty('label');
      expect(
        await failure(options.options(fx.users.reader!, q('unit'))),
      ).toEqual({ status: 403, code: 'BENEFIT_PERMISSION_REQUIRED' });
      expect(
        await failure(options.options(fx.users.reader!, q('assignment'))),
      ).toEqual({ status: 403, code: 'BENEFIT_PERMISSION_REQUIRED' });
      expect(
        await failure(options.options(fx.users.orgBAdmin!, q('position'))),
      ).toEqual({ status: 403, code: 'BENEFIT_PERMISSION_REQUIRED' });
      // Finding an employee's benefits: benefit.read is enough; never oneself; scoped.
      expect(
        ids(await options.options(fx.users.reader!, q('employee'))),
      ).toEqual([fx.employee1, fx.employee2].sort());
      expect(ids(await options.options(fx.selfUser1, q('employee')))).toEqual([
        fx.employee2,
      ]);
      expect(
        await failure(options.options(fx.users.orgBAdmin!, q('employee'))),
      ).toEqual({ status: 403, code: 'BENEFIT_PERMISSION_REQUIRED' });
      // Rules carry the names of their criteria.
      const { plan, admin } = await healthPlan(svc, fx);
      await svc.eligibility.addRule(
        plan.id,
        { effectiveFrom: '2026-01-01', departmentId: fx.deptA },
        admin,
      );
      expect(
        (await svc.plans.detail(fx.users.planAdmin!, plan.id))
          .eligibilityRules[0],
      ).toMatchObject({ departmentId: fx.deptA, departmentName: 'Dept A' });
    });
  });

  it('minor findings: local birth dates, INITIAL after a rescind, one spouse per coverage, plan-status messages', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const hr = ctx(fx.users.benefitsAdmin!);
      // 2026-03-16 01:00 in Tokyo is still 2026-03-15 in UTC: a birth "today" east of UTC.
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'Asia/Tokyo' },
      });
      await tx.workLocation.updateMany({
        where: { organizationId: fx.orgA },
        data: { timezone: 'Asia/Tokyo' },
      });
      clock.value = new Date('2026-03-15T16:00:00.000Z');
      await svc.dependents.create(
        fx.employee1,
        {
          firstName: 'New',
          lastName: 'Born',
          relationship: 'CHILD',
          dateOfBirth: '2026-03-16',
        },
        hr,
      );
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'America/Toronto' },
      });
      await tx.workLocation.updateMany({
        where: { organizationId: fx.orgA },
        data: { timezone: 'America/Toronto' },
      });
      const { plan, single, family, admin } = await healthPlan(svc, fx);
      const enroll = (optionId: string, dependentIds: string[] = []) =>
        svc.enrollments.enroll(
          {
            employmentAssignmentId: fx.otherTeamA,
            planId: plan.id,
            optionId,
            coverageStart: '2026-02-01',
            dependentIds,
          },
          hr,
        );
      const mistaken = await enroll(single.id);
      await svc.enrollments.rescind(mistaken.id, { reason: 'Wrong plan' }, hr);
      const fresh = await enroll(single.id);
      expect(
        (
          await tx.benefitEnrollment.findUniqueOrThrow({
            where: { id: fresh.id },
          })
        ).recordType,
      ).toBe('INITIAL');
      await svc.enrollments.rescind(fresh.id, { reason: 'Redo' }, hr);
      // Two spouses are never covered by one election.
      const spouses = [];
      for (const firstName of ['Ana', 'Bea']) {
        spouses.push(
          await svc.dependents.create(
            fx.employee2,
            { firstName, lastName: 'Spouse', relationship: 'SPOUSE' },
            hr,
          ),
        );
      }
      expect(
        await failure(
          enroll(
            family.id,
            spouses.map((s) => s.id),
          ),
        ),
      ).toMatchObject({ status: 400 });
      // A draft plan says it is a draft.
      const draft = await svc.plans.create(
        {
          organizationId: fx.orgA,
          code: 'DRAFT',
          name: 'Draft',
          benefitType: 'OTHER',
          currency: 'CAD',
          effectiveFrom: '2026-01-01',
        },
        admin,
      );
      const refused = (await rejection(
        svc.enrollments.waive(
          {
            employmentAssignmentId: fx.otherTeamA,
            planId: draft.id,
            coverageStart: '2026-02-01',
          },
          hr,
        ),
      )) as HttpException;
      expect(refused.getResponse()).toMatchObject({
        code: 'BENEFIT_PLAN_NOT_ACCEPTING',
        message: expect.stringContaining('draft') as unknown,
      });
    });
  });
});
