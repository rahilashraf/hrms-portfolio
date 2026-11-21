import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { normalizeCodeValue } from '../organization/organization.dto.js';
import { BRANDING_LIMITS } from './branding-domain.js';

/**
 * Shapes only (types and outer length bounds); the https / color / email rules and the
 * normalization live in branding-domain.ts so the service enforces them on every path.
 * PUT is a full replacement: an omitted or null field is cleared.
 */
const nullableText = (max: number) => [
  IsOptional(),
  ValidateIf((_object: unknown, value: unknown) => value !== null),
  IsString(),
  MaxLength(max),
];

function NullableText(max: number): PropertyDecorator {
  return (target, key) => {
    for (const decorator of nullableText(max)) decorator(target, key);
  };
}

export class BrandingUpdateDto {
  @NullableText(BRANDING_LIMITS.displayName + 50)
  displayName?: string | null;

  @NullableText(BRANDING_LIMITS.shortName + 50)
  shortName?: string | null;

  @NullableText(BRANDING_LIMITS.url + 50)
  logoUrl?: string | null;

  @NullableText(BRANDING_LIMITS.url + 50)
  iconUrl?: string | null;

  @NullableText(BRANDING_LIMITS.url + 50)
  loginLogoUrl?: string | null;

  @NullableText(32)
  primaryColor?: string | null;

  @NullableText(32)
  secondaryColor?: string | null;

  @NullableText(BRANDING_LIMITS.loginSubtitle + 50)
  loginSubtitle?: string | null;

  @NullableText(BRANDING_LIMITS.url + 50)
  websiteUrl?: string | null;

  @NullableText(BRANDING_LIMITS.email + 50)
  supportEmail?: string | null;

  @IsOptional()
  @IsBoolean()
  publicLoginEnabled?: boolean;

  /** The version the change is based on (0 when the organization has no branding yet). */
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class PublicBrandingQueryDto {
  /** An organization code (normalized like organization codes). */
  @IsOptional()
  @Transform(({ value }) => normalizeCodeValue(value))
  @IsString()
  @Length(2, 64)
  @Matches(/^[A-Z0-9_-]+$/)
  organization?: string;
}
