export type MyShiftStatus = 'ACTIVE' | 'CANCELLED';

export interface MyScheduledShift {
  id: string;
  schedule: { id: string; name: string };
  assignment: {
    id: string;
    isPrimary: boolean;
    position: { id: string; name: string; code: string };
    organization: { id: string; name: string };
  };
  workLocation: { id: string; name: string; code: string; timezone: string | null } | null;
  workDate: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  durationMinutes: number;
  status: MyShiftStatus;
}

/** R4-A.6: an organization holiday shown on a schedule (information only; date-only). */
export interface ScheduleHolidayMarker {
  date: string;
  name: string;
  kind: 'STATUTORY_HOLIDAY' | 'CLOSURE';
  organizationId: string;
}

export interface MyScheduleResponse {
  employeeId: string;
  range: { from: string; to: string };
  /** R4-A.6: holidays of the employee's own assignments (absent from older APIs). */
  holidays?: ScheduleHolidayMarker[];
  items: MyScheduledShift[];
}

// ─── Administration (Phase 7 Scheduling API) ────────────────────────────────

export type ScheduleStatus = 'DRAFT' | 'PUBLISHED';
export type ScheduleType = 'STANDARD' | 'AD_HOC';
export type ScheduleScopeType = 'ORGANIZATION' | 'ORGANIZATIONAL_UNIT' | 'DEPARTMENT' | 'TEAM';
export type ShiftStatus = 'ACTIVE' | 'CANCELLED';
export type ShiftSourceType = 'MANUAL' | 'PATTERN';
export type ConflictType =
  | 'SAME_ASSIGNMENT_OVERLAP'
  | 'EMPLOYEE_ASSIGNMENT_OVERLAP'
  | 'MINIMUM_REST_VIOLATION'
  | 'MAXIMUM_SHIFT_DURATION_EXCEEDED';
export type RevisionType = 'PUBLISHED_BASELINE' | 'CORRECTED' | 'CANCELLED';

export interface ScopeFields {
  scopeType: ScheduleScopeType;
  organizationalUnitId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
}

export interface Schedule extends ScopeFields {
  id: string;
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  name: string;
  periodStart: string;
  periodEnd: string;
  type: ScheduleType;
  status: ScheduleStatus;
  publishedAt: string | null;
  publishedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  nextAfterId: string | null;
}

export interface ScheduleInput {
  scopeType: ScheduleScopeType;
  organizationId: string;
  organizationalUnitId?: string;
  departmentId?: string;
  teamId?: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  type: ScheduleType;
}

export type ScheduleUpdateInput = Partial<Omit<ScheduleInput, 'organizationId'>>;

export interface ScheduleListQuery {
  organizationId: string;
  status?: ScheduleStatus;
  type?: ScheduleType;
  from?: string;
  to?: string;
  afterId?: string;
  limit?: number;
}

/** A shift as stored (schedule shift endpoints). */
export interface ScheduledShift {
  id: string;
  scheduleId: string;
  employmentAssignmentId: string;
  workLocationId: string | null;
  workDate: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: ShiftStatus;
  sourceType: ShiftSourceType;
  createdAt: string;
  updatedAt: string;
}

export interface ShiftActions {
  canEditDraft: boolean;
  canDeleteDraft: boolean;
  canPublish: boolean;
  canCorrect: boolean;
  canCancel: boolean;
  canOverrideConflict: boolean;
  canManagePattern: boolean;
}

/** A shift as the grid view returns it (GET /scheduling). */
export interface GridShift {
  id: string;
  scheduleId: string;
  schedule: {
    id: string;
    name: string;
    status: ScheduleStatus;
    type: ScheduleType;
    scopeType: ScheduleScopeType;
    periodStart: string;
    periodEnd: string;
  };
  employmentAssignmentId: string;
  employee: { id: string; employeeNumber: string; displayName: string | null };
  assignment: {
    id: string;
    isPrimary: boolean;
    employmentType: string;
    position: {
      id: string;
      name: string;
      code: string;
      organizationalUnitId: string | null;
      departmentId: string | null;
      teamId: string | null;
    };
    organization: { id: string; name: string };
  };
  workLocation: { id: string; name: string; code: string; timezone: string | null } | null;
  workDate: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  durationMinutes: number;
  status: ShiftStatus;
  sourceType: ShiftSourceType;
  sourcePatternId: string | null;
  currentRevision: { id: string; revisionNumber: number; revisionType: RevisionType } | null;
  actions: ShiftActions;
}

export interface GridQuery {
  organizationId: string;
  from: string;
  to: string;
  organizationalUnitId?: string;
  departmentId?: string;
  teamId?: string;
  employeeId?: string;
  employmentAssignmentId?: string;
  workLocationId?: string;
  scheduleId?: string;
  status?: ShiftStatus;
  scheduleStatus?: ScheduleStatus;
  sourceType?: ShiftSourceType;
  afterId?: string;
  limit?: number;
}

export interface GridResponse {
  range: { from: string; to: string };
  /** R4-A.6: holidays of the schedules the reader may see (the same on every page). */
  holidays?: ScheduleHolidayMarker[];
  items: GridShift[];
  nextAfterId: string | null;
}

export interface ConflictOverrideInput {
  conflictType: ConflictType;
  conflictKey: string;
  reason: string;
}

export interface ShiftFieldsInput {
  employmentAssignmentId: string;
  workLocationId?: string;
  workDate: string;
  startsAt: string;
  endsAt: string;
  timezone?: string;
}

export interface ShiftCreateInput extends ShiftFieldsInput {
  conflictOverrides?: ConflictOverrideInput[];
}

export type ShiftUpdateInput = Partial<Omit<ShiftFieldsInput, 'workLocationId'>> & {
  workLocationId?: string | null;
  conflictOverrides?: ConflictOverrideInput[];
};

export interface ScheduleConflict {
  key: string;
  type: ConflictType;
  severity: 'WARNING' | 'ERROR';
  overrideAllowed: boolean;
  overridden: boolean;
  overrideId: string | null;
  message: string;
  employeeId: string;
  employmentAssignmentId: string;
  conflictingShift: {
    id: string;
    scheduleId: string | null;
    employmentAssignmentId: string | null;
    workDate: string;
    startsAt: string;
    endsAt: string;
  } | null;
  overlap: { startsAt: string; endsAt: string } | null;
}

export interface ConflictPreview {
  valid: boolean;
  overrideRequired: boolean;
  conflicts: ScheduleConflict[];
}

export interface ShiftRevision {
  id: string;
  scheduledShiftId: string;
  revisionNumber: number;
  revisionType: RevisionType;
  employmentAssignmentId: string;
  workLocationId: string | null;
  workDate: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: ShiftStatus;
  sourceType: ShiftSourceType;
  reason: string | null;
  changedByUserId: string | null;
  changedAt: string;
}

export interface ShiftChangeResult {
  shift: ScheduledShift;
  revision: ShiftRevision;
}

// ─── Templates and recurring patterns ───────────────────────────────────────

export type DayOfWeek =
  'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';

export interface RecurrenceRuleInput {
  weekIndex: number;
  dayOfWeek: DayOfWeek;
  startLocalTime: string;
  endLocalTime: string;
  workLocationId?: string;
  timezone?: string;
  sortOrder?: number;
}

/** A rule edit: omitted fields are unchanged; a null work location means the position default. */
export type RecurrenceRuleUpdateInput = Partial<
  Omit<RecurrenceRuleInput, 'workLocationId' | 'timezone'>
> & { workLocationId?: string | null; timezone?: string | null };

export interface RecurrenceRule {
  id: string;
  weekIndex: number;
  dayOfWeek: DayOfWeek;
  startLocalTime: string;
  endLocalTime: string;
  overnight: boolean;
  workLocationId: string | null;
  timezone: string | null;
  sortOrder: number;
}

export interface ScheduleTemplate {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  rotationWeeks: number;
  archivedAt: string | null;
  ruleCount?: number;
  rules?: RecurrenceRule[];
  createdAt: string;
  updatedAt: string;
}

export interface TemplateInput {
  organizationId: string;
  name: string;
  description?: string;
  rotationWeeks: number;
  rules?: RecurrenceRuleInput[];
}

export interface SchedulePattern {
  id: string;
  employmentAssignmentId: string;
  name: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  rotationWeeks: number;
  anchorDate: string;
  sourceTemplateId: string | null;
  rules: RecurrenceRule[];
  createdAt: string;
  updatedAt: string;
}

export interface PatternPeriodInput {
  name?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  anchorDate: string;
}

/** A pattern edit (only before it starts). A null end date makes the pattern open-ended. */
export interface PatternUpdateInput {
  name?: string | null;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  anchorDate?: string;
  rotationWeeks?: number;
}

export interface PatternInput extends PatternPeriodInput {
  rotationWeeks: number;
  rules: RecurrenceRuleInput[];
}

export interface GenerationIssue {
  patternId: string;
  ruleId: string;
  workDate: string;
  occurrenceKey: string;
  code: string;
  message: string;
  conflictingShiftId?: string;
}

export interface GenerationResult {
  patternId: string;
  employmentAssignmentId: string;
  range: { from: string; to: string };
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  protected: number;
  /** Ids of weekly draft Schedules created for the generated shifts. */
  schedulesCreated: string[];
  blocked: GenerationIssue[];
  errors: GenerationIssue[];
  notices: GenerationIssue[];
}

// ─── Policies and reports ───────────────────────────────────────────────────

export type UnscheduledWorkMode =
  'ALLOW_UNSCHEDULED' | 'WARN_UNSCHEDULED' | 'REQUIRE_SCHEDULED_SHIFT';

export interface SchedulePolicySettings {
  generationHorizonDays: number | null;
  defaultSchedulePeriod: 'WEEKLY' | null;
  autoCreateSchedules: boolean | null;
  unscheduledWorkMode: UnscheduledWorkMode | null;
  clockInEarlyMinutes: number | null;
  clockInLateMinutes: number | null;
  overlapConflictSeverity: 'WARNING' | 'ERROR' | null;
  minimumRestMinutes: number | null;
  maximumShiftDurationMinutes: number | null;
  requireWorkLocation: boolean | null;
  allowManagerConflictOverride: boolean | null;
}

/**
 * A policy edit (R3.1). Only a policy that has not taken effect can be edited; its scope cannot
 * change. A setting sent as null is cleared, so it is inherited again; an omitted one is unchanged.
 */
export type SchedulePolicyUpdateInput = {
  name?: string | null;
  effectiveFrom?: string;
  effectiveTo?: string | null;
} & { [K in keyof SchedulePolicySettings]?: SchedulePolicySettings[K] };

export const POLICY_SETTING_KEYS = [
  'generationHorizonDays',
  'defaultSchedulePeriod',
  'autoCreateSchedules',
  'unscheduledWorkMode',
  'clockInEarlyMinutes',
  'clockInLateMinutes',
  'overlapConflictSeverity',
  'minimumRestMinutes',
  'maximumShiftDurationMinutes',
  'requireWorkLocation',
  'allowManagerConflictOverride',
] as const satisfies readonly (keyof SchedulePolicySettings)[];

export interface SchedulePolicy extends SchedulePolicySettings {
  id: string;
  scopeType: ScheduleScopeType;
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  name: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SchedulePolicyInput = Partial<SchedulePolicySettings> & {
  scopeType: ScheduleScopeType;
  organizationId: string;
  organizationalUnitId?: string;
  departmentId?: string;
  teamId?: string;
  name?: string;
  effectiveFrom: string;
  effectiveTo?: string;
};

export type ResolvedSchedulePolicy = {
  employmentAssignmentId: string;
  date: string;
  sources: Record<string, { policyId: string; scopeType: ScheduleScopeType } | 'DEFAULT'>;
} & { [K in keyof SchedulePolicySettings]: NonNullable<SchedulePolicySettings[K]> };

export const SCHEDULED_HOURS_DIMENSIONS = [
  'organizationalUnit',
  'department',
  'team',
  'employee',
  'employmentAssignment',
  'position',
  'workLocation',
  'workDate',
  'schedule',
  'status',
  'sourceType',
  'organization',
] as const;
export type ScheduledHoursDimension = (typeof SCHEDULED_HOURS_DIMENSIONS)[number];

export interface ScheduledHoursQuery extends Omit<GridQuery, 'afterId' | 'limit'> {
  groupBy: ScheduledHoursDimension;
  afterKey?: string;
  limit?: number;
}

export interface ScheduledHoursGroup {
  /** The dimension value: an id, a date, or an enum value; null when absent. */
  key: string | null;
  shiftCount: number;
  scheduledMinutes: number;
}

export interface ScheduledHoursResponse {
  range: { from: string; to: string };
  groupBy: ScheduledHoursDimension;
  filters: { status: ShiftStatus | null; scheduleStatus: ScheduleStatus | null };
  groups: ScheduledHoursGroup[];
  nextAfterKey: string | null;
}
