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
  requireActor,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  PerformanceCycle,
  PerformancePartStatus,
  PerformanceReview,
  PerformanceReviewStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { PerformanceAccessService } from './performance-access.service.js';
import {
  isoDate,
  lockReview,
  PerformanceClock,
  performanceToday,
  shareCycle,
  writePerformanceAudit,
  type PerformanceClient,
  type PerformanceRequestContext,
} from './performance-common.js';
import {
  displayName,
  formShape,
  overdueParts,
} from './performance-cycle.service.js';
import {
  answeredBy,
  calculateScore,
  missingRequired,
  normalizeAnswer,
  parseText,
  type Answer,
  type AnswerInput,
  type ItemShape,
  type ScaleLevel,
} from './performance-domain.js';

export type Part = 'SELF' | 'REVIEWER';

export interface AnswerUpdate extends AnswerInput {
  itemId: string;
}

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
const forbidden = (code: string, message: string) =>
  new ForbiddenException(domainError(403, code, message));

export const WRITABLE: readonly PerformanceReviewStatus[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
];
export const FINAL: readonly PerformanceReviewStatus[] = [
  'FINALIZED',
  'ACKNOWLEDGED',
  'CLOSED',
];
const OPEN_PART: readonly PerformancePartStatus[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
];

const PERSON = {
  select: { firstName: true, lastName: true, preferredName: true },
} as const;

export const REVIEW_INCLUDE = {
  cycle: {
    include: {
      organization: { select: { id: true, name: true, timezone: true } },
      formSections: {
        orderBy: { sortOrder: 'asc' },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      },
    },
  },
  employmentAssignment: {
    include: {
      employee: {
        select: {
          id: true,
          employeeNumber: true,
          status: true,
          person: PERSON,
        },
      },
      position: { select: { id: true, name: true } },
    },
  },
  reviewer: { select: { id: true, person: PERSON } },
  responses: { where: { supersededAt: null } },
  goalLinks: {
    where: { unlinkedAt: null },
    include: { goal: true },
    orderBy: { linkedAt: 'asc' },
  },
  evidenceLinks: {
    where: { unlinkedAt: null },
    include: { evidence: true },
    orderBy: { linkedAt: 'asc' },
  },
  acknowledgements: { where: { supersededAt: null } },
  events: { orderBy: { createdAt: 'asc' } },
} as const;

export type ReviewRow = Prisma.PerformanceReviewGetPayload<{
  include: typeof REVIEW_INCLUDE;
}>;

/** The review status implied by its parts (never moving a finalized review). */
export function progressStatus(
  current: PerformanceReviewStatus,
  reviewerStatus: PerformancePartStatus,
  started: boolean,
): PerformanceReviewStatus {
  if (FINAL.includes(current)) return current;
  if (reviewerStatus === 'SUBMITTED') return 'SUBMITTED';
  return started ? 'IN_PROGRESS' : 'NOT_STARTED';
}

export function itemShapes(cycle: ReviewRow['cycle']): ItemShape[] {
  return cycle.formSections.flatMap((section) =>
    section.items.map((item) => ({
      id: item.id,
      itemType: item.itemType,
      respondent: item.respondent,
      required: item.required,
      weight: item.weight?.toFixed(2) ?? null,
      scaleLevels: (item.scaleLevels as ScaleLevel[] | null) ?? null,
      scaleMin: item.scaleMin,
      scaleMax: item.scaleMax,
    })),
  );
}

export function answersOf(
  responses: ReviewRow['responses'],
  respondent: Part,
): Map<string, Answer> {
  return new Map(
    responses
      .filter((row) => row.respondent === respondent)
      .map((row) => [
        row.itemId,
        {
          ratingValue: row.ratingValue,
          ratingLabel: row.ratingLabel,
          numericValue: row.numericValue,
          booleanValue: row.booleanValue,
          textValue: row.textValue,
        },
      ]),
  );
}

/**
 * Phase 12 Batch 12.4 — writing reviews.
 *
 * - The employee writes the self part (when the cycle asks for it): drafts, then submit.
 * - The current reviewer — or an HR user with performance.manage on the assignment, never on
 *   their own review — writes the reviewer part, sets the overall rating (when the template
 *   allows it) and submits. The calculated score is the backend's (advisory, never the rating).
 * - Each side sees the other's answers only once submitted; the employee sees the reviewer's
 *   only after finalization. Drafts are private to their side.
 * - Submitted answers are locked; HR can reopen a part (with a reason) while the review is not
 *   finalized — later edits supersede the locked answers, which stay as history.
 * - HR reassigns reviewers; every reviewer change is an event with both identities kept.
 * - Writing happens in the cycle's window (HR may complete late reviews while it is open).
 */
@Injectable()
export class PerformanceReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PerformanceAccessService,
    private readonly audit: AuditService,
    private readonly clock: PerformanceClock,
  ) {}

  // ─── Reads ────────────────────────────────────────────────────────────────

  async detail(userId: string, reviewId: string) {
    const review = await this.reviewOrThrow(reviewId);
    const access = await this.access.requireReviewRead(userId, review);
    return this.view(review, access);
  }

  /** The reviews the user currently reviews (open cycles), with what is due. */
  async queue(userId: string) {
    const employeeId = await this.access.requireEmployee(userId);
    const rows = await this.prisma.performanceReview.findMany({
      where: {
        reviewerEmployeeId: employeeId,
        status: { in: [...WRITABLE] },
        cycle: { status: 'OPEN' },
        organizationId: { notIn: await this.access.disabledOrganizations() },
      },
      include: {
        cycle: { include: { organization: { select: { timezone: true } } } },
        employmentAssignment: {
          include: {
            employee: {
              select: { id: true, employeeNumber: true, person: PERSON },
            },
            position: { select: { name: true } },
          },
        },
      },
      orderBy: [{ cycle: { reviewerDueDate: 'asc' } }, { createdAt: 'asc' }],
    });
    const now = this.clock.now();
    return {
      items: rows.map((row) => ({
        id: row.id,
        cycle: {
          id: row.cycle.id,
          name: row.cycle.name,
          reviewerDueDate: isoDate(row.cycle.reviewerDueDate),
          windowEnd: formatDate(row.cycle.windowEnd),
        },
        employee: {
          id: row.employmentAssignment.employee.id,
          employeeNumber: row.employmentAssignment.employee.employeeNumber,
          displayName: displayName(row.employmentAssignment.employee.person),
        },
        positionName: row.employmentAssignment.position.name,
        status: row.status,
        selfStatus: row.selfStatus,
        reviewerStatus: row.reviewerStatus,
        overdue: overdueParts(
          row.cycle,
          row,
          performanceToday(now, row.cycle.organization.timezone),
        ),
      })),
    };
  }

  // ─── Answers ──────────────────────────────────────────────────────────────

  async saveAnswers(
    reviewId: string,
    part: Part,
    input: {
      answers: AnswerUpdate[];
      overallRatingValue?: number | null;
    },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const { review, access } = await this.lockForPart(
        tx,
        reviewId,
        part,
        actor,
      );
      const items = new Map(
        itemShapes(review.cycle).map((item) => [item.id, item]),
      );
      const now = this.clock.now();
      const seen = new Set<string>();
      for (const update of input.answers) {
        if (seen.has(update.itemId)) {
          throw invalid(
            'PERFORMANCE_ANSWER_INVALID',
            'Each item is answered once per save.',
          );
        }
        seen.add(update.itemId);
        const item = items.get(update.itemId);
        if (!item) {
          throw invalid(
            'PERFORMANCE_ITEM_NOT_FOUND',
            "The item is not on this review's form.",
            {
              itemId: update.itemId,
            },
          );
        }
        if (!answeredBy(item, part)) {
          throw forbidden(
            'PERFORMANCE_ITEM_NOT_YOURS',
            part === 'SELF'
              ? 'This item is answered by the reviewer.'
              : 'This item is answered by the employee.',
          );
        }
        const answer = normalizeAnswer(item, update);
        const current = review.responses.find(
          (row) => row.itemId === item.id && row.respondent === part,
        );
        const author = {
          authorUserId: actor,
          authorEmployeeId: access.employeeId,
        };
        if (current && !current.lockedAt) {
          await tx.performanceReviewResponse.update({
            where: { id: current.id },
            data: { ...answer, ...author },
          });
        } else {
          if (current) {
            await tx.performanceReviewResponse.update({
              where: { id: current.id },
              data: { supersededAt: now },
            });
          }
          await tx.performanceReviewResponse.create({
            data: {
              reviewId,
              cycleId: review.cycleId,
              itemId: item.id,
              respondent: part,
              ...answer,
              ...author,
              ...(current ? { supersedesResponseId: current.id } : {}),
            },
          });
        }
      }
      const reviewUpdate: Prisma.PerformanceReviewUncheckedUpdateInput = {};
      if (input.overallRatingValue !== undefined) {
        if (part !== 'REVIEWER') {
          throw forbidden(
            'PERFORMANCE_ITEM_NOT_YOURS',
            'Only the reviewer sets the overall rating.',
          );
        }
        Object.assign(
          reviewUpdate,
          this.overallRating(review.cycle, input.overallRatingValue),
        );
      }
      if (part === 'SELF') reviewUpdate.selfStatus = 'IN_PROGRESS';
      else reviewUpdate.reviewerStatus = 'IN_PROGRESS';
      reviewUpdate.status = progressStatus(
        review.status,
        part === 'REVIEWER' ? 'IN_PROGRESS' : review.reviewerStatus,
        true,
      );
      await tx.performanceReview.update({
        where: { id: reviewId },
        data: reviewUpdate,
      });
      return this.view(await this.reviewOrThrow(reviewId, tx), access);
    });
  }

  /** Submits a part: required items answered (and the overall rating when enabled). */
  async submit(
    reviewId: string,
    part: Part,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const { review, access } = await this.lockForPart(
        tx,
        reviewId,
        part,
        actor,
      );
      const items = itemShapes(review.cycle);
      const answers = answersOf(review.responses, part);
      const missing = missingRequired(items, part, answers);
      if (missing.length > 0) {
        throw invalid(
          'PERFORMANCE_REQUIRED_UNANSWERED',
          'Answer every required item before submitting.',
          {
            itemIds: missing,
          },
        );
      }
      if (
        part === 'REVIEWER' &&
        review.cycle.overallRatingEnabled &&
        review.overallRatingValue === null
      ) {
        throw invalid(
          'PERFORMANCE_OVERALL_RATING_REQUIRED',
          'Choose the overall rating before submitting.',
        );
      }
      const now = this.clock.now();
      await tx.performanceReviewResponse.updateMany({
        where: {
          reviewId,
          respondent: part,
          lockedAt: null,
          supersededAt: null,
        },
        data: { lockedAt: now },
      });
      const data: Prisma.PerformanceReviewUncheckedUpdateInput =
        part === 'SELF'
          ? {
              selfStatus: 'SUBMITTED',
              selfSubmittedAt: now,
              selfSubmittedByUserId: actor,
            }
          : {
              reviewerStatus: 'SUBMITTED',
              reviewerSubmittedAt: now,
              reviewerSubmittedByUserId: actor,
              reviewerSubmittedEmployeeId: access.employeeId,
              calculatedScore: calculateScore(
                review.cycle.scoringMode,
                items,
                answersOf(review.responses, 'REVIEWER'),
              ),
            };
      data.status = progressStatus(
        review.status,
        part === 'REVIEWER' ? 'SUBMITTED' : review.reviewerStatus,
        true,
      );
      await tx.performanceReview.update({ where: { id: reviewId }, data });
      await tx.performanceReviewEvent.create({
        data: {
          reviewId,
          type: part === 'SELF' ? 'SELF_SUBMITTED' : 'REVIEWER_SUBMITTED',
          actorUserId: actor,
          actorEmployeeId: access.employeeId,
          fromStatus: review.status,
          toStatus: data.status as PerformanceReviewStatus,
        },
      });
      await this.auditWrite(
        tx,
        part === 'SELF'
          ? 'PERFORMANCE_SELF_REVIEW_SUBMITTED'
          : 'PERFORMANCE_REVIEW_SUBMITTED',
        reviewId,
        context,
        {
          organizationId: review.organizationId,
          cycleId: review.cycleId,
          answered: answers.size,
          ...(part === 'REVIEWER' ? { asHr: !access.isReviewer } : {}),
        },
      );
      return this.view(await this.reviewOrThrow(reviewId, tx), access);
    });
  }

  // ─── HR actions ───────────────────────────────────────────────────────────

  /**
   * Assigns (or clears) the reviewer of a review not yet finalized. The reviewer must have an
   * assignment in the organization that is not cancelled and must not be the employee.
   * Drafts already written stay with the review (authors are kept on each answer).
   */
  async reassignReviewer(
    reviewId: string,
    input: { reviewerEmployeeId: string | null; reason: string },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const reason = parseText(input.reason, 'reason', {
      required: true,
      max: 500,
    })!;
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.performanceReview.findUnique({
        where: { id: reviewId },
      });
      if (!row) throw new NotFoundException('Review not found.');
      await shareCycle(tx, row.cycleId);
      await lockReview(tx, reviewId);
      const review = await this.reviewOrThrow(reviewId, tx);
      const access = await this.access.requireReviewManage(actor, review, tx);
      if (!WRITABLE.includes(review.status)) {
        throw conflict(
          'PERFORMANCE_REVIEW_FINAL',
          'A finalized or closed review keeps its reviewer.',
        );
      }
      if (
        review.cycle.status === 'CLOSED' ||
        review.cycle.status === 'ARCHIVED'
      ) {
        throw conflict('PERFORMANCE_CYCLE_CLOSED', 'The cycle is closed.');
      }
      let reviewerAssignmentId: string | null = null;
      if (input.reviewerEmployeeId) {
        if (input.reviewerEmployeeId === review.employeeId) {
          throw invalid(
            'PERFORMANCE_SELF_REVIEWER',
            'An employee never reviews themselves.',
          );
        }
        const assignment = await tx.employmentAssignment.findFirst({
          where: {
            employeeId: input.reviewerEmployeeId,
            status: { notIn: ['CANCELLED', 'ENDED'] },
            position: { organizationId: review.organizationId },
          },
          orderBy: [{ isPrimary: 'desc' }, { startDate: 'asc' }],
          select: { id: true },
        });
        if (!assignment) {
          throw invalid(
            'PERFORMANCE_REVIEWER_INVALID',
            "The reviewer must currently work in the review's organization.",
          );
        }
        reviewerAssignmentId = assignment.id;
      }
      if (input.reviewerEmployeeId === review.reviewerEmployeeId)
        return this.view(review, access);
      await tx.performanceReview.update({
        where: { id: reviewId },
        data: {
          reviewerEmployeeId: input.reviewerEmployeeId,
          reviewerAssignmentId,
          reviewerSource: input.reviewerEmployeeId ? 'ASSIGNED' : null,
          reviewerAssignedAt: input.reviewerEmployeeId
            ? this.clock.now()
            : null,
        },
      });
      await tx.performanceReviewEvent.create({
        data: {
          reviewId,
          type: 'REVIEWER_CHANGED',
          actorUserId: actor,
          actorEmployeeId: access.employeeId,
          fromEmployeeId: review.reviewerEmployeeId,
          toEmployeeId: input.reviewerEmployeeId,
          reason,
        },
      });
      await this.auditWrite(
        tx,
        'PERFORMANCE_REVIEWER_CHANGED',
        reviewId,
        context,
        {
          organizationId: review.organizationId,
          cycleId: review.cycleId,
          fromEmployeeId: review.reviewerEmployeeId,
          toEmployeeId: input.reviewerEmployeeId,
        },
      );
      return this.view(await this.reviewOrThrow(reviewId, tx), access);
    });
  }

  /** Reopens a submitted part (before finalization) so it can be revised; history stays. */
  async reopen(
    reviewId: string,
    part: Part,
    input: { reason: string },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const reason = parseText(input.reason, 'reason', {
      required: true,
      max: 500,
    })!;
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.performanceReview.findUnique({
        where: { id: reviewId },
      });
      if (!row) throw new NotFoundException('Review not found.');
      await shareCycle(tx, row.cycleId);
      await lockReview(tx, reviewId);
      const review = await this.reviewOrThrow(reviewId, tx);
      const access = await this.access.requireReviewManage(actor, review, tx);
      if (review.cycle.status !== 'OPEN') {
        throw conflict(
          'PERFORMANCE_CYCLE_NOT_OPEN',
          'Reviews are reopened only while the cycle is open.',
        );
      }
      if (!WRITABLE.includes(review.status)) {
        throw conflict(
          'PERFORMANCE_REVIEW_FINAL',
          'A finalized review is corrected explicitly, not reopened.',
        );
      }
      const partStatus =
        part === 'SELF' ? review.selfStatus : review.reviewerStatus;
      if (partStatus !== 'SUBMITTED') {
        throw conflict(
          'PERFORMANCE_PART_NOT_SUBMITTED',
          'Only a submitted part can be reopened.',
        );
      }
      const data: Prisma.PerformanceReviewUncheckedUpdateInput =
        part === 'SELF'
          ? {
              selfStatus: 'IN_PROGRESS',
              selfSubmittedAt: null,
              selfSubmittedByUserId: null,
            }
          : {
              reviewerStatus: 'IN_PROGRESS',
              reviewerSubmittedAt: null,
              reviewerSubmittedByUserId: null,
              reviewerSubmittedEmployeeId: null,
              calculatedScore: null,
              status: 'IN_PROGRESS',
            };
      await tx.performanceReview.update({ where: { id: reviewId }, data });
      await tx.performanceReviewEvent.create({
        data: {
          reviewId,
          type: part === 'SELF' ? 'SELF_REOPENED' : 'REVIEWER_REOPENED',
          actorUserId: actor,
          actorEmployeeId: access.employeeId,
          fromStatus: review.status,
          toStatus:
            (data.status as PerformanceReviewStatus | undefined) ??
            review.status,
          reason,
        },
      });
      await this.auditWrite(
        tx,
        part === 'SELF'
          ? 'PERFORMANCE_SELF_REVIEW_REOPENED'
          : 'PERFORMANCE_REVIEW_REOPENED',
        reviewId,
        context,
        { organizationId: review.organizationId, cycleId: review.cycleId },
      );
      return this.view(await this.reviewOrThrow(reviewId, tx), access);
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Locks the cycle (shared) and the review, and checks the actor may write the part now:
   * the employee for SELF; the current reviewer or performance.manage (never self) for
   * REVIEWER; an open cycle, the part not submitted, and inside the window (HR may write past
   * the window end while the cycle is open).
   */
  private async lockForPart(
    tx: Prisma.TransactionClient,
    reviewId: string,
    part: Part,
    actor: string,
  ) {
    const row = await tx.performanceReview.findUnique({
      where: { id: reviewId },
    });
    if (!row) throw new NotFoundException('Review not found.');
    await shareCycle(tx, row.cycleId);
    await lockReview(tx, reviewId);
    const review = await this.reviewOrThrow(reviewId, tx);
    const access = await this.access.reviewAccess(actor, review, tx);
    // Batch 7B (D8): another organization's review reads as missing.
    if (!access.isSelf && !access.isReviewer && !access.canRead)
      await this.access.notFoundOutside(
        actor,
        access.target.organizationId,
        'Review not found.',
        tx,
      );
    if (part === 'SELF' && !access.isSelf) {
      throw forbidden(
        'PERFORMANCE_NOT_YOUR_REVIEW',
        'Only the employee writes their self review.',
      );
    }
    if (part === 'REVIEWER' && !access.isReviewer && !access.canManage) {
      if (access.isSelf) {
        throw forbidden(
          'PERFORMANCE_SELF_MANAGEMENT',
          'You cannot write your own reviewer review.',
        );
      }
      throw forbidden(
        'PERFORMANCE_NOT_REVIEWER',
        'Only the assigned reviewer (or HR) writes this part.',
      );
    }
    if (review.cycle.status !== 'OPEN') {
      throw conflict(
        'PERFORMANCE_CYCLE_NOT_OPEN',
        'The review cycle is not open.',
      );
    }
    if (!WRITABLE.includes(review.status)) {
      throw conflict('PERFORMANCE_REVIEW_FINAL', 'The review is finalized.');
    }
    const status = part === 'SELF' ? review.selfStatus : review.reviewerStatus;
    if (status === 'NOT_REQUIRED') {
      throw conflict(
        'PERFORMANCE_SELF_NOT_REQUIRED',
        'This cycle has no self review.',
      );
    }
    if (!OPEN_PART.includes(status)) {
      throw conflict(
        'PERFORMANCE_PART_SUBMITTED',
        'This part is submitted; HR can reopen it if it needs changes.',
      );
    }
    const today = performanceToday(
      this.clock.now(),
      review.cycle.organization.timezone,
    );
    if (today < review.cycle.windowStart) {
      throw conflict(
        'PERFORMANCE_WINDOW_NOT_OPEN',
        'The review window has not opened yet.',
      );
    }
    const asHr = part === 'REVIEWER' && access.canManage && !access.isReviewer;
    if (today > review.cycle.windowEnd && !asHr) {
      throw conflict(
        'PERFORMANCE_WINDOW_CLOSED',
        'The review window has closed.',
      );
    }
    return { review, access };
  }

  private overallRating(
    cycle: Pick<
      PerformanceCycle,
      'overallRatingEnabled' | 'overallScaleLevels'
    >,
    value: number | null,
  ) {
    if (!cycle.overallRatingEnabled) {
      throw invalid(
        'PERFORMANCE_OVERALL_RATING_DISABLED',
        'This review has no overall rating.',
      );
    }
    if (value === null)
      return { overallRatingValue: null, overallRatingLabel: null };
    const level = (
      (cycle.overallScaleLevels as ScaleLevel[] | null) ?? []
    ).find((l) => l.value === value);
    if (!level) {
      throw invalid(
        'PERFORMANCE_ANSWER_INVALID',
        'The overall rating is not a level of the scale.',
      );
    }
    return { overallRatingValue: level.value, overallRatingLabel: level.label };
  }

  /** Display names of the people a review's history mentions. */
  private async eventNames(review: ReviewRow) {
    const userIds = [
      ...new Set(review.events.map((e) => e.actorUserId).filter(Boolean)),
    ] as string[];
    const employeeIds = [
      ...new Set(
        review.events
          .flatMap((e) => [e.fromEmployeeId, e.toEmployeeId])
          .filter(Boolean),
      ),
    ] as string[];
    const PERSON = {
      select: { firstName: true, lastName: true, preferredName: true },
    } as const;
    const [users, employees] = await Promise.all([
      userIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, person: PERSON },
          })
        : [],
      employeeIds.length
        ? this.prisma.employee.findMany({
            where: { id: { in: employeeIds } },
            select: { id: true, person: PERSON },
          })
        : [],
    ]);
    const nameOf = (person: Parameters<typeof displayName>[0] | null) =>
      (person && displayName(person)) || 'Unnamed';
    return {
      users: new Map(users.map((u) => [u.id, nameOf(u.person)])),
      employees: new Map(employees.map((e) => [e.id, nameOf(e.person)])),
    };
  }

  async reviewOrThrow(
    reviewId: string,
    client: PerformanceClient = this.prisma,
  ): Promise<ReviewRow> {
    const review = await client.performanceReview.findUnique({
      where: { id: reviewId },
      include: REVIEW_INCLUDE,
    });
    if (!review) throw new NotFoundException('Review not found.');
    return review;
  }

  /**
   * The review as the viewer may see it. Drafts stay with their side; the employee sees the
   * reviewer's answers, score and rating only after finalization; the reviewer sees the self
   * answers once submitted; HR and readers see submitted parts.
   */
  async view(
    review: ReviewRow,
    access: Awaited<ReturnType<PerformanceAccessService['reviewAccess']>>,
  ) {
    // Batch 7B: the history's people by name (actors and reviewer changes), never ids only.
    const names = await this.eventNames(review);
    const finalized = review.finalizedAt !== null;
    const viewer = access.isSelf
      ? 'SELF'
      : access.isReviewer
        ? 'REVIEWER'
        : access.canManage
          ? 'HR'
          : 'READER';
    const selfVisible =
      viewer === 'SELF' ||
      review.selfStatus === 'SUBMITTED' ||
      (finalized && review.selfStatus !== 'NOT_REQUIRED');
    const reviewerVisible =
      viewer === 'SELF'
        ? finalized
        : viewer === 'REVIEWER' ||
          viewer === 'HR' ||
          review.reviewerStatus === 'SUBMITTED';
    const responses: Record<string, { self?: unknown; reviewer?: unknown }> =
      {};
    for (const row of review.responses) {
      const visible = row.respondent === 'SELF' ? selfVisible : reviewerVisible;
      if (!visible) continue;
      // An unsubmitted draft of the other side is never shown.
      if (!row.lockedAt && row.respondent === 'SELF' && viewer !== 'SELF')
        continue;
      if (
        !row.lockedAt &&
        row.respondent === 'REVIEWER' &&
        !['REVIEWER', 'HR'].includes(viewer)
      ) {
        continue;
      }
      const entry = (responses[row.itemId] ??= {});
      const value = {
        ratingValue: row.ratingValue,
        ratingLabel: row.ratingLabel,
        numericValue: row.numericValue,
        booleanValue: row.booleanValue,
        textValue: row.textValue,
        submitted: row.lockedAt !== null,
        recordType: row.recordType,
      };
      if (row.respondent === 'SELF') entry.self = value;
      else entry.reviewer = value;
    }
    // Batch 7B (S1): the outcome (overall rating, score) — the employee sees it once finalized;
    // read-only viewers once the reviewer has submitted (a draft rating stays with the reviewer
    // side and HR, like the reviewer's draft answers).
    const showOutcome =
      viewer === 'SELF'
        ? finalized
        : viewer === 'READER'
          ? finalized || review.reviewerStatus === 'SUBMITTED'
          : true;
    const items = itemShapes(review.cycle);
    const writable =
      review.cycle.status === 'OPEN' && WRITABLE.includes(review.status);
    const employee = review.employmentAssignment.employee;
    return {
      id: review.id,
      status: review.status,
      selfStatus: review.selfStatus,
      reviewerStatus: review.reviewerStatus,
      viewer,
      cycle: {
        id: review.cycle.id,
        code: review.cycle.code,
        name: review.cycle.name,
        status: review.cycle.status,
        periodStart: formatDate(review.cycle.periodStart),
        periodEnd: formatDate(review.cycle.periodEnd),
        windowStart: formatDate(review.cycle.windowStart),
        windowEnd: formatDate(review.cycle.windowEnd),
        selfReviewDueDate: isoDate(review.cycle.selfReviewDueDate),
        reviewerDueDate: isoDate(review.cycle.reviewerDueDate),
        scoringMode: review.cycle.scoringMode,
        overallRatingEnabled: review.cycle.overallRatingEnabled,
        overallScaleLevels: review.cycle.overallScaleLevels,
        acknowledgementEnabled: review.cycle.acknowledgementEnabled,
      },
      organization: {
        id: review.cycle.organization.id,
        name: review.cycle.organization.name,
      },
      employee: {
        id: employee.id,
        employeeNumber: employee.employeeNumber,
        displayName: displayName(employee.person),
      },
      employmentAssignment: {
        id: review.employmentAssignmentId,
        positionName: review.employmentAssignment.position.name,
      },
      reviewer: review.reviewer
        ? {
            id: review.reviewer.id,
            displayName: displayName(review.reviewer.person),
          }
        : null,
      reviewerSource: review.reviewerSource,
      form: formShape(review.cycle.formSections),
      responses,
      goals: review.goalLinks.map((link) => ({
        linkId: link.id,
        goalId: link.goalId,
        // Finalized reviews show the goal as it stood when the review was finalized.
        title: link.snapshotTitle ?? link.goal.title,
        status: link.snapshotStatus ?? link.goal.status,
        progressPercent: link.snapshottedAt
          ? link.snapshotProgress
          : link.goal.progressPercent,
        dueDate: isoDate(link.goal.dueDate),
        snapshotted: link.snapshottedAt !== null,
      })),
      // Evidence as linked (the exact revision reviewed); later corrections are flagged.
      evidence: review.evidenceLinks.map((link) => ({
        linkId: link.id,
        formItemId: link.formItemId,
        evidenceId: link.evidenceId,
        title: link.evidence.title,
        provider: link.evidence.provider,
        kind: link.evidence.kind,
        completedAt: link.evidence.completedAt.toISOString(),
        score: link.evidence.score?.toFixed(2) ?? null,
        maxScore: link.evidence.maxScore?.toFixed(2) ?? null,
        percentage: link.evidence.percentage?.toFixed(2) ?? null,
        passed: link.evidence.passed,
        status: link.evidence.status,
        revision: link.evidence.revision,
        changedSinceLinked: link.evidence.supersededAt !== null,
      })),
      calculatedScore: showOutcome
        ? (review.calculatedScore?.toFixed(2) ??
          (['REVIEWER', 'HR'].includes(viewer) &&
          review.reviewerStatus !== 'SUBMITTED'
            ? calculateScore(
                review.cycle.scoringMode,
                items,
                answersOf(review.responses, 'REVIEWER'),
              )
            : null))
        : null,
      overallRating:
        showOutcome && review.overallRatingValue !== null
          ? {
              value: review.overallRatingValue,
              label: review.overallRatingLabel,
            }
          : null,
      selfSubmittedAt: review.selfSubmittedAt?.toISOString() ?? null,
      reviewerSubmittedAt: review.reviewerSubmittedAt?.toISOString() ?? null,
      finalizedAt: review.finalizedAt?.toISOString() ?? null,
      acknowledgedAt: review.acknowledgedAt?.toISOString() ?? null,
      closedAt: review.closedAt?.toISOString() ?? null,
      closeReason: review.closeReason,
      acknowledgement: review.acknowledgements[0]
        ? {
            acknowledgedAt:
              review.acknowledgements[0].acknowledgedAt.toISOString(),
            comment: review.acknowledgements[0].comment,
          }
        : null,
      // The review's history (reviewer changes, submissions, reopenings, corrections) for
      // everyone but the employee, who sees the outcome.
      events:
        viewer === 'SELF'
          ? []
          : review.events.map((event) => ({
              type: event.type,
              at: event.createdAt.toISOString(),
              fromStatus: event.fromStatus,
              toStatus: event.toStatus,
              fromEmployeeId: event.fromEmployeeId,
              toEmployeeId: event.toEmployeeId,
              actorName: event.actorUserId
                ? (names.users.get(event.actorUserId) ?? null)
                : null,
              fromEmployeeName: event.fromEmployeeId
                ? (names.employees.get(event.fromEmployeeId) ?? null)
                : null,
              toEmployeeName: event.toEmployeeId
                ? (names.employees.get(event.toEmployeeId) ?? null)
                : null,
              reason: event.reason,
            })),
      actions: {
        canEditSelf:
          viewer === 'SELF' &&
          writable &&
          OPEN_PART.includes(review.selfStatus),
        canEditReviewer:
          (viewer === 'REVIEWER' || access.canManage) &&
          !access.isSelf &&
          writable &&
          OPEN_PART.includes(review.reviewerStatus),
        canReassign:
          access.canManage &&
          WRITABLE.includes(review.status) &&
          review.cycle.status === 'OPEN',
        canReopenSelf:
          access.canManage && writable && review.selfStatus === 'SUBMITTED',
        canReopenReviewer:
          access.canManage && writable && review.reviewerStatus === 'SUBMITTED',
        canLinkEvidence:
          (viewer === 'REVIEWER' || access.canManage) &&
          !access.isSelf &&
          writable,
        canLinkGoals:
          (viewer === 'REVIEWER' || access.canManage) &&
          !access.isSelf &&
          writable,
        canFinalize:
          access.canManage &&
          review.cycle.status === 'OPEN' &&
          review.status === 'SUBMITTED',
        canAcknowledge:
          viewer === 'SELF' &&
          review.cycle.acknowledgementEnabled &&
          review.status === 'FINALIZED',
        canClose:
          access.canManage &&
          review.status !== 'CLOSED' &&
          review.cycle.status !== 'DRAFT',
        canCorrect: access.canManage && finalized,
      },
    };
  }

  private auditWrite(
    tx: Prisma.TransactionClient,
    action: string,
    reviewId: string,
    context: PerformanceRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return writePerformanceAudit(this.audit, tx, {
      action,
      entityType: 'PerformanceReview',
      entityId: reviewId,
      context,
      metadata,
    });
  }
}

export type ReviewView = ReturnType<PerformanceReviewService['view']>;
export type { PerformanceReview };
