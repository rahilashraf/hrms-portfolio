import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
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
import { ONBOARDING_OPTION_KINDS } from './onboarding-options.service.js';

/** Shapes only: business rules live in the services and the onboarding domain. */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export const KINDS = ['ONBOARDING', 'OFFBOARDING'] as const;
export const CATEGORIES = [
  'PAPERWORK',
  'POLICY',
  'ACCOUNT_ACCESS',
  'EQUIPMENT',
  'ORIENTATION',
  'TRAINING',
  'PAYROLL',
  'BENEFITS',
  'MEETING',
  'RECORDS',
  'OTHER',
] as const;
export const OWNER_TYPES = [
  'EMPLOYEE',
  'MANAGER',
  'HR',
  'SPECIFIC_USER',
] as const;
export const REFERENCE_TYPES = [
  'EXTERNAL_URL',
  'GOOGLE_FORM',
  'GOOGLE_DOC',
  'GOOGLE_DRIVE_FILE',
  'GOOGLE_DRIVE_FOLDER',
  'INTERNAL_DOCUMENT',
  'POLICY_DOCUMENT',
  'DOCUMENT_TYPE',
] as const;
export const SYSTEM_ACTIONS = [
  'NONE',
  'PROVISION_HRMS_ACCOUNT',
  'DISABLE_HRMS_ACCOUNT',
  'PROVISION_EXTERNAL_ACCOUNT',
  'DISABLE_EXTERNAL_ACCOUNT',
  'REVOKE_BUILDING_ACCESS',
  'ISSUE_EQUIPMENT',
  'COLLECT_EQUIPMENT',
] as const;

const Nullable =
  (...decorators: PropertyDecorator[]) =>
  (target: object, key: string) =>
    [
      IsOptional(),
      ValidateIf((_: unknown, value: unknown) => value !== null),
      ...decorators,
    ].forEach((d) => d(target, key));

export class OrganizationKindQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsIn(KINDS)
  kind?: (typeof KINDS)[number];

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeClosed?: boolean;
}

export class TemplateTaskDto {
  /**
   * The existing template task this entry is (its id from the template), when editing. Only
   * used to keep an owner that task already had; a new task leaves it out.
   */
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @Length(1, 300)
  title!: string;

  @Nullable(IsString(), Length(0, 10_000))
  description?: string | null;

  @IsIn(CATEGORIES)
  category!: (typeof CATEGORIES)[number];

  @IsIn(OWNER_TYPES)
  ownerType!: (typeof OWNER_TYPES)[number];

  @Nullable(IsUUID())
  ownerUserId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(-365)
  @Max(365)
  dueOffsetDays?: number;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsBoolean()
  evidenceRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  acknowledgementRequired?: boolean;

  @Nullable(IsString(), Length(0, 4000))
  acknowledgementStatement?: string | null;

  @Nullable(IsIn(REFERENCE_TYPES))
  referenceType?: (typeof REFERENCE_TYPES)[number] | null;

  @Nullable(IsString(), Length(0, 2000))
  referenceUrl?: string | null;

  @Nullable(IsString(), Length(0, 500))
  referenceExternalId?: string | null;

  @Nullable(IsString(), Length(0, 300))
  referenceLabel?: string | null;

  @IsOptional()
  @IsIn(SYSTEM_ACTIONS)
  systemAction?: (typeof SYSTEM_ACTIONS)[number];
}

export class CreateTemplateDto {
  @IsUUID()
  organizationId!: string;

  @IsIn(KINDS)
  kind!: (typeof KINDS)[number];

  @IsString()
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @Nullable(IsString(), Length(0, 10_000))
  description?: string | null;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TemplateTaskDto)
  tasks!: TemplateTaskDto[];
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @Nullable(IsString(), Length(0, 10_000))
  description?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TemplateTaskDto)
  tasks?: TemplateTaskDto[];
}

export class StartOnboardingDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @Nullable(IsUUID())
  templateId?: string | null;
}

export class StartOffboardingDto extends StartOnboardingDto {
  @Matches(DATE_ONLY)
  plannedEndDate!: string;

  @Nullable(IsString(), Length(0, 2000))
  reason?: string | null;
}

export class StartFromHireDto {
  @Nullable(IsUUID())
  templateId?: string | null;
}

export class RequiredReasonDto {
  @IsString()
  @Length(1, 2000)
  reason!: string;
}

export class CompleteTaskDto {
  @Nullable(IsString(), Length(0, 4000))
  note?: string | null;

  @Nullable(IsString(), Length(0, 2000))
  evidenceReference?: string | null;
}

export class AcknowledgeTaskDto {
  @IsBoolean()
  @Equals(true)
  statementAccepted!: boolean;
}

export class ReassignTaskDto {
  @Nullable(IsUUID())
  ownerUserId!: string | null;
}

export class DueDateDto {
  @Nullable(Matches(DATE_ONLY))
  dueDate!: string | null;

  @IsString()
  @Length(1, 2000)
  reason!: string;
}

export class MyTasksQueryDto {
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeDone?: boolean;
}

class ExternalSubmissionDto {
  @IsString()
  @Length(1, 500)
  externalResourceId!: string;

  @IsString()
  @Length(1, 500)
  externalResponseId!: string;

  @IsString()
  @Length(1, 320)
  respondentEmail!: string;

  @IsString()
  @Length(1, 40)
  submittedAt!: string;
}

export class ImportCompletionsDto {
  @IsUUID()
  organizationId!: string;

  @IsIn(['GOOGLE_FORM', 'GOOGLE_DOC', 'EXTERNAL_URL'])
  referenceType!: 'GOOGLE_FORM' | 'GOOGLE_DOC' | 'EXTERNAL_URL';

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ExternalSubmissionDto)
  submissions!: ExternalSubmissionDto[];
}

/** Batch 7A — module-scoped picker options (GET /onboarding/options). */
export class OnboardingOptionQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsIn(ONBOARDING_OPTION_KINDS)
  kind!: (typeof ONBOARDING_OPTION_KINDS)[number];

  @IsOptional()
  @IsIn(KINDS)
  workflowKind?: (typeof KINDS)[number];

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
