import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  formatDate,
  parseDateOnly,
  positionTargets,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  BenefitEligibilityRule,
  EmploymentType,
} from '../generated/prisma/client.js';
import { BenefitPlanService } from './benefit-plan.service.js';
import {
  BENEFIT_ASSIGNMENT_INCLUDE,
  BenefitsAccessService,
} from './benefits-access.service.js';
import {
  BenefitsClock,
  benefitsToday,
  lockPlan,
  writeBenefitsAudit,
  type BenefitsClient,
  type BenefitsRequestContext,
} from './benefits-common.js';
import {
  evaluateEligibility,
  isoDate,
  parseBenefitRange,
  type EligibilityResult,
} from './benefits-domain.js';

const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  'FULL_TIME',
  'PART_TIME',
  'CASUAL',
  'CONTRACT',
];

export interface EligibilityRuleInput {
  effectiveFrom: string;
  effectiveTo?: string | null;
  organizationalUnitId?: string | null;
  includeSubunits?: boolean;
  departmentId?: string | null;
  positionId?: string | null;
  employmentTypes?: EmploymentType[];
  minimumServiceDays?: number | null;
}

type AssignmentWithPlacement = Awaited<
  ReturnType<BenefitsAccessService['assignmentContext']>
>['assignment'];

/**
 * Phase 11 Batch 11.4 — who is offered a plan. Rules (benefit.plan.manage) are effective-dated
 * and never edited: a change ends one rule and adds another, so eligibility on any past date
 * can still be explained. Evaluation is backend-authoritative and uses only Core HR and
 * organization facts (organization, unit with or without sub-units, department, position,
 * employment type, service since hire, assignment dates). Lost eligibility never ends coverage
 * by itself: it is reported for a person to act on.
 */
@Injectable()
export class BenefitEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BenefitsAccessService,
    private readonly audit: AuditService,
    private readonly clock: BenefitsClock,
    private readonly plans: BenefitPlanService,
  ) {}

  // ─── Rules ─────────────────────────────────────────────────────────────────

  async addRule(
    planId: string,
    input: EligibilityRuleInput,
    context: BenefitsRequestContext,
  ) {
    const plan = await this.plans.planOrThrow(planId);
    await this.access.requirePlanManage(
      context.actorUserId,
      plan.organizationId,
      this.prisma,
      'Benefit plan not found.',
    );
    const range = parseBenefitRange(input.effectiveFrom, input.effectiveTo);
    const types = [...new Set(input.employmentTypes ?? [])];
    if (types.some((type) => !EMPLOYMENT_TYPES.includes(type))) {
      throw new BadRequestException(
        'employmentTypes contains an unknown type.',
      );
    }
    const service = input.minimumServiceDays ?? null;
    if (
      service !== null &&
      (!Number.isInteger(service) || service < 0 || service > 36_500)
    ) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_SERVICE_DAYS_INVALID',
          'minimumServiceDays must be 0–36500.',
        ),
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await lockPlan(tx, planId);
      const current = await tx.benefitPlan.findUniqueOrThrow({
        where: { id: planId },
      });
      if (current.archivedAt) {
        throw new BadRequestException(
          domainError(400, 'BENEFIT_ARCHIVED', 'The plan is archived.'),
        );
      }
      await this.assertTargets(tx, plan.organizationId, input);
      const rule = await tx.benefitEligibilityRule.create({
        data: {
          planId,
          organizationId: plan.organizationId,
          effectiveFrom: range.from,
          effectiveTo: range.to,
          organizationalUnitId: input.organizationalUnitId ?? null,
          includeSubunits: input.includeSubunits ?? true,
          departmentId: input.departmentId ?? null,
          positionId: input.positionId ?? null,
          employmentTypes: types,
          minimumServiceDays: service,
          createdByUserId: context.actorUserId ?? null,
        },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_ELIGIBILITY_RULE_ADDED',
        entityType: 'BenefitEligibilityRule',
        entityId: rule.id,
        context,
        metadata: this.ruleShape(rule),
      });
      return this.ruleShape(rule);
    });
  }

  /** Ends a rule (earlier only); it keeps explaining eligibility on its past dates. */
  async endRule(
    ruleId: string,
    effectiveTo: string,
    context: BenefitsRequestContext,
  ) {
    const rule = await this.prisma.benefitEligibilityRule.findUnique({
      where: { id: ruleId },
    });
    if (!rule) throw new NotFoundException('Eligibility rule not found.');
    await this.access.requirePlanManage(
      context.actorUserId,
      rule.organizationId,
      this.prisma,
      'Eligibility rule not found.',
    );
    const end = parseDateOnly(effectiveTo, 'effectiveTo');
    return this.prisma.$transaction(async (tx) => {
      await lockPlan(tx, rule.planId);
      const current = await tx.benefitEligibilityRule.findUniqueOrThrow({
        where: { id: ruleId },
      });
      if (
        end < current.effectiveFrom ||
        (current.effectiveTo && end >= current.effectiveTo)
      ) {
        throw new BadRequestException(
          domainError(
            400,
            'BENEFIT_RULE_END_INVALID',
            'A rule can only be ended earlier, on or after its start.',
          ),
        );
      }
      const updated = await tx.benefitEligibilityRule.update({
        where: { id: ruleId },
        data: { effectiveTo: end },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_ELIGIBILITY_RULE_ENDED',
        entityType: 'BenefitEligibilityRule',
        entityId: ruleId,
        context,
        metadata: {
          planId: rule.planId,
          previousEffectiveTo: isoDate(current.effectiveTo),
          effectiveTo: formatDate(end),
        },
      });
      return this.ruleShape(updated);
    });
  }

  // ─── Evaluation ────────────────────────────────────────────────────────────

  /** Eligibility of one assignment for every non-draft plan of its organization. */
  async forAssignment(userId: string, assignmentId: string, date?: string) {
    const { assignment, target } = await this.access.requireRead(
      userId,
      assignmentId,
    );
    const on = date ? parseDateOnly(date, 'date') : this.todayOf(assignment);
    return {
      assignmentId,
      date: formatDate(on),
      plans: await this.plansFor(
        this.prisma,
        assignment,
        target.unitPathIds ?? [],
        on,
        false,
      ),
    };
  }

  /** The caller's own assignments and the active plans each is offered (self-service). */
  async mine(userId: string, date?: string) {
    const employeeId = await this.access.employeeIdOfUser(userId);
    if (!employeeId) {
      throw new ForbiddenException(
        domainError(
          403,
          'BENEFIT_NOT_AN_EMPLOYEE',
          'Your account is not linked to an employee.',
        ),
      );
    }
    const assignments = await this.prisma.employmentAssignment.findMany({
      where: {
        employeeId,
        status: { not: 'CANCELLED' },
        // Phase 18: organizations with Benefits disabled are left out.
        position: {
          organizationId: { notIn: await this.access.disabledOrganizations() },
        },
      },
      include: BENEFIT_ASSIGNMENT_INCLUDE,
      orderBy: [{ isPrimary: 'desc' }, { startDate: 'asc' }],
    });
    const targets = await positionTargets(
      this.prisma,
      assignments.map((assignment) => assignment.position),
    );
    const items = [];
    for (const assignment of assignments) {
      const on = date ? parseDateOnly(date, 'date') : this.todayOf(assignment);
      items.push({
        assignmentId: assignment.id,
        positionName: assignment.position.name,
        organization: assignment.position.organization.name,
        date: formatDate(on),
        plans: (
          await this.plansFor(
            this.prisma,
            assignment,
            targets.get(assignment.position.id)?.unitPathIds ?? [],
            on,
            true,
          )
        ).filter((plan) => plan.eligibility.eligible),
      });
    }
    return { items };
  }

  /** Eligibility of an assignment for one plan on a date (used by elections). */
  async evaluate(
    client: BenefitsClient,
    assignmentId: string,
    planId: string,
    date: Date,
  ): Promise<EligibilityResult> {
    const assignment = await client.employmentAssignment.findUnique({
      where: { id: assignmentId },
      include: BENEFIT_ASSIGNMENT_INCLUDE,
    });
    if (!assignment)
      throw new NotFoundException('Employment assignment not found');
    const plan = await client.benefitPlan.findUnique({
      where: { id: planId },
      include: { eligibilityRules: true },
    });
    if (!plan) throw new NotFoundException('Benefit plan not found.');
    const target = (await positionTargets(client, [assignment.position])).get(
      assignment.position.id,
    )!;
    return evaluateEligibility({
      assignment: this.facts(assignment, target.unitPathIds ?? []),
      plan,
      rules: plan.eligibilityRules,
      date,
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async plansFor(
    client: BenefitsClient,
    assignment: AssignmentWithPlacement,
    unitPathIds: readonly string[],
    date: Date,
    activeOnly: boolean,
  ) {
    const plans = await client.benefitPlan.findMany({
      where: {
        organizationId: assignment.position.organizationId,
        archivedAt: null,
        status: activeOnly ? 'ACTIVE' : { not: 'DRAFT' },
      },
      include: {
        eligibilityRules: true,
        options: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } },
      },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
    const facts = this.facts(assignment, unitPathIds);
    return plans.map((plan) => ({
      planId: plan.id,
      code: plan.code,
      name: plan.name,
      benefitType: plan.benefitType,
      status: plan.status,
      options: plan.options.map((option) => ({
        id: option.id,
        code: option.code,
        name: option.name,
        coverageLevel: option.coverageLevel,
      })),
      eligibility: evaluateEligibility({
        assignment: facts,
        plan,
        rules: plan.eligibilityRules,
        date,
      }),
    }));
  }

  private facts(
    assignment: AssignmentWithPlacement,
    unitPathIds: readonly string[],
  ) {
    return {
      status: assignment.status,
      startDate: assignment.startDate,
      endDate: assignment.endDate,
      employmentType: assignment.employmentType,
      organizationId: assignment.position.organizationId,
      unitPathIds,
      departmentId: assignment.position.departmentId,
      positionId: assignment.position.id,
      hireDate: assignment.employee.hireDate,
    };
  }

  private todayOf(assignment: AssignmentWithPlacement) {
    return benefitsToday(
      this.clock.now(),
      assignment.position.workLocation?.timezone,
      assignment.position.organization.timezone,
    ).today;
  }

  private async assertTargets(
    client: BenefitsClient,
    organizationId: string,
    input: EligibilityRuleInput,
  ) {
    const invalid = (what: string) =>
      new BadRequestException(
        domainError(
          400,
          'BENEFIT_ELIGIBILITY_TARGET_INVALID',
          `The ${what} does not belong to the plan's organization.`,
        ),
      );
    if (
      input.organizationalUnitId &&
      !(await client.organizationalUnit.findFirst({
        where: { id: input.organizationalUnitId, organizationId },
      }))
    )
      throw invalid('organizational unit');
    if (
      input.departmentId &&
      !(await client.department.findFirst({
        where: { id: input.departmentId, organizationId },
      }))
    )
      throw invalid('department');
    if (
      input.positionId &&
      !(await client.position.findFirst({
        where: { id: input.positionId, organizationId },
      }))
    )
      throw invalid('position');
  }

  ruleShape(rule: BenefitEligibilityRule) {
    return {
      id: rule.id,
      planId: rule.planId,
      effectiveFrom: formatDate(rule.effectiveFrom),
      effectiveTo: isoDate(rule.effectiveTo),
      organizationalUnitId: rule.organizationalUnitId,
      includeSubunits: rule.includeSubunits,
      departmentId: rule.departmentId,
      positionId: rule.positionId,
      employmentTypes: rule.employmentTypes,
      minimumServiceDays: rule.minimumServiceDays,
    };
  }
}
