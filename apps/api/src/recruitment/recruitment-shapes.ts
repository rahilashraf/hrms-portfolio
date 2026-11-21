import { formatRateAmount } from '../compensation/compensation-domain.js';
import type {
  RecruitmentHire,
  RecruitmentInterview,
  RecruitmentInterviewFeedback,
  RecruitmentInterviewer,
  RecruitmentOffer,
  RecruitmentScreening,
} from '../generated/prisma/client.js';
import { isoDate } from './recruitment-common.js';
import { effectiveOfferStatus } from './recruitment-domain.js';

export function feedbackShape(feedback: RecruitmentInterviewFeedback) {
  return {
    id: feedback.id,
    interviewId: feedback.interviewId,
    interviewerUserId: feedback.interviewerUserId,
    status: feedback.status,
    recommendation: feedback.recommendation,
    rating: feedback.rating,
    strengths: feedback.strengths,
    concerns: feedback.concerns,
    comments: feedback.comments,
    submittedAt: feedback.submittedAt?.toISOString() ?? null,
    revision: feedback.revision,
    reopenReason: feedback.reopenReason,
    supersededAt: feedback.supersededAt?.toISOString() ?? null,
  };
}

export type InterviewWithPeople = RecruitmentInterview & {
  interviewers: Array<
    RecruitmentInterviewer & { user: { id: string; email: string } }
  >;
  feedback: RecruitmentInterviewFeedback[];
};

/**
 * An interview as one viewer sees it: FULL and HIRING_MANAGER see every interviewer's
 * submitted feedback (and the viewer's own draft); an interviewer only their own feedback.
 */
export function interviewShape(
  interview: InterviewWithPeople,
  viewer: { userId: string; seesAllFeedback: boolean },
  now: Date,
) {
  const current = interview.feedback.filter((row) => row.supersededAt === null);
  const active = interview.interviewers.filter((row) => row.removedAt === null);
  const visible = current.filter((row) =>
    row.interviewerUserId === viewer.userId
      ? true
      : viewer.seesAllFeedback && row.status === 'SUBMITTED',
  );
  const pendingFeedback = active.filter(
    (interviewer) =>
      !current.some(
        (row) =>
          row.interviewerUserId === interviewer.userId &&
          row.status === 'SUBMITTED',
      ),
  ).length;
  return {
    id: interview.id,
    applicationId: interview.applicationId,
    type: interview.type,
    title: interview.title,
    scheduledStart: interview.scheduledStart.toISOString(),
    durationMinutes: interview.durationMinutes,
    location: interview.location,
    meetingUrl: interview.meetingUrl,
    status: interview.status,
    feedbackDueAt: interview.feedbackDueAt?.toISOString() ?? null,
    completedAt: interview.completedAt?.toISOString() ?? null,
    cancelledAt: interview.cancelledAt?.toISOString() ?? null,
    cancellationReason: interview.cancellationReason,
    interviewers: active.map((row) => ({
      userId: row.userId,
      email: row.user.email,
      feedbackSubmitted: current.some(
        (feedback) =>
          feedback.interviewerUserId === row.userId &&
          feedback.status === 'SUBMITTED',
      ),
    })),
    feedback: visible.map(feedbackShape),
    pendingFeedback,
    feedbackOverdue:
      interview.status !== 'CANCELLED' &&
      interview.status !== 'NO_SHOW' &&
      pendingFeedback > 0 &&
      interview.feedbackDueAt !== null &&
      interview.feedbackDueAt.getTime() < now.getTime(),
    isInterviewer: active.some((row) => row.userId === viewer.userId),
  };
}

export function offerShape(offer: RecruitmentOffer, today: Date) {
  return {
    id: offer.id,
    applicationId: offer.applicationId,
    positionId: offer.positionId,
    workLocationId: offer.workLocationId,
    employmentType: offer.employmentType,
    startDate: isoDate(offer.startDate),
    payBasis: offer.payBasis,
    rateAmount: formatRateAmount(offer.rateAmount),
    currency: offer.currency,
    expiresOn: isoDate(offer.expiresOn),
    candidateTerms: offer.candidateTerms,
    internalNotes: offer.internalNotes,
    status: offer.status,
    /** Date-derived: a sent offer past its acceptance day reads as EXPIRED. */
    effectiveStatus: effectiveOfferStatus(offer, today),
    approvedAt: offer.approvedAt?.toISOString() ?? null,
    approvedByUserId: offer.approvedByUserId,
    sentAt: offer.sentAt?.toISOString() ?? null,
    respondedAt: offer.respondedAt?.toISOString() ?? null,
    declineReason: offer.declineReason,
    withdrawnAt: offer.withdrawnAt?.toISOString() ?? null,
    withdrawalReason: offer.withdrawalReason,
    expiredAt: offer.expiredAt?.toISOString() ?? null,
    createdByUserId: offer.createdByUserId,
    createdAt: offer.createdAt.toISOString(),
  };
}

export function screeningShape(screening: RecruitmentScreening | null) {
  if (!screening) return null;
  return {
    outcome: screening.outcome,
    meetsMinimumQualifications: screening.meetsMinimumQualifications,
    workAuthorizationConfirmed: screening.workAuthorizationConfirmed,
    requiredCertificationsHeld: screening.requiredCertificationsHeld,
    availableFrom: isoDate(screening.availableFrom),
    notes: screening.notes,
    screenedByUserId: screening.screenedByUserId,
    screenedAt: screening.screenedAt?.toISOString() ?? null,
  };
}

export function hireShape(hire: RecruitmentHire | null) {
  if (!hire) return null;
  return {
    id: hire.id,
    personId: hire.personId,
    employeeId: hire.employeeId,
    employmentAssignmentId: hire.employmentAssignmentId,
    compensationRecordId: hire.compensationRecordId,
    internalCandidate: hire.internalCandidate,
    createdEmployee: hire.createdEmployee,
    convertedByUserId: hire.convertedByUserId,
    convertedAt: hire.convertedAt.toISOString(),
  };
}

export const INTERVIEW_INCLUDE = {
  interviewers: { include: { user: { select: { id: true, email: true } } } },
  feedback: true,
} as const;
