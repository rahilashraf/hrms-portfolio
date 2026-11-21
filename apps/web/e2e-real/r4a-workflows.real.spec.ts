import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { REAL_STACK_API, REAL_STACK_WEB } from './support/stack';

/**
 * Batch R4-A (Checkpoint C) — the V1 workflow-completion screens against the real API and
 * database, in the seed's own R4-A organization (its own HR administrator, time manager and
 * employees, so the other flows and their login rate limits are untouched). Nothing is mocked.
 *
 * Each account signs in once in the browser; API calls reuse that session (a refresh, which is
 * not a login).
 */

let seed: RealStackSeed;
let r4a: RealStackSeed['r4a'];

test.beforeAll(() => {
  seed = readSeed();
  r4a = seed.r4a;
});

test.describe.configure({ mode: 'serial' });

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function signIn(page: Page, account: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** The API as the signed-in browser user (its refresh cookie, not a new login). */
async function apiAs(page: Page): Promise<APIRequestContext> {
  const refreshed = await page.request.post(`${REAL_STACK_API}/auth/refresh`, {
    headers: { Origin: REAL_STACK_WEB },
  });
  expect(refreshed.ok()).toBe(true);
  const { accessToken } = (await refreshed.json()) as { accessToken: string };
  return request.newContext({
    baseURL: REAL_STACK_API,
    extraHTTPHeaders: { Origin: REAL_STACK_WEB, Authorization: `Bearer ${accessToken}` },
  });
}

test('HR: overdue and upcoming ends, a termination-owned end, and a manual end that keeps employment', async ({
  page,
}) => {
  await signIn(page, r4a.hr);
  const api = await apiAs(page);
  // Drew's termination (through the existing API) makes Drew's assignment end with it.
  const terminationDate = new Date(`${r4a.holidayDate}T00:00:00Z`);
  terminationDate.setUTCDate(terminationDate.getUTCDate() + 10);
  const terminated = await api.post(`/employees/${r4a.drew.employeeId}/terminate`, {
    data: { terminationDate: terminationDate.toISOString().slice(0, 10) },
  });
  expect(terminated.ok(), await terminated.text()).toBe(true);

  await page.goto('/admin/employees');
  await page.getByRole('link', { name: 'Ending assignments' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ending assignments' })).toBeVisible();
  const overdue = page.getByRole('table', { name: 'Assignments past their end date' });
  await expect(overdue.getByText(r4a.sam.name)).toBeVisible();
  await expect(overdue.getByText(r4a.sam.officePositionName)).toBeVisible();
  const soon = page.getByRole('table', { name: 'Assignments ending soon' });
  const drewRow = soon.getByRole('row', { name: new RegExp(escapeRegExp(r4a.drew.name)) });
  await expect(drewRow.getByText('Ends with scheduled termination')).toBeVisible();
  // No competing apply action for an end that belongs to a termination.
  await expect(soon.getByRole('button')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);

  await page
    .getByRole('button', {
      name: new RegExp(`^Review and apply end for ${escapeRegExp(r4a.sam.name)}`),
    })
    .click();
  const dialog = page.getByRole('alertdialog', { name: 'Apply this assignment end?' });
  await expect(dialog).toContainText('the employee stays employed');
  await dialog.getByRole('button', { name: 'Apply end' }).click();
  await expect(page.getByText(/employment and other assignments are unchanged/)).toBeVisible();
  await expect(page.getByText('No assignment is past its end date.')).toBeVisible();

  // The real records: Sam is still employed; only the office assignment ended.
  const sam = await (await api.get(`/employees/${r4a.sam.employeeId}`)).json();
  expect(sam.status).toBe('ACTIVE');
  const officeEnded = (
    [...sam.assignments.current, ...sam.assignments.historical] as Array<{
      status: string;
      position: { name: string };
    }>
  ).filter((a) => a.position.name === r4a.sam.officePositionName);
  expect(officeEnded.map((a) => a.status)).toEqual(['ENDED']);
  // Applying again is refused rather than repeated.
  const again = await api.get(
    `/employees/lifecycle/due?organizationId=${r4a.organizationId}&upcomingDays=30`,
  );
  expect((await again.json()).assignmentEnds).toEqual([]);

  // R4-A.2 through the API the screen uses: clear an optional field; never a legal name.
  const setPhone = await api.patch(`/employees/${r4a.sam.employeeId}`, {
    data: { phone: '+1 416 555 0134', personalEmail: 'sam.overdue@example.invalid' },
  });
  expect(setPhone.ok(), await setPhone.text()).toBe(true);
  const cleared = await api.patch(`/employees/${r4a.sam.employeeId}`, {
    data: { phone: null },
  });
  expect(cleared.ok(), await cleared.text()).toBe(true);
  const refused = await api.patch(`/employees/${r4a.sam.employeeId}`, {
    data: { lastName: null },
  });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).code).toBe('PROFILE_REQUIRED_FIELD');
  const profile = await (await api.get(`/employees/${r4a.sam.employeeId}`)).json();
  expect(profile.person.phone).toBeNull();
  expect(profile.person.lastName).toBeTruthy();
  await api.dispose();
});

test('employee: one clock-in covers two assignments, counted once; other coverage is refused', async ({
  page,
}) => {
  await signIn(page, r4a.casey);
  const api = await apiAs(page);
  await page.goto('/time');
  const form = page.getByRole('form', { name: 'Clock in' });
  await form.getByLabel('Assignment').selectOption(r4a.lifeguardAssignmentId);
  const covering = form.getByRole('group', { name: 'Also covering (optional)' });
  await covering
    .getByRole('checkbox', { name: new RegExp(escapeRegExp(r4a.coachPositionName)) })
    .check();
  await expectNoSeriousA11yViolations(page);
  await form.getByRole('button', { name: 'Clock In (2 assignments)' }).click();
  await expect(
    page.getByText('Clocked in, covering 2 assignments (time counted once).'),
  ).toBeVisible();

  const status = await (await api.get('/time/me/status')).json();
  expect(status.state).toBe('CLOCKED_IN');
  expect(
    (status.currentCoverage as Array<{ employmentAssignmentId: string }>)
      .map((c) => c.employmentAssignmentId)
      .sort(),
  ).toEqual([r4a.lifeguardAssignmentId, r4a.coachAssignmentId].sort());
  expect(status.currentTimeEntry.employmentAssignmentId).toBe(r4a.lifeguardAssignmentId);

  // Clock out; exactly one physical entry for the interval (not one per assignment).
  const out = await api.post('/time/me/clock-out');
  expect(out.ok(), await out.text()).toBe(true);
  const entries = await (await api.get('/time/me/entries')).json();
  const items = (entries.items ?? entries.entries ?? []) as Array<{
    id: string;
    clockInAt: string;
    coverage?: unknown[];
  }>;
  const live = items.filter((item) => item.clockInAt >= status.clockedInAt);
  expect(live).toHaveLength(1);

  // Covering someone else's assignment is refused (the server checks every one).
  const foreign = await api.post('/time/me/clock-in', {
    data: {
      employmentAssignmentId: r4a.lifeguardAssignmentId,
      additionalEmploymentAssignmentIds: [seed.assignmentId],
    },
  });
  expect(foreign.status()).toBeGreaterThanOrEqual(400);
  expect(foreign.status()).toBeLessThan(500);
  expect((await (await api.get('/time/me/status')).json()).state).toBe('OFF_CLOCK');

  // An employee cannot correct coverage (no time.correct, and never their own time).
  const selfCorrect = await api.post(`/time/entries/${live[0]!.id}/correct`, {
    data: {
      type: 'CHANGE_COVERAGE',
      reason: 'Self',
      additionalEmploymentAssignmentIds: [],
    },
  });
  expect([403, 404]).toContain(selfCorrect.status());

  // My Schedule: this organization's holiday, never the main organization's.
  await page.goto('/schedule');
  const holidays = page.getByRole('region', { name: 'Holidays in these two weeks' });
  await expect(holidays).toContainText(`Holiday: ${r4a.holidayName}`);
  await expect(page.getByText(r4a.otherOrganizationHolidayName)).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
  await api.dispose();
});

test('manager: corrects coverage without touching punches, and sees the changed shift', async ({
  page,
}) => {
  await signIn(page, r4a.manager);
  const api = await apiAs(page);
  const caseyEntries = async () =>
    (
      (await (
        await api.get(`/time/manage/entries?organizationId=${r4a.organizationId}&limit=100`)
      ).json()) as { items: typeof entries }
    ).items.filter((entry) => entry.employeeId === r4a.casey.employeeId);
  let entries: Array<{
    employeeId: string;
    id: string;
    clockInAt: string;
    clockOutAt: string | null;
    coverage?: Array<{ employmentAssignmentId: string; isPayrollOwner: boolean }>;
  }> = [];
  entries = await caseyEntries();
  const covered = entries.find((entry) => (entry.coverage ?? []).length > 1);
  expect(covered, 'the clock-in covering two assignments').toBeTruthy();
  const corrected = await api.post(`/time/entries/${covered!.id}/correct`, {
    data: {
      type: 'CHANGE_COVERAGE',
      reason: 'Only lifeguarding that day',
      additionalEmploymentAssignmentIds: [],
    },
  });
  expect(corrected.ok(), await corrected.text()).toBe(true);
  const after = (await caseyEntries()).find((entry) => entry.id === covered!.id)!;
  // The punches are the same; only the coverage changed.
  expect(after.clockInAt).toBe(covered!.clockInAt);
  expect(after.clockOutAt).toBe(covered!.clockOutAt);
  expect((after.coverage ?? []).filter((c) => !c.isPayrollOwner)).toEqual([]);

  // The schedule change exception: original and current shift, and the revision history.
  await page.goto('/admin/time');
  await page.getByRole('tab', { name: 'Exceptions' }).click();
  const region = page.getByRole('region', { name: 'Attendance exceptions' });
  await region
    .getByRole('button', { name: new RegExp(`^Details.*${escapeRegExp(r4a.casey.name)}`) })
    .first()
    .click();
  const change = page.getByRole('region', { name: 'Shift change' });
  await expect(change).toContainText('The shift was changed after attendance was recorded');
  await expect(change.getByText('Original shift (revision 1)')).toBeVisible();
  await expect(change.getByText('Current shift (revision 2)')).toBeVisible();
  await change.getByRole('button', { name: 'Show all revisions' }).click();
  const revisions = change.getByRole('list', { name: 'Shift revisions' });
  await expect(revisions.getByRole('listitem')).toHaveCount(2);
  await expect(revisions).toContainText('Pool opened late');
  await expectNoSeriousA11yViolations(page);

  // The manager's grid: this organization's holiday only. The grid marks holidays of the
  // schedules the reader can see in the range, so the range starts at the seeded schedule.
  const grid = await (
    await api.get(
      `/scheduling?organizationId=${r4a.organizationId}&from=${r4a.changedShift.workDate}&to=${r4a.holidayDate}`,
    )
  ).json();
  expect((grid.holidays as Array<{ name: string }>).map((h) => h.name)).toEqual([r4a.holidayName]);
  // And nothing of the main organization, which this manager does not administer.
  const otherGrid = await api.get(
    `/scheduling?organizationId=${seed.organizationId}&from=${r4a.changedShift.workDate}&to=${r4a.holidayDate}`,
  );
  if (otherGrid.ok()) expect((await otherGrid.json()).holidays ?? []).toEqual([]);
  else expect([403, 404]).toContain(otherGrid.status());

  // The lifecycle panel is not this manager's (no employee.manage): denied, and the API shows
  // nothing to act on.
  await page.goto('/admin/employees/lifecycle');
  await expect(
    page.getByText('You do not have permission to manage employee lifecycle changes.'),
  ).toBeVisible();
  const due = await (
    await api.get(`/employees/lifecycle/due?organizationId=${r4a.organizationId}`)
  ).json();
  expect(due.assignmentEnds).toEqual([]);
  expect(due.upcomingAssignmentEnds).toEqual([]);
  await api.dispose();
});
