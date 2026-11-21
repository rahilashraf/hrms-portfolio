import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';

const identity = {
  id: 'pay-user',
  personId: 'person-pay-user',
  email: 'pay@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const payGroup = { id: 'group-1', code: 'HBL-BIWEEKLY', name: 'HBL Biweekly' };

const initial = {
  id: 'record-1',
  employmentAssignmentId: 'assignment-1',
  recordType: 'INITIAL',
  payBasis: 'HOURLY',
  rateAmount: '24.5000',
  currency: 'CAD',
  effectiveFrom: '2026-01-01',
  effectiveTo: null as string | null,
  payGroup,
  reason: null as string | null,
  supersedesRecordId: null,
  supersededAt: null,
  createdAt: '2026-01-02T00:00:00.000Z',
};

const assignment = {
  id: 'assignment-1',
  status: 'ACTIVE',
  employmentType: 'FULL_TIME',
  isPrimary: true,
  startDate: '2026-01-01',
  endDate: null,
  employee: { id: 'employee-1', employeeNumber: 'EMP-000001', displayName: 'Ada Lovelace' },
  position: { id: 'position-1', name: 'Counsellor', code: 'COUN' },
  organization: { id: 'org-1', name: 'Camp', code: 'CAMP' },
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** A tiny in-memory compensation backend: a change closes the period in effect. */
function compensationBackend(canManage: boolean) {
  let timeline = [{ ...initial }];
  const view = () => ({
    assignment,
    asOf: '2026-10-05',
    current: [...timeline].reverse().find((r) => r.effectiveFrom <= '2026-10-05') ?? null,
    timeline: timeline.map((r) => ({
      ...r,
      actions: { canCorrect: canManage, canEnd: canManage },
    })),
    superseded: [],
    actions: { canCreate: canManage, canChange: canManage },
  });
  return {
    view,
    change(input: { rateAmount: string; effectiveFrom: string; reason?: string }) {
      const last = timeline[timeline.length - 1]!;
      const [y, m, d] = input.effectiveFrom.split('-').map(Number);
      const dayBefore = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
      timeline = [
        ...timeline.slice(0, -1),
        { ...last, effectiveTo: dayBefore },
        {
          ...last,
          id: 'record-2',
          recordType: 'CHANGE',
          rateAmount: `${input.rateAmount}00`.replace(/^(\d+\.\d{4}).*$/, '$1'),
          effectiveFrom: input.effectiveFrom,
          effectiveTo: null,
          reason: input.reason ?? null,
        },
      ];
      return { record: timeline[timeline.length - 1], previous: timeline[timeline.length - 2] };
    },
  };
}

async function mockSession(page: Page, permissions: string[]) {
  // Like the refresh cookie: once signed in, a reload restores the session.
  let signedIn = false;
  await page.route('**/auth/refresh', (route) =>
    signedIn ? json(route, { accessToken: 'pay-e2e-token', identity }, 201) : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'pay-e2e-token', identity }, 201);
  });
  await page.route('**/auth/me', (route) =>
    signedIn ? json(route, identity) : json(route, {}, 401),
  );
  await page.route('**/auth/me/authorization', (route) =>
    json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({
        key,
        scopes: [{ type: 'ORGANIZATION', id: 'org-1' }],
      })),
    }),
  );
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('an employee sees their own pay read-only', async ({ page }) => {
  await mockSession(page, []);
  const backend = compensationBackend(false);
  await page.route(`${API}/compensation/me`, (route) =>
    json(route, { employeeId: 'employee-1', assignments: [backend.view()] }),
  );
  await signIn(page);
  await expect(page.getByRole('link', { name: 'Compensation', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'My Compensation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My pay' })).toBeVisible();
  const card = page.getByRole('article', { name: 'Compensation for Counsellor · Camp' });
  await expect(card.getByText('CAD 24.50 / hour').first()).toBeVisible();
  // Read-only: the only button is the Batch R3.4 "Compensation on date" lookup.
  await expect(card.getByRole('button')).toHaveText(['Show']);
});

test('a compensation manager changes pay from the employee profile', async ({ page }) => {
  await mockSession(page, ['employee.read', 'compensation.read', 'compensation.manage']);
  const backend = compensationBackend(true);
  const changes: unknown[] = [];
  await page.route(`${API}/employees/employee-1`, (route) =>
    json(route, {
      id: 'employee-1',
      employeeNumber: 'EMP-000001',
      status: 'ACTIVE',
      hireDate: '2026-01-01',
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
  );
  await page.route(`${API}/compensation/employees/employee-1`, (route) =>
    json(route, { employeeId: 'employee-1', assignments: [backend.view()] }),
  );
  await page.route(`${API}/pay-groups?**`, (route) =>
    json(route, {
      items: [
        {
          ...payGroup,
          organizationId: 'org-1',
          description: null,
          archivedAt: null,
          actions: { canEdit: true, canArchive: true },
        },
      ],
    }),
  );
  await page.route(`${API}/employment-assignments/assignment-1/compensation/change`, (route) => {
    const input = route.request().postDataJSON() as {
      rateAmount: string;
      effectiveFrom: string;
      reason?: string;
    };
    changes.push(input);
    return json(route, backend.change(input), 201);
  });

  await signIn(page);
  // The employee workspace deep-links to its Compensation tab.
  await page.goto('/admin/employees/employee-1#compensation');
  await expect(page.getByRole('tab', { name: 'Compensation' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const card = page.getByRole('article', { name: 'Compensation for Counsellor · Camp' });
  await expect(card.getByText('CAD 24.50 / hour').first()).toBeVisible();

  await card.getByRole('button', { name: 'Change compensation' }).click();
  const form = page.getByRole('form', { name: 'Change compensation' });
  await form.getByLabel('Hourly rate').fill('26.25');
  await form.getByLabel('Effective from').fill('2026-07-01');
  await form.getByLabel('Reason (optional)').fill('Annual review');
  await form.getByRole('button', { name: 'Save change' }).click();

  await expect(card.getByText('Compensation changed.')).toBeVisible();
  expect(changes).toEqual([
    {
      payBasis: 'HOURLY',
      rateAmount: '26.25',
      currency: 'CAD',
      effectiveFrom: '2026-07-01',
      reason: 'Annual review',
    },
  ]);
  const table = card.getByRole('table');
  await expect(table.getByText('01/01/2026 – 06/30/2026')).toBeVisible();
  await expect(table.getByText('07/01/2026 – ongoing')).toBeVisible();
  await expect(table.getByText('Annual review')).toBeVisible();
});

test('employee.read alone shows no compensation and no pay-group admin', async ({ page }) => {
  await mockSession(page, ['employee.read', 'employee.manage']);
  let compensationRequested = false;
  await page.route(`${API}/compensation/**`, (route) => {
    compensationRequested = true;
    return json(route, {}, 403);
  });
  await signIn(page);
  await expect(page.getByRole('link', { name: 'Compensation', exact: true })).toHaveCount(0);
  await page.goto('/admin/compensation');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  expect(compensationRequested).toBe(false);
});

test('pay groups are administered per organization', async ({ page }) => {
  await mockSession(page, ['compensation.manage']);
  const groups = [
    {
      ...payGroup,
      organizationId: 'org-1',
      description: null,
      archivedAt: null,
      actions: { canEdit: true, canArchive: true },
    },
  ];
  await page.route(`${API}/pay-groups/organizations`, (route) =>
    json(route, { items: [{ id: 'org-1', name: 'Camp', code: 'CAMP', canManagePayGroups: true }] }),
  );
  await page.route(`${API}/pay-groups?**`, (route) => json(route, { items: groups }));
  await page.route(`${API}/pay-groups`, (route) => {
    const input = route.request().postDataJSON() as { code: string; name: string };
    const created = {
      id: 'group-2',
      organizationId: 'org-1',
      code: input.code.toUpperCase().replace(/\s+/g, '-'),
      name: input.name,
      description: null,
      archivedAt: null,
      actions: { canEdit: true, canArchive: true },
    };
    groups.push(created);
    return json(route, created, 201);
  });

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Compensation', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Pay groups' })).toBeVisible();
  await expect(page.getByText('HBL Biweekly')).toBeVisible();
  const form = page.getByRole('form', { name: 'New pay group' });
  await form.getByLabel('Code').fill('hbl monthly');
  await form.getByLabel('Name').fill('HBL Monthly');
  await form.getByRole('button', { name: 'Add pay group' }).click();
  await expect(page.getByText('Pay group created.')).toBeVisible();
  await expect(page.getByText('(HBL-MONTHLY)')).toBeVisible();
});
