import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { REAL_STACK_WEB } from './support/stack';

/**
 * Real stack — security remediation M1 against the real API and database: a login-access
 * administrator of one organization cannot change the login of someone who also holds a role in
 * another organization (the reason is shown, the organization is not), and can still disable a
 * former employee whose employment ended ten days ago, but not re-enable them.
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
  await page.getByLabel('Email').fill(seed.m1.admin.email);
  await page.getByLabel('Password').fill(seed.m1.admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});
test.afterAll(async () => {
  await context?.close();
});

async function loginAccess(employeeId: string, name: string) {
  await page.goto(`/admin/employees/${employeeId}#overview`);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible({ timeout: 60_000 });
  const section = page.getByRole('region', { name: 'Login access' });
  await expect(section.getByTestId('login-status')).toBeVisible({ timeout: 30_000 });
  return section;
}

test('a login with access in another organization is not this administrator’s to change', async () => {
  const section = await loginAccess(seed.m1.outsideScope.employeeId, seed.m1.outsideScope.name);
  await expect(section.getByTestId('login-status')).toHaveText('Active');
  const unavailable = section.getByRole('list', { name: 'Unavailable login actions' });
  await expect(unavailable).toContainText('Disable login');
  await expect(unavailable).toContainText('Send password reset link');
  await expect(unavailable).toContainText(
    'This person has access outside your administrative scope.',
  );
  await expect(section.getByRole('button', { name: 'Disable login' })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Send password reset link' })).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText(seed.m1.otherOrganizationName);
  await expectNoSeriousA11yViolations(page);
});

test('a former employee (ended ten days ago) can be disabled, but not re-enabled', async () => {
  const section = await loginAccess(seed.m1.former.employeeId, seed.m1.former.name);
  await expect(section.getByRole('list', { name: 'Unavailable login actions' })).toContainText(
    'Send password reset link',
  );
  await section.getByRole('button', { name: 'Disable login' }).click();
  const form = section.getByRole('form', { name: 'Disable login' });
  await form.getByLabel('Reason (optional)').fill('Offboarding');
  await form.getByRole('button', { name: 'Disable login' }).click();
  await expect(
    section.getByText('Login access disabled. All sessions were signed out.'),
  ).toBeVisible();
  await expect(section.getByTestId('login-status')).toHaveText('Disabled');
  await expect(section.getByRole('button', { name: 'Enable login' })).toHaveCount(0);
  await expect(section.getByRole('list', { name: 'Unavailable login actions' })).toContainText(
    'Enable login: This needs a current assignment in your administrative scope.',
  );
  await expectNoSeriousA11yViolations(page);
});
