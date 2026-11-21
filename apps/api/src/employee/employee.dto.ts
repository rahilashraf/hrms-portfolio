import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsNotEmpty,
  IsEmail,
  IsEnum,
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
import {
  EmploymentAssignmentStatus,
  EmploymentType,
} from '../generated/prisma/enums.js';

/** Batch 5A: calendar dates are exactly YYYY-MM-DD (the service also rejects impossible dates). */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** R4-A.1: how far ahead the lifecycle due list looks for assignment ends. */
export const LIFECYCLE_UPCOMING_MAX_DAYS = 90;
export const LIFECYCLE_UPCOMING_DEFAULT_DAYS = 30;

const DATE_MESSAGE = { message: '$property must be a YYYY-MM-DD date' };

export class PersonInputDto {
  @IsOptional() @IsString() @Length(1, 100) firstName?: string;
  @IsOptional() @IsString() @Length(1, 100) middleName?: string;
  @IsOptional() @IsString() @Length(1, 100) lastName?: string;
  @IsOptional() @IsString() @Length(1, 100) preferredName?: string;
  @IsOptional() @IsEmail() personalEmail?: string;
  @IsOptional() @IsString() @Length(1, 50) phone?: string;
}

export class CreateEmployeeDto {
  @IsOptional() @IsUUID() personId?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => PersonInputDto)
  person?: PersonInputDto;
  @IsOptional() @IsString() @Length(1, 50) employeeNumber?: string;
  @IsOptional() @IsUUID() initialPositionId?: string;
  @Matches(DATE_ONLY, DATE_MESSAGE) hireDate!: string;
  @IsOptional() @IsEnum(EmploymentType) initialEmploymentType?: EmploymentType;
  @IsOptional() @Matches(DATE_ONLY, DATE_MESSAGE) initialStartDate?: string;
  @IsOptional() @Matches(DATE_ONLY, DATE_MESSAGE) initialEndDate?: string;
  @IsOptional() @IsBoolean() initialPrimary?: boolean;
  @IsOptional() @IsUUID() initialManagerAssignmentId?: string;
}

export class UpdateEmployeeDto extends PersonInputDto {}

export class CreateAssignmentDto {
  @IsUUID() positionId!: string;
  @IsEnum(EmploymentType) employmentType!: EmploymentType;
  @IsOptional()
  @IsEnum(EmploymentAssignmentStatus)
  status?: EmploymentAssignmentStatus;
  @Matches(DATE_ONLY, DATE_MESSAGE) startDate!: string;
  @IsOptional() @Matches(DATE_ONLY, DATE_MESSAGE) endDate?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  @IsOptional() @IsUUID() managerAssignmentId?: string;
  /** K5: the employee number confirmed through the attach lookup (organization-wide attach). */
  @IsOptional() @IsString() @Length(1, 50) attachEmployeeNumber?: string;
}

export class CorrectAssignmentDto {
  @IsEnum(EmploymentType) employmentType!: EmploymentType;
  @Matches(DATE_ONLY, DATE_MESSAGE) startDate!: string;
  @IsOptional() @Matches(DATE_ONLY, DATE_MESSAGE) endDate?: string;
}

export class EndAssignmentDto {
  @Matches(DATE_ONLY, DATE_MESSAGE) endDate!: string;
}
export class PrimaryAssignmentDto {
  @IsBoolean() isPrimary!: boolean;
}
export class ManagerAssignmentDto {
  @IsOptional() @IsUUID() managerAssignmentId?: string;
}
export class TerminateEmployeeDto {
  /** The last day of employment (inclusive). */
  @Matches(DATE_ONLY, DATE_MESSAGE) terminationDate!: string;
  /** R7: restricted; never shown in directories, reports or audit metadata. */
  @IsOptional() @IsString() @Length(0, 1000) reason?: string;
  /**
   * R6 (legacy): still accepted, but no longer a decision. M3: each System-level role needs an
   * explicit decision in `grantDecisions`.
   */
  @IsOptional() @IsBoolean() acknowledgeSystemGrants?: boolean;
  /** M3: REVOKE, or a KEEP request (approved by someone else), per role grant. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TerminationGrantDecisionDto)
  grantDecisions?: TerminationGrantDecisionDto[];
}
/** Security remediation M3: one decision about a role grant of the terminated person. */
export class TerminationGrantDecisionDto {
  @IsUUID('all') roleAssignmentId!: string;
  @IsIn(['REVOKE', 'KEEP']) decision!: 'REVOKE' | 'KEEP';
  /** KEEP: why the access is needed after the last day (10–500 characters, checked again). */
  @IsOptional() @IsString() @Length(0, 500) reason?: string;
  /** KEEP: when the kept access ends, an ISO date and time with its offset. */
  @IsOptional()
  @Matches(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/,
    { message: 'keepUntil must be an ISO date and time with an offset' },
  )
  keepUntil?: string;
}

export class RecordGrantDecisionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TerminationGrantDecisionDto)
  decisions!: TerminationGrantDecisionDto[];
}

export class ReviewGrantKeepDto {
  @IsOptional() @IsString() @Length(0, 500) note?: string;
}

export class CancelTerminationDto {
  @IsOptional() @IsString() @Length(0, 1000) reason?: string;
}
export class TerminationPreviewQueryDto {
  @Matches(DATE_ONLY, DATE_MESSAGE) terminationDate!: string;
}
export class RehireAssignmentDto {
  @IsUUID() positionId!: string;
  @IsEnum(EmploymentType) employmentType!: EmploymentType;
  @Matches(DATE_ONLY, DATE_MESSAGE) startDate!: string;
  @IsOptional() @Matches(DATE_ONLY, DATE_MESSAGE) endDate?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  @IsOptional() @IsUUID() managerAssignmentId?: string;
}
/** Batch 5A: a rehire always creates the new assignment. */
export class RehireEmployeeDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => RehireAssignmentDto)
  assignment!: RehireAssignmentDto;
  @IsOptional() @IsString() @Length(1, 50) confirmEmployeeNumber?: string;
  @IsOptional() @IsString() @Length(0, 1000) reason?: string;
}
export class InactivateEmployeeDto {
  @IsString() @IsNotEmpty() @Length(1, 500) reason!: string;
}
export class ReactivateEmployeeDto {
  @IsOptional() @IsString() @Length(0, 500) reason?: string;
}
export class RevokeEmployeeGrantsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  roleAssignmentIds!: string[];
  @IsOptional() @IsString() @Length(0, 500) reason?: string;
}
export class LifecycleDueQueryDto {
  @IsUUID() organizationId!: string;
  /**
   * R4-A.1: also list ACTIVE assignments whose end date is within this many days of their local
   * today (0 = ending today only). Default 30.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(LIFECYCLE_UPCOMING_MAX_DAYS)
  upcomingDays?: number;
}
export class AttachLookupQueryDto {
  @IsUUID() organizationId!: string;
  @IsString() @Length(1, 50) employeeNumber!: string;
}

export class EmployeeDirectoryQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE', 'TERMINATED']) status?:
    'ACTIVE' | 'INACTIVE' | 'TERMINATED';
  @IsOptional() @IsUUID() organizationId?: string;
  @IsOptional() @IsUUID() jobTitleId?: string;
  // Query-string values arrive as strings; convert before the integer/range checks.
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID() afterId?: string;
}

export class EmployeeOptionQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsUUID() afterId?: string;
}

export class PositionOptionQueryDto extends EmployeeOptionQueryDto {
  @IsOptional() @IsUUID() organizationId?: string;
}

/**
 * Managers for an existing assignment (`subordinateAssignmentId`) or, Batch 5C, for a new one
 * not created yet (rehire / transfer): `positionId` and `startDate` (and `endDate`), with the
 * employee's own assignments left out through `employeeId`. One of the two forms is required.
 */
export class ManagerAssignmentOptionQueryDto extends EmployeeOptionQueryDto {
  @ValidateIf((query: ManagerAssignmentOptionQueryDto) => !query.positionId)
  @IsUUID()
  subordinateAssignmentId?: string;
  @ValidateIf(
    (query: ManagerAssignmentOptionQueryDto) => !query.subordinateAssignmentId,
  )
  @IsUUID()
  positionId?: string;
  @ValidateIf((query: ManagerAssignmentOptionQueryDto) => !!query.positionId)
  @Matches(DATE_ONLY, DATE_MESSAGE)
  startDate?: string;
  @IsOptional() @Matches(DATE_ONLY, DATE_MESSAGE) endDate?: string;
  @IsOptional() @IsUUID() employeeId?: string;
}

/** Invitation / resend: the address the invitation goes to (default: the person's personal email). */
export class EmployeeAccountInvitationDto {
  @IsOptional() @IsString() @Length(3, 254) email?: string;
}
export class DisableEmployeeAccountDto {
  @IsOptional() @IsString() @Length(0, 500) reason?: string;
}
/** Batch 2: whether the employee's sessions also end now (default: yes). */
export class RequirePasswordChangeDto {
  @IsOptional() @IsBoolean() signOut?: boolean;
}

/** Batch 5B (K6): an atomic transfer to another position, starting on `effectiveDate`. */
export class TransferAssignmentDto {
  @IsUUID() positionId!: string;
  /** The first day in the new position; the current assignment ends the day before. */
  @Matches(DATE_ONLY, DATE_MESSAGE) effectiveDate!: string;
  @IsOptional() @IsEnum(EmploymentType) employmentType?: EmploymentType;
  @IsOptional() @Matches(DATE_ONLY, DATE_MESSAGE) endDate?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  /** Omit to carry the current manager when still valid; null for none. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  managerAssignmentId?: string | null;
  @IsOptional() @IsString() @Length(0, 1000) reason?: string;
}

/** Batch 5B (K8): the end date to preview (default: today in the assignment's time zone). */
export class AssignmentImpactQueryDto {
  @IsOptional() @Matches(DATE_ONLY, DATE_MESSAGE) endDate?: string;
}
