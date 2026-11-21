import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, requireActor } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  RecruitmentInterviewType,
  RecruitmentRecommendation,
} from '../generated/prisma/client.js';
import { RecruitmentAccessService } from './recruitment-access.service.js';
import { RecruitmentApplicationService } from './recruitment-application.service.js';
import {
  candidateDisplayName,
  conflict,
  lockInterview,
  RecruitmentClock,
  recordActivity,
  writeRecruitmentAudit,
  type RecruitmentRequestContext,
  type Tx,
} from './recruitment-common.js';
import {
  defaultFeedbackDue,
  invalid,
  parseDuration,
  parseHttpsUrl,
  parseInstant,
  parseRating,
  parseText,
} from './recruitment-domain.js';
import {
  feedbackShape,
  interviewShape,
  INTERVIEW_INCLUDE,
} from './recruitment-shapes.js';

export interface InterviewInput {
  type: RecruitmentInterviewType;
  title: string;
  scheduledStart: string;
  durationMinutes: number;
  location?: string | null;
  meetingUrl?: string | null;
  feedbackDueAt?: string | null;
  interviewerUserIds?: string[];
}

export interface FeedbackInput {
  recommendation?: RecruitmentRecommendation | null;
  rating?: number | null;
  strengths?: string | null;
  concerns?: string | null;
  comments?: string | null;
}

/**
 * Phase 13 — interviews, interviewers and feedback. Interviewers are explicit assignments
 * (staff of the organization, never the candidate themselves); an interviewer reaches only the
 * interviews they are on and writes only their own feedback. Submitted feedback is locked; an
 * authorized reopening (recruitment.manage) keeps the submitted revision and starts a new
 * draft revision.
 */
@Injectable()
export class RecruitmentInterviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RecruitmentAccessService,
    private readonly audit: AuditService,
    private readonly clock: RecruitmentClock,
    private readonly applications: RecruitmentApplicationService,
  ) {}

  async schedule(
    applicationId: string,
    input: InterviewInput,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const values = this.values(input);
    return this.prisma.$transaction(async (tx) => {
      const application = await this.applications.lockedForManage(
        tx,
        actor,
        applicationId,
      );
      this.applications.requireLive(application.status);
      const interview = await tx.recruitmentInterview.create({
        data: {
          organizationId: application.organizationId,
          applicationId,
          ...values,
          createdByUserId: actor,
        },
      });
      for (const userId of new Set(input.interviewerUserIds ?? [])) {
        await this.assignInterviewer(
          tx,
          interview.id,
          application,
          userId,
          actor,
        );
      }
      await recordActivity(tx, {
        organizationId: application.organizationId,
        candidateId: application.candidateId,
        applicationId,
        type: 'INTERVIEW_SCHEDULED',
        summary: `${values.title} scheduled`,
        relatedId: interview.id,
        actorUserId: actor,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_INTERVIEW_SCHEDULED',
        entityType: 'RecruitmentInterview',
        entityId: interview.id,
        context,
        metadata: {
          organizationId: application.organizationId,
          applicationId,
          type: values.type,
          interviewers: (input.interviewerUserIds ?? []).length,
        },
      });
      return this.shapeById(tx, interview.id, actor);
    });
  }

  async reschedule(
    interviewId: string,
    input: Partial<InterviewInput>,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const { interview, application } = await this.lockedInterview(
        tx,
        actor,
        interviewId,
      );
      if (interview.status !== 'SCHEDULED') {
        throw conflict(
          'RECRUITMENT_INTERVIEW_NOT_SCHEDULED',
          'Only scheduled interviews change.',
        );
      }
      const merged = this.values({
        type: input.type ?? interview.type,
        title: input.title ?? interview.title,
        scheduledStart:
          input.scheduledStart ?? interview.scheduledStart.toISOString(),
        durationMinutes: input.durationMinutes ?? interview.durationMinutes,
        location:
          input.location !== undefined ? input.location : interview.location,
        meetingUrl:
          input.meetingUrl !== undefined
            ? input.meetingUrl
            : interview.meetingUrl,
        feedbackDueAt:
          input.feedbackDueAt !== undefined
            ? input.feedbackDueAt
            : input.scheduledStart || input.durationMinutes
              ? null
              : (interview.feedbackDueAt?.toISOString() ?? null),
      });
      await tx.recruitmentInterview.update({
        where: { id: interviewId },
        data: merged,
      });
      await recordActivity(tx, {
        organizationId: application.organizationId,
        candidateId: application.candidateId,
        applicationId: application.id,
        type: 'INTERVIEW_RESCHEDULED',
        summary: `${merged.title} rescheduled`,
        relatedId: interviewId,
        actorUserId: actor,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_INTERVIEW_RESCHEDULED',
        entityType: 'RecruitmentInterview',
        entityId: interviewId,
        context,
        metadata: {
          organizationId: application.organizationId,
          fields: Object.keys(input),
        },
      });
      return this.shapeById(tx, interviewId, actor);
    });
  }

  async conclude(
    interviewId: string,
    outcome: 'COMPLETED' | 'CANCELLED' | 'NO_SHOW',
    reason: string | null | undefined,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(reason, 'reason', { max: 1000 });
    if (outcome === 'CANCELLED' && !note)
      invalid('RECRUITMENT_REASON_REQUIRED', 'A reason is required.');
    return this.prisma.$transaction(async (tx) => {
      const { interview, application } = await this.lockedInterview(
        tx,
        actor,
        interviewId,
      );
      if (interview.status !== 'SCHEDULED') {
        throw conflict(
          'RECRUITMENT_INTERVIEW_NOT_SCHEDULED',
          `The interview is already ${interview.status.toLowerCase()}.`,
        );
      }
      const now = this.clock.now();
      if (
        outcome !== 'CANCELLED' &&
        interview.scheduledStart.getTime() > now.getTime()
      ) {
        throw conflict(
          'RECRUITMENT_INTERVIEW_NOT_STARTED',
          'The interview has not started yet.',
        );
      }
      await tx.recruitmentInterview.update({
        where: { id: interviewId },
        data: {
          status: outcome,
          ...(outcome === 'COMPLETED' ? { completedAt: now } : {}),
          ...(outcome === 'CANCELLED'
            ? { cancelledAt: now, cancellationReason: note }
            : {}),
        },
      });
      await recordActivity(tx, {
        organizationId: application.organizationId,
        candidateId: application.candidateId,
        applicationId: application.id,
        type:
          outcome === 'CANCELLED'
            ? 'INTERVIEW_CANCELLED'
            : 'INTERVIEW_COMPLETED',
        summary:
          outcome === 'COMPLETED'
            ? `${interview.title} completed`
            : outcome === 'NO_SHOW'
              ? `${interview.title}: candidate did not attend`
              : `${interview.title} cancelled`,
        relatedId: interviewId,
        actorUserId: actor,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: `RECRUITMENT_INTERVIEW_${outcome}`,
        entityType: 'RecruitmentInterview',
        entityId: interviewId,
        context,
        metadata: {
          organizationId: application.organizationId,
          applicationId: application.id,
        },
      });
      return this.shapeById(tx, interviewId, actor);
    });
  }

  async addInterviewer(
    interviewId: string,
    userId: string,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const { interview, application } = await this.lockedInterview(
        tx,
        actor,
        interviewId,
      );
      if (interview.status === 'CANCELLED') {
        throw conflict(
          'RECRUITMENT_INTERVIEW_CANCELLED',
          'The interview was cancelled.',
        );
      }
      await this.assignInterviewer(tx, interviewId, application, userId, actor);
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_INTERVIEWER_ASSIGNED',
        entityType: 'RecruitmentInterview',
        entityId: interviewId,
        context,
        metadata: {
          organizationId: application.organizationId,
          interviewerUserId: userId,
        },
      });
      return this.shapeById(tx, interviewId, actor);
    });
  }

  async removeInterviewer(
    interviewId: string,
    userId: string,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const { application } = await this.lockedInterview(
        tx,
        actor,
        interviewId,
      );
      const row = await tx.recruitmentInterviewer.findFirst({
        where: { interviewId, userId, removedAt: null },
      });
      if (!row)
        throw new NotFoundException(
          'The user is not an interviewer of this interview.',
        );
      await tx.recruitmentInterviewer.update({
        where: { id: row.id },
        data: { removedAt: this.clock.now(), removedByUserId: actor },
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_INTERVIEWER_REMOVED',
        entityType: 'RecruitmentInterview',
        entityId: interviewId,
        context,
        metadata: {
          organizationId: application.organizationId,
          interviewerUserId: userId,
        },
      });
      return this.shapeById(tx, interviewId, actor);
    });
  }

  /** Interviews the user is assigned to (their own interviewing work). */
  async mine(userId: string) {
    const user = await this.access.userContext(userId);
    const rows = await this.prisma.recruitmentInterview.findMany({
      where: {
        interviewers: { some: { userId, removedAt: null } },
        organizationId: { notIn: await this.access.disabledOrganizations() },
      },
      include: {
        ...INTERVIEW_INCLUDE,
        application: {
          include: {
            candidate: true,
            opening: { select: { id: true, code: true, title: true } },
            stage: { select: { name: true } },
          },
        },
      },
      orderBy: [{ scheduledStart: 'desc' }, { id: 'asc' }],
      take: 200,
    });
    const now = this.clock.now();
    return {
      items: rows
        .filter((row) => !this.access.isSelf(user, row.application.candidate))
        .map((row) => ({
          ...interviewShape(row, { userId, seesAllFeedback: false }, now),
          candidate: {
            id: row.application.candidate.id,
            displayName: candidateDisplayName(row.application.candidate),
          },
          opening: row.application.opening,
          stageName: row.application.stage.name,
          myFeedback: (() => {
            const own = row.feedback.find(
              (f) => f.interviewerUserId === userId && f.supersededAt === null,
            );
            return own ? feedbackShape(own) : null;
          })(),
        })),
    };
  }

  // ─── Feedback ─────────────────────────────────────────────────────────────

  /** Saves the interviewer's own draft (creating it on first save). */
  async saveFeedback(
    interviewId: string,
    input: FeedbackInput,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const values = this.feedbackValues(input);
    return this.prisma.$transaction(async (tx) => {
      const { feedback } = await this.ownFeedback(tx, actor, interviewId);
      if (feedback?.status === 'SUBMITTED') {
        throw conflict(
          'RECRUITMENT_FEEDBACK_SUBMITTED',
          'Submitted feedback is locked.',
        );
      }
      const row = feedback
        ? await tx.recruitmentInterviewFeedback.update({
            where: { id: feedback.id },
            data: values,
          })
        : await tx.recruitmentInterviewFeedback.create({
            data: { interviewId, interviewerUserId: actor, ...values },
          });
      return feedbackShape(row);
    });
  }

  async submitFeedback(
    interviewId: string,
    input: FeedbackInput,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const values = this.feedbackValues(input);
    return this.prisma.$transaction(async (tx) => {
      const { feedback, interview, application } = await this.ownFeedback(
        tx,
        actor,
        interviewId,
      );
      if (feedback?.status === 'SUBMITTED') {
        throw conflict(
          'RECRUITMENT_FEEDBACK_SUBMITTED',
          'Feedback was already submitted.',
        );
      }
      const now = this.clock.now();
      if (interview.scheduledStart.getTime() > now.getTime()) {
        throw conflict(
          'RECRUITMENT_INTERVIEW_NOT_STARTED',
          'Feedback is submitted after the interview.',
        );
      }
      const merged = {
        ...feedback,
        ...stripUndefined(values),
      } as typeof values;
      if (!merged.recommendation) {
        invalid(
          'RECRUITMENT_FEEDBACK_RECOMMENDATION_REQUIRED',
          'A recommendation is required to submit.',
        );
      }
      const data = {
        recommendation: merged.recommendation,
        rating: merged.rating ?? null,
        strengths: merged.strengths ?? null,
        concerns: merged.concerns ?? null,
        comments: merged.comments ?? null,
        status: 'SUBMITTED' as const,
        submittedAt: now,
      };
      const row = feedback
        ? await tx.recruitmentInterviewFeedback.update({
            where: { id: feedback.id },
            data,
          })
        : await tx.recruitmentInterviewFeedback.create({
            data: { interviewId, interviewerUserId: actor, ...data },
          });
      await recordActivity(tx, {
        organizationId: application.organizationId,
        candidateId: application.candidateId,
        applicationId: application.id,
        type: 'FEEDBACK_SUBMITTED',
        summary: `Interview feedback submitted for ${interview.title}`,
        relatedId: row.id,
        actorUserId: actor,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_FEEDBACK_SUBMITTED',
        entityType: 'RecruitmentInterviewFeedback',
        entityId: row.id,
        context,
        metadata: {
          organizationId: application.organizationId,
          interviewId,
          revision: row.revision,
        },
      });
      return feedbackShape(row);
    });
  }

  /**
   * Reopens submitted feedback for correction (recruitment.manage on the application): the
   * submitted revision is kept (superseded) and a new draft revision copies its content.
   */
  async reopenFeedback(
    feedbackId: string,
    reason: string,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(reason, 'reason', { required: true, max: 1000 })!;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.recruitmentInterviewFeedback.findUnique({
        where: { id: feedbackId },
      });
      if (!existing) throw new NotFoundException('Feedback not found.');
      const { application } = await this.lockedInterview(
        tx,
        actor,
        existing.interviewId,
      );
      const current = await tx.recruitmentInterviewFeedback.findUniqueOrThrow({
        where: { id: feedbackId },
      });
      if (current.status !== 'SUBMITTED' || current.supersededAt) {
        throw conflict(
          'RECRUITMENT_FEEDBACK_NOT_SUBMITTED',
          'Only current submitted feedback is reopened.',
        );
      }
      if (current.interviewerUserId === actor) {
        throw new ForbiddenException(
          domainError(
            403,
            'RECRUITMENT_FEEDBACK_SELF_REOPEN',
            'Another recruiter reopens your own feedback.',
          ),
        );
      }
      await tx.recruitmentInterviewFeedback.update({
        where: { id: feedbackId },
        data: { supersededAt: this.clock.now() },
      });
      const row = await tx.recruitmentInterviewFeedback.create({
        data: {
          interviewId: current.interviewId,
          interviewerUserId: current.interviewerUserId,
          status: 'DRAFT',
          recommendation: current.recommendation,
          rating: current.rating,
          strengths: current.strengths,
          concerns: current.concerns,
          comments: current.comments,
          revision: current.revision + 1,
          supersedesFeedbackId: current.id,
          reopenReason: note,
          reopenedByUserId: actor,
        },
      });
      await recordActivity(tx, {
        organizationId: application.organizationId,
        candidateId: application.candidateId,
        applicationId: application.id,
        type: 'FEEDBACK_REOPENED',
        summary: 'Interview feedback reopened for correction',
        relatedId: row.id,
        actorUserId: actor,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_FEEDBACK_REOPENED',
        entityType: 'RecruitmentInterviewFeedback',
        entityId: row.id,
        context,
        metadata: {
          organizationId: application.organizationId,
          supersedes: current.id,
          revision: row.revision,
        },
      });
      return feedbackShape(row);
    });
  }

  /**
   * Revision history of an interview's feedback. Batch 7A (S1): feedback is private to its
   * author until submitted, so FULL and HIRING_MANAGER viewers see submitted revisions and
   * their own rows; an interviewer sees only their own.
   */
  async feedbackHistory(userId: string, interviewId: string) {
    const interview = await this.prisma.recruitmentInterview.findUnique({
      where: { id: interviewId },
    });
    if (!interview) throw new NotFoundException('Interview not found.');
    const access = await this.access.requireApplicationView(
      userId,
      interview.applicationId,
    );
    const rows = await this.prisma.recruitmentInterviewFeedback.findMany({
      where: {
        interviewId,
        ...(access.view === 'INTERVIEWER'
          ? { interviewerUserId: userId }
          : {
              OR: [
                { status: 'SUBMITTED' as const },
                { interviewerUserId: userId },
              ],
            }),
      },
      orderBy: [{ interviewerUserId: 'asc' }, { revision: 'asc' }],
    });
    return { items: rows.map(feedbackShape) };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private values(input: InterviewInput) {
    const scheduledStart = parseInstant(input.scheduledStart, 'scheduledStart');
    if (!scheduledStart)
      invalid('RECRUITMENT_DATE_INVALID', 'scheduledStart is required.');
    const durationMinutes = parseDuration(input.durationMinutes);
    const feedbackDueAt =
      parseInstant(input.feedbackDueAt, 'feedbackDueAt') ??
      defaultFeedbackDue(scheduledStart, durationMinutes);
    if (feedbackDueAt.getTime() < scheduledStart.getTime()) {
      invalid(
        'RECRUITMENT_FEEDBACK_DUE_INVALID',
        'Feedback is due after the interview starts.',
      );
    }
    return {
      type: input.type,
      title: parseText(input.title, 'title', { required: true, max: 200 })!,
      scheduledStart,
      durationMinutes,
      location: parseText(input.location, 'location', { max: 300 }),
      meetingUrl: parseHttpsUrl(input.meetingUrl, 'meetingUrl'),
      feedbackDueAt,
    };
  }

  private feedbackValues(input: FeedbackInput) {
    return {
      ...(input.recommendation !== undefined
        ? { recommendation: input.recommendation }
        : {}),
      ...(input.rating !== undefined
        ? { rating: parseRating(input.rating) }
        : {}),
      ...(input.strengths !== undefined
        ? { strengths: parseText(input.strengths, 'strengths') }
        : {}),
      ...(input.concerns !== undefined
        ? { concerns: parseText(input.concerns, 'concerns') }
        : {}),
      ...(input.comments !== undefined
        ? { comments: parseText(input.comments, 'comments') }
        : {}),
    };
  }

  /**
   * An interviewer: an active user who works in the organization (an employee with an
   * assignment there) and is not the candidate.
   */
  private async assignInterviewer(
    tx: Tx,
    interviewId: string,
    application: {
      organizationId: string;
      candidate: {
        internalEmployeeId: string | null;
        normalizedEmail: string | null;
        personId: string | null;
      };
    },
    userId: string,
    actor: string,
  ) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    const context = await this.access.userContext(userId, tx);
    const staff =
      context.employeeId &&
      (await tx.employmentAssignment.count({
        where: {
          employeeId: context.employeeId,
          status: { not: 'CANCELLED' },
          position: { organizationId: application.organizationId },
        },
      }));
    if (!user || user.status !== 'ACTIVE' || !staff) {
      invalid(
        'RECRUITMENT_INTERVIEWER_INVALID',
        'Interviewers are active staff of the organization.',
      );
    }
    if (this.access.isSelf(context, application.candidate)) {
      invalid(
        'RECRUITMENT_INTERVIEWER_IS_CANDIDATE',
        'A candidate never interviews themselves.',
      );
    }
    const existing = await tx.recruitmentInterviewer.findFirst({
      where: { interviewId, userId, removedAt: null },
    });
    if (existing) return existing;
    return tx.recruitmentInterviewer.create({
      data: { interviewId, userId, assignedByUserId: actor },
    });
  }

  private async lockedInterview(tx: Tx, actor: string, interviewId: string) {
    const row = await tx.recruitmentInterview.findUnique({
      where: { id: interviewId },
      select: { applicationId: true },
    });
    if (!row) throw new NotFoundException('Interview not found.');
    const application = await this.applications.lockedForManage(
      tx,
      actor,
      row.applicationId,
    );
    await lockInterview(tx, interviewId);
    const interview = await tx.recruitmentInterview.findUniqueOrThrow({
      where: { id: interviewId },
    });
    return { interview, application };
  }

  /** The interviewer's own current feedback (locked interview). Interviewers only. */
  private async ownFeedback(tx: Tx, actor: string, interviewId: string) {
    const exists = await tx.recruitmentInterview.findUnique({
      where: { id: interviewId },
    });
    if (!exists) throw new NotFoundException('Interview not found.');
    await lockInterview(tx, interviewId);
    const interview = await tx.recruitmentInterview.findUniqueOrThrow({
      where: { id: interviewId },
    });
    const access = await this.access.applicationAccess(
      actor,
      interview.applicationId,
      tx,
    );
    if (access.isSelf || !access.interviewerOn.includes(interviewId)) {
      throw new ForbiddenException(
        domainError(
          403,
          'RECRUITMENT_NOT_INTERVIEWER',
          'Only an interviewer of this interview writes its feedback.',
        ),
      );
    }
    if (interview.status === 'CANCELLED' || interview.status === 'NO_SHOW') {
      throw conflict(
        'RECRUITMENT_INTERVIEW_CLOSED',
        'No feedback is recorded for a cancelled or missed interview.',
      );
    }
    const feedback = await tx.recruitmentInterviewFeedback.findFirst({
      where: { interviewId, interviewerUserId: actor, supersededAt: null },
    });
    return { feedback, interview, application: access.application };
  }

  private async shapeById(tx: Tx, interviewId: string, userId: string) {
    const row = await tx.recruitmentInterview.findUniqueOrThrow({
      where: { id: interviewId },
      include: INTERVIEW_INCLUDE,
    });
    return interviewShape(
      row,
      { userId, seesAllFeedback: true },
      this.clock.now(),
    );
  }
}

function stripUndefined<T extends Record<string, unknown>>(
  value: T,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
