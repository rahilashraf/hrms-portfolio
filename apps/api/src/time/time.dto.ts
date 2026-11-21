import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  IsInt,
  Min,
  Max,
  ValidateIf,
} from 'class-validator';

/**
 * A local date and time as typed (YYYY-MM-DDTHH:mm[:ss]), optionally with the UTC offset that
 * selects one occurrence of a time repeated by a daylight-saving overlap (Batch 4D, D-C).
 */
const LOCAL_DATE_TIME_INPUT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/;

export const TIME_CORRECTION_TYPES = [
  'ADD_MISSING_CLOCK_IN',
  'ADD_MISSING_CLOCK_OUT',
  'CHANGE_CLOCK_IN',
  'CHANGE_CLOCK_OUT',
  'CHANGE_BREAK_START',
  'CHANGE_BREAK_END',
  'ADD_BREAK',
  'REMOVE_BREAK',
  'CHANGE_ASSIGNMENT',
  'ADD_MISSING_TIME_ENTRY',
  'CHANGE_COVERAGE',
] as const;

export class ClockInDto {
  /**
   * Optional once schedules are integrated: an unambiguous scheduled shift preselects its
   * assignment. An explicit assignment is always honoured.
   */
  @IsOptional()
  @IsUUID()
  employmentAssignmentId?: string;

  /**
   * Other assignments the same physical interval also covers (multi-assignment attendance).
   * `employmentAssignmentId` is then required: it is the payroll owner; these add no time.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9)
  @IsUUID('all', { each: true })
  additionalEmploymentAssignmentIds?: string[];

  /** An explicit choice among several eligible published shifts. */
  @IsOptional()
  @IsUUID()
  scheduledShiftId?: string;
}

export class SwitchAssignmentDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @IsOptional()
  @IsUUID()
  scheduledShiftId?: string;
}

export class LinkScheduledShiftDto {
  /** The published shift to interpret the entry against, or an explicit null to unlink it. */
  @ValidateIf((dto: LinkScheduledShiftDto) => dto.scheduledShiftId !== null)
  @IsUUID()
  scheduledShiftId!: string | null;

  @IsString()
  @MinLength(1)
  reason!: string;
}

export class ResolveMissedClockOutDto {
  @IsString()
  @Matches(LOCAL_DATE_TIME_INPUT)
  clockOutAt!: string;
}

export class CreateTimeCorrectionRequestDto {
  @IsIn(TIME_CORRECTION_TYPES)
  type!: (typeof TIME_CORRECTION_TYPES)[number];

  @IsString()
  @MinLength(1)
  reason!: string;

  @IsOptional()
  @IsUUID()
  timeEntryId?: string;

  @IsOptional()
  @IsUUID()
  breakEntryId?: string;

  @IsOptional()
  @IsUUID()
  employmentAssignmentId?: string;

  @IsOptional()
  @IsUUID()
  targetEmploymentAssignmentId?: string;

  /** CHANGE_COVERAGE: the complete set of non-owner assignments the entry covers. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9)
  @IsUUID('all', { each: true })
  additionalEmploymentAssignmentIds?: string[];

  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE_TIME_INPUT)
  clockInAt?: string;

  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE_TIME_INPUT)
  clockOutAt?: string;

  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE_TIME_INPUT)
  breakStartAt?: string;

  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE_TIME_INPUT)
  breakEndAt?: string;

  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE_TIME_INPUT)
  startAt?: string;

  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE_TIME_INPUT)
  endAt?: string;
}

export class ReviewTimeCorrectionDto {
  @IsOptional()
  @IsString()
  reviewerNote?: string;
}

export class DirectTimeCorrectionDto extends CreateTimeCorrectionRequestDto {}

/** Phase 9.5 — a manager records a missing entry directly (local times in the assignment zone). */
export class AddTimeEntryDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @IsString()
  @Matches(LOCAL_DATE_TIME_INPUT)
  startAt!: string;

  @IsString()
  @Matches(LOCAL_DATE_TIME_INPUT)
  endAt!: string;

  @IsString()
  @MinLength(1)
  reason!: string;
}

export class TimesheetReviewDto {
  @IsOptional()
  @IsString()
  note?: string;
}

/** Batch 4A: the minutes the reviewer saw; a mismatch answers 409 TIMESHEET_SEGMENT_CHANGED. */
export class ApproveTimesheetSegmentDto extends TimesheetReviewDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedNetWorkedMinutes?: number;

  /** Batch 4C: the timesheet version the reviewer saw; a mismatch answers 409. */
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

/** Batch 4A: the timesheet version the caller saw; a mismatch answers 409. */
export class TimesheetVersionDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

/** Reopening needs a reason (checked by the service: 400 TIMESHEET_REASON_REQUIRED). */
export class ReopenTimesheetDto extends TimesheetReviewDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

/**
 * Batch 4E-3 (C3) — POST /time/me/timesheets/:id/submit: the totals and version the employee
 * reviewed. Both optional (older clients send nothing); when sent and stale, 409
 * TIMESHEET_TOTALS_CHANGED and nothing is submitted.
 */
export class SubmitOwnTimesheetDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedNetWorkedMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class SubmitTimesheetOnBehalfDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}

export class GenerateTimePeriodsDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate!: string;

  @IsIn(['WEEKLY', 'BIWEEKLY', 'MONTHLY'])
  cadence!: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(26)
  count?: number;
}

/** 'true' / 'false' query strings as booleans. */
const queryBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * Batch 4F (C10): history of organizations with Time & attendance disabled. Opt-in; only
 * changes what the caller's existing grants may read, never what they may do.
 */
export class HistoricalReadQueryDto {
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  includeDisabledOrganizations?: boolean;
}

export class TimeListQueryDto extends HistoricalReadQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate?: string;

  @IsOptional()
  @IsUUID()
  afterId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * Batch 4E-1 (G1): only this organization's records. Applied in the query, inside the
   * reader's authorized organizations (another organization answers an empty page).
   */
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  /** Batch 4E-1 (G1): only this employee's records. */
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class TimeEntriesQueryDto extends TimeListQueryDto {
  @IsOptional()
  @IsIn(['OPEN', 'CLOSED', 'VOIDED'])
  status?: 'OPEN' | 'CLOSED' | 'VOIDED';
}

/** Batch 4E-3 (C4) — GET /time/me/exceptions (paged; the caller's own exceptions only). */
export class SelfExceptionsQueryDto {
  @IsOptional()
  @IsIn(['OPEN', 'RESOLVED', 'DISMISSED', 'SUPERSEDED'])
  status?: 'OPEN' | 'RESOLVED' | 'DISMISSED' | 'SUPERSEDED';

  @IsOptional()
  @IsUUID()
  afterId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Batch 4E-3 (C4) — GET /time/me/corrections (paged; the caller's own requests only). */
export class SelfCorrectionsQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

  @IsOptional()
  @IsUUID()
  afterId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class TimeCurrentQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  /** Batch 4E-1 (G1). */
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  /** Batch 4E-1 (G1). */
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsUUID()
  afterId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class TimeExceptionsQueryDto extends TimeListQueryDto {
  @IsOptional()
  @IsIn([
    'MISSING_CLOCK_OUT',
    'AUTO_CLOSED_CLOCK_OUT',
    'OPEN_BREAK_AUTO_CLOSED',
    'LONG_SHIFT',
    'LATE_ARRIVAL',
    'EARLY_DEPARTURE',
    'UNSCHEDULED_WORK',
    'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
    // Batch 4E-1: every type the review queue shows can be filtered on.
    'LATE_SIGN_IN',
    'UNSCHEDULED_SIGN_IN',
    'RECORDED_AFTER_APPROVAL',
    'NO_SHOW',
  ])
  type?:
    | 'MISSING_CLOCK_OUT'
    | 'AUTO_CLOSED_CLOCK_OUT'
    | 'OPEN_BREAK_AUTO_CLOSED'
    | 'LONG_SHIFT'
    | 'LATE_ARRIVAL'
    | 'EARLY_DEPARTURE'
    | 'UNSCHEDULED_WORK'
    | 'SCHEDULE_CHANGED_AFTER_ATTENDANCE'
    | 'LATE_SIGN_IN'
    | 'UNSCHEDULED_SIGN_IN'
    | 'RECORDED_AFTER_APPROVAL'
    | 'NO_SHOW';

  @IsOptional()
  @IsIn(['INFO', 'REVIEW', 'ACTION_REQUIRED'])
  severity?: 'INFO' | 'REVIEW' | 'ACTION_REQUIRED';

  @IsOptional()
  @IsIn(['NON_BLOCKING', 'SUBMISSION_BLOCKING'])
  workflowImpact?: 'NON_BLOCKING' | 'SUBMISSION_BLOCKING';

  @IsOptional()
  @IsIn(['OPEN', 'RESOLVED', 'DISMISSED', 'SUPERSEDED'])
  status?: 'OPEN' | 'RESOLVED' | 'DISMISSED' | 'SUPERSEDED';
}

export class TimeCorrectionsQueryDto extends TimeListQueryDto {
  @IsOptional()
  @IsIn(TIME_CORRECTION_TYPES)
  type?: (typeof TIME_CORRECTION_TYPES)[number];

  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'SUPERSEDED'])
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'SUPERSEDED';
}

export class TimeTimesheetsQueryDto extends TimeListQueryDto {
  @IsOptional()
  @IsIn(['OPEN', 'SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED', 'LOCKED'])
  status?: 'OPEN' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'APPROVED' | 'LOCKED';

  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'CHANGES_REQUESTED'])
  segmentStatus?: 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED';

  /** Batch 4E-1 (G1): only this time period's timesheets. */
  @IsOptional()
  @IsUUID()
  timePeriodId?: string;
}

/** Batch 4C — GET /time/periods. */
export class TimePeriodsQueryDto extends HistoricalReadQueryDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  /** Periods ending on or after this date. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  /** Periods starting on or before this date. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @IsIn(['UPCOMING', 'OPEN', 'CLOSED', 'LOCKED'])
  status?: 'UPCOMING' | 'OPEN' | 'CLOSED' | 'LOCKED';

  @IsOptional()
  @IsUUID()
  afterId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Batch 4C — resolving or dismissing an attendance exception: a required note. */
export class ReviewAttendanceExceptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  note!: string;
}

/** Scheduled-vs-actual reads at most this many workDates per request. */
export const MAX_VARIANCE_RANGE_DAYS = 31;

export class ScheduledVsActualQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to!: string;

  @IsOptional()
  @IsUUID()
  organizationalUnitId?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsUUID()
  employmentAssignmentId?: string;

  /** Rows are ordered by "workDate|employmentAssignmentId"; page with the last key. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}\|[0-9a-f-]{36}$/)
  afterKey?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

// ─── Phase 9.5: time policy administration ──────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class TimePolicyListQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeArchived?: boolean;
}

/** One effective-dated policy layer; `config` is strictly validated (time-policy.ts). */
export class CreateTimePolicyDto {
  @IsIn([
    'SYSTEM',
    'ORGANIZATION',
    'ORGANIZATIONAL_UNIT',
    'DEPARTMENT',
    'TEAM',
    'EMPLOYMENT_ASSIGNMENT',
  ])
  scopeType!:
    | 'SYSTEM'
    | 'ORGANIZATION'
    | 'ORGANIZATIONAL_UNIT'
    | 'DEPARTMENT'
    | 'TEAM'
    | 'EMPLOYMENT_ASSIGNMENT';

  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsUUID()
  organizationalUnitId?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsUUID()
  employmentAssignmentId?: string;

  @IsOptional()
  @IsIn(['INHERIT', 'OVERRIDE'])
  inheritanceMode?: 'INHERIT' | 'OVERRIDE';

  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  effectiveTo?: string;

  @IsObject()
  config!: Record<string, unknown>;
}

/** Batch 4E-2 (B3) — POST /time/policies/:id/supersede. */
export class SupersedeTimePolicyDto {
  /** The replacement's first day; the current layer ends the day before. */
  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  @IsOptional()
  @IsIn(['INHERIT', 'OVERRIDE'])
  inheritanceMode?: 'INHERIT' | 'OVERRIDE';

  @IsObject()
  config!: Record<string, unknown>;

  /** The current layer's `updatedAt` as the administrator saw it (409 TIME_POLICY_CHANGED). */
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  expectedUpdatedAt!: string;
}

export class EndTimePolicyDto {
  @Matches(DATE_ONLY)
  effectiveTo!: string;
}

// ─── Phase 9.5: sign-ins ────────────────────────────────────────────────────

const LOCAL_DATE_TIME = LOCAL_DATE_TIME_INPUT;

export class SignInDto {
  @IsUUID()
  employmentAssignmentId!: string;

  /** Per-interaction key: a retried submission returns the first sign-in. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,100}$/)
  idempotencyKey?: string;
}

/**
 * Batch 4E-3 (C7) — POST /time/me/sign-in: optionally the occurrence being confirmed (one of the
 * caller's own published shifts open for sign-in now). Without it, the nearest open one is
 * matched as before.
 */
export class SelfSignInDto extends SignInDto {
  @IsOptional()
  @IsUUID()
  scheduledShiftId?: string;
}

export class SignInRangeQueryDto {
  @IsOptional()
  @Matches(DATE_ONLY)
  from?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  to?: string;
}

export class ManagedSignInsQueryDto extends SignInRangeQueryDto {
  @IsUUID()
  organizationId!: string;

  /** Batch 4F (C10): read the history of an organization with Time & attendance disabled. */
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  includeDisabledOrganizations?: boolean;

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeVoided?: boolean;
}

export class ExpectedSignInsQueryDto extends SignInRangeQueryDto {
  @IsUUID()
  organizationId!: string;
}

export class RecordSignInDto {
  @IsUUID()
  employmentAssignmentId!: string;

  /** Local date-time in the assignment's timezone. */
  @Matches(LOCAL_DATE_TIME)
  signedInAt!: string;

  @IsString()
  @MinLength(1)
  reason!: string;

  @IsOptional()
  @IsUUID()
  scheduledShiftId?: string;
}

/** Batch 4D (D-H): a manager's sign-out record (local time, typed; a reason). */
export class RecordSignOutDto {
  @Matches(LOCAL_DATE_TIME)
  signedOutAt!: string;

  @IsString()
  @MinLength(1)
  reason!: string;
}

export class VoidSignInDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}

export class CorrectSignInDto {
  @IsOptional()
  @Matches(LOCAL_DATE_TIME)
  signedInAt?: string;

  @IsOptional()
  @IsUUID()
  employmentAssignmentId?: string;

  /** A shift to link, or null to record it as unscheduled; omitted keeps the current link. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  scheduledShiftId?: string | null;

  @IsString()
  @MinLength(1)
  reason!: string;
}

/** Batch 4E-2 (B1) — GET /time/policies/effective. */
export class EffectivePolicyQueryDto {
  @IsUUID()
  employmentAssignmentId!: string;

  /** The work date (YYYY-MM-DD); today in the assignment's time zone when absent. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}

/**
 * Batch 4E-2 review — GET /time/policies/inherited: what a layer at this scope inherits on a
 * date (the policy editor's hints). One scope id, as for a new layer; no SYSTEM scope (D4).
 */
export class InheritedPolicyQueryDto {
  @IsIn([
    'ORGANIZATION',
    'ORGANIZATIONAL_UNIT',
    'DEPARTMENT',
    'TEAM',
    'EMPLOYMENT_ASSIGNMENT',
  ])
  scopeType!:
    | 'ORGANIZATION'
    | 'ORGANIZATIONAL_UNIT'
    | 'DEPARTMENT'
    | 'TEAM'
    | 'EMPLOYMENT_ASSIGNMENT';

  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsUUID()
  organizationalUnitId?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsUUID()
  employmentAssignmentId?: string;

  /** The layer's first day (YYYY-MM-DD). */
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date!: string;
}

/** Batch 4E-2 (B4) — GET /time/manage/assignment-attendance. */
export class AssignmentAttendanceQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @IsOptional()
  @IsUUID()
  afterId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
