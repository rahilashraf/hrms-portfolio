import { expect, test, type Page } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

const identity = {
  id: 'time-user',
  personId: 'person-time-user',
  email: 'time@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const assignment = {
  id: 'assignment-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-10-01',
  endDate: null,
  isPrimary: true,
  position: { id: 'position-1', name: 'Counsellor', code: 'COUN' },
  jobTitle: { id: 'job-1', name: 'Counsellor', code: 'COUN' },
  organization: { id: 'org-1', name: 'Camp', code: 'CAMP' },
  placement: null,
  workLocation: { id: 'loc-1', name: 'Main', code: 'MAIN' },
  manager: null,
};

const status = {
  state: 'OFF_CLOCK',
  serverTime: '2026-10-03T12:00:00.000Z',
  currentTimeEntry: null,
  currentAssignment: null,
  currentBreakEntry: null,
  breakStartedAt: null,
  clockedInAt: null,
  eligibleAssignments: [assignment],
  activeExceptions: [],
  availableActions: ['CLOCK_IN'],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/auth/refresh', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/auth/login', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken: 'time-e2e-token', identity }),
    }),
  );
  await page.route('**/auth/me/authorization', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        userId: identity.id,
        permissions: [
          { key: 'time.view', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
          { key: 'time.approve', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
          { key: 'time.timesheet.approve', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
        ],
      }),
    }),
  );
  await page.route(`${API}/time/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/time/me/status') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(status),
      });
    }
    if (method === 'POST' && url.pathname === '/time/me/clock-in') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          ...status,
          state: 'CLOCKED_IN',
          availableActions: ['CLOCK_OUT'],
          currentAssignment: assignment,
        }),
      });
    }
    if (
      url.pathname === '/time/me/entries' ||
      url.pathname === '/time/manage/current' ||
      url.pathname === '/time/manage/entries'
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], nextAfterId: null }),
      });
    }
    if (url.pathname === '/time/me/exceptions') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ exceptions: [] }),
      });
    }
    if (url.pathname === '/time/me/corrections') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ corrections: [] }),
      });
    }
    if (url.pathname === '/time/me/timesheets') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ timesheets: [] }),
      });
    }
    // Batch 4E-1: the organizations the manager reviews, with their capabilities.
    if (url.pathname === '/time/manage/organizations') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'org-1',
              name: 'Camp',
              code: 'CAMP',
              timezone: 'America/Toronto',
              workLocations: [],
              physicalSites: [],
              actions: {
                canViewSignIns: true,
                canCorrectSignIns: false,
                canManageDevices: false,
                canManagePolicies: false,
                canManagePins: false,
                canViewAttendance: true,
                canCorrectTime: false,
                canReviewExceptions: true,
                canReviewCorrections: true,
                canApproveTimesheets: true,
                canManageTimesheets: false,
                canManagePeriods: false,
              },
            },
          ],
        }),
      });
    }
    if (
      url.pathname === '/time/periods' ||
      url.pathname === '/time/manage/exceptions' ||
      url.pathname === '/time/manage/corrections' ||
      url.pathname === '/time/manage/timesheets'
    ) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], nextAfterId: null }),
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
});

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('employee time self-service renders backend actions', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'My Time', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Time & Attendance' })).toBeVisible();
  await expect(page.getByText('Off Clock')).toBeVisible();
  await page.getByRole('button', { name: 'Clock In' }).click();
  // Exact: My Time also says "Not clocked in." (Batch 4E-3).
  await expect(page.getByText('Clocked in.', { exact: true })).toBeVisible();
  // Batch 4E-3: the (stateless) mock leaves the button in place; let it finish fading back from
  // its busy state before checking contrast (axe would sample a mid-transition colour).
  await expect(page.getByRole('button', { name: 'Clock In' })).toHaveCSS('opacity', '1');
  // Batch 3B: no serious or critical accessibility violations on the final page.
  await expectNoSeriousA11yViolations(page);
});

test('time operations route renders scoped operational queues', async ({ page }) => {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Attendance', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Time operations' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Currently clocked in' })).toBeVisible();
  await page.getByRole('tab', { name: 'Corrections' }).click();
  await expect(page.getByRole('heading', { name: 'Correction queue' })).toBeVisible();
});
