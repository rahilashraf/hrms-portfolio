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
import { PERFORMANCE_OPTION_KINDS } from './performance-options.service.js';

/** Shapes only: business rules live in the services and the performance domain. */

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WEIGHT = /^\d{1,3}(\.\d{1,2})?$/;
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export const ITEM_TYPES = [
  'RATING',
  'SCALE',
  'TEXT',
  'YES_NO',
  'GOAL_PROGRESS',
  'EVIDENCE_REFERENCE',
] as const;
export const RESPONDENTS = ['SELF', 'REVIEWER', 'BOTH'] as const;
export const SCORING_MODES = ['NONE', 'WEIGHTED_AVERAGE'] as const;

export class PerformanceOrganizationQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}

// ─── Competencies ───────────────────────────────────────────────────────────

class CompetencyFieldsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 1000)
  description?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 120)
  category?: string | null;
}

export class CreateCompetencyDto extends CompetencyFieldsDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 120)
  name!: string;
}

export class UpdateCompetencyDto extends CompetencyFieldsDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;
}

// ─── Rating scales ──────────────────────────────────────────────────────────

export class ScaleLevelDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  value!: number;

  @IsString()
  @Length(1, 120)
  label!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 500)
  description?: string | null;
}

export class CreateRatingScaleDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 1000)
  description?: string | null;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ScaleLevelDto)
  levels!: ScaleLevelDto[];
}

export class UpdateRatingScaleDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 1000)
  description?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ScaleLevelDto)
  levels?: ScaleLevelDto[];
}

// ─── Templates ──────────────────────────────────────────────────────────────

export class TemplateItemDto {
  @IsIn(ITEM_TYPES)
  itemType!: (typeof ITEM_TYPES)[number];

  @IsString()
  @Length(1, 1000)
  prompt!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 2000)
  helpText?: string | null;

  @IsIn(RESPONDENTS)
  respondent!: (typeof RESPONDENTS)[number];

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(WEIGHT)
  weight?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  competencyId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  ratingScaleId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(-1000)
  @Max(1000)
  scaleMin?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(-1000)
  @Max(1000)
  scaleMax?: number | null;
}

export class TemplateSectionDto {
  @IsString()
  @Length(1, 200)
  title!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 2000)
  description?: string | null;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TemplateItemDto)
  items!: TemplateItemDto[];
}

class TemplateHeaderDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 2000)
  description?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  ratingScaleId?: string | null;

  @IsOptional()
  @IsBoolean()
  overallRatingEnabled?: boolean;
}

export class CreateTemplateDto extends TemplateHeaderDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsIn(SCORING_MODES)
  scoringMode!: (typeof SCORING_MODES)[number];

  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => TemplateSectionDto)
  sections!: TemplateSectionDto[];
}

export class UpdateTemplateDto extends TemplateHeaderDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsIn(SCORING_MODES)
  scoringMode?: (typeof SCORING_MODES)[number];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => TemplateSectionDto)
  sections?: TemplateSectionDto[];
}

export class CopyTemplateDto {
  @IsString()
  @Length(1, 64)
  code!: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;
}

// ─── Cycles ─────────────────────────────────────────────────────────────────

export const REVIEWER_MODELS = ['DIRECT_MANAGER', 'HR_ASSIGNED'] as const;

class CycleFieldsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 2000)
  description?: string | null;

  @IsOptional()
  @IsIn(REVIEWER_MODELS)
  reviewerModel?: (typeof REVIEWER_MODELS)[number];

  @IsOptional()
  @IsBoolean()
  selfReviewEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  acknowledgementEnabled?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  selfReviewDueDate?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  reviewerDueDate?: string | null;
}

export class CreateCycleDto extends CycleFieldsDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsUUID()
  templateId!: string;

  @Matches(DATE_ONLY)
  periodStart!: string;

  @Matches(DATE_ONLY)
  periodEnd!: string;

  @Matches(DATE_ONLY)
  windowStart!: string;

  @Matches(DATE_ONLY)
  windowEnd!: string;
}

export class UpdateCycleDto extends CycleFieldsDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsUUID()
  templateId?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  periodStart?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  periodEnd?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  windowStart?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  windowEnd?: string;
}

export class AddCycleReviewsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  assignmentIds?: string[];

  @IsOptional()
  @IsBoolean()
  allInOrganization?: boolean;

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

export class CloseCycleDto {
  @IsOptional()
  @IsBoolean()
  closeIncomplete?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 500)
  reason?: string | null;
}

// ─── Reviews ────────────────────────────────────────────────────────────────

export class AnswerDto {
  @IsUUID()
  itemId!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  ratingValue?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  numericValue?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  booleanValue?: boolean | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 10_000)
  textValue?: string | null;
}

export class SaveAnswersDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AnswerDto)
  answers!: AnswerDto[];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  overallRatingValue?: number | null;
}

export class ReassignReviewerDto {
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  reviewerEmployeeId!: string | null;

  @IsString()
  @Length(1, 500)
  reason!: string;
}

export const REVIEW_PARTS = ['SELF', 'REVIEWER'] as const;

export class ReopenReviewDto {
  @IsIn(REVIEW_PARTS)
  part!: (typeof REVIEW_PARTS)[number];

  @IsString()
  @Length(1, 500)
  reason!: string;
}

// ─── Goals ──────────────────────────────────────────────────────────────────

export const GOAL_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

class GoalFieldsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 4000)
  description?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 1000)
  measure?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DATE_ONLY)
  dueDate?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(100)
  progressPercent?: number | null;
}

export class CreateGoalDto extends GoalFieldsDto {
  @IsUUID()
  employmentAssignmentId!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @Matches(DATE_ONLY)
  startDate!: string;
}

export class UpdateGoalDto extends GoalFieldsDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  startDate?: string;

  @IsOptional()
  @IsIn(GOAL_STATUSES)
  status?: (typeof GOAL_STATUSES)[number];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 4000)
  completionNotes?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 500)
  cancellationReason?: string | null;
}

// ─── Evidence ───────────────────────────────────────────────────────────────

export const EVIDENCE_PROVIDERS = [
  'GOOGLE_FORMS',
  'MANUAL',
  'TRAINING',
  'CERTIFICATION',
  'OTHER',
] as const;
export const MANUAL_EVIDENCE_PROVIDERS = [
  'MANUAL',
  'TRAINING',
  'CERTIFICATION',
  'OTHER',
] as const;
export const EVIDENCE_KINDS = [
  'ASSESSMENT',
  'TRAINING',
  'CERTIFICATION',
  'POLICY_ACKNOWLEDGEMENT',
  'OTHER',
] as const;
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;
const SCORE = /^\d{1,8}(\.\d{1,2})?$/;

class SourceFieldsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 500)
  resourceTitle?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 2000)
  resourceUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(PERCENT)
  passThresholdPercent?: string | null;
}

export class CreateEvidenceSourceDto extends SourceFieldsDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsIn(EVIDENCE_PROVIDERS)
  provider!: (typeof EVIDENCE_PROVIDERS)[number];

  @IsIn(EVIDENCE_KINDS)
  kind!: (typeof EVIDENCE_KINDS)[number];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(1, 500)
  externalResourceId?: string | null;
}

export class UpdateEvidenceSourceDto extends SourceFieldsDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;
}

/** One result of the ingestion contract (see performance-evidence.contract.ts). */
export class ExternalResultDto {
  @IsString()
  @Length(1, 500)
  externalResultId!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  employeeId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  employmentAssignmentId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 320)
  respondentEmail?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 500)
  respondentReference?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 500)
  title?: string | null;

  @IsString()
  @Length(1, 40)
  completedAt!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(SCORE)
  score?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(SCORE)
  maxScore?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  passed?: boolean | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 2000)
  resultUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(1, 40)
  externalUpdatedAt?: string | null;

  @IsOptional()
  @IsBoolean()
  withdrawn?: boolean;
}

export class ImportEvidenceDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ExternalResultDto)
  results!: ExternalResultDto[];
}

export class RecordEvidenceDto {
  @IsUUID()
  organizationId!: string;

  @IsUUID()
  employeeId!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  employmentAssignmentId?: string | null;

  @IsIn(MANUAL_EVIDENCE_PROVIDERS)
  provider!: (typeof MANUAL_EVIDENCE_PROVIDERS)[number];

  @IsIn(EVIDENCE_KINDS)
  kind!: (typeof EVIDENCE_KINDS)[number];

  @IsString()
  @Length(1, 500)
  title!: string;

  @IsString()
  @Length(1, 40)
  completedAt!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(SCORE)
  score?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(SCORE)
  maxScore?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  passed?: boolean | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(PERCENT)
  passThresholdPercent?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 2000)
  resultUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 4000)
  notes?: string | null;
}

export class CorrectEvidenceDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  completedAt?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(SCORE)
  score?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(SCORE)
  maxScore?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  passed?: boolean | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 4000)
  notes?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  employmentAssignmentId?: string | null;

  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class RemapEvidenceDto {
  @IsUUID()
  employeeId!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  employmentAssignmentId?: string | null;

  @IsString()
  @Length(1, 500)
  reason!: string;
}

export class ReasonDto {
  @IsString()
  @Length(1, 500)
  reason!: string;
}

export const INTAKE_STATUSES = [
  'PENDING_MATCH',
  'MATCHED',
  'REJECTED',
] as const;

export class IntakeQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsIn(INTAKE_STATUSES)
  status?: (typeof INTAKE_STATUSES)[number];

  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsUUID()
  afterId?: string;
}

export class ResolveIntakeDto {
  @IsIn(['MATCH', 'REJECT'])
  action!: 'MATCH' | 'REJECT';

  @ValidateIf((dto: ResolveIntakeDto) => dto.action === 'MATCH')
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  employmentAssignmentId?: string | null;

  @ValidateIf(
    (dto: ResolveIntakeDto) =>
      dto.action === 'REJECT' || dto.note !== undefined,
  )
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class LinkEvidenceDto {
  @IsUUID()
  evidenceId!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  formItemId?: string | null;
}

// ─── Review lifecycle ──────────────────────────────────────────────────────

export class AcknowledgeReviewDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 4000)
  comment?: string | null;
}

export class CloseReviewDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Length(0, 500)
  reason?: string | null;
}

export class CorrectReviewDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AnswerDto)
  answers?: AnswerDto[];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  overallRatingValue?: number | null;

  @IsString()
  @Length(1, 500)
  reason!: string;
}

/** Batch 7B (D7) — module-scoped picker options (GET /performance/options). */
export class PerformanceOptionQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsIn(PERFORMANCE_OPTION_KINDS)
  kind!: (typeof PERFORMANCE_OPTION_KINDS)[number];

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

/** Batch 7B — cycle review monitoring filters and paging. */
export class CycleReviewsQueryDto {
  @IsOptional()
  @IsIn([
    'NOT_STARTED',
    'IN_PROGRESS',
    'SUBMITTED',
    'FINALIZED',
    'ACKNOWLEDGED',
    'CLOSED',
  ])
  status?: string;

  @IsOptional()
  @IsUUID()
  reviewerEmployeeId?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  withoutReviewer?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  search?: string;

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

/** Batch 7B — attention filters and paging. */
export class AttentionQueryDto extends PerformanceOrganizationQueryDto {
  @IsOptional()
  @IsUUID()
  cycleId?: string;

  @IsOptional()
  @IsIn([
    'NO_REVIEWER',
    'REVIEWER_NOT_IN_ORGANIZATION',
    'OVERDUE_SELF',
    'OVERDUE_REVIEWER',
    'ASSIGNMENT_ENDED',
    'EMPLOYEE_TERMINATED',
    'AWAITING_FINALIZATION',
    'AWAITING_ACKNOWLEDGEMENT',
  ])
  flag?: string;

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

/** Batch 7B — goal list status filter and paging. */
export class GoalStatusQueryDto {
  @IsOptional()
  @IsIn(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])
  status?: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

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

/** Batch 7B — evidence list status filter and paging. */
export class EvidenceStatusQueryDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'WITHDRAWN'])
  status?: 'ACTIVE' | 'WITHDRAWN';

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
