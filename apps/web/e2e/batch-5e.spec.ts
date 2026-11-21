import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 5E — lifecycle hardening screens against a mocked API: the access review (newly vs
 * already revoked, inactive grants, one's own record without the System override), an inactive
 * employee without assignment actions, and applying a due termination with open time entries
 * (and when they cannot be checked). axe (serious/critical) and no page-wide horizontal scroll at
 * desktop, tablet and a 375 px phone.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG_ARCHIVED = '22222222-2222-4222-8222-222222222222';
const EMP = '55555555-5555-4555-8555-555555555555';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function session(page: Page, userId: string, permissions: string[]) {
  const identity = {
    id: userId,
    personId: `person-${userId}`,
    email: `${userId}@example.com`,
    status: 'ACTIVE',
    emailVerifiedAt: null,
    mustChangePassword: false,
  };
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '5e-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId,
      permissions: permissions.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    }),
  );
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: userId, email: identity.email, displayName: 'Morgan Reedley' },
      systemPermissions: [],
      organizations: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: ['ATTENDANCE', 'SCHEDULING', 'LEAVE', 'COMPENSATION', 'ONBOARDING'],
          permissions,
          isEmployee: false,
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

const org = { id: ORG, name: 'Northwind Academy', code: 'NWA' };
const assignment = {
  id: 'asg-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-05',
  endDate: null,
  isPrimary: true,
  position: { id: 'pos-1', name: 'Grade 4 Teacher', code: 'T4' },
  jobTitle: { id: 'jt-1', name: 'Teacher', code: 'TCH' },
  organization: org,
  placement: null,
  workLocation: null,
  manager: null,
  managerWarnings: [],
};
const capabilities = (changePosition: boolean, manageLifecycle = true) => ({
  employeeId: EMP,
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
  },
  actions: {
    edit: false,
    changePosition,
    assignManager: false,
    addCompensation: false,
    manageDocuments: false,
    startOffboarding: false,
    manageLifecycle,
  },
});
const grant = (id: string, overrides: Record<string, unknown> = {}) => ({
  roleAssignmentId: id,
  roleName: `Role ${id}`,
  scopeType: 'ORGANIZATION',
  organizationId: ORG,
  organizationName: 'Northwind Academy',
  relation: 'CURRENT_EMPLOYMENT',
  revocable: true,
  inactiveReason: null,
  ...overrides,
});

interface Setup {
  status?: string;
  changePosition?: boolean;
  manageLifecycle?: boolean;
  scheduled?: { terminationDate: string };
  openTimeEntries?: number | 'fail';
  revoke?: { status: number; body: unknown };
}

function employeeServer(page: Page, setup: Setup) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const termination = setup.scheduled
    ? {
        id: 'term-1',
        employeeId: EMP,
        terminationDate: setup.scheduled.terminationDate,
        status: 'SCHEDULED',
        reason: null,
        systemGrantsAcknowledged: false,
        recordedByUserId: 'hr',
        recordedAt: '2026-01-10T17:00:00.000Z',
        appliedAt: null,
        appliedSource: null,
        cancelledAt: null,
        cancelledByUserId: null,
        supersededById: null,
        rehireAssignmentId: null,
        rehiredAt: null,
        assignments: [],
      }
    : null;
  return page
    .route(
      (url) => url.origin === API && url.pathname.startsWith(`/employees/`),
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const rest = url.pathname.slice(`/employees/${EMP}`.length);
        requests.push({
          method: request.method(),
          path: url.pathname,
          body: request.postDataJSON?.() ?? null,
        });
        if (rest === '')
          return json(route, {
            id: EMP,
            employeeNumber: 'E-0005',
            status: setup.status ?? 'ACTIVE',
            hireDate: '2026-01-05',
            terminationDate: termination?.terminationDate ?? null,
            person: {
              firstName: 'Ada',
              middleName: null,
              lastName: 'Lovelace',
              preferredName: null,
              personalEmail: null,
              phone: null,
            },
            assignments: { current: [assignment], upcoming: [], historical: [], cancelled: [] },
          });
        if (rest === '/capabilities')
          return json(
            route,
            capabilities(setup.changePosition ?? true, setup.manageLifecycle ?? true),
          );
        if (rest === '/terminations')
          return json(route, { items: termination ? [termination] : [] });
        if (rest === '/termination-preview') {
          if (setup.openTimeEntries === 'fail') return json(route, { message: 'unavailable' }, 503);
          return json(route, {
            employeeId: EMP,
            terminationDate: url.searchParams.get('terminationDate'),
            scheduled: false,
            assignments: [],
            blockers: [],
            followUps: {
              openTimeEntries: setup.openTimeEntries ?? 0,
              futurePublishedShifts: 0,
              pendingLeaveRequests: 0,
              approvedLeaveAfterTermination: 0,
              openBenefitEnrollments: 0,
              openPerformanceReviews: 0,
            },
            access: null,
          });
        }
        if (rest === '/access-review')
          return json(route, {
            employeeId: EMP,
            employeeStatus: setup.status ?? 'ACTIVE',
            access: {
              userId: 'user-ada',
              loginStatus: 'ACTIVE',
              activeSessions: 1,
              grants: [
                grant('teacher'),
                grant('reader'),
                grant('archived', {
                  organizationId: ORG_ARCHIVED,
                  organizationName: 'Closed Campus',
                  relation: 'NO_EMPLOYMENT',
                  inactiveReason: 'ORGANIZATION_ARCHIVED',
                }),
              ],
              hiddenGrants: 0,
              systemGrants: 0,
              hasEffectiveAuthorization: true,
            },
          });
        if (rest === '/access-review/revoke-grants') {
          const revoke = setup.revoke ?? {
            status: 200,
            body: {
              employeeId: EMP,
              revoked: ['teacher'],
              alreadyRevoked: ['reader'],
              loginDisabled: false,
            },
          };
          return json(route, revoke.body, revoke.status);
        }
        return json(route, { message: 'Not found' }, 404);
      },
    )
    .then(() => requests);
}

const HR = [
  'employee.read',
  'employee.manage',
  'employee.account.manage',
  'role.read',
  'role.assign',
];

test('access review: inactive grants are marked, and the result separates newly revoked from already revoked', async ({
  page,
}) => {
  await session(page, 'user-hr', HR);
  await employeeServer(page, {});
  await page.goto(`/admin/employees/${EMP}#overview`);
  const review = page.getByRole('region', { name: 'Access review' });
  await expect(review.getByText('Inactive: organization archived')).toBeVisible();
  // The archived organization's grant is not counted as access elsewhere.
  await expect(review.getByText(/span more than one organization/)).toHaveCount(0);
  await checkAt(page);

  await review.getByLabel('Role teacher').check();
  await review.getByLabel('Role reader').check();
  await review.getByRole('button', { name: 'Revoke selected (2)' }).click();
  const confirm = page.getByRole('dialog', { name: 'Revoke 2 grants?' });
  await expect(confirm).toContainText('if any cannot be revoked, none is');
  await confirm.getByRole('button', { name: 'Revoke grants' }).click();
  await expect(review.getByRole('status')).toContainText('1 grant revoked.');
  await expect(review.getByRole('status')).toContainText(
    '1 selected grant had already been revoked (by someone else, or a moment earlier)',
  );
  await checkAt(page);
});

test('one’s own inactive record: no revoke controls (explained), and no assignment actions', async ({
  page,
}) => {
  // The signed-in user is the employee's own login (user-ada), without the System override.
  await session(page, 'user-ada', HR);
  // As the API answers for one's own record without the System override: no assignment or
  // lifecycle management; the access review is reached through login-access management.
  const requests = await employeeServer(page, {
    status: 'INACTIVE',
    changePosition: false,
    manageLifecycle: false,
  });
  await page.goto(`/admin/employees/${EMP}#overview`);
  const review = page.getByRole('region', { name: 'Access review' });
  await expect(review.getByText('Role teacher')).toBeVisible();
  await expect(review.getByText(/This is your own employment record/)).toBeVisible();
  await expect(review.getByRole('checkbox')).toHaveCount(0);
  await expect(review.getByRole('button', { name: /Revoke selected/ })).toHaveCount(0);
  await checkAt(page);

  await page.getByRole('tab', { name: 'Employment' }).click();
  await expect(page.getByRole('heading', { name: 'Employment', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add assignment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change position' })).toHaveCount(0);
  await checkAt(page);
  expect(requests.some((r) => r.path.endsWith('/revoke-grants'))).toBe(false);
});

test('a refused revocation explains why and that nothing was revoked', async ({ page }) => {
  await session(page, 'user-hr', HR);
  await employeeServer(page, {
    revoke: {
      status: 403,
      body: { statusCode: 403, code: 'LIFECYCLE_SELF_TARGET', action: 'REVOKE_GRANTS' },
    },
  });
  await page.goto(`/admin/employees/${EMP}#overview`);
  const review = page.getByRole('region', { name: 'Access review' });
  await review.getByLabel('Role teacher').check();
  await review.getByRole('button', { name: 'Revoke selected (1)' }).click();
  const confirm = page.getByRole('dialog', { name: 'Revoke 1 grant?' });
  await confirm.getByRole('button', { name: 'Revoke grants' }).click();
  await expect(confirm).toContainText(
    'You cannot revoke grants on your own employment record. Ask another administrator. Nothing was revoked.',
  );
  await checkAt(page);
});

test('applying a due termination warns about open time entries, and says when they cannot be checked', async ({
  page,
}) => {
  await session(page, 'user-hr', HR);
  await employeeServer(page, {
    scheduled: { terminationDate: '2026-01-15' },
    openTimeEntries: 2,
  });
  await page.goto(`/admin/employees/${EMP}#employment`);
  await page.getByRole('button', { name: 'Apply termination' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Apply the termination now?' });
  await expect(dialog).toContainText('2 open time entries: the employee is still clocked in.');
  await expect(dialog).toContainText('Terminating does not clock anyone out.');
  await checkAt(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await session(page, 'user-hr', HR);
  await employeeServer(page, {
    scheduled: { terminationDate: '2026-01-15' },
    openTimeEntries: 'fail',
  });
  await page.reload();
  await page.getByRole('button', { name: 'Apply termination' }).first().click();
  const again = page.getByRole('dialog', { name: 'Apply the termination now?' });
  await expect(again).toContainText('Open time entries could not be checked');
  await expect(again).not.toContainText('No open time entries.');
  await expect(again.getByRole('button', { name: 'Apply termination' })).toBeEnabled();
  await checkAt(page);
});
