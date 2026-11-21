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

/** Shapes only: business rules live in the services and the documents domain. */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;
const toInt = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export const CATEGORIES = [
  'EMPLOYMENT_AGREEMENT',
  'OFFER_LETTER',
  'RESUME',
  'CERTIFICATION',
  'LICENSE',
  'BACKGROUND_CHECK',
  'HANDBOOK',
  'POLICY',
  'EVALUATION',
  'PAYROLL',
  'TAX',
  'IDENTIFICATION',
  'TRAINING_CERTIFICATE',
  'OTHER',
] as const;
export const LEVELS = [
  'EMPLOYEE_VISIBLE',
  'MANAGER_VISIBLE',
  'HR_ONLY',
  'RESTRICTED',
] as const;
export const PROVIDERS = [
  'GOOGLE_DRIVE',
  'EXTERNAL_URL',
  'INTERNAL_OBJECT_STORAGE',
  'MANUAL_REFERENCE',
] as const;
export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CASUAL',
  'CONTRACT',
] as const;

const Nullable =
  (...decorators: PropertyDecorator[]) =>
  (target: object, key: string) =>
    [
      IsOptional(),
      ValidateIf((_: unknown, value: unknown) => value !== null),
      ...decorators,
    ].forEach((d) => d(target, key));

export class OrganizationQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}

export class ExpiryQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(365)
  withinDays?: number;
}

export class CreateTypeDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @Nullable(IsString(), Length(0, 10_000))
  description?: string | null;

  @IsIn(CATEGORIES)
  category!: (typeof CATEGORIES)[number];

  @IsIn(LEVELS)
  defaultConfidentiality!: (typeof LEVELS)[number];

  @IsOptional()
  @IsBoolean()
  expiryTracked?: boolean;

  @IsOptional()
  @IsBoolean()
  employeeProvided?: boolean;
}

export class UpdateTypeDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @Nullable(IsString(), Length(0, 10_000))
  description?: string | null;

  @IsOptional()
  @IsIn(LEVELS)
  defaultConfidentiality?: (typeof LEVELS)[number];

  @IsOptional()
  @IsBoolean()
  expiryTracked?: boolean;

  @IsOptional()
  @IsBoolean()
  employeeProvided?: boolean;
}

export class InitializeTypesDto {
  @IsUUID()
  organizationId!: string;
}

export class CreateRequirementDto {
  @IsUUID()
  organizationId!: string;

  @IsUUID()
  typeId!: string;

  @Nullable(IsIn(EMPLOYMENT_TYPES))
  employmentType?: (typeof EMPLOYMENT_TYPES)[number] | null;

  @Nullable(IsUUID())
  departmentId?: string | null;

  @Nullable(IsUUID())
  positionId?: string | null;

  @Nullable(IsString(), Length(0, 1000))
  note?: string | null;
}

export class StorageReferenceDto {
  @IsIn(PROVIDERS)
  provider!: (typeof PROVIDERS)[number];

  @Nullable(IsString(), Length(0, 2000))
  externalUrl?: string | null;

  /** Refused by the service (Batch 9, F2): kept only to answer with a clear error. */
  @Nullable(IsString(), Length(0, 1000))
  storageKey?: string | null;

  /** Batch 9: an upload (POST /documents/uploads) for INTERNAL_OBJECT_STORAGE. */
  @Nullable(IsUUID())
  uploadId?: string | null;

  @Nullable(IsString(), Length(0, 500))
  externalFileId?: string | null;

  @Nullable(IsString(), Length(0, 300))
  fileName?: string | null;

  @Nullable(IsString(), Length(0, 200))
  mimeType?: string | null;

  @Nullable(IsInt(), Min(0))
  sizeBytes?: number | null;
}

export class VersionDto extends StorageReferenceDto {
  @Nullable(Matches(DATE_ONLY))
  issuedOn?: string | null;

  @Nullable(Matches(DATE_ONLY))
  effectiveOn?: string | null;

  @Nullable(Matches(DATE_ONLY))
  expiresOn?: string | null;

  @Nullable(IsString(), Length(0, 2000))
  note?: string | null;
}

export class CreateDocumentDto {
  @IsUUID()
  organizationId!: string;

  @IsUUID()
  employeeId!: string;

  @Nullable(IsUUID())
  employmentAssignmentId?: string | null;

  @IsUUID()
  typeId!: string;

  @IsString()
  @Length(1, 300)
  title!: string;

  @Nullable(IsString(), Length(0, 10_000))
  description?: string | null;

  @Nullable(IsIn(LEVELS))
  confidentiality?: (typeof LEVELS)[number] | null;

  @ValidateNested()
  @Type(() => VersionDto)
  version!: VersionDto;
}

export class UpdateDocumentDto {
  @IsOptional()
  @IsString()
  @Length(1, 300)
  title?: string;

  @Nullable(IsString(), Length(0, 10_000))
  description?: string | null;

  @IsOptional()
  @IsIn(LEVELS)
  confidentiality?: (typeof LEVELS)[number];
}

export class ProvideDocumentDto {
  @IsUUID()
  organizationId!: string;

  @IsUUID()
  typeId!: string;

  @IsString()
  @Length(1, 300)
  title!: string;

  @Nullable(IsUUID())
  workflowTaskId?: string | null;

  @ValidateNested()
  @Type(() => VersionDto)
  version!: VersionDto;
}

export class RequiredReasonDto {
  @IsString()
  @Length(1, 1000)
  reason!: string;
}

export class CreatePolicyDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 300)
  title!: string;

  @Nullable(IsString(), Length(0, 10_000))
  description?: string | null;

  @Nullable(IsUUID())
  typeId?: string | null;

  @IsOptional()
  @IsBoolean()
  acknowledgementRequired?: boolean;

  @Nullable(IsIn(EMPLOYMENT_TYPES))
  audienceEmploymentType?: (typeof EMPLOYMENT_TYPES)[number] | null;

  @Nullable(IsUUID())
  audienceDepartmentId?: string | null;
}

export class UpdatePolicyDto {
  @IsOptional()
  @IsString()
  @Length(1, 300)
  title?: string;

  @Nullable(IsString(), Length(0, 10_000))
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  acknowledgementRequired?: boolean;

  @Nullable(IsIn(EMPLOYMENT_TYPES))
  audienceEmploymentType?: (typeof EMPLOYMENT_TYPES)[number] | null;

  @Nullable(IsUUID())
  audienceDepartmentId?: string | null;
}

export class PolicyVersionDto extends StorageReferenceDto {
  @IsString()
  @Length(1, 100)
  versionLabel!: string;

  @Nullable(IsString(), Length(0, 4000))
  acknowledgementStatement?: string | null;

  @Nullable(Matches(DATE_ONLY))
  effectiveOn?: string | null;
}

export class AcknowledgeDto {
  @IsBoolean()
  @Equals(true)
  statementAccepted!: boolean;
}

class HandoffItemDto {
  @IsUUID()
  recruitmentDocumentId!: string;

  @IsUUID()
  typeId!: string;

  @Nullable(IsIn(LEVELS))
  confidentiality?: (typeof LEVELS)[number] | null;
}

class HandoffOfferDto {
  @IsUUID()
  typeId!: string;

  @Nullable(IsIn(LEVELS))
  confidentiality?: (typeof LEVELS)[number] | null;
}

export class HandoffDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => HandoffItemDto)
  documents!: HandoffItemDto[];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => HandoffOfferDto)
  offer?: HandoffOfferDto | null;
}

/**
 * Batch 9: what an upload is for (exactly one target): a new record for an employee
 * (organizationId + employeeId), a new version of a document (documentId), the caller's own
 * self-service document (organizationId + self=true), or a policy version (policyId).
 */
export class UploadTargetDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsUUID()
  documentId?: string;

  @IsOptional()
  @IsUUID()
  policyId?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  self?: boolean;
}

export class DocumentOptionsQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsIn(['department', 'position'])
  kind!: 'department' | 'position';

  @IsOptional()
  @IsString()
  @Length(0, 100)
  search?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsUUID()
  afterId?: string;
}

/** Batch 9 (D10): the replacement's criteria (the document type stays the same). */
export class ReplaceRequirementDto {
  @Nullable(IsIn(EMPLOYMENT_TYPES))
  employmentType?: (typeof EMPLOYMENT_TYPES)[number] | null;

  @Nullable(IsUUID())
  departmentId?: string | null;

  @Nullable(IsUUID())
  positionId?: string | null;

  @Nullable(IsString(), Length(0, 1000))
  note?: string | null;
}

export class CopyPolicyDto {
  @IsString()
  @Length(1, 64)
  code!: string;

  @Nullable(IsString(), Length(1, 300))
  title?: string | null;
}
