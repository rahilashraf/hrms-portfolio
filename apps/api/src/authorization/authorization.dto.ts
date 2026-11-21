import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const ORGANIZATIONAL_SCOPE_TYPES = [
  'ORGANIZATION',
  'ORGANIZATIONAL_UNIT',
  'DEPARTMENT',
  'TEAM',
] as const;

export class RoleCreateDto {
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value.trim().replace(/\s+/g, '-').toUpperCase()
      : value,
  )
  @IsString()
  @Length(2, 64)
  @Matches(/^[A-Za-z0-9_-]+$/)
  code!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissionKeys!: string[];
}

export class RoleUpdateDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string | null;
}

export class RolePermissionsReplaceDto {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  permissionKeys!: string[];
}

export class AssignmentScopeDto {
  @IsIn(ORGANIZATIONAL_SCOPE_TYPES)
  type!: (typeof ORGANIZATIONAL_SCOPE_TYPES)[number];

  @IsUUID()
  id!: string;
}

export class RoleAssignmentCreateDto {
  @IsUUID()
  userId!: string;

  @IsUUID()
  roleId!: string;

  @ValidateNested()
  @Type(() => AssignmentScopeDto)
  scope!: AssignmentScopeDto;

  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;
}

export class RevokeRoleAssignmentDto {
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  reason?: string;
}

export class ActiveUserQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  query?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsUUID()
  afterId?: string;
}

export class AssignmentListQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  includeRevoked?: 'true' | 'false';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsUUID()
  afterId?: string;
}

/** Phase 20: role templates, optionally evaluated against one organization. */
export class RoleTemplateQueryDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}
