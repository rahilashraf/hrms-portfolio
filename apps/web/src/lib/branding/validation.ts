/**
 * Phase 20 — client-side branding checks mirroring the API rules (the API stays
 * authoritative and re-validates every field).
 */
import type { BrandingInput } from './types';

export const BRANDING_LIMITS = Object.freeze({
  displayName: 120,
  shortName: 40,
  loginSubtitle: 200,
  url: 2048,
  email: 254,
});

export type BrandingFormValues = Omit<BrandingInput, 'expectedVersion'>;
export type BrandingFormField = keyof BrandingFormValues;
export type BrandingErrors = Partial<Record<BrandingFormField, string>>;

export const BRANDING_URL_FIELDS = ['logoUrl', 'iconUrl', 'loginLogoUrl', 'websiteUrl'] as const;

const CONTROL = /[\u0000-\u001f\u007f]/;
const COLOR = /^#[0-9a-f]{6}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An absolute `https://` URL with a host and no credentials (the API's rule). */
export function isSafeHttpsUrl(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw.startsWith('https://') || /\s/.test(raw) || raw.length > BRANDING_LIMITS.url) {
    return false;
  }
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname) &&
      url.username === '' &&
      url.password === '' &&
      /^https:\/\/[^\s/?#@]+/i.test(raw)
    );
  } catch {
    return false;
  }
}

/** Trimmed text, or null when empty. */
export function cleanText(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function textError(label: string, value: string | null, max: number): string | undefined {
  if (value === null) return undefined;
  if (CONTROL.test(value)) return `${label} must not contain control characters.`;
  if (value.length > max) return `${label} must be at most ${max} characters.`;
  return undefined;
}

const URL_LABELS: Record<(typeof BRANDING_URL_FIELDS)[number], string> = {
  logoUrl: 'Logo URL',
  iconUrl: 'Icon URL',
  loginLogoUrl: 'Sign-in logo URL',
  websiteUrl: 'Website',
};

/** Field errors for a branding form (empty object when valid). Values are cleaned first. */
export function validateBranding(values: BrandingFormValues): BrandingErrors {
  const errors: BrandingErrors = {};
  const set = (field: BrandingFormField, message: string | undefined) => {
    if (message) errors[field] = message;
  };
  set(
    'displayName',
    textError('Display name', cleanText(values.displayName), BRANDING_LIMITS.displayName),
  );
  set('shortName', textError('Short name', cleanText(values.shortName), BRANDING_LIMITS.shortName));
  set(
    'loginSubtitle',
    textError('Sign-in subtitle', cleanText(values.loginSubtitle), BRANDING_LIMITS.loginSubtitle),
  );
  for (const field of BRANDING_URL_FIELDS) {
    const value = cleanText(values[field]);
    if (value !== null && !isSafeHttpsUrl(value)) {
      errors[field] = `${URL_LABELS[field]} must be an absolute https:// address.`;
    }
  }
  for (const [field, label] of [
    ['primaryColor', 'Primary color'],
    ['secondaryColor', 'Secondary color'],
  ] as const) {
    const value = cleanText(values[field]);
    if (value !== null && !COLOR.test(value)) errors[field] = `${label} must be a #RRGGBB color.`;
  }
  const email = cleanText(values.supportEmail);
  if (email !== null && (email.length > BRANDING_LIMITS.email || !EMAIL.test(email))) {
    errors.supportEmail = 'Support email must be a valid email address.';
  }
  return errors;
}

/** The PUT body for the form values (text trimmed, empty → null, colors upper-cased). */
export function brandingPayload(
  values: BrandingFormValues,
  expectedVersion: number,
): BrandingInput {
  const color = (value: string | null) => cleanText(value)?.toUpperCase() ?? null;
  return {
    displayName: cleanText(values.displayName),
    shortName: cleanText(values.shortName),
    logoUrl: cleanText(values.logoUrl),
    iconUrl: cleanText(values.iconUrl),
    loginLogoUrl: cleanText(values.loginLogoUrl),
    primaryColor: color(values.primaryColor),
    secondaryColor: color(values.secondaryColor),
    loginSubtitle: cleanText(values.loginSubtitle),
    websiteUrl: cleanText(values.websiteUrl),
    supportEmail: cleanText(values.supportEmail),
    publicLoginEnabled: values.publicLoginEnabled,
    expectedVersion,
  };
}
