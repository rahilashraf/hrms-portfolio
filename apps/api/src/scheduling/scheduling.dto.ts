import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const SCHEDULE_SCOPE_TYPES = [
  'ORGANIZATION',
  'ORGANIZATIONAL_UNIT',
  'DEPARTMENT',
  'TEAM',
] as const;
export const SCHEDULE_TYPES = ['STANDARD', 'AD_HOC'] as const;
export const SCHEDULE_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
export const SCHEDULED_SHIFT_STATUSES = ['ACTIVE', 'CANCELLED'] as const;
export const SCHEDULE_CONFLICT_TYPES = [
  'SAME_ASSIGNMENT_OVERLAP',
  'EMPLOYEE_ASSIGNMENT_OVERLAP',
  'MINIMUM_REST_VIOLATION',
  'MAXIMUM_SHIFT_DURATION_EXCEEDED',
] as const;

export type ScheduleScopeTypeValue = (typeof SCHEDULE_SCOPE_TYPES)[number];
export type ScheduleTypeValue = (typeof SCHEDULE_TYPES)[number];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const INSTANT_MESSAGE =
  'must be an ISO-8601 timestamp with an explicit Z or ±HH:MM offset';
const CONFLICT_KEY = /^[0-9a-f]{64}$/;
const MAX_CONFLICT_OVERRIDES = 50;

/**
 * Publication state (status, publishedAt, publishedByUserId) is intentionally absent:
 * the global ValidationPipe rejects non-whitelisted properties, so clients cannot set it.
 */
export class CreateScheduleDto {
  @IsIn(SCHEDULE_SCOPE_TYPES)
  scopeType!: ScheduleScopeTypeValue;

  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsUUID()
  organizationalUnitId?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @Matches(DATE_ONLY)
  periodStart!: string;

  @IsString()
  @Matches(DATE_ONLY)
  periodEnd!: string;

  @IsIn(SCHEDULE_TYPES)
  type!: ScheduleTypeValue;
}

/**
 * organizationId is immutable. A scope change must send scopeType together with
 * the hierarchy id it requires; omitted hierarchy ids are cleared.
 */
export class UpdateScheduleDto {
  @IsOptional()
  @IsIn(SCHEDULE_SCOPE_TYPES)
  scopeType?: ScheduleScopeTypeValue;

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
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  periodStart?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  periodEnd?: string;

  @IsOptional()
  @IsIn(SCHEDULE_TYPES)
  type?: ScheduleTypeValue;
}

export class SchedulingPageQueryDto {
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

export class ScheduleListQueryDto extends SchedulingPageQueryDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsIn(SCHEDULE_SCOPE_TYPES)
  scopeType?: ScheduleScopeTypeValue;

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
  @IsIn(SCHEDULE_STATUSES)
  status?: (typeof SCHEDULE_STATUSES)[number];

  @IsOptional()
  @IsIn(SCHEDULE_TYPES)
  type?: ScheduleTypeValue;

  /** Returns schedules whose period overlaps [from, to] (inclusive). */
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  to?: string;
}

/**
 * Explicit approval of one server-computed WARNING conflict. conflictKey must be the key the
 * server returned for a conflict that still exists when the save is re-evaluated; the server
 * never trusts client-computed conflicts.
 */
export class ScheduleConflictOverrideDto {
  @IsIn(SCHEDULE_CONFLICT_TYPES)
  conflictType!: (typeof SCHEDULE_CONFLICT_TYPES)[number];

  @IsString()
  @Matches(CONFLICT_KEY, {
    message: 'conflictKey must be a conflict key returned by the server',
  })
  conflictKey!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/** sourceType (MANUAL) and status (ACTIVE) are server-controlled and not accepted. */
export class ScheduledShiftFieldsDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @IsOptional()
  @IsUUID()
  workLocationId?: string;

  @IsString()
  @Matches(DATE_ONLY)
  workDate!: string;

  @IsString()
  @Matches(INSTANT, { message: `startsAt ${INSTANT_MESSAGE}` })
  startsAt!: string;

  @IsString()
  @Matches(INSTANT, { message: `endsAt ${INSTANT_MESSAGE}` })
  endsAt!: string;

  /** Fallback only; a WorkLocation timezone takes precedence. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  timezone?: string;
}

export class UpdateScheduledShiftFieldsDto {
  @IsOptional()
  @IsUUID()
  employmentAssignmentId?: string;

  /** null removes the WorkLocation. */
  @IsOptional()
  @IsUUID()
  workLocationId?: string | null;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  workDate?: string;

  @IsOptional()
  @IsString()
  @Matches(INSTANT, { message: `startsAt ${INSTANT_MESSAGE}` })
  startsAt?: string;

  @IsOptional()
  @IsString()
  @Matches(INSTANT, { message: `endsAt ${INSTANT_MESSAGE}` })
  endsAt?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  timezone?: string;
}

export class CreateScheduledShiftDto extends ScheduledShiftFieldsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CONFLICT_OVERRIDES)
  @ValidateNested({ each: true })
  @Type(() => ScheduleConflictOverrideDto)
  conflictOverrides?: ScheduleConflictOverrideDto[];
}

export class UpdateScheduledShiftDto extends UpdateScheduledShiftFieldsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CONFLICT_OVERRIDES)
  @ValidateNested({ each: true })
  @Type(() => ScheduleConflictOverrideDto)
  conflictOverrides?: ScheduleConflictOverrideDto[];
}

export class ScheduledShiftListQueryDto extends SchedulingPageQueryDto {
  @IsOptional()
  @IsUUID()
  employmentAssignmentId?: string;

  @IsOptional()
  @IsIn(SCHEDULED_SHIFT_STATUSES)
  status?: (typeof SCHEDULED_SHIFT_STATUSES)[number];

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  to?: string;
}

/**
 * Published changes are explicit and accountable: each one requires a reason, which is stored
 * on the resulting ScheduledShiftRevision.
 */
export class CancelScheduledShiftDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/** Corrects a published ACTIVE shift; unspecified fields keep their current values. */
export class CorrectScheduledShiftDto extends UpdateScheduledShiftDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/** Adds a new, immediately operational shift to a PUBLISHED Schedule. */
export class AddPublishedScheduledShiftDto extends CreateScheduledShiftDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
