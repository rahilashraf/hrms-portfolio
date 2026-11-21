import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  SCHEDULE_STATUSES,
  SCHEDULED_SHIFT_STATUSES,
} from './scheduling.dto.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

/** Grid and self views read a bounded, inclusive workDate range. */
export const MAX_VIEW_RANGE_DAYS = 62;

export class ScheduleRangeQueryDto {
  @IsString()
  @Matches(DATE_ONLY)
  from!: string;

  @IsString()
  @Matches(DATE_ONLY)
  to!: string;
}

export class MyScheduleQueryDto extends ScheduleRangeQueryDto {
  /** Cancelled published shifts are hidden unless asked for. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeCancelled?: boolean;
}

export class ScheduleGridQueryDto extends ScheduleRangeQueryDto {
  @IsUUID()
  organizationId!: string;

  /** Position placement filters; a unit includes its descendant units. */
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

  @IsOptional()
  @IsUUID()
  positionId?: string;

  @IsOptional()
  @IsUUID()
  workLocationId?: string;

  @IsOptional()
  @IsUUID()
  scheduleId?: string;

  @IsOptional()
  @IsIn(SCHEDULED_SHIFT_STATUSES)
  status?: (typeof SCHEDULED_SHIFT_STATUSES)[number];

  @IsOptional()
  @IsIn(['MANUAL', 'PATTERN'])
  sourceType?: 'MANUAL' | 'PATTERN';

  @IsOptional()
  @IsIn(SCHEDULE_STATUSES)
  scheduleStatus?: (typeof SCHEDULE_STATUSES)[number];

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

/** Scheduled-hours report dimensions (each a whitelisted SQL expression, never user SQL). */
export const SCHEDULED_HOURS_DIMENSIONS = [
  'organization',
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
] as const;
export type ScheduledHoursDimension =
  (typeof SCHEDULED_HOURS_DIMENSIONS)[number];

export class ScheduledHoursQueryDto extends ScheduleRangeQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsIn(SCHEDULED_HOURS_DIMENSIONS)
  groupBy!: ScheduledHoursDimension;

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

  @IsOptional()
  @IsUUID()
  positionId?: string;

  @IsOptional()
  @IsUUID()
  workLocationId?: string;

  @IsOptional()
  @IsUUID()
  scheduleId?: string;

  /** Defaults to ACTIVE: cancelled shifts are not expected work unless asked for. */
  @IsOptional()
  @IsIn(SCHEDULED_SHIFT_STATUSES)
  status?: (typeof SCHEDULED_SHIFT_STATUSES)[number];

  @IsOptional()
  @IsIn(['MANUAL', 'PATTERN'])
  sourceType?: 'MANUAL' | 'PATTERN';

  /** Defaults to PUBLISHED (operational expected work); DRAFT reports planning. */
  @IsOptional()
  @IsIn(SCHEDULE_STATUSES)
  scheduleStatus?: (typeof SCHEDULE_STATUSES)[number];

  /** Groups are ordered by key; page with the last key returned. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  afterKey?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
