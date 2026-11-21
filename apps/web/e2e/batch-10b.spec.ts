import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 10B — administration and people pages against a mocked API, with deliberately long
 * names (the kind that broke layouts in the Batch 10 audit):
 * - D2: /leave's request form never widens the page at 375 px, whatever the leave-type names;
 * - D3: wide tables on /compensation and /admin/leave scroll inside named, focusable regions
 *   (axe `scrollable-region-focusable`);
 * - D6: the roles page's organization select fits a 375 px phone;
 * - role detail and user access show a loading state — never "Access denied" — while the
 *   authorization snapshot loads, and an API error as an error;
 * - each route: axe (serious/critical) and no page-wide horizontal scroll at 1280, 820 and
 *   375 px.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_NAME = 'Northwind Academy of Performing Arts and Outdoor Education';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;
const LONG_TYPE =
  'Bereavement leave for an immediate family member (paid, up to five working days each time)';

const identity = {
  id: 'user-10b',
  personId: 'person-10b',
  email: 'morgan.reedley@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const path = (pathname: string) => (url: URL) => url.origin === API && url.pathname === pathname;

interface SessionOptions {
  permissions: string[];
  /** Permissions granted system-wide instead of in ORG. */
  systemPermissions?: string[];
  isEmployee?: boolean;
  authorizationDelayMs?: number;
  modules?: string[];
}

async function session(page: Page, options: SessionOptions) {
  const {
    permissions,
    systemPermissions = [],
    isEmployee = true,
    authorizationDelayMs = 0,
  } = options;
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '10b-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, async (route) => {
    if (authorizationDelayMs) await new Promise((r) => setTimeout(r, authorizationDelayMs));
    await json(route, {
      userId: identity.id,
      permissions: [
        ...permissions.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
        ...systemPermissions.map((key) => ({ key, scopes: [{ type: 'SYSTEM' }] })),
      ],
    });
  });
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: identity.id, email: identity.email, displayName: 'Morgan Reedley' },
      systemPermissions,
      organizations: [
        {
          id: ORG,
          name: ORG_NAME,
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: options.modules ?? ['LEAVE', 'COMPENSATION', 'DOCUMENTS'],
          permissions,
          isEmployee,
          isManager: false,
        },
      ],
    }),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => json(route, { unread: 0 }));
}

async function pageOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** No page-wide horizontal scroll and no serious/critical axe violations at three widths. */
async function checkAtAllWidths(page: Page, ready: () => Promise<void>) {
  for (const size of [VIEWPORTS.desktop, VIEWPORTS.tablet, VIEWPORTS.phone]) {
    await page.setViewportSize(size);
    await ready();
    await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(1);
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

/** Samples the page while `done` is false: was "Access denied" ever shown? */
async function watchForDenied(page: Page, done: () => Promise<boolean>) {
  let sawDenied = false;
  const widths: number[] = [];
  for (let i = 0; i < 100 && !(await done().catch(() => false)); i += 1) {
    const sample = await page
      .evaluate(() => {
        const first = document.querySelector('main')?.firstElementChild as HTMLElement | null;
        return {
          width: first ? Math.round(first.getBoundingClientRect().width) : 0,
          denied: /Access denied/.test(document.body.innerText),
        };
      })
      .catch(() => ({ width: 0, denied: false }));
    if (sample.width) widths.push(sample.width);
    sawDenied ||= sample.denied;
    await page.waitForTimeout(40);
  }
  return { sawDenied, widths };
}

async function mainWidth(page: Page) {
  return page.evaluate(() =>
    Math.round(
      (document.querySelector('main')?.firstElementChild as HTMLElement).getBoundingClientRect()
        .width,
    ),
  );
}

// ─── Leave ──────────────────────────────────────────────────────────────────

const leaveType = (id: string, name: string) => ({
  leaveType: {
    id,
    code: id.toUpperCase(),
    name,
    classification: 'PAID',
    tracksBalance: true,
    displayUnit: 'HOURS',
  },
  eligible: true,
  policy: {
    id: `policy-${id}`,
    standardWorkdayMinutes: 480,
    allowPartialDay: true,
    amountSource: 'SCHEDULE_THEN_STANDARD',
    negativeBalanceLimitMinutes: 0,
    employeeMayCancelApprovedFuture: true,
  },
  accountId: `account-${id}`,
  balance: { currentMinutes: 2400, scheduledMinutes: 0, availableMinutes: 2400, pendingMinutes: 0 },
  actions: { canRequest: true },
});

const myAssignment = (id: string, position: string) => ({
  employmentAssignmentId: id,
  isPrimary: id === 'asg-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-01',
  endDate: null,
  position: { id: `pos-${id}`, name: position, code: 'POS' },
  organization: { id: ORG, name: ORG_NAME },
  timezone: 'America/Toronto',
  asOf: '2027-03-02',
  leaveTypes: [leaveType('vac', 'Vacation'), leaveType('ber', LONG_TYPE)],
  actions: { canRequest: true },
});

async function myLeave(page: Page) {
  await page.route(path('/leave/me'), (route) =>
    json(route, {
      employeeId: 'emp-1',
      assignments: [
        myAssignment('asg-1', 'Senior Outdoor Education Program Coordinator and Trip Leader'),
        myAssignment('asg-2', 'Weekend Aquatics Instructor'),
      ],
    }),
  );
  await page.route(path('/leave/me/team-calendar'), (route) =>
    json(route, { range: { from: '', to: '' }, teams: [], hasTeam: false, people: [] }),
  );
  await page.route(path('/leave/me/holidays'), (route) => json(route, { items: [] }));
  await page.route(path('/leave/me/requests'), (route) =>
    json(route, {
      items: [
        {
          id: 'req-1',
          status: 'PENDING',
          employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Morgan Reedley' },
          employmentAssignmentId: 'asg-1',
          positionName: 'Senior Outdoor Education Program Coordinator and Trip Leader',
          leaveType: leaveType('ber', LONG_TYPE).leaveType,
          startDate: '2027-04-05',
          endDate: '2027-04-06',
          startLocalTime: null,
          endLocalTime: null,
          timezone: 'America/Toronto',
          requestedMinutes: 960,
          approvedMinutes: null,
          activeMinutes: null,
          cancelledDayCount: 0,
          submittedAt: '2027-03-01T12:00:00.000Z',
          actions: { canCancel: true },
        },
      ],
      nextAfterId: null,
    }),
  );
}

test('D2: the leave request form never widens /leave on a phone, even with long names', async ({
  page,
}) => {
  await session(page, { permissions: ['leave.request'] });
  await myLeave(page);
  await page.setViewportSize(VIEWPORTS.phone);
  await page.goto('/leave');
  const type = page.getByLabel('Leave type');
  await expect(type).toBeVisible();
  // The request list (a wide table that scrolls inside its own region) is on the page too.
  await expect(page.getByRole('button', { name: 'Withdraw' })).toBeAttached();
  expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  await type.selectOption({ label: `${LONG_TYPE} (Paid)` });
  await expect(type).toHaveValue('ber');
  expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  // The select stays inside the form and keeps its choice.
  const box = await type.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(VIEWPORTS.phone.width);
  await checkAtAllWidths(page, () =>
    expect(page.getByRole('heading', { level: 1, name: 'Leave' })).toBeVisible(),
  );
  await expect(type).toHaveValue('ber');
});

const leaveOrganization = {
  id: ORG,
  name: ORG_NAME,
  timezone: 'America/Toronto',
  actions: {
    canReadRequests: true,
    canApprove: true,
    canViewBalances: true,
    canAdjust: false,
    canReadConfiguration: true,
    canManageTypes: true,
    canManagePolicies: true,
    canReadHolidays: true,
    canManageHolidays: true,
    canManageOrganizationHolidays: true,
  },
  holidayScopes: [],
};

async function leaveAdmin(page: Page) {
  await page.route(path('/leave/organizations'), (route) =>
    json(route, { items: [leaveOrganization] }),
  );
  await page.route(path('/holidays'), (route) =>
    json(route, {
      items: [
        {
          id: 'hol-1',
          organizationId: ORG,
          organizationalUnitId: null,
          departmentId: null,
          teamId: null,
          date: `${new Date().getFullYear()}-07-01`,
          name: 'Founders Day and Annual Community Open House',
          kind: 'STATUTORY_HOLIDAY',
          archivedAt: null,
          actions: { canEdit: true, canArchive: true },
        },
      ],
    }),
  );
  await page.route(path('/leave/types'), (route) =>
    json(route, {
      items: [
        {
          id: 'type-ber',
          organizationId: ORG,
          code: 'BER',
          name: LONG_TYPE,
          description: null,
          classification: 'PAID',
          tracksBalance: true,
          displayUnit: 'HOURS',
          archivedAt: null,
          actions: { canEdit: true, canArchive: true },
        },
      ],
    }),
  );
  await page.route(path('/leave/requests'), (route) =>
    json(route, { items: [], nextAfterId: null }),
  );
  for (const resource of ['units', 'departments', 'teams']) {
    await page.route(path(`/organizations/${ORG}/${resource}`), (route) => json(route, []));
  }
}

test('D3: the holidays table on /admin/leave scrolls in a named, focusable region', async ({
  page,
}) => {
  await session(page, {
    permissions: ['leave.manage', 'leave.approve', 'holiday.read', 'holiday.manage'],
    isEmployee: false,
  });
  await leaveAdmin(page);
  await page.setViewportSize(VIEWPORTS.phone);
  await page.goto('/admin/leave#holidays');
  const row = page.getByRole('rowheader', { name: 'Founders Day and Annual Community Open House' });
  await expect(row).toBeVisible();
  const region = page.getByRole('region', { name: /holidays/i });
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('tabindex', '0');
  await expect(region.locator('th[scope="col"]').first()).toBeVisible();
  await checkAtAllWidths(page, () => expect(row).toBeVisible());
});

// ─── Compensation ───────────────────────────────────────────────────────────

test('D3: the compensation history on /compensation scrolls in a named, focusable region', async ({
  page,
}) => {
  await session(page, { permissions: ['compensation.read.self'] });
  const record = {
    id: 'rec-1',
    employmentAssignmentId: 'asg-1',
    recordType: 'INITIAL',
    payBasis: 'HOURLY',
    rateAmount: '24.5000',
    currency: 'CAD',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    payGroup: { id: 'pg-1', code: 'NWA-BIWEEKLY', name: 'Northwind biweekly hourly staff' },
    reason: null,
    supersedesRecordId: null,
    supersededAt: null,
    createdAt: '2026-01-02T00:00:00.000Z',
  };
  await page.route(path('/compensation/me'), (route) =>
    json(route, {
      employeeId: 'emp-1',
      assignments: [
        {
          assignment: {
            id: 'asg-1',
            status: 'ACTIVE',
            employmentType: 'FULL_TIME',
            isPrimary: true,
            startDate: '2026-01-01',
            endDate: null,
            employee: { id: 'emp-1', employeeNumber: 'EMP-000001', displayName: 'Morgan Reedley' },
            position: { id: 'pos-1', name: 'Senior Outdoor Education Coordinator', code: 'SOEC' },
            organization: { id: ORG, name: ORG_NAME, code: 'NWA' },
          },
          asOf: '2026-10-05',
          current: record,
          timeline: [{ ...record, actions: { canCorrect: false, canEnd: false } }],
          superseded: [],
          actions: { canCreate: false, canChange: false },
        },
      ],
    }),
  );
  await page.setViewportSize(VIEWPORTS.phone);
  await page.goto('/compensation');
  const region = page.getByRole('region', { name: /Compensation history/ });
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('tabindex', '0');
  // Monetary formatting is unchanged.
  await expect(region.getByText(/24\.50/).first()).toBeVisible();
  await checkAtAllWidths(page, () => expect(region).toBeVisible());
});

// ─── Roles, role detail, user access ────────────────────────────────────────

const PERMISSION_LIST = [
  {
    id: 'perm-1',
    key: 'employee.read',
    name: 'Read employees',
    description: null,
    isActive: true,
    area: 'People',
    label: 'View employee records',
  },
  {
    id: 'perm-2',
    key: 'leave.approve',
    name: 'Approve leave',
    description: null,
    isActive: true,
    area: 'Leave',
    label: 'Approve leave requests',
  },
];
const ROLE = {
  id: 'role-1',
  organizationId: ORG,
  code: 'PROGRAM_COORDINATORS',
  name: 'Program coordinators for outdoor education and aquatics',
  description: 'Coordinators who look after the outdoor education and aquatics programs.',
  isSystemOwner: false,
  archivedAt: null,
  permissions: [{ permissionId: 'perm-1', permission: PERMISSION_LIST[0] }],
};

async function rolesApi(page: Page, { roleStatus = 200 }: { roleStatus?: number } = {}) {
  await page.route(`${API}/organizations*`, (route) =>
    json(route, [
      {
        id: ORG,
        name: ORG_NAME,
        code: 'NWA',
        description: null,
        archivedAt: null,
        timezone: 'America/Toronto',
      },
    ]),
  );
  await page.route(path(`/authorization/organizations/${ORG}/roles`), (route) =>
    json(route, [ROLE]),
  );
  await page.route(path('/authorization/permissions'), (route) => json(route, PERMISSION_LIST));
  await page.route(path('/authorization/role-templates'), (route) => json(route, { items: [] }));
  await page.route(path('/authorization/roles/role-1'), (route) =>
    roleStatus === 200
      ? json(route, ROLE)
      : json(route, { message: 'The role service is unavailable.' }, roleStatus),
  );
  await page.route(path('/authorization/roles/role-1/assignments'), (route) =>
    json(route, {
      items: [
        {
          id: 'as-1',
          userId: 'user-2',
          roleId: 'role-1',
          scopeType: 'ORGANIZATION',
          organizationId: ORG,
          organizationalUnitId: null,
          departmentId: null,
          teamId: null,
          startsAt: '2026-01-01T00:00:00.000Z',
          expiresAt: null,
          revokedAt: null,
          user: { id: 'user-2', email: 'grace.hopper.outdoor-education@example.com' },
        },
      ],
      nextCursor: null,
    }),
  );
}

const ROLE_ADMIN = ['organization.read', 'role.read', 'role.manage', 'role.assign'];

test('D6: the roles page organization select fits a phone and still selects', async ({ page }) => {
  await session(page, { permissions: ROLE_ADMIN, isEmployee: false });
  await rolesApi(page);
  await page.setViewportSize(VIEWPORTS.phone);
  await page.goto('/admin/access-control/roles');
  const select = page.getByLabel('Organization', { exact: true });
  await expect(select).toBeVisible();
  await select.selectOption(ORG);
  await expect(page.getByRole('link', { name: ROLE.name })).toBeVisible();
  expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  const box = await select.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(VIEWPORTS.phone.width);
  await checkAtAllWidths(page, () =>
    expect(page.getByRole('link', { name: ROLE.name })).toBeVisible(),
  );
});

test('the roles page names organizations (not ids) for people without organization.read', async ({
  page,
}) => {
  await session(page, { permissions: ['role.read'], isEmployee: false });
  await rolesApi(page);
  await page.setViewportSize(VIEWPORTS.phone);
  await page.goto('/admin/access-control/roles');
  const select = page.getByLabel('Organization', { exact: true });
  await expect(select.getByRole('option')).toHaveCount(2);
  // D6 as found by the audit: an option labelled with a raw id widened the page by 7 px.
  expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
  const box = await select.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(VIEWPORTS.phone.width);
  await expect(select.getByRole('option', { name: ORG_NAME })).toBeAttached();
  await expect(select.getByRole('option', { name: ORG })).toHaveCount(0);
  await select.selectOption(ORG);
  await expect(page.getByRole('link', { name: ROLE.name })).toBeVisible();
  expect(await pageOverflow(page)).toBeLessThanOrEqual(1);
});

for (const target of [
  { path: '/admin/access-control/roles/role-1', heading: ROLE.name },
  {
    path: '/admin/access-control/assignments?roleId=role-1',
    heading: `User Access · ${ROLE.name}`,
  },
]) {
  test(`${target.path.split('?')[0]}: loading, never "Access denied", while permissions load`, async ({
    page,
  }) => {
    await session(page, {
      permissions: ROLE_ADMIN,
      isEmployee: false,
      authorizationDelayMs: 1_500,
    });
    await rolesApi(page);
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto(target.path, { waitUntil: 'commit' });
    const h1 = page.getByRole('heading', { level: 1, name: target.heading });
    const { sawDenied, widths } = await watchForDenied(page, () => h1.isVisible());
    await expect(h1).toBeVisible();
    expect(sawDenied).toBe(false);
    const loaded = await mainWidth(page);
    expect([...new Set([...widths, loaded])]).toEqual([loaded]);
    await checkAtAllWidths(page, () => expect(h1).toBeVisible());
  });

  test(`${target.path.split('?')[0]}: denied once permissions are known to be missing`, async ({
    page,
  }) => {
    await session(page, { permissions: ['organization.read'], isEmployee: false });
    await rolesApi(page);
    await page.goto(target.path);
    await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeVisible();
    await expect(page.getByText(ROLE.description)).toHaveCount(0);
  });

  test(`${target.path.split('?')[0]}: an API error is shown as an error, not as loading or denied`, async ({
    page,
  }) => {
    await session(page, { permissions: ROLE_ADMIN, isEmployee: false });
    await rolesApi(page, { roleStatus: 503 });
    await page.goto(target.path);
    await expect(
      page.getByRole('alert').filter({ hasText: /temporarily unavailable/ }),
    ).toBeVisible();
    await expect(page.getByText('Access denied')).toHaveCount(0);
    await expect(page.getByRole('status', { name: /Loading/ })).toHaveCount(0);
  });
}

// ─── Employees: directory, creation, profile ────────────────────────────────

const EMP = '55555555-5555-4555-8555-555555555555';
const longAssignment = {
  id: 'asg-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-05',
  endDate: null,
  isPrimary: true,
  position: {
    id: 'pos-1',
    name: 'Senior Outdoor Education Program Coordinator and Trip Leader',
    code: 'SOEC',
  },
  jobTitle: { id: 'jt-1', name: 'Program Coordinator', code: 'PC' },
  organization: { id: ORG, name: ORG_NAME, code: 'NWA' },
  placement: { type: 'TEAM', id: 'team-1', name: 'Aquatics and Waterfront Safety Team' },
  workLocation: null,
  manager: {
    assignmentId: 'asg-m',
    employeeId: 'emp-m',
    employeeNumber: 'E-0001',
    displayName: 'Grace Hopper',
    positionName: 'Director of Programs',
  },
  managerWarnings: [],
};

async function employeesApi(page: Page) {
  await page.route(`${API}/organizations*`, (route) =>
    json(route, [
      {
        id: ORG,
        name: ORG_NAME,
        code: 'NWA',
        description: null,
        archivedAt: null,
        timezone: 'America/Toronto',
      },
    ]),
  );
  await page.route(path('/employees'), (route) =>
    json(route, {
      items: [
        {
          id: EMP,
          employeeNumber: 'EMP-000005',
          status: 'ACTIVE',
          terminationDate: null,
          person: {
            firstName: 'Ada',
            middleName: null,
            lastName: 'Lovelace-Byron King-Noel',
            preferredName: null,
          },
          displayAssignment: longAssignment,
        },
      ],
      nextAfterId: null,
    }),
  );
  await page.route(
    (url) => url.origin === API && url.pathname.startsWith(`/employees/${EMP}`),
    (route) => {
      const rest = new URL(route.request().url()).pathname.slice(`/employees/${EMP}`.length);
      if (rest === '')
        return json(route, {
          id: EMP,
          employeeNumber: 'EMP-000005',
          status: 'ACTIVE',
          hireDate: '2026-01-05',
          terminationDate: null,
          person: {
            firstName: 'Ada',
            middleName: null,
            lastName: 'Lovelace-Byron King-Noel',
            preferredName: null,
            personalEmail: 'ada.lovelace-byron.king-noel@example.com',
            phone: null,
          },
          assignments: {
            current: [longAssignment],
            upcoming: [],
            historical: [],
            cancelled: [],
          },
        });
      if (rest === '/capabilities')
        return json(route, {
          employeeId: EMP,
          organizationIds: [ORG],
          tabs: {
            overview: true,
            employment: true,
            compensation: false,
            time: false,
            leave: true,
            benefits: false,
            documents: false,
            performance: false,
          },
          actions: {
            edit: true,
            changePosition: true,
            assignManager: true,
            addCompensation: false,
            manageDocuments: false,
            startOffboarding: false,
            manageLifecycle: true,
          },
        });
      if (rest === '/terminations') return json(route, { items: [] });
      return json(route, { message: 'Not found' }, 404);
    },
  );
}

const PEOPLE_ADMIN = ['organization.read', 'employee.read', 'employee.manage'];

test('employee directory: a named, focusable table; long names stay inside it at every width', async ({
  page,
}) => {
  await session(page, { permissions: PEOPLE_ADMIN, isEmployee: false });
  await employeesApi(page);
  await page.goto('/admin/employees');
  const region = page.getByRole('region', { name: 'Employees' });
  await expect(
    region.getByRole('rowheader', { name: 'Ada Lovelace-Byron King-Noel' }),
  ).toBeVisible();
  await expect(region).toHaveAttribute('tabindex', '0');
  await expect(region.getByText('Active', { exact: true })).toBeVisible();
  await checkAtAllWidths(page, () => expect(region).toBeVisible());
});

test('employee creation: the form fits every width', async ({ page }) => {
  await session(page, { permissions: PEOPLE_ADMIN, isEmployee: false });
  await employeesApi(page);
  await page.goto('/admin/employees/new');
  const h1 = page.getByRole('heading', { level: 1, name: 'Add employee' });
  await checkAtAllWidths(page, () => expect(h1).toBeVisible());
});

test('employee profile: tabs follow #hash deep links and Back/Forward; no overflow at any width', async ({
  page,
}) => {
  await session(page, { permissions: PEOPLE_ADMIN, isEmployee: false });
  await employeesApi(page);
  await page.goto(`/admin/employees/${EMP}#employment`);
  const tab = (name: string) => page.getByRole('tab', { name });
  await expect(tab('Employment')).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('heading', {
      level: 4,
      name: 'Senior Outdoor Education Program Coordinator and Trip Leader',
    }),
  ).toBeVisible();
  // The breadcrumb links back to the directory (the page's own back link was removed).
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Employees' }),
  ).toHaveAttribute('href', '/admin/employees');
  await checkAtAllWidths(page, () => expect(tab('Employment')).toBeVisible());
  // Picking a tab writes its hash; a new history entry (e.g. a link) and Back/Forward follow it.
  await tab('Leave').click();
  await expect(page).toHaveURL(new RegExp(`/admin/employees/${EMP}#leave$`));
  await expect(page.getByRole('heading', { level: 2, name: 'Leave' })).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = 'overview';
  });
  await expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(tab('Leave')).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  // On a fresh load, a hash naming no available tab opens Overview.
  await page.goto(`/admin/employees/${EMP}#benefits`);
  await page.reload();
  await expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
});

for (const target of [
  { path: '/admin/employees', heading: 'Employees' },
  { path: `/admin/employees/${EMP}`, heading: 'Ada Lovelace-Byron King-Noel' },
  { path: '/admin/compensation', heading: 'Pay groups' },
  { path: '/admin/audit', heading: 'Audit log' },
]) {
  test(`${target.path}: loading, never "Access denied", while permissions load; same width`, async ({
    page,
  }) => {
    await session(page, {
      permissions: [...PEOPLE_ADMIN, 'compensation.read', 'audit.read'],
      isEmployee: false,
      authorizationDelayMs: 1_500,
    });
    await employeesApi(page);
    await page.route(`${API}/compensation/**`, (route) => json(route, { items: [] }));
    await page.route(`${API}/audit/**`, (route) => json(route, { items: [], nextCursor: null }));
    await page.setViewportSize(VIEWPORTS.desktop);
    await page.goto(target.path, { waitUntil: 'commit' });
    const h1 = page.getByRole('heading', { level: 1, name: target.heading });
    const { sawDenied, widths } = await watchForDenied(page, () => h1.isVisible());
    await expect(h1).toBeVisible();
    expect(sawDenied).toBe(false);
    const loaded = await mainWidth(page);
    expect([...new Set([...widths, loaded])]).toEqual([loaded]);
  });
}

// ─── Leave administration ──────────────────────────────────────────────────

test('leave administration: tabs follow #hash deep links and Back/Forward; requests and types fit', async ({
  page,
}) => {
  await session(page, {
    permissions: ['leave.manage', 'leave.approve', 'holiday.read', 'holiday.manage'],
    isEmployee: false,
  });
  await leaveAdmin(page);
  await page.route(path('/leave/policies'), (route) => json(route, { items: [] }));
  await page.goto('/admin/leave#types');
  const tab = (name: string) => page.getByRole('tab', { name });
  await expect(tab('Leave types')).toHaveAttribute('aria-selected', 'true');
  const types = page.getByRole('region', { name: 'Leave types' });
  await expect(types).toHaveAttribute('tabindex', '0');
  await checkAtAllWidths(page, () => expect(types).toBeVisible());
  await page.evaluate(() => {
    window.location.hash = 'holidays';
  });
  await expect(tab('Holidays')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(tab('Leave types')).toHaveAttribute('aria-selected', 'true');
  await tab('Requests').click();
  await expect(tab('Requests')).toHaveAttribute('aria-selected', 'true');
  await checkAtAllWidths(page, () =>
    expect(page.getByRole('heading', { level: 1, name: 'Leave operations' })).toBeVisible(),
  );
});

// ─── Organization administration ───────────────────────────────────────────

test('organization administration: the list and an organization fit every width', async ({
  page,
}) => {
  await session(page, {
    permissions: ['organization.read', 'organization.manage'],
    isEmployee: false,
  });
  await page.route(`${API}/organizations*`, (route) =>
    json(route, [
      {
        id: ORG,
        name: ORG_NAME,
        code: 'NWA',
        description: 'Programs across three campuses, two lakes and a very long description line.',
        archivedAt: null,
        timezone: 'America/Toronto',
      },
    ]),
  );
  await page.route(path(`/organizations/${ORG}`), (route) =>
    json(route, {
      id: ORG,
      name: ORG_NAME,
      code: 'NWA',
      description: 'Programs across three campuses, two lakes and a very long description line.',
      archivedAt: null,
      timezone: 'America/Toronto',
    }),
  );
  await page.goto('/admin');
  await checkAtAllWidths(page, () =>
    expect(page.getByRole('heading', { level: 1, name: 'Organizations' })).toBeVisible(),
  );
  await page.goto(`/admin/organizations/${ORG}`);
  await checkAtAllWidths(page, () =>
    expect(page.getByRole('heading', { level: 1, name: ORG_NAME })).toBeVisible(),
  );
});

// ─── Role detail and user access: content at every width ───────────────────

test('role detail and user access: no overflow, serious axe or clipped actions at any width', async ({
  page,
}) => {
  await session(page, { permissions: ROLE_ADMIN, isEmployee: false });
  await rolesApi(page);
  await page.goto('/admin/access-control/roles/role-1');
  await checkAtAllWidths(page, () =>
    expect(page.getByRole('button', { name: 'Save permissions' })).toBeVisible(),
  );
  await page.goto('/admin/access-control/assignments?roleId=role-1');
  const people = page.getByRole('list', { name: 'People with this role' });
  await checkAtAllWidths(page, async () => {
    await expect(people.getByRole('button', { name: 'Revoke' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assign role' })).toBeVisible();
  });
});
