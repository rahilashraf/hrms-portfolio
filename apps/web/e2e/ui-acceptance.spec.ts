import { expect, test } from '@playwright/test';
import { pageWidthFor } from '../src/lib/navigation/page-width';
import {
  ACCEPTANCE_VIEWPORTS,
  expectAcceptableAt,
  expectVisibleFocus,
  framesUntil,
  recordSkeletons,
  recordedSkeletons,
  MAX_WIDTH_PX,
} from './support/acceptance';
import { ROUTES } from './support/acceptance-routes';

/**
 * Batch 10F — the permanent UI acceptance suite. Each major route, in its loaded state with the
 * module's existing mocked API, at 1440, 1280, 820 and 375 px (plus 320 px):
 * - no document-wide horizontal scroll, no action pushed off-screen, scroll containers are
 *   named keyboard-focusable regions;
 * - exactly one h1 and no skipped heading levels; axe reports no serious or critical violation;
 * - the frame is the page's `PageContainer` width (lib/navigation/page-width.ts), and it never
 *   changes from the first paint — route skeleton, access check, loading — to the loaded page;
 * - the first controls in main show a visible focus indicator.
 * Loading/denied privacy, navigation and kiosk checks are in ui-acceptance-flows.spec.ts.
 */

test.describe('UI acceptance: routes at 1440/1280/820/375 (+320) px', () => {
  for (const route of ROUTES) {
    test(`[${route.area}] ${route.path}: fits, one h1, ordered headings, axe, its own width from the first paint`, async ({
      page,
    }) => {
      // The table's width is the app's own route width (lib/navigation/page-width.ts).
      expect(pageWidthFor(route.path)).toBe(route.width);
      await route.setup(page);
      await recordSkeletons(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(route.path, { waitUntil: 'commit' });
      const ready = route.ready(page);
      const { maxWidths, sawDenied } = await framesUntil(page, ready);
      expect(sawDenied, 'permitted users never see "Access denied"').toBe(false);
      expect(maxWidths, 'frame width from first paint to loaded').toEqual([
        `${MAX_WIDTH_PX[route.width]}px`,
      ]);
      await expectAcceptableAt(page, ready, route.width);
      await expectVisibleFocus(page);
      // Whenever the route skeleton showed, it was in the destination's width.
      for (const skeleton of await recordedSkeletons(page))
        expect(skeleton.maxWidth, `skeleton on ${skeleton.path}`).toBe(
          `${MAX_WIDTH_PX[pageWidthFor(skeleton.path)]}px`,
        );
    });
  }
});

test('the route list covers at least 20 routes across every area', () => {
  expect(ROUTES.length).toBeGreaterThanOrEqual(20);
  expect(new Set(ROUTES.map((route) => route.area))).toEqual(
    new Set(['shell', 'administration', 'workforce', 'payroll', 'hr']),
  );
  expect(ACCEPTANCE_VIEWPORTS.map((viewport) => viewport.width)).toEqual([1440, 1280, 820, 375]);
});
