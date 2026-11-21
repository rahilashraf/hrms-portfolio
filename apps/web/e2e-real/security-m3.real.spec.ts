import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { disposableDatabaseUrl, REAL_STACK_WEB } from './support/stack';

/**
 * Real stack — security remediation M3 against the real API and database: an administrator
 * terminates an employee (last day yesterday, so it applies at once). The termination dialog
 * lists the employee's grant in that organization as revoked by default; applying revokes it,
 * and with no access left the login is disabled. The access review shows both.
 */

let seed: RealStackSeed;
let context: BrowserContext;
let page: Page;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  seed = readSeed();
  context = await browser.newContext({ baseURL: REAL_STACK_WEB });
  page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(seed.m3.admin.email);
  await page.getByLabel('Password').fill(seed.m3.admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});
test.afterAll(async () => {
  await context?.close();
});

function plusDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

test('terminating revokes the grant in the terminated organization and disables the login', async () => {
  const leaver = seed.m3.leaver;
  await page.goto(`/admin/employees/${leaver.employeeId}#employment`);
  await expect(page.getByRole('heading', { name: leaver.name, level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Terminate employee' }).click();
  const dialog = page.getByRole('dialog', { name: 'Terminate employee' });
  await dialog.getByLabel('Last day of employment').fill(plusDays(seed.referenceDate, -1));
  const roles = dialog.getByRole('region', { name: 'Roles and access' });
  const grant = roles.getByRole('group', { name: new RegExp(leaver.roleName) });
  await expect(grant.getByLabel('Revoke when the termination applies')).toBeChecked();
  await expect(roles).toContainText('the login will be disabled');
  await expect(roles).toContainText('A keep is a request, not an approval');
  await expectNoSeriousA11yViolations(page);
  await dialog.getByLabel(/I understand employment ends now/).check();
  await dialog.getByRole('button', { name: 'Terminate now' }).click();
  await expect(page.getByText(/Employee terminated\..*1 role grant revoked/)).toBeVisible();

  await page.goto(`/admin/employees/${leaver.employeeId}#overview`);
  const review = page.getByRole('region', { name: 'Access review' });
  await expect(review.getByText('Revoked by termination')).toBeVisible({ timeout: 30_000 });
  await expect(review.getByText(leaver.roleName)).toBeVisible();
  await expect(review.getByText(/no access remained, so the login was disabled/)).toBeVisible();
  await expect(review.getByText('Disabled', { exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

/** The worker's retained-grant reconciliation job, run once with lifecycle automation off. */
function reconcileRetainedGrants() {
  const output = execFileSync(
    'pnpm',
    ['exec', 'tsx', 'test/real-stack/lifecycle-cli.ts', 'reconcile-retained-grants'],
    {
      cwd: resolve(__dirname, '../../api'),
      env: {
        ...process.env,
        DATABASE_URL: disposableDatabaseUrl(process.env.DATABASE_URL),
        EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED: 'false',
        NODE_ENV: 'test',
        REAL_STACK_E2E: '1',
      },
      encoding: 'utf8',
    },
  );
  return JSON.parse(output.trim().split('\n').at(-1)!) as {
    handled: string[];
    failed: unknown[];
  };
}

test('decision A: with lifecycle automation off, an expired retained grant disables the login once the reconciliation job runs', async () => {
  const keeper = seed.m3.keeper;
  await page.goto(`/admin/employees/${keeper.employeeId}#overview`);
  await expect(page.getByRole('heading', { name: keeper.name, level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  const review = page.getByRole('region', { name: 'Access review' });
  // Before the job: the keep has ended, but the login is still enabled.
  await expect(review.getByText('Revoked by termination')).toBeVisible({ timeout: 30_000 });
  await expect(review.getByText('Active', { exact: true })).toBeVisible();

  const outcome = reconcileRetainedGrants();
  expect(outcome.failed).toEqual([]);
  expect(outcome.handled).toContain(keeper.employeeId);
  // Idempotent: a second run has nothing left for this employee.
  expect(reconcileRetainedGrants().handled).not.toContain(keeper.employeeId);

  await page.reload();
  await expect(review.getByText(/no access remained, so the login was disabled/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(review.getByText('Disabled', { exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  // A disabled login no longer authenticates (sessions are checked against ACTIVE logins; see
  // the database test (21)). No sign-in attempt here: the suite's per-IP login rate limit is
  // shared by every real-stack test.
});

test('final M3: applying a termination whose approved keep is no longer valid revokes the grant instead of keeping it', async () => {
  const subject = seed.m3.invalidated;
  await page.goto(`/admin/employees/${subject.employeeId}#employment`);
  await expect(page.getByRole('heading', { name: subject.name, level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  // Before applying: the panel says the approval no longer holds.
  const panel = page.getByRole('region', { name: 'Roles and access at termination' });
  await expect(panel.getByText('Approval no longer valid: not kept')).toBeVisible({
    timeout: 30_000,
  });
  await expectNoSeriousA11yViolations(page);
  await page.getByRole('button', { name: 'Apply termination' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Apply the termination now?' });
  await dialog.getByRole('button', { name: 'Apply termination' }).click();
  await expect(page.getByText(/Employee terminated\..*1 role grant revoked/)).toBeVisible();

  await page.goto(`/admin/employees/${subject.employeeId}#overview`);
  const review = page.getByRole('region', { name: 'Access review' });
  await expect(review.getByText('Revoked by termination')).toBeVisible({ timeout: 30_000 });
  await expect(review.getByText(subject.roleName)).toBeVisible();
  await expect(review.getByText(/Kept after termination/)).toHaveCount(0);
  await expect(review.getByText('Disabled', { exact: true })).toBeVisible();
});
