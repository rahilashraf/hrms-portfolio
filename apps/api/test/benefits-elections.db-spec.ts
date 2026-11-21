import type { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  BENEFIT_PERMISSION_KEYS,
  BENEFIT_USERS,
  benefitsServices,
  FixedBenefitsClock,
  healthPlan,
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

/** Employee 2 (self2) is also a benefits administrator: nobody manages their own benefits. */
const USERS = {
  ...BENEFIT_USERS,
  self2: [{ permissions: BENEFIT_PERMISSION_KEYS, scope: 'org' as const }],
};

const failure = async (promise: Promise<unknown>) => {
  const error = (await rejection(promise)) as HttpException;
  const body = error.getResponse?.() as { code?: string } | undefined;
  return { status: error.getStatus?.(), code: body?.code };
};

describe('Benefit dependents and elections (database)', () => {
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
          const fx = await createSchedulingFixtures(tx, USERS);
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

  it('enrolls an employee once per plan across assignments, with matching dependents', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single, family } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const spouse = await svc.dependents.create(
        fx.employee1,
        { firstName: 'Sam', lastName: 'Spouse', relationship: 'SPOUSE' },
        hr,
      );
      const child = await svc.dependents.create(
        fx.employee1,
        {
          firstName: 'Kid',
          lastName: 'One',
          relationship: 'CHILD',
          dateOfBirth: '2015-05-01',
        },
        hr,
      );
      const adult = await svc.dependents.create(
        fx.employee1,
        {
          firstName: 'Old',
          lastName: 'Kid',
          relationship: 'CHILD',
          dateOfBirth: '2000-01-01',
        },
        hr,
      );
      const otherChild = await svc.dependents.create(
        fx.employee2,
        {
          firstName: 'Not',
          lastName: 'Mine',
          relationship: 'CHILD',
          dateOfBirth: '2016-01-01',
        },
        hr,
      );
      const base = {
        employmentAssignmentId: fx.assignmentTeamA,
        planId: plan.id,
        coverageStart: '2026-04-01',
      };
      expect(
        await failure(
          svc.enrollments.enroll(
            { ...base, optionId: single.id, dependentIds: [child.id] },
            hr,
          ),
        ),
      ).toEqual({ status: 400, code: 'BENEFIT_DEPENDENTS_MISMATCH' });
      expect(
        await failure(
          svc.enrollments.enroll(
            { ...base, optionId: family.id, dependentIds: [otherChild.id] },
            hr,
          ),
        ),
      ).toEqual({ status: 400, code: 'BENEFIT_DEPENDENT_NOT_FOUND' });
      expect(
        await failure(
          svc.enrollments.enroll(
            { ...base, optionId: family.id, dependentIds: [adult.id] },
            hr,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_DEPENDENT_INELIGIBLE' });

      const enrolled = await svc.enrollments.enroll(
        {
          ...base,
          optionId: family.id,
          dependentIds: [spouse.id, child.id],
          reason: 'New hire',
        },
        hr,
      );
      expect(enrolled).toMatchObject({
        status: 'PENDING',
        electionType: 'ENROLLED',
        recordType: 'INITIAL',
        coverageStart: '2026-04-01',
        coverageEnd: null,
        electedOn: '2026-03-15',
        cost: {
          frequency: 'MONTHLY',
          employeeAmount: '25.00',
          employerAmount: '75.00',
          currency: 'CAD',
        },
      });
      expect(enrolled.dependents.map((d) => d.relationship).sort()).toEqual([
        'CHILD',
        'SPOUSE',
      ]);

      // One timeline per employee and plan: not again through the second assignment, nor waived.
      expect(
        await failure(
          svc.enrollments.enroll(
            {
              ...base,
              employmentAssignmentId: fx.assignmentDeptB,
              optionId: single.id,
              eligibilityOverrideReason: 'x',
            },
            hr,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_ELECTION_OVERLAP' });
      expect(
        await failure(
          svc.enrollments.waive({ ...base, coverageStart: '2026-06-01' }, hr),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_ELECTION_OVERLAP' });
      // Another employee has their own timeline; an earlier waiver segment fits before.
      await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-04-01',
        },
        hr,
      );
      const waived = await svc.enrollments.waive(
        {
          ...base,
          coverageStart: '2026-01-01',
          coverageEnd: '2026-03-31',
          reason: 'Spouse plan',
        },
        hr,
      );
      expect(waived).toMatchObject({
        status: 'WAIVED',
        recordType: 'CHANGE',
        option: null,
        cost: null,
      });
      expect(
        await tx.auditLog.count({
          where: {
            action: { in: ['BENEFIT_ENROLLED', 'BENEFIT_WAIVED'] },
            entityId: { in: [enrolled.id, waived.id] },
          },
        }),
      ).toBe(2);
      // Audit metadata of dependents never carries personal data.
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'BENEFIT_DEPENDENT_ADDED', entityId: child.id },
      });
      expect(JSON.stringify(audit.metadata)).not.toMatch(/Kid|2015/);
    });
  });

  it('checks eligibility, rates, plan state, organization and dates before electing', async () => {
    await scenario(async (tx, fx, svc) => {
      const { admin, plan, single } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      await svc.eligibility.addRule(
        plan.id,
        { effectiveFrom: '2026-01-01', employmentTypes: ['FULL_TIME'] },
        admin,
      );
      const partTime = {
        employmentAssignmentId: fx.assignmentDeptB,
        planId: plan.id,
        optionId: single.id,
        coverageStart: '2026-04-01',
      };
      const notEligible = (await rejection(
        svc.enrollments.enroll(partTime, hr),
      )) as HttpException;
      expect(notEligible.getResponse()).toMatchObject({
        code: 'BENEFIT_NOT_ELIGIBLE',
        reasons: ['NO_MATCHING_RULE'],
      });
      const overridden = await svc.enrollments.enroll(
        {
          ...partTime,
          eligibilityOverrideReason: 'Collective agreement exception',
        },
        hr,
      );
      expect(overridden.eligibilityOverrideReason).toBe(
        'Collective agreement exception',
      );

      const extra = await svc.plans.addOption(
        plan.id,
        { code: 'NO-RATE', name: 'No rate', coverageLevel: 'CUSTOM' },
        admin,
      );
      expect(
        await failure(
          svc.enrollments.enroll(
            {
              employmentAssignmentId: fx.otherTeamA,
              planId: plan.id,
              optionId: extra.id,
              coverageStart: '2026-04-01',
            },
            hr,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_RATE_MISSING' });
      expect(
        await failure(
          svc.enrollments.enroll(
            {
              employmentAssignmentId: fx.otherTeamA,
              planId: plan.id,
              optionId: single.id,
              coverageStart: '2025-12-01',
            },
            hr,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_COVERAGE_OUTSIDE_PLAN' });
      await svc.plans.transition(plan.id, 'CLOSED', admin);
      expect(
        await failure(
          svc.enrollments.waive(
            {
              employmentAssignmentId: fx.otherTeamA,
              planId: plan.id,
              coverageStart: '2026-04-01',
            },
            hr,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_PLAN_NOT_ACCEPTING' });
      const orgB = await svc.plans.create(
        {
          organizationId: fx.orgB,
          code: 'B-HEALTH',
          name: 'B',
          benefitType: 'HEALTH',
          currency: 'CAD',
          effectiveFrom: '2026-01-01',
        },
        ctx(fx.users.orgBAdmin!),
      );
      expect(
        await failure(
          svc.enrollments.waive(
            {
              employmentAssignmentId: fx.otherTeamA,
              planId: orgB.id,
              coverageStart: '2026-04-01',
            },
            hr,
          ),
        ),
        // Batch 7C (B1): a plan of an organization the caller has nothing to do with reads as
        // missing (was 400 BENEFIT_PLAN_OTHER_ORGANIZATION, which disclosed it exists).
      ).toEqual({ status: 404, code: undefined });
      expect(
        await tx.benefitEnrollment.count({ where: { planId: plan.id } }),
      ).toBe(1);
    });
  });

  it('scopes reads and writes to the sponsoring assignment, never one’s own', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single, family } = await healthPlan(svc, fx);
      const enroll = (user: string, assignment: string, start = '2026-04-01') =>
        svc.enrollments.enroll(
          {
            employmentAssignmentId: assignment,
            planId: plan.id,
            optionId: single.id,
            coverageStart: start,
          },
          ctx(fx.users[user] ?? user),
        );
      expect(await failure(enroll('reader', fx.assignmentTeamA))).toMatchObject(
        { status: 403 },
      );
      expect(await failure(enroll('hr', fx.assignmentTeamA))).toMatchObject({
        status: 403,
      });
      expect(
        await failure(enroll('teamManager', fx.assignmentDeptB)),
      ).toMatchObject({ status: 403 });
      expect(await failure(enroll(fx.selfUser2, fx.otherTeamA))).toEqual({
        status: 403,
        code: 'BENEFIT_SELF_MANAGEMENT',
      });
      // Employee 1: one plan through Team A (team manager's scope), one through Dept B.
      await enroll('teamManager', fx.assignmentTeamA);
      const { plan: dental, single: dentalSingle } = await healthPlan(
        svc,
        fx,
        'DENTAL',
      );
      await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentDeptB,
          planId: dental.id,
          optionId: dentalSingle.id,
          coverageStart: '2026-04-01',
        },
        ctx(fx.users.benefitsAdmin!),
      );
      const asReader = await svc.enrollments.employee(
        fx.users.reader!,
        fx.employee1,
      );
      expect(asReader.items.map((item) => item.plan.code).sort()).toEqual([
        'DENTAL',
        'HEALTH',
      ]);
      const asTeam = await svc.enrollments.employee(
        fx.users.teamManager!,
        fx.employee1,
      );
      expect(asTeam.items.map((item) => item.plan.code)).toEqual(['HEALTH']);
      expect(asTeam.items[0]!.actions.canChange).toBe(true);
      expect(asReader.items[0]!.actions.canChange).toBe(false);
      expect(
        await failure(svc.enrollments.employee(fx.users.hr!, fx.employee1)),
      ).toMatchObject({
        status: 403,
      });
      // Self-service: own elections, no HR notes; employer cost only when the plan shows it.
      await tx.benefitPlan.update({
        where: { id: plan.id },
        data: { showEmployerCostToEmployee: false },
      });
      const mine = await svc.enrollments.mine(fx.selfUser1);
      const health = mine.items.find((item) => item.plan.code === 'HEALTH')!;
      expect(health.cost).toMatchObject({
        employeeAmount: '25.00',
        employerAmount: null,
      });
      expect(health).not.toHaveProperty('eligibilityOverrideReason');
      expect(
        mine.items.find((item) => item.plan.code === 'DENTAL')!.cost!
          .employerAmount,
      ).toBe('75.00');
      expect((await svc.enrollments.mine(fx.selfUser2)).items).toEqual([]);
      expect(await failure(svc.enrollments.mine(fx.users.reader!))).toEqual({
        status: 403,
        code: 'BENEFIT_NOT_AN_EMPLOYEE',
      });
      expect(family.code).toBe('FAMILY');
    });
  });

  it('maintains dependents without rewriting what coverage relied on', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, family } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      expect(
        await failure(
          svc.dependents.create(
            fx.employee2,
            { firstName: 'A', lastName: 'B', relationship: 'SPOUSE' },
            ctx(fx.selfUser2),
          ),
        ),
      ).toEqual({ status: 403, code: 'BENEFIT_SELF_MANAGEMENT' });
      expect(
        await failure(
          svc.dependents.create(
            fx.employee1,
            { firstName: 'A', lastName: 'B', relationship: 'CHILD' },
            hr,
          ),
        ),
      ).toEqual({ status: 400, code: 'BENEFIT_DEPENDENT_BIRTH_DATE_REQUIRED' });
      const spouse = await svc.dependents.create(
        fx.employee1,
        { firstName: 'Sam', lastName: 'Spouse', relationship: 'SPOUSE' },
        hr,
      );
      await svc.dependents.update(spouse.id, { relationship: 'OTHER' }, hr);
      await svc.dependents.update(
        spouse.id,
        { relationship: 'SPOUSE', lastName: 'Partner' },
        hr,
      );
      await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: family.id,
          dependentIds: [spouse.id],
          coverageStart: '2026-03-01',
        },
        hr,
      );
      expect(
        await failure(
          svc.dependents.update(spouse.id, { relationship: 'OTHER' }, hr),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_DEPENDENT_RELATIONSHIP_FIXED' });
      expect(await failure(svc.dependents.archive(spouse.id, hr))).toEqual({
        status: 409,
        code: 'BENEFIT_DEPENDENT_COVERED',
      });
      const list = await svc.dependents.list(fx.users.reader!, fx.employee1);
      expect(list).toMatchObject({ canManage: false });
      expect(list.items.map((item) => item.lastName)).toEqual(['Partner']);
      expect((await svc.dependents.mine(fx.selfUser1)).items).toHaveLength(1);
      expect(
        await failure(svc.dependents.list(fx.users.hr!, fx.employee1)),
      ).toMatchObject({
        status: 403,
      });
      const unused = await svc.dependents.create(
        fx.employee1,
        { firstName: 'Old', lastName: 'Friend', relationship: 'OTHER' },
        hr,
      );
      await svc.dependents.archive(unused.id, hr);
      expect(
        (await svc.dependents.list(fx.users.reader!, fx.employee1)).items,
      ).toHaveLength(1);
      expect(
        (await svc.dependents.list(fx.users.reader!, fx.employee1, true)).items,
      ).toHaveLength(2);
      expect(
        await tx.benefitDependent.count({
          where: { employeeId: fx.employee1 },
        }),
      ).toBe(2);
    });
  });
});

describe('Benefit election concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let svc: BenefitsServices;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, USERS),
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

  it('lets only one of two concurrent elections through two assignments succeed', async () => {
    const { plan, single } = await healthPlan(svc, fx);
    const hr = ctx(fx.users.benefitsAdmin!);
    const outcomes = await Promise.allSettled(
      [fx.assignmentTeamA, fx.assignmentDeptB].map((assignment) =>
        svc.enrollments.enroll(
          {
            employmentAssignmentId: assignment,
            planId: plan.id,
            optionId: single.id,
            coverageStart: '2026-04-01',
          },
          hr,
        ),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(
      (o) => o.status === 'rejected',
    ) as PromiseRejectedResult;
    expect((rejected.reason as HttpException).getResponse()).toMatchObject({
      code: 'BENEFIT_ELECTION_OVERLAP',
    });
    expect(
      await prisma.benefitEnrollment.count({
        where: { employeeId: fx.employee1, planId: plan.id },
      }),
    ).toBe(1);
  });
});
