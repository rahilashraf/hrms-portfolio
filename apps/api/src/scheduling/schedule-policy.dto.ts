import {
  IsBoolean,
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
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SCHEDULE_SCOPE_TYPES,
  SchedulingPageQueryDto,
} from './scheduling.dto.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const SCHEDULE_PERIOD_TYPES = ['WEEKLY'] as const;
export const UNSCHEDULED_WORK_MODES = [
  'ALLOW_UNSCHEDULED',
  'WARN_UNSCHEDULED',
  'REQUIRE_SCHEDULED_SHIFT',
] as const;
export const POLICY_CONFLICT_SEVERITIES = ['WARNING', 'ERROR'] as const;

const nullable = () => ValidateIf((_, value) => value !== null);

/**
 * Policy settings. Omitted means "not set by this policy" (inherited); on update, null clears a
 * setting so it is inherited again.
 */
export class SchedulePolicySettingsDto {
  @nullable()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(366)
  generationHorizonDays?: number | null;

  @nullable()
  @IsOptional()
  @IsIn(SCHEDULE_PERIOD_TYPES)
  defaultSchedulePeriod?: (typeof SCHEDULE_PERIOD_TYPES)[number] | null;

  @nullable()
  @IsOptional()
  @IsBoolean()
  autoCreateSchedules?: boolean | null;

  @nullable()
  @IsOptional()
  @IsIn(UNSCHEDULED_WORK_MODES)
  unscheduledWorkMode?: (typeof UNSCHEDULED_WORK_MODES)[number] | null;

  @nullable()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  clockInEarlyMinutes?: number | null;

  @nullable()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  clockInLateMinutes?: number | null;

  @nullable()
  @IsOptional()
  @IsIn(POLICY_CONFLICT_SEVERITIES)
  overlapConflictSeverity?: (typeof POLICY_CONFLICT_SEVERITIES)[number] | null;

  /** 0 disables the check for this scope even if a broader policy sets one. */
  @nullable()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2880)
  minimumRestMinutes?: number | null;

  @nullable()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2880)
  maximumShiftDurationMinutes?: number | null;

  @nullable()
  @IsOptional()
  @IsBoolean()
  requireWorkLocation?: boolean | null;

  @nullable()
  @IsOptional()
  @IsBoolean()
  allowManagerConflictOverride?: boolean | null;
}

export class CreateSchedulePolicyDto extends SchedulePolicySettingsDto {
  @IsIn(SCHEDULE_SCOPE_TYPES)
  scopeType!: (typeof SCHEDULE_SCOPE_TYPES)[number];

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

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsString()
  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  /** Inclusive; omitted for an open-ended policy. */
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  effectiveTo?: string;
}

/** Only for policies that have not taken effect; scope is immutable. */
export class UpdateSchedulePolicyDto extends SchedulePolicySettingsDto {
  @nullable()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string | null;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  effectiveFrom?: string;

  @nullable()
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  effectiveTo?: string | null;
}

export class EndSchedulePolicyDto {
  @IsString()
  @Matches(DATE_ONLY)
  effectiveTo!: string;
}

export class SchedulePolicyListQueryDto extends SchedulingPageQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsIn(SCHEDULE_SCOPE_TYPES)
  scopeType?: (typeof SCHEDULE_SCOPE_TYPES)[number];

  @IsOptional()
  @IsUUID()
  organizationalUnitId?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;
}

export class ResolveSchedulePolicyQueryDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @IsString()
  @Matches(DATE_ONLY)
  date!: string;
}
