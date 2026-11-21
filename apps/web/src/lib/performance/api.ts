import { apiRequest } from '../auth/api-client';
import type {
  Answer,
  AttentionItem,
  Competency,
  Cycle,
  CycleReview,
  Evidence,
  EvidenceKind,
  EvidenceRevision,
  EvidenceProvider,
  EvidenceSource,
  Goal,
  GoalStatus,
  IngestionReport,
  IntakeItem,
  Page,
  PerformanceOption,
  PerformanceOptionKind,
  PerformanceOrganization,
  QueueItem,
  RatingScale,
  ReviewDetail,
  ReviewSummary,
  ScaleLevel,
  ScoringMode,
  TemplateDetail,
  TemplateItemInput,
  TemplateSummary,
} from './types';

const enc = encodeURIComponent;

function send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return apiRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const org = (organizationId: string, extra = '') =>
  `?organizationId=${enc(organizationId)}${extra}`;

/** Batch 7B — cursor paging of goal and evidence lists (no limit: the whole list). */
export interface ListPaging {
  limit?: number;
  afterId?: string;
}
/** `total` and `nextAfterId` come with every list response; older callers read `items` only. */
export interface Paged<T> {
  items: T[];
  total?: number;
  nextAfterId?: string | null;
}

/** `?a=1&b=2` from the defined values (empty when none). */
function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export interface ManualEvidenceInput {
  organizationId: string;
  employeeId: string;
  employmentAssignmentId?: string | null;
  provider: Exclude<EvidenceProvider, 'GOOGLE_FORMS'>;
  kind: EvidenceKind;
  title: string;
  completedAt: string;
  score?: string | null;
  maxScore?: string | null;
  passed?: boolean | null;
  passThresholdPercent?: string | null;
  resultUrl?: string | null;
  notes?: string | null;
}

export interface EvidenceCorrection {
  title?: string;
  completedAt?: string;
  score?: string | null;
  maxScore?: string | null;
  passed?: boolean | null;
  resultUrl?: string | null;
  notes?: string | null;
  reason: string;
}

export interface TemplateInput {
  organizationId: string;
  code: string;
  name: string;
  description?: string | null;
  scoringMode: ScoringMode;
  ratingScaleId?: string | null;
  overallRatingEnabled?: boolean;
  sections: Array<{ title: string; description?: string | null; items: TemplateItemInput[] }>;
}

export interface CycleInput {
  organizationId: string;
  code: string;
  name: string;
  description?: string | null;
  templateId: string;
  reviewerModel?: 'DIRECT_MANAGER' | 'HR_ASSIGNED';
  selfReviewEnabled?: boolean;
  acknowledgementEnabled?: boolean;
  periodStart: string;
  periodEnd: string;
  windowStart: string;
  windowEnd: string;
  selfReviewDueDate?: string | null;
  reviewerDueDate?: string | null;
}

export interface GoalInput {
  employmentAssignmentId: string;
  title: string;
  description?: string | null;
  measure?: string | null;
  startDate: string;
  dueDate?: string | null;
  progressPercent?: number | null;
}

export const performanceApi = {
  // ─── Self-service ─────────────────────────────────────────────────────────
  me(): Promise<{
    employeeId: string;
    assignments: Array<{
      id: string;
      status: string;
      isPrimary: boolean;
      positionName: string;
      organization: { id: string; name: string };
    }>;
  }> {
    return apiRequest('/performance/me');
  },
  myReviews(): Promise<{ items: ReviewSummary[] }> {
    return apiRequest('/performance/me/reviews');
  },
  myGoals(status?: GoalStatus, paging: ListPaging = {}): Promise<Paged<Goal>> {
    return apiRequest(`/performance/me/goals${qs({ status, ...paging })}`);
  },
  myEvidence(paging: ListPaging = {}): Promise<Paged<Evidence>> {
    return apiRequest(`/performance/me/evidence${qs({ ...paging })}`);
  },
  reviewing(): Promise<{ items: QueueItem[] }> {
    return apiRequest('/performance/reviewing');
  },

  // ─── Reviews ──────────────────────────────────────────────────────────────
  review(reviewId: string): Promise<ReviewDetail> {
    return apiRequest(`/performance/reviews/${enc(reviewId)}`);
  },
  saveAnswers(
    reviewId: string,
    part: 'self' | 'reviewer',
    input: { answers: Answer[]; overallRatingValue?: number | null },
  ): Promise<ReviewDetail> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/${part}`, input);
  },
  submit(reviewId: string, part: 'self' | 'reviewer'): Promise<ReviewDetail> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/${part}/submit`);
  },
  reassign(
    reviewId: string,
    reviewerEmployeeId: string | null,
    reason: string,
  ): Promise<ReviewDetail> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/reviewer-assignment`, {
      reviewerEmployeeId,
      reason,
    });
  },
  reopen(reviewId: string, part: 'SELF' | 'REVIEWER', reason: string): Promise<ReviewDetail> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/reopen`, { part, reason });
  },
  finalize(reviewId: string): Promise<ReviewDetail> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/finalize`);
  },
  acknowledge(reviewId: string, comment: string | null): Promise<ReviewDetail> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/acknowledge`, { comment });
  },
  closeReview(reviewId: string, reason: string | null): Promise<ReviewDetail> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/close`, { reason });
  },
  correct(
    reviewId: string,
    input: { answers?: Answer[]; overallRatingValue?: number | null; reason: string },
  ): Promise<ReviewDetail> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/correct`, input);
  },
  linkEvidence(reviewId: string, evidenceId: string, formItemId: string | null): Promise<unknown> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/evidence`, {
      evidenceId,
      formItemId,
    });
  },
  unlinkEvidence(reviewId: string, linkId: string): Promise<unknown> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/evidence/${enc(linkId)}/unlink`);
  },
  linkGoal(reviewId: string, goalId: string): Promise<unknown> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/goals/${enc(goalId)}`);
  },
  unlinkGoal(reviewId: string, goalId: string): Promise<unknown> {
    return send('POST', `/performance/reviews/${enc(reviewId)}/goals/${enc(goalId)}/unlink`);
  },

  // ─── Employees ────────────────────────────────────────────────────────────
  employeeReviews(employeeId: string): Promise<{ items: ReviewSummary[] }> {
    return apiRequest(`/performance/employees/${enc(employeeId)}/reviews`);
  },
  employeeGoals(
    employeeId: string,
    status?: GoalStatus,
    paging: ListPaging = {},
  ): Promise<Paged<Goal>> {
    return apiRequest(
      `/performance/employees/${enc(employeeId)}/goals${qs({ status, ...paging })}`,
    );
  },
  employeeEvidence(
    employeeId: string,
    status?: 'ACTIVE' | 'WITHDRAWN',
    paging: ListPaging = {},
  ): Promise<Paged<Evidence>> {
    return apiRequest(
      `/performance/employees/${enc(employeeId)}/evidence${qs({ status, ...paging })}`,
    );
  },
  createGoal(input: GoalInput): Promise<Goal> {
    return send('POST', '/performance/goals', input);
  },
  updateGoal(
    goalId: string,
    input: Partial<Omit<GoalInput, 'employmentAssignmentId'>> & {
      status?: GoalStatus;
      completionNotes?: string | null;
      cancellationReason?: string | null;
    },
  ): Promise<Goal> {
    return send('PATCH', `/performance/goals/${enc(goalId)}`, input);
  },

  // ─── Configuration ────────────────────────────────────────────────────────
  organizations(): Promise<{ items: PerformanceOrganization[] }> {
    return apiRequest('/performance/organizations');
  },
  competencies(organizationId: string): Promise<{ items: Competency[] }> {
    return apiRequest(`/performance/competencies${org(organizationId)}`);
  },
  createCompetency(input: {
    organizationId: string;
    code: string;
    name: string;
    category?: string | null;
    description?: string | null;
  }): Promise<Competency> {
    return send('POST', '/performance/competencies', input);
  },
  updateCompetency(
    id: string,
    input: { name?: string; category?: string | null; description?: string | null },
  ): Promise<Competency> {
    return send('PATCH', `/performance/competencies/${enc(id)}`, input);
  },
  updateScale(
    id: string,
    input: { name?: string; description?: string | null; levels?: ScaleLevel[] },
  ): Promise<RatingScale> {
    return send('PATCH', `/performance/rating-scales/${enc(id)}`, input);
  },
  updateTemplate(
    id: string,
    input: Partial<Omit<TemplateInput, 'organizationId' | 'code'>>,
  ): Promise<TemplateDetail> {
    return send('PATCH', `/performance/templates/${enc(id)}`, input);
  },
  archiveCompetency(id: string): Promise<Competency> {
    return send('POST', `/performance/competencies/${enc(id)}/archive`);
  },
  scales(organizationId: string): Promise<{ items: RatingScale[] }> {
    return apiRequest(`/performance/rating-scales${org(organizationId)}`);
  },
  createScale(input: {
    organizationId: string;
    code: string;
    name: string;
    levels: ScaleLevel[];
  }): Promise<RatingScale> {
    return send('POST', '/performance/rating-scales', input);
  },
  transitionScale(id: string, action: 'activate' | 'archive'): Promise<RatingScale> {
    return send('POST', `/performance/rating-scales/${enc(id)}/${action}`);
  },
  templates(organizationId: string): Promise<{ items: TemplateSummary[] }> {
    return apiRequest(`/performance/templates${org(organizationId)}`);
  },
  template(id: string): Promise<TemplateDetail> {
    return apiRequest(`/performance/templates/${enc(id)}`);
  },
  createTemplate(input: TemplateInput): Promise<TemplateDetail> {
    return send('POST', '/performance/templates', input);
  },
  transitionTemplate(id: string, action: 'activate' | 'archive'): Promise<TemplateDetail> {
    return send('POST', `/performance/templates/${enc(id)}/${action}`);
  },
  copyTemplate(id: string, code: string, name?: string): Promise<TemplateDetail> {
    return send('POST', `/performance/templates/${enc(id)}/copy`, {
      code,
      ...(name ? { name } : {}),
    });
  },

  // ─── Cycles ───────────────────────────────────────────────────────────────
  cycles(organizationId: string): Promise<{ items: Cycle[] }> {
    return apiRequest(`/performance/cycles${org(organizationId)}`);
  },
  createCycle(input: CycleInput): Promise<Cycle> {
    return send('POST', '/performance/cycles', input);
  },
  cycle(cycleId: string): Promise<Cycle & Record<string, unknown>> {
    return apiRequest(`/performance/cycles/${enc(cycleId)}`);
  },
  updateCycle(
    cycleId: string,
    input: Partial<Omit<CycleInput, 'organizationId' | 'code'>>,
  ): Promise<Cycle> {
    return send('PATCH', `/performance/cycles/${enc(cycleId)}`, input);
  },
  discardCycle(cycleId: string): Promise<unknown> {
    return send('DELETE', `/performance/cycles/${enc(cycleId)}`);
  },
  cycleReviews(
    cycleId: string,
    filters: {
      status?: string;
      reviewerEmployeeId?: string;
      withoutReviewer?: boolean;
      search?: string;
      limit?: number;
      afterId?: string;
    } = {},
  ): Promise<Page<CycleReview>> {
    return apiRequest(`/performance/cycles/${enc(cycleId)}/reviews${qs(filters)}`);
  },
  addReviews(
    cycleId: string,
    input: {
      allInOrganization?: boolean;
      assignmentIds?: string[];
      organizationalUnitId?: string;
      departmentId?: string;
      teamId?: string;
    },
  ): Promise<{ added: number; skipped: number; withoutReviewer: number; excludedOwn?: number }> {
    return send('POST', `/performance/cycles/${enc(cycleId)}/reviews`, input);
  },
  removeReview(cycleId: string, reviewId: string): Promise<{ removed: boolean }> {
    return send('DELETE', `/performance/cycles/${enc(cycleId)}/reviews/${enc(reviewId)}`);
  },
  transitionCycle(cycleId: string, action: 'open' | 'archive'): Promise<Cycle> {
    return send('POST', `/performance/cycles/${enc(cycleId)}/${action}`);
  },
  closeCycle(
    cycleId: string,
    input: { closeIncomplete?: boolean; reason?: string | null },
  ): Promise<Cycle> {
    return send('POST', `/performance/cycles/${enc(cycleId)}/close`, input);
  },
  attention(
    organizationId: string,
    filters: { cycleId?: string; flag?: string; limit?: number; afterId?: string } = {},
  ): Promise<Page<AttentionItem>> {
    return apiRequest(`/performance/attention${qs({ organizationId, ...filters })}`);
  },

  // ─── Evidence ─────────────────────────────────────────────────────────────
  evidenceSources(organizationId: string): Promise<{ items: EvidenceSource[] }> {
    return apiRequest(`/performance/evidence-sources${org(organizationId)}`);
  },
  createEvidenceSource(input: {
    organizationId: string;
    code: string;
    name: string;
    provider: EvidenceProvider;
    kind: EvidenceKind;
    externalResourceId?: string | null;
    resourceTitle?: string | null;
    passThresholdPercent?: string | null;
  }): Promise<EvidenceSource> {
    return send('POST', '/performance/evidence-sources', input);
  },
  importResults(sourceId: string, results: unknown[]): Promise<IngestionReport> {
    return send('POST', `/performance/evidence-sources/${enc(sourceId)}/import`, { results });
  },
  intake(
    organizationId: string,
    filters: {
      status?: 'PENDING_MATCH' | 'MATCHED' | 'REJECTED';
      sourceId?: string;
      limit?: number;
      afterId?: string;
    } = {},
  ): Promise<Page<IntakeItem>> {
    return apiRequest(`/performance/evidence-intake${qs({ organizationId, ...filters })}`);
  },
  updateEvidenceSource(
    sourceId: string,
    input: {
      name?: string;
      resourceTitle?: string | null;
      resourceUrl?: string | null;
      passThresholdPercent?: string | null;
    },
  ): Promise<EvidenceSource> {
    return send('PATCH', `/performance/evidence-sources/${enc(sourceId)}`, input);
  },
  archiveEvidenceSource(sourceId: string): Promise<EvidenceSource> {
    return send('POST', `/performance/evidence-sources/${enc(sourceId)}/archive`);
  },
  recordEvidence(input: ManualEvidenceInput): Promise<Evidence> {
    return send('POST', '/performance/evidence', input);
  },
  correctEvidence(evidenceId: string, input: EvidenceCorrection): Promise<Evidence> {
    return send('POST', `/performance/evidence/${enc(evidenceId)}/correct`, input);
  },
  remapEvidence(
    evidenceId: string,
    input: { employeeId: string; employmentAssignmentId?: string | null; reason: string },
  ): Promise<Evidence> {
    return send('POST', `/performance/evidence/${enc(evidenceId)}/remap`, input);
  },
  evidenceHistory(evidenceId: string): Promise<{ items: EvidenceRevision[] }> {
    return apiRequest(`/performance/evidence/${enc(evidenceId)}/history`);
  },

  // ─── Pickers (Batch 7B, D7) ───────────────────────────────────────────────
  options(
    organizationId: string,
    kind: PerformanceOptionKind,
    filters: { search?: string; employeeId?: string; limit?: number; afterId?: string } = {},
  ): Promise<{ items: PerformanceOption[]; nextAfterId: string | null }> {
    return apiRequest(`/performance/options${qs({ organizationId, kind, ...filters })}`);
  },
  resolveIntake(
    intakeId: string,
    input:
      | {
          action: 'MATCH';
          employeeId: string;
          employmentAssignmentId?: string | null;
          note?: string;
        }
      | { action: 'REJECT'; note: string },
  ): Promise<{ status: string }> {
    return send('POST', `/performance/evidence-intake/${enc(intakeId)}/resolve`, input);
  },
  withdrawEvidence(evidenceId: string, reason: string): Promise<Evidence> {
    return send('POST', `/performance/evidence/${enc(evidenceId)}/withdraw`, { reason });
  },
};
