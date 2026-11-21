import { expect, test, type Page } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

const identity = {
  id: 'shell-user',
  personId: 'person-shell',
  email: 'ada@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const ALL_MODULES = [
  'ATTENDANCE',
  'SCHEDULING',
  'LEAVE',
  'COMPENSATION',
  'PAYROLL',
  'BENEFITS',
  'PERFORMANCE',
  'RECRUITMENT',
  'ONBOARDING',
  'DOCUMENTS',
  'NOTIFICATIONS',
  'GOOGLE_WORKSPACE',
  'REPORTING',
];

const organization = (overrides: Record<string, unknown> = {}) => ({
  id: 'org-1',
  name: 'Northwind Academy',
  code: 'NWA',
  timezone: 'America/Toronto',
  branding: null,
  enabledModules: ALL_MODULES,
  permissions: [],
  isEmployee: true,
  isManager: false,
  ...overrides,
});

const EMPLOYEE_WORKSPACE = {
  user: { id: identity.id, email: identity.email, displayName: 'Ada Lovelace' },
  systemPermissions: [],
  organizations: [organization({ permissions: ['leave.request', 'time.clock'] })],
};

const ADMIN_WORKSPACE = {
  user: { id: identity.id, email: identity.email, displayName: 'Ada Lovelace' },
  systemPermissions: [],
  organizations: [
    organization({
      permissions: [
        'employee.read',
        'organization.read',
        'payroll.read',
        'time.view',
        'time.timesheet.approve',
        'audit.read',
        'feature.read',
      ],
    }),
    organization({
      id: 'org-2',
      name: 'Lakeside Camp',
      code: 'LAKE',
      branding: {
        displayName: 'Lakeside',
        shortName: 'Lake',
        logoUrl: null,
        iconUrl: null,
        primaryColor: '#0F766E',
        secondaryColor: null,
      },
      enabledModules: ['LEAVE'],
      permissions: ['leave.read', 'recruitment.read'],
      isEmployee: false,
    }),
  ],
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** A restored session (refresh succeeds), so reloads keep the user signed in. */
async function session(page: Page, workspace: typeof ADMIN_WORKSPACE) {
  const snapshot = {
    userId: identity.id,
    permissions: (workspace.organizations[0]?.permissions ?? []).map((key) => ({
      key,
      scopes: [{ type: 'ORGANIZATION', id: 'org-1' }],
    })),
  };
  // Registered first so the specific routes below take precedence.
  await page.route(`${API}/**`, (route) => route.fulfill(json({ message: 'Not found' }, 404)));
  await page.route(`${API}/auth/refresh`, (route) =>
    route.fulfill(json({ accessToken: 'shell-token' })),
  );
  await page.route(`${API}/auth/me`, (route) => route.fulfill(json(identity)));
  await page.route(`${API}/auth/me/authorization`, (route) => route.fulfill(json(snapshot)));
  await page.route(`${API}/auth/me/workspace`, (route) => route.fulfill(json(workspace)));
  await page.route(`${API}/notifications/me/unread-count`, (route) =>
    route.fulfill(json({ unread: 2 })),
  );
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

test.describe('desktop shell', () => {
  test('renders landmarks, grouped navigation, profile controls and breadcrumbs', async ({
    page,
  }) => {
    await session(page, ADMIN_WORKSPACE);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    await expect(page.getByRole('main')).toHaveAttribute('id', 'main-content');
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByText('Ada Lovelace')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Notifications, 2 unread' })).toBeVisible();
    await expect(page.getByLabel('Switch organization')).toHaveValue('org-1');

    // Skip link is the first tab stop and targets the main content.
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toHaveAttribute('href', '#main-content');

    // Navigate through a group and check the breadcrumbs for a nested page.
    const pay = nav(page).getByRole('button', { name: 'Pay' });
    await expect(pay).toHaveAttribute('aria-expanded', 'true');
    await nav(page).getByRole('link', { name: 'Payroll', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/payroll$/);
    await expect(nav(page).getByRole('link', { name: 'Payroll', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(crumbs(page).getByText('Payroll')).toHaveAttribute('aria-current', 'page');

    await page.goto('/admin/payroll/runs/run-1');
    await expect(crumbs(page).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    await expect(crumbs(page).getByRole('link', { name: 'Payroll' })).toHaveAttribute(
      'href',
      '/admin/payroll',
    );
    await expect(crumbs(page).getByText('Payroll run')).toHaveAttribute('aria-current', 'page');
    // The nested route keeps its parent entry active.
    await expect(nav(page).getByRole('link', { name: 'Payroll', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('deep-links to page sections from the sidebar', async ({ page }) => {
    await session(page, ADMIN_WORKSPACE);
    // Batch 4E-1: the Time operations hub reviews one organization at a time.
    await page.route(`${API}/time/manage/organizations`, (route) =>
      route.fulfill(
        json({
          items: [
            {
              id: 'org-1',
              name: 'Camp',
              code: 'CAMP',
              timezone: 'America/Toronto',
              workLocations: [],
              physicalSites: [],
              actions: {
                canViewSignIns: false,
                canCorrectSignIns: false,
                canManageDevices: false,
                canManagePolicies: false,
                canManagePins: false,
                canApproveTimesheets: true,
              },
            },
          ],
        }),
      ),
    );
    await page.goto('/dashboard');
    await nav(page).getByRole('link', { name: 'Timesheets' }).click();
    await expect(page).toHaveURL(/\/admin\/time#timesheets$/);
    await expect(nav(page).getByRole('link', { name: 'Timesheets' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('heading', { name: 'Timesheet approval queue' })).toBeVisible();
    await expect(crumbs(page).getByText('Timesheets')).toHaveAttribute('aria-current', 'page');
  });

  test('switching organization re-filters navigation and persists', async ({ page }) => {
    await session(page, ADMIN_WORKSPACE);
    await page.goto('/dashboard');
    await expect(nav(page).getByRole('link', { name: 'Payroll', exact: true })).toBeVisible();
    await page.getByLabel('Switch organization').selectOption('org-2');
    await expect(page.getByText('Switched to Lake.')).toBeVisible();
    // Lakeside: recruitment is off there and the caller is not employed.
    await expect(nav(page).getByRole('link', { name: 'Payroll', exact: true })).toHaveCount(0);
    await expect(nav(page).getByRole('link', { name: 'Recruitment' })).toHaveCount(0);
    await expect(nav(page).getByRole('link', { name: 'Requests', exact: true })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'My Leave' })).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel('Switch organization')).toHaveValue('org-2');
  });

  test('collapsed sidebar and collapsed groups persist across reloads', async ({ page }) => {
    await session(page, ADMIN_WORKSPACE);
    await page.goto('/dashboard');
    await nav(page).getByRole('button', { name: 'People' }).click();
    await expect(nav(page).getByRole('link', { name: 'Employees' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    // Icon-only links keep their names (aria-label) for assistive technology.
    await expect(nav(page).getByRole('link', { name: 'Audit Log' })).toHaveAttribute(
      'title',
      'Audit Log',
    );
    // Only the hover/focus tooltip carries the text, and it is hidden until then.
    await expect(nav(page).getByText('Audit Log', { exact: true })).toBeHidden();

    await page.reload();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(nav(page).getByRole('button', { name: 'People' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.reload();
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
    await expect(nav(page).getByRole('button', { name: 'People' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('keyboard users can move through the sidebar and toggle groups', async ({ page }) => {
    await session(page, ADMIN_WORKSPACE);
    await page.goto('/dashboard');
    await nav(page).getByRole('link', { name: 'Home' }).focus();
    await page.keyboard.press('ArrowDown');
    const people = nav(page).getByRole('button', { name: 'People' });
    await expect(people).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(people).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await expect(people).toHaveAttribute('aria-expanded', 'true');
    // Self-service entries lead each group: My Profile first, then the administration pages.
    await page.keyboard.press('ArrowRight');
    await expect(nav(page).getByRole('link', { name: 'My Profile' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(nav(page).getByRole('link', { name: 'Employees' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin\/employees$/);
  });

  test('unknown pages show the not-found page', async ({ page }) => {
    await page.goto('/this-page-does-not-exist');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Return to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });
});

test.describe('persona visibility', () => {
  test('an employee sees only self-service navigation', async ({ page }) => {
    await session(page, EMPLOYEE_WORKSPACE);
    await page.goto('/dashboard');
    await expect(nav(page).getByRole('link', { name: 'My Leave' })).toBeVisible();
    await expect(nav(page).getByRole('link')).toHaveText([
      'Home',
      'My Profile',
      'My Time',
      'My Schedule',
      'My Leave',
      'My Pay',
      'My Compensation',
      'My Benefits',
      'My Performance',
      'My Interviews',
      'My Onboarding',
      'My Documents',
    ]);
    await expect(nav(page).getByRole('button', { name: 'Administration' })).toHaveCount(0);
    await expect(page.getByLabel('Switch organization')).toHaveCount(0);
  });

  test('an administrator sees operations and administration', async ({ page }) => {
    await session(page, ADMIN_WORKSPACE);
    await page.goto('/dashboard');
    for (const name of [
      'Employees',
      'Organization',
      'Positions',
      'Attendance',
      'Payroll',
      'Audit Log',
      'Features',
    ])
      await expect(nav(page).getByRole('link', { name, exact: true })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Positions' })).toHaveAttribute(
      'href',
      '/admin/organizations/org-1/positions',
    );
    await expect(nav(page).getByRole('link', { name: 'Recruitment' })).toHaveCount(0);
    // Batch 3B: no serious or critical accessibility violations on the final page.
    await expectNoSeriousA11yViolations(page);
  });

  test('falls back to the authorization snapshot when the workspace is unavailable', async ({
    page,
  }) => {
    await session(page, ADMIN_WORKSPACE);
    await page.route(`${API}/auth/me/workspace`, (route) => route.fulfill(json({}, 503)));
    await page.route(`${API}/auth/me/authorization`, (route) =>
      route.fulfill(
        json({
          userId: identity.id,
          permissions: [{ key: 'report.read', scopes: [{ type: 'TEAM', id: 'team-1' }] }],
        }),
      ),
    );
    await page.goto('/dashboard');
    await expect(nav(page).getByRole('link', { name: 'Reports' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'My Leave' })).toBeVisible();
    await expect(nav(page).getByRole('link', { name: 'Payroll', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Switch organization')).toHaveCount(0);
  });
});

test.describe('mobile shell', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('opens and closes the navigation drawer and navigates from it', async ({ page }) => {
    await session(page, ADMIN_WORKSPACE);
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    await expect(nav(page)).toBeHidden();
    const open = page.getByRole('button', { name: 'Open navigation' });
    await expect(open).toHaveAttribute('aria-expanded', 'false');

    await open.click();
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Close navigation' })).toBeFocused();
    // The page behind the open drawer is inert: Tab stays in the drawer, and axe is clean.
    await expect(page.locator('#main-content').locator('xpath=..')).toHaveAttribute('inert', '');
    await expectNoSeriousA11yViolations(page);
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(open).toBeFocused();

    await open.click();
    await page.getByTestId('drawer-backdrop').click({ position: { x: 370, y: 400 } });
    await expect(drawer).toHaveCount(0);

    await open.click();
    await drawer.getByRole('link', { name: 'Audit Log' }).click();
    await expect(page).toHaveURL(/\/admin\/audit$/);
    await expect(drawer).toHaveCount(0);
    await expect(crumbs(page).getByText('Audit Log')).toHaveAttribute('aria-current', 'page');
    // No horizontal page scroll on a phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
