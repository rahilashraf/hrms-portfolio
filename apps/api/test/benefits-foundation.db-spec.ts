import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { benefitPlan, election } from './support/benefits-fixtures.js';
import { d } from './support/payroll-fixtures.js';
import {
  createSchedulingFixtures,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** The database half of the Benefits invariants (Phase 11 foundation migration). */
describe('Benefits foundation constraints (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (tx: Tx, fx: SchedulingFixtures) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, {});
          await run(tx, fx).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('keeps one election timeline per employee and plan across all assignments', async () => {
    await scenario(async (tx, fx) => {
      const { plan, single, family } = await benefitPlan(tx, fx);
      const first = await election(tx, fx, {
        planId: plan.id,
        optionId: single.id,
        coverageStart: '2026-02-01',
        coverageEnd: '2026-02-28',
      });
      // Overlap through the same assignment, through the other assignment, and as a waiver.
      for (const assignmentId of [fx.assignmentTeamA, fx.assignmentDeptB]) {
        await violation(tx, () =>
          election(tx, fx, {
            planId: plan.id,
            optionId: family.id,
            assignmentId,
            coverageStart: '2026-02-28',
          }),
        );
      }
      await violation(tx, () =>
        election(tx, fx, {
          planId: plan.id,
          optionId: null,
          coverageStart: '2026-02-15',
        }),
      );
      // Adjacent segments (even via the second assignment) are fine.
      await election(tx, fx, {
        planId: plan.id,
        optionId: family.id,
        assignmentId: fx.assignmentDeptB,
        coverageStart: '2026-03-01',
        coverageEnd: '2026-03-31',
      });
      await election(tx, fx, {
        planId: plan.id,
        optionId: null,
        coverageStart: '2026-04-01',
      });
      // Another employee has their own timeline.
      await election(tx, fx, {
        planId: plan.id,
        optionId: single.id,
        employeeId: fx.employee2,
        assignmentId: fx.otherTeamA,
        coverageStart: '2026-02-01',
      });
      // A superseded segment leaves the timeline, and a correction can replace it.
      await tx.benefitEnrollment.update({
        where: { id: first.id },
        data: { supersededAt: new Date(), supersessionReason: 'Wrong option' },
      });
      await tx.benefitEnrollment.create({
        data: {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          organizationId: fx.orgA,
          planId: plan.id,
          optionId: family.id,
          electionType: 'ENROLLED',
          recordType: 'CORRECTION',
          supersedesEnrollmentId: first.id,
          reason: 'Family coverage was elected',
          coverageStart: d('2026-02-01'),
          coverageEnd: d('2026-02-28'),
          electedOn: d('2026-01-20'),
        },
      });
    });
  });

  it('allows coverage to end earlier only, freezes terms and never deletes', async () => {
    await scenario(async (tx, fx) => {
      const { plan, single, family } = await benefitPlan(tx, fx);
      const row = await election(tx, fx, {
        planId: plan.id,
        optionId: single.id,
        coverageStart: '2026-02-01',
      });
      await tx.benefitEnrollment.update({
        where: { id: row.id },
        data: { coverageEnd: d('2026-06-30') },
      });
      await tx.benefitEnrollment.update({
        where: { id: row.id },
        data: { coverageEnd: d('2026-05-31') },
      });
      await violation(tx, () =>
        tx.benefitEnrollment.update({
          where: { id: row.id },
          data: { coverageEnd: d('2026-07-31') },
        }),
      );
      await violation(tx, () =>
        tx.benefitEnrollment.update({
          where: { id: row.id },
          data: { coverageEnd: null },
        }),
      );
      await violation(tx, () =>
        tx.benefitEnrollment.update({
          where: { id: row.id },
          data: { optionId: family.id },
        }),
      );
      await violation(tx, () =>
        tx.benefitEnrollment.update({
          where: { id: row.id },
          data: { coverageStart: d('2026-03-01') },
        }),
      );
      await violation(tx, () =>
        tx.benefitEnrollment.delete({ where: { id: row.id } }),
      );
      // Superseding needs a reason; a superseded segment is frozen.
      await violation(tx, () =>
        tx.benefitEnrollment.update({
          where: { id: row.id },
          data: { supersededAt: new Date() },
        }),
      );
      await tx.benefitEnrollment.update({
        where: { id: row.id },
        data: {
          supersededAt: new Date(),
          supersessionReason: 'Entered in error',
        },
      });
      await violation(tx, () =>
        tx.benefitEnrollment.update({
          where: { id: row.id },
          data: { coverageEnd: d('2026-04-30') },
        }),
      );
    });
  });

  it('enforces election shape, organization, plan and assignment boundaries', async () => {
    await scenario(async (tx, fx) => {
      const { plan, single } = await benefitPlan(tx, fx, {
        effectiveFrom: d('2026-01-01'),
        effectiveTo: d('2026-12-31'),
      });
      const base = {
        employeeId: fx.employee1,
        employmentAssignmentId: fx.assignmentTeamA,
        organizationId: fx.orgA,
        planId: plan.id,
        recordType: 'INITIAL' as const,
        coverageStart: d('2026-02-01'),
        electedOn: d('2026-02-01'),
      };
      // A waiver elects no option; an enrollment elects one.
      await violation(tx, () =>
        tx.benefitEnrollment.create({
          data: { ...base, electionType: 'WAIVED', optionId: single.id },
        }),
      );
      await violation(tx, () =>
        tx.benefitEnrollment.create({
          data: { ...base, electionType: 'ENROLLED' },
        }),
      );
      // A correction must name what it corrects, with a reason.
      await violation(tx, () =>
        tx.benefitEnrollment.create({
          data: {
            ...base,
            electionType: 'ENROLLED',
            optionId: single.id,
            recordType: 'CORRECTION',
          },
        }),
      );
      // Another organization's plan cannot be elected through an Org A assignment.
      const other = await benefitPlan(tx, fx, {
        organizationId: fx.orgB,
        code: `OTHER-${fx.suffix}`,
      });
      await violation(tx, () =>
        tx.benefitEnrollment.create({
          data: {
            ...base,
            planId: other.plan.id,
            organizationId: fx.orgB,
            electionType: 'ENROLLED',
            optionId: other.single.id,
          },
        }),
      );
      // The assignment must belong to the employee (composite key).
      await violation(tx, () =>
        tx.benefitEnrollment.create({
          data: {
            ...base,
            employmentAssignmentId: fx.otherTeamA,
            electionType: 'ENROLLED',
            optionId: single.id,
          },
        }),
      );
      // Coverage inside the plan and the assignment.
      await violation(tx, () =>
        election(tx, fx, {
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2025-12-01',
        }),
      );
      await violation(tx, () =>
        election(tx, fx, {
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-06-01',
        }),
      );
      // A draft plan and an archived option accept no elections.
      const draft = await benefitPlan(tx, fx, {
        status: 'DRAFT',
        code: `DRAFT-${fx.suffix}`,
      });
      await violation(tx, () =>
        election(tx, fx, {
          planId: draft.plan.id,
          optionId: draft.single.id,
          coverageStart: '2026-02-01',
        }),
      );
      await tx.benefitCoverageOption.update({
        where: { id: single.id },
        data: { archivedAt: new Date() },
      });
      await violation(tx, () =>
        election(tx, fx, {
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
          coverageEnd: '2026-03-01',
        }),
      );
      // A cancelled assignment sponsors nothing.
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentDeptB },
        data: { status: 'CANCELLED' },
      });
      await violation(tx, () =>
        election(tx, fx, {
          planId: plan.id,
          optionId: null,
          assignmentId: fx.assignmentDeptB,
          coverageStart: '2026-02-01',
          coverageEnd: '2026-03-01',
        }),
      );
    });
  });

  it('never blocks Core HR: assignments end or are cancelled with coverage in place', async () => {
    await scenario(async (tx, fx) => {
      const { plan, single } = await benefitPlan(tx, fx);
      await election(tx, fx, {
        planId: plan.id,
        optionId: single.id,
        coverageStart: '2026-02-01',
      });
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { endDate: d('2026-03-31'), status: 'ENDED' },
      });
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { status: 'CANCELLED' },
      });
      expect(
        await tx.benefitEnrollment.count({
          where: { employmentAssignmentId: fx.assignmentTeamA },
        }),
      ).toBe(1);
    });
  });

  it('keeps covered dependents with their own employee and an enrolled segment', async () => {
    await scenario(async (tx, fx) => {
      const { plan, single, family } = await benefitPlan(tx, fx);
      const child = await tx.benefitDependent.create({
        data: {
          employeeId: fx.employee1,
          firstName: 'Ada',
          lastName: 'Child',
          relationship: 'CHILD',
          dateOfBirth: d('2015-04-01'),
        },
      });
      const otherChild = await tx.benefitDependent.create({
        data: {
          employeeId: fx.employee2,
          firstName: 'Bo',
          lastName: 'Child',
          relationship: 'CHILD',
          dateOfBirth: d('2016-04-01'),
        },
      });
      // A child needs a birth date; names are required; a dependent never changes employee.
      await violation(tx, () =>
        tx.benefitDependent.create({
          data: {
            employeeId: fx.employee1,
            firstName: 'X',
            lastName: 'Y',
            relationship: 'CHILD',
          },
        }),
      );
      await violation(tx, () =>
        tx.benefitDependent.update({
          where: { id: child.id },
          data: { employeeId: fx.employee2 },
        }),
      );
      const enrolled = await election(tx, fx, {
        planId: plan.id,
        optionId: family.id,
        coverageStart: '2026-02-01',
        coverageEnd: '2026-02-28',
      });
      await tx.benefitEnrollmentDependent.create({
        data: {
          enrollmentId: enrolled.id,
          employeeId: fx.employee1,
          dependentId: child.id,
        },
      });
      // Another employee's dependent cannot be covered.
      await violation(tx, () =>
        tx.benefitEnrollmentDependent.create({
          data: {
            enrollmentId: enrolled.id,
            employeeId: fx.employee1,
            dependentId: otherChild.id,
          },
        }),
      );
      // Waivers cover nobody; covered dependents never change or disappear.
      const waived = await election(tx, fx, {
        planId: plan.id,
        optionId: null,
        coverageStart: '2026-03-01',
      });
      await violation(tx, () =>
        tx.benefitEnrollmentDependent.create({
          data: {
            enrollmentId: waived.id,
            employeeId: fx.employee1,
            dependentId: child.id,
          },
        }),
      );
      await violation(tx, () =>
        tx.benefitEnrollmentDependent.deleteMany({
          where: { enrollmentId: enrolled.id },
        }),
      );
      // A referenced dependent cannot be deleted (archive instead).
      await violation(tx, () =>
        tx.benefitDependent.delete({ where: { id: child.id } }),
      );
      expect(single.coverageLevel).toBe('EMPLOYEE_ONLY');
    });
  });

  it('keeps rate timelines per option, inside the plan, immutable', async () => {
    await scenario(async (tx, fx) => {
      const { plan, single, family } = await benefitPlan(tx, fx, {
        effectiveTo: d('2026-12-31'),
      });
      const rate = (
        optionId: string,
        from: string,
        to: string | null,
        overrides = {},
      ) =>
        tx.benefitRate.create({
          data: {
            planId: plan.id,
            optionId,
            effectiveFrom: d(from),
            effectiveTo: to ? d(to) : null,
            frequency: 'MONTHLY',
            employeeAmount: '25.00',
            employerAmount: '75.00',
            recordType: 'INITIAL',
            ...overrides,
          },
        });
      const january = await rate(single.id, '2026-01-01', '2026-06-30');
      await violation(tx, () => rate(single.id, '2026-06-30', null));
      await rate(single.id, '2026-07-01', '2026-12-31');
      // Another option has its own timeline; zero cost is a valid (free) benefit.
      await rate(family.id, '2026-01-01', '2026-12-31', {
        employeeAmount: '0',
        employerAmount: '0',
      });
      // Outside the plan, negative amounts, and a correction without reason are refused.
      await violation(tx, () => rate(family.id, '2025-12-01', '2025-12-31'));
      await violation(tx, () => rate(single.id, '2027-01-01', null));
      await violation(tx, () =>
        tx.benefitRate.create({
          data: {
            planId: plan.id,
            optionId: single.id,
            effectiveFrom: d('2026-01-01'),
            frequency: 'MONTHLY',
            employeeAmount: '-1',
            employerAmount: '0',
            recordType: 'INITIAL',
          },
        }),
      );
      // Terms are frozen; the end may only move earlier; never deleted.
      await violation(tx, () =>
        tx.benefitRate.update({
          where: { id: january.id },
          data: { employeeAmount: '30' },
        }),
      );
      await violation(tx, () =>
        tx.benefitRate.update({
          where: { id: january.id },
          data: { effectiveTo: d('2026-07-31') },
        }),
      );
      await violation(tx, () =>
        tx.benefitRate.delete({ where: { id: january.id } }),
      );
      // A correction supersedes the rate and takes its place.
      await tx.benefitRate.update({
        where: { id: january.id },
        data: { supersededAt: new Date() },
      });
      await rate(single.id, '2026-01-01', '2026-06-30', {
        recordType: 'CORRECTION',
        supersedesRateId: january.id,
        reason: 'Carrier invoice',
        employeeAmount: '26.00',
      });
      // A plan's identity never changes, and its dates cannot strand its rates.
      await violation(tx, () =>
        tx.benefitPlan.update({
          where: { id: plan.id },
          data: { currency: 'USD' },
        }),
      );
      await violation(tx, () =>
        tx.benefitPlan.update({
          where: { id: plan.id },
          data: { effectiveTo: d('2026-10-31') },
        }),
      );
      await violation(tx, () =>
        tx.benefitCoverageOption.update({
          where: { id: single.id },
          data: { coverageLevel: 'FAMILY' },
        }),
      );
    });
  });

  it('keeps eligibility rules in their organization with frozen criteria', async () => {
    await scenario(async (tx, fx) => {
      const { plan } = await benefitPlan(tx, fx);
      const rule = await tx.benefitEligibilityRule.create({
        data: {
          planId: plan.id,
          organizationId: fx.orgA,
          effectiveFrom: d('2026-01-01'),
          departmentId: fx.deptA,
          employmentTypes: ['FULL_TIME'],
          minimumServiceDays: 90,
        },
      });
      const orgBPosition = await tx.position.create({
        data: {
          organizationId: fx.orgB,
          jobTitleId: (
            await tx.jobTitle.create({
              data: {
                organizationId: fx.orgB,
                name: 'B',
                code: `JB${fx.suffix}`,
              },
            })
          ).id,
          name: 'B',
          code: `PB${fx.suffix}`,
        },
      });
      await violation(tx, () =>
        tx.benefitEligibilityRule.create({
          data: {
            planId: plan.id,
            organizationId: fx.orgA,
            effectiveFrom: d('2026-01-01'),
            positionId: orgBPosition.id,
          },
        }),
      );
      await violation(tx, () =>
        tx.benefitEligibilityRule.update({
          where: { id: rule.id },
          data: { minimumServiceDays: 30 },
        }),
      );
      await tx.benefitEligibilityRule.update({
        where: { id: rule.id },
        data: { effectiveTo: d('2026-06-30') },
      });
      await violation(tx, () =>
        tx.benefitEligibilityRule.update({
          where: { id: rule.id },
          data: { effectiveTo: null },
        }),
      );
    });
  });
});
