import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, requireActor } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  PerformanceCloseReason,
  PerformanceReviewStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { PerformanceAccessService } from './performance-access.service.js';
import {
  lockReview,
  PerformanceClock,
  shareCycle,
  writePerformanceAudit,
  type PerformanceRequestContext,
} from './performance-common.js';
import {
  answeredBy,
  calculateScore,
  normalizeAnswer,
  parseText,
  type ScaleLevel,
} from './performance-domain.js';
import {
  answersOf,
  FINAL,
  itemShapes,
  PerformanceReviewService,
  WRITABLE,
  type AnswerUpdate,
} from './performance-review.service.js';

const conflict = (code: string, message: string) =>
  new ConflictException(domainError(409, code, message));
const invalid = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new BadRequestException(domainError(400, code, message, extra));

/**
 * Phase 12 Batch 12.7 — the end of a review.
 *
 * - HR (performance.manage, never their own) finalizes a submitted review: its content locks,
 *   unsubmitted self parts are recorded as NOT_SUBMITTED, linked goals are frozen as they
 *   stand, and the employee can now see the outcome.
 * - The employee acknowledges having seen it (not agreement), optionally with a comment.
 * - HR closes reviews — with or without acknowledgement (e.g. the employee left), or as
 *   incomplete with a reason (e.g. the reviewed assignment ended mid-cycle).
 * - Errors found after finalization are corrected explicitly (reviewer answers and the
 *   overall rating, with a reason): corrections supersede, never overwrite, and ask the
 *   employee to acknowledge again. The employee's own words are never edited by HR.
 */
@Injectable()
export class PerformanceReviewLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PerformanceAccessService,
    private readonly audit: AuditService,
    private readonly clock: PerformanceClock,
    private readonly reviews: PerformanceReviewService,
  ) {}

  async finalize(reviewId: string, context: PerformanceRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const { review, access } = await this.lockManaged(tx, reviewId, actor);
      if (review.cycle.status !== 'OPEN') {
        throw conflict(
          'PERFORMANCE_CYCLE_NOT_OPEN',
          'Reviews are finalized while the cycle is open.',
        );
      }
      if (review.status !== 'SUBMITTED') {
        throw conflict(
          'PERFORMANCE_REVIEW_NOT_SUBMITTED',
          'Only a review the reviewer has submitted can be finalized.',
        );
      }
      const now = this.clock.now();
      for (const link of review.goalLinks) {
        await tx.performanceReviewGoal.update({
          where: { id: link.id },
          data: {
            snapshotTitle: link.goal.title,
            snapshotStatus: link.goal.status,
            snapshotProgress: link.goal.progressPercent,
            snapshottedAt: now,
          },
        });
      }
      await tx.performanceReview.update({
        where: { id: reviewId },
        data: {
          status: 'FINALIZED',
          finalizedAt: now,
          finalizedByUserId: actor,
          ...(['NOT_STARTED', 'IN_PROGRESS'].includes(review.selfStatus)
            ? { selfStatus: 'NOT_SUBMITTED' }
            : {}),
        },
      });
      await this.event(
        tx,
        reviewId,
        'FINALIZED',
        actor,
        access.employeeId,
        review.status,
        'FINALIZED',
      );
      await this.auditWrite(
        tx,
        'PERFORMANCE_REVIEW_FINALIZED',
        reviewId,
        context,
        {
          organizationId: review.organizationId,
          cycleId: review.cycleId,
          selfStatus: review.selfStatus,
          linkedGoals: review.goalLinks.length,
        },
      );
      return this.reviews.view(
        await this.reviews.reviewOrThrow(reviewId, tx),
        access,
      );
    });
  }

  /** The employee has seen the finalized review (an optional comment; never agreement). */
  async acknowledge(
    reviewId: string,
    input: { comment?: string | null },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const comment = parseText(input.comment, 'comment', { max: 4000 });
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.performanceReview.findUnique({
        where: { id: reviewId },
      });
      if (!row) throw new NotFoundException('Review not found.');
      await lockReview(tx, reviewId);
      const review = await this.reviews.reviewOrThrow(reviewId, tx);
      const access = await this.access.reviewAccess(actor, review, tx);
      if (!access.isSelf) {
        if (!access.isReviewer && !access.canRead)
          await this.access.notFoundOutside(
            actor,
            access.target.organizationId,
            'Review not found.',
            tx,
          );
        throw new ForbiddenException(
          domainError(
            403,
            'PERFORMANCE_NOT_YOUR_REVIEW',
            'Only the employee acknowledges their review.',
          ),
        );
      }
      if (!review.cycle.acknowledgementEnabled) {
        throw conflict(
          'PERFORMANCE_ACKNOWLEDGEMENT_DISABLED',
          'This cycle does not ask for acknowledgement.',
        );
      }
      if (review.status !== 'FINALIZED') {
        throw conflict(
          'PERFORMANCE_REVIEW_NOT_FINALIZED',
          review.status === 'ACKNOWLEDGED'
            ? 'The review is already acknowledged.'
            : 'Only a finalized review can be acknowledged.',
        );
      }
      const now = this.clock.now();
      await tx.performanceReviewAcknowledgement.create({
        data: {
          reviewId,
          employeeId: review.employeeId,
          userId: actor,
          comment,
          acknowledgedAt: now,
        },
      });
      await tx.performanceReview.update({
        where: { id: reviewId },
        data: { status: 'ACKNOWLEDGED', acknowledgedAt: now },
      });
      await this.event(
        tx,
        reviewId,
        'ACKNOWLEDGED',
        actor,
        access.employeeId,
        'FINALIZED',
        'ACKNOWLEDGED',
      );
      await this.auditWrite(
        tx,
        'PERFORMANCE_REVIEW_ACKNOWLEDGED',
        reviewId,
        context,
        {
          organizationId: review.organizationId,
          cycleId: review.cycleId,
          withComment: comment !== null,
        },
      );
      return this.reviews.view(
        await this.reviews.reviewOrThrow(reviewId, tx),
        access,
      );
    });
  }

  /**
   * Closes a review. Finalized: COMPLETED (acknowledged or not asked) or NOT_ACKNOWLEDGED.
   * Not yet finalized: INCOMPLETE, with a reason (e.g. the employee left mid-cycle).
   */
  async close(
    reviewId: string,
    input: { reason?: string | null },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const reason = parseText(input.reason, 'reason', { max: 500 });
    return this.prisma.$transaction(async (tx) => {
      const { review, access } = await this.lockManaged(tx, reviewId, actor);
      if (review.status === 'CLOSED') {
        throw conflict(
          'PERFORMANCE_REVIEW_CLOSED',
          'The review is already closed.',
        );
      }
      // Batch 7B (F2): a draft cycle's review is removed from the cycle, not closed (a closed
      // review would block opening the cycle).
      if (review.cycle.status === 'DRAFT') {
        throw conflict(
          'PERFORMANCE_CYCLE_NOT_OPEN',
          'Remove the review from the draft cycle instead of closing it.',
        );
      }
      let closeReason: PerformanceCloseReason;
      const data: Prisma.PerformanceReviewUncheckedUpdateInput = {};
      if (WRITABLE.includes(review.status)) {
        if (!reason)
          throw invalid(
            'PERFORMANCE_REASON_REQUIRED',
            'Say why an unfinished review is closed.',
          );
        closeReason = 'INCOMPLETE';
        if (['NOT_STARTED', 'IN_PROGRESS'].includes(review.selfStatus))
          data.selfStatus = 'NOT_SUBMITTED';
        if (review.reviewerStatus !== 'SUBMITTED')
          data.reviewerStatus = 'NOT_SUBMITTED';
      } else {
        closeReason =
          review.status === 'FINALIZED' && review.cycle.acknowledgementEnabled
            ? 'NOT_ACKNOWLEDGED'
            : 'COMPLETED';
      }
      const now = this.clock.now();
      await tx.performanceReview.update({
        where: { id: reviewId },
        data: {
          ...data,
          status: 'CLOSED',
          closeReason,
          closedAt: now,
          closedByUserId: actor,
        },
      });
      await this.event(
        tx,
        reviewId,
        'CLOSED',
        actor,
        access.employeeId,
        review.status,
        'CLOSED',
        reason,
      );
      await this.auditWrite(
        tx,
        'PERFORMANCE_REVIEW_CLOSED',
        reviewId,
        context,
        {
          organizationId: review.organizationId,
          cycleId: review.cycleId,
          closeReason,
        },
      );
      return this.reviews.view(
        await this.reviews.reviewOrThrow(reviewId, tx),
        access,
      );
    });
  }

  /**
   * Corrects a finalized review: reviewer answers that were given and/or the overall rating.
   * Each corrected answer supersedes the finalized one (both kept); the score is recalculated.
   * A correction after acknowledgement asks the employee to acknowledge again (unless closed).
   */
  async correct(
    reviewId: string,
    input: {
      answers?: AnswerUpdate[];
      overallRatingValue?: number | null;
      reason: string;
    },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const reason = parseText(input.reason, 'reason', {
      required: true,
      max: 500,
    })!;
    const answers = input.answers ?? [];
    if (answers.length === 0 && input.overallRatingValue === undefined) {
      throw invalid('PERFORMANCE_CORRECTION_EMPTY', 'Say what is corrected.');
    }
    // Batch 7B (F1): one correction per item (a repeat would hit the response constraints).
    const itemIds = answers.map((answer) => answer.itemId);
    if (new Set(itemIds).size !== itemIds.length) {
      throw invalid('PERFORMANCE_ANSWER_DUPLICATE', 'Correct each item once.');
    }
    return this.prisma.$transaction(async (tx) => {
      const { review, access } = await this.lockManaged(tx, reviewId, actor);
      if (!FINAL.includes(review.status) || !review.finalizedAt) {
        throw conflict(
          'PERFORMANCE_REVIEW_NOT_FINALIZED',
          'Corrections apply to finalized reviews; reopen a review that is still being written.',
        );
      }
      const items = new Map(
        itemShapes(review.cycle).map((item) => [item.id, item]),
      );
      const now = this.clock.now();
      for (const update of answers) {
        const item = items.get(update.itemId);
        if (!item || !answeredBy(item, 'REVIEWER')) {
          throw invalid(
            'PERFORMANCE_ITEM_NOT_CORRECTABLE',
            "Only the reviewer's answers are corrected (the employee's own words never are).",
            { itemId: update.itemId },
          );
        }
        const current = review.responses.find(
          (row) =>
            row.itemId === item.id &&
            row.respondent === 'REVIEWER' &&
            row.lockedAt,
        );
        if (!current) {
          throw invalid(
            'PERFORMANCE_CORRECTION_NO_ANSWER',
            'Only answers given in the finalized review can be corrected.',
            { itemId: item.id },
          );
        }
        const answer = normalizeAnswer(item, update);
        await tx.performanceReviewResponse.update({
          where: { id: current.id },
          data: { supersededAt: now },
        });
        await tx.performanceReviewResponse.create({
          data: {
            reviewId,
            cycleId: review.cycleId,
            itemId: item.id,
            respondent: 'REVIEWER',
            ...answer,
            recordType: 'CORRECTION',
            correctionReason: reason,
            supersedesResponseId: current.id,
            lockedAt: now,
            authorUserId: actor,
            authorEmployeeId: access.employeeId,
          },
        });
      }
      const data: Prisma.PerformanceReviewUncheckedUpdateInput = {};
      if (input.overallRatingValue !== undefined) {
        if (!review.cycle.overallRatingEnabled) {
          throw invalid(
            'PERFORMANCE_OVERALL_RATING_DISABLED',
            'This review has no overall rating.',
          );
        }
        const level =
          input.overallRatingValue === null
            ? null
            : ((
                (review.cycle.overallScaleLevels as ScaleLevel[] | null) ?? []
              ).find((l) => l.value === input.overallRatingValue) ?? undefined);
        if (level === undefined) {
          throw invalid(
            'PERFORMANCE_ANSWER_INVALID',
            'The overall rating is not a level of the scale.',
          );
        }
        data.overallRatingValue = level?.value ?? null;
        data.overallRatingLabel = level?.label ?? null;
      }
      const corrected = await tx.performanceReviewResponse.findMany({
        where: { reviewId, supersededAt: null },
      });
      data.calculatedScore = calculateScore(
        review.cycle.scoringMode,
        [...items.values()],
        answersOf(corrected, 'REVIEWER'),
      );
      let toStatus: PerformanceReviewStatus = review.status;
      if (review.status === 'ACKNOWLEDGED') {
        toStatus = 'FINALIZED';
        data.status = 'FINALIZED';
        data.acknowledgedAt = null;
        await tx.performanceReviewAcknowledgement.updateMany({
          where: { reviewId, supersededAt: null },
          data: { supersededAt: now },
        });
      }
      await tx.performanceReview.update({ where: { id: reviewId }, data });
      await this.event(
        tx,
        reviewId,
        'CORRECTED',
        actor,
        access.employeeId,
        review.status,
        toStatus,
        reason,
      );
      await this.auditWrite(
        tx,
        'PERFORMANCE_REVIEW_CORRECTED',
        reviewId,
        context,
        {
          organizationId: review.organizationId,
          cycleId: review.cycleId,
          itemIds: answers.map((answer) => answer.itemId),
          overallRatingCorrected: input.overallRatingValue !== undefined,
          reacknowledgementRequested: toStatus !== review.status,
        },
      );
      return this.reviews.view(
        await this.reviews.reviewOrThrow(reviewId, tx),
        access,
      );
    });
  }

  private async lockManaged(
    tx: Prisma.TransactionClient,
    reviewId: string,
    actor: string,
  ) {
    const row = await tx.performanceReview.findUnique({
      where: { id: reviewId },
    });
    if (!row) throw new NotFoundException('Review not found.');
    await shareCycle(tx, row.cycleId);
    await lockReview(tx, reviewId);
    const review = await this.reviews.reviewOrThrow(reviewId, tx);
    const access = await this.access.requireReviewManage(actor, review, tx);
    return { review, access };
  }

  private event(
    tx: Prisma.TransactionClient,
    reviewId: string,
    type: 'FINALIZED' | 'ACKNOWLEDGED' | 'CLOSED' | 'CORRECTED',
    actorUserId: string,
    actorEmployeeId: string | null,
    fromStatus: PerformanceReviewStatus,
    toStatus: PerformanceReviewStatus,
    reason: string | null = null,
  ) {
    return tx.performanceReviewEvent.create({
      data: {
        reviewId,
        type,
        actorUserId,
        actorEmployeeId,
        fromStatus,
        toStatus,
        reason,
      },
    });
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
