import { expect, test, type Page } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

const identity = {
  id: 'leave-user',
  personId: 'person-leave-user',
  email: 'leave@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const vacation = {
  id: 'type-vac',
  code: 'VAC',
  name: 'Vacation',
  classification: 'PAID',
  tracksBalance: true,
  displayUnit: 'HOURS',
};
const employee = { id: 'employee-2', employeeNumber: 'E2', displayName: 'Grace Hopper' };

const overview = {
  employeeId: 'employee-1',
  assignments: [
    {
      employmentAssignmentId: 'assignment-1',
      isPrimary: true,
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      startDate: '2026-01-01',
      endDate: null,
      position: { id: 'position-1', name: 'Counsellor', code: 'COUN' },
      organization: { id: 'org-1', name: 'Camp' },
      timezone: 'America/Toronto',
      asOf: '2027-03-02',
      leaveTypes: [
        {
          leaveType: vacation,
          eligible: true,
          policy: {
            id: 'policy-1',
            standardWorkdayMinutes: 480,
            allowPartialDay: true,
            amountSource: 'SCHEDULE_THEN_STANDARD',
            negativeBalanceLimitMinutes: 0,
            employeeMayCancelApprovedFuture: true,
          },
          accountId: 'account-1',
          balance: {
            currentMinutes: 2400,
            scheduledMinutes: 0,
            availableMinutes: 2400,
            pendingMinutes: 0,
          },
          actions: { canRequest: true },
        },
      ],
      actions: { canRequest: true },
    },
  ],
};

const day = (
  date: string,
  minutes: number,
  amountSource: string,
  holidayName: string | null = null,
) => ({
  date,
  minutes,
  amountSource,
  windowStart: `${date}T14:00:00.000Z`,
  windowEnd: `${date}T22:00:00.000Z`,
  absenceStart: `${date}T05:00:00.000Z`,
  absenceEnd: `${date}T05:00:00.000Z`,
  scheduledShiftRevisionIds: [],
  holidayName,
  overrideReason: null,
  cancelled: false,
});

const pending = {
  id: 'request-9',
  status: 'PENDING',
  employee,
  employmentAssignmentId: 'assignment-9',
  positionName: 'Cook',
  leaveType: vacation,
  startDate: '2027-04-05',
  endDate: '2027-04-05',
  startLocalTime: null,
  endLocalTime: null,
  timezone: 'America/Toronto',
  requestedMinutes: 480,
  approvedMinutes: null,
  activeMinutes: null,
  cancelledDayCount: 0,
  submittedAt: '2027-03-01T12:00:00.000Z',
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

test.beforeEach(async ({ page }) => {
  let myRequests: unknown[] = [];
  let decided = false;
  await page.route('**/auth/refresh', (route) => route.fulfill(json({}, 401)));
  await page.route('**/auth/login', (route) =>
    route.fulfill(json({ accessToken: 'leave-e2e-token', identity }, 201)),
  );
  await page.route('**/auth/me/authorization', (route) =>
    route.fulfill(
      json({
        userId: identity.id,
        permissions: [
          { key: 'leave.request', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
          { key: 'leave.approve', scopes: [{ type: 'TEAM', id: 'team-1' }] },
        ],
      }),
    ),
  );
  await page.route(`${API}/leave/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/leave/me') return route.fulfill(json(overview));
    // Batch 6B: the team calendar and holidays on My Leave.
    if (url.pathname === '/leave/me/team-calendar')
      return route.fulfill(
        json({ range: { from: '', to: '' }, teams: [], hasTeam: false, people: [] }),
      );
    if (url.pathname === '/leave/me/holidays') return route.fulfill(json({ items: [] }));
    if (url.pathname === '/leave/me/requests' && method === 'GET')
      return route.fulfill(json({ items: myRequests, nextAfterId: null }));
    if (url.pathname === '/leave/me/requests/preview') {
      const input = route.request().postDataJSON();
      return route.fulfill(
        json({
          employmentAssignmentId: input.employmentAssignmentId,
          leaveType: vacation,
          timezone: 'America/Toronto',
          startDate: input.startDate,
          endDate: input.endDate,
          partial: null,
          totalMinutes: 480,
          days: [
            day('2027-03-08', 480, 'SCHEDULE'),
            day('2027-03-09', 0, 'HOLIDAY_EXCLUDED', 'Founders Day'),
          ],
          balance: {
            currentMinutes: 2400,
            scheduledMinutes: 0,
            availableMinutes: 2400,
            pendingMinutes: 0,
            leaveYear: { start: '2027-01-01', end: '2027-12-31' },
            availableForLeaveYearMinutes: 2400,
            availableAfterMinutes: 1920,
            negativeBalanceLimitMinutes: 0,
            sufficient: true,
          },
        }),
      );
    }
    if (url.pathname === '/leave/me/requests' && method === 'POST') {
      const input = route.request().postDataJSON();
      myRequests = [
        {
          ...pending,
          id: 'request-1',
          employee: { id: 'employee-1', employeeNumber: 'E1', displayName: 'Leave User' },
          startDate: input.startDate,
          endDate: input.endDate,
          actions: { canCancel: true },
        },
      ];
      return route.fulfill(json({ requestId: 'request-1', status: 'PENDING' }, 201));
    }
    if (url.pathname === '/leave/organizations') {
      return route.fulfill(
        json({
          items: [
            {
              id: 'org-1',
              name: 'Camp',
              timezone: 'America/Toronto',
              actions: {
                canReadRequests: true,
                canApprove: true,
                canViewBalances: true,
                canAdjust: false,
                canReadConfiguration: true,
                canManageTypes: false,
                canManagePolicies: false,
                canReadHolidays: false,
                canManageHolidays: false,
                canManageOrganizationHolidays: false,
              },
              holidayScopes: [],
            },
          ],
        }),
      );
    }
    if (url.pathname === '/leave/requests') {
      const status = decided ? 'APPROVED' : 'PENDING';
      const items =
        url.searchParams.get('status') === 'PENDING' && decided
          ? []
          : [
              {
                ...pending,
                status,
                actions: { canApprove: !decided, canReject: !decided, canAmend: decided },
              },
            ];
      return route.fulfill(json({ items, nextAfterId: null }));
    }
    if (url.pathname === '/leave/requests/request-9') {
      return route.fulfill(
        json({
          ...pending,
          status: decided ? 'APPROVED' : 'PENDING',
          approvedMinutes: decided ? 480 : null,
          reason: null,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          requestedByUserId: 'user-2',
          days: [
            {
              ...day('2027-04-05', 480, 'STANDARD_DAY'),
              id: 'day-9',
              cancelledByAmendmentId: null,
              locked: false,
            },
          ],
          events: [
            {
              id: 'event-1',
              type: 'SUBMITTED',
              actorUserId: 'user-2',
              note: null,
              metadata: {},
              occurredAt: '2027-03-01T12:00:00.000Z',
            },
          ],
          amendments: [],
          ledgerEntries: [],
          balance: { currentMinutes: 960, scheduledMinutes: 0, availableMinutes: 960 },
          coverage: { leaveRequestId: 'request-9', coveredShifts: [], totalOverlapMinutes: 0 },
          actions: {
            canApprove: !decided,
            canReject: !decided,
            canAmend: decided,
            canCancel: false,
          },
        }),
      );
    }
    if (url.pathname === '/leave/requests/request-9/approve' && method === 'POST') {
      decided = true;
      return route.fulfill(
        json({ requestId: 'request-9', status: 'APPROVED', approvedMinutes: 480 }, 201),
      );
    }
    return route.fulfill(json({ message: 'Not mocked' }, 404));
  });
});

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('employee previews backend sizing and submits leave', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'My Leave', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Leave', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vacation' })).toBeVisible();
  await page.getByLabel('Start date').fill('2027-03-08');
  await page.getByLabel('End date').fill('2027-03-09');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('Founders Day', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Submit 8h' }).click();
  await expect(page.getByText('Leave requested.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw' })).toBeVisible();
  // Batch 3B: no serious or critical accessibility violations on the final page.
  await expectNoSeriousA11yViolations(page);
});

test('scoped approver reviews and approves a pending request', async ({ page }) => {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Requests', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Leave operations' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Holidays' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByText('No published shifts overlap this leave.')).toBeVisible();
  await page.getByRole('button', { name: 'Approve…' }).click();
  await page.getByRole('button', { name: 'Confirm approval' }).click();
  await expect(page.getByText('Leave approved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Shorten or cancel…' })).toBeVisible();
});
