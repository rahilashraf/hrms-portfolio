import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { REAL_STACK_WEB } from './support/stack';

/**
 * Real stack (Batch 6B): leave against the real API and database, in the seed's time zone, in
 * the seed's own leave organization (disposable data only). A leave administrator records and
 * approves leave for Taylor through the employee picker, after a preview that marks the holiday;
 * Taylor's teammate Quinn then sees Taylor as "Absent" — and nothing about the leave type — plus
 * the holiday; Rowan, in another team, does not see Taylor at all.
 */

let seed: RealStackSeed;
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  seed = readSeed();
});

const formatted = (date: string) => {
  const [year, month, day] = date.split('-');
  return `${month}/${day}/${year}`;
};

async function signedIn(browser: Browser, account: { email: string; password: string }) {
  const context = await browser.newContext({ baseURL: REAL_STACK_WEB });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return { context, page };
}

/** First loads under `next dev` compile on demand; fail at once on an error instead. */
async function firstLoad(page: Page, path: string, heading: string) {
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

test('a leave administrator records and approves leave for an employee, with a holiday-aware preview', async ({
  browser,
}) => {
  const l = seed.leave;
  const { context, page } = await signedIn(browser, l.admin);
  try {
    await firstLoad(page, '/admin/leave', 'Leave operations');
    await expect(page.getByRole('tablist', { name: 'Leave sections' })).toBeVisible();
    await page.getByRole('button', { name: 'Record leave for an employee' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record leave for an employee' });
    await dialog.getByRole('combobox', { name: /Employee — employee/ }).fill('Taylor');
    await page.getByRole('option', { name: new RegExp(l.taylor.name) }).click();
    const assignment = dialog.getByLabel('Employee — assignment');
    await expect(assignment.locator('option', { hasText: l.positionName })).toHaveCount(1);
    await assignment.selectOption({
      label: await assignment.locator('option', { hasText: l.positionName }).innerText(),
    });
    await expect(dialog.getByLabel('Leave type')).toHaveValue(/.+/);
    await dialog.getByLabel('First day').fill(l.leaveStart);
    await dialog.getByLabel('Last day').fill(l.leaveEnd);
    await dialog.getByRole('button', { name: 'Preview' }).click();
    const preview = dialog.getByRole('region', { name: 'Leave preview' });
    await expect(preview).toContainText(l.holidayName);
    await expect(preview).toContainText('over 1 day(s)');
    await expectNoSeriousA11yViolations(page);
    await dialog.getByRole('button', { name: 'Record and approve' }).click();
    await expect(page.getByText('Leave recorded and approved.')).toBeVisible();

    // The approved request is in the queue for Taylor.
    await page.getByLabel('Status').selectOption('APPROVED');
    const row = page.getByRole('row', { name: new RegExp(l.taylor.name) });
    await expect(row).toContainText(l.leaveTypeName);
    await expect(row).toContainText('Approved');
  } finally {
    await context.close();
  }
});

test('a teammate sees "Absent" only, with the holiday; another team sees nothing', async ({
  browser,
}) => {
  const l = seed.leave;
  const teammate = await signedIn(browser, l.quinn);
  try {
    await firstLoad(teammate.page, '/leave', 'Leave');
    const list = teammate.page.getByRole('list', { name: 'Absences and holidays by day' });
    await expect(list.getByText(`${l.taylor.name} — Absent`)).toHaveCount(1);
    await expect(
      list.getByRole('listitem').filter({ hasText: `${l.taylor.name} — Absent` }),
    ).toContainText(formatted(l.leaveStart));
    await expect(list.getByText(new RegExp(l.holidayName))).toBeVisible();
    await expect(list).not.toContainText(l.leaveTypeName);
    await expect(teammate.page.getByText(new RegExp(l.teamName))).toBeVisible();
    await expectNoSeriousA11yViolations(teammate.page);
  } finally {
    await teammate.context.close();
  }

  const elsewhere = await signedIn(browser, l.rowan);
  try {
    await firstLoad(elsewhere.page, '/leave', 'Leave');
    const list = elsewhere.page.getByRole('list', { name: 'Absences and holidays by day' });
    // The organization-wide holiday applies; Taylor's absence does not show in another team.
    await expect(list.getByText(new RegExp(l.holidayName))).toBeVisible();
    await expect(elsewhere.page.getByText(l.taylor.name)).toHaveCount(0);
  } finally {
    await elsewhere.context.close();
  }
});
