import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';
import {
  MANAGER_PERMISSIONS,
  ORG,
  ORG2,
  SCHEDULING_PERMISSIONS,
  VIEWPORTS,
  checkAt,
  json,
  mockManager,
  mockMyTime,
  mockScheduling,
  noHorizontalScroll,
  path,
  session,
} from './support/workforce-mocks';

/**
 * Batch 4F — final hardening against a mocked API: the kiosk's explicit occurrence choice and
 * accessible screens (idle warning, 320px PIN), capped lists that say so, the read-only history
 * of organizations with Time & attendance turned off (My Time and the manager screens), the
 * scheduled-vs-actual view, linking an entry to a shift, the PIN section answering 404, capped
 * report runs and CSV files, and axe checks of the scheduling pages at desktop, tablet and phone
 * widths. Screenshots (deviceScaleFactor 2) when BATCH_4F_SCREENSHOTS_DIR is set.
 */

const SHOTS = process.env.BATCH_4F_SCREENSHOTS_DIR;
test.use({ deviceScaleFactor: SHOTS ? 2 : 1 });

async function screenshot(page: Page, name: string, fullPage = true) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage });
}

// ─── Kiosk ───────────────────────────────────────────────────────────────────

test('kiosk: one button per open occurrence, the chosen one is sent; screens pass axe', async ({
  page,
}) => {
  const actions: Array<Record<string, unknown>> = [];
  await page.clock.install();
  await page.route(`${API}/kiosk/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/kiosk/session') {
      return json(route, {
        device: { id: 'device-1', name: 'Front desk' },
        location: { name: 'Main building', timezone: 'America/Toronto' },
        organization: { name: 'Northwind Academy' },
        interactionSeconds: 90,
      });
    }
    if (pathname === '/kiosk/identify') {
      return json(
        route,
        {
          token: 'token-1',
          expiresInSeconds: 90,
          employee: { firstName: 'Grace' },
          state: 'OFF_CLOCK',
          actions: [
            {
              action: 'SIGN_IN',
              employmentAssignmentId: 'assignment-2',
              scheduledShiftId: 'shift-a',
              label: 'Sign in — Instructor · 1:00 PM – 1:30 PM',
            },
            {
              action: 'SIGN_IN',
              employmentAssignmentId: 'assignment-2',
              scheduledShiftId: 'shift-b',
              label: 'Sign in — Instructor · 1:45 PM – 2:15 PM',
            },
          ],
        },
        201,
      );
    }
    if (pathname === '/kiosk/actions') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      actions.push(body);
      return json(
        route,
        {
          action: 'SIGN_IN',
          outcome: 'SIGNED_IN',
          occurredAt: '2026-11-03T18:46:00.000Z',
          timezone: 'America/Toronto',
        },
        201,
      );
    }
    if (pathname === '/kiosk/cancel') return json(route, { cancelled: true }, 201);
    return json(route, {}, 404);
  });

  await page.goto('/kiosk');
  await expect(page.getByRole('button', { name: 'Tap to start' })).toBeVisible();
  await checkAt(page);

  await page.getByRole('button', { name: 'Tap to start' }).click();
  await page.getByLabel('Employee number').fill('e-200');
  await checkAt(page);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  for (const digit of '582') await page.getByRole('button', { name: digit, exact: true }).click();
  await checkAt(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await noHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, 'kiosk-pin-320px');
  await page.setViewportSize(VIEWPORTS.desktop);
  for (const digit of '914') await page.getByRole('button', { name: digit, exact: true }).click();

  // Two occurrences open: one button each, named by the server's label.
  const first = page.getByRole('button', { name: 'Sign in — Instructor · 1:00 PM – 1:30 PM' });
  const second = page.getByRole('button', { name: 'Sign in — Instructor · 1:45 PM – 2:15 PM' });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await checkAt(page);
  await page.setViewportSize(VIEWPORTS.phone);
  await screenshot(page, 'kiosk-occurrence-choice-phone');

  // The idle warning, before the reset.
  await page.clock.fastForward(21_000);
  const warning = page.getByRole('alertdialog', { name: 'Still there?' });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole('button', { name: 'Continue' })).toBeFocused();
  await checkAt(page, ['phone', 'desktop']);
  await page.setViewportSize(VIEWPORTS.phone);
  await screenshot(page, 'kiosk-idle-warning');
  await page.setViewportSize(VIEWPORTS.desktop);
  await warning.getByRole('button', { name: 'Continue' }).click();
  await expect(warning).toBeHidden();

  await second.click();
  await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible();
  expect(actions).toEqual([
    expect.objectContaining({
      token: 'token-1',
      action: 'SIGN_IN',
      employmentAssignmentId: 'assignment-2',
      scheduledShiftId: 'shift-b',
    }),
  ]);
});

// ─── My Time and My Schedule ────────────────────────────────────────────────

test('My Time: read-only history of an organization with attendance off, capped lists warned', async ({
  page,
}) => {
  await session(page, ['time.clock'], { isEmployee: true });
  await mockMyTime(page);
  await page.goto('/time');

  // Today: the capped expected attendance says so.
  const shifts = page.getByRole('heading', { name: 'Today’s shifts' }).locator('..');
  await expect(
    shifts.getByText('Showing the first 1,000 records. Narrow the date range to see the rest.'),
  ).toBeVisible();
  await screenshot(page, 'truncation-warning-my-time');

  await page.getByRole('tab', { name: 'History' }).click();
  const region = page.getByRole('region', { name: 'Attendance history' });
  const off = region.getByRole('row', { name: /10\/23\/2026/ });
  await expect(off).toContainText('Attendance turned off — read only');
  await expect(off.getByRole('button')).toHaveCount(0);
  const on = region.getByRole('row', { name: /10\/24\/2026/ });
  await expect(on.getByRole('button', { name: /Request a correction/ })).toBeVisible();
  await checkAt(page);
  await screenshot(page, 'my-time-read-only-badge');

  // My Schedule: the capped attendance is never presented as complete.
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'My Schedule' })
    .click();
  await expect(page.getByRole('heading', { name: 'My schedule' })).toBeVisible();
  // A shift of an organization with attendance off: read only, nothing to record.
  const harborShift = page.getByRole('listitem').filter({ hasText: 'Harbor School' });
  await expect(harborShift).toContainText('Attendance turned off — read only');
  await expect(harborShift.getByRole('link')).toHaveCount(0);
  await expect(
    page.getByText('Showing the first 1,000 records. Narrow the date range to see the rest.'),
  ).toBeVisible();
  await checkAt(page);
});

test('My Time: everything turned off shows a calm notice and keeps the history', async ({
  page,
}) => {
  await session(page, ['time.clock'], { isEmployee: true });
  await mockMyTime(page);
  await page.route(path('/time/me/status'), (route) =>
    json(
      route,
      { statusCode: 403, code: 'FEATURE_DISABLED', module: 'ATTENDANCE', message: 'Disabled' },
      403,
    ),
  );
  await page.goto('/time');
  await expect(
    page.getByText('Time & attendance is turned off for your organization.'),
  ).toBeVisible();
  // (The empty alert is Next's route announcer.)
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('region', { name: 'Attendance history' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

// ─── Manager time operations ────────────────────────────────────────────────

const section = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Time operations sections' }).getByRole('tab', { name });

test('manager: records, corrections and scheduled vs actual (load more) pass axe', async ({
  page,
}) => {
  await session(page, MANAGER_PERMISSIONS);
  const world = await mockManager(page);
  await page.goto('/admin/time');
  await expect(page.getByRole('heading', { name: 'Time operations' })).toBeVisible();

  await section(page, 'Records').click();
  await expect(page.getByRole('region', { name: 'Attendance records' })).toBeVisible();
  await checkAt(page);

  await section(page, 'Corrections').click();
  await expect(page.getByText('Stayed for the parent meeting')).toBeVisible();
  await checkAt(page);

  await section(page, 'Scheduled vs actual').click();
  const table = page.getByRole('region', { name: 'Scheduled vs actual' });
  await expect(table.getByRole('row', { name: /Alan Turing/ })).toContainText('-10h');
  await expect(table.getByRole('row', { name: /Ada Lovelace/ })).toContainText('not included');
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(table.getByRole('row', { name: /Grace Hopper/ })).toContainText('+30m');
  const calls = world.requests.filter((request) =>
    request.path.startsWith('/time/manage/scheduled-vs-actual'),
  );
  expect(new URL(`http://x${calls.at(-1)!.path}`).searchParams.get('afterKey')).toBe(
    '2026-10-20|assignment-Alan Turing',
  );
  await expect(page.getByText(/Showing 3 rows\./)).toBeVisible();
  await checkAt(page);
  await screenshot(page, 'scheduled-vs-actual-desktop');
  await page.setViewportSize(VIEWPORTS.phone);
  await screenshot(page, 'scheduled-vs-actual-phone');
  await page.setViewportSize(VIEWPORTS.desktop);

  // More than 31 days: explained, nothing requested.
  const before = world.requests.length;
  await page.getByLabel('To').fill('2026-12-31');
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toContainText(
    'Choose at most 31 days',
  );
  expect(
    world.requests
      .slice(before)
      .filter((request) => request.path.startsWith('/time/manage/scheduled-vs-actual')),
  ).toEqual([]);
});

test('manager: link-shift dialog requires a reason, shows API errors, then saves', async ({
  page,
}) => {
  await session(page, MANAGER_PERMISSIONS);
  const world = await mockManager(page);
  await page.goto('/admin/time');
  await section(page, 'Timesheets').click();
  await page.getByRole('button', { name: 'Review timesheet of Ada Lovelace' }).click();
  const daily = page.getByRole('region', { name: 'Daily time' });
  const change = daily.getByRole('button', { name: /^Change shift link for the 10\/20\/2026/ });
  await expect(
    daily.getByRole('button', { name: /^Link shift for the 10\/21\/2026/ }),
  ).toBeVisible();
  await change.click();

  const dialog = page.getByRole('dialog', { name: 'Change shift link' });
  await expect(dialog).toBeVisible();
  const save = dialog.getByRole('button', { name: 'Save shift link' });
  await dialog.getByRole('radio', { name: /current link/ }).check();
  await expect(save).toBeDisabled();
  await checkAt(page);
  await screenshot(page, 'link-shift-dialog', false);

  // Unlink: reason required, then an API refusal is shown in the dialog.
  await dialog.getByRole('radio', { name: 'Unlink: no scheduled shift' }).check();
  await dialog.getByLabel('Reason').fill('Worked an unscheduled block');
  await dialog.getByRole('button', { name: 'Unlink shift' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'That time is in an approved or locked timesheet.',
  );
  // Then a re-link to the other shift succeeds and is announced.
  await dialog.getByRole('radio', { name: /^Oct 20, 2026, 1:00 PM/ }).check();
  await save.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Shift link updated.')).toBeVisible();
  const posts = world.requests.filter((request) => request.method === 'POST');
  expect(posts.map((request) => request.body)).toEqual([
    { scheduledShiftId: null, reason: 'Worked an unscheduled block' },
    { scheduledShiftId: 'shift-2', reason: 'Worked an unscheduled block' },
  ]);
  // Focus returns to the row action that opened the dialog.
  await expect(change).toBeFocused();
});

test('manager: attendance sign-ins and expected sign-ins warn when capped', async ({ page }) => {
  await session(page, MANAGER_PERMISSIONS);
  await mockManager(page);
  await page.goto('/admin/time');
  await section(page, 'Attendance').click();
  await page.getByRole('tab', { name: 'Sign-ins', exact: true }).click();
  await expect(
    page.getByText('Showing the first 1,000 records. Narrow the date range to see the rest.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Record sign-out Ada Lovelace,/ })).toBeVisible();
  await checkAt(page);
  await screenshot(page, 'truncation-warning-sign-ins');
  await page.getByRole('tab', { name: 'Expected sign-ins' }).click();
  await expect(
    page.getByText('Showing the first 2,000 records. Narrow the date range to see the rest.'),
  ).toBeVisible();
  await checkAt(page);
});

test('manager: history of an organization with attendance off is opt-in and read only', async ({
  page,
}) => {
  await session(page, MANAGER_PERMISSIONS);
  const world = await mockManager(page);
  await page.goto('/admin/time');
  const toggle = page.getByRole('checkbox', {
    name: 'Include organizations with attendance turned off (read only)',
  });
  await expect(page.getByRole('combobox', { name: 'Organization' })).toHaveCount(0);
  await toggle.check();
  const picker = page.getByRole('combobox', { name: 'Organization' });
  await expect(
    picker.getByRole('option', { name: 'Harbor School (turned off — read only)' }),
  ).toHaveCount(1);
  await picker.selectOption(ORG2);
  await expect(page.getByText('Time & attendance is turned off for Harbor School.')).toBeVisible();

  await section(page, 'Records').click();
  await expect(page.getByRole('region', { name: 'Attendance records' })).toContainText(
    'Instructor',
  );
  await checkAt(page);
  await screenshot(page, 'manager-history-toggle-on');
  await section(page, 'Corrections').click();
  await expect(page.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  await section(page, 'Timesheets').click();
  // Periods of the organization come from /time/periods with the flag, marked read only.
  const periods = page.getByRole('region', { name: 'Time periods' });
  const harborRow = periods.getByRole('row', { name: /09\/14\/2026/ });
  await expect(harborRow).toContainText('Attendance turned off — read only');
  await expect(harborRow.getByRole('button', { name: /Create timesheets/ })).toHaveCount(0);
  await harborRow.getByRole('button', { name: /^Open period/ }).click();
  await expect(
    page.getByRole('button', { name: /^Review timesheet of Ada Lovelace/ }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // Attendance administration: the sign-in history only, without actions.
  await section(page, 'Attendance').click();
  await page.getByRole('combobox', { name: 'Organization' }).selectOption(ORG2);
  await expect(page.getByRole('tablist', { name: 'Attendance' }).getByRole('tab')).toHaveText([
    'Sign-ins',
  ]);
  await expect(page.getByRole('region', { name: 'Sign-ins' })).toContainText('Ada Lovelace');
  await expect(page.getByRole('region', { name: 'Sign-ins' }).getByRole('button')).toHaveCount(0);
  await checkAt(page);

  const harborCalls = world.requests.filter(
    (request) => request.method === 'GET' && request.path.includes(`organizationId=${ORG2}`),
  );
  expect(harborCalls.length).toBeGreaterThan(0);
  for (const call of harborCalls) expect(call.path).toContain('includeDisabledOrganizations=true');
  expect(
    world.requests.some((request) =>
      request.path.startsWith('/time/manage/organizations?includeDisabledOrganizations=true'),
    ),
  ).toBe(true);
});

// ─── PIN section ─────────────────────────────────────────────────────────────

test('the PIN section is simply not shown when the employee is not visible (404)', async ({
  page,
}) => {
  await session(page, ['employee.read', 'time.credential.manage']);
  let pinRequests = 0;
  await page.route(path('/employees/employee-1'), (route) =>
    json(route, {
      id: 'employee-1',
      employeeNumber: 'EMP-000001',
      status: 'ACTIVE',
      hireDate: '2026-09-01',
      terminationDate: null,
      person: {
        firstName: 'Grace',
        middleName: null,
        lastName: 'Hopper',
        preferredName: null,
        personalEmail: 'grace@example.com',
        phone: null,
      },
      assignments: { current: [], upcoming: [], historical: [], cancelled: [] },
    }),
  );
  await page.route(path('/employees/employee-1/capabilities'), (route) =>
    json(route, {
      employeeId: 'employee-1',
      organizationIds: [ORG],
      tabs: {
        overview: true,
        employment: true,
        compensation: false,
        time: true,
        leave: false,
        benefits: false,
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
      },
    }),
  );
  await page.route(path('/time/employees/employee-1/attendance-pin'), (route) => {
    pinRequests += 1;
    return json(route, { statusCode: 404, message: 'Employee not found.' }, 404);
  });
  await page.goto('/admin/employees/employee-1#time');
  await expect(page.getByRole('link', { name: 'Open Attendance' })).toBeVisible();
  await expect.poll(() => pinRequests).toBeGreaterThan(0);
  await expect(page.getByRole('region', { name: 'Attendance PIN' })).toHaveCount(0);
  await expect(page.getByText(/not found|Unable to load the attendance PIN/i)).toHaveCount(0);
});

// ─── Reports ─────────────────────────────────────────────────────────────────

test('a capped report run and a capped CSV export are never presented as complete', async ({
  page,
}) => {
  await session(page, ['report.read', 'report.export', 'time.view']);
  const signIns = {
    key: 'time.sign-ins',
    title: 'Attendance sign-ins',
    description: 'One row per presence sign-in in the range.',
    sourcePermissions: ['time.view'],
    organizationPermissions: [],
    dateMode: 'RANGE',
    filters: ['from', 'to', 'organizationalUnitId', 'departmentId', 'teamId', 'positionId'],
    groupBy: [],
    defaultGroupBy: null,
    sensitive: false,
    excludesSelf: false,
    columns: [
      { key: 'workDate', label: 'Work date', type: 'date' },
      { key: 'employeeName', label: 'Employee', type: 'string' },
      { key: 'position', label: 'Position', type: 'string' },
      { key: 'signedInAt', label: 'Signed in (local)', type: 'string' },
      { key: 'source', label: 'Source', type: 'string' },
    ],
    canExport: true,
  };
  await page.route(path('/reports/organizations'), (route) =>
    json(route, { items: [{ id: ORG, name: 'Northwind Academy', code: 'NWA', timezone: 'UTC' }] }),
  );
  await page.route(path('/reports/catalog'), (route) =>
    json(route, { organizationId: ORG, items: [{ area: 'time', reports: [signIns] }] }),
  );
  for (const resource of ['units', 'departments', 'teams', 'positions']) {
    await page.route(path(`/organizations/${ORG}/${resource}`), (route) =>
      json(route, { statusCode: 403, message: 'Forbidden' }, 403),
    );
  }
  await page.route(path('/reports/time.sign-ins'), (route) =>
    json(route, {
      reportKey: 'time.sign-ins',
      area: 'time',
      title: 'Attendance sign-ins',
      generatedAt: '2026-11-03T12:00:00.000Z',
      filters: Object.fromEntries(new URL(route.request().url()).searchParams),
      scopeSummary: {
        organizationId: ORG,
        placement: 'POSITION',
        organizationWide: true,
        scopes: [{ type: 'ORGANIZATION', id: ORG }],
        positions: 3,
        openings: null,
        selfExcluded: false,
      },
      columns: signIns.columns,
      rows: [
        {
          workDate: '2026-11-02',
          employeeName: 'Ada Lovelace',
          position: 'Instructor',
          signedInAt: '2026-11-02 08:05',
          source: 'KIOSK',
        },
      ],
      suppressed: 0,
      notes: ['The result was capped at 1 row; narrow the filters to see the rest.'],
      truncated: true,
    }),
  );
  await page.route(path('/reports/time.sign-ins/export.csv'), (route) =>
    route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="time.sign-ins-2026-11-03.csv"',
        'X-Report-Truncated': 'true',
        'Access-Control-Expose-Headers': 'Content-Disposition, X-Report-Truncated',
      },
      body: 'Work date,Employee\r\n2026-11-02,Ada Lovelace\r\nTRUNCATED: the export was capped at 1 rows; narrow the filters to export the rest.\r\n',
    }),
  );

  await page.goto(`/reports/time.sign-ins?organizationId=${ORG}`);
  await expect(page.getByRole('heading', { name: 'Attendance sign-ins' })).toBeVisible();
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.getByRole('table', { name: 'Attendance sign-ins' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Partial result:' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await download;
  await expect(page.getByText('The export is capped:')).toBeVisible();
  await checkAt(page);
});

// ─── Scheduling pages ────────────────────────────────────────────────────────

test('scheduling pages pass axe at desktop, tablet and phone widths', async ({ page }) => {
  await session(page, SCHEDULING_PERMISSIONS);
  await mockScheduling(page, { failTemplatesOnce: true });
  await page.goto('/admin/scheduling');
  await expect(page.getByRole('heading', { name: 'Schedules', level: 1 })).toBeVisible();
  await checkAt(page);

  const sections = page.getByRole('navigation', { name: 'Scheduling sections' });
  await sections.getByRole('link', { name: 'Templates' }).click();
  // A load failure is an error with retry, never an empty state.
  const retry = page.getByRole('button', { name: /retry|try again/i });
  await expect(retry).toBeVisible();
  await screenshot(page, 'scheduling-error-with-retry');
  await checkAt(page, ['desktop']);
  await retry.click();
  await expect(retry).toHaveCount(0);
  await checkAt(page);

  for (const name of ['Recurring patterns', 'Policies', 'Scheduled hours']) {
    await sections.getByRole('link', { name }).click();
    await expect(sections.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    await checkAt(page);
  }
});
