/**
 * Batch 3A — shared style tokens. Modules that defined their own copies (inputClass,
 * primaryButton, secondaryButton, dangerButton) now re-export these, so existing imports keep
 * working and new code imports from here. Colors that follow organization branding use the
 * --hrms-accent* custom properties (app/globals.css, lib/branding/color.ts).
 */
import { buttonClass } from './button';

export { buttonClass };

/**
 * Text inputs, selects and textareas: full width under their label. Batch 10F: a visible focus
 * ring in the accent text colour (as on buttons and checkboxes) instead of the browser default,
 * which some controls (date inputs focus an inner field) do not draw on the control itself.
 */
export const inputClass =
  'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 focus:outline-hidden focus:ring-2 focus:ring-[var(--hrms-accent-text)] disabled:bg-slate-50 disabled:text-slate-600 aria-[invalid=true]:border-rose-600';

/** The button styles modules used to define themselves. */
export const primaryButton = buttonClass('primary');
export const secondaryButton = buttonClass('secondary');
/** Outlined destructive trigger (opens a confirmation); the confirm button is `destructive`. */
export const dangerButton = buttonClass('danger');

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const BADGE_TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  info: 'bg-sky-100 text-sky-900',
  success: 'bg-emerald-100 text-emerald-900',
  warning: 'bg-amber-100 text-amber-900',
  danger: 'bg-rose-100 text-rose-900',
};

/** A small status pill; every tone keeps at least 4.5:1 text contrast. */
export function badgeClass(tone: Tone = 'neutral'): string {
  return `inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${BADGE_TONES[tone]}`;
}

/**
 * Batch 10E-2: a native checkbox at 24 × 24 px (WCAG 2.2 target size, also on a phone), in the
 * organization's accent, with the brand focus ring. Used where a checkbox stands next to its own
 * label text (performance, benefits, notifications, documents).
 */
export const checkboxClass =
  'size-6 shrink-0 cursor-pointer rounded border-slate-300 accent-[var(--hrms-accent)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)] focus-visible:ring-offset-2 disabled:cursor-not-allowed';
