import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { settingDisabled } from '../features/features-domain.js';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  formatDate,
  parseDateOnly,
  positionTargets,
  requireActor,
} from '../common/domain-support.js';
import { pageList } from '../common/option-paging.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  PerformanceCycle,
  PerformanceReviewerModel,
  Prisma,
} from '../generated/prisma/client.js';
import { PerformanceAccessService } from './performance-access.service.js';
import {
  isoDate,
  lockCycle,
  PerformanceClock,
  performanceToday,
  shareCycle,
  writePerformanceAudit,
  type PerformanceRequestContext,
} from './performance-common.js';
import { parsePerformanceCode, parseText } from './performance-domain.js';

export interface CycleInput {
  organizationId: string;
  code: string;
  name: string;
  description?: string | null;
  templateId: string;
  reviewerModel?: PerformanceReviewerModel;
  selfReviewEnabled?: boolean;
  acknowledgementEnabled?: boolean;
  periodStart: string;
  periodEnd: string;
  windowStart: string;
  windowEnd: string;
  selfReviewDueDate?: string | null;
  reviewerDueDate?: string | null;
}

export interface CycleTargetInput {
  assignmentIds?: string[];
  /** Every assignment of the organization active in the review period (optionally narrowed). */
  allInOrganization?: boolean;
  organizationalUnitId?: string;
  departmentId?: string;
  teamId?: string;
}

/** Batch 7B (D4): cycle-level operations never act on the actor's own review. */
const selfManagement = () =>
  new ForbiddenException(
    domainError(
      403,
      'PERFORMANCE_SELF_MANAGEMENT',
      'You cannot manage your own performance review; ask another cycle manager.',
    ),
  );
const conflict = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new ConflictException(domainError(409, code, message, extra));
const invalid = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new BadRequestException(domainError(400, code, message, extra));

const ACTIVE_REVIEW = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED'] as const;

const day = (value: string, field: string) => parseDateOnly(value, field);

/**
 * Phase 12 Batch 12.3 — review cycles (performance.cycle.manage at the organization).
 *
 * A cycle is configured as a DRAFT (template, reviewer model, dates, who is reviewed), OPENed
 * — which freezes the template into the cycle's own form snapshot (wording, competency labels,
 * scale levels, weights, order) — CLOSED (incomplete reviews are closed explicitly, never
 * silently) and ARCHIVED. An opened cycle's template, period and reviewer model never change;
 * its window may move as long as it stays consistent with its due dates.
 *
 * Reviews are tied to an EmploymentAssignment active in the review period, one per cycle and
 * assignment. With DIRECT_MANAGER the reviewer is the assignment's manager when the review is
 * added (recorded on the review; later reporting-line changes never move access).
 */
@Injectable()
export class PerformanceCycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PerformanceAccessService,
    private readonly audit: AuditService,
    private readonly clock: PerformanceClock,
  ) {}

  // ─── Reads ────────────────────────────────────────────────────────────────

  async list(userId: string, organizationId: string, includeArchived = false) {
    await this.access.requireConfigurationRead(userId, organizationId);
    const grants = await this.access.grants(userId);
    const canManage = this.access.canInOrganization(
      grants,
      'performance.cycle.manage',
      organizationId,
    );
    const rows = await this.prisma.performanceCycle.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { status: { not: 'ARCHIVED' } }),
      },
      include: { template: { select: { id: true, code: true, name: true } } },
      orderBy: [{ windowStart: 'desc' }, { name: 'asc' }],
    });
    // Batch 7B (S8): status counts cover the reviews the viewer may monitor — every review
    // with performance.cycle.manage, otherwise those within their performance.read/manage
    // scope or that they review (never their own), as in reviews() below.
    const reviews = await this.prisma.performanceReview.findMany({
      where: { cycleId: { in: rows.map((row) => row.id) } },
      select: {
        cycleId: true,
        status: true,
        employeeId: true,
        reviewerEmployeeId: true,
        employmentAssignment: {
          select: {
            position: {
              select: {
                id: true,
                organizationId: true,
                organizationalUnitId: true,
                departmentId: true,
                teamId: true,
              },
            },
          },
        },
      },
    });
    let visibleReviews = reviews;
    if (!canManage) {
      const employeeId = await this.access.employeeIdOfUser(userId);
      const targets = await positionTargets(
        this.prisma,
        reviews.map((review) => review.employmentAssignment.position),
      );
      visibleReviews = reviews.filter((review) => {
        if (employeeId !== null && employeeId === review.employeeId)
          return false;
        if (employeeId !== null && employeeId === review.reviewerEmployeeId)
          return true;
        const target = targets.get(review.employmentAssignment.position.id)!;
        return (
          this.access.can(grants, 'performance.manage', target) ||
          this.access.can(grants, 'performance.read', target)
        );
      });
    }
    const countsOf = (cycleId: string) => {
      const counts: Record<string, number> = {};
      for (const review of visibleReviews)
        if (review.cycleId === cycleId)
          counts[review.status] = (counts[review.status] ?? 0) + 1;
      return counts;
    };
    return {
      items: rows.map((row) => ({
        ...this.shape(row),
        template: row.template,
        reviewCounts: countsOf(row.id),
        actions: this.actions(row, canManage),
      })),
    };
  }

  async detail(userId: string, cycleId: string) {
    const row = await this.prisma.performanceCycle.findUnique({
      where: { id: cycleId },
      include: {
        template: {
          select: { id: true, code: true, name: true, status: true },
        },
        organization: { select: { id: true, name: true, timezone: true } },
        formSections: {
          orderBy: { sortOrder: 'asc' },
          include: { items: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
    if (!row) throw new NotFoundException('Review cycle not found.');
    await this.access.notFoundOutside(
      userId,
      row.organizationId,
      'Review cycle not found.',
    );
    await this.access.requireConfigurationRead(userId, row.organizationId);
    const grants = await this.access.grants(userId);
    const canManage = this.access.canInOrganization(
      grants,
      'performance.cycle.manage',
      row.organizationId,
    );
    return {
      ...this.shape(row),
      template: row.template,
      organization: row.organization,
      form: formShape(row.formSections),
      actions: this.actions(row, canManage),
    };
  }

  /**
   * Monitoring: the cycle's reviews the user may see — all of them with
   * performance.cycle.manage, otherwise those within their performance.read/manage scope. Only
   * status and progress, never review content.
   */
  async reviews(
    userId: string,
    cycleId: string,
    /** Batch 7B: filters and cursor paging (all of them without a limit). */
    filters: {
      status?: string;
      reviewerEmployeeId?: string;
      withoutReviewer?: boolean;
      search?: string;
      limit?: number;
      afterId?: string;
    } = {},
  ) {
    const cycle = await this.cycleOrThrow(cycleId);
    const grants = await this.access.grants(userId);
    const canManageCycle = this.access.canInOrganization(
      grants,
      'performance.cycle.manage',
      cycle.organizationId,
    );
    if (
      !canManageCycle &&
      !(await this.access.hasAnyInOrganization(
        userId,
        cycle.organizationId,
        this.prisma,
        grants,
      ))
    ) {
      await this.access.notFoundOutside(
        userId,
        cycle.organizationId,
        'Review cycle not found.',
      );
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Missing performance permissions for the cycle.',
        ),
      );
    }
    await this.access.requireEnabled(cycle.organizationId);
    const rows = await this.prisma.performanceReview.findMany({
      where: { cycleId },
      include: {
        employmentAssignment: {
          include: {
            employee: {
              select: {
                id: true,
                employeeNumber: true,
                person: {
                  select: {
                    firstName: true,
                    lastName: true,
                    preferredName: true,
                  },
                },
              },
            },
            position: {
              select: {
                id: true,
                name: true,
                organizationId: true,
                organizationalUnitId: true,
                departmentId: true,
                teamId: true,
              },
            },
          },
        },
        reviewer: {
          select: {
            id: true,
            person: {
              select: { firstName: true, lastName: true, preferredName: true },
            },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: cycle.organizationId },
      select: { timezone: true },
    });
    const today = performanceToday(this.clock.now(), organization.timezone);
    // Phase 19: batched. The per-row reviewAccess (≈4 queries per review) is replaced by one
    // grant load, one employee lookup and one placement resolution, with the same rule:
    // performance.read / .manage on the assignment (never one's own review) or its reviewer.
    const visible = [];
    if (canManageCycle) visible.push(...rows);
    else {
      const employeeId = await this.access.employeeIdOfUser(userId);
      const targets = await positionTargets(
        this.prisma,
        rows.map((row) => row.employmentAssignment.position),
      );
      for (const row of rows) {
        const isSelf = employeeId !== null && employeeId === row.employeeId;
        if (isSelf) continue;
        const target = targets.get(row.employmentAssignment.position.id)!;
        const isReviewer =
          employeeId !== null && employeeId === row.reviewerEmployeeId;
        if (
          isReviewer ||
          this.access.can(grants, 'performance.manage', target) ||
          this.access.can(grants, 'performance.read', target)
        )
          visible.push(row);
      }
    }
    const search = filters.search?.trim().toLowerCase();
    const filtered = visible.filter((row) => {
      if (filters.status && row.status !== filters.status) return false;
      if (
        filters.reviewerEmployeeId &&
        row.reviewerEmployeeId !== filters.reviewerEmployeeId
      )
        return false;
      if (filters.withoutReviewer && row.reviewerEmployeeId) return false;
      if (search) {
        const employee = row.employmentAssignment.employee;
        const text =
          `${displayName(employee.person)} ${employee.employeeNumber}`.toLowerCase();
        if (!text.includes(search)) return false;
      }
      return true;
    });
    const page = pageList(filtered, filters.limit, filters.afterId);
    return {
      total: filtered.length,
      nextAfterId: page.nextAfterId,
      items: page.items.map((row) => {
        const employee = row.employmentAssignment.employee;
        return {
          id: row.id,
          employee: {
            id: employee.id,
            employeeNumber: employee.employeeNumber,
            displayName: displayName(employee.person),
          },
          employmentAssignment: {
            id: row.employmentAssignmentId,
            positionName: row.employmentAssignment.position.name,
          },
          reviewer: row.reviewer
            ? {
                id: row.reviewer.id,
                displayName: displayName(row.reviewer.person),
              }
            : null,
          status: row.status,
          selfStatus: row.selfStatus,
          reviewerStatus: row.reviewerStatus,
          overdue: overdueParts(cycle, row, today),
          finalizedAt: row.finalizedAt?.toISOString() ?? null,
          acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
        };
      }),
    };
  }

  /** Phase 18: whether the organization lets cycles include self reviews (default yes). */
  private async selfReviewAllowed(
    organizationId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return (
      (await this.access.features.setting(
        organizationId,
        'performance.selfReview',
        client,
      )) === true
    );
  }

  // ─── Writes ───────────────────────────────────────────────────────────────

  async create(input: CycleInput, context: PerformanceRequestContext) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'performance.cycle.manage',
      input.organizationId,
    );
    const code = parsePerformanceCode(input.code);
    const dates = this.parseDates(input);
    // Phase 18 (performance.selfReview): with self reviews turned off for the organization a
    // new cycle has none, and asking for one is refused.
    const selfReviewAllowed = await this.selfReviewAllowed(
      input.organizationId,
    );
    if (input.selfReviewEnabled === true && !selfReviewAllowed)
      throw settingDisabled('performance.selfReview');
    return this.prisma.$transaction(async (tx) => {
      await this.requireActiveTemplate(
        tx,
        input.templateId,
        input.organizationId,
      );
      const taken = await tx.performanceCycle.findUnique({
        where: {
          organizationId_code: { organizationId: input.organizationId, code },
        },
        select: { id: true },
      });
      if (taken)
        throw conflict(
          'PERFORMANCE_CODE_EXISTS',
          `A cycle with code ${code} already exists.`,
        );
      const row = await tx.performanceCycle.create({
        data: {
          organizationId: input.organizationId,
          code,
          name: parseText(input.name, 'name', { required: true, max: 200 })!,
          description: parseText(input.description, 'description', {
            max: 2000,
          }),
          templateId: input.templateId,
          reviewerModel: input.reviewerModel ?? 'DIRECT_MANAGER',
          selfReviewEnabled: input.selfReviewEnabled ?? selfReviewAllowed,
          acknowledgementEnabled: input.acknowledgementEnabled ?? true,
          ...dates,
          createdByUserId: actor,
        },
      });
      await this.auditWrite(tx, 'PERFORMANCE_CYCLE_CREATED', row.id, context, {
        organizationId: row.organizationId,
        code,
        templateId: row.templateId,
        reviewerModel: row.reviewerModel,
      });
      return this.shape(row);
    });
  }

  /**
   * DRAFT: everything but the organization and code. OPEN: name, description, window end and
   * due dates (consistent with the window). CLOSED/ARCHIVED: name and description.
   */
  async update(
    cycleId: string,
    input: Partial<Omit<CycleInput, 'organizationId' | 'code'>>,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const existing = await this.cycleOrThrow(cycleId);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.cycle.manage',
      existing.organizationId,
      'Review cycle not found.',
    );
    if (
      input.selfReviewEnabled === true &&
      !(await this.selfReviewAllowed(existing.organizationId))
    )
      throw settingDisabled('performance.selfReview');
    return this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const current = await tx.performanceCycle.findUniqueOrThrow({
        where: { id: cycleId },
      });
      const draftOnly = (
        [
          'templateId',
          'reviewerModel',
          'selfReviewEnabled',
          'acknowledgementEnabled',
          'periodStart',
          'periodEnd',
          'windowStart',
        ] as const
      ).filter((key) => input[key] !== undefined);
      const openOnly = (
        ['windowEnd', 'selfReviewDueDate', 'reviewerDueDate'] as const
      ).filter((key) => input[key] !== undefined);
      if (current.status !== 'DRAFT' && draftOnly.length > 0) {
        throw conflict(
          'PERFORMANCE_CYCLE_FROZEN',
          'An opened cycle keeps its template, period, window start and reviewer model.',
          { fields: draftOnly },
        );
      }
      if (
        ['CLOSED', 'ARCHIVED'].includes(current.status) &&
        openOnly.length > 0
      ) {
        throw conflict(
          'PERFORMANCE_CYCLE_FROZEN',
          "A closed cycle's dates never change.",
          {
            fields: openOnly,
          },
        );
      }
      if (input.templateId !== undefined) {
        await this.requireActiveTemplate(
          tx,
          input.templateId,
          current.organizationId,
        );
      }
      const merged = {
        periodStart: input.periodStart ?? formatDate(current.periodStart),
        periodEnd: input.periodEnd ?? formatDate(current.periodEnd),
        windowStart: input.windowStart ?? formatDate(current.windowStart),
        windowEnd: input.windowEnd ?? formatDate(current.windowEnd),
        selfReviewDueDate:
          input.selfReviewDueDate !== undefined
            ? input.selfReviewDueDate
            : isoDate(current.selfReviewDueDate),
        reviewerDueDate:
          input.reviewerDueDate !== undefined
            ? input.reviewerDueDate
            : isoDate(current.reviewerDueDate),
      };
      const dates = this.parseDates(merged);
      const row = await tx.performanceCycle.update({
        where: { id: cycleId },
        data: {
          ...(input.name !== undefined
            ? {
                name: parseText(input.name, 'name', {
                  required: true,
                  max: 200,
                })!,
              }
            : {}),
          ...(input.description !== undefined
            ? {
                description: parseText(input.description, 'description', {
                  max: 2000,
                }),
              }
            : {}),
          ...(input.templateId !== undefined
            ? { templateId: input.templateId }
            : {}),
          ...(input.reviewerModel !== undefined
            ? { reviewerModel: input.reviewerModel }
            : {}),
          ...(input.selfReviewEnabled !== undefined
            ? { selfReviewEnabled: input.selfReviewEnabled }
            : {}),
          ...(input.acknowledgementEnabled !== undefined
            ? { acknowledgementEnabled: input.acknowledgementEnabled }
            : {}),
          ...(current.status === 'DRAFT'
            ? dates
            : ['CLOSED', 'ARCHIVED'].includes(current.status)
              ? {}
              : {
                  windowEnd: dates.windowEnd,
                  selfReviewDueDate: dates.selfReviewDueDate,
                  reviewerDueDate: dates.reviewerDueDate,
                }),
        },
      });
      await this.auditWrite(tx, 'PERFORMANCE_CYCLE_UPDATED', cycleId, context, {
        organizationId: row.organizationId,
        status: row.status,
        fields: Object.keys(input).filter(
          (key) => input[key as keyof typeof input] !== undefined,
        ),
      });
      return this.shape(row);
    });
  }

  /**
   * Adds reviews (idempotent: assignments already in the cycle are skipped). Targets are
   * explicit assignments and/or every assignment of the organization (optionally of a unit,
   * department or team) active at some point in the review period.
   */
  async addReviews(
    cycleId: string,
    input: CycleTargetInput,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const existing = await this.cycleOrThrow(cycleId);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.cycle.manage',
      existing.organizationId,
      'Review cycle not found.',
    );
    if (!input.allInOrganization && !input.assignmentIds?.length) {
      throw invalid(
        'PERFORMANCE_TARGET_REQUIRED',
        'Choose assignments, or every assignment of the organization (optionally narrowed).',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await shareCycle(tx, cycleId);
      const cycle = await tx.performanceCycle.findUniqueOrThrow({
        where: { id: cycleId },
      });
      if (!['DRAFT', 'OPEN'].includes(cycle.status)) {
        throw conflict(
          'PERFORMANCE_CYCLE_NOT_ACCEPTING',
          'Reviews are added to draft or open cycles.',
        );
      }
      const inPeriod: Prisma.EmploymentAssignmentWhereInput = {
        status: { not: 'CANCELLED' },
        startDate: { lte: cycle.periodEnd },
        OR: [{ endDate: null }, { endDate: { gte: cycle.periodStart } }],
        position: { organizationId: cycle.organizationId },
      };
      const select = {
        id: true,
        employeeId: true,
        managerAssignmentId: true,
        manager: { select: { id: true, employeeId: true, status: true } },
      } as const;
      const candidates = new Map<
        string,
        Prisma.EmploymentAssignmentGetPayload<{ select: typeof select }>
      >();
      if (input.assignmentIds?.length) {
        const ids = [...new Set(input.assignmentIds)];
        const rows = await tx.employmentAssignment.findMany({
          where: { id: { in: ids }, ...inPeriod },
          select,
        });
        if (rows.length !== ids.length) {
          throw invalid(
            'PERFORMANCE_ASSIGNMENT_NOT_ELIGIBLE',
            "Every assignment must belong to the cycle's organization and be active in its review period.",
            {
              assignmentIds: ids.filter(
                (id) => !rows.some((row) => row.id === id),
              ),
            },
          );
        }
        for (const row of rows) candidates.set(row.id, row);
      }
      if (input.allInOrganization) {
        const narrowed: Prisma.PositionWhereInput = {
          organizationId: cycle.organizationId,
          ...(input.organizationalUnitId
            ? {
                OR: [
                  { organizationalUnitId: input.organizationalUnitId },
                  {
                    department: {
                      organizationalUnitId: input.organizationalUnitId,
                    },
                  },
                ],
              }
            : {}),
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          ...(input.teamId ? { teamId: input.teamId } : {}),
        };
        const rows = await tx.employmentAssignment.findMany({
          where: { ...inPeriod, position: narrowed },
          select,
        });
        for (const row of rows) candidates.set(row.id, row);
      }
      // Batch 7B (D4): the actor's own assignments are never added (reported, not refused).
      const actorEmployeeId = await this.access.employeeIdOfUser(actor, tx);
      let excludedOwn = 0;
      for (const [id, row] of [...candidates]) {
        if (actorEmployeeId && row.employeeId === actorEmployeeId) {
          candidates.delete(id);
          excludedOwn += 1;
        }
      }
      const already = new Set(
        (
          await tx.performanceReview.findMany({
            where: {
              cycleId,
              employmentAssignmentId: { in: [...candidates.keys()] },
            },
            select: { employmentAssignmentId: true },
          })
        ).map((row) => row.employmentAssignmentId),
      );
      const now = this.clock.now();
      const asksSelf =
        cycle.selfReviewEnabled &&
        (cycle.status === 'DRAFT' ||
          (await tx.performanceFormItem.count({
            where: { cycleId, respondent: { not: 'REVIEWER' } },
          })) > 0);
      const drafts = [...candidates.values()]
        .filter((row) => !already.has(row.id))
        .map((row) => {
          const manager =
            cycle.reviewerModel === 'DIRECT_MANAGER' &&
            row.manager &&
            // Batch 7B (F3): only a current (planned or active) manager assignment reviews.
            ['PLANNED', 'ACTIVE'].includes(row.manager.status) &&
            row.manager.employeeId !== row.employeeId
              ? row.manager
              : null;
          return {
            id: randomUUID(),
            cycleId,
            organizationId: cycle.organizationId,
            employeeId: row.employeeId,
            employmentAssignmentId: row.id,
            selfStatus: asksSelf
              ? ('NOT_STARTED' as const)
              : ('NOT_REQUIRED' as const),
            reviewerEmployeeId: manager?.employeeId ?? null,
            reviewerAssignmentId: manager?.id ?? null,
            reviewerSource: manager ? ('DIRECT_MANAGER' as const) : null,
            reviewerAssignedAt: manager ? now : null,
            createdByUserId: actor,
          };
        });
      // Concurrent additions of the same assignment: the unique key keeps one.
      await tx.performanceReview.createMany({
        data: drafts,
        skipDuplicates: true,
      });
      const created = await tx.performanceReview.findMany({
        where: { id: { in: drafts.map((draft) => draft.id) } },
        select: { id: true, reviewerEmployeeId: true },
      });
      if (cycle.status === 'OPEN') {
        await tx.performanceReviewEvent.createMany({
          data: created.map((review) => ({
            reviewId: review.id,
            type: 'ADDED' as const,
            actorUserId: actor,
            toEmployeeId: review.reviewerEmployeeId,
            toStatus: 'NOT_STARTED' as const,
          })),
        });
      }
      await this.auditWrite(tx, 'PERFORMANCE_REVIEWS_ADDED', cycleId, context, {
        organizationId: cycle.organizationId,
        added: created.length,
        skipped: candidates.size - created.length,
        withoutReviewer: created.filter((review) => !review.reviewerEmployeeId)
          .length,
        excludedOwn,
      });
      return {
        added: created.length,
        skipped: candidates.size - created.length,
        withoutReviewer: created.filter((review) => !review.reviewerEmployeeId)
          .length,
        excludedOwn,
      };
    });
  }

  /** Only a draft cycle's reviews can be removed (nothing has been written in them). */
  async removeReview(
    cycleId: string,
    reviewId: string,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const existing = await this.cycleOrThrow(cycleId);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.cycle.manage',
      existing.organizationId,
      'Review cycle not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const cycle = await tx.performanceCycle.findUniqueOrThrow({
        where: { id: cycleId },
      });
      if (cycle.status !== 'DRAFT') {
        throw conflict(
          'PERFORMANCE_CYCLE_NOT_DRAFT',
          'Reviews of an opened cycle are closed, never removed.',
        );
      }
      const review = await tx.performanceReview.findFirst({
        where: { id: reviewId, cycleId },
      });
      if (!review) throw new NotFoundException('Review not found.');
      if (review.employeeId === (await this.access.employeeIdOfUser(actor, tx)))
        throw selfManagement();
      await tx.performanceReview.delete({ where: { id: reviewId } });
      await this.auditWrite(
        tx,
        'PERFORMANCE_REVIEW_REMOVED',
        cycleId,
        context,
        {
          organizationId: cycle.organizationId,
          reviewId,
          employmentAssignmentId: review.employmentAssignmentId,
        },
      );
      return { removed: true };
    });
  }

  /** DRAFT → OPEN: freezes the template into the cycle's form snapshot. */
  async open(cycleId: string, context: PerformanceRequestContext) {
    const actor = requireActor(context);
    const existing = await this.cycleOrThrow(cycleId);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.cycle.manage',
      existing.organizationId,
      'Review cycle not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const cycle = await tx.performanceCycle.findUniqueOrThrow({
        where: { id: cycleId },
      });
      if (cycle.status !== 'DRAFT') {
        throw conflict(
          'PERFORMANCE_STATUS_INVALID',
          'Only a draft cycle can be opened.',
        );
      }
      // Phase 18: a draft asking for self reviews is not launched while they are turned off.
      if (
        cycle.selfReviewEnabled &&
        !(await this.selfReviewAllowed(cycle.organizationId, tx))
      ) {
        throw settingDisabled('performance.selfReview');
      }
      const template = await tx.performanceTemplate.findUniqueOrThrow({
        where: { id: cycle.templateId },
        include: {
          ratingScale: { include: { levels: { orderBy: { value: 'asc' } } } },
          sections: {
            orderBy: { sortOrder: 'asc' },
            include: {
              items: {
                orderBy: { sortOrder: 'asc' },
                include: {
                  competency: true,
                  ratingScale: {
                    include: { levels: { orderBy: { value: 'asc' } } },
                  },
                },
              },
            },
          },
        },
      });
      if (template.status !== 'ACTIVE') {
        throw conflict(
          'PERFORMANCE_TEMPLATE_NOT_ACTIVE',
          "The cycle's template is no longer active.",
        );
      }
      const reviews = await tx.performanceReview.findMany({
        where: { cycleId },
        select: { id: true, reviewerEmployeeId: true },
      });
      if (reviews.length === 0) {
        throw conflict(
          'PERFORMANCE_CYCLE_EMPTY',
          'Add the employees to review before opening.',
        );
      }
      const hasSelfItems = template.sections.some((section) =>
        section.items.some((item) => item.respondent !== 'REVIEWER'),
      );
      const levels = (
        rows: Array<{
          value: number;
          label: string;
          description: string | null;
        }>,
      ): Prisma.InputJsonValue =>
        rows.map((level) => ({
          value: level.value,
          label: level.label,
          description: level.description,
        }));
      for (const section of template.sections) {
        const formSection = await tx.performanceFormSection.create({
          data: {
            cycleId,
            sortOrder: section.sortOrder,
            title: section.title,
            description: section.description,
          },
        });
        for (const item of section.items) {
          await tx.performanceFormItem.create({
            data: {
              cycleId,
              sectionId: formSection.id,
              sortOrder: item.sortOrder,
              itemType: item.itemType,
              prompt: item.prompt,
              helpText: item.helpText,
              respondent: item.respondent,
              required: item.required,
              weight: item.weight,
              competencyId: item.competencyId,
              competencyCode: item.competency?.code ?? null,
              competencyName: item.competency?.name ?? null,
              ...(item.ratingScale
                ? { scaleLevels: levels(item.ratingScale.levels) }
                : {}),
              scaleMin: item.scaleMin,
              scaleMax: item.scaleMax,
              templateItemId: item.id,
            },
          });
        }
      }
      const opened = await tx.performanceCycle.update({
        where: { id: cycleId },
        data: {
          status: 'OPEN',
          openedAt: this.clock.now(),
          openedByUserId: actor,
          scoringMode: template.scoringMode,
          overallRatingEnabled: template.overallRatingEnabled,
          ...(template.ratingScale
            ? {
                overallScaleLevels: levels(template.ratingScale.levels),
                overallScaleName: template.ratingScale.name,
              }
            : {}),
        },
      });
      // A cycle without self items (or with self review off) never asks the employee.
      const selfStatus =
        cycle.selfReviewEnabled && hasSelfItems
          ? ('NOT_STARTED' as const)
          : ('NOT_REQUIRED' as const);
      await tx.performanceReview.updateMany({
        where: { cycleId },
        data: { selfStatus },
      });
      await tx.performanceReviewEvent.createMany({
        data: reviews.map((review) => ({
          reviewId: review.id,
          type: 'ADDED' as const,
          actorUserId: actor,
          toEmployeeId: review.reviewerEmployeeId,
          toStatus: 'NOT_STARTED' as const,
        })),
      });
      await this.auditWrite(tx, 'PERFORMANCE_CYCLE_OPENED', cycleId, context, {
        organizationId: cycle.organizationId,
        templateId: template.id,
        reviews: reviews.length,
        withoutReviewer: reviews.filter((review) => !review.reviewerEmployeeId)
          .length,
      });
      return this.shape(opened);
    });
  }

  /**
   * OPEN → CLOSED. Reviews still in progress are closed only when asked explicitly
   * (closeIncomplete), as CLOSED/INCOMPLETE with their unsubmitted parts NOT_SUBMITTED.
   * Finalized reviews stay as they are (the employee can still acknowledge them).
   */
  async close(
    cycleId: string,
    input: { closeIncomplete?: boolean; reason?: string | null },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const existing = await this.cycleOrThrow(cycleId);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.cycle.manage',
      existing.organizationId,
      'Review cycle not found.',
    );
    const reason = parseText(input.reason, 'reason', { max: 500 });
    return this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const cycle = await tx.performanceCycle.findUniqueOrThrow({
        where: { id: cycleId },
      });
      if (cycle.status !== 'OPEN') {
        throw conflict(
          'PERFORMANCE_STATUS_INVALID',
          'Only an open cycle can be closed.',
        );
      }
      const incomplete = await tx.performanceReview.findMany({
        where: { cycleId, status: { in: [...ACTIVE_REVIEW] } },
        select: {
          employeeId: true,
          id: true,
          status: true,
          selfStatus: true,
          reviewerStatus: true,
        },
      });
      if (incomplete.length > 0 && !input.closeIncomplete) {
        throw conflict(
          'PERFORMANCE_CYCLE_HAS_INCOMPLETE',
          `${incomplete.length} review(s) are not finalized. Finalize them, or close them as incomplete.`,
          { incomplete: incomplete.length },
        );
      }
      const actorEmployeeId = await this.access.employeeIdOfUser(actor, tx);
      if (
        input.closeIncomplete &&
        actorEmployeeId &&
        incomplete.some((review) => review.employeeId === actorEmployeeId)
      )
        throw selfManagement();
      if (incomplete.length > 0 && !reason) {
        throw invalid(
          'PERFORMANCE_REASON_REQUIRED',
          'Say why incomplete reviews are closed.',
        );
      }
      const now = this.clock.now();
      for (const review of incomplete) {
        await tx.performanceReview.update({
          where: { id: review.id },
          data: {
            status: 'CLOSED',
            closeReason: 'INCOMPLETE',
            closedAt: now,
            closedByUserId: actor,
            ...(['NOT_STARTED', 'IN_PROGRESS'].includes(review.selfStatus)
              ? { selfStatus: 'NOT_SUBMITTED' }
              : {}),
            ...(review.reviewerStatus !== 'SUBMITTED'
              ? { reviewerStatus: 'NOT_SUBMITTED' }
              : {}),
          },
        });
        await tx.performanceReviewEvent.create({
          data: {
            reviewId: review.id,
            type: 'CLOSED',
            actorUserId: actor,
            fromStatus: review.status,
            toStatus: 'CLOSED',
            reason,
          },
        });
      }
      const closed = await tx.performanceCycle.update({
        where: { id: cycleId },
        data: { status: 'CLOSED', closedAt: now, closedByUserId: actor },
      });
      await this.auditWrite(tx, 'PERFORMANCE_CYCLE_CLOSED', cycleId, context, {
        organizationId: cycle.organizationId,
        closedIncomplete: incomplete.length,
      });
      return this.shape(closed);
    });
  }

  async archive(cycleId: string, context: PerformanceRequestContext) {
    const actor = requireActor(context);
    const existing = await this.cycleOrThrow(cycleId);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.cycle.manage',
      existing.organizationId,
      'Review cycle not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const cycle = await tx.performanceCycle.findUniqueOrThrow({
        where: { id: cycleId },
      });
      if (cycle.status !== 'CLOSED') {
        throw conflict(
          'PERFORMANCE_STATUS_INVALID',
          'Only a closed cycle can be archived.',
        );
      }
      const archived = await tx.performanceCycle.update({
        where: { id: cycleId },
        data: { status: 'ARCHIVED', archivedAt: this.clock.now() },
      });
      await this.auditWrite(
        tx,
        'PERFORMANCE_CYCLE_ARCHIVED',
        cycleId,
        context,
        {
          organizationId: cycle.organizationId,
        },
      );
      return this.shape(archived);
    });
  }

  /** A draft cycle (and its reviews, never written in) can be discarded. */
  async discard(cycleId: string, context: PerformanceRequestContext) {
    const actor = requireActor(context);
    const existing = await this.cycleOrThrow(cycleId);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.cycle.manage',
      existing.organizationId,
      'Review cycle not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const cycle = await tx.performanceCycle.findUniqueOrThrow({
        where: { id: cycleId },
      });
      if (cycle.status !== 'DRAFT') {
        throw conflict(
          'PERFORMANCE_CYCLE_NOT_DRAFT',
          'Only a draft cycle can be discarded.',
        );
      }
      // Batch 7B (D4): discarding deletes every review in it — never the actor's own.
      const own = await this.access.employeeIdOfUser(actor, tx);
      if (
        own &&
        (await tx.performanceReview.count({
          where: { cycleId, employeeId: own },
        })) > 0
      )
        throw selfManagement();
      await tx.performanceReview.deleteMany({ where: { cycleId } });
      await tx.performanceCycle.delete({ where: { id: cycleId } });
      await this.auditWrite(
        tx,
        'PERFORMANCE_CYCLE_DISCARDED',
        cycleId,
        context,
        {
          organizationId: cycle.organizationId,
          code: cycle.code,
        },
      );
      return { discarded: true };
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private parseDates(input: {
    periodStart: string;
    periodEnd: string;
    windowStart: string;
    windowEnd: string;
    selfReviewDueDate?: string | null;
    reviewerDueDate?: string | null;
  }) {
    const dates = {
      periodStart: day(input.periodStart, 'periodStart'),
      periodEnd: day(input.periodEnd, 'periodEnd'),
      windowStart: day(input.windowStart, 'windowStart'),
      windowEnd: day(input.windowEnd, 'windowEnd'),
      selfReviewDueDate: input.selfReviewDueDate
        ? day(input.selfReviewDueDate, 'selfReviewDueDate')
        : null,
      reviewerDueDate: input.reviewerDueDate
        ? day(input.reviewerDueDate, 'reviewerDueDate')
        : null,
    };
    if (dates.periodEnd < dates.periodStart) {
      throw invalid(
        'PERFORMANCE_DATES_INVALID',
        'The review period ends before it starts.',
      );
    }
    if (dates.windowEnd < dates.windowStart) {
      throw invalid(
        'PERFORMANCE_DATES_INVALID',
        'The review window ends before it opens.',
      );
    }
    for (const [field, value] of [
      ['selfReviewDueDate', dates.selfReviewDueDate],
      ['reviewerDueDate', dates.reviewerDueDate],
    ] as const) {
      if (value && (value < dates.windowStart || value > dates.windowEnd)) {
        throw invalid(
          'PERFORMANCE_DATES_INVALID',
          `${field} must fall within the review window.`,
          { field },
        );
      }
    }
    return dates;
  }

  private async requireActiveTemplate(
    tx: Prisma.TransactionClient,
    templateId: string,
    organizationId: string,
  ) {
    const template = await tx.performanceTemplate.findFirst({
      where: { id: templateId, organizationId },
      select: { status: true },
    });
    if (!template) {
      throw invalid(
        'PERFORMANCE_TEMPLATE_NOT_FOUND',
        'The template is not in this organization.',
      );
    }
    if (template.status !== 'ACTIVE') {
      throw conflict(
        'PERFORMANCE_TEMPLATE_NOT_ACTIVE',
        'Cycles use active templates only.',
      );
    }
  }

  private async cycleOrThrow(cycleId: string) {
    const row = await this.prisma.performanceCycle.findUnique({
      where: { id: cycleId },
    });
    if (!row) throw new NotFoundException('Review cycle not found.');
    return row;
  }

  private shape(row: PerformanceCycle) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      code: row.code,
      name: row.name,
      description: row.description,
      status: row.status,
      templateId: row.templateId,
      reviewerModel: row.reviewerModel,
      selfReviewEnabled: row.selfReviewEnabled,
      acknowledgementEnabled: row.acknowledgementEnabled,
      periodStart: formatDate(row.periodStart),
      periodEnd: formatDate(row.periodEnd),
      windowStart: formatDate(row.windowStart),
      windowEnd: formatDate(row.windowEnd),
      selfReviewDueDate: isoDate(row.selfReviewDueDate),
      reviewerDueDate: isoDate(row.reviewerDueDate),
      scoringMode: row.scoringMode,
      overallRatingEnabled: row.overallRatingEnabled,
      overallScaleName: row.overallScaleName,
      overallScaleLevels: row.overallScaleLevels,
      openedAt: row.openedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
    };
  }

  private actions(row: PerformanceCycle, canManage: boolean) {
    return {
      canEdit: canManage && row.status !== 'ARCHIVED',
      canAddReviews: canManage && ['DRAFT', 'OPEN'].includes(row.status),
      canOpen: canManage && row.status === 'DRAFT',
      canClose: canManage && row.status === 'OPEN',
      canArchive: canManage && row.status === 'CLOSED',
      canDiscard: canManage && row.status === 'DRAFT',
    };
  }

  private auditWrite(
    tx: Prisma.TransactionClient,
    action: string,
    cycleId: string,
    context: PerformanceRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return writePerformanceAudit(this.audit, tx, {
      action,
      entityType: 'PerformanceCycle',
      entityId: cycleId,
      context,
      metadata,
    });
  }
}

export function displayName(person: {
  firstName: string | null;
  lastName: string | null;
  preferredName: string | null;
}) {
  return [person.preferredName ?? person.firstName, person.lastName]
    .filter(Boolean)
    .join(' ');
}

/** The parts of a review past their due date and not yet submitted (local organization date). */
export function overdueParts(
  cycle: Pick<
    PerformanceCycle,
    'status' | 'selfReviewDueDate' | 'reviewerDueDate'
  >,
  review: { status: string; selfStatus: string; reviewerStatus: string },
  today: Date,
) {
  if (
    cycle.status !== 'OPEN' ||
    !['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED'].includes(review.status)
  ) {
    return [];
  }
  const parts: Array<'SELF' | 'REVIEWER'> = [];
  if (
    cycle.selfReviewDueDate &&
    today > cycle.selfReviewDueDate &&
    ['NOT_STARTED', 'IN_PROGRESS'].includes(review.selfStatus)
  ) {
    parts.push('SELF');
  }
  if (
    cycle.reviewerDueDate &&
    today > cycle.reviewerDueDate &&
    ['NOT_STARTED', 'IN_PROGRESS'].includes(review.reviewerStatus)
  ) {
    parts.push('REVIEWER');
  }
  return parts;
}

export function formShape(
  sections: Array<
    Prisma.PerformanceFormSectionGetPayload<{ include: { items: true } }>
  >,
) {
  return sections.map((section) => ({
    id: section.id,
    title: section.title,
    description: section.description,
    sortOrder: section.sortOrder,
    items: section.items.map((item) => ({
      id: item.id,
      sortOrder: item.sortOrder,
      itemType: item.itemType,
      prompt: item.prompt,
      helpText: item.helpText,
      respondent: item.respondent,
      required: item.required,
      weight: item.weight?.toFixed(2) ?? null,
      competency: item.competencyId
        ? {
            id: item.competencyId,
            code: item.competencyCode,
            name: item.competencyName,
          }
        : null,
      scaleLevels: item.scaleLevels,
      scaleMin: item.scaleMin,
      scaleMax: item.scaleMax,
    })),
  }));
}
