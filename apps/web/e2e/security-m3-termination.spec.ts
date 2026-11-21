import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Security remediation M3 — role grants and termination, against a mocked API:
 * - the termination dialog's "Roles and access" (revoke by default, a System-level grant must
 *   be decided, a keep is a request with a reason and at most 30 days), by keyboard;
 * - a scheduled termination's decisions: blocked until approved, approval only by someone other
 *   than the requester;
 * - the access review afterwards: grants revoked by the termination, a kept grant with its end
 *   date and approval, and the login state.
 * axe (serious/critical) and no page-wide horizontal scroll at desktop, tablet and a 375 px
 * phone, and once with forced colours.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const EMP = '55555555-5555-4555-8555-555555555555';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;
const KEEP_LIMIT = '2027-07-31T04:00:00.000Z';

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
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: 'm3-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId,
      permissions: permissions.map((key) => ({ key, scopes: [{ type: 'SYSTEM' }] })),
    }),
  );
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: userId, email: identity.email, displayName: 'Morgan Reedley' },
      systemPermissions: permissions,
      organizations: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: ['ATTENDANCE', 'LEAVE', 'COMPENSATION', 'ONBOARDING'],
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
  await page.emulateMedia({ forcedColors: 'active' });
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ forcedColors: 'none' });
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
const capabilities = {
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
    changePosition: true,
    assignManager: false,
    addCompensation: false,
    manageDocuments: false,
    startOffboarding: false,
    manageLifecycle: true,
  },
};
const hrGrant = {
  roleAssignmentId: 'grant-hr',
  roleName: 'HR Administrator',
  scopeType: 'ORGANIZATION',
  system: false,
  organizationId: ORG,
  organizationName: 'Northwind Academy',
  expiresAt: null,
  outcome: 'REVOKE',
};
const ownerGrant = {
  roleAssignmentId: 'grant-owner',
  roleName: 'System Owner',
  scopeType: 'SYSTEM',
  system: true,
  organizationId: null,
  organizationName: null,
  expiresAt: null,
  outcome: 'DECISION_REQUIRED',
};
const termination = (terminationDate: string, status = 'SCHEDULED') => ({
  id: 'term-1',
  employeeId: EMP,
  terminationDate,
  status,
  reason: null,
  systemGrantsAcknowledged: false,
  recordedByUserId: 'user-requester',
  recordedAt: '2026-06-01T17:00:00.000Z',
  appliedAt: null,
  appliedSource: null,
  cancelledAt: null,
  cancelledByUserId: null,
  supersededById: null,
  rehireAssignmentId: null,
  rehiredAt: null,
  assignments: [],
});
const pendingKeep = {
  id: 'decision-1',
  decision: 'KEEP',
  status: 'REQUESTED',
  reason: 'Handover of the payroll provider integration',
  keepUntil: '2027-07-11T04:00:00.000Z',
  requestedByUserId: 'user-requester',
  requestedByName: 'Rita Requester',
  requestedAt: '2026-06-02T15:00:00.000Z',
  reviewedByUserId: null,
  reviewedByName: null,
  reviewedAt: null,
  reviewNote: null,
  appliedAt: null,
  outcome: null,
  retainedRoleAssignmentId: null,
  retainedUntil: null,
};

interface Setup {
  status?: string;
  scheduled?: string;
  access?: unknown;
}

function employeeServer(page: Page, setup: Setup) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let decision: Record<string, unknown> = pendingKeep;
  const grantList = () => ({
    grants: [
      { ...hrGrant, decision: null },
      {
        ...ownerGrant,
        outcome: decision.status === 'APPROVED' ? 'KEEP' : 'KEEP_PENDING',
        decision,
      },
    ],
    otherAccessRemains: false,
    loginWillBeDisabled: decision.status !== 'APPROVED',
    blocking:
      decision.status === 'APPROVED'
        ? []
        : [{ roleAssignmentId: 'grant-owner', code: 'TERMINATION_KEEP_APPROVAL_REQUIRED' }],
    keepLimit: KEEP_LIMIT,
  });
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
            terminationDate: setup.scheduled ?? null,
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
        if (rest === '/capabilities') return json(route, capabilities);
        if (rest === '/terminations')
          return json(route, { items: setup.scheduled ? [termination(setup.scheduled)] : [] });
        if (rest === '/termination-preview') {
          const date = url.searchParams.get('terminationDate')!;
          return json(route, {
            employeeId: EMP,
            terminationDate: date,
            scheduled: true,
            assignments: [
              {
                employmentAssignmentId: 'asg-1',
                positionName: 'Grade 4 Teacher',
                organizationId: ORG,
                organizationName: 'Northwind Academy',
                timezone: 'America/Toronto',
                status: 'ACTIVE',
                startDate: '2026-01-05',
                endDate: null,
                action: 'END',
                newEndDate: date,
                effectiveFrom: date,
              },
            ],
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
            grantChanges: {
              grants: [hrGrant, ownerGrant],
              otherAccessRemains: false,
              loginWillBeDisabled: true,
              decisionsRequired: ['grant-owner'],
              keepLimit: KEEP_LIMIT,
            },
          });
        }
        if (rest === '/terminate')
          return json(
            route,
            {
              termination: termination('2027-06-30'),
              employee: { id: EMP, status: 'ACTIVE', terminationDate: '2027-06-30' },
            },
            201,
          );
        if (rest === '/terminations/term-1/grants') return json(route, grantList());
        if (rest === '/terminations/term-1/grant-decisions/decision-1/approve') {
          decision = {
            ...pendingKeep,
            status: 'APPROVED',
            reviewedByUserId: 'user-approver',
            reviewedByName: 'Alex Approver',
            reviewedAt: '2026-06-03T10:00:00.000Z',
          };
          return json(route, grantList());
        }
        if (rest === '/access-review')
          return json(route, {
            employeeId: EMP,
            employeeStatus: setup.status ?? 'ACTIVE',
            access: setup.access ?? null,
          });
        return json(route, { message: 'Not found' }, 404);
      },
    )
    .then(() => requests);
}

const ADMIN = ['employee.read', 'employee.manage', 'role.read', 'role.assign'];

test('terminate: each grant has a decision, the System-level one must be decided, and a keep is a request (keyboard)', async ({
  page,
}) => {
  await session(page, 'user-requester', ADMIN);
  const requests = await employeeServer(page, {});
  await page.goto(`/admin/employees/${EMP}#employment`);
  await page.getByRole('button', { name: 'Terminate employee' }).click();
  const dialog = page.getByRole('dialog', { name: 'Terminate employee' });
  await dialog.getByLabel('Last day of employment').fill('2027-06-30');
  const roles = dialog.getByRole('region', { name: 'Roles and access' });
  await expect(roles).toContainText('A keep is a request, not an approval');
  await expect(roles).toContainText('the login will be disabled');
  const submit = dialog.getByRole('button', { name: 'Schedule termination' });
  await expect(submit).toBeDisabled();
  const owner = roles.getByRole('group', { name: /System Owner/ });
  await expect(owner).toContainText('Required: decide');
  await checkAt(page);

  // By keyboard: choose "Request to keep", then fill the reason and the days.
  await owner.getByLabel('Revoke when the termination applies').focus();
  await page.keyboard.press('ArrowDown');
  await expect(owner.getByLabel(/Request to keep it/)).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(owner.getByLabel('Reason for keeping it')).toBeFocused();
  await page.keyboard.type('Handover of the payroll provider integration');
  await page.keyboard.press('Tab');
  await expect(owner.getByLabel(/how many days after the last day/)).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('10');
  await expect(owner).toContainText('Ends Jul 11, 2027');
  await expect(submit).toBeEnabled();
  await checkAt(page);
  await submit.click();
  await expect(page.getByText(/Termination scheduled: last day/).first()).toBeVisible();
  const sent = requests.find((r) => r.path.endsWith('/terminate'));
  expect(sent?.body).toEqual({
    terminationDate: '2027-06-30',
    grantDecisions: [
      {
        roleAssignmentId: 'grant-owner',
        decision: 'KEEP',
        reason: 'Handover of the payroll provider integration',
        keepUntil: '2027-07-11T04:00:00.000Z',
      },
    ],
  });
});

test('scheduled: blocked until another administrator approves; the requester cannot approve', async ({
  page,
}) => {
  await session(page, 'user-requester', ADMIN);
  await employeeServer(page, { scheduled: '2027-06-30' });
  await page.goto(`/admin/employees/${EMP}#employment`);
  const panel = page.getByRole('region', { name: 'Roles and access at termination' });
  await expect(panel.getByRole('alert')).toContainText('The termination cannot apply yet');
  await expect(panel).toContainText('Rita Requester');
  await expect(panel).toContainText('You requested this exception');
  await expect(panel.getByRole('button', { name: 'Approve keep' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Withdraw request' })).toBeVisible();
  await checkAt(page);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await session(page, 'user-approver', ADMIN);
  const requests = await employeeServer(page, { scheduled: '2027-06-30' });
  await page.reload();
  const again = page.getByRole('region', { name: 'Roles and access at termination' });
  await again.getByRole('button', { name: 'Approve keep' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve keeping System Owner?' });
  await expect(dialog).toContainText('Your approval is recorded in the audit log');
  await dialog.getByLabel(/Note/).fill('Agreed with payroll');
  await dialog.getByRole('button', { name: 'Approve keep' }).click();
  await expect(again.getByRole('status')).toContainText('Keep approved.');
  await expect(again).toContainText('Approved by Alex Approver');
  await expect(again.getByRole('alert')).toHaveCount(0);
  await checkAt(page);
  expect(requests.find((r) => r.path.endsWith('/decision-1/approve'))?.body).toEqual({
    note: 'Agreed with payroll',
  });
});

test('access review after termination: revoked grants, a kept grant with its end date, and the login state', async ({
  page,
}) => {
  await session(page, 'user-approver', ADMIN);
  await employeeServer(page, {
    status: 'TERMINATED',
    access: {
      userId: 'user-ada',
      loginStatus: 'ACTIVE',
      activeSessions: 0,
      grants: [
        {
          roleAssignmentId: 'kept-1',
          roleName: 'System Owner',
          scopeType: 'SYSTEM',
          organizationId: null,
          organizationName: null,
          relation: 'SYSTEM',
          revocable: false,
          inactiveReason: null,
          retention: {
            terminationId: 'term-1',
            keepUntil: '2027-07-11T04:00:00.000Z',
            approvalStatus: 'APPROVED',
            requestedByUserId: 'user-requester',
            approvedByUserId: 'user-approver',
          },
        },
      ],
      revokedByTermination: [
        {
          roleAssignmentId: 'grant-hr',
          roleName: 'HR Administrator',
          scopeType: 'ORGANIZATION',
          organizationName: 'Northwind Academy',
          revokedAt: '2027-07-01T04:00:00.000Z',
        },
      ],
      hiddenGrants: 0,
      systemGrants: 1,
      hasEffectiveAuthorization: true,
    },
  });
  await page.goto(`/admin/employees/${EMP}#overview`);
  const review = page.getByRole('region', { name: 'Access review' });
  await expect(review.getByText('Revoked by termination')).toBeVisible();
  await expect(review).toContainText('HR Administrator');
  await expect(review).toContainText('Kept after termination until Jul 11, 2027');
  await expect(review).toContainText('approved by another administrator');
  await expect(review).toContainText('an approved exception until its end date');
  await checkAt(page);
});
