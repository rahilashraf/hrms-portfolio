import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

const ORG = '11111111-1111-4111-8111-111111111111';

const identity = {
  id: 'user-p20',
  personId: 'person-p20',
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

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Routes one API method + path (query ignored) to a handler. */
async function api(
  page: Page,
  method: string,
  pathname: string,
  handler: (route: Route) => Promise<void> | void,
) {
  await page.route(
    (url) => url.origin === API && url.pathname === pathname,
    (route) => (route.request().method() === method ? handler(route) : route.fallback()),
  );
}

function workspace(
  permissions: string[],
  options: { isEmployee?: boolean; branding?: unknown } = {},
) {
  return {
    user: { id: identity.id, email: identity.email, displayName: 'Ada Lovelace' },
    systemPermissions: [],
    organizations: [
      {
        id: ORG,
        name: 'Northwind Academy',
        code: 'NWA',
        timezone: 'America/Toronto',
        branding: options.branding ?? null,
        enabledModules: ALL_MODULES,
        permissions,
        isEmployee: options.isEmployee ?? false,
        isManager: false,
      },
    ],
  };
}

/** A restored session with the given organization permissions (and SYSTEM keys). */
async function session(
  page: Page,
  permissions: string[],
  options: { isEmployee?: boolean; branding?: unknown; system?: string[] } = {},
) {
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: 'p20-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId: identity.id,
      permissions: [
        ...permissions.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
        ...(options.system ?? []).map((key) => ({ key, scopes: [{ type: 'SYSTEM' }] })),
      ],
    }),
  );
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, workspace(permissions, options)),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => json(route, { unread: 0 }));
}

test.describe('login branding', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/auth/refresh', (route) => json(route, {}, 401));
  });

  test('shows the configured organization branding for ?organization=<code>', async ({ page }) => {
    let requested = '';
    await api(page, 'GET', '/public/branding', (route) => {
      requested = route.request().url();
      return json(route, {
        source: 'ORGANIZATION',
        displayName: 'Northwind Academy',
        shortName: 'Northwind',
        loginLogoUrl: 'https://cdn.example.com/login.png',
        iconUrl: null,
        primaryColor: '#0F766E',
        secondaryColor: '#F59E0B',
        loginSubtitle: 'Staff and camp counsellors',
        websiteUrl: 'https://northwind.example.com',
        supportEmail: 'help@northwind.example.com',
      });
    });
    // The (external) image is never fetched for real.
    await page.route('https://cdn.example.com/**', (route) => route.fulfill({ status: 404 }));
    await page.goto('/login?organization=nwa');
    const card = page.getByRole('region', { name: 'Northwind Academy sign-in' });
    await expect(card).toBeVisible();
    expect(new URL(requested).searchParams.get('organization')).toBe('NWA');
    await expect(card.getByAltText('Northwind Academy logo')).toHaveAttribute(
      'referrerpolicy',
      'no-referrer',
    );
    await expect(card.getByText('Staff and camp counsellors')).toBeVisible();
    await expect(card.getByRole('link', { name: 'Contact support' })).toHaveAttribute(
      'href',
      'mailto:help@northwind.example.com',
    );
    await expect(page).toHaveTitle('Sign in · Northwind');
    await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCSS(
      'background-color',
      'rgb(15, 118, 110)',
    );
  });

  test('falls back to generic branding when branding fails and still signs in', async ({
    page,
  }) => {
    await api(page, 'GET', '/public/branding', (route) => json(route, { message: 'down' }, 500));
    await page.route('**/auth/login', (route) =>
      json(route, { accessToken: 'p20-token', identity }, 201),
    );
    await page.route(`${API}/auth/me/workspace`, (route) => json(route, {}, 503));
    await page.goto('/login');
    const card = page.getByRole('region', { name: 'HRMS sign-in' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('img')).toHaveCount(0);
    await page.getByLabel('Email').fill('ada@example.com');
    await page.getByLabel('Password').fill('correct horse battery');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

const BRANDING = {
  organizationId: ORG,
  displayName: 'Northwind',
  shortName: 'NW',
  logoUrl: null,
  iconUrl: null,
  loginLogoUrl: null,
  primaryColor: '#0F766E',
  secondaryColor: null,
  loginSubtitle: null,
  websiteUrl: null,
  supportEmail: null,
  publicLoginEnabled: false,
  version: 1,
  updatedAt: '2026-10-01T00:00:00Z',
  updatedByUserId: 'user-1',
};

test('branding settings: validates, saves with the expected version and recovers from a conflict', async ({
  page,
}) => {
  await session(page, ['organization.read', 'organization.branding.manage']);
  let current = { ...BRANDING };
  const bodies: Array<Record<string, unknown>> = [];
  let conflictOnce = true;
  await api(page, 'GET', `/organizations/${ORG}/branding`, (route) => json(route, current));
  await api(page, 'PUT', `/organizations/${ORG}/branding`, (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (conflictOnce) {
      conflictOnce = false;
      // Someone else saved meanwhile.
      current = { ...current, displayName: 'Changed elsewhere', version: 2 };
      return json(
        route,
        { statusCode: 409, code: 'BRANDING_VERSION_CONFLICT', message: 'stale', currentVersion: 2 },
        409,
      );
    }
    current = { ...current, ...body, version: current.version + 1 } as typeof current;
    return json(route, current);
  });

  await page.goto('/admin/settings/branding');
  await expect(page.getByRole('heading', { name: 'Branding', level: 1 })).toBeVisible();
  const displayName = page.getByLabel('Display name');
  await expect(displayName).toHaveValue('Northwind');

  await page.getByLabel('Logo URL', { exact: true }).fill('http://insecure.example.com/logo.png');
  await page.getByRole('button', { name: 'Save branding' }).click();
  await expect(page.getByText('Logo URL must be an absolute https:// address.')).toBeVisible();
  expect(bodies).toHaveLength(0);

  await page.getByLabel('Logo URL', { exact: true }).fill('');
  await displayName.fill('Mine');
  await page.getByRole('button', { name: 'Save branding' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Someone else changed this branding',
  );
  await expect(displayName).toHaveValue('Changed elsewhere');
  expect(bodies[0]).toMatchObject({ displayName: 'Mine', expectedVersion: 1 });

  await page.getByLabel('Short name').fill('Northwind');
  await page.getByRole('button', { name: 'Save branding' }).click();
  await expect(page.getByRole('main').getByText('Branding saved.')).toBeVisible();
  expect(bodies[1]).toMatchObject({
    displayName: 'Changed elsewhere',
    shortName: 'Northwind',
    expectedVersion: 2,
  });
  // The preview reflects the values.
  await expect(page.getByRole('figure', { name: 'Sign-in preview' })).toContainText(
    'Changed elsewhere',
  );
});

test('branding settings are read-only without the manage permission', async ({ page }) => {
  await session(page, ['organization.read']);
  await api(page, 'GET', `/organizations/${ORG}/branding`, (route) => json(route, BRANDING));
  await page.goto('/admin/settings/branding');
  await expect(page.getByLabel('Display name')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save branding' })).toHaveCount(0);
});

test.describe('dashboard personas', () => {
  test('an employee sees self-service, My Time and no admin cards', async ({ page }) => {
    await session(page, ['leave.request', 'time.clock'], { isEmployee: true });
    await api(page, 'GET', '/dashboard', (route) =>
      json(route, {
        organizationId: ORG,
        cards: [],
        self: {
          employeeId: 'employee-1',
          todayShifts: 1,
          leaveBalances: [
            { leaveTypeId: 'vac', name: 'Vacation', availableMinutes: 2400, pendingMinutes: 0 },
          ],
          policyAcknowledgementsDue: 2,
          selfReviewsDue: 1,
          reviewsToWrite: null,
          openGoals: 3,
        },
        quickActions: [],
      }),
    );
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Welcome, Ada' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My work' })).toBeVisible();
    await expect(page.getByText('Vacation')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to My Time' })).toHaveAttribute(
      'href',
      '/time',
    );
    await expect(page.getByRole('heading', { name: 'Overview' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Quick actions' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Set up your organization' })).toHaveCount(0);
    await expect(page).toHaveTitle('Home · Northwind Academy');
  });

  test('an administrator sees API cards, quick actions and the setup checklist', async ({
    page,
  }) => {
    await session(page, [
      'employee.read',
      'employee.manage',
      'leave.approve',
      'organization.manage',
    ]);
    await api(page, 'GET', '/dashboard', (route) =>
      json(route, {
        organizationId: ORG,
        cards: [
          {
            key: 'activeEmployees',
            label: 'Active employees',
            value: 42,
            href: '/admin/employees',
            area: 'People',
          },
          {
            key: 'pendingLeaveApprovals',
            label: 'Leave requests to approve',
            value: 3,
            href: '/admin/leave',
            area: 'Leave',
          },
        ],
        self: null,
        quickActions: [{ key: 'addEmployee', label: 'Add employee', href: '/admin/employees/new' }],
      }),
    );
    await api(page, 'GET', `/organizations/${ORG}/setup`, (route) =>
      json(route, {
        organizationId: ORG,
        steps: [
          {
            key: 'company',
            label: 'Company details',
            description: 'Set the time zone.',
            complete: true,
            optional: false,
            href: '/admin/settings/company',
            detail: null,
          },
          {
            key: 'branding',
            label: 'Branding',
            description: 'Logo and colors.',
            complete: false,
            optional: true,
            href: '/admin/settings/branding',
            detail: null,
          },
        ],
      }),
    );
    await page.goto('/dashboard');
    const overview = page.getByRole('heading', { name: 'Overview' }).locator('..');
    await expect(overview.getByRole('link')).toHaveCount(2);
    await expect(overview.getByRole('link', { name: /42\s*Active employees/ })).toHaveAttribute(
      'href',
      '/admin/employees',
    );
    await expect(page.getByRole('link', { name: 'Add employee' })).toHaveAttribute(
      'href',
      '/admin/employees/new',
    );
    await expect(page.getByRole('heading', { name: 'My work' })).toHaveCount(0);
    const setup = page.getByRole('region', { name: 'Set up your organization' });
    await expect(setup.getByText('All required steps are complete.')).toBeVisible();
    await setup.getByRole('button', { name: 'Hide for now' }).click();
    await expect(page.getByText('The setup checklist is hidden for now.')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Show setup checklist' })).toBeVisible();
  });
});

test('creates a role from a template, customized, with protected permissions disabled', async ({
  page,
}) => {
  await session(page, ['role.read', 'role.manage', 'role.assign']);
  const permissions = [
    ['employee.read', 'People', 'View employees'],
    ['employee.manage', 'People', 'Manage employees'],
    ['leave.approve', 'Leave', 'Approve leave'],
    ['audit.read', 'Administration', 'View audit trail'],
  ].map(([key, area, label], index) => ({
    id: `p${index}`,
    key,
    name: key,
    description: `${label}.`,
    isActive: true,
    area,
    label,
  }));
  let created: unknown = null;
  await api(page, 'GET', `/authorization/organizations/${ORG}/roles`, (route) =>
    json(route, created ? [created] : []),
  );
  await api(page, 'GET', '/authorization/permissions', (route) => json(route, permissions));
  await api(page, 'GET', '/authorization/role-templates', (route) =>
    json(route, {
      items: [
        {
          key: 'MANAGER',
          name: 'Manager',
          description: 'Team operations.',
          permissions: ['audit.read', 'employee.read', 'leave.approve'],
          missingPermissions: ['audit.read'],
        },
      ],
    }),
  );
  let body: Record<string, unknown> | null = null;
  await api(page, 'POST', `/authorization/organizations/${ORG}/roles`, (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    created = {
      id: 'role-9',
      organizationId: ORG,
      code: body.code,
      name: body.name,
      description: null,
      isSystemOwner: false,
      archivedAt: null,
      permissions: [],
    };
    return json(route, created, 201);
  });

  await page.goto('/admin/access-control/roles');
  await page.getByLabel('Start from a template (optional)').selectOption('MANAGER');
  await expect(page.getByRole('checkbox', { name: /View employees/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Approve leave/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /View audit trail/ })).toBeDisabled();
  await page.getByRole('checkbox', { name: /Approve leave/ }).uncheck();
  await page.getByRole('checkbox', { name: /Manage employees/ }).check();
  await page.getByLabel(/^Code/).fill('TEAM_LEAD');
  await page.getByLabel(/^Name/).fill('Team lead');
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText(/Role Team lead created/)).toBeVisible();
  expect(body).toMatchObject({
    code: 'TEAM_LEAD',
    name: 'Team lead',
    permissionKeys: ['employee.read', 'employee.manage'],
  });
  await expect(page.getByRole('link', { name: 'Team lead' })).toBeVisible();
});

const PROFILE = {
  id: 'employee-1',
  employeeNumber: 'EMP-000001',
  status: 'ACTIVE',
  hireDate: '2026-09-01',
  terminationDate: null,
  person: {
    firstName: 'Grace',
    middleName: null,
    lastName: 'Hopper',
    preferredName: null,
    personalEmail: 'grace@example.com',
    phone: null,
  },
  assignments: { current: [], upcoming: [], historical: [], cancelled: [] },
};

function capabilities(tabs: Record<string, boolean>, actions: Record<string, boolean>) {
  return {
    employeeId: 'employee-1',
    organizationIds: [ORG],
    tabs: {
      overview: true,
      employment: true,
      compensation: false,
      time: false,
      leave: false,
      benefits: false,
      documents: false,
      performance: false,
      ...tabs,
    },
    actions: {
      edit: false,
      changePosition: false,
      assignManager: false,
      addCompensation: false,
      manageDocuments: false,
      startOffboarding: false,
      ...actions,
    },
  };
}

test.describe('employee workspace', () => {
  test('a reader sees only Overview and Employment, without actions', async ({ page }) => {
    await session(page, ['employee.read']);
    await api(page, 'GET', '/employees/employee-1', (route) => json(route, PROFILE));
    await api(page, 'GET', '/employees/employee-1/capabilities', (route) =>
      json(route, capabilities({}, {})),
    );
    await page.goto('/admin/employees/employee-1');
    await expect(page.getByRole('heading', { name: 'Grace Hopper' })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveText(['Overview', 'Employment']);
    await expect(page.getByRole('button', { name: 'Edit employee' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Start offboarding' })).toHaveCount(0);
  });

  test('tabs and actions follow capabilities, sync to the URL and work with the keyboard', async ({
    page,
  }) => {
    await session(page, ['employee.read'], { system: ['employee.read', 'employee.manage'] });
    await api(page, 'GET', '/employees/employee-1', (route) => json(route, PROFILE));
    await api(page, 'GET', '/employees/employee-1/capabilities', (route) =>
      json(
        route,
        capabilities({ leave: true, performance: true }, { edit: true, startOffboarding: true }),
      ),
    );
    await page.goto('/admin/employees/employee-1#leave');
    await expect(page.getByRole('tab')).toHaveText([
      'Overview',
      'Employment',
      'Leave',
      'Performance',
    ]);
    await expect(page.getByRole('tab', { name: 'Leave' })).toHaveAttribute('aria-selected', 'true');
    // Batch 6B: the Leave links open Leave with the employee already selected.
    await expect(
      page.getByRole('tabpanel').getByRole('link', { name: 'Leave requests' }),
    ).toHaveAttribute('href', '/admin/leave?employeeId=employee-1#requests');
    await page.getByRole('tab', { name: 'Leave' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'Employment' })).toBeFocused();
    await expect(page).toHaveURL(/#employment$/);
    await expect(page.getByText('No visible employment.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Start offboarding' })).toHaveAttribute(
      'href',
      // Batch 5C: the link preselects the employee in the offboarding form.
      '/admin/onboarding?offboardEmployee=employee-1#start',
    );
    await page.getByRole('button', { name: 'Edit employee' }).click();
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('heading', { name: 'Edit profile' })).toBeVisible();
  });
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the dashboard and branding settings fit a phone without horizontal scroll', async ({
    page,
  }) => {
    await session(page, ['organization.read', 'organization.branding.manage'], {
      branding: {
        displayName: 'Northwind',
        shortName: 'NW',
        logoUrl: null,
        iconUrl: null,
        primaryColor: '#0F766E',
        secondaryColor: null,
      },
    });
    await api(page, 'GET', '/dashboard', (route) =>
      json(route, { organizationId: ORG, cards: [], self: null, quickActions: [] }),
    );
    await api(page, 'GET', `/organizations/${ORG}/branding`, (route) => json(route, BRANDING));
    for (const path of ['/dashboard', '/admin/settings/branding']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Navigation' })
        .getByRole('link', { name: 'Northwind home' }),
    ).toBeVisible();
    // Batch 3B: no serious or critical accessibility violations on the final page.
    await expectNoSeriousA11yViolations(page);
  });
});
