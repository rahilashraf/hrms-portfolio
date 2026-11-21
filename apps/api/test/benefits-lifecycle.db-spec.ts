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
  onPayroll,
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

const USERS = {
  ...BENEFIT_USERS,
  self2: [{ permissions: BENEFIT_PERMISSION_KEYS, scope: 'org' as const }],
};

const failure = async (promise: Promise<unknown>) => {
  const error = (await rejection(promise)) as HttpException;
  const body = error.getResponse?.() as { code?: string } | undefined;
  return { status: error.getStatus?.(), code: body?.code };
};

const timeline = async (tx: Tx, employeeId: string, planId: string) =>
  (
    await tx.benefitEnrollment.findMany({
      where: { employeeId, planId },
      include: { option: true, dependents: true },
      orderBy: [{ coverageStart: 'asc' }, { createdAt: 'asc' }],
    })
  ).map((row) => [
    row.recordType,
    row.electionType,
    row.option?.code ?? null,
    row.coverageStart.toISOString().slice(0, 10),
    row.coverageEnd?.toISOString().slice(0, 10) ?? null,
    row.dependents.length,
    row.supersededAt ? 'SUPERSEDED' : 'LIVE',
  ]);

/** Clock: 2026-03-15 (Toronto). */
describe('Benefit election lifecycle (database)', () => {
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

  it('changes, ends, waives and re-enrolls without rewriting the past', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single, family } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const spouse = await svc.dependents.create(
        fx.employee1,
        { firstName: 'Sam', lastName: 'S', relationship: 'SPOUSE' },
        hr,
      );
      // Waived at first, then enrolls from February.
      const waiver = await svc.enrollments.waive(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          coverageStart: '2026-01-01',
        },
        hr,
      );
      await svc.enrollments.end(waiver.id, { coverageEnd: '2026-01-31' }, hr);
      const first = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        hr,
      );
      expect(first).toMatchObject({ status: 'ACTIVE', recordType: 'CHANGE' });
      expect(
        await failure(
          svc.enrollments.change(
            first.id,
            { effectiveDate: '2026-02-01', optionId: family.id },
            hr,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_CHANGE_ON_START' });
      expect(
        await failure(
          svc.enrollments.change(
            first.id,
            { effectiveDate: '2026-04-01', optionId: family.id },
            hr,
          ),
        ),
      ).toEqual({ status: 400, code: 'BENEFIT_DEPENDENTS_MISMATCH' });
      expect(
        await failure(
          svc.enrollments.change(
            waiver.id,
            { effectiveDate: '2026-01-15' },
            hr,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_ELECTION_WAIVED' });
      const changed = await svc.enrollments.change(
        first.id,
        {
          effectiveDate: '2026-04-01',
          optionId: family.id,
          dependentIds: [spouse.id],
          reason: 'Marriage',
        },
        hr,
      );
      expect(changed).toMatchObject({
        status: 'PENDING',
        recordType: 'CHANGE',
      });
      await svc.enrollments.end(changed.id, { coverageEnd: '2026-06-30' }, hr);
      expect(
        await failure(
          svc.enrollments.end(changed.id, { coverageEnd: '2026-07-31' }, hr),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_END_NOT_EARLIER' });
      expect(
        await failure(
          svc.enrollments.end(changed.id, { coverageEnd: '2026-03-31' }, hr),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_END_BEFORE_START' });
      // Then waives again from July.
      await svc.enrollments.waive(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          coverageStart: '2026-07-01',
        },
        hr,
      );
      expect(await timeline(tx, fx.employee1, plan.id)).toEqual([
        ['INITIAL', 'WAIVED', null, '2026-01-01', '2026-01-31', 0, 'LIVE'],
        ['CHANGE', 'ENROLLED', 'SINGLE', '2026-02-01', '2026-03-31', 0, 'LIVE'],
        ['CHANGE', 'ENROLLED', 'FAMILY', '2026-04-01', '2026-06-30', 1, 'LIVE'],
        ['CHANGE', 'WAIVED', null, '2026-07-01', null, 0, 'LIVE'],
      ]);
      // As of a past date, the employee view shows what applied then.
      const asOf = await svc.enrollments.employee(
        fx.users.reader!,
        fx.employee1,
        '2026-02-15',
      );
      expect(
        asOf.items.find((item) => item.id === first.id)!.cost!.employeeAmount,
      ).toBe('25.00');
      expect(
        await tx.auditLog.count({
          where: {
            action: {
              in: ['BENEFIT_ELECTION_CHANGED', 'BENEFIT_ELECTION_ENDED'],
            },
          },
        }),
      ).toBeGreaterThanOrEqual(3);
    });
  });

  it('corrects and rescinds by supersession, keeping the wrong records readable', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single, family } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const child = await svc.dependents.create(
        fx.employee1,
        {
          firstName: 'Kid',
          lastName: 'K',
          relationship: 'CHILD',
          dateOfBirth: '2016-01-01',
        },
        hr,
      );
      const wrong = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        hr,
      );
      expect(
        await failure(svc.enrollments.correct(wrong.id, { reason: ' ' }, hr)),
      ).toEqual({ status: 400, code: 'BENEFIT_REASON_REQUIRED' });
      expect(
        await failure(
          svc.enrollments.correct(
            wrong.id,
            { reason: 'x' },
            ctx(fx.users.reader!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      const fixed = await svc.enrollments.correct(
        wrong.id,
        {
          reason: 'Family was elected',
          optionId: family.id,
          dependentIds: [child.id],
        },
        hr,
      );
      expect(fixed).toMatchObject({
        recordType: 'CORRECTION',
        supersedesEnrollmentId: wrong.id,
        coverageStart: '2026-02-01',
        option: { code: 'FAMILY' },
      });
      expect(
        await failure(
          svc.enrollments.correct(wrong.id, { reason: 'again' }, hr),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_ELECTION_SUPERSEDED' });
      const history = await svc.enrollments.employee(
        fx.users.reader!,
        fx.employee1,
      );
      const old = history.items.find((item) => item.id === wrong.id)!;
      expect(old).toMatchObject({
        status: 'SUPERSEDED',
        supersessionReason: 'Family was elected',
      });
      expect(old.actions.canCorrect).toBe(false);
      // A future election entered in error is rescinded; its dates become free again.
      const future = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-05-01',
        },
        hr,
      );
      await svc.enrollments.rescind(
        future.id,
        { reason: 'Entered for the wrong employee' },
        hr,
      );
      await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-05-01',
        },
        hr,
      );
      // Nobody corrects their own benefits.
      expect(
        await failure(
          svc.enrollments.rescind(
            future.id,
            { reason: 'x' },
            ctx(fx.selfUser2),
          ),
        ),
      ).toEqual({ status: 403, code: 'BENEFIT_SELF_MANAGEMENT' });
      expect(
        await tx.auditLog.count({
          where: { action: 'BENEFIT_ELECTION_CORRECTED', entityId: fixed.id },
        }),
      ).toBe(1);
    });
  });

  it('flags what needs attention and transfers coverage to another assignment', async () => {
    await scenario(async (tx, fx, svc) => {
      const { admin, plan, single, family } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      await onPayroll(tx, fx, [fx.assignmentTeamA, fx.assignmentDeptB]);
      // Turned 22 on 2026-03-01: eligible at the February start, not today (2026-03-15).
      const child = await svc.dependents.create(
        fx.employee2,
        {
          firstName: 'Big',
          lastName: 'Kid',
          relationship: 'CHILD',
          dateOfBirth: '2004-03-01',
        },
        hr,
      );
      await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: family.id,
          dependentIds: [child.id],
          coverageStart: '2026-02-01',
        },
        hr,
      );
      const covered = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        hr,
      );
      // Employee 1's Team A assignment ends; coverage now outlives its sponsor.
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { endDate: d('2026-05-31') },
      });
      const flagged = await svc.enrollments.attention(
        fx.users.reader!,
        fx.orgA,
      );
      expect(
        Object.fromEntries(
          flagged.items.map((item) => [item.employeeId, item.flags]),
        ),
      ).toEqual({
        [fx.employee1]: ['SPONSOR_ASSIGNMENT_ENDED'],
        [fx.employee2]: ['DEPENDENT_INELIGIBLE', 'SPONSOR_NOT_ON_PAYROLL'],
      });
      expect(
        await failure(svc.enrollments.attention(fx.users.hr!, fx.orgA)),
      ).toMatchObject({
        status: 403,
      });
      // Transfer to the Dept B assignment from June: the flag clears, coverage continues.
      expect(
        await failure(
          svc.enrollments.transfer(
            covered.id,
            {
              employmentAssignmentId: fx.otherTeamA,
              effectiveDate: '2026-06-01',
            },
            hr,
          ),
        ),
      ).toEqual({ status: 400, code: 'BENEFIT_TRANSFER_OTHER_EMPLOYEE' });
      const moved = await svc.enrollments.transfer(
        covered.id,
        {
          employmentAssignmentId: fx.assignmentDeptB,
          effectiveDate: '2026-06-01',
        },
        hr,
      );
      expect(moved.sponsoringAssignment.id).toBe(fx.assignmentDeptB);
      const after = await svc.enrollments.attention(fx.users.reader!, fx.orgA);
      expect(after.items.map((item) => item.employeeId)).toEqual([
        fx.employee2,
      ]);
      // Eligibility lost: a rule that the assignment no longer meets.
      await svc.eligibility.addRule(
        plan.id,
        { effectiveFrom: '2026-01-01', departmentId: fx.deptB },
        admin,
      );
      const lost = await svc.enrollments.employee(
        fx.users.reader!,
        fx.employee2,
      );
      expect(lost.items[0]!.flags).toEqual([
        'ELIGIBILITY_LOST',
        'DEPENDENT_INELIGIBLE',
        'SPONSOR_NOT_ON_PAYROLL',
      ]);
    });
  });

  it('discontinues a plan with its elections and rates, never silently', async () => {
    await scenario(async (tx, fx, svc) => {
      const { admin, plan, single } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        hr,
      );
      const future = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-08-01',
        },
        hr,
      );
      const input = {
        effectiveTo: '2026-06-30',
        endElections: false,
        reason: 'Carrier change',
      };
      expect(
        await failure(svc.enrollments.discontinuePlan(plan.id, input, admin)),
      ).toEqual({ status: 409, code: 'BENEFIT_PLAN_HAS_COVERAGE' });
      expect(
        await failure(
          svc.enrollments.discontinuePlan(
            plan.id,
            { ...input, endElections: true },
            ctx(fx.users.teamManager!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      const result = await svc.enrollments.discontinuePlan(
        plan.id,
        { ...input, endElections: true },
        admin,
      );
      expect(result).toMatchObject({
        electionsEnded: 1,
        electionsRescinded: 1,
      });
      expect(await timeline(tx, fx.employee1, plan.id)).toEqual([
        [
          'INITIAL',
          'ENROLLED',
          'SINGLE',
          '2026-02-01',
          '2026-06-30',
          0,
          'LIVE',
        ],
      ]);
      expect(
        (
          await tx.benefitEnrollment.findUniqueOrThrow({
            where: { id: future.id },
          })
        ).supersededAt,
      ).not.toBeNull();
      const stored = await tx.benefitPlan.findUniqueOrThrow({
        where: { id: plan.id },
      });
      expect(stored.effectiveTo?.toISOString().slice(0, 10)).toBe('2026-06-30');
      expect(
        (
          await tx.benefitRate.findMany({
            where: { planId: plan.id, supersededAt: null },
          })
        ).map((rate) => rate.effectiveTo?.toISOString().slice(0, 10)),
      ).toEqual(['2026-06-30', '2026-06-30']);
    });
  });
});
