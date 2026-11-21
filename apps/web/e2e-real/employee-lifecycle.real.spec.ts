import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { REAL_STACK_WEB } from './support/stack';

/**
 * Real stack (Batch 5C): an HR administrator's lifecycle and organization screens against the
 * real API and database, in the seed's time zone (America/Toronto, Asia/Kolkata, …).
 *
 * The flow leaves the employee exactly as seeded (the attendance spec uses them): a termination
 * is scheduled with a future last day, shown to the reader, then cancelled; the impact of ending
 * the assignment is previewed (read-only); the access review is read without revoking anything.
 * Organization: a physical site is added and archived, another one is used by a new work
 * location and then cannot be archived.
 */

let seed: RealStackSeed;
// One HR session for the whole file: sign-ins are rate limited per address, and the attendance
// spec that follows signs in several times from the same one.
let context: BrowserContext;
let page: Page;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  seed = readSeed();
  // An explicit context: axe-core needs one (a bare browser.newPage() cannot be analyzed).
  context = await browser.newContext({ baseURL: REAL_STACK_WEB });
  page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(seed.hr.email);
  await page.getByLabel('Password').fill(seed.hr.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});
/**
 * The first visit of a route under `next dev` compiles it on demand (one cold run of the profile
 * took over 20 s). Allow for that on first loads only — and fail at once, with the page's own
 * message, when the page rendered an error instead of its heading.
 */
async function firstLoad(path: string, heading: string) {
  await page.goto(path);
  const ready = page.getByRole('heading', { name: heading, level: 1 });
  const failure = page
    .getByRole('main')
    .getByRole('alert')
    .filter({ hasText: /unable|not found|permission|error|went wrong|unavailable/i });
  await expect(ready.or(failure).first()).toBeVisible({ timeout: 60_000 });
  await expect(failure).toHaveCount(0);
  await expect(ready).toBeVisible();
}

test.afterAll(async () => {
  await context?.close();
});

/** A YYYY-MM-DD date `days` after another (calendar arithmetic, no time zone). */
function plusDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

test('HR schedules a future termination, every reader sees it, and HR cancels it (Batch 5C)', async () => {
  const lastDay = plusDays(seed.referenceDate, 45);
  await firstLoad(`/admin/employees/${seed.employeeId}#employment`, seed.employee.name);

  await page.getByRole('button', { name: 'Terminate employee' }).click();
  const dialog = page.getByRole('dialog', { name: 'Terminate employee' });
  await dialog.getByLabel('Last day of employment').fill(lastDay);
  await dialog.getByLabel(/^Reason/).fill(`Real-stack reason ${seed.suffix}`);
  // The real preview: the date is still to come in the organization's time zone.
  await expect(dialog.getByText(/Scheduled: the employee keeps working through/)).toBeVisible();
  await expect(dialog.getByText(new RegExp(`${seed.positionName}.*ends`))).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole('button', { name: 'Schedule termination' }).click();

  const banner = page.getByRole('status', { name: 'Scheduled termination' });
  await expect(banner).toContainText('Termination scheduled: last day');
  await expect(banner).not.toContainText(seed.suffix);
  // HR manages the employee, so the restricted reason is in the history.
  await expect(page.getByText(`Real-stack reason ${seed.suffix}`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Terminate employee' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);

  await banner.getByRole('button', { name: 'Cancel termination' }).click();
  await page
    .getByRole('dialog', { name: /Cancel the scheduled termination/ })
    .getByRole('button', { name: 'Cancel termination' })
    .click();
  await expect(page.getByText(/Scheduled termination cancelled/)).toBeVisible();
  await expect(page.getByRole('status', { name: 'Scheduled termination' })).toHaveCount(0);
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Terminate employee' })).toBeVisible();
});

test('HR previews the impact of ending the assignment and reads the access review (Batch 5C)', async () => {
  await page.goto(`/admin/employees/${seed.employeeId}#employment`);
  await page.getByRole('button', { name: 'Preview impact' }).click();
  const panel = page.getByRole('region', { name: `Impact preview for ${seed.positionName}` });
  await panel.getByLabel('If this assignment ended on (inclusive)').fill(seed.referenceDate);
  await expect(panel.getByText(/Impact of ending on/)).toBeVisible();
  await expect(panel.getByText(`Time zone: ${seed.timezone}`)).toBeVisible();
  // HR has no attendance, scheduling or payroll access: those sections are not shown, not empty.
  await expect(panel.getByText(/Not shown with your access: attendance, scheduling/)).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await page.getByRole('tab', { name: 'Overview' }).click();
  const review = page.getByRole('region', { name: 'Access review' });
  await expect(review.getByText('Real stack EMP')).toBeVisible();
  await expect(review.getByText('Current employment')).toBeVisible();
  // HR may revoke here (Batch 5D adds role.assign), but nothing is revoked without a selection.
  await expect(review.getByRole('button', { name: 'Revoke selected (0)' })).toBeDisabled();
});

test('HR adds and archives a physical site; a site in use by a work location cannot be archived (Batch 5C)', async () => {
  await firstLoad(`/admin/organizations/${seed.organizationId}/physical-sites`, 'Physical Sites');

  const add = async (name: string) => {
    await page.getByRole('button', { name: 'Add physical site' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add physical site' });
    await dialog.getByLabel(/^Name/).fill(name);
    await dialog.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByText(`${name} added.`)).toBeVisible();
  };
  const annex = `Annex ${seed.suffix}`;
  const main = `Main ${seed.suffix}`;
  await add(annex);
  await add(main);
  const listing = page.getByRole('list', { name: 'Physical sites' });
  await listing
    .getByRole('listitem')
    .filter({ hasText: annex })
    .getByRole('button', { name: 'Archive' })
    .click();
  await page
    .getByRole('dialog', { name: `Archive ${annex}?` })
    .getByRole('button', { name: 'Archive site' })
    .click();
  await expect(page.getByText(`${annex} archived.`)).toBeVisible();

  // A work location on the remaining site.
  await firstLoad(`/admin/organizations/${seed.organizationId}/work-locations`, 'Work Locations');
  await page.getByRole('button', { name: 'New record' }).click();
  await page.getByLabel('Name', { exact: true }).fill(`Front office ${seed.suffix}`);
  await page.getByLabel('Code', { exact: true }).fill(`FO-${seed.suffix}`);
  const picker = page.getByLabel('Physical Site');
  await expect(
    picker.locator('option', { hasText: 'Create a matching physical site' }),
  ).toHaveCount(1);
  await expect(picker.locator('option', { hasText: annex })).toHaveCount(0);
  await picker.selectOption({ label: main });
  await page.getByRole('button', { name: 'Create Work Location' }).click();
  await expect(page.getByText(`Front office ${seed.suffix}`).first()).toBeVisible();

  await page.goto(`/admin/organizations/${seed.organizationId}/physical-sites`);
  const used = page
    .getByRole('list', { name: 'Physical sites' })
    .getByRole('listitem')
    .filter({ hasText: main });
  await expect(used).toContainText('1 work location');
  await expect(used.getByRole('button', { name: 'Archive' })).toBeDisabled();
  await expect(used).toContainText('In use by 1 work location.');
  await expectNoSeriousA11yViolations(page);
});

// ─── Batch 5D: the full lifecycle on a second employee (never the attendance employee) ──────

test('HR transfers an employee, sees the compensation reminder, terminates immediately with confirmation (Batch 5D)', async () => {
  const jordan = seed.lifecycleEmployee;
  await firstLoad(`/admin/employees/${jordan.employeeId}#employment`, jordan.name);

  // Transfer, two weeks out: the impact of the day before must be reviewed first.
  await page.getByRole('button', { name: 'Transfer', exact: true }).click();
  const transfer = page.getByRole('dialog', { name: /^Transfer from/ });
  await transfer.getByRole('button', { name: new RegExp(seed.transferPositionName) }).click();
  await transfer.getByLabel('First day in the new position').fill(plusDays(seed.referenceDate, 14));
  await expect(transfer.getByText(/Impact of ending on/)).toBeVisible();
  await expect(transfer.getByRole('button', { name: 'Transfer', exact: true })).toBeDisabled();
  await transfer.getByLabel(/I reviewed the impact/).check();
  await transfer.getByRole('button', { name: 'Transfer', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Transfer recorded' })).toContainText(
    'Compensation is not copied',
  );

  // An immediate termination (yesterday in the organization's time zone): ends the current
  // assignment and cancels the planned one, after an explicit confirmation.
  await page.getByRole('button', { name: 'Terminate employee' }).click();
  const terminate = page.getByRole('dialog', { name: 'Terminate employee' });
  await terminate.getByLabel('Last day of employment').fill(plusDays(seed.referenceDate, -1));
  await expect(
    terminate.getByText(/Immediate: .* has already passed in every affected time zone/),
  ).toBeVisible();
  await expect(terminate.getByText(/cancelled \(it has not started\)/)).toBeVisible();
  await expect(terminate.getByRole('button', { name: 'Terminate now' })).toBeDisabled();
  await expectNoSeriousA11yViolations(page);
  await terminate.getByLabel(/I understand employment ends now/).check();
  await terminate.getByRole('button', { name: 'Terminate now' }).click();
  await expect(page.getByText(/Employee terminated\./)).toBeVisible();
  await expect(page.getByText(/1 role grant revoked/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rehire employee' })).toBeVisible();
});

test('the termination revoked the grant in its organization and disabled the login, then HR rehires (M3)', async () => {
  const jordan = seed.lifecycleEmployee;
  await page.goto(`/admin/employees/${jordan.employeeId}#overview`);
  const review = page.getByRole('region', { name: 'Access review' });
  // Security remediation M3: applying the termination revoked the grant (it was in the
  // terminated organization) and, with no access left, disabled the login.
  await expect(review.getByText('Revoked by termination')).toBeVisible();
  await expect(review.getByText('Real stack JORDAN')).toBeVisible();
  await expect(review.getByText(/no access remained, so the login was disabled/)).toBeVisible();
  await expect(review.getByText('Disabled', { exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: /Revoke selected/ })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);

  // Rehire from the day after the last day; access is not restored.
  await page.getByRole('button', { name: 'Rehire employee' }).click();
  const rehire = page.getByRole('dialog', { name: 'Rehire employee' });
  await expect(rehire.getByLabel('Start date')).toHaveValue(seed.referenceDate);
  await rehire.getByRole('button', { name: new RegExp(seed.transferPositionName) }).click();
  await rehire.getByLabel('Employment type').selectOption('FULL_TIME');
  await rehire.getByRole('button', { name: 'Rehire employee' }).click();
  await expect(page.getByText(/Employee rehired into the new assignment/)).toBeVisible();
  await expect(review.getByText('Disabled', { exact: true })).toBeVisible();
});
