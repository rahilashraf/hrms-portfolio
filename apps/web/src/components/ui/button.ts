/**
 * Consistent button styles. Every variant has a visible focus ring (Batch 10A): a 2px ring with an
 * offset, in the organization's accent text color (kept at 4.5:1 or more on white by branding) or
 * rose-700 for destructive variants, so the indicator keeps at least 3:1 against the page.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

/**
 * Batch 10E-2: transitions animate colours, the focus ring and hover brightness, never opacity.
 * With `transition` (which includes opacity) a button that became enabled stayed partly
 * transparent for 150 ms, so its text was briefly below 4.5:1 contrast while already usable
 * (the intermittent axe `color-contrast` failure in batch-9-documents). Disabled stays at 60%
 * opacity with a not-allowed cursor; enabling is now instant.
 */
const BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg font-semibold shadow-sm transition-[color,background-color,border-color,box-shadow,filter] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';
const VARIANTS: Record<ButtonVariant, string> = {
  // The accent follows organization branding (CSS custom properties; default indigo-700).
  primary:
    'bg-[var(--hrms-accent)] text-[var(--hrms-on-accent)] hover:brightness-110 focus-visible:ring-[var(--hrms-accent-text)]',
  secondary:
    'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus-visible:ring-[var(--hrms-accent-text)]',
  destructive: 'bg-rose-700 text-white hover:bg-rose-600 focus-visible:ring-rose-700',
  // Outlined: a destructive action's trigger, before its confirmation.
  danger:
    'border border-rose-300 bg-white text-rose-800 hover:bg-rose-50 focus-visible:ring-rose-700',
  ghost:
    'text-slate-700 shadow-none hover:bg-slate-100 focus-visible:ring-[var(--hrms-accent-text)]',
};
const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
};

export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md'): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]}`;
}
