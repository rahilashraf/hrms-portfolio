import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';

const identity = {
  id: 'benefits-user',
  personId: 'person-benefits-user',
  email: 'benefits@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockSession(page: Page, permissions: string[]) {
  let signedIn = false;
  await page.route('**/auth/refresh', (route) =>
    signedIn ? json(route, { accessToken: 'benefits-token', identity }, 201) : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'benefits-token', identity }, 201);
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

const election = {
  id: 'enr-1',
  status: 'ACTIVE',
  electionType: 'ENROLLED',
  recordType: 'INITIAL',
  plan: {
    id: 'plan-1',
    code: 'HEALTH',
    name: 'Health',
    benefitType: 'HEALTH',
    providerName: 'Carrier Co',
    currency: 'CAD',
  },
  option: { id: 'opt-1', code: 'FAMILY', name: 'Family', coverageLevel: 'FAMILY' },
  coverageStart: '2026-01-01',
  coverageEnd: null,
  electedOn: '2026-01-01',
  sponsoringAssignment: { id: 'asg-1', positionName: 'Analyst', organizationName: 'Camp' },
  dependents: [{ id: 'dep-1', firstName: 'Sam', lastName: 'Doe', relationship: 'CHILD' }],
  cost: {
    rateId: 'rate-1',
    asOf: '2026-10-06',
    frequency: 'MONTHLY',
    currency: 'CAD',
    employeeAmount: '75.00',
    employerAmount: null,
  },
};

test('an employee reads their benefits without any way to change them', async ({ page }) => {
  await mockSession(page, []);
  await page.route(`${API}/benefits/me`, (route) =>
    json(route, { employeeId: 'emp-1', items: [election] }),
  );
  await page.route(`${API}/benefits/me/dependents`, (route) =>
    json(route, {
      items: [
        {
          id: 'dep-1',
          employeeId: 'emp-1',
          firstName: 'Sam',
          lastName: 'Doe',
          relationship: 'CHILD',
          dateOfBirth: '2015-04-01',
          relationshipStartDate: null,
          relationshipEndDate: null,
          archived: false,
        },
      ],
    }),
  );
  await page.route(`${API}/benefits/me/eligibility`, (route) => json(route, { items: [] }));
  await signIn(page);
  await expect(page.getByRole('link', { name: 'Benefits', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'My Benefits' }).click();
  await expect(page.getByRole('heading', { name: 'My benefits' })).toBeVisible();
  const current = page.getByRole('region', { name: 'Current and upcoming' });
  await expect(current.getByText('CAD 75.00 monthly')).toBeVisible();
  await expect(current.getByText('Sam Doe')).toBeVisible();
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
});

test('a plan manager adds a rate to a benefit plan', async ({ page }) => {
  await mockSession(page, ['benefit.plan.manage']);
  const options = [
    {
      id: 'opt-1',
      planId: 'plan-1',
      code: 'SINGLE',
      name: 'Single',
      coverageLevel: 'EMPLOYEE_ONLY',
      sortOrder: 0,
      archived: false,
      currentAndFutureEnrollments: 0,
      actions: { canEdit: true, canArchive: true },
    },
  ];
  const plan = {
    id: 'plan-1',
    organizationId: 'org-1',
    code: 'HEALTH',
    name: 'Health',
    description: null,
    benefitType: 'HEALTH',
    providerName: null,
    providerReference: null,
    currency: 'CAD',
    status: 'DRAFT',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    employerContributionTaxable: false,
    showEmployerCostToEmployee: false,
    dependentChildMaxAge: null,
    archived: false,
    optionCount: 1,
    actions: {
      canEdit: true,
      canActivate: true,
      canClose: false,
      canArchive: true,
      canManageOptions: true,
      canManageRates: true,
      canManageEligibility: true,
    },
  };
  const rates: unknown[] = [];
  let rateBody: unknown = null;
  await page.route(`${API}/benefits/organizations`, (route) =>
    json(route, {
      items: [
        {
          id: 'org-1',
          name: 'Camp',
          code: 'CAMP',
          timezone: 'America/Toronto',
          actions: { canManagePlans: true },
        },
      ],
    }),
  );
  await page.route(`${API}/benefits/plans?organizationId=org-1`, (route) =>
    json(route, { items: [plan] }),
  );
  await page.route(`${API}/benefits/attention?organizationId=org-1`, (route) =>
    json(route, { items: [] }),
  );
  await page.route(`${API}/benefits/plans/plan-1`, (route) =>
    json(route, {
      ...plan,
      organization: { id: 'org-1', name: 'Camp', timezone: 'America/Toronto' },
      asOf: '2026-10-06',
      options,
      rates,
      eligibilityRules: [],
    }),
  );
  await page.route(`${API}/benefits/options/opt-1/rates`, (route) => {
    rateBody = route.request().postDataJSON();
    rates.push({
      id: 'rate-1',
      optionId: 'opt-1',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      frequency: 'MONTHLY',
      employeeAmount: '25.00',
      employerAmount: '75.00',
      currency: 'CAD',
      recordType: 'INITIAL',
      supersededAt: null,
      reason: null,
    });
    return json(route, rates[0], 201);
  });
  await signIn(page);
  await expect(page.getByRole('link', { name: 'My Benefits' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Benefits', exact: true })
    .click();
  await page.getByRole('button', { name: 'Open Health' }).click();
  const plans = page.getByRole('region', { name: 'Health plan' });
  await expect(plans.getByText('No rate')).toBeVisible();
  const form = page.getByRole('form', { name: 'Add rate' });
  await form.getByLabel('Rate effective from').fill('2026-01-01');
  await form.getByLabel('Employee amount').fill('25.00');
  await form.getByLabel('Employer amount').fill('75.00');
  await form.getByRole('button', { name: 'Add rate' }).click();
  await expect(page.getByText('Rate added.')).toBeVisible();
  await expect(
    plans.getByText(/CAD 25\.00 employee \/ CAD 75\.00 employer, monthly/),
  ).toBeVisible();
  expect(rateBody).toEqual({
    effectiveFrom: '2026-01-01',
    frequency: 'MONTHLY',
    employeeAmount: '25.00',
    employerAmount: '75.00',
  });
});
