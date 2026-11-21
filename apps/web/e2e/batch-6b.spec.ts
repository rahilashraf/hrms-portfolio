import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 6B — leave management completion against a stateful mocked API: an HR administrator opens
 * Leave from an employee profile link (employee preselected), records leave for that employee
 * with a preview (holiday marked) and approves it, pages the queue, edits a leave type, checks
 * which policy applies; an employee reads their team calendar ("Absent" only) and holidays. axe
 * (serious/critical) and no page-wide horizontal scroll at desktop, tablet and a 375 px phone.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const path = (pathname: string) => (url: URL) => url.origin === API && url.pathname === pathname;

async function session(page: Page, permissions: string[], isEmployee: boolean) {
  const identity = {
    id: 'user-hr',
    personId: 'person-hr',
    email: 'hr@example.com',
    status: 'ACTIVE',
    emailVerifiedAt: null,
    mustChangePassword: false,
  };
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '6b-token' }));
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
          enabledModules: ['LEAVE'],
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

const vacation = {
  id: 'type-vac',
  organizationId: ORG,
  code: 'VAC',
  name: 'Vacation',
  description: null,
  classification: 'PAID',
  tracksBalance: true,
  displayUnit: 'HOURS',
  archivedAt: null,
  actions: { canEdit: true, canArchive: false },
};
const grace = { id: 'emp-2', employeeNumber: 'E-2', displayName: 'Grace Hopper' };
const day = (date: string, minutes: number, holidayName: string | null = null) => ({
  date,
  minutes,
  amountSource: holidayName ? 'HOLIDAY_EXCLUDED' : 'STANDARD_DAY',
  windowStart: `${date}T13:00:00.000Z`,
  windowEnd: `${date}T21:00:00.000Z`,
  absenceStart: `${date}T05:00:00.000Z`,
  absenceEnd: `${date}T05:00:00.000Z`,
  scheduledShiftRevisionIds: [],
  holidayName,
  overrideReason: null,
  cancelled: false,
});
const request = (id: string, status: string) => ({
  id,
  status,
  employee: grace,
  employmentAssignmentId: 'asg-2',
  positionName: 'Director',
  leaveType: vacation,
  startDate: '2027-03-08',
  endDate: '2027-03-09',
  startLocalTime: null,
  endLocalTime: null,
  timezone: 'America/Toronto',
  requestedMinutes: 480,
  approvedMinutes: status === 'APPROVED' ? 480 : null,
  activeMinutes: status === 'APPROVED' ? 480 : null,
  cancelledDayCount: 0,
  submittedAt: '2027-03-01T12:00:00.000Z',
  actions: { canApprove: status === 'PENDING', canReject: status === 'PENDING', canAmend: false },
});

function leaveServer() {
  const state = {
    recorded: null as null | Record<string, unknown>,
    queueCalls: [] as Array<Record<string, string>>,
    typeUpdate: null as null | Record<string, unknown>,
    resolved: null as null | Record<string, string>,
  };
  return {
    state,
    async install(page: Page) {
      await page.route(path('/leave/organizations'), (route) =>
        json(route, {
          items: [
            {
              id: ORG,
              name: 'Northwind Academy',
              timezone: 'America/Toronto',
              actions: {
                canReadRequests: true,
                canApprove: true,
                canViewBalances: true,
                canAdjust: false,
                canReadConfiguration: true,
                canManageTypes: true,
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
      await page.route(path('/leave/types'), (route) =>
        json(route, {
          items: [state.typeUpdate ? { ...vacation, ...state.typeUpdate } : vacation],
        }),
      );
      await page.route(path('/leave/types/type-vac'), (route, req) => {
        state.typeUpdate = req.postDataJSON() as Record<string, unknown>;
        return json(route, { ...vacation, ...state.typeUpdate });
      });
      await page.route(path('/leave/requests'), (route, req) => {
        if (req.method() === 'POST') {
          state.recorded = req.postDataJSON() as Record<string, unknown>;
          return json(
            route,
            { requestId: 'req-new', status: 'APPROVED', approvedMinutes: 480 },
            201,
          );
        }
        const query = Object.fromEntries(new URL(req.url()).searchParams);
        state.queueCalls.push(query);
        const recorded = state.recorded ? [request('req-new', 'APPROVED')] : [];
        if (query.afterId === 'req-a')
          return json(route, { items: [request('req-b', 'PENDING')], nextAfterId: null });
        return json(route, {
          items: [...recorded, request('req-a', 'PENDING')],
          nextAfterId: 'req-a',
        });
      });
      await page.route(path('/leave/requests/preview'), (route, req) => {
        const input = req.postDataJSON() as { startDate: string; endDate: string };
        return json(
          route,
          {
            employmentAssignmentId: 'asg-2',
            leaveType: vacation,
            timezone: 'America/Toronto',
            startDate: input.startDate,
            endDate: input.endDate,
            partial: null,
            totalMinutes: 480,
            days: [day('2027-03-08', 480), day('2027-03-09', 0, 'Founders Day')],
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
          },
          201,
        );
      });
      await page.route(path('/leave/policies'), (route) => json(route, { items: [] }));
      await page.route(path('/leave/policies/resolve'), (route, req) => {
        state.resolved = Object.fromEntries(new URL(req.url()).searchParams);
        return json(route, {
          date: state.resolved.date,
          eligible: true,
          policy: {
            id: 'pol-1',
            leaveTypeId: 'type-vac',
            organizationId: ORG,
            scopeType: 'ORGANIZATION',
            organizationalUnitId: null,
            departmentId: null,
            teamId: null,
            employmentAssignmentId: null,
            name: 'Standard vacation',
            effectiveFrom: '2026-01-01',
            effectiveTo: null,
            eligible: true,
            leaveType: vacation,
          },
        });
      });
      // The employee picker: Grace and her assignment.
      await page.route(path('/employees'), (route) =>
        json(route, {
          items: [
            {
              id: 'emp-2',
              employeeNumber: 'E-2',
              status: 'ACTIVE',
              person: {
                firstName: 'Grace',
                lastName: 'Hopper',
                middleName: null,
                preferredName: null,
              },
              displayAssignment: null,
            },
          ],
          nextAfterId: null,
        }),
      );
      await page.route(path('/employees/emp-2'), (route) =>
        json(route, {
          id: 'emp-2',
          person: { firstName: 'Grace', lastName: 'Hopper', middleName: null, preferredName: null },
          assignments: {
            current: [
              {
                id: 'asg-2',
                status: 'ACTIVE',
                isPrimary: true,
                startDate: '2026-01-01',
                position: { id: 'pos-2', name: 'Director' },
                organization: { id: ORG, name: 'Northwind Academy' },
              },
            ],
            upcoming: [],
          },
        }),
      );
      for (const resource of ['units', 'departments', 'teams', 'positions']) {
        await page.route(path(`/organizations/${ORG}/${resource}`), (route) => json(route, []));
      }
    },
  };
}

test('HR records leave for an employee from the profile link, pages the queue, edits a type and checks the policy', async ({
  page,
}) => {
  await session(
    page,
    ['leave.read', 'leave.approve', 'leave.manage_policy', 'employee.read'],
    false,
  );
  const server = leaveServer();
  await server.install(page);

  // The profile's Leave link opens Leave with the employee preselected.
  await page.goto('/admin/leave?employeeId=emp-2#requests');
  await expect(page.getByRole('heading', { name: 'Leave operations' })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Leave sections' })).toBeVisible();
  await expect.poll(() => server.state.queueCalls.at(-1)?.employeeId).toBe('emp-2');
  await expect(page.getByText('Grace Hopper').first()).toBeVisible();

  // Paging.
  await page.getByRole('button', { name: 'Load more requests' }).click();
  await expect.poll(() => server.state.queueCalls.at(-1)?.afterId).toBe('req-a');
  await expect(page.getByRole('button', { name: 'Load more requests' })).toHaveCount(0);
  await checkAt(page);

  // Record leave for Grace: preview (holiday marked), then record and approve.
  await page.getByRole('button', { name: 'Record leave for an employee' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record leave for an employee' });
  await dialog.getByLabel('Employee — assignment').selectOption('asg-2');
  await dialog.getByLabel('First day').fill('2027-03-08');
  await dialog.getByLabel('Last day').fill('2027-03-09');
  await dialog.getByRole('button', { name: 'Preview' }).click();
  const preview = dialog.getByRole('region', { name: 'Leave preview' });
  await expect(preview).toContainText('Founders Day');
  await expect(preview).toContainText('Balance after this leave');
  await checkAt(page);
  await dialog.getByRole('button', { name: 'Record and approve' }).click();
  await expect(page.getByText('Leave recorded and approved.')).toBeVisible();
  expect(server.state.recorded).toEqual({
    employmentAssignmentId: 'asg-2',
    leaveTypeId: 'type-vac',
    startDate: '2027-03-08',
    endDate: '2027-03-09',
    approve: true,
  });

  // Edit a leave type: every editable field.
  await page.getByRole('tab', { name: 'Leave types' }).click();
  await page.getByRole('button', { name: 'Edit Vacation' }).click();
  const edit = page.getByRole('form', { name: 'Edit leave type VAC' });
  await edit.getByLabel('Description').fill('Paid time away');
  await edit.getByLabel('Display unit').selectOption('DAYS');
  await checkAt(page);
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Leave type updated.')).toBeVisible();
  expect(server.state.typeUpdate).toEqual({
    name: 'Vacation',
    description: 'Paid time away',
    displayUnit: 'DAYS',
  });

  // Which policy applies?
  await page.getByRole('tab', { name: 'Policies' }).click();
  const resolver = page.getByRole('form', { name: 'Which policy applies' });
  await resolver.getByRole('combobox', { name: /Employee — employee/ }).fill('Grace');
  await page.getByRole('option', { name: /Grace Hopper/ }).click();
  await resolver.getByLabel('Employee — assignment').selectOption('asg-2');
  await resolver.getByLabel('Date', { exact: true }).fill('2027-03-08');
  await resolver.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Standard vacation' })).toBeVisible();
  expect(server.state.resolved).toEqual({
    employmentAssignmentId: 'asg-2',
    leaveTypeId: 'type-vac',
    date: '2027-03-08',
  });
  await checkAt(page);
});

test('an employee sees the team calendar as "Absent" only, with holidays', async ({ page }) => {
  await session(page, ['leave.request'], true);
  let calendarQuery: Record<string, string> | null = null;
  await page.route(path('/leave/me'), (route) =>
    json(route, { employeeId: 'emp-1', assignments: [] }),
  );
  await page.route(path('/leave/me/requests'), (route) =>
    json(route, { items: [], nextAfterId: null }),
  );
  await page.route(path('/leave/me/team-calendar'), (route, req) => {
    calendarQuery = Object.fromEntries(new URL(req.url()).searchParams);
    return json(route, {
      range: { from: calendarQuery.from, to: calendarQuery.to },
      teams: ['Kitchen team'],
      hasTeam: true,
      people: [
        {
          displayName: 'Ada Lovelace',
          self: false,
          absences: [{ date: calendarQuery.from, label: 'Absent' }],
        },
      ],
    });
  });
  await page.route(path('/leave/me/holidays'), (route, req) => {
    const from = new URL(req.url()).searchParams.get('from')!;
    return json(route, {
      items: [
        {
          date: from,
          name: 'Founders Day',
          kind: 'STATUTORY_HOLIDAY',
          organizationName: 'Northwind',
        },
      ],
    });
  });
  await page.goto('/leave');
  const list = page.getByRole('list', { name: 'Absences and holidays by day' });
  await expect(list.getByText('Ada Lovelace — Absent')).toBeVisible();
  await expect(list.getByText(/Founders Day/)).toBeVisible();
  await expect(page.getByText(/Kitchen team/)).toBeVisible();
  await expect(page.getByText(/leave types and reasons are private/)).toBeVisible();
  expect(calendarQuery).toMatchObject({ from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  await checkAt(page);
  await page.getByRole('button', { name: 'Next 4 weeks' }).click();
  await expect(list.getByText('Ada Lovelace — Absent')).toBeVisible();
});
