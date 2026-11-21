'use client';

import type { CSSProperties } from 'react';
import { accentPalette, accentStyle, type AccentPalette } from '../../lib/branding/color';
import { cleanText, isSafeHttpsUrl, type BrandingFormValues } from '../../lib/branding/validation';
import { organizationInitials } from '../../lib/navigation/context';

/** Only https references are ever rendered as images (no referrer is sent). */
function BrandImage({
  src,
  alt,
  className,
}: {
  src: string | null;
  alt: string;
  className: string;
}) {
  if (!isSafeHttpsUrl(src)) return null;
  return (
    // Branding images are external https references chosen by administrators.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} referrerPolicy="no-referrer" className={className} />
  );
}

export function previewPalette(values: BrandingFormValues): AccentPalette {
  return accentPalette(cleanText(values.primaryColor), cleanText(values.secondaryColor));
}

/**
 * A live preview of the form values: the sidebar header and the sign-in card, as they will
 * look with the readable-contrast rules applied.
 */
export function BrandingPreview({
  values,
  organizationName,
}: {
  values: BrandingFormValues;
  organizationName: string;
}) {
  const palette = previewPalette(values);
  const displayName = cleanText(values.displayName) ?? organizationName;
  const shortName = cleanText(values.shortName) ?? displayName;
  const logo = cleanText(values.logoUrl);
  const icon = cleanText(values.iconUrl);
  const loginLogo = cleanText(values.loginLogoUrl);
  const subtitle = cleanText(values.loginSubtitle);
  const website = cleanText(values.websiteUrl);
  const support = cleanText(values.supportEmail);
  const style = accentStyle(palette) as CSSProperties;

  return (
    <section aria-labelledby="branding-preview-heading" className="space-y-4" style={style}>
      <h2 id="branding-preview-heading" className="text-lg font-semibold text-slate-950">
        Preview
      </h2>
      {!palette.branded && cleanText(values.primaryColor) && (
        <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          The primary color does not keep readable contrast (4.5:1) for button text, so the default
          accent is used instead.
        </p>
      )}
      <figure
        className="rounded-xl border border-slate-200 bg-white p-4"
        aria-label="Sidebar preview"
      >
        <figcaption className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Sidebar
        </figcaption>
        <div className="mt-3 flex items-center gap-2 font-semibold text-[var(--hrms-accent-text)]">
          {isSafeHttpsUrl(logo) ? (
            <BrandImage
              src={logo}
              alt={`${displayName} logo`}
              className="h-8 max-w-[9rem] object-contain"
            />
          ) : (
            <span>{shortName}</span>
          )}
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-2">
          {isSafeHttpsUrl(icon) ? (
            <BrandImage
              src={icon}
              alt={`${displayName} icon`}
              className="size-8 rounded-lg object-cover"
            />
          ) : (
            <span
              aria-hidden="true"
              className="inline-flex size-8 items-center justify-center rounded-lg text-xs font-semibold"
              style={{ backgroundColor: palette.accent, color: palette.onAccent }}
            >
              {organizationInitials(shortName)}
            </span>
          )}
          <span className="truncate text-sm font-semibold text-slate-900">{shortName}</span>
        </div>
        <p className="relative mt-3 rounded-lg bg-indigo-50 px-3 py-2 text-sm font-medium text-slate-900 before:absolute before:inset-y-1 before:left-0 before:w-1 before:rounded-full before:bg-[var(--hrms-accent-text)]">
          Active page
        </p>
      </figure>
      <figure
        className="overflow-hidden rounded-xl border border-slate-200 bg-white"
        aria-label="Sign-in preview"
      >
        <div aria-hidden="true" className="h-1.5" style={{ backgroundColor: palette.secondary }} />
        <div className="p-4">
          <figcaption className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Sign-in page
          </figcaption>
          <div className="mt-3 flex items-center gap-3 text-sm font-semibold text-[var(--hrms-accent-text)]">
            <BrandImage
              src={isSafeHttpsUrl(loginLogo) ? loginLogo : icon}
              alt={`${displayName} sign-in logo`}
              className="h-10 max-w-[10rem] object-contain"
            />
            <span>{displayName}</span>
          </div>
          {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
          <p className="mt-4 text-base font-semibold text-slate-950">Sign in to your account</p>
          <span
            className="mt-3 block w-full rounded-lg px-4 py-2 text-center text-sm font-semibold"
            style={{ backgroundColor: palette.accent, color: palette.onAccent }}
          >
            Sign in
          </span>
          {(isSafeHttpsUrl(website) || support) && (
            <p className="mt-3 flex gap-4 text-xs font-medium text-[var(--hrms-accent-text)]">
              {isSafeHttpsUrl(website) && <span>Website</span>}
              {support && <span>Contact support</span>}
            </p>
          )}
          {!values.publicLoginEnabled && (
            <p className="mt-3 text-xs text-slate-500">
              Not shown publicly: the sign-in page uses generic HRMS branding until public sign-in
              branding is turned on.
            </p>
          )}
        </div>
      </figure>
    </section>
  );
}
