import { apiRequest } from '../auth/api-client';
import type {
  ApplicationDetail,
  ApplicationStatus,
  ApplicationSummary,
  Candidate,
  CandidateDetail,
  CandidateDocument,
  CandidateSource,
  CompensationRange,
  Dashboard,
  DocumentReferenceInput,
  EmploymentType,
  Feedback,
  HireResult,
  IngestionReport,
  IntakeProvider,
  IntakeSource,
  IntakeStatus,
  IntakePage,
  IntakeSubmission,
  Interview,
  InterviewType,
  MyInterview,
  Offer,
  OfferAction,
  Opening,
  OpeningAction,
  OpeningDetail,
  OpeningStatus,
  PayBasis,
  Recommendation,
  RecruitmentOptionKind,
  RecruitmentOptionPage,
  RecruitmentOrganization,
  Screening,
  ScreeningOutcome,
  Stage,
  StageKind,
} from './types';

const enc = encodeURIComponent;

function send<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return apiRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** `?organizationId=…` plus any defined filters. */
function query(organizationId: string, filters: Record<string, string | boolean | undefined> = {}) {
  const params = new URLSearchParams({ organizationId });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return `?${params.toString()}`;
}

export interface OpeningFields {
  description?: string | null;
  positionId?: string | null;
  organizationalUnitId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
  workLocationId?: string | null;
  hiringManagerEmployeeId?: string | null;
  recruiterUserId?: string | null;
  openingCount?: number;
  expectedStartDate?: string | null;
  postedOn?: string | null;
  closesOn?: string | null;
  compensation?: CompensationRange | null;
}

export interface OpeningInput extends OpeningFields {
  organizationId: string;
  code: string;
  title: string;
  employmentType: EmploymentType;
}

export interface OpeningUpdate extends OpeningFields {
  title?: string;
  employmentType?: EmploymentType;
}

export interface CandidateDetailsInput {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  source?: CandidateSource;
  notes?: string | null;
}

export interface ApplicationInput {
  openingId: string;
  candidateId?: string | null;
  candidate?: CandidateDetailsInput | null;
  source?: CandidateSource;
  sourceDetail?: string | null;
  appliedAt?: string | null;
  recruiterUserId?: string | null;
  documents?: DocumentReferenceInput[];
}

export interface ApplicationFilters {
  openingId?: string;
  stageId?: string;
  status?: ApplicationStatus;
  search?: string;
}

export interface ScreeningInput {
  outcome: ScreeningOutcome;
  meetsMinimumQualifications?: boolean | null;
  workAuthorizationConfirmed?: boolean | null;
  requiredCertificationsHeld?: boolean | null;
  availableFrom?: string | null;
  notes?: string | null;
}

export interface InterviewInput {
  type: InterviewType;
  title: string;
  scheduledStart: string;
  durationMinutes: number;
  location?: string | null;
  meetingUrl?: string | null;
  feedbackDueAt?: string | null;
  interviewerUserIds?: string[];
}

export interface FeedbackInput {
  recommendation?: Recommendation | null;
  rating?: number | null;
  strengths?: string | null;
  concerns?: string | null;
  comments?: string | null;
}

export interface OfferInput {
  positionId: string;
  employmentType: EmploymentType;
  startDate: string;
  payBasis: PayBasis;
  rateAmount: string;
  currency: string;
  workLocationId?: string | null;
  expiresOn?: string | null;
  candidateTerms?: string | null;
  internalNotes?: string | null;
}

export interface HireInput {
  existingEmployeeId?: string | null;
  confirmNewPerson?: boolean;
  isPrimary?: boolean;
  managerAssignmentId?: string | null;
  initializeCompensation?: boolean;
  payGroupId?: string | null;
}

export interface IntakeSourceInput {
  organizationId: string;
  code: string;
  name: string;
  provider: IntakeProvider;
  externalResourceId?: string | null;
  resourceUrl?: string | null;
  defaultOpeningId?: string | null;
}

export const recruitmentApi = {
  // ─── Pickers (Batch 7A) ───────────────────────────────────────────────────
  /** Module-scoped picker options: needs recruitment.manage in the organization. */
  options(
    organizationId: string,
    kind: RecruitmentOptionKind,
    filters: { search?: string; limit?: number; afterId?: string } = {},
  ): Promise<RecruitmentOptionPage> {
    return apiRequest(
      `/recruitment/options${query(organizationId, {
        kind,
        search: filters.search,
        limit: filters.limit === undefined ? undefined : String(filters.limit),
        afterId: filters.afterId,
      })}`,
    );
  },

  // ─── Organizations and dashboard ──────────────────────────────────────────
  organizations(): Promise<{ items: RecruitmentOrganization[] }> {
    return apiRequest('/recruitment/organizations');
  },
  dashboard(organizationId: string): Promise<Dashboard> {
    return apiRequest(`/recruitment/dashboard${query(organizationId)}`);
  },

  // ─── Stages ───────────────────────────────────────────────────────────────
  stages(organizationId: string, includeArchived = false): Promise<{ items: Stage[] }> {
    return apiRequest(
      `/recruitment/stages${query(organizationId, includeArchived ? { includeArchived } : {})}`,
    );
  },
  createStage(input: {
    organizationId: string;
    code: string;
    name: string;
    kind: StageKind;
    sortOrder?: number;
  }): Promise<Stage> {
    return send('POST', '/recruitment/stages', input);
  },
  updateStage(stageId: string, input: { name?: string; sortOrder?: number }): Promise<Stage> {
    return send('PATCH', `/recruitment/stages/${enc(stageId)}`, input);
  },
  archiveStage(stageId: string): Promise<Stage> {
    return send('POST', `/recruitment/stages/${enc(stageId)}/archive`);
  },
  reorderStages(organizationId: string, stageIds: string[]): Promise<{ items: Stage[] }> {
    return send('POST', '/recruitment/stages/reorder', { organizationId, stageIds });
  },
  initializeStages(organizationId: string): Promise<{ created: boolean; items: Stage[] }> {
    return send('POST', '/recruitment/stages/initialize', { organizationId });
  },

  // ─── Openings ─────────────────────────────────────────────────────────────
  openings(
    organizationId: string,
    filters: { status?: OpeningStatus; search?: string } = {},
  ): Promise<{ items: Opening[]; truncated?: boolean }> {
    return apiRequest(`/recruitment/openings${query(organizationId, filters)}`);
  },
  opening(openingId: string): Promise<OpeningDetail> {
    return apiRequest(`/recruitment/openings/${enc(openingId)}`);
  },
  createOpening(input: OpeningInput): Promise<Opening> {
    return send('POST', '/recruitment/openings', input);
  },
  updateOpening(openingId: string, input: OpeningUpdate): Promise<Opening> {
    return send('PATCH', `/recruitment/openings/${enc(openingId)}`, input);
  },
  transitionOpening(openingId: string, action: OpeningAction, reason?: string): Promise<Opening> {
    return send(
      'POST',
      `/recruitment/openings/${enc(openingId)}/${action}`,
      reason ? { reason } : {},
    );
  },

  // ─── Candidates and documents ─────────────────────────────────────────────
  candidates(
    organizationId: string,
    filters: { search?: string; includeMerged?: boolean } = {},
  ): Promise<{ items: Candidate[] }> {
    return apiRequest(`/recruitment/candidates${query(organizationId, filters)}`);
  },
  candidate(candidateId: string): Promise<CandidateDetail> {
    return apiRequest(`/recruitment/candidates/${enc(candidateId)}`);
  },
  createCandidate(input: CandidateDetailsInput & { organizationId: string }): Promise<Candidate> {
    return send('POST', '/recruitment/candidates', input);
  },
  updateCandidate(
    candidateId: string,
    input: Partial<Omit<CandidateDetailsInput, 'source'>>,
  ): Promise<Candidate> {
    return send('PATCH', `/recruitment/candidates/${enc(candidateId)}`, input);
  },
  setInternalEmployee(candidateId: string, employeeId: string | null): Promise<Candidate> {
    return send('PUT', `/recruitment/candidates/${enc(candidateId)}/internal-employee`, {
      employeeId,
    });
  },
  archiveCandidate(candidateId: string): Promise<Candidate> {
    return send('POST', `/recruitment/candidates/${enc(candidateId)}/archive`);
  },
  mergeCandidate(candidateId: string, intoCandidateId: string): Promise<Candidate> {
    return send('POST', `/recruitment/candidates/${enc(candidateId)}/merge`, { intoCandidateId });
  },
  addDocument(
    candidateId: string,
    input: DocumentReferenceInput & { applicationId?: string | null },
  ): Promise<CandidateDocument> {
    return send('POST', `/recruitment/candidates/${enc(candidateId)}/documents`, input);
  },
  removeDocument(documentId: string, reason: string): Promise<CandidateDocument> {
    return send('POST', `/recruitment/documents/${enc(documentId)}/remove`, { reason });
  },

  // ─── Applications ─────────────────────────────────────────────────────────
  applications(
    organizationId: string,
    filters: ApplicationFilters = {},
  ): Promise<{ items: ApplicationSummary[] }> {
    return apiRequest(`/recruitment/applications${query(organizationId, { ...filters })}`);
  },
  application(applicationId: string): Promise<ApplicationDetail> {
    return apiRequest(`/recruitment/applications/${enc(applicationId)}`);
  },
  createApplication(
    input: ApplicationInput,
  ): Promise<{ id: string; candidateId: string; status: ApplicationStatus }> {
    return send('POST', '/recruitment/applications', input);
  },
  moveStage(
    applicationId: string,
    stageId: string,
    note?: string | null,
  ): Promise<{ id: string; stage: { id: string; name: string; kind: StageKind } }> {
    return send('POST', `/recruitment/applications/${enc(applicationId)}/stage`, {
      stageId,
      note: note || null,
    });
  },
  recordScreening(applicationId: string, input: ScreeningInput): Promise<Screening> {
    return send('PUT', `/recruitment/applications/${enc(applicationId)}/screening`, input);
  },
  withdraw(applicationId: string, reason: string): Promise<unknown> {
    return send('POST', `/recruitment/applications/${enc(applicationId)}/withdraw`, { reason });
  },
  reject(applicationId: string, reason: string): Promise<unknown> {
    return send('POST', `/recruitment/applications/${enc(applicationId)}/reject`, { reason });
  },

  // ─── Interviews and feedback ──────────────────────────────────────────────
  myInterviews(): Promise<{ items: MyInterview[] }> {
    return apiRequest('/recruitment/me/interviews');
  },
  scheduleInterview(applicationId: string, input: InterviewInput): Promise<Interview> {
    return send('POST', `/recruitment/applications/${enc(applicationId)}/interviews`, input);
  },
  rescheduleInterview(
    interviewId: string,
    input: Partial<Omit<InterviewInput, 'interviewerUserIds'>>,
  ): Promise<Interview> {
    return send('PATCH', `/recruitment/interviews/${enc(interviewId)}`, input);
  },
  completeInterview(interviewId: string): Promise<Interview> {
    return send('POST', `/recruitment/interviews/${enc(interviewId)}/complete`);
  },
  noShowInterview(interviewId: string): Promise<Interview> {
    return send('POST', `/recruitment/interviews/${enc(interviewId)}/no-show`);
  },
  cancelInterview(interviewId: string, reason: string): Promise<Interview> {
    return send('POST', `/recruitment/interviews/${enc(interviewId)}/cancel`, { reason });
  },
  addInterviewer(interviewId: string, userId: string): Promise<Interview> {
    return send('POST', `/recruitment/interviews/${enc(interviewId)}/interviewers`, { userId });
  },
  removeInterviewer(interviewId: string, userId: string): Promise<Interview> {
    return send(
      'DELETE',
      `/recruitment/interviews/${enc(interviewId)}/interviewers/${enc(userId)}`,
    );
  },
  feedbackHistory(interviewId: string): Promise<{ items: Feedback[] }> {
    return apiRequest(`/recruitment/interviews/${enc(interviewId)}/feedback`);
  },
  saveFeedback(interviewId: string, input: FeedbackInput): Promise<Feedback> {
    return send('PUT', `/recruitment/interviews/${enc(interviewId)}/feedback/me`, input);
  },
  submitFeedback(interviewId: string, input: FeedbackInput): Promise<Feedback> {
    return send('POST', `/recruitment/interviews/${enc(interviewId)}/feedback/me/submit`, input);
  },
  reopenFeedback(feedbackId: string, reason: string): Promise<Feedback> {
    return send('POST', `/recruitment/feedback/${enc(feedbackId)}/reopen`, { reason });
  },

  // ─── Offers and hire conversion ───────────────────────────────────────────
  createOffer(applicationId: string, input: OfferInput): Promise<Offer> {
    return send('POST', `/recruitment/applications/${enc(applicationId)}/offers`, input);
  },
  updateOffer(offerId: string, input: Partial<OfferInput>): Promise<Offer> {
    return send('PATCH', `/recruitment/offers/${enc(offerId)}`, input);
  },
  offerAction(offerId: string, action: OfferAction, reason?: string): Promise<Offer> {
    return send('POST', `/recruitment/offers/${enc(offerId)}/${action}`, reason ? { reason } : {});
  },
  hire(applicationId: string, input: HireInput): Promise<HireResult> {
    return send('POST', `/recruitment/applications/${enc(applicationId)}/hire`, input);
  },

  // ─── External intake ──────────────────────────────────────────────────────
  intakeSources(organizationId: string): Promise<{ items: IntakeSource[] }> {
    return apiRequest(`/recruitment/intake-sources${query(organizationId)}`);
  },
  createIntakeSource(input: IntakeSourceInput): Promise<IntakeSource> {
    return send('POST', '/recruitment/intake-sources', input);
  },
  updateIntakeSource(
    sourceId: string,
    input: { name?: string; resourceUrl?: string | null; defaultOpeningId?: string | null },
  ): Promise<IntakeSource> {
    return send('PATCH', `/recruitment/intake-sources/${enc(sourceId)}`, input);
  },
  archiveIntakeSource(sourceId: string): Promise<IntakeSource> {
    return send('POST', `/recruitment/intake-sources/${enc(sourceId)}/archive`);
  },
  importSubmissions(sourceId: string, submissions: unknown[]): Promise<IngestionReport> {
    return send('POST', `/recruitment/intake-sources/${enc(sourceId)}/import`, { submissions });
  },
  /**
   * Batch 7A: the queue (PENDING_OPENING, oldest first) or its history (REJECTED / APPLIED,
   * newest first), filterable by source and paged with `afterId`.
   */
  intake(
    organizationId: string,
    filters: {
      status?: IntakeStatus;
      sourceId?: string;
      limit?: number;
      afterId?: string;
    } = {},
  ): Promise<IntakePage> {
    return apiRequest(
      `/recruitment/intake${query(organizationId, {
        status: filters.status ?? 'PENDING_OPENING',
        sourceId: filters.sourceId,
        limit: filters.limit === undefined ? undefined : String(filters.limit),
        afterId: filters.afterId,
      })}`,
    );
  },
  assignOpening(submissionId: string, openingId: string): Promise<unknown> {
    return send('POST', `/recruitment/intake/${enc(submissionId)}/assign-opening`, { openingId });
  },
  rejectSubmission(submissionId: string, reason: string): Promise<IntakeSubmission> {
    return send('POST', `/recruitment/intake/${enc(submissionId)}/reject`, { reason });
  },
};
