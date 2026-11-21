/**
 * Phase 20 — organization branding. Branding stores references only (https image URLs,
 * #RRGGBB colors and short text); the API validates and stays authoritative.
 */

/** GET/PUT /organizations/:organizationId/branding */
export interface BrandingView {
  organizationId: string;
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
  /** 0 = the organization has no branding yet. */
  version: number;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

/** PUT body: a full replacement (omitted/null clears the field). */
export interface BrandingInput {
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
  expectedVersion: number;
}

/** PUBLIC GET /public/branding — presentation fields only. */
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
