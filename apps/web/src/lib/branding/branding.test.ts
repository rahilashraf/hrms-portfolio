import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import {
  brandingApi,
  brandingInvalidField,
  isBrandingConflict,
  normalizeOrganizationCode,
  parsePublicBranding,
} from './api';
import {
  accentPalette,
  contrastRatio,
  DEFAULT_ACCENT,
  readableTextColor,
  relativeLuminance,
} from './color';
import { DEFAULT_PUBLIC_BRANDING } from './types';
import {
  brandingPayload,
  isSafeHttpsUrl,
  validateBranding,
  type BrandingFormValues,
} from './validation';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../auth/api-client', () => ({ apiRequest }));

const blank: BrandingFormValues = {
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
};

afterEach(() => apiRequest.mockReset());

describe('accent colors', () => {
  it('computes WCAG luminance and contrast', () => {
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1);
    expect(relativeLuminance('#000000')).toBe(0);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21);
    expect(contrastRatio('#4338CA', '#FFFFFF')).toBeGreaterThan(4.5);
  });

  it('picks a readable text color for the accent', () => {
    expect(readableTextColor('#0F766E')).toBe('#FFFFFF');
    expect(readableTextColor('#FDE047')).toBe('#0F172A');
  });

  it('uses a brand color with readable button text, and as text only when it contrasts with white', () => {
    const dark = accentPalette('#0f766e', '#f59e0b');
    expect(dark).toMatchObject({
      accent: '#0F766E',
      onAccent: '#FFFFFF',
      accentText: '#0F766E',
      secondary: '#F59E0B',
      branded: true,
    });
    const light = accentPalette('#FDE047');
    expect(light.branded).toBe(true);
    expect(light.onAccent).toBe('#0F172A');
    // Yellow on white is unreadable as text: the default accent is used for text.
    expect(light.accentText).toBe(DEFAULT_ACCENT);
  });

  it('falls back to the default palette below 4.5:1 or for invalid colors', () => {
    // Mid grey: neither white nor dark text reaches 4.5:1.
    expect(accentPalette('#777777').branded).toBe(false);
    expect(accentPalette('#777777').accent).toBe(DEFAULT_ACCENT);
    expect(accentPalette('red').branded).toBe(false);
    expect(accentPalette(null).accent).toBe(DEFAULT_ACCENT);
  });
});

describe('branding validation', () => {
  it('accepts only absolute https URLs without credentials', () => {
    expect(isSafeHttpsUrl('https://cdn.example.com/logo.png')).toBe(true);
    for (const bad of [
      'http://cdn.example.com/logo.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      '//cdn.example.com/logo.png',
      'https://user:pass@cdn.example.com/logo.png',
      'https://exa mple.com/logo.png',
      'HTTPS://cdn.example.com/logo.png',
      null,
    ])
      expect(isSafeHttpsUrl(bad), String(bad)).toBe(false);
  });

  it('reports field errors for URLs, colors, email and lengths', () => {
    const errors = validateBranding({
      ...blank,
      displayName: 'x'.repeat(121),
      logoUrl: 'http://insecure.example.com/logo.png',
      primaryColor: '#12345',
      supportEmail: 'not-an-email',
    });
    expect(errors.displayName).toMatch(/at most 120/);
    expect(errors.logoUrl).toMatch(/https/);
    expect(errors.primaryColor).toMatch(/#RRGGBB/);
    expect(errors.supportEmail).toMatch(/valid email/);
    expect(validateBranding({ ...blank, primaryColor: '#0f766e' })).toEqual({});
  });

  it('builds a full-replacement payload (trimmed, empty → null, colors upper-cased)', () => {
    expect(
      brandingPayload(
        { ...blank, displayName: '  Northwind  ', shortName: '  ', primaryColor: '#0f766e' },
        3,
      ),
    ).toEqual({
      ...blank,
      displayName: 'Northwind',
      shortName: null,
      primaryColor: '#0F766E',
      expectedVersion: 3,
    });
  });
});

describe('public branding', () => {
  it('keeps only known public fields and only https URLs', () => {
    const parsed = parsePublicBranding({
      source: 'ORGANIZATION',
      displayName: 'Northwind Academy',
      shortName: 'Northwind',
      loginLogoUrl: 'http://insecure.example.com/logo.png',
      iconUrl: 'https://cdn.example.com/icon.png',
      primaryColor: '#0f766e',
      secondaryColor: 'blue',
      loginSubtitle: 'Staff sign-in',
      websiteUrl: 'javascript:alert(1)',
      supportEmail: 'help@example.com',
      // Unknown fields are dropped.
      organizationId: 'org-1',
      publicLoginEnabled: true,
      updatedByUserId: 'user-1',
    });
    expect(parsed).toEqual({
      source: 'ORGANIZATION',
      displayName: 'Northwind Academy',
      shortName: 'Northwind',
      loginLogoUrl: null,
      iconUrl: 'https://cdn.example.com/icon.png',
      primaryColor: '#0F766E',
      secondaryColor: null,
      loginSubtitle: 'Staff sign-in',
      websiteUrl: null,
      supportEmail: 'help@example.com',
    });
    expect(Object.keys(parsed)).not.toContain('organizationId');
  });

  it('falls back to generic HRMS branding for unexpected shapes', () => {
    expect(parsePublicBranding(null)).toEqual(DEFAULT_PUBLIC_BRANDING);
    expect(parsePublicBranding({ displayName: '' })).toEqual(DEFAULT_PUBLIC_BRANDING);
    expect(parsePublicBranding([])).toEqual(DEFAULT_PUBLIC_BRANDING);
  });

  it('requests unauthenticated with a normalized organization code, never throwing', async () => {
    apiRequest.mockResolvedValueOnce({ source: 'DEFAULT', displayName: 'HRMS', shortName: 'HRMS' });
    await brandingApi.publicBranding(' nwa ');
    expect(apiRequest).toHaveBeenCalledWith('/public/branding?organization=NWA', {
      authenticated: false,
      retryUnauthorized: false,
    });
    apiRequest.mockResolvedValueOnce({});
    await brandingApi.publicBranding('<script>');
    expect(apiRequest).toHaveBeenLastCalledWith('/public/branding', expect.anything());
    apiRequest.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(brandingApi.publicBranding()).resolves.toEqual(DEFAULT_PUBLIC_BRANDING);
    expect(normalizeOrganizationCode('a')).toBeNull();
  });

  it('recognizes version conflicts and invalid fields', () => {
    expect(
      isBrandingConflict(
        new AuthApiError('conflict', 409, 'x', {
          code: 'BRANDING_VERSION_CONFLICT',
          currentVersion: 4,
        }),
      ),
    ).toBe(true);
    expect(isBrandingConflict(new AuthApiError('conflict', 409, 'x', { code: 'OTHER' }))).toBe(
      false,
    );
    expect(
      brandingInvalidField(
        new AuthApiError('validation', 400, 'x', { code: 'BRANDING_INVALID', field: 'logoUrl' }),
      ),
    ).toBe('logoUrl');
  });
});
