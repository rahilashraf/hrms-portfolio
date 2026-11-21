import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 7C — an employee's benefits against a mocked API: HR removes a spouse from coverage
 * after a divorce (relationship end recorded, then employee-only coverage from the next day);
 * ending coverage that a later election continues is refused with the later coverage named, not
 * ended silently; a dependent's relationship dates are edited in a dialog; My Benefits keeps
 * its other sections when one request fails and retries it. axe (serious/critical) and no
 * page-wide horizontal scroll at 1280, 820 and a 375 px phone.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const EMP = '33333333-3333-4333-8333-333333333333';
const ASG = '44444444-4444-4444-8444-444444444444';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;

const identity = {
  id: 'user-7c',
  personId: 'person-7c',
  email: 'benefits-hr@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function session(page: Page, permissions: string[], isEmployee = false) {
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '7c-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    }),
  );
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: identity.id, email: identity.email, displayName: 'Morgan Reedley' },
      systemPermissions: [],
      organizations: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: ['BENEFITS'],
          permissions,
          isEmployee,
          isManager: false,
        },
      ],
    }),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => json(route, { unread: 0 }));
}

async function checkAt(page: Page) {
  for (const size of Object.values(VIEWPORTS)) {
    await page.setViewportSize(size);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const org = { id: ORG, name: 'Northwind Academy', code: 'NWA' };
const profile = {
  id: EMP,
  employeeNumber: 'E-0001',
  status: 'ACTIVE',
  hireDate: '2026-01-05',
  terminationDate: null,
  person: {
    firstName: 'Ada',
    middleName: null,
    lastName: 'Lovelace',
    preferredName: null,
    personalEmail: 'ada@example.com',
    phone: null,
  },
  assignments: {
    current: [
      {
        id: ASG,
        employmentType: 'FULL_TIME',
        status: 'ACTIVE',
        startDate: '2026-01-05',
        endDate: null,
        isPrimary: true,
        position: { id: 'pos-teacher', name: 'Grade 4 Teacher', code: 'T4' },
        jobTitle: { id: 'jt-1', name: 'Teacher', code: 'TCH' },
        organization: org,
        placement: null,
        workLocation: null,
        manager: null,
        managerWarnings: [],
      },
    ],
    upcoming: [],
    historical: [],
    cancelled: [],
  },
};
const capabilities = {
  employeeId: EMP,
  organizationIds: [ORG],
  tabs: {
    overview: true,
    employment: false,
    compensation: false,
    time: false,
    leave: false,
    benefits: true,
    documents: false,
    performance: false,
  },
  actions: {
    edit: false,
    changePosition: false,
    assignManager: false,
    addCompensation: false,
    manageDocuments: false,
    startOffboarding: false,
    manageLifecycle: false,
  },
};

const actions = {
  canChange: true,
  canEnd: true,
  canTransfer: false,
  canCorrect: true,
  canRescind: true,
};
const health = {
  id: 'plan-1',
  code: 'HEALTH',
  name: 'Health',
  benefitType: 'HEALTH',
  providerName: 'Carrier Co',
  currency: 'CAD',
};
const single = { id: 'opt-single', code: 'SINGLE', name: 'Single', coverageLevel: 'EMPLOYEE_ONLY' };
const couple = {
  id: 'opt-spouse',
  code: 'SPOUSE',
  name: 'Employee and spouse',
  coverageLevel: 'EMPLOYEE_SPOUSE',
};
const spouseLink = { id: 'dep-1', firstName: 'Sam', lastName: 'Lovelace', relationship: 'SPOUSE' };
const election = (overrides: Record<string, unknown> = {}) => ({
  id: 'enr-1',
  status: 'ACTIVE',
  electionType: 'ENROLLED',
  recordType: 'INITIAL',
  plan: health,
  option: couple,
  coverageStart: '2026-02-01',
  coverageEnd: null,
  electedOn: '2026-02-01',
  sponsoringAssignment: { id: ASG, positionName: 'Grade 4 Teacher', organizationName: org.name },
  dependents: [spouseLink],
  cost: {
    rateId: 'rate-1',
    asOf: '2026-03-15',
    frequency: 'MONTHLY',
    currency: 'CAD',
    employeeAmount: '50.00',
    employerAmount: '75.00',
  },
  flags: [],
  actions,
  ...overrides,
});
const spouse = (overrides: Record<string, unknown> = {}) => ({
  id: 'dep-1',
  employeeId: EMP,
  firstName: 'Sam',
  lastName: 'Lovelace',
  relationship: 'SPOUSE',
  dateOfBirth: '1990-05-01',
  relationshipStartDate: '2015-06-01',
  relationshipEndDate: null,
  archived: false,
  canManage: true,
  ...overrides,
});

/** A stateful mock of the employee and benefits endpoints the profile's Benefits tab uses. */
async function benefitsServer(page: Page, options: { laterCoverage?: boolean } = {}) {
  const state = {
    elections: [election()] as Array<Record<string, unknown>>,
    dependents: [spouse()] as Array<Record<string, unknown>>,
    requests: [] as Array<{ method: string; path: string; body: unknown }>,
  };
  if (options.laterCoverage)
    state.elections.push(
      election({ id: 'enr-2', option: single, dependents: [], coverageStart: '2026-09-01' }),
    );
  await page.route(
    (url) => url.origin === API && url.pathname.startsWith(`/employees/${EMP}`),
    (route) => {
      const rest = new URL(route.request().url()).pathname.slice(`/employees/${EMP}`.length);
      if (rest === '') return json(route, profile);
      if (rest === '/capabilities') return json(route, capabilities);
      return json(route, { message: 'Not found' }, 404);
    },
  );
  await page.route(
    (url) => url.origin === API && url.pathname.startsWith('/benefits/'),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.postDataJSON?.() ?? null;
      if (request.method() !== 'GET') state.requests.push({ method: request.method(), path, body });
      if (path === `/benefits/employees/${EMP}/elections`)
        return json(route, {
          employeeId: EMP,
          canManage: true,
          sponsoringAssignments: [
            {
              id: ASG,
              positionName: 'Grade 4 Teacher',
              organizationId: ORG,
              status: 'ACTIVE',
              startDate: '2026-01-05',
              endDate: null,
            },
          ],
          items: state.elections,
        });
      if (path === `/benefits/employees/${EMP}/dependents`)
        return json(route, { items: state.dependents, canManage: true });
      if (path === `/benefits/assignments/${ASG}/eligibility`)
        return json(route, {
          plans: [
            {
              planId: 'plan-1',
              code: 'HEALTH',
              name: 'Health',
              benefitType: 'HEALTH',
              status: 'ACTIVE',
              options: [single, couple],
              eligibility: { eligible: true, reasons: [], rules: [] },
            },
          ],
        });
      if (path === '/benefits/dependents/dep-1' && request.method() === 'PATCH') {
        state.dependents = [spouse(body as Record<string, unknown>)];
        return json(route, state.dependents[0]);
      }
      if (path === '/benefits/elections/enr-1/change') {
        state.elections = [
          election({ coverageEnd: '2026-05-31', actions: { ...actions, canChange: false } }),
          election({
            id: 'enr-3',
            option: single,
            dependents: [],
            coverageStart: '2026-06-01',
            recordType: 'CHANGE',
          }),
        ];
        return json(route, state.elections[1]);
      }
      if (path === '/benefits/elections/enr-1/end')
        return json(
          route,
          {
            statusCode: 409,
            code: 'BENEFIT_LATER_COVERAGE',
            message: 'Coverage of this plan continues in a later election.',
            laterElections: 1,
            elections: [{ id: 'enr-2', coverageStart: '2026-09-01', coverageEnd: null }],
          },
          409,
        );
      return json(route, { message: 'Not found' }, 404);
    },
  );
  return state;
}

// ─── Employee profile: divorce and later coverage ───────────────────────────

test('HR removes a spouse after a divorce: relationship end, then employee-only coverage — accessible at every width', async ({
  page,
}) => {
  await session(page, ['employee.read', 'benefit.read', 'benefit.manage']);
  const server = await benefitsServer(page);
  await page.goto(`/admin/employees/${EMP}#benefits`);
  await expect(page.getByRole('heading', { name: 'Benefits', level: 2 })).toBeVisible();
  const elections = page.getByRole('region', { name: 'Benefit elections' });
  await expect(elections.getByText('Employee and spouse')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recorded dependents' })).toContainText(
    'Sam Lovelace',
  );
  await checkAt(page);

  await page.getByRole('button', { name: 'Remove a dependent from Health' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove a dependent from Health' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Coverage option')).toHaveValue('opt-single');
  await dialog.getByLabel('Relationship ended on').fill('2026-05-31');
  await expect(dialog.getByLabel(/Coverage without them from/)).toHaveValue('2026-06-01');
  await checkAt(page);
  await dialog.getByRole('button', { name: 'Remove from coverage' }).click();
  await expect(page.getByText('Dependent removed from coverage.')).toBeVisible();
  expect(server.requests.map((r) => [r.method, r.path, r.body])).toEqual([
    ['PATCH', '/benefits/dependents/dep-1', { relationshipEndDate: '2026-05-31' }],
    [
      'POST',
      '/benefits/elections/enr-1/change',
      { effectiveDate: '2026-06-01', optionId: 'opt-single', dependentIds: [] },
    ],
  ]);
  await expect(elections.getByRole('cell', { name: 'Single' })).toBeVisible();
});

test('ending coverage a later election continues is refused with that election named', async ({
  page,
}) => {
  await session(page, ['employee.read', 'benefit.read', 'benefit.manage']);
  const server = await benefitsServer(page, { laterCoverage: true });
  await page.goto(`/admin/employees/${EMP}#benefits`);
  await page.getByRole('button', { name: 'End Health coverage' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'End Health coverage?' });
  await dialog.getByLabel('Last day of coverage').fill('2026-04-30');
  await dialog.getByLabel(/Reason/).fill('Divorce');
  await dialog.getByRole('button', { name: 'End coverage' }).click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('later election');
  await expect(alert).toContainText('Later coverage: Health Single from');
  await expect(dialog).toBeVisible();
  await expect(page.getByText('Coverage ended.')).toHaveCount(0);
  await checkAt(page);
  expect(server.requests).toHaveLength(1);

  // A dependent's relationship dates are edited in a dialog.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Edit Sam Lovelace' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Sam Lovelace' });
  await expect(edit.getByLabel('Relationship start (optional)')).toHaveValue('2015-06-01');
  await expect(edit.getByLabel(/Date of birth/)).toHaveValue('1990-05-01');
  await checkAt(page);
});

// ─── My Benefits ────────────────────────────────────────────────────────────

test('My Benefits keeps what loaded when one part fails, and retries it', async ({ page }) => {
  await session(page, [], true);
  let dependentsCalls = 0;
  await page.route(`${API}/benefits/me`, (route) =>
    json(route, {
      employeeId: EMP,
      items: [election({ actions: undefined, dependents: [spouseLink] })],
    }),
  );
  await page.route(`${API}/benefits/me/dependents`, (route) => {
    dependentsCalls += 1;
    return dependentsCalls === 1
      ? json(route, { message: 'Unavailable' }, 503)
      : json(route, { items: [spouse()] });
  });
  await page.route(`${API}/benefits/me/eligibility`, (route) => json(route, { items: [] }));
  await page.goto('/benefits');
  await expect(page.getByRole('heading', { name: 'My benefits' })).toBeVisible();
  const current = page.getByRole('region', { name: 'Current and upcoming' });
  await expect(current.getByText('CAD 50.00 monthly')).toBeVisible();
  const dependents = page.getByRole('region', { name: 'Dependents' });
  await expect(dependents.getByRole('alert')).toBeVisible();
  await checkAt(page);
  await dependents.getByRole('button', { name: 'Try again' }).click();
  await expect(dependents.getByText('Sam Lovelace')).toBeVisible();
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
});
