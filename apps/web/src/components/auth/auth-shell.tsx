'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { InputHTMLAttributes } from 'react';
import Link from 'next/link';
import { accentPalette, accentStyle } from '../../lib/branding/color';
import type { PublicBranding } from '../../lib/branding/types';
import { isSafeHttpsUrl } from '../../lib/branding/validation';
import { useDocumentTitle } from '../ui/use-document-title';

/**
 * The signed-out card. With `branding` (the PUBLIC login branding) it shows the organization's
 * logo (https references only, no referrer), name, subtitle, accent and contact links; without
 * it, the generic HRMS presentation.
 */
export function AuthShell({
  title,
  description,
  children,
  branding = null,
}: {
  title: string;
  description: string;
  children: ReactNode;
  branding?: PublicBranding | null;
}) {
  const palette = accentPalette(branding?.primaryColor, branding?.secondaryColor);
  const name = branding?.displayName || 'HRMS';
  const logo = [branding?.loginLogoUrl, branding?.iconUrl].find((url) => isSafeHttpsUrl(url));
  const website = isSafeHttpsUrl(branding?.websiteUrl) ? branding!.websiteUrl! : null;
  const support = branding?.supportEmail ?? null;
  // Batch 11C: each signed-out page names itself (forgot password, reset, invitation…); a page
  // that sets its own title (sign-in) still wins, because a parent's effect runs after this one.
  useDocumentTitle(`${title} · ${branding?.shortName || name}`);
  return (
    <main
      className="flex min-h-screen items-center justify-center px-4 py-12"
      style={accentStyle(palette) as CSSProperties}
    >
      <section
        aria-label={`${name} sign-in`}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
      >
        <div aria-hidden="true" className="h-1.5 bg-[var(--hrms-secondary)]" />
        <div className="p-8">
          <Link
            href="/"
            className="inline-flex items-center gap-3 text-sm font-semibold tracking-wide text-[var(--hrms-accent-text)]"
          >
            {logo && (
              // Branding images are external https references chosen by administrators.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logo}
                alt={`${name} logo`}
                referrerPolicy="no-referrer"
                className="h-10 max-w-[12rem] object-contain"
              />
            )}
            <span>{name}</span>
          </Link>
          {branding?.loginSubtitle && (
            <p className="mt-2 text-sm text-slate-600">{branding.loginSubtitle}</p>
          )}
          <h1 className="mt-6 text-2xl font-semibold tracking-tight text-slate-950">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
          <div className="mt-7">{children}</div>
          {(website || support) && (
            <nav
              aria-label="Organization links"
              className="mt-6 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-4 text-sm"
            >
              {website && (
                <a
                  href={website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-[var(--hrms-accent-text)] hover:underline"
                >
                  Website
                </a>
              )}
              {support && (
                <a
                  href={`mailto:${support}`}
                  className="font-medium text-[var(--hrms-accent-text)] hover:underline"
                >
                  Contact support
                </a>
              )}
            </nav>
          )}
        </div>
      </section>
    </main>
  );
}

export function FormField({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block text-sm font-medium text-slate-700">
      {label}
      <input
        {...props}
        className="mt-2 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-slate-950 shadow-sm transition focus:border-indigo-500 focus:outline-hidden focus:ring-2 focus:ring-[var(--hrms-accent-text)] disabled:bg-slate-100"
      />
    </label>
  );
}

/**
 * Batch 10F: like the shared `buttonClass` (Batch 10E-2), the submit button transitions colours,
 * the focus ring and hover brightness, never opacity. With `transition` a button that was
 * re-enabled after a failed attempt stayed partly transparent for 150 ms, so its text was briefly
 * below 4.5:1 contrast while already usable. While submitting it stays disabled at 60% opacity
 * with a wait cursor and says "Please wait…".
 */
export const authSubmitButtonClass =
  'w-full rounded-lg bg-[var(--hrms-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--hrms-on-accent)] shadow-sm transition-[color,background-color,border-color,box-shadow,filter] hover:brightness-110 focus:outline-hidden focus:ring-2 focus:ring-[var(--hrms-accent-text)] focus:ring-offset-2 disabled:cursor-wait disabled:opacity-60';

export function SubmitButton({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <button type="submit" disabled={busy} className={authSubmitButtonClass}>
      {busy ? 'Please wait…' : children}
    </button>
  );
}

export function FormMessage({
  children,
  success = false,
}: {
  children: ReactNode;
  success?: boolean;
}) {
  return (
    <p
      role={success ? 'status' : 'alert'}
      className={`rounded-lg px-3 py-2 text-sm ${
        success ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'
      }`}
    >
      {children}
    </p>
  );
}
