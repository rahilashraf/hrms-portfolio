import { BadRequestException } from '@nestjs/common';
import { domainError } from '../common/domain-support.js';

/**
 * Phase 20 — organization branding rules (pure). Branding stores REFERENCES only: https URLs
 * to images hosted elsewhere (never uploads, binaries or data: URIs), #RRGGBB colors and short
 * text. The database CHECK constraints enforce the same rules as the final guard.
 */

export const BRANDING_LIMITS = Object.freeze({
  displayName: 120,
  shortName: 40,
  loginSubtitle: 200,
  url: 2048,
  email: 254,
});

export const BRANDING_URL_FIELDS = [
  'logoUrl',
  'iconUrl',
  'loginLogoUrl',
  'websiteUrl',
] as const;
export const BRANDING_TEXT_FIELDS = [
  'displayName',
  'shortName',
  'loginSubtitle',
] as const;
export const BRANDING_COLOR_FIELDS = [
  'primaryColor',
  'secondaryColor',
] as const;

/** Every stored field, in a stable order (audit `changedFields` uses these names). */
export const BRANDING_FIELDS = [
  'displayName',
  'shortName',
  'logoUrl',
  'iconUrl',
  'loginLogoUrl',
  'primaryColor',
  'secondaryColor',
  'loginSubtitle',
  'websiteUrl',
  'supportEmail',
  'publicLoginEnabled',
] as const;
export type BrandingField = (typeof BRANDING_FIELDS)[number];

export interface BrandingValues {
  displayName: string | null;
  shortName: string | null;
  logoUrl: string | null;
  iconUrl: string | null;
  loginLogoUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  loginSubtitle: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  publicLoginEnabled: boolean;
}

export type BrandingInput = Partial<
  Record<Exclude<BrandingField, 'publicLoginEnabled'>, string | null>
> & { publicLoginEnabled?: boolean | null };

export const EMPTY_BRANDING: Readonly<BrandingValues> = Object.freeze({
  displayName: null,
  shortName: null,
  logoUrl: null,
  iconUrl: null,
  loginLogoUrl: null,
  primaryColor: null,
  secondaryColor: null,
  loginSubtitle: null,
  websiteUrl: null,
  supportEmail: null,
  publicLoginEnabled: false,
});

const COLOR = /^#[0-9a-fA-F]{6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const invalid = (field: string, message: string) =>
  new BadRequestException(
    domainError(400, 'BRANDING_INVALID', message, { field }),
  );

function text(field: string, value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(field, `${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (CONTROL.test(trimmed))
    throw invalid(field, `${field} must not contain control characters.`);
  if (trimmed.length > max)
    throw invalid(field, `${field} must be at most ${max} characters.`);
  return trimmed;
}

/** An absolute https URL with a host and no credentials; anything else is refused. */
export function brandingUrl(field: string, value: unknown): string | null {
  const raw = text(field, value, BRANDING_LIMITS.url);
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(field, `${field} must be an absolute https URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username !== '' ||
    url.password !== '' ||
    /\s/.test(raw) ||
    !/^https:\/\/[^\s/?#@]+/i.test(raw)
  )
    throw invalid(field, `${field} must be an absolute https URL.`);
  // Stored as given (trimmed), so the reference is exactly what the administrator entered; it
  // must also satisfy the database pattern (lower-case scheme).
  if (!raw.startsWith('https://'))
    throw invalid(field, `${field} must start with https://.`);
  return raw;
}

export function brandingColor(field: string, value: unknown): string | null {
  const raw = text(field, value, 7);
  if (raw === null) return null;
  if (!COLOR.test(raw))
    throw invalid(field, `${field} must be a #RRGGBB color.`);
  return raw.toUpperCase();
}

export function brandingEmail(field: string, value: unknown): string | null {
  const raw = text(field, value, BRANDING_LIMITS.email);
  if (raw === null) return null;
  if (!EMAIL.test(raw))
    throw invalid(field, `${field} must be a valid email address.`);
  return raw;
}

/**
 * The normalized branding of a full replacement (PUT): every field not given is cleared, text
 * is trimmed (empty → null), colors are upper-cased.
 */
export function normalizeBranding(input: BrandingInput): BrandingValues {
  if (
    input.publicLoginEnabled !== undefined &&
    input.publicLoginEnabled !== null &&
    typeof input.publicLoginEnabled !== 'boolean'
  )
    throw invalid(
      'publicLoginEnabled',
      'publicLoginEnabled must be a boolean.',
    );
  return {
    displayName: text(
      'displayName',
      input.displayName,
      BRANDING_LIMITS.displayName,
    ),
    shortName: text('shortName', input.shortName, BRANDING_LIMITS.shortName),
    logoUrl: brandingUrl('logoUrl', input.logoUrl),
    iconUrl: brandingUrl('iconUrl', input.iconUrl),
    loginLogoUrl: brandingUrl('loginLogoUrl', input.loginLogoUrl),
    primaryColor: brandingColor('primaryColor', input.primaryColor),
    secondaryColor: brandingColor('secondaryColor', input.secondaryColor),
    loginSubtitle: text(
      'loginSubtitle',
      input.loginSubtitle,
      BRANDING_LIMITS.loginSubtitle,
    ),
    websiteUrl: brandingUrl('websiteUrl', input.websiteUrl),
    supportEmail: brandingEmail('supportEmail', input.supportEmail),
    publicLoginEnabled: input.publicLoginEnabled ?? false,
  };
}

/** Names of the fields whose value changes (names only: audit metadata never holds values). */
export function changedBrandingFields(
  before: BrandingValues,
  after: BrandingValues,
): BrandingField[] {
  return BRANDING_FIELDS.filter((field) => before[field] !== after[field]);
}

/** The branding summary carried by the workspace context (no login-page or contact fields). */
export interface BrandingSummary {
  displayName: string;
  shortName: string;
  logoUrl: string | null;
  iconUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
}

export function brandingSummary(
  organizationName: string,
  row: Partial<BrandingValues> | null | undefined,
): BrandingSummary | null {
  if (!row) return null;
  const displayName = row.displayName ?? organizationName;
  return {
    displayName,
    shortName: row.shortName ?? displayName,
    logoUrl: row.logoUrl ?? null,
    iconUrl: row.iconUrl ?? null,
    primaryColor: row.primaryColor ?? null,
    secondaryColor: row.secondaryColor ?? null,
  };
}

// ─── Public (unauthenticated) branding ───────────────────────────────────────

export interface PublicBranding {
  source: 'ORGANIZATION' | 'DEFAULT';
  displayName: string;
  shortName: string;
  loginLogoUrl: string | null;
  iconUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  loginSubtitle: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
}

export const DEFAULT_PUBLIC_BRANDING: Readonly<PublicBranding> = Object.freeze({
  source: 'DEFAULT',
  displayName: 'HRMS',
  shortName: 'HRMS',
  loginLogoUrl: null,
  iconUrl: null,
  primaryColor: null,
  secondaryColor: null,
  loginSubtitle: null,
  websiteUrl: null,
  supportEmail: null,
});

export interface PublicCandidate {
  name: string;
  archivedAt: Date | null;
  branding: (Partial<BrandingValues> & { publicLoginEnabled: boolean }) | null;
}

/** Exactly the public fields of an organization that opted in (never anything else). */
export function publicBrandingOf(candidate: PublicCandidate): PublicBranding {
  const branding = candidate.branding!;
  const displayName = branding.displayName ?? candidate.name;
  return {
    source: 'ORGANIZATION',
    displayName,
    shortName: branding.shortName ?? displayName,
    loginLogoUrl: branding.loginLogoUrl ?? null,
    iconUrl: branding.iconUrl ?? null,
    primaryColor: branding.primaryColor ?? null,
    secondaryColor: branding.secondaryColor ?? null,
    loginSubtitle: branding.loginSubtitle ?? null,
    websiteUrl: branding.websiteUrl ?? null,
    supportEmail: branding.supportEmail ?? null,
  };
}

const optedIn = (candidate: PublicCandidate | null | undefined) =>
  !!candidate &&
  candidate.archivedAt === null &&
  candidate.branding?.publicLoginEnabled === true;

/**
 * Resolution for the login page: the organization named by code when it opted in; otherwise
 * the only non-archived organization when exactly one exists and it opted in; otherwise the
 * generic default. An unknown code and a code that did not opt in answer exactly the same.
 */
export function resolvePublicBranding(input: {
  byCode: PublicCandidate | null;
  /** The non-archived organizations (at most two are needed to decide "exactly one"). */
  active: readonly PublicCandidate[];
}): PublicBranding {
  if (optedIn(input.byCode)) return publicBrandingOf(input.byCode!);
  if (input.active.length === 1 && optedIn(input.active[0]))
    return publicBrandingOf(input.active[0]!);
  return { ...DEFAULT_PUBLIC_BRANDING };
}
