import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

const identity = {
  id: 'reporting-user',
  personId: 'person-reporting-user',
  email: 'ada@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const ORG = '11111111-1111-4111-8111-111111111111';
const DEPT = '22222222-2222-4222-8222-222222222222';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Matches an API path regardless of its query string. */
const path = (pathname: string) => (url: URL) => url.origin === API && url.pathname === pathname;

async function mockSession(page: Page, permissions: string[]) {
  let signedIn = false;
  await page.route('**/auth/refresh', (route) =>
    signedIn
      ? json(route, { accessToken: 'reporting-token', identity }, 201)
      : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'reporting-token', identity }, 201);
  });
  await page.route('**/auth/me', (route) =>
    signedIn ? json(route, identity) : json(route, {}, 401),
  );
  await page.route('**/auth/me/authorization', (route) =>
    json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({
        key,
        scopes: [{ type: 'ORGANIZATION', id: ORG }],
      })),
    }),
  );
  await page.route(path('/notifications/me/unread-count'), (route) => json(route, { unread: 0 }));
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const GROUP = [
  { key: 'groupKey', label: 'Group key', type: 'string' },
  { key: 'groupLabel', label: 'Group', type: 'string' },
];

const distribution = {
  key: 'workforce.distribution',
  title: 'Headcount distribution',
  description:
    'Headcount on a date by organizational unit, department, team, position or employment type.',
  sourcePermissions: ['employee.read'],
  organizationPermissions: [],
  dateMode: 'AS_OF',
  filters: [
    'asOf',
    'organizationalUnitId',
    'departmentId',
    'teamId',
    'positionId',
    'employmentType',
    'groupBy',
  ],
  groupBy: ['department', 'team', 'organizationalUnit', 'position', 'employmentType'],
  defaultGroupBy: 'department',
  sensitive: false,
  excludesSelf: false,
  columns: [
    ...GROUP,
    { key: 'headcount', label: 'Employees', type: 'integer' },
    { key: 'assignments', label: 'Assignments', type: 'integer' },
  ],
  canExport: true,
};

const payByGroup = {
  ...distribution,
  key: 'compensation.by_group',
  title: 'Pay by group',
  description: 'Average and median current pay rate on a date per group.',
  sourcePermissions: ['compensation.read'],
  sensitive: true,
  canExport: false,
  columns: [
    ...GROUP,
    { key: 'currency', label: 'Currency', type: 'string' },
    { key: 'employees', label: 'Employees', type: 'integer' },
    { key: 'averageRate', label: 'Average rate', type: 'money' },
    { key: 'suppressed', label: 'Suppressed', type: 'boolean' },
  ],
};

test('a report reader runs a report, exports CSV and learns Sheets needs a connection', async ({
  page,
}) => {
  await mockSession(page, ['report.read', 'report.export', 'employee.read']);
  const runs: Array<Record<string, string>> = [];
  let csvQuery: Record<string, string> | null = null;
  let csvAuthorization: string | undefined;
  let sheetsBody: unknown = null;

  await page.route(path('/reports/organizations'), (route) =>
    json(route, { items: [{ id: ORG, name: 'Camp', code: 'CAMP', timezone: 'UTC' }] }),
  );
  await page.route(path('/reports/catalog'), (route) =>
    json(route, {
      organizationId: ORG,
      items: [
        { area: 'workforce', reports: [distribution] },
        { area: 'compensation', reports: [payByGroup] },
      ],
    }),
  );
  await page.route(path(`/organizations/${ORG}/departments`), (route) =>
    json(route, [
      {
        id: DEPT,
        organizationId: ORG,
        name: 'Field',
        code: 'FLD',
        description: null,
        sortOrder: 0,
        archivedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        organizationalUnitId: null,
      },
    ]),
  );
  for (const resource of ['units', 'teams', 'positions']) {
    await page.route(path(`/organizations/${ORG}/${resource}`), (route) =>
      json(route, { statusCode: 403, message: 'Forbidden' }, 403),
    );
  }
  await page.route(path('/reports/workforce.distribution'), (route) => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams);
    runs.push(query);
    return json(route, {
      reportKey: 'workforce.distribution',
      area: 'workforce',
      title: 'Headcount distribution',
      generatedAt: '2026-10-06T12:00:00.000Z',
      filters: query,
      scopeSummary: {
        organizationId: ORG,
        placement: 'POSITION',
        organizationWide: false,
        scopes: [{ type: 'ORGANIZATION', id: ORG }],
        positions: 7,
        openings: null,
        selfExcluded: false,
      },
      columns: distribution.columns,
      rows: [
        { groupKey: 't-1', groupLabel: 'Trail crew', headcount: 1250, assignments: 1251 },
        { groupKey: 't-2', groupLabel: 'Kitchen', headcount: 9, assignments: 9 },
      ],
      suppressed: 0,
      notes: [],
    });
  });
  await page.route(path('/reports/workforce.distribution/export.csv'), (route) => {
    csvQuery = Object.fromEntries(new URL(route.request().url()).searchParams);
    csvAuthorization = route.request().headers()['authorization'];
    return route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="workforce.distribution-2026-10-06.csv"',
        'Access-Control-Expose-Headers': 'Content-Disposition',
      },
      body: 'Group key,Group,Employees,Assignments\r\nt-1,Trail crew,1250,1251\r\n',
    });
  });
  await page.route(path('/reports/workforce.distribution/export/google-sheets'), (route) => {
    sheetsBody = route.request().postDataJSON();
    return json(
      route,
      {
        statusCode: 409,
        code: 'GOOGLE_CONNECTION_REQUIRED',
        message:
          'Exporting to Google Sheets needs an active Google Workspace connection with the Sheets export capability.',
      },
      409,
    );
  });

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Reports', exact: true })
    .click();
  await expect(page).toHaveURL(/\/reports(\?organizationId=.*)?$/);
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  const workforce = page.getByRole('region', { name: 'Workforce' });
  await expect(workforce.getByText(distribution.description)).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Compensation' }).getByText('Small groups suppressed'),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Payroll' })).toHaveCount(0);

  await workforce.getByRole('link', { name: 'Headcount distribution' }).click();
  await expect(page).toHaveURL(
    new RegExp(`/reports/workforce\\.distribution\\?organizationId=${ORG}$`),
  );
  await expect(page.getByRole('heading', { name: 'Headcount distribution' })).toBeVisible();
  await expect(page.getByLabel('Group by')).toHaveValue('department');
  await expect(page.getByLabel('Team ID')).toBeVisible();

  await page.getByLabel('As of').fill('2026-09-30');
  await page.getByLabel('Department').selectOption({ label: 'Field (FLD)' });
  await page.getByLabel('Group by').selectOption({ label: 'Team' });
  await page.getByRole('button', { name: 'Run report' }).click();

  const table = page.getByRole('table', { name: 'Headcount distribution' });
  await expect(table.getByRole('row', { name: /Trail crew 1,250 1,251/ })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Group key' })).toHaveCount(0);
  await expect(page.getByTestId('scope-summary')).toContainText('Limited to 1 scope');
  await expect(page.getByTestId('scope-summary')).toContainText('narrowed by the selected filters');
  expect(runs).toEqual([
    { organizationId: ORG, asOf: '2026-09-30', departmentId: DEPT, groupBy: 'team' },
  ]);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('workforce.distribution-2026-10-06.csv');
  await expect(page.getByText('Downloaded workforce.distribution-2026-10-06.csv.')).toBeVisible();
  expect(csvQuery).toEqual({
    organizationId: ORG,
    asOf: '2026-09-30',
    departmentId: DEPT,
    groupBy: 'team',
  });
  expect(csvAuthorization).toBe('Bearer reporting-token');

  await page.getByRole('button', { name: 'Export to Google Sheets' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Exporting to Google Sheets' });
  await expect(alert).toContainText(
    'needs an active Google Workspace connection with the Sheets export capability',
  );
  await expect(alert.getByRole('link', { name: 'Set up Google Workspace' })).toHaveAttribute(
    'href',
    '/settings/integrations/google',
  );
  expect(sheetsBody).toEqual({
    organizationId: ORG,
    asOf: '2026-09-30',
    departmentId: DEPT,
    groupBy: 'team',
  });
  // Batch 3B: no serious or critical accessibility violations on the final page.
  await expectNoSeriousA11yViolations(page);
});

test('a non-exportable sensitive report shows suppressed groups without export buttons', async ({
  page,
}) => {
  await mockSession(page, ['report.read', 'compensation.read']);
  await page.route(path('/reports/organizations'), (route) =>
    json(route, { items: [{ id: ORG, name: 'Camp', code: 'CAMP', timezone: 'UTC' }] }),
  );
  await page.route(path('/reports/catalog'), (route) =>
    json(route, { organizationId: ORG, items: [{ area: 'compensation', reports: [payByGroup] }] }),
  );
  await page.route(
    (url) => url.origin === API && url.pathname.startsWith(`/organizations/${ORG}/`),
    (route) => json(route, [], 200),
  );
  await page.route(path('/reports/compensation.by_group'), (route) =>
    json(route, {
      reportKey: 'compensation.by_group',
      area: 'compensation',
      title: 'Pay by group',
      generatedAt: '2026-10-06T12:00:00.000Z',
      filters: { organizationId: ORG },
      scopeSummary: {
        organizationId: ORG,
        placement: 'POSITION',
        organizationWide: true,
        scopes: [{ type: 'ORGANIZATION', id: ORG }],
        positions: 4,
        openings: null,
        selfExcluded: false,
      },
      columns: payByGroup.columns,
      rows: [
        {
          groupKey: 'd-1',
          groupLabel: 'Field',
          currency: 'CAD',
          employees: 12,
          averageRate: 27.5,
          suppressed: false,
        },
        {
          groupKey: 'd-2',
          groupLabel: 'Office',
          currency: 'CAD',
          employees: null,
          averageRate: null,
          suppressed: true,
        },
      ],
      suppressed: 1,
      notes: [],
    }),
  );

  await signIn(page);
  await page.goto(`/reports/compensation.by_group?organizationId=${ORG}`);
  await page.getByRole('button', { name: 'Run report' }).click();
  const table = page.getByRole('table', { name: 'Pay by group' });
  await expect(table.getByRole('cell', { name: 'CAD 27.50' })).toBeVisible();
  await expect(table.getByText('Suppressed (fewer than 5)')).toHaveCount(2);
  await expect(page.getByRole('note')).toContainText('1 group with fewer than 5 people');
  await expect(page.getByTestId('scope-summary')).toContainText('Organization-wide');
  await expect(page.getByRole('button', { name: 'Export CSV' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export to Google Sheets' })).toHaveCount(0);
});

test('the Reports link is hidden without report.read', async ({ page }) => {
  await mockSession(page, ['report.export', 'employee.read']);
  await signIn(page);
  await expect(page.getByRole('link', { name: 'Employees' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Reports', exact: true })).toHaveCount(0);
  await page.goto('/reports');
  await expect(page.getByText('You do not have permission to view reports.')).toBeVisible();
});
