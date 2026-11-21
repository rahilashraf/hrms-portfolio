import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Shapes only: modules, keys and values are validated against the registry in the service. */

const toInt = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export class FeatureOrganizationQueryDto {
  @IsUUID()
  organizationId!: string;
}

export class FeatureHistoryQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsISO8601({ strict: true })
  before?: string;
}

export class SetModuleDto {
  @IsUUID()
  organizationId!: string;

  @IsBoolean()
  enabled!: boolean;

  /** The version the change is based on (0 when the module was never changed). */
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class SetSettingDto {
  @IsUUID()
  organizationId!: string;

  /** Boolean, integer or enum value: checked strictly against the setting's registry type. */
  @IsDefined()
  value!: unknown;

  @IsInt()
  @Min(0)
  expectedVersion!: number;

  /** M2: required (10–500 characters) to relax a guarded setting such as payroll dual control. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** M2: explicit confirmation required to relax a guarded setting. */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

export class ResetSettingDto {
  @IsUUID()
  organizationId!: string;

  @IsInt()
  @Min(0)
  expectedVersion!: number;

  /** M2: required (10–500 characters) to relax a guarded setting such as payroll dual control. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** M2: explicit confirmation required to relax a guarded setting. */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}
