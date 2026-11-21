import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';
import {
  MAX_ROTATION_WEEKS,
  SCHEDULE_DAYS_OF_WEEK,
} from './schedule-recurrence.js';
import { SchedulingPageQueryDto } from './scheduling.dto.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_TIME_MESSAGE = 'must be a local time in HH:mm format';
const MAX_RULES = 200;

type DayOfWeek = (typeof SCHEDULE_DAYS_OF_WEEK)[number];

/**
 * One recurring local wall-clock interval. weekIndex is 0-based within the rotation.
 * endLocalTime at or before startLocalTime ends on the following local day (overnight).
 * The timezone is a fallback used only when the WorkLocation has none.
 */
export class RecurrenceRuleDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_ROTATION_WEEKS - 1)
  weekIndex!: number;

  @IsIn(SCHEDULE_DAYS_OF_WEEK)
  dayOfWeek!: DayOfWeek;

  @IsString()
  @Matches(LOCAL_TIME, { message: `startLocalTime ${LOCAL_TIME_MESSAGE}` })
  startLocalTime!: string;

  @IsString()
  @Matches(LOCAL_TIME, { message: `endLocalTime ${LOCAL_TIME_MESSAGE}` })
  endLocalTime!: string;

  @IsOptional()
  @IsUUID()
  workLocationId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  timezone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

/** Unspecified fields keep their values; null clears workLocationId or timezone. */
export class UpdateRecurrenceRuleDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_ROTATION_WEEKS - 1)
  weekIndex?: number;

  @IsOptional()
  @IsIn(SCHEDULE_DAYS_OF_WEEK)
  dayOfWeek?: DayOfWeek;

  @IsOptional()
  @IsString()
  @Matches(LOCAL_TIME, { message: `startLocalTime ${LOCAL_TIME_MESSAGE}` })
  startLocalTime?: string;

  @IsOptional()
  @IsString()
  @Matches(LOCAL_TIME, { message: `endLocalTime ${LOCAL_TIME_MESSAGE}` })
  endLocalTime?: string;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsUUID()
  workLocationId?: string | null;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  timezone?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class CreateScheduleTemplateDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ROTATION_WEEKS)
  rotationWeeks!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RULES)
  @ValidateNested({ each: true })
  @Type(() => RecurrenceRuleDto)
  rules?: RecurrenceRuleDto[];
}

/** organizationId is immutable. */
export class UpdateScheduleTemplateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ROTATION_WEEKS)
  rotationWeeks?: number;
}

export class ScheduleTemplateListQueryDto extends SchedulingPageQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeArchived?: boolean;
}

class PatternPeriodDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsString()
  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  /** Inclusive; omitted for an open-ended pattern. */
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  effectiveTo?: string;

  /** A Monday: the first day of rotation week 0. */
  @IsString()
  @Matches(DATE_ONLY)
  anchorDate!: string;
}

/** A pattern defined directly on an assignment, without a template. */
export class CreateSchedulePatternDto extends PatternPeriodDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ROTATION_WEEKS)
  rotationWeeks!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RULES)
  @ValidateNested({ each: true })
  @Type(() => RecurrenceRuleDto)
  rules!: RecurrenceRuleDto[];
}

/** Copies a template's rotation and rules into a new pattern; nothing is inherited live. */
export class ApplyScheduleTemplateDto extends PatternPeriodDto {
  @IsUUID()
  templateId!: string;
}

/** Only for patterns that have not started yet; started patterns can only be ended. */
export class UpdateSchedulePatternDto {
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string | null;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  effectiveFrom?: string;

  /** null makes the pattern open-ended. */
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  effectiveTo?: string | null;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  anchorDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ROTATION_WEEKS)
  rotationWeeks?: number;
}

export class EndSchedulePatternDto {
  /** The last day (inclusive) the pattern applies. */
  @IsString()
  @Matches(DATE_ONLY)
  effectiveTo!: string;
}

/** Both optional: the range defaults to today through the rolling generation horizon. */
export class GenerateScheduledShiftsDto {
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  to?: string;
}
