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
  ValidateNested,
} from 'class-validator';
import type { NotificationCategory } from '../generated/prisma/client.js';
import { NOTIFICATION_CATEGORIES } from './notifications-domain.js';

/** Shapes only: business rules live in the services and the notifications domain. */

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;
const toInt = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
const TYPE_KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export class InboxQueryDto {
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  archived?: boolean;

  @IsOptional()
  @IsUUID()
  organizationId?: string;
}

export class ReadAllDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}

export class CategoryEmailDto {
  @IsIn(NOTIFICATION_CATEGORIES)
  category!: NotificationCategory;

  @IsBoolean()
  emailEnabled!: boolean;
}

export class PreferencesDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CategoryEmailDto)
  preferences!: CategoryEmailDto[];
}

export class OrganizationQueryDto {
  @IsUUID()
  organizationId!: string;
}

export class TemplateListQueryDto extends OrganizationQueryDto {
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeArchived?: boolean;
}

export class CreateTemplateDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Matches(TYPE_KEY)
  @Length(3, 100)
  key!: string;

  @IsString()
  @Length(1, 200)
  subjectTemplate!: string;

  @IsString()
  @Length(1, 2000)
  bodyTemplate!: string;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  subjectTemplate?: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  bodyTemplate?: string;
}

export class PreviewQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Matches(TYPE_KEY)
  @Length(3, 100)
  key!: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  subjectTemplate?: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  bodyTemplate?: string;
}

export class OrganizationSettingsDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  suppressMandatoryEmail?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CategoryEmailDto)
  categories?: CategoryEmailDto[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Batch 8: delivery log filters (organization-scoped, cursor paged). */
export class DeliveryLogQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsString()
  @Matches(TYPE_KEY)
  @Length(3, 100)
  type?: string;

  @IsOptional()
  @IsIn(NOTIFICATION_CATEGORIES)
  category?: NotificationCategory;

  @IsOptional()
  @IsIn(['IN_APP', 'EMAIL'])
  channel?: 'IN_APP' | 'EMAIL';

  @IsOptional()
  @IsIn(['PENDING', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED'])
  status?: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SUPPRESSED';

  @IsOptional()
  @Matches(DATE_ONLY)
  from?: string;

  @IsOptional()
  @Matches(DATE_ONLY)
  to?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  recipient?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
