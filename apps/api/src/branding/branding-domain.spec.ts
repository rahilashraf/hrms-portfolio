import { BadRequestException } from '@nestjs/common';
import {
  brandingSummary,
  changedBrandingFields,
  DEFAULT_PUBLIC_BRANDING,
  EMPTY_BRANDING,
  normalizeBranding,
  resolvePublicBranding,
  type PublicCandidate,
} from './branding-domain.js';

function invalidField(run: () => unknown) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as {
      code: string;
      field: string;
    };
    expect(body.code).toBe('BRANDING_INVALID');
    return body.field;
  }
  throw new Error('expected a validation error');
}

describe('branding validation', () => {
  it('normalizes a full replacement (trim, empty → null, upper-case colors)', () => {
    expect(
      normalizeBranding({
        displayName: '  Acme Health  ',
        shortName: '',
        logoUrl: 'https://cdn.example.com/logo.svg',
        primaryColor: '#1a2b3c',
        supportEmail: ' help@example.com ',
        publicLoginEnabled: true,
      }),
    ).toEqual({
      ...EMPTY_BRANDING,
      displayName: 'Acme Health',
      logoUrl: 'https://cdn.example.com/logo.svg',
      primaryColor: '#1A2B3C',
      supportEmail: 'help@example.com',
      publicLoginEnabled: true,
    });
    expect(normalizeBranding({})).toEqual(EMPTY_BRANDING);
  });

  it.each([
    ['logoUrl', 'http://cdn.example.com/logo.png'],
    ['logoUrl', 'data:image/png;base64,AAAA'],
    ['iconUrl', 'javascript:alert(1)'],
    ['loginLogoUrl', 'https://user:secret@example.com/logo.png'],
    ['websiteUrl', 'example.com'],
    ['websiteUrl', 'https://exa mple.com'],
    ['websiteUrl', `https://example.com/${'a'.repeat(2048)}`],
    ['primaryColor', 'red'],
    ['primaryColor', '#12345'],
    ['secondaryColor', '#GGGGGG'],
    ['supportEmail', 'not-an-email'],
    ['displayName', 'x'.repeat(121)],
    ['shortName', 'x'.repeat(41)],
    ['loginSubtitle', 'x'.repeat(201)],
    ['displayName', 'line\nbreak'],
  ])('refuses %s = %j', (field, value) => {
    expect(invalidField(() => normalizeBranding({ [field]: value }))).toBe(
      field,
    );
  });

  it('accepts https references with paths and queries', () => {
    expect(
      normalizeBranding({
        iconUrl: 'https://cdn.example.com/a/b/icon.png?v=2#x',
      }).iconUrl,
    ).toBe('https://cdn.example.com/a/b/icon.png?v=2#x');
  });

  it('reports changed field names only', () => {
    const after = normalizeBranding({
      displayName: 'Acme',
      publicLoginEnabled: true,
    });
    expect(changedBrandingFields(EMPTY_BRANDING, after)).toEqual([
      'displayName',
      'publicLoginEnabled',
    ]);
    expect(changedBrandingFields(after, after)).toEqual([]);
  });

  it('summarizes branding with the organization name as fallback', () => {
    expect(brandingSummary('Acme Inc', null)).toBeNull();
    expect(
      brandingSummary('Acme Inc', {
        ...EMPTY_BRANDING,
        primaryColor: '#000000',
      }),
    ).toEqual({
      displayName: 'Acme Inc',
      shortName: 'Acme Inc',
      logoUrl: null,
      iconUrl: null,
      primaryColor: '#000000',
      secondaryColor: null,
    });
  });
});

describe('public branding resolution', () => {
  const candidate = (
    name: string,
    branding: Partial<PublicCandidate['branding']> | null,
    archivedAt: Date | null = null,
  ): PublicCandidate => ({
    name,
    archivedAt,
    branding: branding
      ? { ...EMPTY_BRANDING, publicLoginEnabled: false, ...branding }
      : null,
  });
  const optedIn = candidate('Acme', {
    displayName: 'Acme Health',
    loginLogoUrl: 'https://cdn.example.com/login.png',
    logoUrl: 'https://cdn.example.com/private-logo.png',
    supportEmail: 'help@example.com',
    publicLoginEnabled: true,
  });
  const optedOut = candidate('Beta', {
    displayName: 'Beta',
    publicLoginEnabled: false,
  });

  it('resolves an opted-in organization by code, with only the public fields', () => {
    const result = resolvePublicBranding({
      byCode: optedIn,
      active: [optedIn, optedOut],
    });
    expect(result).toEqual({
      source: 'ORGANIZATION',
      displayName: 'Acme Health',
      shortName: 'Acme Health',
      loginLogoUrl: 'https://cdn.example.com/login.png',
      iconUrl: null,
      primaryColor: null,
      secondaryColor: null,
      loginSubtitle: null,
      websiteUrl: null,
      supportEmail: 'help@example.com',
    });
    expect(Object.keys(result).sort()).toEqual(
      Object.keys(DEFAULT_PUBLIC_BRANDING).sort(),
    );
    expect(JSON.stringify(result)).not.toContain('private-logo');
  });

  it('falls back to DEFAULT for a code that did not opt in, or is archived', () => {
    expect(
      resolvePublicBranding({ byCode: optedOut, active: [optedIn, optedOut] }),
    ).toEqual(DEFAULT_PUBLIC_BRANDING);
    const archived = { ...optedIn, archivedAt: new Date() };
    expect(
      resolvePublicBranding({ byCode: archived, active: [optedOut, optedOut] }),
    ).toEqual(DEFAULT_PUBLIC_BRANDING);
  });

  it('uses the single organization only when it is the only one and opted in', () => {
    expect(
      resolvePublicBranding({ byCode: null, active: [optedIn] }).source,
    ).toBe('ORGANIZATION');
    expect(resolvePublicBranding({ byCode: null, active: [optedOut] })).toEqual(
      DEFAULT_PUBLIC_BRANDING,
    );
    expect(
      resolvePublicBranding({ byCode: null, active: [optedIn, optedOut] }),
    ).toEqual(DEFAULT_PUBLIC_BRANDING);
    expect(
      resolvePublicBranding({ byCode: null, active: [candidate('X', null)] }),
    ).toEqual(DEFAULT_PUBLIC_BRANDING);
    expect(resolvePublicBranding({ byCode: null, active: [] })).toEqual(
      DEFAULT_PUBLIC_BRANDING,
    );
  });

  it('answers an unknown code exactly like a code that did not opt in', () => {
    const unknown = resolvePublicBranding({
      byCode: null,
      active: [optedIn, optedOut],
    });
    const notOptedIn = resolvePublicBranding({
      byCode: optedOut,
      active: [optedIn, optedOut],
    });
    expect(unknown).toEqual(notOptedIn);
  });
});
