import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 5C — employee and organization lifecycle screens against a mocked API: hire → schedule
 * a termination → cancel it → apply → rehire; an assignment's impact preview → transfer →
 * compensation reminder; organization → physical sites → work location picker → archive
 * restriction. axe (serious/critical) and no page-wide horizontal scroll at desktop, tablet and
 * phone widths. Screenshots (deviceScaleFactor 2) when BATCH_5C_SCREENSHOTS_DIR is set.
 */

const SHOTS = process.env.BATCH_5C_SCREENSHOTS_DIR;
test.use({ deviceScaleFactor: SHOTS ? 2 : 1 });

const ORG = '11111111-1111-4111-8111-111111111111';
const EMP = '33333333-3333-4333-8333-333333333333';
const ASG = '44444444-4444-4444-8444-444444444444';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
} as const;
type Viewport = keyof typeof VIEWPORTS;
const ALL: Viewport[] = ['desktop', 'tablet', 'phone'];

const identity = {
  id: 'user-5c',
  personId: 'person-5c',
  email: 'hr@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function session(page: Page, permissions: string[]) {
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '5c-token' }));
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

async function noHorizontalScroll(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
}

async function checkAt(page: Page, viewports: Viewport[] = ALL) {
  for (const name of viewports) {
    await page.setViewportSize(VIEWPORTS[name]);
    await noHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

async function screenshot(page: Page, name: string, fullPage = true) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage });
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const org = { id: ORG, name: 'Northwind Academy', code: 'NWA' };
const assignment = (overrides: Record<string, unknown> = {}) => ({
  id: ASG,
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-05',
  endDate: null,
  isPrimary: true,
  position: { id: 'pos-teacher', name: 'Grade 4 Teacher', code: 'T4' },
  jobTitle: { id: 'jt-1', name: 'Teacher', code: 'TCH' },
  organization: org,
  placement: { type: 'DEPARTMENT', id: 'dept-1', name: 'Elementary', code: 'EL' },
  workLocation: { id: 'wl-1', name: 'Main campus', code: 'MAIN' },
  manager: {
    assignmentId: 'mgr-asg',
    employeeId: 'mgr-emp',
    employeeNumber: 'E-0002',
    displayName: 'Grace Hopper',
    positionName: 'Principal',
  },
  managerWarnings: ['MANAGER_ASSIGNMENT_ENDED'],
  ...overrides,
});
const person = {
  firstName: 'Ada',
  middleName: null,
  lastName: 'Lovelace',
  preferredName: null,
  personalEmail: 'ada@example.com',
  phone: null,
};
const capabilities = {
  employeeId: EMP,
  organizationIds: [ORG],
  tabs: {
    overview: true,
    employment: true,
    compensation: true,
    time: false,
    leave: false,
    benefits: false,
    documents: false,
    performance: false,
  },
  actions: {
    edit: false,
    changePosition: true,
    assignManager: true,
    addCompensation: true,
    manageDocuments: false,
    startOffboarding: true,
    manageLifecycle: true,
  },
};
const termination = (overrides: Record<string, unknown> = {}) => ({
  id: 'term-1',
  employeeId: EMP,
  terminationDate: '2099-06-30',
  status: 'SCHEDULED',
  reason: 'Relocating',
  systemGrantsAcknowledged: false,
  recordedByUserId: identity.id,
  recordedAt: '2026-11-04T17:00:00.000Z',
  appliedAt: null,
  appliedSource: null,
  cancelledAt: null,
  cancelledByUserId: null,
  supersededById: null,
  rehireAssignmentId: null,
  rehiredAt: null,
  assignments: [],
  ...overrides,
});
const accessReview = (status: string) => ({
  employeeId: EMP,
  employeeStatus: status,
  access: {
    userId: 'user-ada',
    loginStatus: 'ACTIVE',
    activeSessions: status === 'TERMINATED' ? 0 : 1,
    grants: [
      {
        roleAssignmentId: 'grant-1',
        roleName: 'Teacher',
        scopeType: 'ORGANIZATION',
        organizationId: ORG,
        organizationName: 'Northwind Academy',
        relation: status === 'TERMINATED' ? 'ENDED_EMPLOYMENT' : 'CURRENT_EMPLOYMENT',
        revocable: true,
      },
    ],
    hiddenGrants: 1,
    systemGrants: 0,
    hasEffectiveAuthorization: true,
  },
});
const preview = (date: string) => ({
  employeeId: EMP,
  terminationDate: date,
  scheduled: date >= '2026-11-04',
  assignments: [
    {
      employmentAssignmentId: ASG,
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
    futurePublishedShifts: 3,
    pendingLeaveRequests: 1,
    approvedLeaveAfterTermination: 0,
    openBenefitEnrollments: 0,
    openPerformanceReviews: 0,
  },
  access: accessReview('ACTIVE').access,
});
const list = <T>(items: T[], total = items.length) => ({
  total,
  items,
  truncated: total > items.length,
  limit: 50,
});
const impact = (endDate: string) => ({
  employeeId: EMP,
  employmentAssignmentId: ASG,
  organizationId: ORG,
  timezone: 'America/Toronto',
  endDate,
  blocked: false,
  blockers: [],
  attendance: { openTimeEntries: list([]) },
  scheduling: {
    futurePublishedShifts: list(
      Array.from({ length: 50 }, (_, i) => ({ id: `shift-${i}`, workDate: '2026-12-02' })),
      64,
    ),
  },
  leave: {
    pending: list([{ id: 'lv-1', startDate: '2026-12-10', endDate: '2026-12-11' }]),
    approvedAfterEnd: list([]),
  },
  compensation: {
    recordsBeyondEnd: list([
      { id: 'comp-1', effectiveFrom: '2026-01-05', effectiveTo: null, payGroupId: null },
    ]),
  },
  payroll: null,
  benefits: null,
  managerRelationships: {
    visibleDirectReports: [],
    visibleDirectReportCount: 0,
    truncated: false,
    limit: 200,
  },
  employment: {
    otherCurrentAssignments: [],
    remainsEmployedInOrganization: false,
    endsLastCurrentEmployment: null,
  },
  access: { loginStatus: 'ACTIVE', grantsInOrganization: 1, changesAccess: false },
  offboarding: {
    employeeId: EMP,
    employmentAssignmentId: ASG,
    plannedEndDate: endDate,
    defaultTemplate: { id: '55555555-5555-4555-8555-555555555555', name: 'Staff exit' },
    openWorkflowId: null,
  },
});
const positionOption = {
  id: 'pos-lead',
  name: 'Literacy Lead',
  code: 'LL',
  jobTitle: { id: 'jt-2', name: 'Lead', code: 'LEAD' },
  organization: org,
  placement: null,
  workLocation: null,
};

/** A stateful mock of the employee endpoints the profile uses. */
function employeeServer(page: Page) {
  const state = {
    status: 'ACTIVE' as 'ACTIVE' | 'TERMINATED',
    terminationDate: null as string | null,
    terminations: [] as Array<Record<string, unknown>>,
    current: [assignment()] as Array<Record<string, unknown>>,
    historical: [] as Array<Record<string, unknown>>,
    requests: [] as Array<{ method: string; path: string; body: unknown }>,
  };
  const profile = () => ({
    id: EMP,
    employeeNumber: 'E-0001',
    status: state.status,
    hireDate: '2026-01-05',
    terminationDate: state.terminationDate,
    person,
    assignments: {
      current: state.current,
      upcoming: [],
      historical: state.historical,
      cancelled: [],
    },
  });
  return page
    .route(
      (url) => url.origin === API && url.pathname.startsWith(`/employees/`),
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const rest = url.pathname.slice(`/employees/${EMP}`.length);
        const body = request.postDataJSON?.() ?? null;
        state.requests.push({ method: request.method(), path: url.pathname, body });
        if (url.pathname === '/employees/options/positions')
          return json(route, { items: [positionOption], nextAfterId: null });
        if (url.pathname === '/employees/options/manager-assignments')
          return json(route, { items: [], nextAfterId: null });
        if (rest === '') return json(route, profile());
        if (rest === '/capabilities') return json(route, capabilities);
        if (rest === '/terminations') return json(route, { items: state.terminations });
        if (rest === '/termination-preview')
          return json(route, preview(url.searchParams.get('terminationDate')!));
        if (rest === '/access-review') return json(route, accessReview(state.status));
        if (rest === '/terminate') {
          const date = (body as { terminationDate: string }).terminationDate;
          const scheduled = date >= '2026-11-04';
          const record = termination({
            terminationDate: date,
            status: scheduled ? 'SCHEDULED' : 'APPLIED',
          });
          state.terminations = [record, ...state.terminations];
          state.terminationDate = date;
          if (!scheduled) {
            state.status = 'TERMINATED';
            state.historical = state.current.map((a) => ({ ...a, status: 'ENDED', endDate: date }));
            state.current = [];
          }
          return json(route, {
            termination: record,
            employee: { id: EMP, status: state.status, terminationDate: date },
          });
        }
        if (rest === '/terminations/term-1/cancel') {
          state.terminations = state.terminations.map((t) =>
            t.status === 'SCHEDULED'
              ? { ...t, status: 'CANCELLED', cancelledAt: '2026-11-04T18:00:00Z' }
              : t,
          );
          state.terminationDate = null;
          return json(route, {
            termination: state.terminations[0],
            employee: { id: EMP, status: 'ACTIVE', terminationDate: null },
          });
        }
        if (rest === '/rehire') {
          state.status = 'ACTIVE';
          state.terminationDate = null;
          state.current = [
            assignment({ id: 'asg-rehire', startDate: '2026-11-15', managerWarnings: [] }),
          ];
          return json(route, {
            employee: { id: EMP, status: 'ACTIVE' },
            assignment: { id: 'asg-rehire', startDate: '2026-11-15', endDate: null },
            terminationId: 'term-1',
          });
        }
        if (rest === `/assignments/${ASG}/impact`)
          return json(route, impact(url.searchParams.get('endDate') ?? '2026-11-30'));
        if (rest === `/assignments/${ASG}/transfer`) {
          state.current = [
            assignment({ status: 'ACTIVE', endDate: '2026-11-30' }),
            assignment({
              id: 'asg-new',
              status: 'PLANNED',
              startDate: '2026-12-01',
              position: { id: 'pos-lead', name: 'Literacy Lead', code: 'LL' },
              managerWarnings: [],
            }),
          ];
          return json(route, {
            replayed: false,
            sourceAssignment: { id: ASG, endDate: '2026-11-30', status: 'ACTIVE' },
            destinationAssignment: {
              id: 'asg-new',
              positionId: 'pos-lead',
              startDate: '2026-12-01',
              endDate: null,
              status: 'PLANNED',
              isPrimary: true,
            },
            compensationRequired: true,
            sourceHadCompensation: true,
            primaryCarried: true,
            manager: { managerAssignmentId: 'mgr-asg', carried: true, droppedReason: null },
          });
        }
        return json(route, { message: 'Not found' }, 404);
      },
    )
    .then(() => state);
}

// ─── Employee lifecycle ─────────────────────────────────────────────────────

test('lifecycle: schedule a termination, see the banner, cancel it; terminate; rehire — accessible at every width', async ({
  page,
}) => {
  await session(page, ['employee.read', 'employee.manage', 'role.read', 'role.assign']);
  const server = await employeeServer(page);
  await page.goto(`/admin/employees/${EMP}#employment`);
  await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible();
  await expect(page.getByText(/manager’s assignment has ended/)).toBeVisible();

  // Schedule.
  await page.getByRole('button', { name: 'Terminate employee' }).click();
  const dialog = page.getByRole('dialog', { name: 'Terminate employee' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Last day of employment')).toBeFocused();
  await dialog.getByLabel('Last day of employment').fill('2099-06-30');
  await dialog.getByLabel(/^Reason/).fill('Relocating');
  await expect(dialog.getByText(/Scheduled: the employee keeps working through/)).toBeVisible();
  await expect(dialog.getByText('3 published shifts after the last day')).toBeVisible();
  await screenshot(page, '01-termination-dialog-scheduled', false);
  await checkAt(page);
  await dialog.getByRole('button', { name: 'Schedule termination' }).click();
  await expect(page.getByRole('status', { name: 'Scheduled termination' })).toContainText(
    'Termination scheduled: last day Jun 30, 2099',
  );
  await expect(page.getByText(/last day Jun 30, 2099/).first()).toBeVisible();
  await expect(page.getByText('Reason (restricted):')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review offboarding' }).first()).toHaveAttribute(
    'href',
    new RegExp(
      `offboardEmployee=${EMP}&offboardOrganization=${ORG}&offboardAssignment=${ASG}&offboardEndDate=2099-06-30#start`,
    ),
  );
  await screenshot(page, '02-profile-termination-scheduled');
  await checkAt(page);

  // Cancel.
  await page.getByRole('button', { name: 'Cancel termination' }).click();
  const cancel = page.getByRole('dialog', { name: /Cancel the scheduled termination/ });
  await cancel.getByRole('button', { name: 'Cancel termination' }).click();
  await expect(page.getByText(/Scheduled termination cancelled/)).toBeVisible();
  await expect(page.getByRole('status', { name: 'Scheduled termination' })).toHaveCount(0);

  // Terminate with a past date (immediate, explicit confirmation).
  await page.getByRole('button', { name: 'Terminate employee' }).click();
  const now = page.getByRole('dialog', { name: 'Terminate employee' });
  await now.getByLabel('Last day of employment').fill('2026-10-30');
  await expect(now.getByText(/Immediate:/)).toBeVisible();
  await expect(now.getByRole('button', { name: 'Terminate now' })).toBeDisabled();
  await now.getByLabel(/employment ends now/).check();
  await now.getByRole('button', { name: 'Terminate now' }).click();
  await expect(page.getByText(/Employee terminated\./)).toBeVisible();

  // Access review: employment vs login, never automatic.
  await page.getByRole('tab', { name: 'Overview' }).click();
  const review = page.getByRole('region', { name: 'Access review' });
  await expect(review.getByText(/login is still active because role grants remain/)).toBeVisible();
  await expect(review.getByText('1 more grant outside your access is not shown.')).toBeVisible();
  expect(server.requests.some((r) => r.path.endsWith('/revoke-grants'))).toBe(false);
  await screenshot(page, '03-access-review-terminated');
  await checkAt(page);

  // Rehire.
  await page.getByRole('button', { name: 'Rehire employee' }).click();
  const rehire = page.getByRole('dialog', { name: 'Rehire employee' });
  await expect(rehire.getByText(/Sign-in access and role grants are not restored/)).toBeVisible();
  await expect(rehire.getByLabel('Start date')).toHaveValue('2026-10-31');
  await rehire.getByRole('button', { name: /Literacy Lead/ }).click();
  await rehire.getByLabel('Employment type').selectOption('FULL_TIME');
  await rehire.getByLabel('Start date').fill('2026-11-15');
  await screenshot(page, '04-rehire-dialog', false);
  await checkAt(page, ['phone']);
  await rehire.getByRole('button', { name: 'Rehire employee' }).click();
  await expect(page.getByText(/Employee rehired into the new assignment/)).toBeVisible();
  const sent = server.requests.find((r) => r.path.endsWith('/rehire'))!.body as {
    assignment: Record<string, unknown>;
  };
  expect(sent.assignment).toMatchObject({
    positionId: 'pos-lead',
    employmentType: 'FULL_TIME',
    startDate: '2026-11-15',
    isPrimary: true,
  });
});

// ─── Impact preview and transfer ────────────────────────────────────────────

test('assignment: impact preview (exact totals, hidden sections), transfer, compensation reminder', async ({
  page,
}) => {
  await session(page, ['employee.read', 'employee.manage', 'compensation.manage']);
  const server = await employeeServer(page);
  await page.goto(`/admin/employees/${EMP}#employment`);
  await page.getByRole('button', { name: 'Preview impact' }).click();
  const panel = page.getByRole('region', { name: 'Impact preview for Grade 4 Teacher' });
  await panel.getByLabel('If this assignment ended on (inclusive)').fill('2026-11-30');
  await expect(panel.getByText('64 published shifts after the last day')).toBeVisible();
  await expect(panel.getByText('(showing the first 50 of 64)')).toBeVisible();
  await expect(panel.getByText(/Not shown with your access: payroll, benefits/)).toBeVisible();
  await expect(
    panel.getByText('The employee would have no other employment in this organization.'),
  ).toBeVisible();
  await screenshot(page, '05-impact-preview');
  await checkAt(page);
  await panel.getByRole('button', { name: 'Close preview' }).click();

  await page.getByRole('button', { name: 'Transfer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Transfer from Grade 4 Teacher' });
  await dialog.getByRole('button', { name: /Literacy Lead/ }).click();
  await dialog.getByLabel('First day in the new position').fill('2026-12-01');
  await expect(dialog.getByText('Grade 4 Teacher ends Nov 30, 2026 (inclusive).')).toBeVisible();
  await expect(
    dialog.getByText('1 compensation record continuing past the last day'),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Transfer' })).toBeDisabled();
  await dialog.getByLabel(/I reviewed the impact/).check();
  await screenshot(page, '06-transfer-dialog', false);
  await checkAt(page, ['desktop', 'phone']);
  await dialog.getByRole('button', { name: 'Transfer' }).click();
  const notice = page.getByRole('status', { name: 'Transfer recorded' });
  await expect(notice).toContainText('Compensation is not copied: add a compensation record');
  expect(server.requests.find((r) => r.path.endsWith('/transfer'))!.body).toEqual({
    positionId: 'pos-lead',
    effectiveDate: '2026-12-01',
    employmentType: 'FULL_TIME',
    isPrimary: true,
  });
  await screenshot(page, '07-transfer-recorded');
  await notice.getByRole('button', { name: 'Add compensation' }).click();
  await expect(page.getByRole('tab', { name: 'Compensation' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('transfer: a conflict is explained and nothing is sent twice', async ({ page }) => {
  await session(page, ['employee.read', 'employee.manage']);
  await employeeServer(page);
  await page.route(
    (url) => url.origin === API && url.pathname.endsWith(`/assignments/${ASG}/transfer`),
    (route) =>
      json(route, { statusCode: 409, code: 'TRANSFER_SOURCE_CHANGED', message: 'changed' }, 409),
  );
  await page.goto(`/admin/employees/${EMP}#employment`);
  await page.getByRole('button', { name: 'Transfer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Transfer from Grade 4 Teacher' });
  await dialog.getByRole('button', { name: /Literacy Lead/ }).click();
  await dialog.getByLabel('First day in the new position').fill('2026-12-01');
  await dialog.getByLabel(/I reviewed the impact/).check();
  await dialog.getByRole('button', { name: 'Transfer' }).click();
  await expect(dialog.getByRole('alert')).toContainText('changed while you were working');
  await expect(dialog).toBeVisible();
});

// ─── Organization: physical sites ───────────────────────────────────────────

test('organization: physical sites, archive restriction, and the work-location site picker', async ({
  page,
}) => {
  await session(page, ['organization.read', 'organization.manage']);
  const sites = [
    {
      id: 'site-main',
      organizationId: ORG,
      name: 'Main campus',
      addressLine1: '1 King St W',
      addressLine2: null,
      city: 'Toronto',
      stateProvince: 'ON',
      postalCode: null,
      country: 'CA',
      archivedAt: null,
      createdAt: '',
      updatedAt: '',
      activeWorkLocations: 2,
      activeDevices: 1,
    },
    {
      id: 'site-annex',
      organizationId: ORG,
      name: 'Annex',
      addressLine1: null,
      addressLine2: null,
      city: null,
      stateProvince: null,
      postalCode: null,
      country: null,
      archivedAt: null,
      createdAt: '',
      updatedAt: '',
      activeWorkLocations: 0,
      activeDevices: 0,
    },
  ];
  const created: unknown[] = [];
  await page.route(
    (url) => url.origin === API && url.pathname.startsWith(`/organizations`),
    async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (url.pathname === '/organizations')
        return json(route, [
          {
            ...org,
            description: null,
            sortOrder: 0,
            timezone: 'America/Toronto',
            archivedAt: null,
            createdAt: '',
            updatedAt: '',
          },
        ]);
      if (url.pathname === `/organizations/${ORG}`)
        return json(route, {
          ...org,
          description: null,
          sortOrder: 0,
          timezone: 'America/Toronto',
          archivedAt: null,
          createdAt: '',
          updatedAt: '',
        });
      if (url.pathname === `/organizations/${ORG}/physical-sites` && method === 'POST') {
        const body = route.request().postDataJSON();
        created.push(body);
        const site = { ...sites[1], id: 'site-north', name: body.name };
        sites.push(site);
        return json(route, site, 201);
      }
      if (url.pathname === `/organizations/${ORG}/physical-sites`)
        return json(route, { items: sites });
      if (url.pathname === `/organizations/${ORG}/physical-sites/site-annex/archive`) {
        sites.splice(1, 1);
        return json(route, { id: 'site-annex' });
      }
      if (url.pathname === `/organizations/${ORG}/work-locations`) return json(route, []);
      return json(route, []);
    },
  );
  await page.goto(`/admin/organizations/${ORG}/physical-sites`);
  const listing = page.getByRole('list', { name: 'Physical sites' });
  const main = listing.getByRole('listitem').filter({ hasText: 'Main campus' });
  await expect(main.getByRole('button', { name: 'Archive' })).toBeDisabled();
  await expect(main).toContainText(
    'In use by 2 work locations and 1 active kiosk device. Move or archive them before archiving this site.',
  );
  await screenshot(page, '08-physical-sites');
  await checkAt(page);

  await page.getByRole('button', { name: 'Add physical site' }).click();
  const add = page.getByRole('dialog', { name: 'Add physical site' });
  await add.getByLabel(/^Name/).fill('North building');
  await add.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByText('North building added.')).toBeVisible();
  expect(created).toHaveLength(1);

  const annex = listing.getByRole('listitem').filter({ hasText: 'Annex' });
  await annex.getByRole('button', { name: 'Archive' }).click();
  await page
    .getByRole('dialog', { name: 'Archive Annex?' })
    .getByRole('button', { name: 'Archive site' })
    .click();
  await expect(page.getByText('Annex archived.')).toBeVisible();

  // The work-location form offers the organization's sites and the create option.
  await page.goto(`/admin/organizations/${ORG}/work-locations`);
  await page.getByRole('button', { name: 'New record' }).click();
  const picker = page.getByLabel('Physical Site');
  await expect(picker.locator('option')).toHaveText([
    'Create a matching physical site',
    'Main campus',
    'North building',
  ]);
  await screenshot(page, '09-work-location-site-picker');
  await checkAt(page, ['phone']);
});

// ─── Pre-merge fixes D1 / D2 ────────────────────────────────────────────────

test('termination: partly immediate across Toronto/Kolkata needs confirmation; a later reschedule never shows stale end dates', async ({
  page,
}) => {
  // 20:00 UTC on Nov 4: still Nov 4 in Toronto, already Nov 5 in Kolkata.
  await page.clock.setFixedTime(new Date('2026-11-04T20:00:00.000Z'));
  await session(page, ['employee.read', 'employee.manage']);
  const server = await employeeServer(page);
  const twoZones = (date: string, endDate: string) => ({
    ...preview(date),
    assignments: [
      { ...preview(date).assignments[0], newEndDate: endDate },
      {
        ...preview(date).assignments[0],
        employmentAssignmentId: 'asg-kolkata',
        positionName: 'Counsellor',
        organizationName: 'Mumbai Campus',
        timezone: 'Asia/Kolkata',
        newEndDate: endDate,
      },
    ],
  });
  await page.route(
    (url) => url.origin === API && url.pathname === `/employees/${EMP}/termination-preview`,
    (route) => {
      const date = new URL(route.request().url()).searchParams.get('terminationDate')!;
      // After the termination is scheduled for Nov 4 the assignments end Nov 4 (shortened).
      return json(route, twoZones(date, server.terminationDate ? server.terminationDate : date));
    },
  );
  await page.goto(`/admin/employees/${EMP}#employment`);
  await page.getByRole('button', { name: 'Terminate employee' }).click();
  const dialog = page.getByRole('dialog', { name: 'Terminate employee' });
  await dialog.getByLabel('Last day of employment').fill('2026-11-04');
  const section = dialog.getByRole('region', { name: 'Termination preview' });
  await expect(section).toContainText('Partly immediate: Nov 4, 2026 has already passed');
  await expect(section).not.toContainText('Nothing ends today');
  await expect(dialog.getByRole('button', { name: 'Record termination' })).toBeDisabled();
  const confirm = dialog.getByLabel(/I understand they end as soon as I confirm/);
  await expect(
    dialog.getByText(
      /these assignments are: Counsellor \(Mumbai Campus, Asia\/Kolkata\)\. I understand/,
    ),
  ).toBeVisible();
  await checkAt(page, ['phone']);
  expect(server.requests.some((r) => r.path.endsWith('/terminate'))).toBe(false);
  await confirm.check();
  await dialog.getByRole('button', { name: 'Record termination' }).click();
  await expect(page.getByRole('status', { name: 'Scheduled termination' })).toBeVisible();
  expect(server.requests.filter((r) => r.path.endsWith('/terminate'))).toHaveLength(1);

  // Reschedule to a later day: the preview is still computed from the shortened end dates.
  await page.getByRole('button', { name: 'Reschedule' }).click();
  const reschedule = page.getByRole('dialog', { name: 'Reschedule termination' });
  await reschedule.getByLabel('Last day of employment').fill('2026-12-31');
  const later = reschedule.getByRole('region', { name: 'Termination preview' });
  await expect(later).toContainText('Last day moves from Nov 4, 2026 to Dec 31, 2026.');
  await expect(later).not.toContainText('ends Nov 4, 2026');
  await expect(later.getByRole('note')).toContainText('cannot be previewed yet');
  await expect(later).toContainText('counted for the current last day (Nov 4, 2026)');
  await screenshot(page, '10-reschedule-later-preview', false);
  await checkAt(page, ['desktop', 'phone']);
});
