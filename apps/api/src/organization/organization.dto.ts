import { isIanaTimezone } from '../common/timezone.js';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'teamPlacementXor', async: false })
class TeamPlacementXorConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const input = args.object as TeamCreateDto | TeamUpdateDto;
    return (
      Number(Boolean(input.departmentId)) +
        Number(Boolean(input.organizationalUnitId)) ===
      1
    );
  }

  defaultMessage() {
    return 'Exactly one of departmentId or organizationalUnitId must be provided.';
  }
}

@ValidatorConstraint({ name: 'positionPlacementLimit', async: false })
class PositionPlacementLimitConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    const input = args.object as PositionCreateDto | PositionUpdateDto;
    return (
      Number(Boolean(input.organizationalUnitId)) +
        Number(Boolean(input.departmentId)) +
        Number(Boolean(input.teamId)) <=
      1
    );
  }

  defaultMessage() {
    return 'At most one position placement anchor may be provided.';
  }
}

@ValidatorConstraint({ name: 'ianaTimezone', async: false })
class IanaTimezoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (typeof value !== 'string' || value.trim() === '') return true;
    // Batch 4D (D-A): the same rule as every other module.
    return isIanaTimezone(value);
  }

  defaultMessage() {
    return 'timezone must be a valid IANA time zone.';
  }
}

export function normalizeCodeValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, '-').toUpperCase();
}

export class OrganizationCodeDto {
  @Transform(({ value }) => normalizeCodeValue(value))
  @IsString()
  @Length(2, 64)
  @Matches(/^[A-Z0-9_-]+$/)
  code!: string;
}

export class OrganizationCreateDto extends OrganizationCodeDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;

  /** IANA timezone used for organization-wide local dates (leave, holidays). */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Validate(IanaTimezoneConstraint)
  timezone?: string;
}

export class OrganizationUpdateDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;

  /** IANA timezone used for organization-wide local dates (leave, holidays). */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Validate(IanaTimezoneConstraint)
  timezone?: string;
}

export class OrganizationalUnitCreateDto extends OrganizationCodeDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  parentUnitId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class OrganizationalUnitUpdateDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  parentUnitId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class DepartmentCreateDto extends OrganizationCodeDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  organizationalUnitId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class DepartmentUpdateDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  organizationalUnitId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class TeamCreateDto extends OrganizationCodeDto {
  @Validate(TeamPlacementXorConstraint)
  declare code: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @Validate(TeamPlacementXorConstraint)
  @IsOptional()
  @IsString()
  @Length(36, 36)
  departmentId?: string;

  @Validate(TeamPlacementXorConstraint)
  @IsOptional()
  @IsString()
  @Length(36, 36)
  organizationalUnitId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class TeamUpdateDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @Validate(TeamPlacementXorConstraint)
  @IsOptional()
  @IsString()
  @Length(36, 36)
  departmentId?: string | null;

  @Validate(TeamPlacementXorConstraint)
  @IsOptional()
  @IsString()
  @Length(36, 36)
  organizationalUnitId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class JobTitleCreateDto extends OrganizationCodeDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class JobTitleUpdateDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class PositionCreateDto extends OrganizationCodeDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsString()
  @Length(36, 36)
  jobTitleId!: string;

  @Validate(PositionPlacementLimitConstraint)
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @Validate(PositionPlacementLimitConstraint)
  @IsOptional()
  @IsString()
  @Length(36, 36)
  organizationalUnitId?: string;

  @Validate(PositionPlacementLimitConstraint)
  @IsOptional()
  @IsString()
  @Length(36, 36)
  departmentId?: string;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  teamId?: string;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  workLocationId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class PositionUpdateDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @Validate(PositionPlacementLimitConstraint)
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @Validate(PositionPlacementLimitConstraint)
  @IsOptional()
  @IsString()
  @Length(36, 36)
  jobTitleId?: string;

  @Validate(PositionPlacementLimitConstraint)
  @IsOptional()
  @IsString()
  @Length(36, 36)
  organizationalUnitId?: string | null;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  departmentId?: string | null;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  teamId?: string | null;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  workLocationId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class WorkLocationCreateDto extends OrganizationCodeDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  physicalSiteId?: string;

  /**
   * Batch 5B (D12): the explicit choice to create a physical site matching this work location
   * (audited). A missing or null `physicalSiteId` never creates one by itself.
   */
  @IsOptional()
  @IsBoolean()
  createPhysicalSite?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  city?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  stateProvince?: string;

  @IsOptional()
  @IsString()
  @Length(0, 50)
  postalCode?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  country?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  @Validate(IanaTimezoneConstraint)
  timezone?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

export class WorkLocationUpdateDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  physicalSiteId?: string | null;

  /**
   * Batch 5B (D12): the explicit choice to create a physical site matching this work location
   * (audited). A missing or null `physicalSiteId` never creates one by itself.
   */
  @IsOptional()
  @IsBoolean()
  createPhysicalSite?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  city?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  stateProvince?: string;

  @IsOptional()
  @IsString()
  @Length(0, 50)
  postalCode?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  country?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  @Validate(IanaTimezoneConstraint)
  timezone?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2147483647)
  sortOrder?: number;
}

/** Batch 5B (D12): a physical site (building) of an organization. */
export class PhysicalSiteCreateDto {
  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'name must not be blank' })
  name!: string;

  @IsOptional() @IsString() @Length(0, 200) addressLine1?: string | null;
  @IsOptional() @IsString() @Length(0, 200) addressLine2?: string | null;
  @IsOptional() @IsString() @Length(0, 200) city?: string | null;
  @IsOptional() @IsString() @Length(0, 200) stateProvince?: string | null;
  @IsOptional() @IsString() @Length(0, 50) postalCode?: string | null;
  @IsOptional() @IsString() @Length(0, 200) country?: string | null;
}

export class PhysicalSiteUpdateDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'name must not be blank' })
  name?: string;

  @IsOptional() @IsString() @Length(0, 200) addressLine1?: string | null;
  @IsOptional() @IsString() @Length(0, 200) addressLine2?: string | null;
  @IsOptional() @IsString() @Length(0, 200) city?: string | null;
  @IsOptional() @IsString() @Length(0, 200) stateProvince?: string | null;
  @IsOptional() @IsString() @Length(0, 50) postalCode?: string | null;
  @IsOptional() @IsString() @Length(0, 200) country?: string | null;
}
