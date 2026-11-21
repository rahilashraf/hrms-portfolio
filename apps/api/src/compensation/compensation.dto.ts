import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  Matches,
  ValidateIf,
} from 'class-validator';
import { PAY_BASES, SALARY_ARRANGEMENTS } from './compensation-domain.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

/**
 * Money is accepted only as a decimal string ("24.50"): a JSON number is rejected rather than
 * converted, so binary floating point never touches a rate.
 */
class CompensationValuesDto {
  @IsIn(PAY_BASES)
  payBasis!: (typeof PAY_BASES)[number];

  @IsString()
  @Length(1, 32)
  rateAmount!: string;

  @IsOptional()
  @IsIn(SALARY_ARRANGEMENTS)
  salaryArrangement?: (typeof SALARY_ARRANGEMENTS)[number];

  @IsOptional()
  @IsString()
  @Length(1, 32)
  salaryMonthlyAmount?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  salaryPaidMonths?: number;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  salaryContractAmount?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  salaryPeriodStart?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  salaryPeriodEnd?: string;

  @IsString()
  @Length(3, 3)
  currency!: string;

  /** Optional pay group of the organization; null for none. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  payGroupId?: string | null;
}

export class CreateCompensationDto extends CompensationValuesDto {
  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  effectiveTo?: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reason?: string;
}

export class ChangeCompensationDto extends CompensationValuesDto {
  @Matches(DATE_ONLY)
  effectiveFrom!: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reason?: string;
}

/** Only the fields to correct; anything omitted keeps the corrected record's value. */
export class CorrectCompensationDto {
  @IsOptional()
  @IsIn(PAY_BASES)
  payBasis?: (typeof PAY_BASES)[number];

  @IsOptional()
  @IsString()
  @Length(1, 32)
  rateAmount?: string;

  @IsOptional()
  @IsIn(SALARY_ARRANGEMENTS)
  salaryArrangement?: (typeof SALARY_ARRANGEMENTS)[number];

  @IsOptional()
  @IsString()
  @Length(1, 32)
  salaryMonthlyAmount?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  salaryPaidMonths?: number;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  salaryContractAmount?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  salaryPeriodStart?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  salaryPeriodEnd?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  payGroupId?: string | null;

  @IsOptional()
  @Matches(DATE_ONLY)
  effectiveFrom?: string;

  /** A date, or null for open-ended. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  effectiveTo?: string | null;

  @IsString()
  @Length(1, 2000)
  reason!: string;
}

export class EndCompensationDto {
  /** Last day (inclusive) of the period. */
  @Matches(DATE_ONLY)
  effectiveTo!: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reason?: string;
}

export class CompensationDateQueryDto {
  @IsOptional()
  @Matches(DATE_ONLY)
  date?: string;
}

export class CompensationAsOfQueryDto {
  @Matches(DATE_ONLY)
  date!: string;
}

export class PayGroupListQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @Transform(toBoolean)
  includeArchived?: boolean;
}

export class CreatePayGroupDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(2, 64)
  code!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;
}

export class UpdatePayGroupDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;
}
