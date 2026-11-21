import { expect, test, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

const identity = {
  id: 'user-org-admin',
  personId: 'person-org-admin',
  email: 'structure-admin@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

type ResourceName =
  'units' | 'departments' | 'teams' | 'job-titles' | 'positions' | 'work-locations';

interface MockRecord {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  description: string | null;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

interface MockUnitNode extends MockRecord {
  children: MockUnitNode[];
}

const organizationId = 'org-phase3-e2e';
const rootUnitId = 'unit-phase3-root';
const childUnitId = 'unit-phase3-child';
const departmentId = 'department-phase3';
const teamId = 'team-phase3';
const jobTitleId = 'job-title-phase3';
const positionId = 'position-phase3';
const siteId = 'site-phase3';
const archiveSiteId = 'unused-site-phase3';

const patches: Array<{ resource: string; id: string; body: Record<string, unknown> }> = [];
const posts: Array<{ resource: string; body: Record<string, unknown> }> = [];

/**
 * R5B: an existing organization (Teaching department, an active and an archived job title, a work
 * location, and a staffed position). `scoped` answers like the API does for a department manager:
 * the organization itself is refused and its job titles / work locations list empty, while the
 * position reference options still offer the active ones.
 */
interface MockSeed {
  scoped: boolean;
}
const STAFFED_POSITION_ID = 'position-staffed-r5b';
const IDENTITY_FIELDS = [
  'jobTitleId',
  'workLocationId',
  'organizationalUnitId',
  'departmentId',
  'teamId',
];

function seededRecords(now: string): Record<ResourceName, MockRecord[]> {
  const record = (id: string, name: string, code: string, extra: Record<string, unknown> = {}) => ({
    id,
    organizationId,
    name,
    code,
    description: null,
    sortOrder: 0,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  return {
    units: [],
    departments: [record(departmentId, 'Teaching', 'TEACHING', { organizationalUnitId: null })],
    teams: [],
    'job-titles': [
      record(jobTitleId, 'Teacher', 'TEACHER'),
      record('job-title-retired', 'Tutor', 'TUTOR', { archivedAt: now }),
    ],
    positions: [
      record(STAFFED_POSITION_ID, 'Senior Teacher', 'SENIOR-TEACHER', {
        jobTitleId,
        workLocationId: siteId,
        organizationalUnitId: null,
        departmentId,
        teamId: null,
      }),
    ],
    'work-locations': [
      record(siteId, 'Main Campus', 'MAIN-CAMPUS', {
        physicalSiteId: `physical-${siteId}`,
        physicalSite: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        stateProvince: null,
        postalCode: null,
        country: null,
        timezone: 'America/Toronto',
      }),
    ],
  };
}

function createMockApi(seed?: MockSeed) {
  const now = '2026-10-01T00:00:00.000Z';
  let organization: MockRecord | null = seed
    ? {
        id: organizationId,
        organizationId,
        name: 'Northwind Academy',
        code: 'NORTHWIND',
        description: null,
        sortOrder: 0,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }
    : null;
  const records: Record<ResourceName, MockRecord[]> = seed
    ? seededRecords(now)
    : {
        units: [],
        departments: [],
        teams: [],
        'job-titles': [],
        positions: [],
        'work-locations': [],
      };

  function makeRecord(
    resource: ResourceName,
    id: string,
    body: Record<string, unknown>,
  ): MockRecord {
    const common = {
      id,
      organizationId,
      name: String(body.name ?? ''),
      code: String(body.code ?? ''),
      description: typeof body.description === 'string' ? body.description : null,
      sortOrder: Number(body.sortOrder ?? 0),
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (resource === 'units') return { ...common, parentUnitId: body.parentUnitId ?? null };
    if (resource === 'departments') {
      return { ...common, organizationalUnitId: body.organizationalUnitId ?? null };
    }
    if (resource === 'teams') {
      return {
        ...common,
        departmentId: body.departmentId ?? null,
        organizationalUnitId: body.organizationalUnitId ?? null,
      };
    }
    if (resource === 'positions') {
      return {
        ...common,
        jobTitleId: body.jobTitleId,
        organizationalUnitId: body.organizationalUnitId ?? null,
        departmentId: body.departmentId ?? null,
        teamId: body.teamId ?? null,
        workLocationId: body.workLocationId ?? null,
      };
    }
    if (resource === 'work-locations') {
      // Like the API: an existing site when one is chosen, otherwise a new site of the same name.
      const physicalSiteId = String(body.physicalSiteId ?? `physical-${id}`);
      return {
        ...common,
        physicalSiteId,
        physicalSite: { id: physicalSiteId, organizationId, name: common.name },
        addressLine1: body.addressLine1 ?? null,
        addressLine2: body.addressLine2 ?? null,
        city: body.city ?? null,
        stateProvince: body.stateProvince ?? null,
        postalCode: body.postalCode ?? null,
        country: body.country ?? null,
        timezone: body.timezone ?? null,
      };
    }
    return common;
  }

  function structure() {
    function node(record: MockRecord): MockUnitNode {
      return {
        ...record,
        children: records.units
          .filter((child) => child.parentUnitId === record.id && !child.archivedAt)
          .map(node),
      };
    }
    return records.units.filter((unit) => !unit.parentUnitId && !unit.archivedAt).map(node);
  }

  return async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const segments = url.pathname
      .replace(/^\/organizations\/?/, '')
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    const method = request.method();
    const body =
      method === 'POST' || method === 'PATCH'
        ? (request.postDataJSON() as Record<string, unknown>)
        : {};
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });

    if (segments.length === 0) {
      if (method === 'GET') return json(organization ? [organization] : []);
      organization = {
        id: organizationId,
        organizationId,
        name: String(body.name ?? ''),
        code: String(body.code ?? ''),
        description: typeof body.description === 'string' ? body.description : null,
        sortOrder: Number(body.sortOrder ?? 0),
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      return json(organization, 201);
    }
    if (segments.length === 1) {
      if (seed?.scoped) return json({ message: 'Forbidden' }, 403);
      return organization ? json(organization) : json({ message: 'Not found' }, 404);
    }
    if (segments[1] === 'structure' && method === 'GET') return json(structure());
    if (segments[1] === 'position-reference-options' && method === 'GET') {
      const active = (resource: ResourceName) =>
        records[resource]
          .filter((record) => !record.archivedAt)
          .map(({ id, name, code }) => ({ id, name, code }));
      return json({ jobTitles: active('job-titles'), workLocations: active('work-locations') });
    }

    const resource = segments[1] as ResourceName;
    const collection = records[resource];
    if (!collection) return json({ message: 'Not found' }, 404);
    if (segments.length === 2) {
      if (method === 'GET') {
        // The API lists these by organization.read on the organization itself.
        if (seed?.scoped && (resource === 'job-titles' || resource === 'work-locations'))
          return json([]);
        const includeArchived = url.searchParams.get('includeArchived') === 'true';
        return json(
          includeArchived ? collection : collection.filter((record) => !record.archivedAt),
        );
      }
      posts.push({ resource, body });
      const id =
        resource === 'units'
          ? body.parentUnitId
            ? childUnitId
            : rootUnitId
          : resource === 'departments'
            ? departmentId
            : resource === 'teams'
              ? teamId
              : resource === 'job-titles'
                ? jobTitleId
                : resource === 'positions'
                  ? positionId
                  : body.name === 'Unused Site'
                    ? archiveSiteId
                    : siteId;
      const record = makeRecord(resource, id, body);
      collection.push(record);
      return json(record, 201);
    }
    if (segments[3] === 'archive') {
      const record = collection.find((item) => item.id === segments[2]);
      if (record) record.archivedAt = now;
      return json({ success: true }, 201);
    }
    if (segments[3] === 'reactivate') {
      const record = collection.find((item) => item.id === segments[2]);
      if (record) record.archivedAt = null;
      return json({ success: true }, 201);
    }
    if (segments[2] && method === 'PATCH') {
      patches.push({ resource, id: segments[2], body });
      // Like the API: a Position with employment history refuses any identity field, even unchanged.
      if (
        segments[2] === STAFFED_POSITION_ID &&
        IDENTITY_FIELDS.some((field) => Object.hasOwn(body, field))
      ) {
        return json(
          {
            message:
              'A position referenced by employment history cannot have its organizational identity changed.',
          },
          400,
        );
      }
      const record = collection.find((item) => item.id === segments[2]);
      if (record) Object.assign(record, body);
      return json(record ?? { message: 'Not found' }, record ? 200 : 404);
    }
    return json({ message: 'Not found' }, 404);
  };
}

test.beforeEach(async ({ page }, testInfo) => {
  await page.route('**/auth/refresh', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/auth/login', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken: 'organization-e2e-token', identity }),
    }),
  );
  await page.route('**/auth/me/authorization', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: identity.id,
        permissions: testInfo.title.includes('unauthorized')
          ? []
          : testInfo.title.includes('SYSTEM-only')
            ? [
                { key: 'organization.read', scopes: [{ type: 'SYSTEM' }] },
                {
                  key: 'organization.manage',
                  scopes: [{ type: 'ORGANIZATION', id: organizationId }],
                },
              ]
            : testInfo.title.includes('department manager')
              ? [
                  {
                    key: 'organization.read',
                    scopes: [{ type: 'DEPARTMENT', id: departmentId }],
                  },
                  {
                    key: 'organization.manage',
                    scopes: [{ type: 'DEPARTMENT', id: departmentId }],
                  },
                ]
              : testInfo.title.includes('Access Control happy')
                ? [
                    { key: 'organization.read', scopes: [{ type: 'SYSTEM' }] },
                    { key: 'role.read', scopes: [{ type: 'ORGANIZATION', id: organizationId }] },
                    { key: 'role.manage', scopes: [{ type: 'ORGANIZATION', id: organizationId }] },
                    { key: 'role.assign', scopes: [{ type: 'ORGANIZATION', id: organizationId }] },
                  ]
                : [
                    { key: 'organization.read', scopes: [{ type: 'SYSTEM' }] },
                    { key: 'organization.manage', scopes: [{ type: 'SYSTEM' }] },
                  ],
      }),
    }),
  );
  await page.route(
    `${API}/organizations**`,
    createMockApi(
      testInfo.title.includes('R5B')
        ? { scoped: testInfo.title.includes('department manager') }
        : undefined,
    ),
  );
});

test('authenticated user manages the organization structure and record lifecycle', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Organization' })
    .click();
  await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible();

  await page.getByRole('button', { name: 'New organization' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Northwind Academy');
  await page.getByLabel('Code', { exact: true }).fill('northwind');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('link', { name: 'Northwind Academy', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Northwind Academy' })).toBeVisible();

  await page.getByRole('link', { name: 'Business Units' }).click();
  await page.getByRole('button', { name: 'New record' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Academic');
  await page.getByLabel('Code', { exact: true }).fill('ACADEMIC');
  await page.getByRole('button', { name: 'Create Business Unit' }).click();
  await expect(page.getByText('Academic', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New record' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Primary School');
  await page.getByLabel('Code', { exact: true }).fill('PRIMARY');
  await page.getByLabel('Parent Unit').selectOption(rootUnitId);
  await page.getByRole('button', { name: 'Create Business Unit' }).click();
  await expect(page.getByText('Primary School', { exact: true })).toBeVisible();
  await expect(page.getByText('Parent: Academic')).toBeVisible();

  await page.getByRole('link', { name: '← Northwind Academy' }).click();
  await page.getByRole('link', { name: 'Departments' }).click();
  await page.getByRole('button', { name: 'New record' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Teaching');
  await page.getByLabel('Code', { exact: true }).fill('TEACHING');
  await page.getByLabel('Business Unit').selectOption(rootUnitId);
  await page.getByRole('button', { name: 'Create Department' }).click();
  await expect(page.getByText('Teaching', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '← Northwind Academy' }).click();
  await page.getByRole('link', { name: 'Teams' }).click();
  await page.getByRole('button', { name: 'New record' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Primary Teachers');
  await page.getByLabel('Code', { exact: true }).fill('PRIMARY-TEACHERS');
  await page.locator('select[name="departmentId"]').selectOption({ label: 'Teaching (TEACHING)' });
  await page.getByRole('button', { name: 'Create Team' }).click();
  await expect(page.getByText('Department: Teaching')).toBeVisible();

  await page.getByRole('link', { name: '← Northwind Academy' }).click();
  await page.getByRole('link', { name: 'Job Titles' }).click();
  await page.getByRole('button', { name: 'New record' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Teacher');
  await page.getByLabel('Code', { exact: true }).fill('TEACHER');
  await page.getByRole('button', { name: 'Create Job Title' }).click();
  await expect(page.getByText('Teacher', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '← Northwind Academy' }).click();
  await page.getByRole('link', { name: /^Work Locations/ }).click();
  await page.getByRole('button', { name: 'New record' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Main Campus');
  await page.getByLabel('Code', { exact: true }).fill('MAIN-CAMPUS');
  await page.getByLabel('City').fill('Northwind');
  await page.getByLabel('Timezone (IANA)').fill('America/Toronto');
  await page.getByRole('button', { name: 'Create Work Location' }).click();
  await expect(page.getByText('Main Campus', { exact: true })).toBeVisible();

  // Editing keeps the location on its physical site (kiosk devices are tied to the site).
  await page
    .getByRole('row', { name: /MAIN-CAMPUS.*Main Campus/ })
    .getByRole('button', { name: 'Edit' })
    .click();
  await expect(page.getByLabel('Physical Site')).toHaveValue(`physical-${siteId}`);
  await page.getByLabel('City').fill('Northwind Falls');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect
    .poll(() => patches.find((patch) => patch.id === siteId)?.body.physicalSiteId)
    .toBe(`physical-${siteId}`);

  await page.getByRole('button', { name: 'New record' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Unused Site');
  await page.getByLabel('Code', { exact: true }).fill('UNUSED-SITE');
  await page.getByRole('button', { name: 'Create Work Location' }).click();
  await expect(page.getByText('Unused Site', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: '← Northwind Academy' }).click();
  await page.getByRole('link', { name: 'Positions' }).click();
  await page.getByRole('button', { name: 'New record' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Primary Teacher');
  await page.getByLabel('Code', { exact: true }).fill('PRIMARY-TEACHER');
  await page.getByLabel('Job Title').selectOption(jobTitleId);
  await page.getByLabel('Work Location').selectOption(siteId);
  await page.getByLabel('Placement type').selectOption('teams');
  await page.locator('select[name="teamId"]').selectOption(teamId);
  await page.getByRole('button', { name: 'Create Position' }).click();
  await expect(page.getByText('Team: Primary Teachers')).toBeVisible();

  await page.getByRole('link', { name: '← Northwind Academy' }).click();
  await page.getByRole('link', { name: /^Work Locations/ }).click();
  const unusedSiteRow = page.getByRole('row', { name: /UNUSED-SITE.*Unused Site/ });
  await unusedSiteRow.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('button', { name: 'Confirm archive' }).click();
  await expect(page.getByRole('status').getByText('Unused Site archived.')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Show archived' }).check();
  const archivedRow = page.getByRole('row', { name: /UNUSED-SITE.*Unused Site/ });
  await expect(archivedRow.getByText('Archived')).toBeVisible();
  await archivedRow.getByRole('button', { name: 'Reactivate' }).click();
  await expect(page.getByRole('status').getByText('Unused Site reactivated.')).toBeVisible();
});

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.route('**/auth/refresh', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken: 'organization-e2e-token' }),
    }),
  );
  await page.route('**/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(identity) }),
  );
}

test('denies an unauthorized Access Control route', async ({ page }) => {
  await signIn(page);
  await page.goto('/admin/access-control/roles');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
});

test('excludes SYSTEM-only management from organization controls', async ({ page }) => {
  await signIn(page);
  await page.goto('/admin/organizations');
  await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New organization' })).not.toBeVisible();
});

test('Access Control happy path completes a role and scoped assignment workflow', async ({
  page,
}) => {
  const roleId = 'role-access-control-e2e';
  const userId = 'user-access-control-e2e';
  let rolePermissions = ['organization.read'];
  let assignment: Record<string, unknown> | null = null;

  await signIn(page);
  await page.route(`${API}/organizations?includeArchived=true`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: organizationId,
          name: 'Northwind Academy',
          code: 'NORTHWIND',
          description: null,
          sortOrder: 0,
          archivedAt: null,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ]),
    }),
  );
  await page.route(`${API}/authorization/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON() as Record<string, unknown> | null;
    if (url.pathname.endsWith('/permissions') && request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'permission-org-read',
            key: 'organization.read',
            name: 'Read organization',
            description: null,
            isActive: true,
          },
          {
            id: 'permission-role-read',
            key: 'role.read',
            name: 'Read roles',
            description: null,
            isActive: true,
          },
          {
            id: 'permission-role-assign',
            key: 'role.assign',
            name: 'Assign roles',
            description: null,
            isActive: true,
          },
        ]),
      });
    }
    if (url.pathname.endsWith('/roles') && request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: roleId,
            organizationId,
            code: 'ACCESS-E2E',
            name: 'Access E2E',
            description: 'Playwright role',
            isSystemOwner: false,
            archivedAt: null,
            permissions: rolePermissions.map((key) => ({
              permissionId: key,
              permission: { key, name: key, description: null, isActive: true },
            })),
          },
        ]),
      });
    }
    if (url.pathname.endsWith('/roles') && request.method() === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: roleId,
          organizationId,
          code: 'ACCESS-E2E',
          name: 'Access E2E',
          description: 'Playwright role',
          isSystemOwner: false,
          archivedAt: null,
          permissions: [],
        }),
      });
    }
    if (url.pathname === `/authorization/roles/${roleId}` && request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: roleId,
          organizationId,
          code: 'ACCESS-E2E',
          name: 'Access E2E',
          description: 'Playwright role',
          isSystemOwner: false,
          archivedAt: null,
          permissions: rolePermissions.map((key) => ({
            permissionId: key,
            permission: { key, name: key, description: null, isActive: true },
          })),
        }),
      });
    }
    if (
      url.pathname === `/authorization/roles/${roleId}/permissions` &&
      request.method() === 'PUT'
    ) {
      rolePermissions = (body?.permissionKeys as string[]) ?? [];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
    }
    if (
      url.pathname === `/authorization/roles/${roleId}/assignments` &&
      request.method() === 'GET'
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: assignment ? [assignment] : [], nextCursor: null }),
      });
    }
    if (url.pathname === '/authorization/users' && request.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            { id: userId, email: 'assignee@example.com', personId: 'person-access-control-e2e' },
          ],
          nextCursor: null,
        }),
      });
    }
    if (url.pathname === '/authorization/assignments' && request.method() === 'POST') {
      assignment = {
        id: 'assignment-access-control-e2e',
        userId,
        roleId,
        scopeType: 'ORGANIZATION',
        organizationId,
        organizationalUnitId: null,
        departmentId: null,
        teamId: null,
        startsAt: '2026-10-01T00:00:00.000Z',
        expiresAt: null,
        revokedAt: null,
        user: { id: userId, email: 'assignee@example.com' },
      };
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(assignment),
      });
    }
    if (url.pathname.endsWith('/revoke') && request.method() === 'POST') {
      if (assignment) assignment = { ...assignment, revokedAt: '2026-10-01T01:00:00.000Z' };
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(assignment),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Not found' }),
    });
  });

  await page.goto('/admin/access-control/roles');
  await page.getByLabel('Organization').selectOption(organizationId);
  await page.getByLabel(/^Code/).fill('ACCESS-E2E');
  await page.getByLabel(/^Name/).fill('Access E2E');
  await page.getByLabel(/^Description/).fill('Playwright role');
  await page.getByText('Read organization').click();
  await page.getByRole('button', { name: 'Create role' }).click();
  await page.getByRole('link', { name: 'Access E2E' }).click();
  await page.getByRole('checkbox', { name: /Read roles/ }).check();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await page.getByRole('link', { name: 'Manage user access' }).click();
  await expect(page.getByRole('option', { name: 'SYSTEM' })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'All organizations' })).toHaveCount(0);
  // The user picker searches as you type and is chosen from its list (keyboard here).
  const userSearch = page.getByRole('combobox', { name: /Find user/ });
  await userSearch.fill('assignee');
  await expect(page.getByRole('option', { name: /assignee@example.com/ })).toBeVisible();
  await userSearch.press('ArrowDown');
  await userSearch.press('Enter');
  await expect(userSearch).toHaveValue('assignee@example.com');
  await page.getByLabel('Scope').selectOption('ORGANIZATION');
  await page.getByLabel('Organization', { exact: true }).selectOption(organizationId);
  await page.getByRole('button', { name: 'Assign role' }).click();
  // Batch 10B: each person is a list item with a status badge.
  const holder = page
    .getByRole('list', { name: 'People with this role' })
    .getByRole('listitem')
    .filter({ hasText: 'assignee@example.com' });
  await expect(holder).toContainText('Organization');
  await expect(holder).toContainText('Active');
  await page.getByRole('button', { name: /^Revoke for / }).click();
  const revoke = page.getByRole('alertdialog', { name: 'Revoke user access?' });
  await expect(revoke).toContainText('assignee@example.com');
  await revoke.getByRole('button', { name: 'Revoke access' }).click();
  await expect(revoke).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Show revoked access' }).check();
  await expect(holder).toContainText('Revoked');
  // Batch 3B: no serious or critical accessibility violations on the final page.
  await expectNoSeriousA11yViolations(page);
});

test('R5B: a department manager creates a Position from the reference options', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/admin/organizations/${organizationId}/positions`);
  await expect(page.getByRole('heading', { name: 'Positions', level: 1 })).toBeVisible();
  // Names come from the reference options although the organization lists are empty for them.
  await expect(
    page
      .getByRole('row', { name: /SENIOR-TEACHER/ })
      .getByText('Department: Teaching · Teacher · Main Campus'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'New record' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Assistant Teacher');
  await page.getByLabel('Code', { exact: true }).fill('ASSISTANT-TEACHER');
  const jobTitle = page.getByLabel('Job Title');
  await expect(jobTitle.locator('option')).toHaveText(['Select…', 'Teacher (TEACHER)']);
  await jobTitle.selectOption({ label: 'Teacher (TEACHER)' });
  await page.getByLabel('Work Location').selectOption({ label: 'Main Campus (MAIN-CAMPUS)' });
  await page.getByLabel('Placement type').selectOption('departments');
  await page.locator('select[name="departmentId"]').selectOption(departmentId);
  await page.getByRole('button', { name: 'Create Position' }).click();
  await expect(page.getByRole('status').getByText('Positions created.')).toBeVisible();
  expect(posts.at(-1)).toEqual({
    resource: 'positions',
    body: {
      name: 'Assistant Teacher',
      code: 'ASSISTANT-TEACHER',
      description: '',
      sortOrder: 0,
      jobTitleId,
      workLocationId: siteId,
      departmentId,
    },
  });
  await expect(page.getByRole('row', { name: /ASSISTANT-TEACHER/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('R5B: an organization admin renames a staffed Position without resending its identity', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/admin/organizations/${organizationId}/positions`);
  await page
    .getByRole('row', { name: /SENIOR-TEACHER/ })
    .getByRole('button', { name: 'Edit' })
    .click();
  await expect(page.getByLabel('Job Title')).toHaveValue(jobTitleId);
  await expect(page.getByLabel('Work Location')).toHaveValue(siteId);
  await page.getByLabel('Name', { exact: true }).fill('Lead Teacher');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').getByText('Positions updated.')).toBeVisible();
  await expect(page.getByRole('row', { name: /SENIOR-TEACHER.*Lead Teacher/ })).toBeVisible();
  const patch = patches.findLast((item) => item.id === STAFFED_POSITION_ID);
  expect(patch?.body).toEqual({ name: 'Lead Teacher', description: '', sortOrder: 0 });
  await expectNoSeriousA11yViolations(page);
});
