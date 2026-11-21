import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
import { RECRUITMENT_OPTION_KINDS } from './recruitment-options.service.js';

/** Shapes only: business rules live in the services and the recruitment domain. */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CASUAL',
  'CONTRACT',
] as const;
export const PAY_BASES = ['HOURLY', 'SALARY'] as const;
export const OPENING_STATUSES = [
  'DRAFT',
  'OPEN',
  'ON_HOLD',
  'FILLED',
  'CLOSED',
  'CANCELLED',
] as const;
export const STAGE_KINDS = [
  'APPLIED',
  'SCREENING',
  'INTERVIEW',
  'ASSESSMENT',
  'REFERENCE_CHECK',
  'OFFER',
  'HIRED',
  'OTHER',
] as const;
export const SOURCES = [
  'DIRECT',
  'REFERRAL',
  'JOB_BOARD',
  'AGENCY',
  'INTERNAL',
  'CAREERS_SITE',
  'EXTERNAL_FORM',
  'OTHER',
] as const;
export const APPLICATION_STATUSES = [
  'ACTIVE',
  'WITHDRAWN',
  'REJECTED',
  'OFFERED',
  'HIRED',
] as const;
export const SCREENING_OUTCOMES = [
  'PENDING',
  'ADVANCE',
  'HOLD',
  'DO_NOT_ADVANCE',
] as const;
export const INTERVIEW_TYPES = [
  'PHONE',
  'VIDEO',
  'IN_PERSON',
  'PANEL',
  'OTHER',
] as const;
export const RECOMMENDATIONS = [
  'STRONG_YES',
  'YES',
  'NO',
  'STRONG_NO',
  'NO_DECISION',
] as const;
export const DOCUMENT_KINDS = [
  'RESUME',
  'COVER_LETTER',
  'CERTIFICATE',
  'REFERENCE',
  'PORTFOLIO',
  'OTHER',
] as const;
export const DOCUMENT_PROVIDERS = [
  'EXTERNAL_URL',
  'GOOGLE_DRIVE',
  'MANUAL_REFERENCE',
] as const;
export const INTAKE_PROVIDERS = [
  'GOOGLE_FORMS',
  'CAREERS_SITE',
  'MANUAL_IMPORT',
  'OTHER',
] as const;

const NullableString = (max: number) => {
  const decorators = [
    IsOptional(),
    ValidateIf((_: unknown, value: unknown) => value !== null),
    IsString(),
    Length(0, max),
  ];
  return (target: object, key: string) =>
    decorators.forEach((decorator) => decorator(target, key));
};
const NullableUuid = () => {
  const decorators = [
    IsOptional(),
    ValidateIf((_: unknown, value: unknown) => value !== null),
    IsUUID(),
  ];
  return (target: object, key: string) =>
    decorators.forEach((decorator) => decorator(target, key));
};
const NullableDate = () => {
  const decorators = [
    IsOptional(),
    ValidateIf((_: unknown, value: unknown) => value !== null),
    Matches(DATE_ONLY),
  ];
  return (target: object, key: string) =>
    decorators.forEach((decorator) => decorator(target, key));
};

export class OrganizationQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}

export class ReasonDto {
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  reason?: string;
}

export class RequiredReasonDto {
  @IsString()
  @Length(1, 2000)
  reason!: string;
}

// ─── Stages ─────────────────────────────────────────────────────────────────

export class CreateStageDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsIn(STAGE_KINDS)
  kind!: (typeof STAGE_KINDS)[number];

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateStageDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class ReorderStagesDto {
  @IsUUID()
  organizationId!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  stageIds!: string[];
}

export class InitializeStagesDto {
  @IsUUID()
  organizationId!: string;
}

// ─── Openings ───────────────────────────────────────────────────────────────

export class CompensationRangeDto {
  @IsIn(PAY_BASES)
  payBasis!: (typeof PAY_BASES)[number];

  @NullableString(24)
  min?: string | null;

  @NullableString(24)
  max?: string | null;

  @IsString()
  @Length(3, 3)
  currency!: string;
}

class OpeningFieldsDto {
  @NullableString(10_000)
  description?: string | null;

  @NullableUuid()
  positionId?: string | null;

  @NullableUuid()
  organizationalUnitId?: string | null;

  @NullableUuid()
  departmentId?: string | null;

  @NullableUuid()
  teamId?: string | null;

  @NullableUuid()
  workLocationId?: string | null;

  @NullableUuid()
  hiringManagerEmployeeId?: string | null;

  @NullableUuid()
  recruiterUserId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  openingCount?: number;

  @NullableDate()
  expectedStartDate?: string | null;

  @NullableDate()
  postedOn?: string | null;

  @NullableDate()
  closesOn?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => CompensationRangeDto)
  compensation?: CompensationRangeDto | null;
}

export class CreateOpeningDto extends OpeningFieldsDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsIn(EMPLOYMENT_TYPES)
  employmentType!: (typeof EMPLOYMENT_TYPES)[number];
}

export class UpdateOpeningDto extends OpeningFieldsDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: (typeof EMPLOYMENT_TYPES)[number];
}

export class OpeningQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsIn(OPENING_STATUSES)
  status?: (typeof OPENING_STATUSES)[number];

  @IsOptional()
  @IsString()
  @Length(0, 200)
  search?: string;
}

// ─── Candidates and documents ───────────────────────────────────────────────

export class CandidateDetailsDto {
  @IsString()
  @Length(1, 120)
  firstName!: string;

  @IsString()
  @Length(1, 120)
  lastName!: string;

  @NullableString(120)
  preferredName?: string | null;

  @NullableString(320)
  email?: string | null;

  @NullableString(50)
  phone?: string | null;

  @NullableString(200)
  location?: string | null;

  @IsOptional()
  @IsIn(SOURCES)
  source?: (typeof SOURCES)[number];

  @NullableString(10_000)
  notes?: string | null;
}

export class CreateCandidateDto extends CandidateDetailsDto {
  @IsUUID()
  organizationId!: string;
}

export class UpdateCandidateDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  lastName?: string;

  @NullableString(120)
  preferredName?: string | null;

  @NullableString(320)
  email?: string | null;

  @NullableString(50)
  phone?: string | null;

  @NullableString(200)
  location?: string | null;

  @NullableString(10_000)
  notes?: string | null;
}

export class CandidateQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  search?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeMerged?: boolean;
}

export class MergeCandidateDto {
  @IsUUID()
  intoCandidateId!: string;
}

export class InternalEmployeeDto {
  @NullableUuid()
  employeeId!: string | null;
}

export class DocumentReferenceDto {
  @IsIn(DOCUMENT_KINDS)
  kind!: (typeof DOCUMENT_KINDS)[number];

  @IsString()
  @Length(1, 300)
  title!: string;

  @IsIn(DOCUMENT_PROVIDERS)
  provider!: (typeof DOCUMENT_PROVIDERS)[number];

  @NullableString(2000)
  externalUrl?: string | null;

  @NullableString(500)
  externalFileId?: string | null;

  @NullableString(300)
  fileName?: string | null;

  @NullableString(200)
  mimeType?: string | null;
}

export class AddDocumentDto extends DocumentReferenceDto {
  @NullableUuid()
  applicationId?: string | null;
}

// ─── Applications ───────────────────────────────────────────────────────────

export class CreateApplicationDto {
  @IsUUID()
  openingId!: string;

  @NullableUuid()
  candidateId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @ValidateNested()
  @Type(() => CandidateDetailsDto)
  candidate?: CandidateDetailsDto | null;

  @IsOptional()
  @IsIn(SOURCES)
  source?: (typeof SOURCES)[number];

  @NullableString(200)
  sourceDetail?: string | null;

  @NullableString(40)
  appliedAt?: string | null;

  @NullableUuid()
  recruiterUserId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DocumentReferenceDto)
  documents?: DocumentReferenceDto[];
}

export class ApplicationQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsUUID()
  openingId?: string;

  @IsOptional()
  @IsUUID()
  stageId?: string;

  @IsOptional()
  @IsIn(APPLICATION_STATUSES)
  status?: (typeof APPLICATION_STATUSES)[number];

  @IsOptional()
  @IsString()
  @Length(0, 200)
  search?: string;
}

export class MoveStageDto {
  @IsUUID()
  stageId!: string;

  @NullableString(2000)
  note?: string | null;
}

export class ScreeningDto {
  @IsIn(SCREENING_OUTCOMES)
  outcome!: (typeof SCREENING_OUTCOMES)[number];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  meetsMinimumQualifications?: boolean | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  workAuthorizationConfirmed?: boolean | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  requiredCertificationsHeld?: boolean | null;

  @NullableDate()
  availableFrom?: string | null;

  @NullableString(10_000)
  notes?: string | null;
}

// ─── Interviews ─────────────────────────────────────────────────────────────

class InterviewFieldsDto {
  @NullableString(300)
  location?: string | null;

  @NullableString(2000)
  meetingUrl?: string | null;

  @NullableString(40)
  feedbackDueAt?: string | null;
}

export class ScheduleInterviewDto extends InterviewFieldsDto {
  @IsIn(INTERVIEW_TYPES)
  type!: (typeof INTERVIEW_TYPES)[number];

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 40)
  scheduledStart!: string;

  @IsInt()
  @Min(5)
  @Max(1440)
  durationMinutes!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  interviewerUserIds?: string[];
}

export class RescheduleInterviewDto extends InterviewFieldsDto {
  @IsOptional()
  @IsIn(INTERVIEW_TYPES)
  type?: (typeof INTERVIEW_TYPES)[number];

  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  scheduledStart?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  durationMinutes?: number;
}

export class InterviewerDto {
  @IsUUID()
  userId!: string;
}

export class FeedbackDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn(RECOMMENDATIONS)
  recommendation?: (typeof RECOMMENDATIONS)[number] | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number | null;

  @NullableString(10_000)
  strengths?: string | null;

  @NullableString(10_000)
  concerns?: string | null;

  @NullableString(10_000)
  comments?: string | null;
}

// ─── Offers and hire ────────────────────────────────────────────────────────

class OfferFieldsDto {
  @NullableUuid()
  workLocationId?: string | null;

  @NullableDate()
  expiresOn?: string | null;

  @NullableString(20_000)
  candidateTerms?: string | null;

  @NullableString(10_000)
  internalNotes?: string | null;
}

export class CreateOfferDto extends OfferFieldsDto {
  @IsUUID()
  positionId!: string;

  @IsIn(EMPLOYMENT_TYPES)
  employmentType!: (typeof EMPLOYMENT_TYPES)[number];

  @Matches(DATE_ONLY)
  startDate!: string;

  @IsIn(PAY_BASES)
  payBasis!: (typeof PAY_BASES)[number];

  @IsString()
  @Length(1, 24)
  rateAmount!: string;

  @IsString()
  @Length(3, 3)
  currency!: string;
}

export class UpdateOfferDto extends OfferFieldsDto {
  @IsOptional()
  @IsUUID()
  positionId?: string;

  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: (typeof EMPLOYMENT_TYPES)[number];

  @IsOptional()
  @Matches(DATE_ONLY)
  startDate?: string;

  @IsOptional()
  @IsIn(PAY_BASES)
  payBasis?: (typeof PAY_BASES)[number];

  @IsOptional()
  @IsString()
  @Length(1, 24)
  rateAmount?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;
}

export class ConvertToEmployeeDto {
  @NullableUuid()
  existingEmployeeId?: string | null;

  @IsOptional()
  @IsBoolean()
  confirmNewPerson?: boolean;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @NullableUuid()
  managerAssignmentId?: string | null;

  @IsOptional()
  @IsBoolean()
  initializeCompensation?: boolean;

  @NullableUuid()
  payGroupId?: string | null;
}

// ─── Intake ─────────────────────────────────────────────────────────────────

export class CreateIntakeSourceDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsIn(INTAKE_PROVIDERS)
  provider!: (typeof INTAKE_PROVIDERS)[number];

  @NullableString(500)
  externalResourceId?: string | null;

  @NullableString(2000)
  resourceUrl?: string | null;

  @NullableUuid()
  defaultOpeningId?: string | null;
}

export class UpdateIntakeSourceDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @NullableString(2000)
  resourceUrl?: string | null;

  @NullableUuid()
  defaultOpeningId?: string | null;
}

class SubmissionCandidateDto {
  @IsString()
  @Length(0, 120)
  firstName!: string;

  @IsString()
  @Length(0, 120)
  lastName!: string;

  @NullableString(120)
  preferredName?: string | null;

  @NullableString(320)
  email?: string | null;

  @NullableString(50)
  phone?: string | null;

  @NullableString(200)
  location?: string | null;
}

class SubmissionAnswerDto {
  @IsString()
  @Length(0, 500)
  question!: string;

  @IsString()
  @Length(0, 4000)
  answer!: string;
}

export class SubmissionDto {
  @IsString()
  @Length(1, 500)
  externalResponseId!: string;

  @IsString()
  @Length(1, 40)
  submittedAt!: string;

  @NullableString(40)
  externalUpdatedAt?: string | null;

  @NullableString(64)
  openingCode?: string | null;

  @ValidateNested()
  @Type(() => SubmissionCandidateDto)
  candidate!: SubmissionCandidateDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => SubmissionAnswerDto)
  answers?: SubmissionAnswerDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => DocumentReferenceDto)
  documents?: DocumentReferenceDto[];

  @NullableString(200)
  sourceDetail?: string | null;
}

export class ImportSubmissionsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SubmissionDto)
  submissions!: SubmissionDto[];
}

export class IntakeQueueQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsIn(['PENDING_OPENING', 'REJECTED', 'APPLIED'])
  status?: 'PENDING_OPENING' | 'REJECTED' | 'APPLIED';

  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsUUID()
  afterId?: string;
}

export class AssignOpeningDto {
  @IsUUID()
  openingId!: string;
}

/** Batch 7A — module-scoped picker options (GET /recruitment/options). */
export class RecruitmentOptionQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsIn(RECRUITMENT_OPTION_KINDS)
  kind!: (typeof RECRUITMENT_OPTION_KINDS)[number];

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
