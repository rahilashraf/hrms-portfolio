import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  formatDate,
  parseDateOnly,
  requireActor,
} from '../common/domain-support.js';
import { pageList, type ListPaging } from '../common/option-paging.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  PerformanceGoal,
  PerformanceGoalStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { PerformanceAccessService } from './performance-access.service.js';
import {
  isoDate,
  lockGoal,
  lockReview,
  PerformanceClock,
  shareCycle,
  writePerformanceAudit,
  type PerformanceClient,
  type PerformanceRequestContext,
} from './performance-common.js';
import { displayName } from './performance-cycle.service.js';
import { parseText } from './performance-domain.js';
import { WRITABLE } from './performance-review.service.js';

export interface GoalInput {
  employmentAssignmentId: string;
  title: string;
  description?: string | null;
  measure?: string | null;
  startDate: string;
  dueDate?: string | null;
  progressPercent?: number | null;
}

export interface GoalUpdate {
  title?: string;
  description?: string | null;
  measure?: string | null;
  startDate?: string;
  dueDate?: string | null;
  progressPercent?: number | null;
  status?: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  completionNotes?: string | null;
  cancellationReason?: string | null;
}

const conflict = (code: string, message: string) =>
  new ConflictException(domainError(409, code, message));
const invalid = (code: string, message: string) =>
  new BadRequestException(domainError(400, code, message));

const TERMINAL: readonly PerformanceGoalStatus[] = ['COMPLETED', 'CANCELLED'];

/**
 * Phase 12 Batch 12.5 — performance goals of an employment assignment.
 *
 * Who may write a goal: the employee (their own goals), HR with performance.manage on the
 * assignment (never their own through it), and the current reviewer of an open review of the
 * same assignment. performance.read reads. Completed and cancelled goals are frozen; nothing
 * is deleted. A goal links only into reviews of its own assignment (an employee with several
 * assignments keeps them apart); finalization freezes its state onto the link.
 */
@Injectable()
export class PerformanceGoalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PerformanceAccessService,
    private readonly audit: AuditService,
    private readonly clock: PerformanceClock,
  ) {}

  /** What the user may do with goals of an assignment. */
  async goalAccess(
    userId: string,
    employmentAssignmentId: string,
    client: PerformanceClient = this.prisma,
  ) {
    const { assignment } = await this.access.assignmentContext(
      employmentAssignmentId,
      client,
    );
    const access = await this.access.reviewAccess(
      userId,
      {
        employeeId: assignment.employeeId,
        employmentAssignmentId,
        reviewerEmployeeId: null,
      },
      client,
    );
    const reviewing =
      access.employeeId !== null &&
      (await client.performanceReview.count({
        where: {
          employmentAssignmentId,
          reviewerEmployeeId: access.employeeId,
          status: { in: [...WRITABLE] },
          cycle: { status: 'OPEN' },
        },
      })) > 0;
    // Batch 7B (S7): a reviewer reaching the goals only as reviewer is gated like everyone else.
    if (reviewing)
      await this.access.requireEnabled(access.target.organizationId, client);
    return {
      assignment,
      isSelf: access.isSelf,
      canRead: access.canRead || access.isSelf || reviewing,
      canWrite: access.isSelf || access.canManage || reviewing,
      employeeId: access.employeeId,
    };
  }

  /** The employee's own assignments (not cancelled), for self-service goal entry. */
  async me(userId: string) {
    const employeeId = await this.access.requireEmployee(userId);
    const rows = await this.prisma.employmentAssignment.findMany({
      where: {
        employeeId,
        status: { not: 'CANCELLED' },
        position: {
          organizationId: { notIn: await this.access.disabledOrganizations() },
        },
      },
      select: {
        id: true,
        status: true,
        isPrimary: true,
        startDate: true,
        endDate: true,
        position: {
          select: {
            name: true,
            organization: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ isPrimary: 'desc' }, { startDate: 'asc' }],
    });
    return {
      employeeId,
      assignments: rows.map((row) => ({
        id: row.id,
        status: row.status,
        isPrimary: row.isPrimary,
        positionName: row.position.name,
        organization: row.position.organization,
        startDate: formatDate(row.startDate),
        endDate: isoDate(row.endDate),
      })),
    };
  }

  async mine(
    userId: string,
    status?: PerformanceGoal['status'],
    paging: ListPaging = {},
  ) {
    const employeeId = await this.access.requireEmployee(userId);
    return this.list(employeeId, null, status, paging);
  }

  /** An employee's goals on the assignments the user may read through. */
  async forEmployee(
    userId: string,
    employeeId: string,
    /** Batch 7B: by status. */
    status?: PerformanceGoal['status'],
    paging: ListPaging = {},
  ) {
    const employee = await this.access.employeeAccess(userId, employeeId);
    const reviewing = (
      await this.access.reviewingAssignments(userId, employeeId)
    ).map((row) => row.employmentAssignmentId);
    const readable = employee.isSelf
      ? null
      : [
          ...new Set([
            ...employee.assignments
              .filter((row) => row.canRead)
              .map((row) => row.assignment.id),
            ...reviewing,
          ]),
        ];
    if (readable && readable.length === 0) {
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Missing permission performance.read for the employee.',
        ),
      );
    }
    return this.list(employeeId, readable, status, paging);
  }

  private async list(
    employeeId: string,
    assignmentIds: string[] | null,
    status: PerformanceGoal['status'] | undefined,
    paging: ListPaging,
  ) {
    const rows = await this.prisma.performanceGoal.findMany({
      where: {
        employeeId,
        ...(status ? { status } : {}),
        organizationId: { notIn: await this.access.disabledOrganizations() },
        ...(assignmentIds
          ? { employmentAssignmentId: { in: assignmentIds } }
          : {}),
      },
      include: {
        employmentAssignment: {
          select: { position: { select: { name: true } } },
        },
      },
      orderBy: [
        { status: 'asc' },
        { dueDate: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });
    // Batch 7B: cursor paging (by the last goal id of the previous page) over the ordered list.
    const page = pageList(rows, paging.limit, paging.afterId);
    const provenance = await this.provenance(this.prisma, page.items);
    return {
      total: page.total,
      nextAfterId: page.nextAfterId,
      items: page.items.map((row) => ({
        ...goalShape(row, provenance(row)),
        positionName: row.employmentAssignment.position.name,
      })),
    };
  }

  async create(input: GoalInput, context: PerformanceRequestContext) {
    const actor = requireActor(context);
    const access = await this.goalAccess(actor, input.employmentAssignmentId);
    if (!access.canWrite) {
      // Batch 7B (D8): another organization's assignment reads as missing.
      await this.access.notFoundOutside(
        actor,
        access.assignment.position.organizationId,
        'Assignment not found.',
      );
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Missing permission to manage goals of the assignment.',
        ),
      );
    }
    if (access.assignment.status === 'CANCELLED') {
      throw conflict(
        'PERFORMANCE_ASSIGNMENT_CANCELLED',
        'The assignment was cancelled.',
      );
    }
    const dates = this.dates(input.startDate, input.dueDate ?? null);
    const progress = this.progress(input.progressPercent);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.performanceGoal.create({
        data: {
          organizationId: access.assignment.position.organizationId,
          employeeId: access.assignment.employeeId,
          employmentAssignmentId: input.employmentAssignmentId,
          title: parseText(input.title, 'title', { required: true, max: 200 })!,
          description: parseText(input.description, 'description', {
            max: 4000,
          }),
          measure: parseText(input.measure, 'measure', { max: 1000 }),
          ...dates,
          progressPercent: progress,
          status: progress && progress > 0 ? 'IN_PROGRESS' : 'NOT_STARTED',
          createdByUserId: actor,
        },
      });
      await this.auditWrite(tx, 'PERFORMANCE_GOAL_CREATED', row.id, context, {
        organizationId: row.organizationId,
        employmentAssignmentId: row.employmentAssignmentId,
        bySelf: access.isSelf,
      });
      return goalShape(row, (await this.provenance(tx, [row]))(row));
    });
  }

  /** Edits, progress and status changes of a goal that is not yet completed or cancelled. */
  async update(
    goalId: string,
    input: GoalUpdate,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const existing = await this.goalOrThrow(goalId);
    const access = await this.goalAccess(
      actor,
      existing.employmentAssignmentId,
    );
    if (!access.canWrite) {
      await this.access.notFoundOutside(
        actor,
        existing.organizationId,
        'Goal not found.',
      );
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Missing permission to manage goals of the assignment.',
        ),
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await lockGoal(tx, goalId);
      const goal = await tx.performanceGoal.findUniqueOrThrow({
        where: { id: goalId },
      });
      if (TERMINAL.includes(goal.status)) {
        throw conflict(
          'PERFORMANCE_GOAL_CLOSED',
          'Completed and cancelled goals are frozen.',
        );
      }
      if (access.isSelf) {
        // Batch 7B (D5): a goal someone else set (the manager or HR) is completed or cancelled
        // by them, not by the employee — who keeps editing and updating its progress.
        const managerSet =
          goal.createdByUserId !== null && goal.createdByUserId !== actor;
        if (
          managerSet &&
          (input.status === 'COMPLETED' || input.status === 'CANCELLED')
        ) {
          throw new ForbiddenException(
            domainError(
              403,
              'PERFORMANCE_GOAL_MANAGER_SET',
              'Your manager set this goal; ask them (or HR) to complete or cancel it.',
            ),
          );
        }
        // Batch 7B (D5): while a review the goal is linked to waits for finalization (the
        // reviewer submitted it), the employee's edits would silently change what is
        // snapshotted at finalization; they wait until it is finalized (or reopened).
        // The linked reviews are locked FOR SHARE first, so a concurrent reviewer submission
        // cannot slip between this check and the edit (the submission waits for this one).
        await tx.$queryRaw`
          SELECT r."id" FROM "PerformanceReview" r
          JOIN "PerformanceReviewGoal" g ON g."reviewId" = r."id"
          WHERE g."goalId" = ${goalId}::uuid AND g."unlinkedAt" IS NULL
          ORDER BY r."id" FOR SHARE OF r`;
        const underReview = await tx.performanceReviewGoal.count({
          where: {
            goalId,
            unlinkedAt: null,
            review: { status: 'SUBMITTED', finalizedAt: null },
          },
        });
        if (underReview > 0) {
          throw conflict(
            'PERFORMANCE_GOAL_UNDER_REVIEW',
            'This goal is part of a review awaiting finalization; it can change once the review is finalized.',
          );
        }
      }
      const data: Prisma.PerformanceGoalUncheckedUpdateInput = {};
      if (input.title !== undefined)
        data.title = parseText(input.title, 'title', {
          required: true,
          max: 200,
        })!;
      if (input.description !== undefined) {
        data.description = parseText(input.description, 'description', {
          max: 4000,
        });
      }
      if (input.measure !== undefined)
        data.measure = parseText(input.measure, 'measure', { max: 1000 });
      if (input.startDate !== undefined || input.dueDate !== undefined) {
        Object.assign(
          data,
          this.dates(
            input.startDate ?? formatDate(goal.startDate),
            input.dueDate !== undefined ? input.dueDate : isoDate(goal.dueDate),
          ),
        );
      }
      if (input.progressPercent !== undefined)
        data.progressPercent = this.progress(input.progressPercent);
      const status = input.status ?? goal.status;
      if (status === 'COMPLETED') {
        data.status = 'COMPLETED';
        data.completedAt = this.clock.now();
        data.completionNotes = parseText(
          input.completionNotes,
          'completionNotes',
          { max: 4000 },
        );
        if (input.progressPercent === undefined) data.progressPercent = 100;
      } else if (status === 'CANCELLED') {
        data.status = 'CANCELLED';
        data.cancelledAt = this.clock.now();
        const reason = parseText(
          input.cancellationReason,
          'cancellationReason',
          { max: 500 },
        );
        if (!reason)
          throw invalid(
            'PERFORMANCE_REASON_REQUIRED',
            'Say why the goal is cancelled.',
          );
        data.cancellationReason = reason;
      } else {
        data.status = status;
      }
      const row = await tx.performanceGoal.update({
        where: { id: goalId },
        data,
      });
      await this.auditWrite(tx, 'PERFORMANCE_GOAL_UPDATED', goalId, context, {
        organizationId: row.organizationId,
        from: goal.status,
        to: row.status,
        fields: Object.keys(input).filter(
          (key) => input[key as keyof GoalUpdate] !== undefined,
        ),
      });
      return goalShape(row, (await this.provenance(tx, [row]))(row));
    });
  }

  /**
   * Batch 7B (D5): who set each goal — the employee themself, or someone else (their manager or
   * HR), with that person's display name. Goals without a recorded creator are UNKNOWN.
   */
  private async provenance(
    client: PerformanceClient,
    rows: Array<Pick<PerformanceGoal, 'employeeId' | 'createdByUserId'>>,
  ) {
    const creatorIds = [
      ...new Set(rows.map((row) => row.createdByUserId).filter(Boolean)),
    ] as string[];
    const users = creatorIds.length
      ? await client.user.findMany({
          where: { id: { in: creatorIds } },
          select: {
            id: true,
            person: {
              select: {
                firstName: true,
                lastName: true,
                preferredName: true,
                employee: { select: { id: true } },
              },
            },
          },
        })
      : [];
    const byId = new Map(users.map((user) => [user.id, user]));
    return (row: Pick<PerformanceGoal, 'employeeId' | 'createdByUserId'>) => {
      const creator = row.createdByUserId
        ? byId.get(row.createdByUserId)
        : undefined;
      if (!creator) return { setBy: 'UNKNOWN' as const, createdBy: null };
      return {
        setBy:
          creator.person?.employee?.id === row.employeeId
            ? ('EMPLOYEE' as const)
            : ('MANAGER' as const),
        createdBy: {
          userId: creator.id,
          displayName: creator.person
            ? displayName(creator.person) || 'Unnamed'
            : 'Unnamed',
        },
      };
    };
  }

  /** Links a goal of the review's assignment while the review is being written. */
  async link(
    reviewId: string,
    goalId: string,
    context: PerformanceRequestContext,
  ) {
    return this.linkChange(reviewId, goalId, 'link', context);
  }

  async unlink(
    reviewId: string,
    goalId: string,
    context: PerformanceRequestContext,
  ) {
    return this.linkChange(reviewId, goalId, 'unlink', context);
  }

  private async linkChange(
    reviewId: string,
    goalId: string,
    change: 'link' | 'unlink',
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.performanceReview.findUnique({
        where: { id: reviewId },
      });
      if (!review) throw new NotFoundException('Review not found.');
      await shareCycle(tx, review.cycleId);
      await lockReview(tx, reviewId);
      const current = await tx.performanceReview.findUniqueOrThrow({
        where: { id: reviewId },
        include: { cycle: { select: { status: true } } },
      });
      const access = await this.access.reviewAccess(actor, current, tx);
      if (!(access.isReviewer || access.canManage)) {
        if (!access.isSelf && !access.canRead)
          await this.access.notFoundOutside(
            actor,
            access.target.organizationId,
            'Review not found.',
            tx,
          );
        throw new ForbiddenException(
          domainError(
            403,
            'PERFORMANCE_PERMISSION_REQUIRED',
            'Only the reviewer (or HR) links goals to the review.',
          ),
        );
      }
      if (
        !WRITABLE.includes(current.status) ||
        current.cycle.status !== 'OPEN'
      ) {
        throw conflict(
          'PERFORMANCE_REVIEW_FINAL',
          "A finalized review's links are locked.",
        );
      }
      const goal = await tx.performanceGoal.findUnique({
        where: { id: goalId },
      });
      if (!goal || goal.employeeId !== current.employeeId)
        throw new NotFoundException('Goal not found.');
      if (goal.employmentAssignmentId !== current.employmentAssignmentId) {
        throw invalid(
          'PERFORMANCE_GOAL_OTHER_ASSIGNMENT',
          'A goal links only into reviews of its own assignment.',
        );
      }
      const active = await tx.performanceReviewGoal.findFirst({
        where: { reviewId, goalId, unlinkedAt: null },
      });
      if (change === 'link' && !active) {
        await tx.performanceReviewGoal.create({
          data: {
            reviewId,
            goalId,
            employeeId: goal.employeeId,
            linkedByUserId: actor,
          },
        });
      }
      if (change === 'unlink' && active) {
        await tx.performanceReviewGoal.update({
          where: { id: active.id },
          data: { unlinkedAt: this.clock.now(), unlinkedByUserId: actor },
        });
      }
      if ((change === 'link') !== Boolean(active)) {
        await writePerformanceAudit(this.audit, tx, {
          action:
            change === 'link'
              ? 'PERFORMANCE_GOAL_LINKED'
              : 'PERFORMANCE_GOAL_UNLINKED',
          entityType: 'PerformanceReview',
          entityId: reviewId,
          context,
          metadata: { organizationId: current.organizationId, goalId },
        });
      }
      return { linked: change === 'link' };
    });
  }

  private dates(startDate: string, dueDate: string | null) {
    const start = parseDateOnly(startDate, 'startDate');
    const due = dueDate ? parseDateOnly(dueDate, 'dueDate') : null;
    if (due && due < start)
      throw invalid(
        'PERFORMANCE_DATES_INVALID',
        'The due date is before the start.',
      );
    return { startDate: start, dueDate: due };
  }

  private progress(value: number | null | undefined) {
    if (value === null || value === undefined) return null;
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw invalid(
        'PERFORMANCE_PROGRESS_INVALID',
        'Progress is a whole percentage from 0 to 100.',
      );
    }
    return value;
  }

  private async goalOrThrow(goalId: string) {
    const goal = await this.prisma.performanceGoal.findUnique({
      where: { id: goalId },
    });
    if (!goal) throw new NotFoundException('Goal not found.');
    return goal;
  }

  private auditWrite(
    tx: Prisma.TransactionClient,
    action: string,
    goalId: string,
    context: PerformanceRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return writePerformanceAudit(this.audit, tx, {
      action,
      entityType: 'PerformanceGoal',
      entityId: goalId,
      context,
      metadata,
    });
  }
}

export function goalShape(
  row: PerformanceGoal,
  provenance: {
    setBy: 'EMPLOYEE' | 'MANAGER' | 'UNKNOWN';
    createdBy: { userId: string; displayName: string } | null;
  } = { setBy: 'UNKNOWN', createdBy: null },
) {
  return {
    ...provenance,
    id: row.id,
    organizationId: row.organizationId,
    employeeId: row.employeeId,
    employmentAssignmentId: row.employmentAssignmentId,
    title: row.title,
    description: row.description,
    measure: row.measure,
    startDate: formatDate(row.startDate),
    dueDate: isoDate(row.dueDate),
    status: row.status,
    progressPercent: row.progressPercent,
    completionNotes: row.completionNotes,
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancellationReason: row.cancellationReason,
  };
}
