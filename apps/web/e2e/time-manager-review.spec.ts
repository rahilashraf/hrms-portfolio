import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 4E-1 — the manager attendance review at /admin/time against a stateful mocked API:
 * overview → exception (resolved with a note) → its timesheet → approval that meets a stale
 * version, reloads and then approves. Accessibility (axe) at desktop and tablet widths, keyboard
 * use, and every management request filtered to the chosen organization by the API.
 *
 * Screenshots for review are written when REVIEW_SCREENSHOTS_DIR is set.
 */

const identity = {
  id: 'manager-user',
  personId: 'person-manager',
  email: 'maya@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const permissions = [
  'time.view',
  'time.approve',
  'time.correct',
  'time.timesheet.approve',
  'time.timesheet.manage',
].map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] }));

const assignment = {
  id: 'assignment-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-01',
  endDate: null,
  isPrimary: true,
  position: { id: 'position-1', name: 'Counsellor', code: 'COUN' },
  jobTitle: { id: 'job-1', name: 'Counsellor', code: 'COUN' },
  organization: { id: 'org-1', name: 'Camp', code: 'CAMP' },
  placement: null,
  workLocation: { id: 'loc-1', name: 'Main', code: 'MAIN' },
};

const actions = {
  canViewSignIns: true,
  canCorrectSignIns: true,
  canManageDevices: false,
  canManagePolicies: false,
  canManagePins: false,
  canViewAttendance: true,
  canCorrectTime: true,
  canReviewExceptions: true,
  canReviewCorrections: true,
  canApproveTimesheets: true,
  canManageTimesheets: true,
  canManagePeriods: true,
};

const period = {
  id: 'period-1',
  organizationId: 'org-1',
  startDate: '2026-10-05',
  endDate: '2026-10-11',
  status: 'CLOSED',
  cadence: 'WEEKLY',
  openedAt: null,
  closedAt: null,
  lockedAt: null,
};

function entry(
  id: string,
  day: string,
  from: string,
  to: string,
  extra: Record<string, unknown> = {},
) {
  const gross = (Date.parse(`${day}T${to}:00Z`) - Date.parse(`${day}T${from}:00Z`)) / 60000;
  return {
    id,
    employeeId: 'employee-1',
    employeeNumber: 'E-100',
    employeeName: 'Ada Lovelace',
    employmentAssignmentId: 'assignment-1',
    assignment,
    coverage: [],
    workDate: day,
    clockInAt: `${day}T${from}:00.000Z`,
    clockOutAt: `${day}T${to}:00.000Z`,
    timezone: 'America/Toronto',
    status: 'CLOSED',
    source: 'LIVE_CLOCK',
    grossMinutes: gross,
    paidBreakMinutes: 15,
    unpaidBreakMinutes: 0,
    breakMinutes: 15,
    netWorkedMinutes: gross,
    policyDeductionMinutes: 30,
    payableMinutes: gross - 30,
    breaks: [],
    exceptions: [],
    corrections: [],
    ...extra,
  };
}

interface World {
  requests: URL[];
  approvals: Array<Record<string, unknown>>;
  version: number;
  net: number;
  sheetStatus: string;
  exceptionStatus: string;
  staleOnce: boolean;
}

function exceptions(world: World) {
  return [
    {
      id: 'exception-late',
      type: 'LATE_ARRIVAL',
      severity: 'REVIEW',
      workflowImpact: 'NON_BLOCKING',
      status: world.exceptionStatus,
      timeEntryId: 'entry-1',
      employmentAssignmentId: 'assignment-1',
      detectedAt: '2026-10-06T13:25:00.000Z',
      resolvedAt: world.exceptionStatus === 'OPEN' ? null : '2026-10-12T14:00:00.000Z',
      reason: null,
      metadata: { expectedAt: '2026-10-06T13:00:00.000Z', varianceMinutes: 25 },
      employeeId: 'employee-1',
      employeeNumber: 'E-100',
      employeeName: 'Ada Lovelace',
      workDate: '2026-10-06',
      timezone: 'America/Toronto',
      assignment,
      resolutionMethod: world.exceptionStatus === 'OPEN' ? null : 'MANAGER_RESOLUTION',
      resolvedByUserId: world.exceptionStatus === 'OPEN' ? null : 'manager-user',
      resolutionNote: world.exceptionStatus === 'OPEN' ? null : 'Bus delay',
      actors: {},
    },
    {
      id: 'exception-auto',
      type: 'MISSING_CLOCK_OUT',
      severity: 'ACTION_REQUIRED',
      workflowImpact: 'SUBMISSION_BLOCKING',
      status: 'RESOLVED',
      timeEntryId: 'entry-2',
      employmentAssignmentId: 'assignment-1',
      detectedAt: '2026-10-08T05:00:00.000Z',
      resolvedAt: '2026-10-08T06:00:00.000Z',
      reason: null,
      metadata: {},
      employeeId: 'employee-1',
      employeeNumber: 'E-100',
      employeeName: 'Ada Lovelace',
      workDate: '2026-10-07',
      timezone: 'America/Toronto',
      assignment,
      resolutionMethod: 'SYSTEM_AUTO_RESOLUTION',
      resolvedByUserId: null,
      resolutionNote: null,
      actors: {},
    },
  ];
}

function timesheet(world: World) {
  return {
    id: 'sheet-1',
    employeeId: 'employee-1',
    timePeriodId: 'period-1',
    status: world.sheetStatus,
    submittedByUserId: 'employee-user',
    submittedAt: '2026-10-12T13:00:00.000Z',
    approvedByUserId: world.sheetStatus === 'APPROVED' ? 'manager-user' : null,
    approvedAt: world.sheetStatus === 'APPROVED' ? '2026-10-12T15:00:00.000Z' : null,
    lockedByUserId: null,
    lockedAt: null,
    reopenedByUserId: null,
    reopenedAt: null,
    reviewerNote: null,
    version: world.version,
    totals:
      world.sheetStatus === 'APPROVED'
        ? {
            payrollWorkDates: [
              {
                workDate: '2026-10-06',
                employmentAssignmentId: 'assignment-1',
                grossMinutes: 540,
                paidBreakMinutes: 15,
                unpaidBreakMinutes: 0,
                policyDeductionMinutes: 30,
                approvedWorkedMinutes: 510,
              },
              {
                workDate: '2026-10-07',
                employmentAssignmentId: 'assignment-1',
                grossMinutes: world.net - 510 + 30,
                paidBreakMinutes: 15,
                unpaidBreakMinutes: 0,
                policyDeductionMinutes: 30,
                approvedWorkedMinutes: world.net - 510,
              },
            ],
          }
        : {},
    period,
    employee: { id: 'employee-1', employeeNumber: 'E-100', name: 'Ada Lovelace' },
    actors: { 'employee-user': 'Ada Lovelace', 'manager-user': 'Maya Manager' },
    segments: [
      {
        id: 'segment-1',
        employmentAssignmentId: 'assignment-1',
        status: world.sheetStatus === 'APPROVED' ? 'APPROVED' : 'PENDING',
        reviewedByUserId: world.sheetStatus === 'APPROVED' ? 'manager-user' : null,
        reviewedAt: world.sheetStatus === 'APPROVED' ? '2026-10-12T15:00:00.000Z' : null,
        reviewerNote: null,
        grossMinutes: world.net + 60,
        paidBreakMinutes: 30,
        unpaidBreakMinutes: 0,
        policyDeductionMinutes: 60,
        netWorkedMinutes: world.net,
        approvedWorkedMinutes: world.sheetStatus === 'APPROVED' ? world.net : 0,
        calculatedAt: '2026-10-12T13:00:00.000Z',
        assignment,
      },
    ],
    events: [
      {
        id: 'event-submitted',
        segmentId: null,
        actorUserId: 'employee-user',
        type: 'SUBMITTED',
        note: null,
        metadata: null,
        occurredAt: '2026-10-12T13:00:00.000Z',
      },
      ...(world.sheetStatus === 'APPROVED'
        ? [
            {
              id: 'event-approved',
              segmentId: null,
              actorUserId: 'manager-user',
              type: 'APPROVED',
              note: null,
              metadata: null,
              occurredAt: '2026-10-12T15:00:00.000Z',
            },
          ]
        : []),
    ],
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockApi(page: Page): Promise<World> {
  const world: World = {
    requests: [],
    approvals: [],
    version: 3,
    net: 960,
    sheetStatus: 'SUBMITTED',
    exceptionStatus: 'OPEN',
    staleOnce: true,
  };
  await page.route('**/auth/refresh', (route) => json(route, {}, 401));
  await page.route('**/auth/login', (route) =>
    json(route, { accessToken: 'review-token', identity }, 201),
  );
  await page.route('**/auth/me/authorization', (route) =>
    json(route, { userId: identity.id, permissions }),
  );
  await page.route(`${API}/time/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    world.requests.push(url);
    const page_ = (items: unknown[]) => json(route, { items, nextAfterId: null });
    switch (`${method} ${url.pathname}`) {
      case 'GET /time/manage/organizations':
        return json(route, {
          items: [
            {
              id: 'org-1',
              name: 'Camp',
              code: 'CAMP',
              timezone: 'America/Toronto',
              workLocations: [],
              physicalSites: [],
              actions,
            },
          ],
        });
      case 'GET /time/manage/current':
        return page_([
          {
            ...entry('entry-open', '2026-10-12', '13:00', '13:00'),
            clockOutAt: null,
            status: 'OPEN',
            grossMinutes: null,
            netWorkedMinutes: null,
            policyDeductionMinutes: null,
            payableMinutes: null,
          },
        ]);
      case 'GET /time/manage/entries':
        return page_([
          entry('entry-1', '2026-10-06', '13:25', '22:25', {
            exceptions: [
              { id: 'exception-late', type: 'LATE_ARRIVAL', status: world.exceptionStatus },
            ],
          }),
          entry('entry-2', '2026-10-07', '13:00', '21:00'),
        ]);
      case 'GET /time/manage/exceptions': {
        const status = url.searchParams.get('status');
        return page_(exceptions(world).filter((item) => !status || item.status === status));
      }
      case 'GET /time/manage/corrections':
        return page_([]);
      case 'GET /time/manage/timesheets': {
        const status = url.searchParams.get('status');
        const sheet = timesheet(world);
        return page_(!status || status === sheet.status ? [sheet] : []);
      }
      case 'GET /time/periods':
        return page_([{ ...period, payrollManaged: false, timesheetCount: 1 }]);
      case 'POST /time/exceptions/exception-late/resolve':
        world.exceptionStatus = 'RESOLVED';
        return json(route, exceptions(world)[0]);
      case 'POST /time/timesheet-segments/segment-1/approve': {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        world.approvals.push(body);
        if (world.staleOnce) {
          // Someone corrected the time meanwhile: new minutes, new version.
          world.staleOnce = false;
          world.version = 4;
          world.net = 990;
          return json(
            route,
            { statusCode: 409, code: 'TIMESHEET_SEGMENT_CHANGED', message: 'Changed' },
            409,
          );
        }
        world.sheetStatus = 'APPROVED';
        world.version = 5;
        return json(route, timesheet(world), 201);
      }
      default:
        return json(route, {}, 404);
    }
  });
  return world;
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** In-app navigation (a full reload would drop the in-memory session the mock can't refresh). */
async function openTimeOperations(page: Page) {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Attendance', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Time operations' })).toBeVisible();
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.REVIEW_SCREENSHOTS_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
}

async function noHorizontalScroll(page: Page) {
  // Polled: the shell re-renders for the new width after a resize.
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
}

test('a manager reviews an exception, opens the timesheet and approves it after a stale-version reload', async ({
  page,
}) => {
  const world = await mockApi(page);
  await signIn(page);
  await openTimeOperations(page);

  // Overview: the organization's signals and attendance.
  await expect(page.getByRole('heading', { name: 'Currently clocked in' })).toBeVisible();
  const totals = page.getByRole('region', { name: 'Attendance totals' });
  await expect(totals.getByText('Late arrivals')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '1-overview-desktop');

  // Exceptions: details, how others were closed, and a resolution with a note.
  await page.getByRole('tab', { name: 'Exceptions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Exception reporting' })).toBeVisible();
  await expect(page.getByText('Closed automatically by the system')).toBeVisible();
  await page.getByRole('button', { name: /^Details for Late Arrival/ }).click();
  await expect(page.getByText('25m')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '2-exception-details');
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Resolve this exception?' });
  await expect(dialog.getByRole('button', { name: 'Resolve exception' })).toBeDisabled();
  await dialog.getByLabel('Note').fill('Bus delay');
  await dialog.getByRole('button', { name: 'Resolve exception' }).click();
  await expect(page.getByText('Exception resolved.')).toBeVisible();
  await expect(page.getByText('Manager decision').first()).toBeVisible();

  // Its timesheet: totals, daily time with the automatic deduction, history.
  await page.getByRole('button', { name: 'Open timesheet' }).click();
  await expect(page).toHaveURL(/timesheetPeriod=period-1/);
  await expect(page.getByRole('heading', { name: /Ada Lovelace · 10\/05\/2026/ })).toBeVisible();
  const daily = page.getByRole('region', { name: 'Daily time' });
  await expect(daily.getByText('Day total')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Approval history' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '3-timesheet-detail');

  // Approve: the API says it changed meanwhile; the page reloads and explains; then it approves.
  await page.getByRole('button', { name: 'Approve Counsellor' }).click();
  // (Next.js's route announcer is an alert too.)
  await expect(
    page.getByRole('alert').filter({ hasText: 'This timesheet changed since you opened it' }),
  ).toBeVisible();
  await expect(page.getByText('Version 4')).toBeVisible();
  await page.getByRole('button', { name: 'Approve Counsellor' }).click();
  await expect(page.getByText('Timesheet segment approved.')).toBeVisible();
  await expect(page.getByText('Version 5')).toBeVisible();
  expect(world.approvals).toEqual([
    { expectedNetWorkedMinutes: 960, expectedVersion: 3 },
    { expectedNetWorkedMinutes: 990, expectedVersion: 4 },
  ]);
  // Approved: the stored snapshot and the manager actions for a finalized timesheet.
  await expect(page.getByRole('region', { name: 'Approved daily time' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lock' })).toBeVisible();
  await screenshot(page, '4-timesheet-approved');

  // Every management list was filtered to the organization by the API.
  const lists = world.requests.filter(
    (url) =>
      url.pathname.startsWith('/time/manage/') && url.pathname !== '/time/manage/organizations',
  );
  expect(lists.length).toBeGreaterThan(5);
  for (const url of lists) expect(url.searchParams.get('organizationId')).toBe('org-1');
});

test('tablet layout: no page-wide horizontal scroll, accessible tables and dialogs', async ({
  page,
}) => {
  await mockApi(page);
  await signIn(page);
  await openTimeOperations(page);
  // Tablet portrait (the collapsed sidebar is not part of this check).
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(page.getByRole('heading', { name: 'Attendance by employee and day' })).toBeVisible();
  await noHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '5-overview-tablet');

  await page.getByRole('tab', { name: 'Timesheets', exact: true }).click();
  await page.getByRole('button', { name: /^Review timesheet of Ada Lovelace/ }).click();
  await expect(page.getByRole('heading', { name: /Ada Lovelace · 10\/05\/2026/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Daily time' })).toBeVisible();
  await noHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '6-timesheet-tablet');
});

test('keyboard: sections, details and the decision dialog work without a mouse', async ({
  page,
}) => {
  await mockApi(page);
  await signIn(page);
  await openTimeOperations(page);
  const exceptionsTab = page.getByRole('tab', { name: 'Exceptions', exact: true });
  await exceptionsTab.focus();
  await page.keyboard.press('Enter');
  await expect(exceptionsTab).toHaveAttribute('aria-selected', 'true');
  const details = page.getByRole('button', { name: /^Details for Late Arrival/ });
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: /^Hide details for Late Arrival/ }),
  ).toHaveAttribute('aria-expanded', 'true');
  const resolve = page.getByRole('button', { name: 'Resolve', exact: true });
  await resolve.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'Resolve this exception?' });
  await expect(dialog).toBeVisible();
  // Focus starts on the safe choice and stays inside the dialog.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(resolve).toBeFocused();
});
