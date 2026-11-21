import { expect, test, type Page } from '@playwright/test';
import { pageWidthFor } from '../src/lib/navigation/page-width';
import { API } from './support/api-origin';
import {
  expectNoClippedActions,
  expectNoDocumentOverflow,
  frame,
  framesUntil,
  MAX_WIDTH_PX,
} from './support/acceptance';
import { ROUTES } from './support/acceptance-routes';
import { expectNoSeriousA11yViolations } from './support/axe';
import { type KioskMock, mockKiosk } from './support/kiosk-mocks';
import { json, path, session as workforceSession } from './support/workforce-mocks';

/**
 * Batch 10F — UI acceptance flows across modules:
 * - deep links: `#hash` and `?tab=` links select their section, picking a tab rewrites the URL
 *   in place (replace, not push: no new history entry), a reload keeps it (bookmarks), an
 *   unknown tab falls back to the first one, Back/Forward move between pages;
 * - permissions: while the authorization snapshot loads a page shows loading in its own width
 *   and never "Access denied"; without the permission it shows the denied state in the same
 *   width with no module data and no module request; a server error never shows its raw text;
 * - the kiosk: tablet portrait and landscape and a phone, touch targets, keyboard PIN entry,
 *   announced status and errors, the idle warning and reset, the completion screen.
 */

const setupOf = (routePath: string) => {
  const route = ROUTES.find((candidate) => candidate.path === routePath);
  if (!route) throw new Error(`No acceptance route ${routePath}`);
  return route;
};

const historyLength = (page: Page) => page.evaluate(() => window.history.length);

interface DeepLink {
  module: string;
  route: string;
  tablist: string;
  /** The link's suffix (`#hash` or `?tab=`), the tab it opens, another tab and its suffix. */
  deep: string;
  opens: string;
  pick: string;
  picked: RegExp;
  /** The tab an unknown suffix falls back to. */
  first: string;
  unknown: string;
}

const DEEP_LINKS: DeepLink[] = [
  {
    module: 'time',
    route: '/admin/time',
    tablist: 'Time operations sections',
    deep: '#corrections',
    opens: 'Corrections',
    pick: 'Records',
    picked: /\/admin\/time#records$/,
    first: 'Overview',
    unknown: '#nothing-here',
  },
  {
    module: 'my time',
    route: '/time',
    tablist: 'My Time',
    deep: '?tab=history',
    opens: 'History',
    pick: 'Timesheets',
    picked: /\/time\?tab=timesheets$/,
    first: 'Today',
    unknown: '?tab=nothing-here',
  },
  {
    module: 'payroll',
    route: '/admin/payroll',
    tablist: 'Payroll sections',
    deep: '?tab=calendars',
    opens: 'Calendars',
    pick: 'Pay periods',
    picked: /\/admin\/payroll\?tab=periods$/,
    first: 'Overview',
    unknown: '?tab=nothing-here',
  },
  {
    module: 'payroll run',
    route: '/admin/payroll/runs/run-1',
    tablist: 'Run sections',
    deep: '?tab=validation',
    opens: 'Validation',
    pick: 'Employees',
    picked: /\/admin\/payroll\/runs\/run-1\?tab=employees$/,
    first: 'Summary',
    unknown: '?tab=nothing-here',
  },
  {
    module: 'recruitment',
    route: '/admin/recruitment',
    tablist: 'Recruitment sections',
    deep: '#candidates',
    opens: 'Candidates',
    pick: 'Openings',
    picked: /\/admin\/recruitment#openings$/,
    first: 'Dashboard',
    unknown: '#nothing-here',
  },
  {
    module: 'onboarding',
    route: '/admin/onboarding',
    tablist: 'Onboarding sections',
    deep: '#templates',
    opens: 'Templates',
    pick: 'Offboarding',
    picked: /\/admin\/onboarding#offboarding$/,
    first: 'Onboarding',
    unknown: '#nothing-here',
  },
  {
    module: 'performance',
    route: '/admin/performance',
    tablist: 'Performance sections',
    deep: '#attention',
    opens: 'Needs attention',
    pick: 'Templates',
    picked: /\/admin\/performance#templates$/,
    first: 'Review cycles',
    unknown: '#nothing-here',
  },
  {
    module: 'benefits',
    route: '/admin/benefits',
    tablist: 'Benefits sections',
    deep: '#plans',
    opens: 'Plans',
    pick: 'Needs attention',
    picked: /\/admin\/benefits#attention$/,
    first: 'Plans',
    unknown: '#nothing-here',
  },
  {
    module: 'notifications',
    route: '/admin/notifications',
    tablist: 'Notifications sections',
    deep: '#templates',
    opens: 'Templates',
    pick: 'Delivery log',
    picked: /\/admin\/notifications#deliveries$/,
    first: 'Templates',
    unknown: '#nothing-here',
  },
  {
    module: 'documents',
    route: '/admin/documents',
    tablist: 'Documents sections',
    deep: '#policies',
    opens: 'Policies',
    pick: 'Missing',
    picked: /\/admin\/documents#missing$/,
    first: 'Document types',
    unknown: '#nothing-here',
  },
];

test.describe('UI acceptance flows: deep links', () => {
  for (const link of DEEP_LINKS) {
    test(`${link.module}: ${link.route}${link.deep} opens "${link.opens}"; picking a tab replaces the URL; reload, unknown tab, Back/Forward`, async ({
      page,
    }) => {
      await setupOf(link.route).setup(page);
      const tab = (name: string) =>
        page.getByRole('tablist', { name: link.tablist }).getByRole('tab', { name, exact: true });

      // A previous page, so Back/Forward have somewhere to go.
      await page.goto('/account/security');
      await expect(page.getByRole('heading', { level: 1, name: 'Account security' })).toBeVisible();
      await page.goto(`${link.route}${link.deep}`);
      await expect(tab(link.opens)).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel').first()).toBeVisible();

      // Picking a tab rewrites the URL in place: no new history entry.
      const before = await historyLength(page);
      await tab(link.pick).click();
      await expect(page).toHaveURL(link.picked);
      await expect(tab(link.pick)).toHaveAttribute('aria-selected', 'true');
      expect(await historyLength(page)).toBe(before);

      // A bookmark (reload) keeps the section.
      await page.reload();
      await expect(tab(link.pick)).toHaveAttribute('aria-selected', 'true');

      // Back leaves the page (the tab change made no entry); Forward returns to the section.
      await page.goBack();
      await expect(page).toHaveURL(/\/account\/security$/);
      await page.goForward();
      await expect(tab(link.pick)).toHaveAttribute('aria-selected', 'true');

      // An unknown or restricted tab falls back to the first section without an error.
      await page.goto(`${link.route}${link.unknown}`);
      await page.reload(); // a fresh load of the unknown link, not a same-document hash change
      await expect(tab(link.pick)).not.toHaveAttribute('aria-selected', 'true');
      await expect(tab(link.first)).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    });
  }
});

// ─── Permissions: loading, denied, privacy ──────────────────────────────────

const DENIED_ROUTES: Array<{ path: string; heading: string; apiPrefix: string }> = [
  { path: '/admin/audit', heading: 'Audit log', apiPrefix: '/audit' },
  { path: '/admin/payroll', heading: 'Payroll', apiPrefix: '/payroll' },
  { path: '/admin/recruitment', heading: 'Recruitment', apiPrefix: '/recruitment' },
  { path: '/admin/onboarding', heading: 'Onboarding & offboarding', apiPrefix: '/onboarding' },
  { path: '/admin/performance', heading: 'Performance', apiPrefix: '/performance' },
  { path: '/admin/benefits', heading: 'Benefits', apiPrefix: '/benefits' },
  {
    path: '/admin/notifications',
    heading: 'Notifications',
    apiPrefix: '/notifications/deliveries',
  },
  { path: '/admin/documents', heading: 'Documents', apiPrefix: '/documents' },
  { path: '/admin/settings', heading: 'Settings', apiPrefix: '/features' },
  { path: '/reports', heading: 'Reports', apiPrefix: '/reports' },
];

/** Holds the authorization snapshot until the test releases it (a deterministic "loading"). */
async function holdAuthorization(page: Page) {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${API}/auth/me/authorization`, async (route) => {
    await released;
    await route.fallback();
  });
  return release;
}

const API_PATH = new URL(API).pathname.replace(/\/$/, '');

/** A signed-in user who may only read employees; module API paths requested are recorded. */
async function employeeReader(page: Page) {
  await workforceSession(page, ['employee.read']);
  const moduleRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(API))
      moduleRequests.push(new URL(request.url()).pathname.slice(API_PATH.length));
  });
  return moduleRequests;
}

/** "Checking your access…" (or the route skeleton) shows in the page's width. */
async function expectLoadingInWidth(page: Page, routePath: string) {
  const loading = page
    .getByRole('main')
    .getByRole('status')
    .filter({ hasText: /^(Checking your access…|Loading page…|Loading.*)$/ })
    .first();
  await expect(loading).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Access denied' })).toHaveCount(0);
  expect((await frame(page))?.maxWidth).toBe(`${MAX_WIDTH_PX[pageWidthFor(routePath)]}px`);
}

test.describe('UI acceptance flows: permissions', () => {
  for (const target of DENIED_ROUTES) {
    test(`${target.path}: loading, then denied, in one width; never data, never a module request`, async ({
      page,
    }) => {
      const requests = await employeeReader(page);
      const release = await holdAuthorization(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(target.path, { waitUntil: 'commit' });
      // Loading and denied are distinct states, both in the page's own width.
      await expectLoadingInWidth(page, target.path);
      release();
      const denied = page.getByRole('heading', { level: 1, name: 'Access denied' });
      await expect(denied).toBeVisible();
      expect((await frame(page))?.maxWidth).toBe(`${MAX_WIDTH_PX[pageWidthFor(target.path)]}px`);
      const main = page.getByRole('main');
      await expect(
        main.getByRole('heading', { level: 1, name: target.heading, exact: true }),
      ).toHaveCount(0);
      await expect(main.getByRole('table')).toHaveCount(0);
      await expect(main.getByRole('tablist')).toHaveCount(0);
      await expect(main.getByRole('form')).toHaveCount(0);
      // No module data is requested. A module's organization list is its access check (it
      // answers which organizations the user may act in, with no records) and is allowed.
      expect(
        requests.filter(
          (pathname) =>
            pathname.startsWith(target.apiPrefix) && !pathname.endsWith('/organizations'),
        ),
      ).toEqual([]);
      await expectNoSeriousA11yViolations(page);
    });
  }

  for (const routePath of ['/admin/audit', '/admin/time', '/admin/payroll']) {
    test(`${routePath}: while permissions load, loading in the page's width, never "Access denied"`, async ({
      page,
    }) => {
      const route = setupOf(routePath);
      await route.setup(page);
      const release = await holdAuthorization(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(routePath, { waitUntil: 'commit' });
      await expectLoadingInWidth(page, routePath);
      release();
      const { maxWidths, sawDenied } = await framesUntil(page, route.ready(page));
      expect(sawDenied).toBe(false);
      expect(maxWidths).toEqual([`${MAX_WIDTH_PX[route.width]}px`]);
    });
  }

  test('a failing API never shows its raw error text', async ({ page }) => {
    await workforceSession(page, ['audit.read']);
    await page.route(path('/audit'), (route) =>
      json(route, { message: 'SQLSTATE 42P01 relation "audit_log" at db-internal-7:5432' }, 500),
    );
    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('SQLSTATE');
    await expect(page.getByRole('main')).not.toContainText('db-internal');
  });
});

// ─── Kiosk ──────────────────────────────────────────────────────────────────

const KIOSK_VIEWPORTS = [
  { name: 'tablet portrait', width: 820, height: 1180 },
  { name: 'tablet landscape', width: 1180, height: 820 },
  { name: 'small tablet landscape', width: 1024, height: 768 },
  { name: 'phone', width: 375, height: 812 },
] as const;

function kioskWorld(): KioskMock {
  return {
    enrolled: true,
    identification: {
      token: 'token-1',
      expiresInSeconds: 90,
      employee: { firstName: 'Ada' },
      state: 'OFF_CLOCK',
      actions: [
        {
          action: 'CLOCK_IN',
          employmentAssignmentId: 'assignment-1',
          label: 'Clock in · Counsellor',
        },
      ],
    },
    actions: [],
  };
}

async function expectTouchTargets(page: Page, minimum = 44) {
  const small = await page.getByRole('button').evaluateAll(
    (nodes, min) =>
      nodes
        .map((node) => ({
          name: node.textContent?.trim() ?? '',
          box: node.getBoundingClientRect(),
        }))
        .filter(({ box }) => box.width > 0 && (box.width < min || box.height < min))
        .map(({ name, box }) => `${name} ${Math.round(box.width)}×${Math.round(box.height)}`),
    minimum,
  );
  expect(small, 'kiosk buttons below the touch-target size').toEqual([]);
}

test.describe('UI acceptance flows: kiosk', () => {
  test('every kiosk screen fits portrait and landscape tablets and a phone, with 44 px targets', async ({
    page,
  }) => {
    // 20 screens at four sizes, plus four real 5 s completion resets.
    test.setTimeout(120_000);
    await mockKiosk(page, kioskWorld());
    await page.goto('/kiosk');
    const start = page.getByRole('button', { name: 'Tap to start' });
    const number = page.getByLabel('Employee number');
    const toNumber = () => start.click();
    const toPin = async () => {
      await number.fill('e-100');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    };
    const toActions = async () => {
      for (const digit of '582914')
        await page.getByRole('button', { name: digit, exact: true }).click();
    };
    const toDone = () => page.getByRole('button', { name: 'Clock in · Counsellor' }).click();
    const checkScreen = async () => {
      await expectNoDocumentOverflow(page);
      await expectNoClippedActions(page);
      await expectTouchTargets(page);
      await expectNoSeriousA11yViolations(page);
    };
    const screens: Array<[ReturnType<typeof page.getByRole>, Array<() => Promise<unknown>>]> = [
      [start, []],
      [number, [toNumber]],
      [page.getByRole('button', { name: '5', exact: true }), [toNumber, toPin]],
      [page.getByRole('heading', { name: 'Hello, Ada' }), [toNumber, toPin, toActions]],
    ];
    for (const viewport of KIOSK_VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const [ready, steps] of screens) {
        // Each screen from the welcome screen (Cancel/idle are covered below).
        await page.goto('/kiosk');
        for (const step of steps) await step();
        await expect(ready).toBeVisible();
        await checkScreen();
      }
      // The completion screen announces the outcome, then clears itself after 5 s: it is
      // measured as soon as it shows, and the reset to the welcome screen is awaited.
      await toDone();
      await expect(page.getByRole('heading', { name: 'Clocked in' })).toBeVisible();
      await expect(page.getByRole('status')).toContainText('Clock in · Counsellor');
      await checkScreen();
      await expect(start).toBeVisible({ timeout: 15_000 });
    }
  });

  test('keyboard only: the employee number, the PIN typed on a keyboard, and the action', async ({
    page,
  }) => {
    const world = kioskWorld();
    await mockKiosk(page, world);
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto('/kiosk');
    const start = page.getByRole('button', { name: 'Tap to start' });
    await start.focus();
    await page.keyboard.press('Enter');
    const number = page.getByLabel('Employee number');
    await expect(number).toBeFocused();
    await page.keyboard.type('e-100');
    await page.keyboard.press('Enter');
    // The PIN field takes focus, so a physical keyboard works straight away.
    const pin = page.getByLabel(/PIN/);
    await expect(pin).toBeFocused();
    await page.keyboard.type('582914');
    await expect(page.getByRole('heading', { name: 'Hello, Ada' })).toBeFocused();
    const action = page.getByRole('button', { name: 'Clock in · Counsellor' });
    await action.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Clocked in' })).toBeVisible();
    expect(world.actions).toHaveLength(1);
  });

  test('a wrong PIN is announced as an alert and the employee can try again', async ({ page }) => {
    await mockKiosk(page, kioskWorld());
    await page.route(`${API}/kiosk/identify`, (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'KIOSK_IDENTIFICATION_FAILED', message: 'internal detail' }),
      }),
    );
    await page.goto('/kiosk');
    await page.getByRole('button', { name: 'Tap to start' }).click();
    await page.getByLabel('Employee number').fill('e-100');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    for (const digit of '000000')
      await page.getByRole('button', { name: digit, exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'not recognized' });
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText('internal detail');
    await expectNoSeriousA11yViolations(page);
  });

  test('idle: a waiting screen warns ("Still there?") and then resets to the welcome screen', async ({
    page,
  }) => {
    await page.clock.install();
    await mockKiosk(page, kioskWorld());
    await page.goto('/kiosk');
    await page.getByRole('button', { name: 'Tap to start' }).click();
    await expect(page.getByLabel('Employee number')).toBeVisible();
    await page.clock.fastForward(25_000);
    const warning = page.getByRole('alertdialog', { name: 'Still there?' });
    await expect(warning).toBeVisible();
    await expect(warning.getByRole('button', { name: 'Continue' })).toBeFocused();
    await expectNoSeriousA11yViolations(page);
    await page.clock.fastForward(10_000);
    await expect(page.getByRole('button', { name: 'Tap to start' })).toBeVisible();
    await expect(page.getByLabel('Employee number')).toHaveCount(0);
  });
});

test('the deep-link and denied lists use routes of the acceptance table', () => {
  for (const link of DEEP_LINKS) expect(setupOf(link.route)).toBeTruthy();
  expect(DENIED_ROUTES.length).toBeGreaterThanOrEqual(10);
});

// ─── Sign-in button ─────────────────────────────────────────────────────────

test('sign-in: the button is disabled while submitting and fully opaque the moment it is enabled again', async ({
  page,
}) => {
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, {}, 401));
  let answer: (() => void) | null = null;
  await page.route(`${API}/auth/login`, async (route) => {
    await new Promise<void>((resolve) => {
      answer = resolve;
    });
    await json(route, { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' }, 401);
  });
  await page.goto('/login');
  const signIn = page.getByRole('button', { name: 'Sign in' });
  // Enabled: fully opaque, and the page passes axe (colour contrast included).
  await expect(signIn).toBeEnabled();
  expect(await signIn.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expectNoSeriousA11yViolations(page);

  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Password').fill('wrong-password');
  await signIn.click();
  // Submitting: disabled, says so, at the disabled opacity.
  const busy = page.getByRole('button', { name: 'Please wait…' });
  await expect(busy).toBeDisabled();
  expect(await busy.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.6');
  // Enabling: the failed attempt re-enables it, opaque at once (no opacity transition).
  await expect.poll(() => answer !== null).toBe(true);
  answer!();
  await expect(signIn).toBeEnabled();
  const opacity = await signIn.evaluate((el) => ({
    opacity: getComputedStyle(el).opacity,
    transition: getComputedStyle(el).transitionProperty,
  }));
  expect(opacity.opacity).toBe('1');
  expect(opacity.transition).not.toMatch(/opacity|all/);
  await expect(page.getByRole('alert').filter({ hasText: 'incorrect' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
