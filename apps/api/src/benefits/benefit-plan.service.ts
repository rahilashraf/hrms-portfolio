import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, formatDate } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  BenefitCoverageLevel,
  BenefitPlan,
  BenefitPlanStatus,
  BenefitType,
  Prisma,
} from '../generated/prisma/client.js';
import { BenefitsAccessService } from './benefits-access.service.js';
import {
  BenefitsClock,
  benefitsToday,
  lockPlan,
  writeBenefitsAudit,
  type BenefitsRequestContext,
} from './benefits-common.js';
import {
  isoDate,
  parseBenefitCode,
  parseBenefitCurrency,
  parseBenefitRange,
} from './benefits-domain.js';

type Tx = Prisma.TransactionClient;

export const BENEFIT_TYPES: readonly BenefitType[] = [
  'HEALTH',
  'DENTAL',
  'VISION',
  'LIFE',
  'DISABILITY',
  'RETIREMENT',
  'WELLNESS',
  'OTHER',
];
export const BENEFIT_COVERAGE_LEVELS: readonly BenefitCoverageLevel[] = [
  'EMPLOYEE_ONLY',
  'EMPLOYEE_SPOUSE',
  'EMPLOYEE_CHILDREN',
  'FAMILY',
  'CUSTOM',
];

export interface CreatePlanInput {
  organizationId: string;
  code: string;
  name: string;
  description?: string | null;
  benefitType: BenefitType;
  providerName?: string | null;
  providerReference?: string | null;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  employerContributionTaxable?: boolean;
  showEmployerCostToEmployee?: boolean;
  dependentChildMaxAge?: number | null;
}

export type UpdatePlanInput = Partial<
  Pick<
    CreatePlanInput,
    | 'name'
    | 'description'
    | 'providerName'
    | 'providerReference'
    | 'employerContributionTaxable'
    | 'showEmployerCostToEmployee'
    | 'dependentChildMaxAge'
    | 'effectiveFrom'
  >
>;

const text = (value: string | null | undefined, field: string, max = 500) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new BadRequestException(
      `${field} must be at most ${max} characters.`,
    );
  }
  return trimmed;
};

const requiredText = (value: string | undefined, field: string, max = 200) => {
  const trimmed = text(value ?? '', field, max);
  if (!trimmed) throw new BadRequestException(`${field} is required.`);
  return trimmed;
};

/**
 * Phase 11 Batch 11.2 — benefit plans and coverage options (benefit.plan.manage at the
 * organization). A plan is configured as a DRAFT, activated to accept elections, closed to stop
 * new elections (existing coverage continues), and archived only when no coverage remains
 * current or future. Its code, organization and currency never change; an option's coverage
 * level never changes. Every write locks the plan row and is audited.
 */
@Injectable()
export class BenefitPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BenefitsAccessService,
    private readonly audit: AuditService,
    private readonly clock: BenefitsClock,
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async list(
    userId: string,
    query: { organizationId: string; includeArchived?: boolean },
  ) {
    await this.access.requirePlanRead(userId, query.organizationId);
    const grants = await this.access.grants(userId);
    const canManage = this.access.can(grants, 'benefit.plan.manage', {
      type: 'ORGANIZATION',
      organizationId: query.organizationId,
    });
    const rows = await this.prisma.benefitPlan.findMany({
      where: {
        organizationId: query.organizationId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
      },
      include: {
        options: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } },
      },
      orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
    const liveCoverage = await this.liveCoverage(
      query.organizationId,
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) => ({
        ...this.planShape(row),
        optionCount: row.options.length,
        actions: this.planActions(row, canManage, {
          optionCount: row.options.length,
          liveCoverage: liveCoverage.get(row.id) ?? 0,
        }),
      })),
    };
  }

  async detail(userId: string, planId: string) {
    const plan = await this.planOrThrow(planId);
    await this.access.requirePlanRead(
      userId,
      plan.organizationId,
      this.prisma,
      'Benefit plan not found.',
    );
    const grants = await this.access.grants(userId);
    const canManage = this.access.can(grants, 'benefit.plan.manage', {
      type: 'ORGANIZATION',
      organizationId: plan.organizationId,
    });
    const full = await this.prisma.benefitPlan.findUniqueOrThrow({
      where: { id: planId },
      include: {
        organization: { select: { id: true, name: true, timezone: true } },
        options: {
          orderBy: [
            { archivedAt: 'asc' },
            { sortOrder: 'asc' },
            { code: 'asc' },
          ],
        },
        rates: {
          orderBy: [
            { optionId: 'asc' },
            { effectiveFrom: 'asc' },
            { createdAt: 'asc' },
          ],
        },
        eligibilityRules: {
          orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }],
          // Batch 7C: criteria by name (pickers and display never show raw ids).
          include: {
            organizationalUnit: { select: { name: true } },
            department: { select: { name: true } },
            position: { select: { name: true } },
          },
        },
      },
    });
    const { today } = benefitsToday(
      this.clock.now(),
      full.organization.timezone,
    );
    const enrolled = await this.prisma.benefitEnrollment.groupBy({
      by: ['optionId'],
      where: {
        planId,
        supersededAt: null,
        electionType: 'ENROLLED',
        OR: [{ coverageEnd: null }, { coverageEnd: { gte: today } }],
      },
      _count: { _all: true },
    });
    const enrolledBy = new Map(
      enrolled.map((row) => [row.optionId, row._count._all]),
    );
    return {
      ...this.planShape(full),
      organization: full.organization,
      asOf: formatDate(today),
      actions: this.planActions(full, canManage, {
        optionCount: full.options.filter((option) => !option.archivedAt).length,
        liveCoverage:
          (await this.liveCoverage(full.organizationId, [full.id])).get(
            full.id,
          ) ?? 0,
      }),
      options: full.options.map((option) => ({
        ...this.optionShape(option),
        currentAndFutureEnrollments: enrolledBy.get(option.id) ?? 0,
        actions: {
          canEdit: canManage && !option.archivedAt && !full.archivedAt,
          canArchive:
            canManage &&
            !option.archivedAt &&
            !full.archivedAt &&
            (enrolledBy.get(option.id) ?? 0) === 0,
        },
      })),
      rates: full.rates.map((rate) => ({
        id: rate.id,
        optionId: rate.optionId,
        effectiveFrom: formatDate(rate.effectiveFrom),
        effectiveTo: isoDate(rate.effectiveTo),
        frequency: rate.frequency,
        employeeAmount: rate.employeeAmount.toFixed(2),
        employerAmount: rate.employerAmount.toFixed(2),
        currency: full.currency,
        recordType: rate.recordType,
        supersedesRateId: rate.supersedesRateId,
        supersededAt: rate.supersededAt?.toISOString() ?? null,
        reason: rate.reason,
        createdAt: rate.createdAt.toISOString(),
        // Batch 7C (B13): what correctRate accepts.
        actions: {
          canCorrect:
            canManage &&
            !rate.supersededAt &&
            !full.archivedAt &&
            !full.options.find((option) => option.id === rate.optionId)
              ?.archivedAt,
        },
      })),
      eligibilityRules: full.eligibilityRules.map((rule) => ({
        id: rule.id,
        effectiveFrom: formatDate(rule.effectiveFrom),
        effectiveTo: isoDate(rule.effectiveTo),
        organizationalUnitId: rule.organizationalUnitId,
        organizationalUnitName: rule.organizationalUnit?.name ?? null,
        includeSubunits: rule.includeSubunits,
        departmentId: rule.departmentId,
        departmentName: rule.department?.name ?? null,
        positionId: rule.positionId,
        positionName: rule.position?.name ?? null,
        employmentTypes: rule.employmentTypes,
        minimumServiceDays: rule.minimumServiceDays,
        createdAt: rule.createdAt.toISOString(),
      })),
    };
  }

  // ─── Plan writes ───────────────────────────────────────────────────────────

  async create(input: CreatePlanInput, context: BenefitsRequestContext) {
    await this.access.requirePlanManage(
      context.actorUserId,
      input.organizationId,
    );
    const code = parseBenefitCode(input.code);
    const currency = parseBenefitCurrency(input.currency);
    const range = parseBenefitRange(input.effectiveFrom, input.effectiveTo);
    if (!BENEFIT_TYPES.includes(input.benefitType)) {
      throw new BadRequestException('benefitType is not supported.');
    }
    const childAge = this.childAge(input.dependentChildMaxAge);
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: input.organizationId },
      });
      if (!organization || organization.archivedAt) {
        throw new NotFoundException('Organization not found.');
      }
      const existing = await tx.benefitPlan.findUnique({
        where: {
          organizationId_code: { organizationId: input.organizationId, code },
        },
      });
      if (existing) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_PLAN_CODE_TAKEN',
            `Plan code ${code} is already used.`,
          ),
        );
      }
      const plan = await tx.benefitPlan.create({
        data: {
          organizationId: input.organizationId,
          code,
          name: requiredText(input.name, 'name'),
          description: text(input.description, 'description') ?? null,
          benefitType: input.benefitType,
          providerName: text(input.providerName, 'providerName', 200) ?? null,
          providerReference:
            text(input.providerReference, 'providerReference', 200) ?? null,
          currency,
          effectiveFrom: range.from,
          effectiveTo: range.to,
          employerContributionTaxable:
            input.employerContributionTaxable ?? false,
          showEmployerCostToEmployee: input.showEmployerCostToEmployee ?? true,
          dependentChildMaxAge: childAge ?? null,
          createdByUserId: context.actorUserId ?? null,
        },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_PLAN_CREATED',
        entityType: 'BenefitPlan',
        entityId: plan.id,
        context,
        metadata: {
          organizationId: plan.organizationId,
          code,
          benefitType: plan.benefitType,
          currency,
          effectiveFrom: formatDate(plan.effectiveFrom),
          effectiveTo: isoDate(plan.effectiveTo),
        },
      });
      return this.planShape(plan);
    });
  }

  async update(
    planId: string,
    input: UpdatePlanInput,
    context: BenefitsRequestContext,
  ) {
    const plan = await this.planOrThrow(planId);
    await this.access.requirePlanManage(
      context.actorUserId,
      plan.organizationId,
      this.prisma,
      'Benefit plan not found.',
    );
    const childAge = this.childAge(input.dependentChildMaxAge);
    return this.prisma.$transaction(async (tx) => {
      await lockPlan(tx, planId);
      const current = await tx.benefitPlan.findUniqueOrThrow({
        where: { id: planId },
      });
      if (current.archivedAt) throw this.archived();
      const data: Prisma.BenefitPlanUpdateInput = {};
      if (input.name !== undefined)
        data.name = requiredText(input.name, 'name');
      if (input.description !== undefined)
        data.description = text(input.description, 'description');
      if (input.providerName !== undefined)
        data.providerName = text(input.providerName, 'providerName', 200);
      if (input.providerReference !== undefined)
        data.providerReference = text(
          input.providerReference,
          'providerReference',
          200,
        );
      if (input.employerContributionTaxable !== undefined)
        data.employerContributionTaxable = input.employerContributionTaxable;
      if (input.showEmployerCostToEmployee !== undefined)
        data.showEmployerCostToEmployee = input.showEmployerCostToEmployee;
      if (input.dependentChildMaxAge !== undefined)
        data.dependentChildMaxAge = childAge;
      if (input.effectiveFrom !== undefined) {
        // The start moves only while the plan is a draft (nothing depends on it yet).
        if (current.status !== 'DRAFT') {
          throw new ConflictException(
            domainError(
              409,
              'BENEFIT_PLAN_NOT_DRAFT',
              'A plan start date changes only while the plan is a draft.',
            ),
          );
        }
        data.effectiveFrom = parseBenefitRange(
          input.effectiveFrom,
          current.effectiveTo ? formatDate(current.effectiveTo) : null,
        ).from;
        // Batch 7C (B11): a draft may already carry rates; its start never passes them.
        const earlier = await tx.benefitRate.findFirst({
          where: {
            planId,
            supersededAt: null,
            effectiveFrom: { lt: data.effectiveFrom },
          },
          orderBy: { effectiveFrom: 'asc' },
        });
        if (earlier) {
          throw new ConflictException(
            domainError(
              409,
              'BENEFIT_PLAN_START_AFTER_RATE',
              'A rate starts before that date; correct the rate first.',
              { rateStart: formatDate(earlier.effectiveFrom) },
            ),
          );
        }
      }
      const updated = await tx.benefitPlan.update({
        where: { id: planId },
        data,
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_PLAN_UPDATED',
        entityType: 'BenefitPlan',
        entityId: planId,
        context,
        metadata: { changed: Object.keys(data).sort() },
      });
      return this.planShape(updated);
    });
  }

  /** DRAFT → ACTIVE (needs an option), ACTIVE → CLOSED, CLOSED → ACTIVE. */
  async transition(
    planId: string,
    to: Exclude<BenefitPlanStatus, 'DRAFT'>,
    context: BenefitsRequestContext,
  ) {
    const plan = await this.planOrThrow(planId);
    await this.access.requirePlanManage(
      context.actorUserId,
      plan.organizationId,
      this.prisma,
      'Benefit plan not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await lockPlan(tx, planId);
      const current = await tx.benefitPlan.findUniqueOrThrow({
        where: { id: planId },
      });
      if (current.archivedAt) throw this.archived();
      const allowed =
        (to === 'ACTIVE' &&
          (current.status === 'DRAFT' || current.status === 'CLOSED')) ||
        (to === 'CLOSED' && current.status === 'ACTIVE');
      if (!allowed) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_PLAN_STATUS',
            `A ${current.status.toLowerCase()} plan cannot become ${to.toLowerCase()}.`,
          ),
        );
      }
      if (to === 'ACTIVE') {
        const options = await tx.benefitCoverageOption.count({
          where: { planId, archivedAt: null },
        });
        if (options === 0) {
          throw new ConflictException(
            domainError(
              409,
              'BENEFIT_PLAN_HAS_NO_OPTIONS',
              'Add at least one coverage option before activating the plan.',
            ),
          );
        }
      }
      const updated = await tx.benefitPlan.update({
        where: { id: planId },
        data: { status: to },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action:
          to === 'ACTIVE' ? 'BENEFIT_PLAN_ACTIVATED' : 'BENEFIT_PLAN_CLOSED',
        entityType: 'BenefitPlan',
        entityId: planId,
        context,
        metadata: { previousStatus: current.status, status: to },
      });
      return this.planShape(updated);
    });
  }

  /** Hides a plan whose coverage is all in the past; its history stays readable. */
  async archive(planId: string, context: BenefitsRequestContext) {
    const plan = await this.planOrThrow(planId);
    await this.access.requirePlanManage(
      context.actorUserId,
      plan.organizationId,
      this.prisma,
      'Benefit plan not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await lockPlan(tx, planId);
      const current = await tx.benefitPlan.findUniqueOrThrow({
        where: { id: planId },
        include: { organization: { select: { timezone: true } } },
      });
      if (current.archivedAt) return this.planShape(current);
      const { today } = benefitsToday(
        this.clock.now(),
        current.organization.timezone,
      );
      const live = await tx.benefitEnrollment.count({
        where: {
          planId,
          supersededAt: null,
          OR: [{ coverageEnd: null }, { coverageEnd: { gte: today } }],
        },
      });
      if (live > 0) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_PLAN_HAS_COVERAGE',
            'End or supersede the plan’s current and future elections before archiving it.',
            { elections: live },
          ),
        );
      }
      const updated = await tx.benefitPlan.update({
        where: { id: planId },
        data: {
          archivedAt: this.clock.now(),
          status: current.status === 'DRAFT' ? 'DRAFT' : 'CLOSED',
        },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_PLAN_ARCHIVED',
        entityType: 'BenefitPlan',
        entityId: planId,
        context,
        metadata: { previousStatus: current.status },
      });
      return this.planShape(updated);
    });
  }

  // ─── Options ───────────────────────────────────────────────────────────────

  async addOption(
    planId: string,
    input: {
      code: string;
      name: string;
      coverageLevel: BenefitCoverageLevel;
      sortOrder?: number;
    },
    context: BenefitsRequestContext,
  ) {
    const plan = await this.planOrThrow(planId);
    await this.access.requirePlanManage(
      context.actorUserId,
      plan.organizationId,
      this.prisma,
      'Benefit plan not found.',
    );
    const code = parseBenefitCode(input.code);
    if (!BENEFIT_COVERAGE_LEVELS.includes(input.coverageLevel)) {
      throw new BadRequestException('coverageLevel is not supported.');
    }
    return this.prisma.$transaction(async (tx) => {
      await lockPlan(tx, planId);
      const current = await tx.benefitPlan.findUniqueOrThrow({
        where: { id: planId },
      });
      if (current.archivedAt) throw this.archived();
      if (
        await tx.benefitCoverageOption.findUnique({
          where: { planId_code: { planId, code } },
        })
      ) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_OPTION_CODE_TAKEN',
            `Option code ${code} is already used.`,
          ),
        );
      }
      const option = await tx.benefitCoverageOption.create({
        data: {
          planId,
          code,
          name: requiredText(input.name, 'name'),
          coverageLevel: input.coverageLevel,
          sortOrder: input.sortOrder ?? 0,
        },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_OPTION_CREATED',
        entityType: 'BenefitCoverageOption',
        entityId: option.id,
        context,
        metadata: { planId, code, coverageLevel: option.coverageLevel },
      });
      return this.optionShape(option);
    });
  }

  async updateOption(
    optionId: string,
    input: { name?: string; sortOrder?: number },
    context: BenefitsRequestContext,
  ) {
    const option = await this.optionOrThrow(optionId);
    await this.access.requirePlanManage(
      context.actorUserId,
      option.plan.organizationId,
      this.prisma,
      'Coverage option not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await lockPlan(tx, option.planId);
      const current = await tx.benefitCoverageOption.findUniqueOrThrow({
        where: { id: optionId },
        include: { plan: { select: { archivedAt: true } } },
      });
      // Batch 7C (B12): an archived plan's options are history too.
      if (current.plan.archivedAt) throw this.archived();
      if (current.archivedAt) throw this.archived('option');
      const updated = await tx.benefitCoverageOption.update({
        where: { id: optionId },
        data: {
          ...(input.name !== undefined
            ? { name: requiredText(input.name, 'name') }
            : {}),
          ...(input.sortOrder !== undefined
            ? { sortOrder: input.sortOrder }
            : {}),
        },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_OPTION_UPDATED',
        entityType: 'BenefitCoverageOption',
        entityId: optionId,
        context,
        metadata: { planId: option.planId, changed: Object.keys(input).sort() },
      });
      return this.optionShape(updated);
    });
  }

  /** Archives an option no current or future election uses; past elections keep it. */
  async archiveOption(optionId: string, context: BenefitsRequestContext) {
    const option = await this.optionOrThrow(optionId);
    await this.access.requirePlanManage(
      context.actorUserId,
      option.plan.organizationId,
      this.prisma,
      'Coverage option not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await lockPlan(tx, option.planId);
      const current = await tx.benefitCoverageOption.findUniqueOrThrow({
        where: { id: optionId },
        include: { plan: { select: { archivedAt: true } } },
      });
      if (current.archivedAt) return this.optionShape(current);
      // Batch 7C (B12): an archived plan's options are history too.
      if (current.plan.archivedAt) throw this.archived();
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: option.plan.organizationId },
      });
      const { today } = benefitsToday(this.clock.now(), organization.timezone);
      const live = await tx.benefitEnrollment.count({
        where: {
          optionId,
          supersededAt: null,
          OR: [{ coverageEnd: null }, { coverageEnd: { gte: today } }],
        },
      });
      if (live > 0) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_OPTION_HAS_COVERAGE',
            'Elections still use this option; change or end them first.',
            { elections: live },
          ),
        );
      }
      const updated = await tx.benefitCoverageOption.update({
        where: { id: optionId },
        data: { archivedAt: this.clock.now() },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_OPTION_ARCHIVED',
        entityType: 'BenefitCoverageOption',
        entityId: optionId,
        context,
        metadata: { planId: option.planId },
      });
      return this.optionShape(updated);
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async planOrThrow(planId: string, client: PrismaService | Tx = this.prisma) {
    const plan = await client.benefitPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Benefit plan not found.');
    return plan;
  }

  async optionOrThrow(
    optionId: string,
    client: PrismaService | Tx = this.prisma,
  ) {
    const option = await client.benefitCoverageOption.findUnique({
      where: { id: optionId },
      include: { plan: true },
    });
    if (!option) throw new NotFoundException('Coverage option not found.');
    return option;
  }

  private childAge(value: number | null | undefined) {
    if (value === undefined || value === null) return value;
    if (!Number.isInteger(value) || value < 0 || value > 99) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_CHILD_AGE_INVALID',
          'dependentChildMaxAge must be 0–99.',
        ),
      );
    }
    return value;
  }

  /**
   * Current or future coverage (any election not superseded, waivers included) per plan, as
   * archiving the plan checks it (the organization's today).
   */
  private async liveCoverage(organizationId: string, planIds: string[]) {
    if (planIds.length === 0) return new Map<string, number>();
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const { today } = benefitsToday(this.clock.now(), organization.timezone);
    const rows = await this.prisma.benefitEnrollment.groupBy({
      by: ['planId'],
      where: {
        planId: { in: planIds },
        supersededAt: null,
        OR: [{ coverageEnd: null }, { coverageEnd: { gte: today } }],
      },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.planId, row._count._all]));
  }

  private archived(what = 'plan') {
    return new ConflictException(
      domainError(
        409,
        'BENEFIT_ARCHIVED',
        `The ${what} is archived and cannot change.`,
      ),
    );
  }

  /**
   * Batch 7C (B13): flags match what the service accepts — activation needs an option,
   * archiving needs no current or future coverage, the start date moves only on a draft.
   */
  private planActions(
    plan: BenefitPlan,
    canManage: boolean,
    facts: { optionCount: number; liveCoverage: number },
  ) {
    const live = canManage && !plan.archivedAt;
    return {
      canEdit: live,
      canEditStart: live && plan.status === 'DRAFT',
      canActivate:
        live &&
        (plan.status === 'DRAFT' || plan.status === 'CLOSED') &&
        facts.optionCount > 0,
      canClose: live && plan.status === 'ACTIVE',
      canArchive: live && facts.liveCoverage === 0,
      canManageOptions: live,
      canManageRates: live,
      canManageEligibility: live,
    };
  }

  planShape(plan: BenefitPlan) {
    return {
      id: plan.id,
      organizationId: plan.organizationId,
      code: plan.code,
      name: plan.name,
      description: plan.description,
      benefitType: plan.benefitType,
      providerName: plan.providerName,
      providerReference: plan.providerReference,
      currency: plan.currency,
      status: plan.status,
      effectiveFrom: formatDate(plan.effectiveFrom),
      effectiveTo: isoDate(plan.effectiveTo),
      employerContributionTaxable: plan.employerContributionTaxable,
      showEmployerCostToEmployee: plan.showEmployerCostToEmployee,
      dependentChildMaxAge: plan.dependentChildMaxAge,
      archived: plan.archivedAt !== null,
      createdAt: plan.createdAt.toISOString(),
    };
  }

  optionShape(option: {
    id: string;
    planId: string;
    code: string;
    name: string;
    coverageLevel: BenefitCoverageLevel;
    sortOrder: number;
    archivedAt: Date | null;
  }) {
    return {
      id: option.id,
      planId: option.planId,
      code: option.code,
      name: option.name,
      coverageLevel: option.coverageLevel,
      sortOrder: option.sortOrder,
      archived: option.archivedAt !== null,
    };
  }
}
