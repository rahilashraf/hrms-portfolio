import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 4E-3 — the employee's My Time and My Schedule against a stateful mocked API: a timed
 * employee (clock in, history with payable minutes, a correction request from a record, a
 * timesheet returned with a note and resubmitted after review), a presence employee confirming
 * one of two open sessions and signing out, and a kiosk-only employee with nothing to record
 * here. Accessibility (axe) at desktop, tablet and phone widths, no page-wide horizontal scroll,
 * keyboard use of the tabs and the review dialog. Screenshots when REVIEW_SCREENSHOTS_DIR is set.
 */

const identity = {
  id: 'user-self',
  personId: 'person-self',
  email: 'ada@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const assignment = (id: string, position: string, organization: string, orgId: string) => ({
  id,
  employmentType: 'PART_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-01',
  endDate: null,
  isPrimary: id === 'assignment-1',
  position: { id: `position-${id}`, name: position, code: position.slice(0, 3).toUpperCase() },
  jobTitle: { id: `job-${id}`, name: position, code: position.slice(0, 3).toUpperCase() },
  organization: { id: orgId, name: organization, code: organization.toUpperCase() },
  placement: null,
  workLocation: null,
});
const counsellor = assignment('assignment-1', 'Counsellor', 'Camp', 'org-1');
const teacher = assignment('assignment-2', 'Teacher', 'School', 'org-2');

const capability = (
  item: ReturnType<typeof assignment>,
  overrides: Record<string, unknown> = {},
) => ({
  employmentAssignmentId: item.id,
  position: { id: item.position.id, name: item.position.name },
  organization: { id: item.organization.id, name: item.organization.name },
  timezone: 'America/Toronto',
  attendanceEnabled: true,
  clockEnabled: true,
  canCapture: true,
  trackingMode: 'TIME_CLOCK',
  captureMode: 'SELF_SERVICE',
  selfServiceCapture: true,
  kioskLocationRule: 'ANY_IN_ORGANIZATION',
  signOutEnabled: false,
  breakMode: 'AUTO_DEDUCT',
  assignmentSwitching: false,
  correctionRequestsEnabled: true,
  missedPunchSelfResolutionEnabled: true,
  allowEarlySubmission: false,
  unavailableReason: null,
  explanation: null,
  ...overrides,
});

type Role = 'timed' | 'presence' | 'kiosk';

interface World {
  role: Role;
  clockedIn: boolean;
  signedIn: string[];
  corrections: Array<Record<string, unknown>>;
  sheetStatus: string;
  requests: Array<{ method: string; path: string; body: unknown }>;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const entry = (id: string, day: string, overrides: Record<string, unknown> = {}) => ({
  id,
  employeeId: 'employee-1',
  employeeNumber: 'E-100',
  employeeName: 'Ada Lovelace',
  employmentAssignmentId: 'assignment-1',
  assignment: counsellor,
  workDate: day,
  clockInAt: `${day}T13:00:00.000Z`,
  clockOutAt: `${day}T17:00:00.000Z`,
  timezone: 'America/Toronto',
  status: 'CLOSED',
  source: 'LIVE_CLOCK',
  grossMinutes: 240,
  paidBreakMinutes: 0,
  unpaidBreakMinutes: 0,
  breakMinutes: 0,
  netWorkedMinutes: 240,
  policyDeductionMinutes: 30,
  payableMinutes: 210,
  breaks: [],
  exceptions: [],
  corrections: [],
  ...overrides,
});

function statusOf(world: World) {
  const base = {
    serverTime: new Date().toISOString(),
    currentBreakEntry: null,
    breakStartedAt: null,
    activeExceptions: [],
    attendanceModes: [],
  };
  if (world.role === 'kiosk') {
    return {
      ...base,
      state: 'OFF_CLOCK',
      currentTimeEntry: null,
      currentAssignment: null,
      clockedInAt: null,
      eligibleAssignments: [],
      availableActions: [],
      assignmentCapabilities: [
        capability(counsellor, {
          captureMode: 'KIOSK_ONLY',
          selfServiceCapture: false,
          unavailableReason: 'KIOSK_ONLY',
          explanation:
            'Attendance for this assignment is recorded at the onsite kiosk only, with your employee number and attendance PIN.',
        }),
      ],
    };
  }
  if (world.role === 'presence') {
    const start = new Date();
    start.setUTCMinutes(0, 0, 0);
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000).toISOString();
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(start);
    const option = (id: string, from: number, to: number) => ({
      scheduledShiftId: id,
      scheduleId: 'schedule-1',
      employmentAssignmentId: 'assignment-2',
      workLocationId: null,
      workDate: day,
      startsAt: at(from),
      endsAt: at(to),
      timezone: 'America/Toronto',
      clockInOpensAt: at(from - 30),
      clockInClosesAt: at(to),
      signIn: world.signedIn.includes(id) ? { id: `sign-in-${id}`, signedInAt: at(from) } : null,
    });
    return {
      ...base,
      state: 'OFF_CLOCK',
      currentTimeEntry: null,
      currentAssignment: null,
      clockedInAt: null,
      eligibleAssignments: [],
      availableActions: ['SIGN_IN', ...(world.signedIn.length > 0 ? ['SIGN_OUT'] : [])],
      signInAssignments: [teacher],
      signOutAssignments: world.signedIn.length > 0 ? [teacher] : [],
      signInOptions: [option('session-a', 0, 45), option('session-b', 50, 95)],
      assignmentCapabilities: [
        capability(teacher, {
          trackingMode: 'SIGN_IN_ONLY',
          captureMode: 'KIOSK_OR_SELF_SERVICE',
          signOutEnabled: true,
        }),
      ],
    };
  }
  return {
    ...base,
    state: world.clockedIn ? 'CLOCKED_IN' : 'OFF_CLOCK',
    currentTimeEntry: world.clockedIn
      ? {
          id: 'entry-open',
          employmentAssignmentId: 'assignment-1',
          clockedInAt: new Date().toISOString(),
          timezone: 'America/Toronto',
          workDate: '2026-11-03',
        }
      : null,
    currentAssignment: world.clockedIn ? counsellor : null,
    clockedInAt: world.clockedIn ? new Date().toISOString() : null,
    eligibleAssignments: world.clockedIn ? [] : [counsellor],
    availableActions: world.clockedIn ? ['CLOCK_OUT'] : ['CLOCK_IN'],
    assignmentCapabilities: [
      capability(counsellor),
      capability(teacher, {
        attendanceEnabled: false,
        canCapture: false,
        unavailableReason: 'ATTENDANCE_DISABLED',
        explanation:
          'Time & attendance is switched off for this organization. Earlier records stay visible.',
      }),
    ],
  };
}

function timesheet(world: World) {
  return {
    id: 'sheet-1',
    employeeId: 'employee-1',
    timePeriodId: 'period-1',
    status: world.sheetStatus,
    submittedByUserId: 'user-self',
    submittedAt: '2026-10-26T12:00:00.000Z',
    approvedByUserId: null,
    approvedAt: null,
    lockedByUserId: null,
    lockedAt: null,
    reopenedByUserId: null,
    reopenedAt: null,
    reviewerNote: world.sheetStatus === 'CHANGES_REQUESTED' ? 'Please confirm Tuesday' : null,
    version: 1,
    totals: { netWorkedMinutes: 420 },
    period: {
      id: 'period-1',
      organizationId: 'org-1',
      startDate: '2026-10-19',
      endDate: '2026-10-25',
      status: 'CLOSED',
      cadence: 'WEEKLY',
      openedAt: null,
      closedAt: null,
      lockedAt: null,
    },
    segments: [
      {
        id: 'segment-1',
        employmentAssignmentId: 'assignment-1',
        status: world.sheetStatus === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : 'PENDING',
        reviewedByUserId: 'user-manager',
        reviewedAt: '2026-10-27T13:00:00.000Z',
        reviewerNote: 'Please confirm Tuesday',
        grossMinutes: 480,
        paidBreakMinutes: 0,
        unpaidBreakMinutes: 0,
        policyDeductionMinutes: 60,
        netWorkedMinutes: 420,
        approvedWorkedMinutes: 0,
        calculatedAt: null,
        assignment: counsellor,
      },
    ],
    events: [
      {
        id: 'event-1',
        segmentId: null,
        actorUserId: 'user-self',
        type: 'SUBMITTED',
        note: null,
        metadata: {},
        occurredAt: '2026-10-26T12:00:00.000Z',
      },
      {
        id: 'event-2',
        segmentId: 'segment-1',
        actorUserId: 'user-manager',
        type: 'CHANGES_REQUESTED',
        note: 'Please confirm Tuesday',
        metadata: {},
        occurredAt: '2026-10-27T13:00:00.000Z',
      },
    ],
    actors: { 'user-self': 'Ada Lovelace', 'user-manager': 'Maya Patel' },
  };
}

async function mockApi(page: Page, role: Role): Promise<World> {
  const world: World = {
    role,
    clockedIn: false,
    signedIn: [],
    corrections: [],
    sheetStatus: 'CHANGES_REQUESTED',
    requests: [],
  };
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route('**/auth/refresh', (route) => json(route, {}, 401));
  await page.route('**/auth/login', (route) =>
    json(route, { accessToken: 'self-token', identity }, 201),
  );
  await page.route('**/auth/me/authorization', (route) =>
    json(route, {
      userId: identity.id,
      permissions: [{ key: 'time.clock', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] }],
    }),
  );
  await page.route(`${API}/scheduling/me**`, (route) =>
    json(route, { employeeId: 'employee-1', range: { from: '', to: '' }, items: [] }),
  );
  await page.route(`${API}/time/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const body = route.request().postDataJSON() as unknown;
    world.requests.push({ method, path: `${url.pathname}${url.search}`, body });
    switch (`${method} ${url.pathname}`) {
      case 'GET /time/me/status':
        return json(route, statusOf(world));
      case 'POST /time/me/clock-in':
        world.clockedIn = true;
        return json(route, statusOf(world), 201);
      case 'GET /time/me/entries':
        return json(route, {
          items: url.searchParams.get('afterId')
            ? [entry('entry-4', '2026-10-21')]
            : [
                entry('entry-1', '2026-10-24'),
                entry('entry-2', '2026-10-23', { status: 'VOIDED', payableMinutes: null }),
                entry('entry-3', '2026-10-22', {
                  corrections: [
                    {
                      id: 'c-0',
                      type: 'CHANGE_CLOCK_OUT',
                      status: 'APPROVED',
                      requestedAt: '2026-10-23T12:00:00.000Z',
                      reviewedAt: '2026-10-23T13:00:00.000Z',
                      adjustmentId: 'a-0',
                    },
                  ],
                }),
              ],
          nextAfterId: url.searchParams.get('afterId') ? null : 'entry-3',
        });
      case 'GET /time/me/corrections':
        return json(route, { corrections: world.corrections, nextAfterId: null });
      case 'POST /time/me/corrections': {
        const input = body as Record<string, unknown>;
        world.corrections.unshift({
          id: `c-${world.corrections.length + 1}`,
          employeeId: 'employee-1',
          requestorUserId: 'user-self',
          reviewerUserId: null,
          timeEntryId: input.timeEntryId ?? null,
          breakEntryId: null,
          employmentAssignmentId: null,
          targetEmploymentAssignmentId: null,
          type: input.type,
          status: 'PENDING',
          reason: input.reason,
          reviewerNote: null,
          requestedValues: { clockOutAt: input.clockOutAt },
          currentValues: { clockOutAt: '2026-10-24T17:00:00.000Z' },
          requestedAt: new Date().toISOString(),
          reviewedAt: null,
          cancelledAt: null,
          adjustmentId: null,
          workDate: '2026-10-24',
          timezone: 'America/Toronto',
          assignment: counsellor,
          actors: {},
        });
        return json(route, world.corrections[0], 201);
      }
      case 'GET /time/me/exceptions':
        return json(route, { exceptions: [], nextAfterId: null });
      case 'GET /time/me/timesheets':
        return json(route, { timesheets: [timesheet(world)] });
      case 'GET /time/me/timesheets/sheet-1':
        return json(route, timesheet(world));
      case 'POST /time/me/timesheets/sheet-1/submit':
        world.sheetStatus = 'SUBMITTED';
        return json(route, timesheet(world), 201);
      case 'POST /time/me/sign-in': {
        const input = body as { scheduledShiftId?: string };
        if (input.scheduledShiftId) world.signedIn.push(input.scheduledShiftId);
        return json(
          route,
          {
            outcome: 'SIGNED_IN',
            signIn: { signedInAt: new Date().toISOString(), timezone: 'America/Toronto' },
            exceptions: [],
          },
          201,
        );
      }
      case 'POST /time/me/sign-out':
        world.signedIn = [];
        return json(route, { outcome: 'SIGNED_OUT', signOut: {} }, 201);
      case 'GET /time/me/sign-ins':
        return json(route, { items: [] });
      case 'GET /time/me/attendance-pin':
        return json(route, { hasPin: true });
      case 'GET /time/me/expected-attendance':
        return json(route, { from: '', to: '', items: [] });
      default:
        return json(route, { message: 'Not found' }, 404);
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

async function openMyTime(page: Page) {
  await page.getByRole('link', { name: 'My Time', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Today' })).toHaveAttribute('aria-selected', 'true');
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.REVIEW_SCREENSHOTS_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
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

test('a timed employee clocks in, reviews history, requests a correction and resubmits a returned timesheet', async ({
  page,
}) => {
  const world = await mockApi(page, 'timed');
  await signIn(page);
  await openMyTime(page);

  // Today: one timed assignment; the other organization has Attendance switched off.
  const assignments = page.getByRole('heading', { name: 'Your assignments' }).locator('..');
  await expect(assignments).toContainText('Counsellor · Camp');
  await expect(assignments).toContainText('switched off for this organization');
  await page.getByRole('button', { name: 'Clock In' }).click();
  await expect(page.getByText('Clocked in.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clock Out' })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '1-today-timed');

  // History: payable minutes, labels, paging; a keyboard-focusable table region.
  await page.getByRole('tab', { name: 'History' }).click();
  const history = page.getByRole('region', { name: 'Attendance history' });
  await expect(history.getByRole('row', { name: /10\/24\/2026/ })).toContainText('3h 30m');
  await expect(history.getByRole('row', { name: /10\/23\/2026/ })).toContainText('Voided');
  await expect(history.getByRole('row', { name: /10\/22\/2026/ })).toContainText('Corrected');
  await page.getByRole('button', { name: /Load more/ }).click();
  await expect(history.getByRole('row', { name: /10\/21\/2026/ })).toBeVisible();
  await history.focus();
  await expect(history).toBeFocused();
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '2-history');

  // A correction requested from the record.
  await history.getByRole('button', { name: /Request a correction for 10\/24\/2026/ }).click();
  await expect(page.getByRole('tab', { name: 'Requests' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const form = page.getByRole('form', { name: 'Request a correction' });
  await expect(form.getByLabel('Attendance record')).toHaveValue('entry-1');
  await form.getByLabel('Correct clock-out').fill('2026-10-24T14:30');
  await form.getByLabel('Reason').fill('Stayed for the delivery');
  await form.getByRole('button', { name: 'Request correction' }).click();
  await expect(form.getByText(/Correction requested/)).toBeVisible();
  const requests = page.getByRole('heading', { name: 'My correction requests' }).locator('..');
  await expect(requests).toContainText('Pending');
  expect(
    world.requests.find(
      (request) => request.path === '/time/me/corrections' && request.method === 'POST',
    )?.body,
  ).toEqual({
    type: 'CHANGE_CLOCK_OUT',
    reason: 'Stayed for the delivery',
    timeEntryId: 'entry-1',
    clockOutAt: '2026-10-24T14:30',
  });
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '3-requests');

  // Timesheets: returned with a note, reviewed, resubmitted with the totals seen.
  await page.getByRole('tab', { name: 'Timesheets' }).click();
  await page.getByRole('button', { name: /Open the timesheet for 10\/19\/2026/ }).click();
  await expect(page.getByText('Your manager asked for changes.')).toBeVisible();
  await expect(page.getByText('“Please confirm Tuesday”')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Daily time' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'History' }).locator('..')).toContainText(
    'Maya Patel',
  );
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '4-timesheet-changes-requested');
  await page.getByRole('button', { name: 'Review and resubmit' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Submit this timesheet?' });
  await expect(dialog).toContainText('7h');
  await dialog.getByRole('button', { name: 'Submit timesheet' }).click();
  await expect(page.getByText('Timesheet submitted.')).toBeVisible();
  expect(
    world.requests.find((request) => request.path === '/time/me/timesheets/sheet-1/submit')?.body,
  ).toEqual({ expectedNetWorkedMinutes: 420, expectedVersion: 1 });
});

test('a presence employee confirms one of two open sessions and signs out, on a phone', async ({
  page,
}) => {
  const world = await mockApi(page, 'presence');
  await signIn(page);
  await openMyTime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Presence' })).toBeVisible();
  const sessions = page.getByRole('list', { name: 'Sessions open now for Teacher' });
  await expect(sessions.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Clock/ })).toHaveCount(0);
  await sessions
    .getByRole('button', { name: /^Sign in for/ })
    .last()
    .click();
  await expect(page.getByText(/^Signed in for \d{2}:\d{2}–/)).toBeVisible();
  expect(
    (
      world.requests.find((request) => request.path === '/time/me/sign-in')?.body as {
        scheduledShiftId?: string;
      }
    ).scheduledShiftId,
  ).toBe('session-b');
  await expect(sessions.getByText(/Signed in at/)).toBeVisible();
  await noHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '5-presence-phone');
  await page.getByRole('button', { name: 'Sign out of Teacher · School' }).click();
  await expect(page.getByText('Signed out.')).toBeVisible();
});

test('a kiosk-only employee is told to use the kiosk and offered nothing to record, on a tablet', async ({
  page,
}) => {
  await mockApi(page, 'kiosk');
  await signIn(page);
  await openMyTime(page);
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(page.getByText(/recorded at the onsite kiosk only/)).toBeVisible();
  for (const name of ['Clock In', 'Clock Out', 'Sign in', 'Start Break']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('heading', { name: 'Kiosk PIN' })).toBeVisible();
  await noHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '6-kiosk-only-tablet');
});

test('keyboard: the tabs move with the arrow keys and keep a shareable URL; the review dialog traps focus', async ({
  page,
}) => {
  await mockApi(page, 'timed');
  await signIn(page);
  await openMyTime(page);
  await page.getByRole('tab', { name: 'Today' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'History' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/time\?tab=history$/);
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Requests' })).toBeFocused();

  await page.getByRole('tab', { name: 'Timesheets' }).click();
  await page.getByRole('button', { name: /Open the timesheet/ }).click();
  const submit = page.getByRole('button', { name: 'Review and resubmit' });
  await submit.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'Submit this timesheet?' });
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(submit).toBeFocused();
});
