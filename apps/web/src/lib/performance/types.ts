/** Phase 12 Performance read and write models (mirror the API). */

export type ConfigStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type ItemType =
  'RATING' | 'SCALE' | 'TEXT' | 'YES_NO' | 'GOAL_PROGRESS' | 'EVIDENCE_REFERENCE';
export type Respondent = 'SELF' | 'REVIEWER' | 'BOTH';
export type ScoringMode = 'NONE' | 'WEIGHTED_AVERAGE';
export type CycleStatus = 'DRAFT' | 'OPEN' | 'CLOSED' | 'ARCHIVED';
export type ReviewStatus =
  'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'FINALIZED' | 'ACKNOWLEDGED' | 'CLOSED';
export type PartStatus =
  'NOT_REQUIRED' | 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'NOT_SUBMITTED';
export type GoalStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type EvidenceProvider = 'GOOGLE_FORMS' | 'MANUAL' | 'TRAINING' | 'CERTIFICATION' | 'OTHER';
export type EvidenceKind =
  'ASSESSMENT' | 'TRAINING' | 'CERTIFICATION' | 'POLICY_ACKNOWLEDGEMENT' | 'OTHER';

export interface PerformanceOrganization {
  id: string;
  name: string;
  code: string;
  timezone: string | null;
  actions: { canManageTemplates: boolean; canManageCycles: boolean; canManageEvidence: boolean };
}

export interface ScaleLevel {
  value: number;
  label: string;
  description: string | null;
}

export interface Competency {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  archived: boolean;
}

export interface RatingScale {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ConfigStatus;
  levels: ScaleLevel[];
}

export interface TemplateSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: ConfigStatus;
  scoringMode: ScoringMode;
  overallRatingEnabled: boolean;
  ratingScale: { id: string; code: string; name: string } | null;
  sectionCount: number;
  itemCount: number;
  cycleCount: number;
}

export interface TemplateItemInput {
  itemType: ItemType;
  prompt: string;
  helpText?: string | null;
  respondent: Respondent;
  required?: boolean;
  weight?: string | null;
  competencyId?: string | null;
  ratingScaleId?: string | null;
  scaleMin?: number | null;
  scaleMax?: number | null;
}

export interface TemplateDetail extends Omit<
  TemplateSummary,
  'sectionCount' | 'itemCount' | 'cycleCount' | 'ratingScale'
> {
  ratingScale: RatingScale | null;
  sections: Array<{
    id: string;
    title: string;
    description: string | null;
    items: Array<
      Omit<TemplateItemInput, 'competencyId' | 'ratingScaleId'> & {
        id: string;
        competency: { id: string; code: string; name: string; archived: boolean } | null;
        ratingScale: { id: string; code: string; name: string; status: ConfigStatus } | null;
      }
    >;
  }>;
  actions: { canEdit: boolean; canActivate: boolean; canArchive: boolean; canCopy: boolean };
}

export interface Cycle {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: CycleStatus;
  templateId: string;
  reviewerModel: 'DIRECT_MANAGER' | 'HR_ASSIGNED';
  selfReviewEnabled: boolean;
  acknowledgementEnabled: boolean;
  periodStart: string;
  periodEnd: string;
  windowStart: string;
  windowEnd: string;
  selfReviewDueDate: string | null;
  reviewerDueDate: string | null;
  scoringMode: ScoringMode | null;
  overallRatingEnabled: boolean | null;
  template?: { id: string; code: string; name: string };
  reviewCounts?: Partial<Record<ReviewStatus, number>>;
  actions?: {
    canEdit: boolean;
    canAddReviews: boolean;
    canOpen: boolean;
    canClose: boolean;
    canArchive: boolean;
    canDiscard: boolean;
  };
}

export interface CycleReview {
  id: string;
  employee: { id: string; employeeNumber: string; displayName: string };
  employmentAssignment: { id: string; positionName: string };
  reviewer: { id: string; displayName: string } | null;
  status: ReviewStatus;
  selfStatus: PartStatus;
  reviewerStatus: PartStatus;
  overdue: Array<'SELF' | 'REVIEWER'>;
}

export interface FormItem {
  id: string;
  sortOrder: number;
  itemType: ItemType;
  prompt: string;
  helpText: string | null;
  respondent: Respondent;
  required: boolean;
  weight: string | null;
  competency: { id: string; code: string | null; name: string | null } | null;
  scaleLevels: ScaleLevel[] | null;
  scaleMin: number | null;
  scaleMax: number | null;
}

export interface FormSection {
  id: string;
  title: string;
  description: string | null;
  items: FormItem[];
}

export interface AnswerView {
  ratingValue: number | null;
  ratingLabel: string | null;
  numericValue: number | null;
  booleanValue: boolean | null;
  textValue: string | null;
  submitted: boolean;
  recordType: 'ORIGINAL' | 'CORRECTION';
}

export interface Answer {
  itemId: string;
  ratingValue?: number | null;
  numericValue?: number | null;
  booleanValue?: boolean | null;
  textValue?: string | null;
}

export interface ReviewDetail {
  id: string;
  status: ReviewStatus;
  selfStatus: PartStatus;
  reviewerStatus: PartStatus;
  viewer: 'SELF' | 'REVIEWER' | 'HR' | 'READER';
  cycle: {
    id: string;
    code: string;
    name: string;
    status: CycleStatus;
    periodStart: string;
    periodEnd: string;
    windowStart: string;
    windowEnd: string;
    selfReviewDueDate: string | null;
    reviewerDueDate: string | null;
    scoringMode: ScoringMode | null;
    overallRatingEnabled: boolean | null;
    overallScaleLevels: ScaleLevel[] | null;
    acknowledgementEnabled: boolean;
  };
  organization: { id: string; name: string };
  employee: { id: string; employeeNumber: string; displayName: string };
  employmentAssignment: { id: string; positionName: string };
  reviewer: { id: string; displayName: string } | null;
  form: FormSection[];
  responses: Record<string, { self?: AnswerView; reviewer?: AnswerView }>;
  goals: Array<{
    linkId: string;
    goalId: string;
    title: string;
    status: GoalStatus;
    progressPercent: number | null;
    dueDate: string | null;
    snapshotted: boolean;
  }>;
  evidence: Array<{
    linkId: string;
    formItemId: string | null;
    evidenceId: string;
    title: string;
    provider: EvidenceProvider;
    completedAt: string;
    score: string | null;
    maxScore: string | null;
    percentage: string | null;
    passed: boolean | null;
    status: 'ACTIVE' | 'WITHDRAWN';
    changedSinceLinked: boolean;
  }>;
  calculatedScore: string | null;
  overallRating: { value: number; label: string | null } | null;
  finalizedAt: string | null;
  acknowledgedAt: string | null;
  closedAt: string | null;
  closeReason: 'COMPLETED' | 'NOT_ACKNOWLEDGED' | 'INCOMPLETE' | null;
  acknowledgement: { acknowledgedAt: string; comment: string | null } | null;
  events: Array<{
    type: string;
    at: string;
    fromStatus: ReviewStatus | null;
    toStatus: ReviewStatus | null;
    reason: string | null;
    /** Batch 7B: people by name. */
    actorName?: string | null;
    fromEmployeeId?: string | null;
    toEmployeeId?: string | null;
    fromEmployeeName?: string | null;
    toEmployeeName?: string | null;
  }>;
  actions: {
    canEditSelf: boolean;
    canEditReviewer: boolean;
    canReassign: boolean;
    canReopenSelf: boolean;
    canReopenReviewer: boolean;
    canLinkEvidence: boolean;
    canLinkGoals: boolean;
    canFinalize: boolean;
    canAcknowledge: boolean;
    canClose: boolean;
    canCorrect: boolean;
  };
}

export interface ReviewSummary {
  id: string;
  cycle: {
    id: string;
    code: string;
    name: string;
    status: CycleStatus;
    periodStart: string;
    periodEnd: string;
  };
  positionName: string;
  reviewer: { id: string; displayName: string } | null;
  status: ReviewStatus;
  selfStatus: PartStatus;
  reviewerStatus: PartStatus;
  overallRating: { value: number; label: string | null } | null;
  calculatedScore: string | null;
  finalizedAt: string | null;
  acknowledgedAt: string | null;
  closeReason: string | null;
  awaitingAcknowledgement: boolean;
  submittedBy?: { id: string; displayName: string | null } | null;
}

export interface QueueItem {
  id: string;
  cycle: { id: string; name: string; reviewerDueDate: string | null; windowEnd: string };
  employee: { id: string; employeeNumber: string; displayName: string };
  positionName: string;
  status: ReviewStatus;
  selfStatus: PartStatus;
  reviewerStatus: PartStatus;
  overdue: Array<'SELF' | 'REVIEWER'>;
}

export interface Goal {
  id: string;
  /** Batch 7B (D5): who set the goal — the employee, or their manager or HR. */
  setBy?: 'EMPLOYEE' | 'MANAGER' | 'UNKNOWN';
  createdBy?: { userId: string; displayName: string } | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  employmentAssignmentId: string;
  positionName?: string;
  title: string;
  description: string | null;
  measure: string | null;
  startDate: string;
  dueDate: string | null;
  status: GoalStatus;
  progressPercent: number | null;
  completionNotes: string | null;
  cancellationReason: string | null;
}

export interface Evidence {
  id: string;
  organizationId: string;
  employeeId?: string;
  /** Batch 7B: the employee by name (HR views). */
  employee?: { id: string; employeeNumber: string; displayName: string } | null;
  sourceId?: string | null;
  resultUrl?: string | null;
  employmentAssignment: { id: string; positionName: string | null } | null;
  provider: EvidenceProvider;
  kind: EvidenceKind;
  channel: 'MANUAL' | 'IMPORT' | 'SYNC';
  title: string;
  sourceName: string | null;
  completedAt: string;
  score: string | null;
  maxScore: string | null;
  percentage: string | null;
  passed: boolean | null;
  passThresholdPercent: string | null;
  status: 'ACTIVE' | 'WITHDRAWN';
  withdrawalReason: string | null;
  revision: number;
  importedAt: string;
  sync: { lastSyncedAt: string | null; lastSyncStatus: string | null } | null;
  notes?: string | null;
  actions?: { canManage: boolean };
}

export interface EvidenceSource {
  id: string;
  code: string;
  name: string;
  provider: EvidenceProvider;
  kind: EvidenceKind;
  externalResourceId: string | null;
  resourceTitle: string | null;
  resourceUrl: string | null;
  passThresholdPercent: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
  archived: boolean;
  evidenceCount?: number;
  pendingMatches?: number;
}

export interface IntakeItem {
  id: string;
  resolutionNote?: string | null;
  resolvedAt?: string | null;
  source: { id: string; code: string; name: string; provider: EvidenceProvider };
  externalResultId: string;
  respondentEmail: string | null;
  respondentReference: string | null;
  result: { title?: string; completedAt?: string; score?: string | null; maxScore?: string | null };
  status: 'PENDING_MATCH' | 'MATCHED' | 'REJECTED';
  reason: string;
  receivedAt: string;
}

export interface IngestionReport {
  received: number;
  counts: Record<string, number>;
  outcomes: Array<{ externalResultId: string; outcome: string; reason?: string }>;
}

export interface AttentionItem {
  id?: string;
  reviewId: string;
  cycle: { id: string; name: string; status: CycleStatus };
  employee: { id: string; employeeNumber: string; displayName: string };
  positionName: string;
  reviewer: { id: string; displayName: string } | null;
  status: ReviewStatus;
  flags: string[];
}

/** Batch 7B — one revision of a piece of evidence (history). */
export interface EvidenceRevision extends Evidence {
  correctionReason: string | null;
  supersededAt: string | null;
  recordedBy: { userId: string; displayName: string } | null;
}

/** Batch 7B — module-scoped picker option (GET /performance/options). */
export interface PerformanceOption {
  id: string;
  label: string;
  description?: string;
  employeeId?: string;
}
export type PerformanceOptionKind =
  'employee' | 'assignment' | 'reviewer' | 'unit' | 'department' | 'team';

/** Batch 7B — a page of a queue. */
export interface Page<T> {
  items: T[];
  nextAfterId: string | null;
  total?: number;
  truncated?: boolean;
}
