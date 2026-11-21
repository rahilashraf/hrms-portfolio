import { Transform, Type } from 'class-transformer';
import {
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
} from 'class-validator';
import {
  BENEFIT_COVERAGE_LEVELS,
  BENEFIT_TYPES,
} from './benefit-plan.service.js';
import { BENEFIT_OPTION_KINDS } from './benefit-options.service.js';
import { BENEFIT_RATE_FREQUENCIES } from './benefit-rate.service.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

/** organizationId query of organization-scoped benefit reads. */
export class BenefitOrganizationQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}

class PlanDescriptionDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 500)
  description?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 200)
  providerName?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 200)
  providerReference?: string | null;

  @IsOptional()
  @IsBoolean()
  employerContributionTaxable?: boolean;

  @IsOptional()
  @IsBoolean()
  showEmployerCostToEmployee?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(99)
  dependentChildMaxAge?: number | null;
}

export class CreateBenefitPlanDto extends PlanDescriptionDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(2, 64)
  code!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsIn(BENEFIT_TYPES)
  benefitType!: (typeof BENEFIT_TYPES)[number];

  @IsString()
  @Length(3, 3)
  currency!: string;

  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  effectiveTo?: string | null;
}

export class UpdateBenefitPlanDto extends PlanDescriptionDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  effectiveFrom?: string;
}

export class CreateBenefitOptionDto {
  @IsString()
  @Length(2, 64)
  code!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsIn(BENEFIT_COVERAGE_LEVELS)
  coverageLevel!: (typeof BENEFIT_COVERAGE_LEVELS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class UpdateBenefitOptionDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

/** Money only as a decimal string ("12.50"): never a JSON number, never floating point. */
const MONEY = /^\d{1,17}(\.\d{1,2})?$/;

export class CreateBenefitRateDto {
  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  effectiveTo?: string | null;

  @IsIn(BENEFIT_RATE_FREQUENCIES)
  frequency!: (typeof BENEFIT_RATE_FREQUENCIES)[number];

  @IsString()
  @Matches(MONEY)
  employeeAmount!: string;

  @IsString()
  @Matches(MONEY)
  employerAmount!: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reason?: string;
}

export class CorrectBenefitRateDto {
  @IsOptional()
  @Matches(DATE_ONLY)
  effectiveFrom?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  effectiveTo?: string | null;

  @IsOptional()
  @IsIn(BENEFIT_RATE_FREQUENCIES)
  frequency?: (typeof BENEFIT_RATE_FREQUENCIES)[number];

  @IsOptional()
  @IsString()
  @Matches(MONEY)
  employeeAmount?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY)
  employerAmount?: string;

  @IsString()
  @Length(1, 2000)
  reason!: string;
}

const EMPLOYMENT_TYPE_VALUES = [
  'FULL_TIME',
  'PART_TIME',
  'CASUAL',
  'CONTRACT',
] as const;

export class CreateEligibilityRuleDto {
  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  effectiveTo?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  organizationalUnitId?: string | null;

  @IsOptional()
  @IsBoolean()
  includeSubunits?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  departmentId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  positionId?: string | null;

  @IsOptional()
  @IsIn(EMPLOYMENT_TYPE_VALUES, { each: true })
  employmentTypes?: Array<(typeof EMPLOYMENT_TYPE_VALUES)[number]>;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(36_500)
  minimumServiceDays?: number | null;
}

export class EndEligibilityRuleDto {
  @Matches(DATE_ONLY)
  effectiveTo!: string;
}

export class BenefitDateQueryDto {
  @IsOptional()
  @Matches(DATE_ONLY)
  date?: string;
}

const RELATIONSHIPS = ['SPOUSE', 'CHILD', 'OTHER'] as const;

class DependentFieldsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  dateOfBirth?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  relationshipStartDate?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  relationshipEndDate?: string | null;
}

export class CreateDependentDto extends DependentFieldsDto {
  @IsString()
  @Length(1, 100)
  firstName!: string;

  @IsString()
  @Length(1, 100)
  lastName!: string;

  @IsIn(RELATIONSHIPS)
  relationship!: (typeof RELATIONSHIPS)[number];
}

export class UpdateDependentDto extends DependentFieldsDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  lastName?: string;

  @IsOptional()
  @IsIn(RELATIONSHIPS)
  relationship?: (typeof RELATIONSHIPS)[number];
}

export class IncludeArchivedQueryDto {
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}

export class AsOfQueryDto {
  @IsOptional()
  @Matches(DATE_ONLY)
  asOf?: string;
}

class ElectionFieldsDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @IsUUID()
  planId!: string;

  @Matches(DATE_ONLY)
  coverageStart!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  coverageEnd?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  electedOn?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reason?: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  eligibilityOverrideReason?: string;
}

export class EnrollDto extends ElectionFieldsDto {
  @IsUUID()
  optionId!: string;

  @IsOptional()
  @IsUUID('all', { each: true })
  dependentIds?: string[];
}

export class WaiveDto extends ElectionFieldsDto {}

export class ChangeElectionDto {
  @Matches(DATE_ONLY)
  effectiveDate!: string;

  @IsOptional()
  @IsUUID()
  optionId?: string;

  @IsOptional()
  @IsUUID('all', { each: true })
  dependentIds?: string[];

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reason?: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  eligibilityOverrideReason?: string;
}

export class EndElectionDto {
  @Matches(DATE_ONLY)
  coverageEnd!: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reason?: string;
}

export class TransferElectionDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @Matches(DATE_ONLY)
  effectiveDate!: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reason?: string;

  /** Batch 7C (C3): when the new sponsor is not eligible on the date. */
  @IsOptional()
  @IsString()
  @Length(1, 2000)
  eligibilityOverrideReason?: string;
}

export class CorrectElectionDto {
  @IsString()
  @Length(1, 2000)
  reason!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  optionId?: string | null;

  @IsOptional()
  @IsUUID('all', { each: true })
  dependentIds?: string[];

  @IsOptional()
  @Matches(DATE_ONLY)
  coverageStart?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  coverageEnd?: string | null;

  @IsOptional()
  @Matches(DATE_ONLY)
  electedOn?: string;

  @IsOptional()
  @IsUUID()
  employmentAssignmentId?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(1, 2000)
  eligibilityOverrideReason?: string | null;
}

export class RescindElectionDto {
  @IsString()
  @Length(1, 2000)
  reason!: string;
}

export class DiscontinuePlanDto {
  @Matches(DATE_ONLY)
  effectiveTo!: string;

  @IsBoolean()
  endElections!: boolean;

  @IsString()
  @Length(1, 2000)
  reason!: string;
}

export class AttentionQueryDto {
  @IsUUID()
  organizationId!: string;
}

/** Batch 7C (C7) — Benefits picker options. */
export class BenefitOptionQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsIn(BENEFIT_OPTION_KINDS)
  kind!: (typeof BENEFIT_OPTION_KINDS)[number];

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsUUID()
  afterId?: string;
}
