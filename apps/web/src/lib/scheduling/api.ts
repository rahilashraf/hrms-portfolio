import { apiRequest } from '../auth/api-client';
import type {
  ConflictPreview,
  GenerationResult,
  GridQuery,
  GridResponse,
  MyScheduleResponse,
  Page,
  PatternInput,
  PatternPeriodInput,
  PatternUpdateInput,
  RecurrenceRule,
  RecurrenceRuleInput,
  RecurrenceRuleUpdateInput,
  ResolvedSchedulePolicy,
  Schedule,
  ScheduleInput,
  ScheduleListQuery,
  SchedulePattern,
  SchedulePolicy,
  SchedulePolicyInput,
  SchedulePolicyUpdateInput,
  ScheduleTemplate,
  ScheduleUpdateInput,
  ScheduledHoursQuery,
  ScheduledHoursResponse,
  ScheduledShift,
  ShiftChangeResult,
  ShiftCreateInput,
  ShiftFieldsInput,
  ShiftRevision,
  ShiftUpdateInput,
  TemplateInput,
} from './types';

/** The self-service view and the admin grid read at most this many days (inclusive) per request. */
export const MY_SCHEDULE_MAX_DAYS = 62;
export const GRID_MAX_DAYS = 62;

const enc = encodeURIComponent;

function query(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return apiRequest(path, { method: 'POST', body: JSON.stringify(body) });
}
function patch<T>(path: string, body: unknown): Promise<T> {
  return apiRequest(path, { method: 'PATCH', body: JSON.stringify(body) });
}
function del<T = { success: true }>(path: string): Promise<T> {
  return apiRequest(path, { method: 'DELETE' });
}

export const schedulingApi = {
  /** One's own published shifts between two dates (YYYY-MM-DD, inclusive). */
  mySchedule(from: string, to: string, includeCancelled = false): Promise<MyScheduleResponse> {
    const params = new URLSearchParams({ from, to });
    if (includeCancelled) params.set('includeCancelled', 'true');
    return apiRequest(`/scheduling/me?${params.toString()}`);
  },

  // ─── Views ────────────────────────────────────────────────────────────────
  grid(input: GridQuery): Promise<GridResponse> {
    return apiRequest(`/scheduling${query(input)}`);
  },
  scheduledHours(input: ScheduledHoursQuery): Promise<ScheduledHoursResponse> {
    return apiRequest(`/scheduling/reports/scheduled-hours${query(input)}`);
  },

  // ─── Schedules ────────────────────────────────────────────────────────────
  listSchedules(input: ScheduleListQuery): Promise<Page<Schedule>> {
    return apiRequest(`/schedules${query(input)}`);
  },
  getSchedule(id: string): Promise<Schedule> {
    return apiRequest(`/schedules/${enc(id)}`);
  },
  createSchedule(input: ScheduleInput): Promise<Schedule> {
    return post('/schedules', input);
  },
  updateSchedule(id: string, input: ScheduleUpdateInput): Promise<Schedule> {
    return patch(`/schedules/${enc(id)}`, input);
  },
  deleteSchedule(id: string) {
    return del(`/schedules/${enc(id)}`);
  },
  publishSchedule(id: string): Promise<Schedule> {
    return post(`/schedules/${enc(id)}/publish`);
  },

  // ─── Shifts ───────────────────────────────────────────────────────────────
  getShift(scheduleId: string, shiftId: string): Promise<ScheduledShift> {
    return apiRequest(`/schedules/${enc(scheduleId)}/shifts/${enc(shiftId)}`);
  },
  createShift(scheduleId: string, input: ShiftCreateInput): Promise<ScheduledShift> {
    return post(`/schedules/${enc(scheduleId)}/shifts`, input);
  },
  updateShift(
    scheduleId: string,
    shiftId: string,
    input: ShiftUpdateInput,
  ): Promise<ScheduledShift> {
    return patch(`/schedules/${enc(scheduleId)}/shifts/${enc(shiftId)}`, input);
  },
  deleteShift(scheduleId: string, shiftId: string) {
    return del(`/schedules/${enc(scheduleId)}/shifts/${enc(shiftId)}`);
  },
  previewNewShift(scheduleId: string, input: ShiftFieldsInput): Promise<ConflictPreview> {
    return post(`/schedules/${enc(scheduleId)}/shifts/conflicts`, input);
  },
  previewShiftUpdate(
    scheduleId: string,
    shiftId: string,
    input: Omit<ShiftUpdateInput, 'conflictOverrides'>,
  ): Promise<ConflictPreview> {
    return post(`/schedules/${enc(scheduleId)}/shifts/${enc(shiftId)}/conflicts`, input);
  },
  addPublishedShift(
    scheduleId: string,
    input: ShiftCreateInput & { reason: string },
  ): Promise<ShiftChangeResult> {
    return post(`/schedules/${enc(scheduleId)}/shifts/add`, input);
  },
  correctShift(
    scheduleId: string,
    shiftId: string,
    input: ShiftUpdateInput & { reason: string },
  ): Promise<ShiftChangeResult> {
    return post(`/schedules/${enc(scheduleId)}/shifts/${enc(shiftId)}/correct`, input);
  },
  cancelShift(scheduleId: string, shiftId: string, reason: string): Promise<ShiftChangeResult> {
    return post(`/schedules/${enc(scheduleId)}/shifts/${enc(shiftId)}/cancel`, { reason });
  },
  revisions(scheduleId: string, shiftId: string): Promise<{ items: ShiftRevision[] }> {
    return apiRequest(`/schedules/${enc(scheduleId)}/shifts/${enc(shiftId)}/revisions`);
  },

  // ─── Templates ────────────────────────────────────────────────────────────
  listTemplates(
    organizationId: string,
    includeArchived = false,
    afterId?: string,
  ): Promise<Page<ScheduleTemplate>> {
    return apiRequest(
      `/schedule-templates${query({ organizationId, includeArchived: includeArchived || undefined, afterId, limit: 100 })}`,
    );
  },
  getTemplate(id: string): Promise<ScheduleTemplate> {
    return apiRequest(`/schedule-templates/${enc(id)}`);
  },
  createTemplate(input: TemplateInput): Promise<ScheduleTemplate> {
    return post('/schedule-templates', input);
  },
  updateTemplate(
    id: string,
    input: { name?: string; description?: string | null; rotationWeeks?: number },
  ): Promise<ScheduleTemplate> {
    return patch(`/schedule-templates/${enc(id)}`, input);
  },
  archiveTemplate(id: string): Promise<ScheduleTemplate> {
    return post(`/schedule-templates/${enc(id)}/archive`);
  },
  deleteTemplate(id: string) {
    return del(`/schedule-templates/${enc(id)}`);
  },
  addTemplateRule(id: string, rule: RecurrenceRuleInput): Promise<RecurrenceRule> {
    return post(`/schedule-templates/${enc(id)}/rules`, rule);
  },
  updateTemplateRule(
    id: string,
    ruleId: string,
    input: RecurrenceRuleUpdateInput,
  ): Promise<RecurrenceRule> {
    return patch(`/schedule-templates/${enc(id)}/rules/${enc(ruleId)}`, input);
  },
  deleteTemplateRule(id: string, ruleId: string) {
    return del(`/schedule-templates/${enc(id)}/rules/${enc(ruleId)}`);
  },

  // ─── Recurring patterns (per employment assignment) ──────────────────────
  listPatterns(assignmentId: string): Promise<{ items: SchedulePattern[] }> {
    return apiRequest(`/employment-assignments/${enc(assignmentId)}/schedule-patterns`);
  },
  createPattern(assignmentId: string, input: PatternInput): Promise<SchedulePattern> {
    return post(`/employment-assignments/${enc(assignmentId)}/schedule-patterns`, input);
  },
  patternFromTemplate(
    assignmentId: string,
    input: PatternPeriodInput & { templateId: string },
  ): Promise<SchedulePattern> {
    return post(
      `/employment-assignments/${enc(assignmentId)}/schedule-patterns/from-template`,
      input,
    );
  },
  /** Only before the pattern starts. */
  updatePattern(
    assignmentId: string,
    patternId: string,
    input: PatternUpdateInput,
  ): Promise<SchedulePattern> {
    return patch(
      `/employment-assignments/${enc(assignmentId)}/schedule-patterns/${enc(patternId)}`,
      input,
    );
  },
  endPattern(
    assignmentId: string,
    patternId: string,
    effectiveTo: string,
  ): Promise<SchedulePattern> {
    return post(
      `/employment-assignments/${enc(assignmentId)}/schedule-patterns/${enc(patternId)}/end`,
      { effectiveTo },
    );
  },
  deletePattern(assignmentId: string, patternId: string) {
    return del(`/employment-assignments/${enc(assignmentId)}/schedule-patterns/${enc(patternId)}`);
  },
  addPatternRule(
    assignmentId: string,
    patternId: string,
    rule: RecurrenceRuleInput,
  ): Promise<RecurrenceRule> {
    return post(
      `/employment-assignments/${enc(assignmentId)}/schedule-patterns/${enc(patternId)}/rules`,
      rule,
    );
  },
  updatePatternRule(
    assignmentId: string,
    patternId: string,
    ruleId: string,
    input: RecurrenceRuleUpdateInput,
  ): Promise<RecurrenceRule> {
    return patch(
      `/employment-assignments/${enc(assignmentId)}/schedule-patterns/${enc(patternId)}/rules/${enc(ruleId)}`,
      input,
    );
  },
  deletePatternRule(assignmentId: string, patternId: string, ruleId: string) {
    return del(
      `/employment-assignments/${enc(assignmentId)}/schedule-patterns/${enc(patternId)}/rules/${enc(ruleId)}`,
    );
  },
  generate(
    assignmentId: string,
    patternId: string,
    range: { from?: string; to?: string } = {},
  ): Promise<GenerationResult> {
    return post(
      `/employment-assignments/${enc(assignmentId)}/schedule-patterns/${enc(patternId)}/generate`,
      range,
    );
  },

  // ─── Policies ─────────────────────────────────────────────────────────────
  listPolicies(organizationId: string, afterId?: string): Promise<Page<SchedulePolicy>> {
    return apiRequest(`/schedule-policies${query({ organizationId, afterId, limit: 100 })}`);
  },
  createPolicy(input: SchedulePolicyInput): Promise<SchedulePolicy> {
    return post('/schedule-policies', input);
  },
  /** Only before the policy takes effect. */
  updatePolicy(id: string, input: SchedulePolicyUpdateInput): Promise<SchedulePolicy> {
    return patch(`/schedule-policies/${enc(id)}`, input);
  },
  endPolicy(id: string, effectiveTo: string): Promise<SchedulePolicy> {
    return post(`/schedule-policies/${enc(id)}/end`, { effectiveTo });
  },
  deletePolicy(id: string) {
    return del(`/schedule-policies/${enc(id)}`);
  },
  resolvePolicy(employmentAssignmentId: string, date: string): Promise<ResolvedSchedulePolicy> {
    return apiRequest(`/schedule-policies/resolve${query({ employmentAssignmentId, date })}`);
  },
};
