import { AuditService } from '../../src/audit/audit.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { BenefitDependentService } from '../../src/benefits/benefit-dependent.service.js';
import { BenefitEligibilityService } from '../../src/benefits/benefit-eligibility.service.js';
import { BenefitEnrollmentService } from '../../src/benefits/benefit-enrollment.service.js';
import { BenefitPlanService } from '../../src/benefits/benefit-plan.service.js';
import { BenefitRateService } from '../../src/benefits/benefit-rate.service.js';
import { BenefitsAccessService } from '../../src/benefits/benefits-access.service.js';
import { BenefitsClock } from '../../src/benefits/benefits-common.js';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { d } from './payroll-fixtures.js';
import {
  ctx,
  type SchedulingFixtures,
  type Tx,
  type UserSpec,
} from './scheduling-fixtures.js';

/** Raw rows for benefits database specs (services arrive in later batches). */
export async function benefitPlan(
  tx: Tx,
  fx: SchedulingFixtures,
  overrides: Partial<{
    code: string;
    organizationId: string;
    status: 'DRAFT' | 'ACTIVE' | 'CLOSED';
    effectiveFrom: Date;
    effectiveTo: Date | null;
    currency: string;
  }> = {},
) {
  const plan = await tx.benefitPlan.create({
    data: {
      organizationId: overrides.organizationId ?? fx.orgA,
      code: overrides.code ?? `HEALTH-${fx.suffix}`,
      name: 'Health',
      benefitType: 'HEALTH',
      currency: overrides.currency ?? 'CAD',
      status: overrides.status ?? 'ACTIVE',
      effectiveFrom: overrides.effectiveFrom ?? d('2026-01-01'),
      effectiveTo: overrides.effectiveTo ?? null,
    },
  });
  const single = await tx.benefitCoverageOption.create({
    data: {
      planId: plan.id,
      code: 'SINGLE',
      name: 'Employee only',
      coverageLevel: 'EMPLOYEE_ONLY',
    },
  });
  const family = await tx.benefitCoverageOption.create({
    data: {
      planId: plan.id,
      code: 'FAMILY',
      name: 'Family',
      coverageLevel: 'FAMILY',
    },
  });
  return { plan, single, family };
}

export function election(
  tx: Tx,
  fx: SchedulingFixtures,
  input: {
    planId: string;
    optionId: string | null;
    employeeId?: string;
    assignmentId?: string;
    organizationId?: string;
    coverageStart: string;
    coverageEnd?: string | null;
  },
) {
  return tx.benefitEnrollment.create({
    data: {
      employeeId: input.employeeId ?? fx.employee1,
      employmentAssignmentId: input.assignmentId ?? fx.assignmentTeamA,
      organizationId: input.organizationId ?? fx.orgA,
      planId: input.planId,
      optionId: input.optionId,
      electionType: input.optionId ? 'ENROLLED' : 'WAIVED',
      recordType: 'INITIAL',
      coverageStart: d(input.coverageStart),
      coverageEnd: input.coverageEnd ? d(input.coverageEnd) : null,
      electedOn: d(input.coverageStart),
    },
  });
}

export const BENEFIT_PERMISSION_KEYS = [
  'benefit.read',
  'benefit.manage',
  'benefit.plan.manage',
] as const;

/** Users of benefits specs: benefits are never implied by HR, compensation or payroll access. */
export const BENEFIT_USERS: Record<string, UserSpec[]> = {
  planAdmin: [{ permissions: ['benefit.plan.manage'], scope: 'org' }],
  benefitsAdmin: [{ permissions: BENEFIT_PERMISSION_KEYS, scope: 'org' }],
  reader: [{ permissions: ['benefit.read'], scope: 'org' }],
  teamManager: [
    { permissions: ['benefit.read', 'benefit.manage'], scope: 'teamA' },
  ],
  teamPlanManage: [{ permissions: ['benefit.plan.manage'], scope: 'teamA' }],
  hr: [
    {
      permissions: [
        'employee.read',
        'employee.manage',
        'compensation.read',
        'compensation.manage',
        'payroll.read',
        'payroll.manage',
      ],
      scope: 'org',
    },
  ],
  orgBAdmin: [{ permissions: BENEFIT_PERMISSION_KEYS, scope: 'orgB' }],
};

export class FixedBenefitsClock extends BenefitsClock {
  value = new Date('2026-03-15T16:00:00.000Z');

  override now() {
    return this.value;
  }
}

export function benefitsServices(prisma: PrismaService, clock: BenefitsClock) {
  const authorization = new AuthorizationService(prisma);
  const access = new BenefitsAccessService(prisma, authorization);
  const audit = new AuditService(prisma);
  const plans = new BenefitPlanService(prisma, access, audit, clock);
  const rates = new BenefitRateService(prisma, access, audit, plans);
  const eligibility = new BenefitEligibilityService(
    prisma,
    access,
    audit,
    clock,
    plans,
  );
  const dependents = new BenefitDependentService(prisma, access, audit, clock);
  const enrollments = new BenefitEnrollmentService(
    prisma,
    access,
    audit,
    clock,
    eligibility,
  );
  return {
    authorization,
    access,
    audit,
    clock,
    plans,
    rates,
    eligibility,
    dependents,
    enrollments,
  };
}

export type BenefitsServices = ReturnType<typeof benefitsServices>;

/**
 * A HEALTH plan from 2026-01-01 (children covered up to 21) with SINGLE and FAMILY options at
 * 25.00 employee / 75.00 employer monthly. Clock: 2026-03-15 (Toronto).
 */
export async function healthPlan(
  svc: BenefitsServices,
  fx: SchedulingFixtures,
  code = 'HEALTH',
) {
  const admin = ctx(fx.users.planAdmin!);
  const plan = await svc.plans.create(
    {
      organizationId: fx.orgA,
      code,
      name: 'Health',
      benefitType: 'HEALTH',
      currency: 'CAD',
      effectiveFrom: '2026-01-01',
      dependentChildMaxAge: 21,
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
  for (const option of [single, family]) {
    await svc.rates.addRate(
      option.id,
      {
        effectiveFrom: '2026-01-01',
        frequency: 'MONTHLY',
        employeeAmount: '25',
        employerAmount: '75',
      },
      admin,
    );
  }
  await svc.plans.transition(plan.id, 'ACTIVE', admin);
  return { admin, plan, single, family };
}

/** Puts assignments on payroll (salary in a pay group) so benefit sponsors are paid. */
export async function onPayroll(
  tx: Tx,
  fx: SchedulingFixtures,
  assignmentIds: readonly string[],
) {
  const group = await tx.payGroup.create({
    data: {
      organizationId: fx.orgA,
      code: `BEN-${fx.suffix}`,
      name: 'Benefits PG',
    },
  });
  for (const employmentAssignmentId of assignmentIds) {
    await tx.compensationRecord.create({
      data: {
        employmentAssignmentId,
        organizationId: fx.orgA,
        recordType: 'INITIAL',
        payBasis: 'SALARY',
        rateAmount: '52000',
        currency: 'CAD',
        effectiveFrom: d('2026-01-01'),
        payGroupId: group.id,
      },
    });
  }
  return group;
}
