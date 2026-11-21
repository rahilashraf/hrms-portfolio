import { resolve } from 'node:path';
import { test, type Page } from '@playwright/test';
import { signIn } from './demo-accounts';

/**
 * Regenerates the README screenshots (docs/assets/screenshots/) from a running local demo
 * (`pnpm demo`). Synthetic Harbourline data only; it reads pages and changes nothing.
 *
 *   pnpm --filter web screenshots:demo
 *
 * Every image is 1440×900 in light mode. Each role signs in once (the API limits sign-ins).
 * Nothing is submitted: the clock-in form is filled in only as far as choosing an assignment.
 */
const OUT = resolve(__dirname, '../../../docs/assets/screenshots');

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ context }) => {
  // The Next.js dev-mode indicator is a development tool, not application UI.
  await context.addInitScript(() => {
    const hide = () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal{display:none!important}';
      document.head.appendChild(style);
    };
    if (document.head) hide();
    else document.addEventListener('DOMContentLoaded', hide);
  });
});

const main = (page: Page) => page.getByRole('main');

async function shot(page: Page, name: string, ready: string) {
  await main(page).getByText(ready).first().waitFor();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

test('HR administrator', async ({ page }) => {
  await signIn(page, 'hr');
  await page.goto('/dashboard');
  await shot(page, '01-dashboard', 'Quick actions');
  await page.goto('/admin/employees');
  await shot(page, '02-employee-directory', 'Sofia Martins');
  await page.goto('/admin/onboarding');
  await main(page).getByRole('link', { name: 'Open Marcus Bell' }).click();
  await shot(page, '08-onboarding-workflow', 'Sign the employment agreement');
  await page.goto('/admin/performance');
  await shot(page, '09-performance', 'Autumn season review');
  await page.goto('/admin/benefits');
  await shot(page, '10-benefits', 'Extended health care');
  await page.goto('/admin/documents#expiring');
  // The sample certificate expires 40 days after the demo's reference week.
  await page.getByLabel('Expiring within (days)').fill('60');
  await page.getByRole('button', { name: 'Apply' }).click();
  await shot(page, '11-documents-expiring', 'Wilderness first aid certificate');
  // Manual lifecycle (default 30-day window): an overdue secondary assignment, an upcoming one
  // and a scheduled termination, none applied (the demo keeps lifecycle automation off).
  await page.goto('/admin/employees/lifecycle');
  await main(page).getByText('Leo Brandt').waitFor();
  await shot(page, '13-lifecycle-due', 'Grace Mwangi');
});

test('Manager', async ({ page }) => {
  await signIn(page, 'manager');
  await page.goto('/admin/scheduling');
  await shot(page, '03-scheduling', 'Sofia Martins');
  await page.goto('/admin/time#records');
  await shot(page, '04-attendance-records', 'Marcus Bell');
});

test('Payroll administrator', async ({ page }) => {
  await signIn(page, 'payroll');
  await page.goto('/admin/payroll?tab=runs');
  await shot(page, '05-payroll-runs', 'Finalized');
  // Runs are listed newest first: the first hourly row is the latest finalized hourly run.
  await main(page)
    .getByRole('row', { name: /Program staff \(hourly\)/ })
    .first()
    .getByRole('link')
    .click();
  await page.getByRole('tab', { name: 'Employees' }).click();
  await shot(page, '06-payroll-run', 'Sofia Martins');
});

test('Recruiter', async ({ page }) => {
  await signIn(page, 'recruiter');
  await page.goto('/admin/recruitment#pipeline');
  await shot(page, '07-recruitment-pipeline', 'Riley Oduya');
});

test('Employee', async ({ page }) => {
  await signIn(page, 'employee');
  await page.goto('/time');
  // Two eligible assignments: choose one (not submitted) so the form shows "Also covering".
  const clockIn = main(page).getByRole('form', { name: 'Clock in' });
  await clockIn.getByLabel('Assignment').selectOption({ index: 1 });
  await clockIn.getByText('Also covering (optional)').waitFor();
  await shot(page, '12-employee-self-service', 'Today’s shifts');
});

test('Department-scoped structure manager', async ({ page }) => {
  await signIn(page, 'facilities');
  await page.goto('/admin/organizations');
  await main(page).getByRole('link', { name: 'Harbourline Outdoor Centre' }).first().click();
  await page.waitForURL(/\/admin\/organizations\/[^/]+$/);
  // Operations is editable (organization.manage on that department); the others are read-only.
  await page.goto(`${new URL(page.url()).pathname}/departments`);
  await shot(page, '14-scoped-structure', 'Operations');
});
