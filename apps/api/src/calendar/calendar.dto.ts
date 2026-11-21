import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const HOLIDAY_KINDS = ['STATUTORY_HOLIDAY', 'CLOSURE'] as const;

export class HolidayListQueryDto {
  @IsUUID()
  organizationId!: string;

  @IsString()
  @Matches(DATE_ONLY)
  from!: string;

  @IsString()
  @Matches(DATE_ONLY)
  to!: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeArchived?: boolean;
}

export class CreateHolidayDto {
  @IsUUID()
  organizationId!: string;

  /** At most one: limits the holiday to a unit (and its descendants), department or team. */
  @IsOptional()
  @IsUUID()
  organizationalUnitId?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsString()
  @Matches(DATE_ONLY)
  date!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @IsIn(HOLIDAY_KINDS)
  kind!: (typeof HOLIDAY_KINDS)[number];
}

export class UpdateHolidayDto {
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  date?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsIn(HOLIDAY_KINDS)
  kind?: (typeof HOLIDAY_KINDS)[number];
}
