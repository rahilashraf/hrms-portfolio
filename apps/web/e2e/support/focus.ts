import { expect, type Page } from '@playwright/test';

/**
 * Batch 11C — keyboard focus indicators in ordinary display and in Windows forced-colours mode.
 *
 * - Ordinary display: the focused control has an outline or a ring (an opaque box-shadow layer),
 *   and that indicator's colour has at least 3:1 contrast with the background behind the control
 *   (WCAG 1.4.11 non-text contrast).
 * - Forced colours (`page.emulateMedia({ forcedColors: 'active' })`): box-shadows are removed, so
 *   only a painted outline counts. The system chooses its colour, so no contrast is computed.
 *
 * Chromium's forced-colours emulation applies the same style adjustments as Windows high contrast
 * (box-shadow none, system colours) but it is not a real Windows session.
 */
export type FocusMode = 'ordinary' | 'forced';

export interface FocusStop {
  label: string;
  visible: boolean;
  contrast: number | null;
}

/** The focused element's indicator, read in the page. `null` when focus left `scope`. */
export function readFocus(page: Page, mode: FocusMode, scope: string | null) {
  return page.evaluate(
    ({ mode, scope }) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      if (scope && !el.closest(scope)) return null;
      const label = `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} ${(
        el.getAttribute('aria-label') ??
        el.textContent ??
        ''
      )
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 40)}`;
      // Focus inside a native control's own UI (a date input's calendar button): the browser
      // draws that indicator and the host does not match :focus.
      if (!el.matches(':focus')) return { label, visible: true, contrast: null };

      // Computed colours can be rgb(), lab(), oklch()… (Tailwind 4's palette). color-mix() in
      // sRGB normalises any of them to `color(srgb r g b / a)`.
      const probe = document.createElement('span');
      document.body.append(probe);
      const parse = (color: string) => {
        if (!color || color === 'transparent') return null;
        probe.style.color = '';
        probe.style.color = `color-mix(in srgb, ${color} 100%, transparent 0%)`;
        const m = getComputedStyle(probe).color.match(
          /color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([-\d.e]+))?\)/,
        );
        if (!m) {
          // Forced colours apply to the probe too and compute to rgb()/rgba().
          const rgb = getComputedStyle(probe).color.match(/rgba?\(([^)]+)\)/);
          if (!rgb) return null;
          const [r, g, b2, alpha = '1'] = rgb[1].split(/[,\s/]+/).filter(Boolean);
          return { r: +r, g: +g, b: +b2, a: +alpha };
        }
        const channel = (v: string) => Math.round(Math.min(1, Math.max(0, +v)) * 255);
        return { r: channel(m[1]), g: channel(m[2]), b: channel(m[3]), a: m[4] ? +m[4] : 1 };
      };
      const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
        const c = [r, g, b].map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const backgroundBehind = (node: HTMLElement) => {
        let current: HTMLElement | null = node.parentElement;
        while (current) {
          const color = parse(getComputedStyle(current).backgroundColor);
          if (color && color.a > 0.5) return color;
          current = current.parentElement;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
      };
      const ratio = (fg: { r: number; g: number; b: number; a: number }, bg: typeof fg) => {
        const blended = {
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a),
        };
        const [hi, lo] = [luminance(blended), luminance(bg)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };

      // A visually hidden control (`sr-only`: a radio inside a chip label, the kiosk PIN field)
      // shows its focus on a visual stand-in: the label around it, else the next sibling.
      const rect = el.getBoundingClientRect();
      const target =
        rect.width <= 1 || rect.height <= 1
          ? ((el.closest('label') as HTMLElement | null) ??
            (el.nextElementSibling as HTMLElement | null) ??
            el)
          : el;
      const style = getComputedStyle(target);
      const outlineColor = parse(style.outlineColor);
      // In forced colours the probe's own colour is forced too, so visibility is read from the
      // computed outline colour itself (a system colour, never fully transparent when painted).
      const painted =
        mode === 'forced'
          ? !/transparent|rgba\([^)]*,\s*0\)$/.test(style.outlineColor)
          : !!outlineColor && outlineColor.a > 0;
      const outline =
        style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && painted;
      if (mode === 'forced') {
        probe.remove();
        return { label, visible: outline, contrast: null };
      }

      // The ring is the outermost opaque box-shadow layer with a spread (Tailwind's ring, drawn
      // outside any ring-offset layer).
      let ring: { color: ReturnType<typeof parse>; spread: number } | null = null;
      // Layers are "<color> <x> <y> <blur> <spread>"; a ring has a spread, a drop shadow only
      // a blur. The colour may itself contain spaces and parentheses (lab(…)).
      for (const layer of style.boxShadow.split(/,(?![^(]*\))/)) {
        const colorText = layer.match(/[a-z]+\([^)]*\)/)?.[0] ?? '';
        const color = parse(colorText);
        const lengths = (layer.replace(colorText, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat);
        const spread = lengths[3] ?? 0;
        if (color && color.a > 0 && spread > 0 && (!ring || spread > ring.spread))
          ring = { color, spread };
      }
      // A control may draw both (the global outline and its own ring): the stronger one counts.
      const behind = backgroundBehind(target);
      const contrasts = [outline ? outlineColor : null, ring?.color ?? null]
        .filter((color): color is NonNullable<typeof color> => !!color)
        .map((color) => ratio(color, behind));
      const contrast = contrasts.length ? Math.max(...contrasts) : null;
      probe.remove();
      return {
        label,
        visible: outline || !!ring,
        contrast,
      };
    },
    { mode, scope },
  );
}

/**
 * Presses Tab `stops` times from the current focus and checks each focused control inside
 * `scope` (a CSS selector; null = the whole document). Stops outside the scope end the walk.
 */
export async function expectFocusIndicators(
  page: Page,
  {
    mode,
    stops,
    scope = 'main',
    minimum = 1,
  }: { mode: FocusMode; stops: number; scope?: string | null; minimum?: number },
) {
  const failures: string[] = [];
  const seen: string[] = [];
  for (let i = 0; i < stops; i += 1) {
    await page.keyboard.press('Tab');
    let state = await readFocus(page, mode, scope);
    if (!state) break;
    // Styles apply by the next frame at the latest; re-read briefly before reporting.
    for (let retry = 0; retry < 10 && !state.visible; retry += 1) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      state = (await readFocus(page, mode, scope)) ?? state;
    }
    seen.push(state.label);
    if (!state.visible) failures.push(`${state.label}: no visible indicator`);
    else if (mode === 'ordinary' && state.contrast !== null && state.contrast < 3)
      failures.push(`${state.label}: indicator contrast ${state.contrast.toFixed(2)}:1`);
  }
  expect(seen.length, 'controls that took focus').toBeGreaterThanOrEqual(minimum);
  expect(failures, `focus indicators (${mode}) for: ${seen.join(' | ')}`).toEqual([]);
  return seen;
}

/** Checks the currently focused element only. */
export async function expectFocusedIndicator(page: Page, mode: FocusMode) {
  let state = await readFocus(page, mode, null);
  // Styles apply by the next frame at the latest; re-read briefly before reporting.
  for (let retry = 0; retry < 10 && state && !state.visible; retry += 1) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    state = await readFocus(page, mode, null);
  }
  expect(state, 'something has focus').not.toBeNull();
  expect(state!.visible, `${state!.label}: visible indicator (${mode})`).toBe(true);
  if (mode === 'ordinary' && state!.contrast !== null)
    expect(state!.contrast, `${state!.label}: indicator contrast`).toBeGreaterThanOrEqual(3);
}
