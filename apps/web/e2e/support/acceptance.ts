import { expect, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './axe';

/**
 * Batch 10F — the shared checks of the permanent UI acceptance suite (e2e/ui-acceptance*.spec.ts).
 * Every check reads the rendered page only; none of them waits a fixed time.
 */

/** Acceptance viewports: two desktops, a tablet (portrait) and a phone; 320 px is checked apart. */
export const ACCEPTANCE_VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 800 },
  { name: '820', width: 820, height: 1180 },
  { name: '375', width: 375, height: 812 },
] as const;
export const NARROWEST = { width: 320, height: 640 } as const;

export type PageWidth = 'narrow' | 'default' | 'wide' | 'full';
/** `PageContainer`'s max widths (Tailwind max-w-3xl/5xl/6xl/7xl at 16 px per rem). */
export const MAX_WIDTH_PX: Record<PageWidth, number> = {
  narrow: 768,
  default: 1024,
  wide: 1152,
  full: 1280,
};

/** The page frame: `<main>`'s first child (PageContainer, or the route skeleton). */
export async function frame(page: Page) {
  return page
    .evaluate(() => {
      const first = document.querySelector('main')?.firstElementChild as HTMLElement | null;
      if (!first) return null;
      return {
        width: Math.round(first.getBoundingClientRect().width),
        maxWidth: getComputedStyle(first).maxWidth,
      };
    })
    .catch(() => null);
}

export async function documentOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

export async function expectNoDocumentOverflow(page: Page) {
  await expect.poll(() => documentOverflow(page)).toBeLessThanOrEqual(1);
}

/** Every horizontally scrolling container in main is a named, keyboard-focusable region. */
export async function expectAccessibleScrollers(page: Page) {
  const offenders = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('main *'))
      .filter((el) => {
        const style = getComputedStyle(el);
        return (
          (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          el.scrollWidth > el.clientWidth + 1
        );
      })
      // A scrolling table must be a named, focusable region; any other scroller must at least be
      // reachable by keyboard (it is focusable or holds focusable controls, as a tab bar does).
      .filter((el) => {
        const namedRegion =
          el.getAttribute('role') === 'region' &&
          !!el.getAttribute('aria-label') &&
          el.tabIndex >= 0;
        if (el.querySelector('table')) return !namedRegion;
        const focusable = el.querySelector(
          'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        return !namedRegion && el.tabIndex < 0 && !focusable;
      })
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 120)),
  );
  expect(offenders, 'scroll containers that are not named, focusable regions').toEqual([]);
}

/**
 * Buttons and links in main are inside the viewport horizontally, unless they sit in a
 * scroll region (where scrolling reveals them).
 */
export async function expectNoClippedActions(page: Page) {
  const clipped = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const inScroller = (el: Element) => {
      for (
        let node = el.parentElement;
        node && node.tagName !== 'MAIN';
        node = node.parentElement
      ) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') return true;
      }
      return false;
    };
    return Array.from(
      document.querySelectorAll<HTMLElement>('main button, main a[href], main [role="tab"]'),
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return false; // sr-only or hidden
        if (getComputedStyle(el).visibility === 'hidden') return false;
        return (rect.left < -1 || rect.right > width + 1) && !inScroller(el);
      })
      .map((el) => (el.textContent ?? '').trim().slice(0, 60) || el.getAttribute('aria-label'));
  });
  expect(clipped, 'actions outside the viewport').toEqual([]);
}

/** One visible h1 on the page; headings in main never skip a level going deeper. */
export async function expectHeadingOutline(page: Page) {
  const outline = await page.evaluate(() => {
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        (rect.width > 0 || rect.height > 0 || el.closest('.sr-only') !== null) &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        !el.closest('[hidden], [aria-hidden="true"], dialog:not([open])')
      );
    };
    const h1s = Array.from(document.querySelectorAll('h1')).filter(visible);
    const levels = Array.from(
      document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6'),
    )
      .filter(visible)
      .map((el) => Number(el.tagName[1]));
    return { h1s: h1s.length, levels };
  });
  expect(outline.h1s, 'visible h1 elements').toBe(1);
  const skips: string[] = [];
  outline.levels.reduce((previous, level) => {
    if (level > previous + 1) skips.push(`h${previous} → h${level}`);
    return level;
  }, 1);
  expect(skips, 'heading levels skipped').toEqual([]);
}

/**
 * Keyboard focus: the first focusable controls in main, reached with Tab from the skip-link
 * target, each show a visible indicator (an outline or a ring box-shadow).
 */
export async function expectVisibleFocus(page: Page, stops = 6) {
  const main = page.locator('#main-content');
  await main.focus();
  const focusState = () =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.closest('main')) return null;
      // Focus inside a native control's own UI (a date input's calendar button): the browser
      // draws that indicator, and the host does not match :focus.
      if (!el.matches(':focus')) return { label: 'native', visible: true };
      const style = getComputedStyle(el);
      const transparent = (color: string) => /rgba\([^)]*,\s*0\)|transparent/.test(color);
      const outline =
        style.outlineStyle !== 'none' &&
        parseFloat(style.outlineWidth) > 0 &&
        !transparent(style.outlineColor);
      // A ring: a box-shadow layer with an opaque colour and a spread or blur.
      const ring = (style.boxShadow.match(/rgba?\([^)]*\)[^,]*/g) ?? []).some((layer) => {
        const color = layer.match(/rgba?\([^)]*\)/)?.[0] ?? '';
        const lengths = (layer.replace(color, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat);
        return !transparent(color) && lengths.slice(2).some((value) => value > 0);
      });
      return {
        label: `${el.tagName.toLowerCase()}[${el.getAttribute('type') ?? ''}] ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}`,
        visible: outline || ring,
      };
    });
  const missing: string[] = [];
  for (let i = 0; i < stops; i += 1) {
    await page.keyboard.press('Tab');
    let state = await focusState();
    if (!state) break; // left main: nothing more to check
    // Styles apply on the next frame at the latest; re-read briefly before reporting.
    for (let retry = 0; retry < 10 && state && !state.visible; retry += 1) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      state = await focusState();
    }
    if (state && !state.visible) missing.push(state.label);
  }
  expect(missing, 'focused controls without a visible indicator').toEqual([]);
}

/**
 * Samples the page frame from the first paint until `ready` is visible, including the route
 * skeleton and the page's own loading and access-check states. Returns the distinct widths
 * and whether "Access denied" ever showed.
 */
export async function framesUntil(page: Page, ready: Locator) {
  const widths = new Set<string>();
  let sawDenied = false;
  let sawSkeleton = false;
  for (let i = 0; i < 400 && !(await ready.isVisible().catch(() => false)); i += 1) {
    const current = await frame(page);
    if (current) widths.add(current.maxWidth);
    sawSkeleton ||= await page
      .getByText('Loading page…', { exact: true })
      .isVisible()
      .catch(() => false);
    sawDenied ||= await page
      .getByRole('heading', { name: 'Access denied' })
      .isVisible()
      .catch(() => false);
    // Yield to the page for one animation frame (no fixed sleep).
    await page
      .evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
      .catch(() => undefined);
  }
  await expect(ready).toBeVisible();
  const final = await frame(page);
  if (final) widths.add(final.maxWidth);
  return { maxWidths: [...widths], sawDenied, sawSkeleton };
}

/** All the per-viewport checks of one route. */
export async function expectAcceptableAt(page: Page, ready: Locator, width: PageWidth) {
  for (const viewport of ACCEPTANCE_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(ready).toBeVisible();
    await expectNoDocumentOverflow(page);
    await expectAccessibleScrollers(page);
    await expectNoClippedActions(page);
    await expectHeadingOutline(page);
    expect((await frame(page))?.maxWidth, `page width at ${viewport.name}`).toBe(
      `${MAX_WIDTH_PX[width]}px`,
    );
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(NARROWEST);
  await expect(ready).toBeVisible();
  await expectNoDocumentOverflow(page);
  await expectNoClippedActions(page);
  await page.setViewportSize({ width: 1280, height: 800 });
}

/**
 * Records every appearance of the route skeleton ("Loading page…" from
 * app/(app)/(authenticated)/loading.tsx) with the path and frame width at that moment. Whether
 * it shows depends on Next's prefetch cache, so tests record it rather than force it; the
 * deterministic check of its width per route is route-fallbacks.test.tsx.
 */
export async function recordSkeletons(page: Page) {
  await page.addInitScript(() => {
    const seen: Array<{ path: string; maxWidth: string }> = [];
    (window as unknown as { __skeletons: typeof seen }).__skeletons = seen;
    const check = () => {
      const status = Array.from(document.querySelectorAll('main [role="status"]')).find(
        (node) => node.textContent === 'Loading page…',
      );
      if (!status) return;
      const first = document.querySelector('main')?.firstElementChild as HTMLElement | null;
      if (first) seen.push({ path: location.pathname, maxWidth: getComputedStyle(first).maxWidth });
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });
}

export async function recordedSkeletons(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __skeletons?: Array<{ path: string; maxWidth: string }> })
        .__skeletons ?? [],
  );
}
