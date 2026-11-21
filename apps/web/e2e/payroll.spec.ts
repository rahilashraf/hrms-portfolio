import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

const identity = {
  id: 'payroll-user',
  personId: 'person-payroll-user',
  email: 'payroll@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockSession(page: Page, permissions: string[]) {
  let signedIn = false;
  await page.route('**/auth/refresh', (route) =>
    signedIn ? json(route, { accessToken: 'payroll-token', identity }, 201) : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'payroll-token', identity }, 201);
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

const totals = {
  grossAmount: '2000.00',
  deductionAmount: '0.00',
  employerContributionAmount: '0.00',
  netAmount: null,
  netStatus: 'STATUTORY_NOT_CALCULATED',
};

function run(status: string, canApprove: boolean) {
  return {
    id: 'run-1',
    organizationId: 'org-1',
    status,
    currency: 'CAD',
    payGroup: { id: 'group-1', code: 'BW', name: 'Biweekly' },
    period: {
      id: 'period-1',
      periodStart: '2026-10-04',
      periodEnd: '2026-10-17',
      payDate: '2026-10-22',
      status: 'PROCESSING',
      timezone: 'America/Toronto',
    },
    calculatedAt: '2026-10-18T12:00:00.000Z',
    calculationVersion: 'PAYROLL_GROSS_V1',
    sourceFingerprint: 'abc',
    approvedAt: status === 'APPROVED' ? '2026-10-19T12:00:00.000Z' : null,
    finalizedAt: null,
    voidedAt: null,
    voidReason: null,
    statutoryStatus: 'NOT_CALCULATED',
    totals,
    organization: { id: 'org-1', name: 'Camp' },
    issueCounts: { ERROR: 0, WARNING: 0, INFO: 1 },
    employees: [],
    actions: {
      canCalculate: false,
      canApprove,
      canFinalize: false,
      canVoid: false,
      canAddManualLines: false,
      canAdjust: false,
    },
  };
}

test('an employee reads their own finalized pay statement, without net pay', async ({ page }) => {
  await mockSession(page, []);
  await page.route(`${API}/payroll/me/pay`, (route) =>
    json(route, {
      netPayExplanation: 'Net pay is not shown: statutory deductions are not calculated.',
      items: [
        {
          id: 're-1',
          payrollRunId: 'run-1',
          employer: 'Camp',
          currency: 'CAD',
          payDate: '2026-10-22',
          periodStart: '2026-10-04',
          periodEnd: '2026-10-17',
          grossAmount: '2000.00',
          deductionAmount: '0.00',
          netAmount: null,
        },
      ],
    }),
  );
  await page.route(`${API}/payroll/me/pay/re-1`, (route) =>
    json(route, {
      id: 're-1',
      employer: { name: 'Camp' },
      employee: { displayName: 'Ada Lovelace', employeeNumber: 'EMP-1' },
      payGroup: 'Biweekly',
      period: { periodStart: '2026-10-04', periodEnd: '2026-10-17', payDate: '2026-10-22' },
      currency: 'CAD',
      finalizedAt: '2026-10-20T00:00:00.000Z',
      earnings: [
        {
          id: 'line-1',
          positionName: 'Counsellor',
          type: 'REGULAR_SALARY',
          description: 'Salary',
          workDate: null,
          periodFrom: '2026-10-04',
          periodTo: '2026-10-17',
          hours: null,
          rateAmount: '52000.0000',
          amount: '2000.00',
        },
      ],
      deductions: [],
      employerContributions: [],
      totals: {
        ...totals,
        paidHours: '0.00',
        netPayExplanation: 'Statutory deductions are not calculated.',
      },
      yearToDate: { currency: 'CAD', grossAmount: '2000.00', deductionAmount: '0.00' },
    }),
  );
  await signIn(page);
  await expect(page.getByRole('link', { name: 'Payroll', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'My Pay' }).click();
  await expect(page.getByRole('heading', { name: 'My pay statements' })).toBeVisible();
  await page.getByRole('button', { name: 'View pay statement for 10/22/2026' }).click();
  const slip = page.getByRole('article', {
    name: 'Pay statement for Ada Lovelace, pay date 10/22/2026',
  });
  await expect(slip.getByText(/Regular Salary/)).toBeVisible();
  await expect(slip.getByText('Not calculated', { exact: true })).toBeVisible();
  await expect(slip.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();
});

test('a payroll approver approves a calculated run', async ({ page }) => {
  await mockSession(page, ['payroll.read', 'payroll.approve']);
  let current = run('CALCULATED', true);
  const approvals: string[] = [];
  await page.route(`${API}/payroll/runs/run-1`, (route) => json(route, current));
  await page.route(`${API}/payroll/runs/run-1/issues`, (route) =>
    json(route, {
      items: [
        {
          id: 'issue-1',
          severity: 'INFO',
          code: 'NET_PAY_NOT_CALCULATED',
          message: 'Statutory deductions are not calculated.',
          metadata: null,
          employee: null,
          assignment: null,
        },
      ],
    }),
  );
  await page.route(`${API}/payroll/runs/run-1/approve`, (route) => {
    approvals.push(route.request().method());
    current = run('APPROVED', false);
    return json(route, current, 201);
  });
  await signIn(page);
  await expect(
    page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Payroll', exact: true }),
  ).toHaveAttribute('href', '/admin/payroll');
  await page.goto('/admin/payroll/runs/run-1');
  await expect(page.getByRole('button', { name: 'Finalize' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Approve' }).click();
  // Batch 6A: approval is confirmed first, like finalization.
  await page
    .getByRole('alertdialog', { name: 'Approve this payroll run?' })
    .getByRole('button', { name: 'Approve run' })
    .click();
  await expect(page.getByText('Run approved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  expect(approvals).toEqual(['POST']);
  // Batch 3B: no serious or critical accessibility violations on the final page.
  await expectNoSeriousA11yViolations(page);
});

test('M2: the calculator sees why they cannot approve, and who prepared the run', async ({
  page,
}) => {
  await mockSession(page, ['payroll.read', 'payroll.calculate', 'payroll.approve']);
  const calculated = {
    ...run('CALCULATED', false),
    dualControl: true,
    calculatedBy: { userId: 'payroll-user', name: 'Pat Preparer' },
    approvedBy: null,
    finalizedBy: null,
    actions: {
      ...run('CALCULATED', false).actions,
      approveBlockedReason: 'CALCULATED_BY_YOU',
    },
  };
  await page.route(`${API}/payroll/runs/run-1`, (route) => json(route, calculated));
  await page.route(`${API}/payroll/runs/run-1/issues`, (route) => json(route, { items: [] }));
  await signIn(page);
  await page.goto('/admin/payroll/runs/run-1');
  await expect(
    page.getByText('You calculated this run: another administrator must approve and finalize it.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Summary' }).click();
  await expect(page.getByText('Pat Preparer')).toBeVisible();
  await expect(page.getByText('Dual control is disabled for this organization.')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
});

test('M2: a run in an organization without dual control says so', async ({ page }) => {
  await mockSession(page, ['payroll.read', 'payroll.approve']);
  const relaxed = {
    ...run('CALCULATED', true),
    dualControl: false,
    calculatedBy: { userId: 'payroll-user', name: 'Pat Preparer' },
    approvedBy: null,
    finalizedBy: null,
  };
  await page.route(`${API}/payroll/runs/run-1`, (route) => json(route, relaxed));
  await page.route(`${API}/payroll/runs/run-1/issues`, (route) => json(route, { items: [] }));
  await signIn(page);
  await page.goto('/admin/payroll/runs/run-1');
  await expect(page.getByText('Dual control is disabled for this organization.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});
