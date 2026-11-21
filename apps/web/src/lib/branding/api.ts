import { apiRequest } from '../auth/api-client';
import { AuthApiError } from '../auth/types';
import { isHexColor } from './color';
import { DEFAULT_PUBLIC_BRANDING } from './types';
import type { BrandingInput, BrandingView, PublicBranding } from './types';
import { isSafeHttpsUrl } from './validation';

const enc = encodeURIComponent;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 500): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
const url = (value: unknown): string | null =>
  isSafeHttpsUrl(text(value, 2048)) ? text(value, 2048) : null;
const color = (value: unknown): string | null => {
  const raw = text(value, 7);
  return isHexColor(raw) ? raw.toUpperCase() : null;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const email = (value: unknown): string | null => {
  const raw = text(value, 254);
  return raw && EMAIL.test(raw) ? raw : null;
};
const CODE = /^[A-Z0-9_-]{2,64}$/;

/**
 * Picks ONLY the known public fields from the response, dropping anything else, and keeps
 * only https image/website URLs. Any unexpected shape yields the generic default.
 */
export function parsePublicBranding(value: unknown): PublicBranding {
  if (!isRecord(value)) return { ...DEFAULT_PUBLIC_BRANDING };
  const displayName = text(value.displayName, 120);
  if (!displayName) return { ...DEFAULT_PUBLIC_BRANDING };
  return {
    source: value.source === 'ORGANIZATION' ? 'ORGANIZATION' : 'DEFAULT',
    displayName,
    shortName: text(value.shortName, 40) ?? displayName,
    loginLogoUrl: url(value.loginLogoUrl),
    iconUrl: url(value.iconUrl),
    primaryColor: color(value.primaryColor),
    secondaryColor: color(value.secondaryColor),
    loginSubtitle: text(value.loginSubtitle, 200),
    websiteUrl: url(value.websiteUrl),
    supportEmail: email(value.supportEmail),
  };
}

/** The organization code for `?organization=` (normalized like the API), else null. */
export function normalizeOrganizationCode(value: string | null | undefined): string | null {
  const code = (value ?? '').trim().toUpperCase();
  return CODE.test(code) ? code : null;
}

export const brandingApi = {
  get(organizationId: string): Promise<BrandingView> {
    return apiRequest(`/organizations/${enc(organizationId)}/branding`);
  },
  update(organizationId: string, input: BrandingInput): Promise<BrandingView> {
    return apiRequest(`/organizations/${enc(organizationId)}/branding`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },
  /**
   * PUBLIC (no credentials). Never throws: any failure (network, 4xx/5xx, bad shape) yields
   * the generic default so the sign-in page is never blocked by branding.
   */
  async publicBranding(organizationCode?: string | null): Promise<PublicBranding> {
    const code = normalizeOrganizationCode(organizationCode);
    try {
      const value = await apiRequest<unknown>(
        `/public/branding${code ? `?organization=${enc(code)}` : ''}`,
        { authenticated: false, retryUnauthorized: false },
      );
      return parsePublicBranding(value);
    } catch {
      return { ...DEFAULT_PUBLIC_BRANDING };
    }
  },
};

/** The domain error code of an API failure (e.g. BRANDING_VERSION_CONFLICT), if any. */
export function apiErrorCode(cause: unknown): string | null {
  if (!(cause instanceof AuthApiError)) return null;
  const code = cause.details?.code;
  return typeof code === 'string' ? code : null;
}

export function isBrandingConflict(cause: unknown): boolean {
  return (
    cause instanceof AuthApiError &&
    cause.status === 409 &&
    apiErrorCode(cause) === 'BRANDING_VERSION_CONFLICT'
  );
}

/** The form field an API BRANDING_INVALID error names, if any. */
export function brandingInvalidField(cause: unknown): string | null {
  if (!(cause instanceof AuthApiError) || apiErrorCode(cause) !== 'BRANDING_INVALID') return null;
  const field = cause.details?.field;
  return typeof field === 'string' ? field : null;
}

export function brandingErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof AuthApiError)) return fallback;
  if (cause.status === 403)
    return 'You do not have permission to manage branding for this organization.';
  if (cause.status === 404) return 'This organization is not available.';
  if (cause.status === 400) return cause.validationMessage ?? 'Check the highlighted fields.';
  if (cause.status === 429) return 'Too many requests. Try again shortly.';
  if (cause.status >= 500) return 'The service is unavailable. Try again shortly.';
  return fallback;
}
