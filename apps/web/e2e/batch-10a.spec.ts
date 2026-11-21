import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 10A — shell and shared primitives against a mocked API:
 * - the notification bell is in the mobile header (and in the sidebar on desktop): exactly one
 *   is visible at each width, it shows the unread count, and the count is requested once;
 * - while the authorization snapshot is slow, /admin, /admin/employees/new, /admin/documents and
 *   /admin/access-control/roles
 *   show a loading state in the page's own width — never "Access denied" — then the page;
 * - /admin's first heading is its h1 (roles shortcut after it);
 * - axe (serious/critical) and no page-wide horizontal scroll at 1280, 820 and 375 px.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;
const identity = {
  id: 'user-10',
  personId: 'person-10',
  email: 'admin@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};
const PERMISSIONS = [
  'organization.read',
  'role.manage',
  'role.read',
  'employee.read',
  'employee.manage',
  'document.read',
  'document.manage',
];

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function session(
  page: Page,
  { authorizationDelayMs = 0, unread = 3 }: { authorizationDelayMs?: number; unread?: number } = {},
) {
  const calls = { unread: 0 };
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '10a-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, async (route) => {
    if (authorizationDelayMs) await new Promise((r) => setTimeout(r, authorizationDelayMs));
    await json(route, {
      userId: identity.id,
      // role.manage system-wide; role.read (organization scope) is what the /admin roles shortcut
      // and the Roles page require (Batch R3.2).
      permissions: PERMISSIONS.map((key) => ({
        key,
        scopes: key === 'role.manage' ? [{ type: 'SYSTEM' }] : [{ type: 'ORGANIZATION', id: ORG }],
      })),
    });
  });
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: identity.id, email: identity.email, displayName: 'Ada Admin' },
      systemPermissions: [],
      organizations: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: ['DOCUMENTS'],
          permissions: PERMISSIONS,
          isEmployee: false,
          isManager: false,
        },
      ],
    }),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => {
    calls.unread += 1;
    return json(route, { unread });
  });
  await page.route(`${API}/organizations*`, (route) =>
    json(route, [
      {
        id: ORG,
        name: 'Northwind Academy',
        code: 'NWA',
        description: null,
        archivedAt: null,
        timezone: 'America/Toronto',
      },
    ]),
  );
  await page.route(`${API}/documents/organizations`, (route) =>
    json(route, {
      items: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          actions: {
            canManageTypes: true,
            canManagePolicies: false,
            canReadRecords: true,
            canManageRecords: true,
          },
        },
      ],
      uploads: { enabled: false, maxBytes: 0, allowedTypes: [] },
    }),
  );
  await page.route(`${API}/documents/types?*`, (route) => json(route, { items: [] }));
  return calls;
}

async function noHorizontalScroll(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
}

/** Visible links named "Notifications…" (CSS-hidden ones are not counted). */
async function visibleBells(page: Page) {
  return page
    .getByRole('link', { name: /^Notifications/ })
    .filter({ visible: true })
    .count();
}

test('the notification bell is in the mobile header, exactly one bell shows, one count request', async ({
  page,
}) => {
  const calls = await session(page, { unread: 3 });
  await page.setViewportSize(VIEWPORTS.phone);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  const header = page.locator('header');
  const bell = header.getByRole('link', { name: 'Notifications, 3 unread' });
  await expect(bell).toBeVisible();
  expect(await visibleBells(page)).toBe(1);
  // Both bells are mounted (header + sidebar), yet the count was requested once.
  expect(calls.unread).toBe(1);
  await expectNoSeriousA11yViolations(page);
  // The drawer still opens and closes; inside it the sidebar's bell is the visible one.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.locator('#app-sidebar');
  await expect(drawer.getByRole('link', { name: 'Notifications, 3 unread' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
  // The header bell goes to the notification center.
  await bell.click();
  await expect(page).toHaveURL(/\/notifications$/);

  for (const size of [VIEWPORTS.tablet, VIEWPORTS.desktop]) {
    await page.setViewportSize(size);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
    expect(await visibleBells(page)).toBe(1);
  }
  // On desktop the visible bell is the sidebar's, not the header's.
  await expect(header.getByRole('link', { name: /^Notifications/ })).toBeHidden();
});

for (const target of [
  { path: '/admin', heading: 'Organizations' },
  { path: '/admin/employees/new', heading: 'Add employee' },
  { path: '/admin/documents', heading: 'Documents & employee records' },
  { path: '/admin/access-control/roles', heading: 'Roles' },
]) {
  test(`${target.path}: no "Access denied" flash or width jump while permissions load`, async ({
    page,
  }) => {
    await session(page, { authorizationDelayMs: 1_500 });
    await page.setViewportSize(VIEWPORTS.desktop);
    const widths: number[] = [];
    let sawDenied = false;
    await page.goto(target.path, { waitUntil: 'commit' });
    const h1 = page.getByRole('heading', { level: 1, name: target.heading });
    for (let i = 0; i < 80 && !(await h1.isVisible().catch(() => false)); i += 1) {
      const sample = await page
        .evaluate(() => {
          const first = document.querySelector('main')?.firstElementChild as HTMLElement | null;
          return {
            width: first ? Math.round(first.getBoundingClientRect().width) : 0,
            denied: /Access denied|No organization access/.test(document.body.innerText),
          };
        })
        .catch(() => ({ width: 0, denied: false }));
      if (sample.width) widths.push(sample.width);
      sawDenied ||= sample.denied;
      await page.waitForTimeout(50);
    }
    await expect(h1).toBeVisible();
    const loaded = await page.evaluate(() =>
      Math.round(
        (document.querySelector('main')?.firstElementChild as HTMLElement).getBoundingClientRect()
          .width,
      ),
    );
    expect(sawDenied).toBe(false);
    expect([...new Set([...widths, loaded])]).toEqual([loaded]);
  });
}

test('/admin: h1 first, roles shortcut after it; axe and no horizontal scroll at three widths', async ({
  page,
}) => {
  await session(page);
  for (const size of Object.values(VIEWPORTS)) {
    await page.setViewportSize(size);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
    const levels = await page
      .locator('main')
      .locator('h1, h2, h3')
      .evaluateAll((nodes) => nodes.map((node) => node.tagName));
    expect(levels[0]).toBe('H1');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Roles & Permissions' }),
    ).toBeVisible();
    await noHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  }
});

test('focus rings follow the brand accent in the shell', async ({ page }) => {
  await session(page);
  await page.setViewportSize(VIEWPORTS.phone);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await menu.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(menu).toBeFocused();
  const ring = await menu.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--tw-ring-color'),
  );
  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--hrms-accent-text').trim(),
  );
  expect(ring.replace(/\s/g, '').toLowerCase()).toContain(
    (accent.replace(/\s/g, '') || '#4338ca').toLowerCase(),
  );
});
