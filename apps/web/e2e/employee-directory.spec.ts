import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

const identity = {
  id: 'employee-reader',
  personId: 'person-reader',
  email: 'reader@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const assignment = {
  id: 'assignment-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-09-01',
  endDate: null,
  isPrimary: true,
  position: { id: 'position-1', name: 'Platform Engineer', code: 'PE-1' },
  jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  placement: { type: 'TEAM', id: 'team-1', name: 'Platform', code: 'PLAT' },
  workLocation: null,
  manager: null,
};
const position = {
  id: 'position-1',
  name: 'Platform Engineer',
  code: 'PE-1',
  jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  placement: { type: 'TEAM', id: 'team-1', name: 'Platform', code: 'PLAT' },
  workLocation: { id: 'location-1', name: 'HQ', code: 'HQ' },
};

const employee = {
  id: 'employee-1',
  employeeNumber: 'EMP-000001',
  status: 'ACTIVE',
  person: { firstName: 'Ada', middleName: null, lastName: 'Lovelace', preferredName: null },
  displayAssignment: assignment,
};
const managerSummary = {
  assignmentId: 'manager-1',
  employeeId: 'manager-1',
  employeeNumber: 'EMP-2',
  displayName: 'Grace Hopper',
  positionName: 'Engineering Manager',
};
let authorizationPermissions: Array<{ key: string; scopes: Array<{ type: string; id?: string }> }> =
  [{ key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] }];

test.beforeEach(async ({ page }) => {
  authorizationPermissions = [{ key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] }];
  await page.route('**/auth/refresh', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/auth/login', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken: 'employee-e2e-token', identity }),
    }),
  );
  await page.route('**/auth/me/authorization', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: identity.id,
        permissions: authorizationPermissions,
      }),
    }),
  );
  await page.route(`${API}/organizations**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'org-1', name: 'Acme', code: 'ACME' }]),
    }),
  );
  await page.route(`${API}/organizations/org-1/job-titles**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'job-1', name: 'Engineer', code: 'ENG' }]),
    }),
  );
});

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('renders the read-only directory, query filters, and profile navigation', async ({ page }) => {
  const requests: string[] = [];
  await page.route(`${API}/employees**`, async (route) => {
    requests.push(route.request().url());
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/employee-1')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...employee,
          hireDate: '2026-01-02',
          terminationDate: null,
          person: { ...employee.person, personalEmail: 'ada@example.com', phone: '555-0100' },
          assignments: {
            current: [{ ...assignment, manager: managerSummary }],
            upcoming: [],
            historical: [],
            cancelled: [],
          },
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [employee], nextAfterId: null }),
    });
  });

  await signIn(page);
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Employees' }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await expect(page.getByRole('heading', { name: 'Employees' })).toBeVisible();
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
  await page.getByLabel('Search employees').fill('Ada');
  await expect.poll(() => requests.some((url) => url.includes('search=Ada'))).toBe(true);
  await page.getByRole('link', { name: 'EMP-000001' }).click();
  await expect(page).toHaveURL(/\/admin\/employees\/employee-1$/);
  await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible();
  await expect(page.getByText('Jan 2, 2026')).toBeVisible();
  await page.getByRole('tab', { name: 'Employment' }).click();
  await expect(page.getByText('Platform Engineer')).toBeVisible();
  await expect(page.getByText('Full Time')).toBeVisible();
  await expect(page.getByText('Grace Hopper')).toBeVisible();
  // Batch 3B: no serious or critical accessibility violations on the final page.
  await expectNoSeriousA11yViolations(page);
});

test('sends status, organization, and dependent job title filters', async ({ page }) => {
  const requests: string[] = [];
  await page.route(`${API}/employees**`, async (route) => {
    requests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [employee], nextAfterId: null }),
    });
  });
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await page.getByLabel('Status').selectOption('TERMINATED');
  await expect.poll(() => requests.some((url) => url.includes('status=TERMINATED'))).toBe(true);
  await page
    .locator('label')
    .filter({ hasText: /^Organization/ })
    .locator('select')
    .selectOption('org-1');
  await expect.poll(() => requests.some((url) => url.includes('organizationId=org-1'))).toBe(true);
  await page.getByLabel('Job title').selectOption('job-1');
  await expect.poll(() => requests.some((url) => url.includes('jobTitleId=job-1'))).toBe(true);
});

test('loads and appends a cursor page', async ({ page }) => {
  const requests: string[] = [];
  await page.route(`${API}/employees**`, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.toString());
    const secondPage = url.searchParams.get('afterId') === 'employee-1';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          secondPage ? { ...employee, id: 'employee-2', employeeNumber: 'EMP-000002' } : employee,
        ],
        nextAfterId: secondPage ? null : 'employee-1',
      }),
    });
  });
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await expect(page.getByText('EMP-000001')).toBeVisible();
  await page.getByRole('button', { name: 'Load more employees' }).click();
  await expect(page.getByText('EMP-000002')).toBeVisible();
  expect(requests.some((url) => url.includes('afterId=employee-1'))).toBe(true);
});

test('renders directory empty and API error states', async ({ page }) => {
  let error = false;
  await page.route(`${API}/employees**`, async (route) => {
    if (error) return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextAfterId: null }),
    });
  });
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await expect(page.getByText('No employees found.')).toBeVisible();
  error = true;
  await page.getByPlaceholder('Search by employee number or name').fill('offline');
  await expect(page.getByRole('alert')).toBeVisible();
});

test('renders unassigned, terminated, manager, null-manager, and not-found profiles', async ({
  page,
}) => {
  let directoryId = 'employee-1';
  await page.route(`${API}/employees**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/employees')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [{ ...employee, id: directoryId }], nextAfterId: null }),
      });
    }
    const id = url.pathname.split('/').pop();
    if (id === 'missing')
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    const terminated = id === 'terminated';
    const manager = null;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...employee,
        id,
        status: terminated ? 'TERMINATED' : 'ACTIVE',
        hireDate: '2026-01-02',
        terminationDate: terminated ? '2026-09-30' : null,
        assignments: {
          current: id === 'unassigned' ? [] : [{ ...assignment, manager }],
          upcoming: [],
          historical: [],
          cancelled: [],
        },
      }),
    });
  });
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await expect(page.getByRole('heading', { name: 'Employees' })).toBeVisible();
  await page.getByRole('link', { name: 'EMP-000001' }).click();
  await expect(page.getByText('EMP-2')).not.toBeVisible();
  directoryId = 'unassigned';
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await page.getByRole('link', { name: 'EMP-000001' }).click();
  await page.getByRole('tab', { name: 'Employment' }).click();
  await expect(page.getByText('No visible employment.')).toBeVisible();
  directoryId = 'terminated';
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await page.getByRole('link', { name: 'EMP-000001' }).click();
  await expect(page.getByText('Terminated').last()).toBeVisible();
  await expect(page.getByText('Sep 30, 2026')).toBeVisible();
  directoryId = 'missing';
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await page.getByRole('link', { name: 'EMP-000001' }).click();
  await expect(page.getByRole('heading', { name: 'Employee not found' })).toBeVisible();
});

test('SYSTEM creates a new Person and unassigned Employee', async ({ page }) => {
  authorizationPermissions = [
    { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
    { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
  ];
  let createBody: unknown = null;
  await page.route(`${API}/employees**`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname === '/employees') {
      createBody = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'employee-created',
          employeeNumber: 'EMP-000010',
          status: 'ACTIVE',
          person: { firstName: 'Ada', middleName: null, lastName: 'Lovelace', preferredName: null },
        }),
      });
    }
    if (url.pathname.endsWith('/employee-created')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...employee,
          id: 'employee-created',
          hireDate: '2026-10-02',
          terminationDate: null,
          person: {
            firstName: 'Ada',
            middleName: null,
            lastName: 'Lovelace',
            preferredName: null,
            personalEmail: null,
            phone: null,
          },
          assignments: { current: [], upcoming: [], historical: [], cancelled: [] },
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [employee], nextAfterId: null }),
    });
  });

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await page.getByRole('link', { name: 'Add employee' }).click();
  await page.getByLabel('First name').fill('Ada');
  await page.getByLabel('Last name').fill('Lovelace');
  await page.getByLabel('Hire date').fill('2026-10-02');
  await page.getByRole('button', { name: 'Create employee' }).click();
  await expect(page).toHaveURL(/\/admin\/employees\/employee-created$/);
  expect(createBody).toEqual({
    person: { firstName: 'Ada', lastName: 'Lovelace' },
    hireDate: '2026-10-02',
  });
});

test('SYSTEM creates an Employee from an existing Person', async ({ page }) => {
  authorizationPermissions = [
    { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
    { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
  ];
  let createBody: unknown = null;
  await page.route(`${API}/employees**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/employees/options/people') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'person-1',
              firstName: 'Grace',
              middleName: null,
              lastName: 'Hopper',
              preferredName: null,
              personalEmail: 'grace@example.com',
              hasEmployee: false,
              hasUser: true,
            },
          ],
          nextAfterId: null,
        }),
      });
    }
    if (route.request().method() === 'POST' && url.pathname === '/employees') {
      createBody = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'employee-existing',
          employeeNumber: 'EMP-000011',
          status: 'ACTIVE',
          person: { firstName: 'Grace', middleName: null, lastName: 'Hopper', preferredName: null },
        }),
      });
    }
    if (url.pathname.endsWith('/employee-existing')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...employee,
          id: 'employee-existing',
          hireDate: '2026-10-02',
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
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [employee], nextAfterId: null }),
    });
  });

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await page.getByRole('link', { name: 'Add employee' }).click();
  await page.getByRole('button', { name: 'Existing person' }).click();
  await expect(page.getByText('grace@example.com')).toBeVisible();
  await page.getByRole('button', { name: /Grace Hopper/ }).click();
  await page.getByLabel('Hire date').fill('2026-10-02');
  await page.getByRole('button', { name: 'Create employee' }).click();
  await expect(page).toHaveURL(/\/admin\/employees\/employee-existing$/);
  expect(createBody).toEqual({ personId: 'person-1', hireDate: '2026-10-02' });
});

test('scoped manager creates a new Person with required initial assignment', async ({ page }) => {
  authorizationPermissions = [
    { key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] },
    { key: 'employee.manage', scopes: [{ type: 'TEAM', id: 'team-1' }] },
  ];
  let createBody: unknown = null;
  await page.route(`${API}/employees**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/employees/options/positions') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [position], nextAfterId: null }),
      });
    }
    if (route.request().method() === 'POST' && url.pathname === '/employees') {
      createBody = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'employee-scoped',
          employeeNumber: 'EMP-000012',
          status: 'ACTIVE',
          person: {
            firstName: 'Katherine',
            middleName: null,
            lastName: 'Johnson',
            preferredName: null,
          },
        }),
      });
    }
    if (url.pathname.endsWith('/employee-scoped')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...employee,
          id: 'employee-scoped',
          hireDate: '2026-10-03',
          terminationDate: null,
          person: {
            firstName: 'Katherine',
            middleName: null,
            lastName: 'Johnson',
            preferredName: null,
            personalEmail: null,
            phone: null,
          },
          assignments: {
            current: [{ ...assignment, id: 'assignment-scoped' }],
            upcoming: [],
            historical: [],
            cancelled: [],
          },
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [employee], nextAfterId: null }),
    });
  });

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await page.getByRole('link', { name: 'Add employee' }).click();
  await expect(page.getByRole('button', { name: 'Existing person' })).not.toBeVisible();
  await page.getByLabel('First name').fill('Katherine');
  await page.getByLabel('Last name').fill('Johnson');
  await page.getByLabel('Hire date').fill('2026-10-03');
  await page.getByRole('button', { name: /Platform Engineer/ }).click();
  await page.getByLabel('Employment type').selectOption('CONTRACT');
  await page.getByLabel('Start date').fill('2026-10-03');
  await page.getByRole('button', { name: 'Create employee' }).click();
  await expect(page).toHaveURL(/\/admin\/employees\/employee-scoped$/);
  expect(createBody).toMatchObject({
    initialPositionId: 'position-1',
    initialEmploymentType: 'CONTRACT',
    initialStartDate: '2026-10-03',
    initialPrimary: true,
  });
});

test('SYSTEM manages assignment lifecycle actions from the profile', async ({ page }) => {
  authorizationPermissions = [
    { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
    { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
  ];
  const supportPosition = {
    ...position,
    id: 'position-2',
    name: 'Support Lead',
    code: 'SL-1',
    jobTitle: { id: 'job-2', name: 'Lead', code: 'LEAD' },
  };
  type AssignmentFixture = Omit<
    typeof assignment,
    'employmentType' | 'status' | 'startDate' | 'endDate' | 'isPrimary'
  > & {
    employmentType: string;
    status: string;
    startDate: string;
    endDate: string | null;
    isPrimary: boolean;
  };
  let activeAssignment: AssignmentFixture = { ...assignment, id: 'active', isPrimary: true };
  let futureAssignment: AssignmentFixture = {
    ...assignment,
    id: 'future',
    status: 'PLANNED',
    startDate: '9999-01-01',
    isPrimary: false,
    position: { id: 'position-3', name: 'Future Analyst', code: 'FA-1' },
    jobTitle: { id: 'job-3', name: 'Analyst', code: 'ANL' },
  };
  const endedAssignment: AssignmentFixture = {
    ...assignment,
    id: 'ended',
    status: 'ENDED',
    endDate: '2026-06-30',
    isPrimary: false,
  };
  const cancelledAssignment: AssignmentFixture = {
    ...assignment,
    id: 'cancelled',
    status: 'CANCELLED',
    isPrimary: false,
  };
  let createAssignmentBody: unknown = null;
  let correctAssignmentBody: unknown = null;
  let endAssignmentBody: unknown = null;
  let primaryPatchBodies: unknown[] = [];
  let cancelCalled = false;
  let primaryConflictReturned = false;

  const profileBody = () => ({
    ...employee,
    hireDate: '2026-01-02',
    terminationDate: null,
    person: { ...employee.person, personalEmail: 'ada@example.com', phone: '555-0100' },
    assignments: {
      current: activeAssignment.status === 'ACTIVE' ? [activeAssignment] : [],
      upcoming: futureAssignment.status === 'PLANNED' ? [futureAssignment] : [],
      historical: [
        endedAssignment,
        ...(activeAssignment.status === 'ENDED' ? [activeAssignment] : []),
      ],
      cancelled: [
        cancelledAssignment,
        ...(futureAssignment.status === 'CANCELLED' ? [futureAssignment] : []),
      ],
    },
  });

  await page.route(`${API}/employees**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/employees/options/positions') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [supportPosition], nextAfterId: null }),
      });
    }
    if (method === 'POST' && url.pathname === '/employees/employee-1/assignments') {
      createAssignmentBody = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'assignment-new' }),
      });
    }
    const assignmentRoute = url.pathname.match(
      /^\/employees\/employee-1\/assignments\/([^/]+)(?:\/(end|cancel|primary))?$/,
    );
    if (assignmentRoute) {
      const [, assignmentId, action] = assignmentRoute;
      if (method === 'PATCH' && !action && assignmentId === 'active') {
        const body = route.request().postDataJSON() as Partial<AssignmentFixture>;
        correctAssignmentBody = body;
        activeAssignment = { ...activeAssignment, ...body };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'active' }),
        });
      }
      if (method === 'POST' && action === 'end' && assignmentId === 'active') {
        const body = route.request().postDataJSON() as { endDate: string };
        endAssignmentBody = body;
        activeAssignment = { ...activeAssignment, status: 'ENDED', endDate: body.endDate };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'active' }),
        });
      }
      if (method === 'POST' && action === 'cancel' && assignmentId === 'future') {
        cancelCalled = true;
        futureAssignment = { ...futureAssignment, status: 'CANCELLED' };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'future' }),
        });
      }
      if (method === 'PATCH' && action === 'primary') {
        const body = route.request().postDataJSON() as { isPrimary: boolean };
        primaryPatchBodies = [...primaryPatchBodies, body];
        if (assignmentId === 'future' && body.isPrimary && !primaryConflictReturned) {
          primaryConflictReturned = true;
          return route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Primary assignments may not overlap.' }),
          });
        }
        activeAssignment = {
          ...activeAssignment,
          isPrimary:
            assignmentId === 'active'
              ? body.isPrimary
              : body.isPrimary
                ? false
                : activeAssignment.isPrimary,
        };
        futureAssignment = {
          ...futureAssignment,
          isPrimary:
            assignmentId === 'future'
              ? body.isPrimary
              : body.isPrimary
                ? false
                : futureAssignment.isPrimary,
        };
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: assignmentId }),
        });
      }
    }
    if (url.pathname.endsWith('/employee-1')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(profileBody()),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [employee], nextAfterId: null }),
    });
  });

  const assignmentBlock = (name: string) =>
    page
      .getByRole('heading', { name })
      .first()
      .locator('xpath=ancestor::div[contains(@class,"space-y-3")][1]');

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await page.getByRole('link', { name: 'EMP-000001' }).click();
  await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible();
  await page.getByRole('tab', { name: 'Employment' }).click();

  await page.getByRole('button', { name: 'Add assignment' }).first().click();
  await page.getByRole('button', { name: /Support Lead/ }).click();
  await page.getByLabel('Employment type').selectOption('CONTRACT');
  await page.getByLabel('Start date').fill('2026-11-01');
  await page.getByLabel('End date').fill('2026-12-31');
  await expect(page.getByLabel('Primary assignment')).not.toBeChecked();
  await expect(page.getByLabel('Manager')).not.toBeVisible();
  await page.getByRole('button', { name: 'Add assignment' }).last().click();
  await expect(page.getByText('Assignment added.')).toBeVisible();
  expect(createAssignmentBody).toEqual({
    positionId: 'position-2',
    employmentType: 'CONTRACT',
    startDate: '2026-11-01',
    endDate: '2026-12-31',
    isPrimary: false,
  });

  await assignmentBlock('Platform Engineer')
    .getByRole('button', { name: 'Correct assignment' })
    .click();
  await page.getByLabel('Employment type').selectOption('PART_TIME');
  await page.getByLabel('Start date').fill('2026-09-02');
  await page.getByLabel('End date').fill('2026-12-31');
  await expect(page.getByLabel('Position')).not.toBeVisible();
  await expect(page.getByLabel('Manager')).not.toBeVisible();
  await page.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('Assignment updated.')).toBeVisible();
  expect(correctAssignmentBody).toEqual({
    employmentType: 'PART_TIME',
    startDate: '2026-09-02',
    endDate: '2026-12-31',
  });

  await assignmentBlock('Future Analyst').getByRole('button', { name: 'Set primary' }).click();
  await expect(page.getByText('Primary assignments may not overlap.')).toBeVisible();
  await assignmentBlock('Future Analyst').getByRole('button', { name: 'Set primary' }).click();
  await expect(page.getByText('Primary assignment updated.')).toBeVisible();
  await assignmentBlock('Future Analyst').getByRole('button', { name: 'Unset primary' }).click();
  await expect(page.getByText('Primary assignment updated.')).toBeVisible();
  expect(primaryPatchBodies).toEqual([
    { isPrimary: true },
    { isPrimary: true },
    { isPrimary: false },
  ]);

  await assignmentBlock('Platform Engineer')
    .getByRole('button', { name: 'End assignment' })
    .click();
  await page.getByLabel('End date').fill('2026-12-31');
  await page.getByRole('button', { name: 'End assignment' }).last().click();
  await expect(page.getByText('Assignment ended.')).toBeVisible();
  expect(endAssignmentBody).toEqual({ endDate: '2026-12-31' });

  await assignmentBlock('Future Analyst')
    .getByRole('button', { name: 'Cancel assignment' })
    .click();
  await expect(
    page.getByText(
      'This cancels a planned assignment before it takes effect. It does not delete the assignment record.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm cancel' }).click();
  await expect(page.getByText('Assignment cancelled.')).toBeVisible();
  expect(cancelCalled).toBe(true);
});

test('SYSTEM manages assignment managers and employee termination lifecycle', async ({ page }) => {
  authorizationPermissions = [
    { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
    { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
  ];
  const managerOption = {
    assignmentId: 'manager-option-1',
    employeeId: 'manager-1',
    employeeNumber: 'EMP-2',
    displayName: 'Grace Hopper',
    position: { id: 'manager-position', name: 'Engineering Manager', code: 'EM-1' },
    jobTitle: { id: 'manager-job', name: 'Manager', code: 'MGR' },
    organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
    startDate: '2026-01-01',
    endDate: null,
    status: 'ACTIVE',
  };
  let employeeStatus = 'ACTIVE';
  let employeeTerminationDate: string | null = null;
  let activeManager: typeof managerSummary | null = null;
  const managerPatchBodies: unknown[] = [];
  let terminateBody: unknown = null;
  let rehireBody: unknown = null;

  const profileBody = () => ({
    ...employee,
    status: employeeStatus,
    hireDate: '2026-01-02',
    terminationDate: employeeTerminationDate,
    person: { ...employee.person, personalEmail: 'ada@example.com', phone: '555-0100' },
    assignments: {
      current:
        employeeStatus === 'ACTIVE'
          ? [{ ...assignment, id: 'active', manager: activeManager }]
          : [],
      upcoming: [],
      historical: [
        {
          ...assignment,
          id: 'ended',
          status: 'ENDED',
          endDate: '2026-06-30',
          manager: managerSummary,
        },
        ...(employeeStatus === 'TERMINATED'
          ? [
              {
                ...assignment,
                id: 'active',
                status: 'ENDED',
                endDate: employeeTerminationDate,
                manager: activeManager,
              },
            ]
          : []),
      ],
      cancelled: [
        {
          ...assignment,
          id: 'cancelled',
          status: 'CANCELLED',
          isPrimary: false,
          manager: managerSummary,
        },
      ],
    },
  });

  await page.route(`${API}/employees**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/employees/options/positions') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{ ...position, id: 'position-rehire', name: 'Rehire Lead', code: 'RL-1' }],
          nextAfterId: null,
        }),
      });
    }
    if (url.pathname === '/employees/options/manager-assignments') {
      expect(url.searchParams.get('subordinateAssignmentId')).toBeTruthy();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [managerOption], nextAfterId: null }),
      });
    }
    const managerRoute = url.pathname.match(
      /^\/employees\/employee-1\/assignments\/([^/]+)\/manager$/,
    );
    if (method === 'PATCH' && managerRoute) {
      const body = route.request().postDataJSON() as { managerAssignmentId: string | null };
      managerPatchBodies.push(body);
      if (managerRoute[1] === 'active')
        activeManager = body.managerAssignmentId ? managerSummary : null;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: managerRoute[1] }),
      });
    }
    if (url.pathname === '/employees/employee-1/terminations') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    }
    if (url.pathname === '/employees/employee-1/termination-preview') {
      const date = url.searchParams.get('terminationDate')!;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          employeeId: 'employee-1',
          terminationDate: date,
          scheduled: false,
          assignments: [],
          blockers: [],
          followUps: {
            openTimeEntries: 0,
            futurePublishedShifts: 0,
            pendingLeaveRequests: 0,
            approvedLeaveAfterTermination: 0,
            openBenefitEnrollments: 0,
            openPerformanceReviews: 0,
          },
          access: null,
        }),
      });
    }
    if (url.pathname === '/employees/employee-1/access-review') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ employeeId: 'employee-1', employeeStatus, access: null }),
      });
    }
    if (method === 'POST' && url.pathname === '/employees/employee-1/terminate') {
      terminateBody = route.request().postDataJSON();
      employeeStatus = 'TERMINATED';
      employeeTerminationDate = (terminateBody as { terminationDate: string }).terminationDate;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          termination: {
            id: 'termination-1',
            status: 'APPLIED',
            terminationDate: employeeTerminationDate,
          },
          employee: {
            id: 'employee-1',
            status: 'TERMINATED',
            terminationDate: employeeTerminationDate,
          },
        }),
      });
    }
    if (method === 'POST' && url.pathname === '/employees/employee-1/rehire') {
      rehireBody = route.request().postDataJSON();
      employeeStatus = 'ACTIVE';
      employeeTerminationDate = null;
      activeManager = null;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'employee-1' }),
      });
    }
    if (url.pathname.endsWith('/employee-1')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(profileBody()),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [employee], nextAfterId: null }),
    });
  });

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await page.getByRole('link', { name: 'EMP-000001' }).click();
  await page.getByRole('tab', { name: 'Employment' }).click();
  await expect(page.getByRole('button', { name: 'Terminate employee' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add assignment' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rehire employee' })).not.toBeVisible();

  await page.getByRole('button', { name: 'Set manager' }).click();
  await page.getByRole('button', { name: /Grace Hopper/ }).click();
  await page.getByRole('button', { name: 'Save manager' }).click();
  await expect(page.getByText('Manager updated.')).toBeVisible();
  expect(managerPatchBodies.at(-1)).toEqual({ managerAssignmentId: 'manager-option-1' });

  await page.getByRole('button', { name: 'Change manager' }).first().click();
  await page.getByRole('button', { name: /Grace Hopper/ }).click();
  await page.getByRole('button', { name: 'Save manager' }).click();
  await expect(page.getByText('Manager updated.')).toBeVisible();
  expect(managerPatchBodies.at(-1)).toEqual({ managerAssignmentId: 'manager-option-1' });

  await page.getByRole('button', { name: 'Clear manager' }).first().click();
  const clearManagerPanel = page
    .getByRole('heading', { name: 'Clear manager' })
    .locator('xpath=ancestor::section[1]');
  await clearManagerPanel.getByRole('button', { name: 'Clear manager' }).click();
  await expect(page.getByText('Manager cleared.')).toBeVisible();
  expect(managerPatchBodies.at(-1)).toEqual({ managerAssignmentId: null });

  await expect(page.getByRole('button', { name: 'Clear manager' })).toHaveCount(1);
  // Batch 5C: the termination dialog previews the date; a past date needs a confirmation.
  await page.getByRole('button', { name: 'Terminate employee' }).click();
  const terminate = page.getByRole('dialog', { name: 'Terminate employee' });
  await terminate.getByLabel('Last day of employment').fill('2026-10-31');
  await expect(terminate.getByText(/Immediate:/)).toBeVisible();
  await terminate.getByLabel(/employment ends now/).check();
  await terminate.getByRole('button', { name: 'Terminate now' }).click();
  await expect(page.getByText(/Employee terminated\./)).toBeVisible();
  expect(terminateBody).toEqual({ terminationDate: '2026-10-31' });
  await expect(page.getByRole('button', { name: 'Add assignment' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Terminate employee' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Rehire employee' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Correct assignment' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change manager' }).first()).toBeVisible();

  // Batch 5A: a rehire creates the new assignment.
  await page.getByRole('button', { name: 'Rehire employee' }).click();
  const rehire = page.getByRole('dialog', { name: 'Rehire employee' });
  await rehire.getByRole('button', { name: /Rehire Lead/ }).click();
  await rehire.getByLabel('Employment type').selectOption('FULL_TIME');
  await rehire.getByLabel('Start date').fill('2027-01-15');
  await rehire.getByRole('button', { name: 'Rehire employee' }).click();
  await expect(page.getByText(/Employee rehired into the new assignment/)).toBeVisible();
  expect(rehireBody).toEqual({
    assignment: {
      positionId: 'position-rehire',
      employmentType: 'FULL_TIME',
      startDate: '2027-01-15',
      isPrimary: true,
    },
  });
  await expect(page.getByRole('button', { name: 'Add assignment' })).toBeVisible();
});

test('SYSTEM corrects profile fields and read-only users have no management controls', async ({
  page,
}) => {
  authorizationPermissions = [
    { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
    { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
  ];
  let patched = false;
  await page.route(`${API}/employees**`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'PATCH' && url.pathname.endsWith('/employee-1')) {
      patched = true;
      expect(route.request().postDataJSON()).toMatchObject({ preferredName: 'Countess' });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'employee-1',
          employeeNumber: 'EMP-000001',
          status: 'ACTIVE',
          person: {
            firstName: 'Ada',
            middleName: null,
            lastName: 'Lovelace',
            preferredName: 'Countess',
          },
        }),
      });
    }
    if (url.pathname.endsWith('/employee-1')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...employee,
          hireDate: '2026-01-02',
          terminationDate: null,
          person: {
            firstName: 'Ada',
            middleName: null,
            lastName: 'Lovelace',
            preferredName: patched ? 'Countess' : null,
            personalEmail: 'ada@example.com',
            phone: '555-0100',
          },
          assignments: { current: [], upcoming: [], historical: [], cancelled: [] },
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [employee], nextAfterId: null }),
    });
  });

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await page.getByRole('link', { name: 'EMP-000001' }).click();
  await expect(page).toHaveURL(/\/admin\/employees\/employee-1$/);
  await page.getByRole('button', { name: 'Edit employee' }).click();
  await page.getByLabel('Preferred name').fill('Countess');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile updated.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Countess' })).toBeVisible();

  authorizationPermissions = [{ key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] }];
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Employees' })
    .click();
  await expect(page.getByRole('link', { name: 'Add employee' })).not.toBeVisible();
  await page.getByRole('link', { name: 'EMP-000001' }).click();
  await expect(page).toHaveURL(/\/admin\/employees\/employee-1$/);
  await expect(page.getByRole('button', { name: 'Edit employee' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Add assignment' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Correct assignment' })).not.toBeVisible();
});
