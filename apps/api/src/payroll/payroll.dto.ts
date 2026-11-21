import { Transform, Type } from 'class-transformer';
import {
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
export const PAYROLL_CADENCES = [
  'WEEKLY',
  'BIWEEKLY',
  'SEMIMONTHLY',
  'MONTHLY',
] as const;

/** organizationId query of the organization-scoped payroll reads. */
export class PayrollOrganizationQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsUUID()
  payGroupId?: string;
}

class PayrollCalendarRulesDto {
  @IsIn(PAYROLL_CADENCES)
  cadence!: (typeof PAYROLL_CADENCES)[number];

  /** Explicit IANA timezone; never defaulted. */
  @IsString()
  @Length(1, 64)
  timezone!: string;

  @Matches(DATE_ONLY)
  anchorDate!: string;

  @Type(() => Number)
  @IsInt()
  @Min(-31)
  @Max(60)
  payDateOffsetDays!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  processingCutoffOffsetDays!: number;
}

export class CreatePayrollCalendarDto extends PayrollCalendarRulesDto {
  @IsUUID()
  payGroupId!: string;

  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  effectiveTo?: string;
}

/** Replaces the rules of a calendar that has not generated any period yet. */
export class UpdatePayrollCalendarDto extends PayrollCalendarRulesDto {
  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  effectiveTo?: string | null;
}

export class EndPayrollCalendarDto {
  @Matches(DATE_ONLY)
  effectiveTo!: string;
}

export class PayrollPeriodListQueryDto extends PayrollOrganizationQueryDto {
  @IsOptional()
  @Matches(DATE_ONLY)
  from?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  to?: string;
}

export class GeneratePayrollPeriodsDto {
  @IsUUID()
  payGroupId!: string;

  /** Generate every period that starts on or before this date. */
  @Matches(DATE_ONLY)
  throughDate!: string;
}

export const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;
export { Transform };

export class SalaryUnpaidLeaveRuleDto {
  @IsIn(['UNCONFIGURED', 'HOURLY_EQUIVALENT'])
  rule!: 'UNCONFIGURED' | 'HOURLY_EQUIVALENT';

  /** Required for HOURLY_EQUIVALENT: the standard paid hours of a salaried year (e.g. "2080"). */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(/^\d{1,4}(\.\d{1,2})?$/)
  standardAnnualHours?: string | null;
}

export class CreatePayrollRunDto {
  @IsUUID()
  payrollPeriodId!: string;

  @IsString()
  @Length(3, 3)
  currency!: string;
}

export class PayrollRunListQueryDto extends PayrollOrganizationQueryDto {
  @IsOptional()
  @IsUUID()
  payrollPeriodId?: string;
}

/** Money as a string with at most two decimals (the service rejects zero and enforces sign). */
const AMOUNT = /^-?\d{1,12}(\.\d{1,2})?$/;

export class PayrollReasonDto {
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class BenefitResolutionAdjustmentDto {
  @IsString()
  @Length(1, 30)
  amount!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  description?: string;
}

/** Batch 7C (C2) — resolving a benefit-only retro difference explicitly. */
export class ResolveBenefitDifferenceDto extends PayrollReasonDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @IsIn(['ADJUSTED', 'NO_ADJUSTMENT_REQUIRED'])
  outcome!: 'ADJUSTED' | 'NO_ADJUSTMENT_REQUIRED';

  @IsOptional()
  @IsUUID()
  adjustmentId?: string;

  /** Batch 7C: the DEDUCTION adjustment to create with the resolution (atomic). */
  @IsOptional()
  @ValidateNested()
  @Type(() => BenefitResolutionAdjustmentDto)
  adjustment?: BenefitResolutionAdjustmentDto;
}

export class AddManualLineDto {
  @IsUUID()
  payrollRunAssignmentId!: string;

  @IsIn(['EARNING', 'DEDUCTION', 'CONTRIBUTION'])
  kind!: 'EARNING' | 'DEDUCTION' | 'CONTRIBUTION';

  @Matches(AMOUNT)
  amount!: string;

  @IsString()
  @Length(1, 200)
  description!: string;

  @IsString()
  @Length(1, 500)
  reason!: string;

  @IsOptional()
  @IsString()
  @Length(2, 64)
  code?: string;
}

export class ReverseManualLineDto extends PayrollReasonDto {
  @IsIn(['EARNING', 'DEDUCTION', 'CONTRIBUTION'])
  kind!: 'EARNING' | 'DEDUCTION' | 'CONTRIBUTION';
}

export class CreatePayrollAdjustmentDto {
  @IsUUID()
  payGroupId!: string;

  @IsUUID()
  employmentAssignmentId!: string;

  @IsString()
  @Length(3, 3)
  currency!: string;

  @IsIn(['EARNING', 'DEDUCTION'])
  kind!: 'EARNING' | 'DEDUCTION';

  @Matches(AMOUNT)
  amount!: string;

  @IsString()
  @Length(1, 200)
  description!: string;

  @IsString()
  @Length(1, 500)
  reason!: string;

  @IsOptional()
  @IsUUID()
  sourceRunId?: string;
}

export class PayrollAdjustmentListQueryDto extends PayrollOrganizationQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'APPLIED', 'CANCELLED'])
  status?: 'PENDING' | 'APPLIED' | 'CANCELLED';

  @IsOptional()
  @IsUUID()
  sourceRunId?: string;

  @IsOptional()
  @IsUUID()
  payrollRunId?: string;
}
