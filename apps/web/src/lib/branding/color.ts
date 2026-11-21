/**
 * Phase 20 — accessible accent colors from organization branding. A brand color is only used
 * where it keeps WCAG AA contrast (4.5:1); otherwise the default palette stays in place.
 */

/** The default accent (Tailwind indigo-700) and its text color. */
export const DEFAULT_ACCENT = '#4338CA';
export const DEFAULT_ON_ACCENT = '#FFFFFF';
export const MIN_CONTRAST = 4.5;

const HEX = /^#([0-9a-f]{6})$/i;
const WHITE = '#FFFFFF';
const DARK = '#0F172A';

export function isHexColor(value: string | null | undefined): value is string {
  return typeof value === 'string' && HEX.test(value);
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #RRGGBB color. */
export function relativeLuminance(hex: string): number {
  const match = HEX.exec(hex);
  if (!match) throw new Error('Expected a #RRGGBB color.');
  const n = parseInt(match[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two #RRGGBB colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** White or near-black text, whichever reads better on `background`. */
export function readableTextColor(background: string): string {
  return contrastRatio(background, WHITE) >= contrastRatio(background, DARK) ? WHITE : DARK;
}

export interface AccentPalette {
  /** Accent background (buttons, badges, indicators). */
  accent: string;
  /** Text on the accent background. */
  onAccent: string;
  /** The accent as text/indicator color on a white surface. */
  accentText: string;
  /** Secondary accent (decorative only); falls back to the accent. */
  secondary: string;
  /** Whether the brand color was used (false: default palette). */
  branded: boolean;
}

/**
 * The palette for a brand's primary/secondary colors: the brand color becomes the accent only
 * when a text color with ≥ 4.5:1 contrast exists on it; it is used as text on white only when
 * it itself has ≥ 4.5:1 against white.
 */
export function accentPalette(
  primary: string | null | undefined,
  secondary?: string | null,
): AccentPalette {
  const fallback: AccentPalette = {
    accent: DEFAULT_ACCENT,
    onAccent: DEFAULT_ON_ACCENT,
    accentText: DEFAULT_ACCENT,
    secondary: isHexColor(secondary) ? secondary.toUpperCase() : DEFAULT_ACCENT,
    branded: false,
  };
  if (!isHexColor(primary)) return fallback;
  const accent = primary.toUpperCase();
  const onAccent = readableTextColor(accent);
  if (contrastRatio(accent, onAccent) < MIN_CONTRAST) return fallback;
  return {
    accent,
    onAccent,
    accentText: contrastRatio(accent, WHITE) >= MIN_CONTRAST ? accent : DEFAULT_ACCENT,
    secondary: isHexColor(secondary) ? secondary.toUpperCase() : accent,
    branded: true,
  };
}

/** CSS custom properties for the palette (consumed by globals.css and the shell). */
export function accentStyle(palette: AccentPalette): Record<string, string> {
  return {
    '--hrms-accent': palette.accent,
    '--hrms-on-accent': palette.onAccent,
    '--hrms-accent-text': palette.accentText,
    '--hrms-secondary': palette.secondary,
  };
}
