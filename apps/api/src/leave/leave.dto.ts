import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export const LEAVE_CLASSIFICATIONS = ['PAID', 'UNPAID'] as const;
export const LEAVE_DISPLAY_UNITS = ['HOURS', 'DAYS'] as const;
export const LEAVE_POLICY_SCOPE_TYPES = [
  'ORGANIZATION',
  'ORGANIZATIONAL_UNIT',
  'DEPARTMENT',
  'TEAM',
  'EMPLOYMENT_ASSIGNMENT',
] as const;
export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CASUAL',
  'CONTRACT',
] as const;
export const WEEKDAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;
export const LEAVE_AMOUNT_SOURCES = [
  'SCHEDULE_THEN_STANDARD',
  'STANDARD_ONLY',
] as const;
export const LEAVE_ACCRUAL_METHODS = [
  'NONE',
  'ANNUAL_GRANT',
  'PERIODIC',
] as const;
export const LEAVE_ACCRUAL_FREQUENCIES = [
  'MONTHLY',
  'SEMI_MONTHLY',
  'BIWEEKLY',
] as const;
export const LEAVE_CARRYOVER_MODES = ['NONE', 'CAPPED', 'UNLIMITED'] as const;
export const LEAVE_REQUEST_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;

/** A single request may span at most this many local dates. */
export const MAX_LEAVE_REQUEST_DAYS = 366;
/** Calendar and report reads span at most this many dates. */
export const MAX_LEAVE_VIEW_DAYS = 93;

// ─── Leave types ─────────────────────────────────────────────────────────────

export class CreateLeaveTypeDto {
  @IsUUID()
  organizationId!: string;

  @Transform(({ value }) =>
    typeof value === 'string'
      ? value.trim().replace(/\s+/g, '-').toUpperCase()
      : value,
  )
  @IsString()
  @Length(2, 64)
  @Matches(/^[A-Z0-9_-]+$/)
  code!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsIn(LEAVE_CLASSIFICATIONS)
  classification!: (typeof LEAVE_CLASSIFICATIONS)[number];

  @IsOptional()
  @IsBoolean()
  tracksBalance?: boolean;

  @IsOptional()
  @IsIn(LEAVE_DISPLAY_UNITS)
  displayUnit?: (typeof LEAVE_DISPLAY_UNITS)[number];
}

export class UpdateLeaveTypeDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsIn(LEAVE_DISPLAY_UNITS)
  displayUnit?: (typeof LEAVE_DISPLAY_UNITS)[number];
}

export class LeaveTypeListQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}

// ─── Leave policies ──────────────────────────────────────────────────────────

/** Every policy setting; omitted settings take the documented defaults on create. */
export class LeavePolicySettingsDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(EMPLOYMENT_TYPES, { each: true })
  employmentTypes?: (typeof EMPLOYMENT_TYPES)[number][];

  @IsOptional()
  @IsBoolean()
  eligible?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3660)
  waitingPeriodDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  leaveYearStartMonth?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(28)
  leaveYearStartDay?: number;

  @IsOptional()
  @IsIn(LEAVE_AMOUNT_SOURCES)
  amountSource?: (typeof LEAVE_AMOUNT_SOURCES)[number];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  standardWorkdayMinutes?: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(WEEKDAYS, { each: true })
  standardWorkdays?: (typeof WEEKDAYS)[number][];

  @IsOptional()
  @IsBoolean()
  excludeHolidays?: boolean;

  @IsOptional()
  @IsBoolean()
  allowPartialDay?: boolean;

  @IsOptional()
  @IsIn(LEAVE_ACCRUAL_METHODS)
  accrualMethod?: (typeof LEAVE_ACCRUAL_METHODS)[number];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(527040)
  annualGrantMinutes?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn(LEAVE_ACCRUAL_FREQUENCIES)
  accrualFrequency?: (typeof LEAVE_ACCRUAL_FREQUENCIES)[number] | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(44640)
  accrualMinutesPerPeriod?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(DATE_ONLY)
  accrualAnchorDate?: string | null;

  @IsOptional()
  @IsBoolean()
  prorateFirstYear?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(527040)
  maxBalanceMinutes?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(527040)
  negativeBalanceLimitMinutes?: number;

  @IsOptional()
  @IsIn(LEAVE_CARRYOVER_MODES)
  carryoverMode?: (typeof LEAVE_CARRYOVER_MODES)[number];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(527040)
  carryoverMaxMinutes?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(3660)
  carryoverExpiryDays?: number | null;

  @IsOptional()
  @IsBoolean()
  employeeMayCancelApprovedFuture?: boolean;
}

export class CreateLeavePolicyDto extends LeavePolicySettingsDto {
  @IsUUID()
  leaveTypeId!: string;

  @IsUUID()
  organizationId!: string;

  @IsIn(LEAVE_POLICY_SCOPE_TYPES)
  scopeType!: (typeof LEAVE_POLICY_SCOPE_TYPES)[number];

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

  @IsString()
  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  effectiveTo?: string;
}

export class UpdateLeavePolicyDto extends LeavePolicySettingsDto {
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  effectiveFrom?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(DATE_ONLY)
  effectiveTo?: string | null;
}

export class EndLeavePolicyDto {
  @IsString()
  @Matches(DATE_ONLY)
  effectiveTo!: string;
}

export class LeavePolicyListQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsUUID()
  leaveTypeId?: string;
}

export class ResolveLeavePolicyQueryDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @IsUUID()
  leaveTypeId!: string;

  @IsString()
  @Matches(DATE_ONLY)
  date!: string;
}

// ─── Requests ────────────────────────────────────────────────────────────────

export class LeaveRequestInputDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @IsUUID()
  leaveTypeId!: string;

  @IsString()
  @Matches(DATE_ONLY)
  startDate!: string;

  @IsString()
  @Matches(DATE_ONLY)
  endDate!: string;

  /** Partial day: both times on a single-date request, local to the assignment. */
  @IsOptional()
  @IsString()
  @Matches(LOCAL_TIME)
  startLocalTime?: string;

  @IsOptional()
  @IsString()
  @Matches(LOCAL_TIME)
  endLocalTime?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  reason?: string;
}

export class CreateLeaveOnBehalfDto extends LeaveRequestInputDto {
  /** Approve in the same step (requires leave.approve; never for oneself). */
  @IsOptional()
  @IsBoolean()
  approve?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  note?: string;
}

export class LeaveDayOverrideDto {
  @IsString()
  @Matches(DATE_ONLY)
  date!: string;

  @IsInt()
  @Min(0)
  @Max(1440)
  minutes!: number;

  @IsString()
  @Length(1, 1000)
  reason!: string;
}

export class ApproveLeaveDto {
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LeaveDayOverrideDto)
  dayOverrides?: LeaveDayOverrideDto[];
}

export class RejectLeaveDto {
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  note?: string;
}

/** Cancels all remaining days, the listed dates, or every date from cancelFrom onwards. */
export class AmendLeaveDto {
  @IsString()
  @Length(1, 2000)
  reason!: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(DATE_ONLY, { each: true })
  cancelDates?: string[];

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  cancelFrom?: string;
}

export class CancelOwnLeaveDto {
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  reason?: string;
}

export class LeaveRequestListQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsIn(LEAVE_REQUEST_STATUSES)
  status?: (typeof LEAVE_REQUEST_STATUSES)[number];

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsUUID()
  leaveTypeId?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  to?: string;

  @IsOptional()
  @IsUUID()
  afterId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class MyLeaveRequestsQueryDto {
  @IsOptional()
  @IsIn(LEAVE_REQUEST_STATUSES)
  status?: (typeof LEAVE_REQUEST_STATUSES)[number];

  @IsOptional()
  @IsUUID()
  afterId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

// ─── Balances / ledger ───────────────────────────────────────────────────────

export class LeaveAdjustmentDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @IsUUID()
  leaveTypeId!: string;

  @IsInt()
  @Min(-527040)
  @Max(527040)
  amountMinutes!: number;

  @IsString()
  @Matches(DATE_ONLY)
  effectiveDate!: string;

  @IsString()
  @Length(1, 2000)
  reason!: string;

  /** Client-supplied retry key: a repeated submission posts nothing new. */
  @IsOptional()
  @IsString()
  @Length(8, 100)
  @Matches(/^[A-Za-z0-9_-]+$/)
  idempotencyKey?: string;
}

export class ReverseLedgerEntryDto {
  @IsString()
  @Length(1, 2000)
  reason!: string;
}

export class LeaveBalanceQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsUUID()
  leaveTypeId?: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  asOf?: string;

  @IsOptional()
  @IsUUID()
  afterId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class LeaveCalendarQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Matches(DATE_ONLY)
  from!: string;

  @IsString()
  @Matches(DATE_ONLY)
  to!: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includePending?: boolean;
}

/** Batch 6B: a date range for the employee team calendar and holiday reads. */
export class LeaveSelfRangeQueryDto {
  @IsString()
  @Matches(DATE_ONLY)
  from!: string;

  @IsString()
  @Matches(DATE_ONLY)
  to!: string;
}
