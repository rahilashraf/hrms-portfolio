import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { REAL_STACK_API, REAL_STACK_WEB } from './support/stack';

/**
 * Real stack (Batch 4, PR 4.0): the attendance flow an organization can complete in the UI today,
 * against the real API and database. Nothing is mocked: every click goes through the real
 * guards, permissions, services, SQL constraints and audit log.
 *
 * Today's flow: clock in → clock out → the employee requests a clock-out correction → a manager
 * approves it → the employee submits the timesheet → the manager returns it for changes with a
 * note → the employee resubmits → the manager approves and locks it (Batch 4F). Batch 4 extends
 * this spec as each step gains its UI (request changes with a note, lock, exceptions).
 *
 * Batch 4C: the organization has no payroll at all. A manager first generates the ended week and
 * materializes its timesheets through the attendance-only Time routes (they have no UI yet:
 * 4E), and at the end resolves an attendance exception, which the Exceptions tab then shows.
 */

/** The API as the manager (the routes the UI doesn't offer yet), from the web origin. */
async function managerApi(): Promise<APIRequestContext> {
  const anonymous = await request.newContext({
    baseURL: REAL_STACK_API,
    extraHTTPHeaders: { Origin: REAL_STACK_WEB },
  });
  const login = await anonymous.post('/auth/login', {
    data: { email: seed.manager.email, password: seed.manager.password },
  });
  expect(login.ok()).toBe(true);
  const { accessToken } = (await login.json()) as { accessToken: string };
  await anonymous.dispose();
  return request.newContext({
    baseURL: REAL_STACK_API,
    extraHTTPHeaders: { Origin: REAL_STACK_WEB, Authorization: `Bearer ${accessToken}` },
  });
}

let seed: RealStackSeed;

test.beforeAll(() => {
  seed = readSeed();
  // Every date below comes from the seed (one reference instant in the organization's
  // timezone), never from this machine's clock or timezone. The seeded period has ended (Batch
  // 4A: timesheets are submitted once their period ends) and holds the past record; the live
  // punches the tests make fall after it, even if the run crosses midnight.
  expect(seed.pastEntry.workDate < seed.referenceDate).toBe(true);
  expect(seed.pastEntry.workDate >= seed.period.startDate).toBe(true);
  expect(seed.pastEntry.workDate <= seed.period.endDate).toBe(true);
  expect(seed.period.endDate < seed.referenceDate).toBe(true);
  expect(seed.pastEntry.correctedClockOut.startsWith(`${seed.pastEntry.workDate}T`)).toBe(true);
});

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, account: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function openMyTime(page: Page) {
  await page.getByRole('link', { name: 'My Time', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Time & Attendance' })).toBeVisible();
}

async function openTimeOperations(page: Page) {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Attendance', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Time operations' })).toBeVisible();
}

/** MM/DD/YYYY, as the time pages print a work date. */
function printedDate(isoDate: string) {
  const [year, month, day] = isoDate.split('-');
  return `${month}/${day}/${year}`;
}

test('a manager creates the ended week and its timesheets without payroll (Batch 4C API)', async () => {
  const api = await managerApi();
  const generated = await api.post('/time/periods/generate', {
    data: {
      organizationId: seed.organizationId,
      startDate: seed.period.startDate,
      cadence: 'WEEKLY',
    },
  });
  expect(generated.status()).toBe(201);
  const [period] = ((await generated.json()) as { periods: Array<{ id: string; endDate: string }> })
    .periods;
  expect(period!.endDate).toBe(seed.period.endDate);
  const listed = await api.get(`/time/periods?organizationId=${seed.organizationId}`);
  expect(
    ((await listed.json()) as { items: Array<{ id: string; payrollManaged: boolean }> }).items,
  ).toEqual([expect.objectContaining({ id: period!.id, payrollManaged: false })]);
  const materialize = () => api.post(`/time/periods/${period!.id}/materialize-timesheets`);
  const first = await materialize();
  expect(first.status()).toBe(201);
  expect(await first.json()).toMatchObject({ created: 1, existing: 0 });
  // Idempotent.
  expect(await (await materialize()).json()).toMatchObject({ created: 0, existing: 1 });
  await api.dispose();
});

test('employee clocks in and out, then requests a clock-out correction', async ({ page }) => {
  await signIn(page, seed.employee);
  await openMyTime(page);

  await expect(page.getByText('Off Clock')).toBeVisible();
  await page.getByRole('button', { name: 'Clock In' }).click();
  await expect(page.getByText('Clocked in.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clock Out' }).click();
  await expect(page.getByText('Off Clock')).toBeVisible();

  await expectNoSeriousA11yViolations(page);

  // Batch 4E-3: History shows yesterday's record with its payable minutes, in a table region
  // keyboard users can focus (the [4E-3] defect 4.0 pinned here: now no violations at all).
  await page.getByRole('tab', { name: 'History' }).click();
  const history = page.getByRole('region', { name: 'Attendance history' });
  const record = history.getByRole('row', {
    name: new RegExp(printedDate(seed.pastEntry.workDate)),
  });
  await expect(record).toContainText(seed.positionName);
  await history.focus();
  await expect(history).toBeFocused();
  await expectNoSeriousA11yViolations(page);

  // Yesterday's record ended at 12:00; it should have ended at 13:00. Requested from the record.
  await record.getByRole('button', { name: /Request a correction/ }).click();
  const form = page.getByRole('form', { name: 'Request a correction' });
  await expect(form.getByLabel('What to correct')).toHaveValue('CHANGE_CLOCK_OUT');
  await form.getByLabel('Correct clock-out').fill(seed.pastEntry.correctedClockOut);
  await form.getByLabel('Reason').fill('Stayed for the 12:30 delivery');
  await form.getByRole('button', { name: 'Request correction' }).click();
  await expect(form.getByText(/Correction requested/)).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'My correction requests' }).locator('..'),
  ).toContainText('Pending');
  await expectNoSeriousA11yViolations(page);
});

test('a manager approves the correction', async ({ page }) => {
  await signIn(page, seed.manager);
  await openTimeOperations(page);
  await page.getByRole('tab', { name: 'Corrections' }).click();
  await expect(page.getByRole('heading', { name: 'Correction queue' })).toBeVisible();

  // Row actions carry the row's name: "Approve <correction type> for <employee>".
  const card = page.getByRole('group', {
    name: new RegExp(`for ${escapeRegExp(seed.employee.name)}$`),
  });
  await card
    .getByRole('button', {
      name: new RegExp(`^Approve .* for ${escapeRegExp(seed.employee.name)}$`),
    })
    .first()
    .click();
  await expect(page.getByText('Correction approved.')).toBeVisible();

  await expectNoSeriousA11yViolations(page);
});

test('the employee sees the approved correction and submits the timesheet', async ({ page }) => {
  await signIn(page, seed.employee);
  await openMyTime(page);

  // Batch 4E-3: the decision, with the reviewer's name, under Requests.
  await page.getByRole('tab', { name: 'Requests' }).click();
  await expect(
    page.getByRole('heading', { name: 'My correction requests' }).locator('..'),
  ).toContainText(`Approved by ${seed.manager.name}`);

  // The timesheet: reviewed (its daily time shows the corrected record), then submitted with the
  // totals seen.
  await page.getByRole('tab', { name: 'Timesheets' }).click();
  await page
    .getByRole('button', { name: /Open the timesheet for/ })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Daily time' })).toContainText(
    printedDate(seed.pastEntry.workDate),
  );
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'Review and submit' }).click();
  await page
    .getByRole('alertdialog', { name: 'Submit this timesheet?' })
    .getByRole('button', { name: 'Submit timesheet' })
    .click();
  await expect(page.getByText('Timesheet submitted.')).toBeVisible();
});

test('a manager returns the submitted timesheet for changes with a note (Batch 4F)', async ({
  page,
}) => {
  await signIn(page, seed.manager);
  await openTimeOperations(page);
  await page.getByRole('tab', { name: 'Timesheets' }).click();
  await expect(page.getByRole('heading', { name: 'Timesheet approval queue' })).toBeVisible();

  // Row actions carry the row's name: "Request changes to <assignment> of <employee>".
  await page
    .getByRole('button', {
      name: new RegExp(
        `^Request changes to .*${escapeRegExp(seed.positionName)}.* of ${escapeRegExp(seed.employee.name)}$`,
      ),
    })
    .first()
    .click();
  const dialog = page.getByRole('alertdialog', { name: 'Return for changes?' });
  await dialog.getByLabel('What needs to change').fill('Add the delivery break');
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole('button', { name: 'Request changes' }).click();
  await expect(page.getByText('Changes requested.')).toBeVisible();
});

test('the employee reads the note and resubmits the timesheet (Batch 4F)', async ({ page }) => {
  await signIn(page, seed.employee);
  await openMyTime(page);
  await page.getByRole('tab', { name: 'Timesheets' }).click();
  await page
    .getByRole('button', { name: /Open the timesheet for/ })
    .first()
    .click();
  await expect(page.getByText('Your manager asked for changes.')).toBeVisible();
  await expect(page.getByText('“Add the delivery break”')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'Review and resubmit' }).click();
  await page
    .getByRole('alertdialog', { name: 'Submit this timesheet?' })
    .getByRole('button', { name: 'Submit timesheet' })
    .click();
  await expect(page.getByText('Timesheet submitted.')).toBeVisible();
});

test('a manager resolves an attendance exception with a note, and the queue shows it (Batch 4C)', async ({
  page,
}) => {
  const api = await managerApi();
  const resolved = await api.post(`/time/exceptions/${seed.exceptionId}/resolve`, {
    data: { note: 'Discussed with the employee: transit delay' },
  });
  expect(resolved.status()).toBe(200);
  expect(await resolved.json()).toMatchObject({
    status: 'RESOLVED',
    resolutionNote: 'Discussed with the employee: transit delay',
  });
  // A second decision on the same exception is refused.
  expect(
    (
      await api.post(`/time/exceptions/${seed.exceptionId}/dismiss`, {
        data: { note: 'Changed my mind' },
      })
    ).status(),
  ).toBe(409);
  await api.dispose();

  await signIn(page, seed.manager);
  await openTimeOperations(page);
  // Batch 4F (same session: the login rate limit allows no extra manager sign-in): the
  // resubmitted timesheet is approved, then locked below.
  await page.getByRole('tab', { name: 'Timesheets' }).click();
  await expect(page.getByRole('heading', { name: 'Timesheet approval queue' })).toBeVisible();
  await page
    .getByRole('button', {
      name: new RegExp(
        `^Approve .*${escapeRegExp(seed.positionName)}.* of ${escapeRegExp(seed.employee.name)}$`,
      ),
    })
    .first()
    .click();
  await expect(page.getByText('Timesheet segment approved.')).toBeVisible();

  await page.getByRole('tab', { name: 'Exceptions' }).click();
  await expect(page.getByText('Resolved').first()).toBeVisible();
  // Batch 4E-1: the exception's own row shows the manager's decision.
  await expect(
    page.getByRole('region', { name: 'Attendance exceptions' }).getByText('Manager decision'),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // Batch 4E-1 (same session: one more sign-in would meet the login rate limit). The approved
  // timesheet, found by its period, with its history; then the manager locks it.
  await page.getByRole('tab', { name: 'Timesheets', exact: true }).click();
  const dates = `${printedDate(seed.period.startDate)} – ${printedDate(seed.period.endDate)}`;
  await page.getByRole('button', { name: `Open period for ${dates}` }).click();
  await page.getByRole('button', { name: `Review timesheet of ${seed.employee.name}` }).click();

  await expect(
    page.getByRole('heading', { name: `${seed.employee.name} · ${dates}` }),
  ).toBeVisible();
  // Approved: the stored snapshot, and who did what (the employee submitted; "You" approved).
  await expect(page.getByRole('region', { name: 'Approved daily time' })).toBeVisible();
  const history = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Approval history' }),
  });
  await expect(history).toContainText(seed.employee.name);
  await expect(history).toContainText('Timesheet approved');
  await expect(history).toContainText('You');
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await page
    .getByRole('alertdialog', { name: 'Lock this timesheet?' })
    .getByRole('button', { name: 'Lock timesheet' })
    .click();
  await expect(page.getByText('Timesheet locked.')).toBeVisible();
  await expect(page.getByText('Locked', { exact: true }).first()).toBeVisible();

  // Batch 4E-2 (same session). The manager replaces the organization policy from a week ahead
  // (breaks become an automatic deduction, which warns first); the earlier layer ends the day
  // before, and the assignment's effective policy on that date shows where breaks now come from.
  const replaceFrom = shiftIsoDate(seed.referenceDate, 7);
  await page.getByRole('tab', { name: 'Attendance', exact: true }).click();
  await page.getByRole('tab', { name: 'Attendance policies' }).click();
  await page
    .getByRole('button', { name: `Change from a date for ${seed.organizationName}` })
    .click();
  const editor = page.getByRole('form', { name: 'Change policy from a date' });
  await editor.getByLabel('Replace from').fill(replaceFrom);
  // What blank settings inherit on that date, from the API's resolution.
  await expect(
    editor.getByText(`as broader policies stand on ${printedDate(replaceFrom)}`, { exact: false }),
  ).toBeVisible();
  const breaks = editor.getByRole('group', { name: 'Breaks and automatic deduction' });
  await breaks.getByLabel('Breaks', { exact: true }).selectOption('AUTO_DEDUCT');
  await breaks.getByLabel('Deduction (minutes)').fill('30');
  await editor.getByRole('button', { name: 'Replace policy' }).click();
  await page
    .getByRole('alertdialog', { name: 'Save these policy changes?' })
    .getByRole('button', { name: 'Save policy' })
    .click();
  await expect(page.getByText(`Policy replaced from ${printedDate(replaceFrom)}`)).toBeVisible();

  await page.getByRole('tab', { name: 'Assignment attendance' }).click();
  await page.getByLabel('Employee name, number or position').fill(seed.positionName);
  await page.getByLabel('On', { exact: true }).fill(replaceFrom);
  await page
    .getByRole('region', { name: 'Assignment attendance' })
    .getByRole('button', {
      name: new RegExp(`Inspect the effective policy of .*${seed.positionName}`),
    })
    .click();
  const effectiveBreaks = page.getByRole('region', {
    name: 'Breaks and automatic deduction: effective settings',
  });
  const breaksRow = effectiveBreaks.getByRole('row', { name: /^Breaks/ });
  await expect(breaksRow).toContainText('Automatic unpaid deduction');
  await expect(breaksRow).toContainText(`Inherited from ${seed.organizationName} (Organization)`);
  await expect(page.getByText(`${printedDate(replaceFrom)} – open-ended`)).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

/** An ISO date shifted by whole days (calendar arithmetic, no timezone). */
function shiftIsoDate(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A literal string inside a RegExp (names may hold regex characters). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
