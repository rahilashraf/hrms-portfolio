import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  GoogleCapability,
  GoogleFormBindingTarget,
} from '../../generated/prisma/client.js';
import { GOOGLE_CAPABILITIES } from './google-workspace-domain.js';

/** Shapes only: business rules live in the services and the Google Workspace domain. */

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;
const toInt = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const TARGETS: GoogleFormBindingTarget[] = [
  'PERFORMANCE_EVIDENCE',
  'RECRUITMENT_INTAKE',
  'ONBOARDING_TASKS',
];

export class OrganizationQueryDto {
  @IsUUID()
  organizationId!: string;
}

export class OrganizationBodyDto {
  @IsUUID()
  organizationId!: string;
}

export class OAuthStartDto {
  @IsUUID()
  organizationId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsIn(GOOGLE_CAPABILITIES, { each: true })
  capabilities!: GoogleCapability[];
}

export class OAuthCompleteDto {
  @IsString()
  @Length(20, 200)
  state!: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  code?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  error?: string;
}

export class ServiceAccountDto {
  @IsUUID()
  organizationId!: string;

  /** The service-account JSON key file content (never echoed or stored as given). */
  @IsString()
  @Length(2, 20_000)
  keyJson!: string;

  @IsEmail()
  @MaxLength(320)
  impersonatedUser!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsIn(GOOGLE_CAPABILITIES, { each: true })
  capabilities!: GoogleCapability[];
}

export class MappingFieldDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  questionId!: string;

  @IsString()
  @Length(1, 64)
  field!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  label?: string;
}

export class MappingDto {
  @IsInt()
  @IsIn([1])
  schemaVersion!: 1;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => MappingFieldDto)
  fields!: MappingFieldDto[];

  @IsOptional()
  @IsIn(['QUIZ_TOTAL', 'NONE'])
  scoreSource?: 'QUIZ_TOTAL' | 'NONE';
}

export class BindingListQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}

export class CreateBindingDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{10,200}$/)
  formId!: string;

  @IsIn(TARGETS)
  target!: GoogleFormBindingTarget;

  @IsOptional()
  @IsUUID()
  performanceSourceId?: string;

  @IsOptional()
  @IsUUID()
  recruitmentSourceId?: string;

  @ValidateNested()
  @Type(() => MappingDto)
  mapping!: MappingDto;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateBindingDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => MappingDto)
  mapping?: MappingDto;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SyncRunsQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsUUID()
  bindingId?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;
}

/** A plain copy of a validated mapping DTO for the strict domain validator. */
export const plainMapping = (mapping: MappingDto) =>
  JSON.parse(JSON.stringify(mapping)) as unknown;
