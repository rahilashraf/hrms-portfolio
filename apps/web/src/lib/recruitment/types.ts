/** Phase 13 Recruitment / ATS read and write models (mirror the API). */

export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CASUAL' | 'CONTRACT';
export type PayBasis = 'HOURLY' | 'SALARY';
export type OpeningStatus = 'DRAFT' | 'OPEN' | 'ON_HOLD' | 'FILLED' | 'CLOSED' | 'CANCELLED';
export type OpeningAction = 'open' | 'hold' | 'resume' | 'close' | 'cancel';
export type StageKind =
  | 'APPLIED'
  | 'SCREENING'
  | 'INTERVIEW'
  | 'ASSESSMENT'
  | 'REFERENCE_CHECK'
  | 'OFFER'
  | 'HIRED'
  | 'OTHER';
export type CandidateSource =
  | 'DIRECT'
  | 'REFERRAL'
  | 'JOB_BOARD'
  | 'AGENCY'
  | 'INTERNAL'
  | 'CAREERS_SITE'
  | 'EXTERNAL_FORM'
  | 'OTHER';
export type CandidateStatus = 'ACTIVE' | 'MERGED' | 'ARCHIVED';
export type ApplicationStatus = 'ACTIVE' | 'WITHDRAWN' | 'REJECTED' | 'OFFERED' | 'HIRED';
export type ApplicationView = 'FULL' | 'HIRING_MANAGER' | 'INTERVIEWER';
export type ScreeningOutcome = 'PENDING' | 'ADVANCE' | 'HOLD' | 'DO_NOT_ADVANCE';
export type InterviewType = 'PHONE' | 'VIDEO' | 'IN_PERSON' | 'PANEL' | 'OTHER';
export type InterviewStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
export type Recommendation = 'STRONG_YES' | 'YES' | 'NO' | 'STRONG_NO' | 'NO_DECISION';
export type FeedbackStatus = 'DRAFT' | 'SUBMITTED';
export type OfferStatus =
  'DRAFT' | 'APPROVED' | 'SENT' | 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED';
export type OfferAction = 'approve' | 'revise' | 'send' | 'accept' | 'decline' | 'withdraw';
export type DocumentKind =
  'RESUME' | 'COVER_LETTER' | 'CERTIFICATE' | 'REFERENCE' | 'PORTFOLIO' | 'OTHER';
export type DocumentProvider = 'EXTERNAL_URL' | 'GOOGLE_DRIVE' | 'MANUAL_REFERENCE';
export type IntakeProvider = 'GOOGLE_FORMS' | 'CAREERS_SITE' | 'MANUAL_IMPORT' | 'OTHER';
export type IntakeStatus = 'APPLIED' | 'PENDING_OPENING' | 'REJECTED';

export interface RecruitmentOrganization {
  id: string;
  name: string;
  code: string;
  timezone: string | null;
  actions: {
    canManagePipeline: boolean;
    canManageIntake: boolean;
    canReadAllCandidates: boolean;
    canManageCandidates: boolean;
    canCreateOpenings: boolean;
  };
}

export interface Stage {
  id: string;
  code: string;
  name: string;
  kind: StageKind;
  sortOrder: number;
  archivedAt: string | null;
}

export interface Named {
  id: string;
  name: string;
}

export interface CompensationRange {
  payBasis: PayBasis;
  min: string | null;
  max: string | null;
  currency: string;
}

export interface Opening {
  id: string;
  organization: Named;
  code: string;
  title: string;
  description: string | null;
  status: OpeningStatus;
  statusReason: string | null;
  employmentType: EmploymentType;
  openingCount: number;
  hiredCount: number;
  position: { id: string; name: string; code: string } | null;
  organizationalUnit: Named | null;
  department: Named | null;
  team: Named | null;
  workLocation: Named | null;
  hiringManager: { id: string; displayName: string } | null;
  recruiterUserId: string | null;
  expectedStartDate: string | null;
  postedOn: string | null;
  closesOn: string | null;
  compensation: CompensationRange | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  actions?: {
    canManage: boolean;
    canApproveOffers: boolean;
    canHire: boolean;
    isHiringManager: boolean;
  };
  /** Application counts by status (list only). */
  applications?: Partial<Record<ApplicationStatus, number>>;
}

export interface OpeningDetail extends Opening {
  events: Array<{
    id: string;
    type: string;
    fromStatus: OpeningStatus | null;
    toStatus: OpeningStatus | null;
    changedFields: unknown;
    reason: string | null;
    actorUserId: string | null;
    createdAt: string;
  }>;
}

export interface Candidate {
  id: string;
  organizationId: string;
  displayName: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  status: CandidateStatus;
  source: CandidateSource;
  internal: boolean;
  internalEmployee: { id: string; employeeNumber: string; displayName: string } | null;
  mergedIntoCandidateId: string | null;
  hired: boolean;
  /** Present only for full (recruiter) views. */
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  notes?: string | null;
  createdAt: string;
  applicationCount?: number;
}

export interface CandidateDocument {
  id: string;
  candidateId: string;
  applicationId: string | null;
  kind: DocumentKind;
  title: string;
  provider: DocumentProvider;
  externalUrl: string | null;
  externalFileId: string | null;
  fileName: string | null;
  mimeType: string | null;
  addedAt: string;
  removedAt: string | null;
}

export interface Activity {
  id: string;
  applicationId: string | null;
  type: string;
  summary: string;
  relatedId: string | null;
  actorUserId: string | null;
  occurredAt: string;
}

export interface CandidateDetail extends Candidate {
  applications: Array<{
    id: string;
    status: ApplicationStatus;
    opening: { id: string; code: string; title: string; status: OpeningStatus };
    stage: { id: string; name: string; kind: StageKind };
    appliedAt: string;
  }>;
  documents: CandidateDocument[];
  activity: Activity[];
  actions: { canEdit: boolean; canMerge: boolean; canMarkInternal: boolean };
}

export interface ApplicationSummary {
  id: string;
  status: ApplicationStatus;
  source: CandidateSource;
  appliedAt: string;
  stageEnteredAt: string;
  candidate: { id: string; displayName: string; internal: boolean };
  opening: { id: string; code: string; title: string; status: OpeningStatus };
  stage: { id: string; name: string; kind: StageKind; sortOrder: number };
  view: ApplicationView;
}

export interface Feedback {
  id: string;
  interviewId: string;
  interviewerUserId: string;
  status: FeedbackStatus;
  recommendation: Recommendation | null;
  rating: number | null;
  strengths: string | null;
  concerns: string | null;
  comments: string | null;
  submittedAt: string | null;
  revision: number;
  reopenReason: string | null;
  supersededAt: string | null;
}

export interface Interview {
  id: string;
  applicationId: string;
  type: InterviewType;
  title: string;
  scheduledStart: string;
  durationMinutes: number;
  location: string | null;
  meetingUrl: string | null;
  status: InterviewStatus;
  feedbackDueAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  interviewers: Array<{ userId: string; email: string; feedbackSubmitted: boolean }>;
  feedback: Feedback[];
  pendingFeedback: number;
  feedbackOverdue: boolean;
  isInterviewer: boolean;
}

export interface MyInterview extends Interview {
  candidate: { id: string; displayName: string };
  opening: { id: string; code: string; title: string };
  stageName: string;
  myFeedback: Feedback | null;
}

export interface Screening {
  outcome: ScreeningOutcome;
  meetsMinimumQualifications: boolean | null;
  workAuthorizationConfirmed: boolean | null;
  requiredCertificationsHeld: boolean | null;
  availableFrom: string | null;
  notes: string | null;
  screenedByUserId: string | null;
  screenedAt: string | null;
}

export interface Offer {
  id: string;
  applicationId: string;
  positionId: string;
  workLocationId: string | null;
  employmentType: EmploymentType;
  startDate: string;
  payBasis: PayBasis;
  rateAmount: string;
  currency: string;
  expiresOn: string | null;
  candidateTerms: string | null;
  internalNotes: string | null;
  status: OfferStatus;
  /** Date-derived: a sent offer past its acceptance day reads as EXPIRED. */
  effectiveStatus: OfferStatus;
  approvedAt: string | null;
  approvedByUserId: string | null;
  sentAt: string | null;
  respondedAt: string | null;
  declineReason: string | null;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
  expiredAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface Hire {
  id: string;
  personId: string;
  employeeId: string;
  employmentAssignmentId: string;
  compensationRecordId: string | null;
  internalCandidate: boolean;
  createdEmployee: boolean;
  convertedByUserId: string | null;
  convertedAt: string;
}

export interface HireResult extends Hire {
  employeeNumber: string;
  assignment: { id: string; status: string; startDate: string };
  opening: { id: string; status: OpeningStatus; hiredCount: number; openingCount: number };
}

export interface PossibleEmployeeMatch {
  employeeId: string;
  employeeNumber: string;
  status: string;
}

export interface ApplicationActions {
  canManage: boolean;
  canMoveStage: boolean;
  canScreen: boolean;
  canScheduleInterview: boolean;
  canWithdraw: boolean;
  canReject: boolean;
  canCreateOffer: boolean;
  canApproveOffer: boolean;
  canHire: boolean;
}

export interface ApplicationDetail {
  id: string;
  view: ApplicationView;
  status: ApplicationStatus;
  source: CandidateSource;
  sourceDetail: string | null;
  appliedAt: string;
  stageEnteredAt: string;
  stage: { id: string; name: string; kind: StageKind };
  organization: Named;
  opening: {
    id: string;
    code: string;
    title: string;
    status: OpeningStatus;
    positionId: string | null;
    employmentType: EmploymentType;
  };
  candidate: Candidate;
  interviews: Interview[];
  documents: CandidateDocument[];
  /** HIRING_MANAGER and FULL views. */
  dispositionReason?: string | null;
  dispositionAt?: string | null;
  transitions?: Array<{
    id: string;
    fromStageName: string | null;
    toStageName: string;
    note: string | null;
    actorUserId: string | null;
    createdAt: string;
  }>;
  activity?: Activity[];
  hire?: Hire | null;
  /** FULL view only. */
  screening?: Screening | null;
  offers?: Offer[];
  actions: ApplicationActions;
}

export interface DashboardOfferRow {
  offerId: string;
  applicationId: string;
  candidate: string;
  opening: { id: string; title: string; code: string };
  status: OfferStatus;
  expiresOn: string | null;
}

export interface Dashboard {
  today: string;
  openings: { byStatus: Partial<Record<OpeningStatus, number>>; total: number };
  pipeline: Array<{
    opening: {
      id: string;
      code: string;
      title: string;
      status: OpeningStatus;
      openingCount: number;
      hiredCount: number;
    };
    stages: Array<{ stageId: string; name: string; count: number }>;
  }>;
  attention: {
    overdueFeedback: Array<{
      interviewId: string;
      applicationId: string;
      title: string;
      candidate: string;
      opening: { id: string; title: string; code: string };
      feedbackDueAt: string;
      missing: number;
    }>;
    upcomingInterviews: Array<{
      interviewId: string;
      applicationId: string;
      title: string;
      candidate: string;
      scheduledStart: string;
    }>;
    offersAwaitingApproval: DashboardOfferRow[];
    offersExpiringSoon: Array<DashboardOfferRow & { expired: boolean }>;
    acceptedNotHired: DashboardOfferRow[];
    staleApplications: Array<{
      applicationId: string;
      candidate: string;
      opening: { id: string; title: string; code: string };
      stage: string;
      since: string;
    }>;
    openingsPastClose: Array<{
      openingId: string;
      code: string;
      title: string;
      closesOn: string | null;
    }>;
    pendingIntake: number | null;
  };
}

export interface IntakeSource {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  provider: IntakeProvider;
  externalResourceId: string | null;
  resourceUrl: string | null;
  defaultOpeningId: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
  archivedAt: string | null;
  pendingOpening?: number;
}

export interface DocumentReferenceInput {
  kind: DocumentKind;
  title: string;
  provider: DocumentProvider;
  externalUrl?: string | null;
  externalFileId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
}

export interface IntakeSubmission {
  id: string;
  sourceId: string;
  externalResponseId: string;
  status: IntakeStatus;
  reason: string | null;
  submission: {
    openingCode?: string | null;
    candidate: {
      firstName: string;
      lastName: string;
      preferredName?: string | null;
      email?: string | null;
      phone?: string | null;
      location?: string | null;
    };
    answers?: Array<{ question: string; answer: string }>;
    documents?: DocumentReferenceInput[];
    sourceDetail?: string | null;
  };
  submittedAt: string;
  correctionCount: number;
  candidateId: string | null;
  applicationId: string | null;
  receivedAt: string;
  lastReceivedAt: string;
  resolvedAt: string | null;
}

export type IngestionOutcomeKind =
  'CREATED' | 'ATTACHED' | 'UNCHANGED' | 'CORRECTED' | 'STALE' | 'PENDING_OPENING' | 'REJECTED';

export interface IngestionReport {
  sourceId: string;
  received: number;
  counts: Record<IngestionOutcomeKind, number>;
  outcomes: Array<{
    externalResponseId: string;
    outcome: IngestionOutcomeKind;
    submissionId?: string;
    applicationId?: string;
    candidateId?: string;
    reason?: string;
  }>;
}

/** Batch 7A — what GET /recruitment/options lists (module-scoped pickers). */
export type RecruitmentOptionKind =
  'position' | 'unit' | 'department' | 'team' | 'workLocation' | 'hiringManager' | 'staff';

export interface RecruitmentOption {
  id: string;
  label: string;
  description?: string;
  /** Units, departments and teams: the structure ancestry to send with the choice. */
  placement?: {
    organizationalUnitId: string | null;
    departmentId: string | null;
    teamId: string | null;
  };
}

export interface RecruitmentOptionPage {
  items: RecruitmentOption[];
  nextAfterId: string | null;
}

/** Batch 7A — one page of the intake queue or its history. */
export interface IntakePage {
  items: IntakeSubmission[];
  nextAfterId: string | null;
}
