import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { signIn } from './demo-accounts';

/**
 * Batch 11 — demo smoke: each demo account signs in with the password `pnpm demo` generated
 * (.demo/credentials.json, never committed), sees the seeded story on its main pages, and is
 * kept out of what its role and organization don't cover. Read-only: nothing is created or
 * changed, so it can run any number of times against the same demo.
 */
test.describe.configure({ mode: 'serial' });

const main = (page: Page) => page.getByRole('main');
const h1 = (page: Page, name: string | RegExp) => page.getByRole('heading', { level: 1, name });

test('owner: both organizations; System Owner administration', async ({ page }) => {
  await signIn(page, 'owner');
  await page.goto('/admin/organizations');
  await expect(main(page).getByText('Harbourline Outdoor Centre').first()).toBeVisible();
  await expect(main(page).getByText('Harbourline Studio').first()).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('HR administrator: the centre’s people, onboarding, benefits, documents and leave — not the studio', async ({
  page,
}) => {
  await signIn(page, 'hr');
  await page.goto('/admin/employees');
  await expect(main(page).getByText('Sofia Martins').first()).toBeVisible();
  // Isolation: the studio's staff are outside this role's organization.
  await expect(main(page).getByText('Arjun Mehta')).toHaveCount(0);
  await page.goto('/admin/onboarding');
  await expect(main(page).getByRole('link', { name: 'Open Marcus Bell' })).toBeVisible();
  await expect(main(page).getByRole('link', { name: 'Open Riley Oduya' })).toBeVisible();
  await page.goto('/admin/benefits');
  await expect(main(page).getByText('Extended health care').first()).toBeVisible();
  await page.goto('/admin/leave');
  await expect(main(page).getByRole('row', { name: /Sofia Martins/ })).toBeVisible();
  await page.goto('/admin/documents#expiring');
  await expect(h1(page, 'Documents & employee records')).toBeVisible();
  // Ending assignments: one overdue, one upcoming, one with a scheduled termination.
  await page.goto('/admin/employees/lifecycle');
  await expect(
    main(page)
      .getByRole('table', { name: 'Assignments past their end date' })
      .getByText('Grace Mwangi'),
  ).toBeVisible();
  const soon = main(page).getByRole('table', { name: 'Assignments ending soon' });
  await expect(soon.getByText('Marcus Bell')).toBeVisible();
  await expect(soon.getByText('Leo Brandt')).toBeVisible();
  await expect(soon.getByText('Ends with scheduled termination')).toBeVisible();
});

test('payroll administrator: finalized hourly runs and a calculated salaried run', async ({
  page,
}) => {
  await signIn(page, 'payroll');
  await page.goto('/admin/payroll?tab=runs');
  await expect(
    main(page)
      .getByText(/Finalized/)
      .first(),
  ).toBeVisible();
  await expect(
    main(page)
      .getByText(/Calculated/)
      .first(),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('manager: timesheet review and this week’s published schedule', async ({ page }) => {
  await signIn(page, 'manager');
  await page.goto('/admin/time#timesheets');
  await expect(h1(page, 'Time operations')).toBeVisible();
  await expect(main(page).getByText('Harbourline Outdoor Centre').first()).toBeVisible();
  await page.goto('/admin/scheduling');
  await expect(h1(page, 'Schedules')).toBeVisible();
});

test('employee: self-service time, schedule, leave, pay, documents, performance and notifications', async ({
  page,
}) => {
  await signIn(page, 'employee');
  await page.goto('/schedule');
  await expect(main(page).getByText('8:00 AM – 4:00 PM').first()).toBeVisible();
  await page.goto('/leave');
  await expect(
    main(page)
      .getByText(/PENDING|Pending/)
      .first(),
  ).toBeVisible();
  await page.goto('/pay');
  await expect(main(page).getByRole('table')).toBeVisible();
  await expect(main(page).getByText('Harbourline Outdoor Centre').first()).toBeVisible();
  await page.goto('/documents');
  await expect(
    main(page).getByText('Wilderness first aid certificate (sample)').first(),
  ).toBeVisible();
  await page.goto('/performance');
  await expect(main(page).getByText('Autumn season review').first()).toBeVisible();
  await page.goto('/notifications');
  await expect(main(page).getByText('Your pay statement is available').first()).toBeVisible();
  // Two eligible assignments: the clock-in form asks which one (nothing is submitted).
  await page.goto('/time');
  const clockIn = main(page).getByRole('form', { name: 'Clock in' });
  await expect(clockIn.getByLabel('Assignment').locator('option')).toHaveCount(3);
  await clockIn.getByLabel('Assignment').selectOption({ index: 1 });
  await expect(clockIn.getByText('Also covering (optional)')).toBeVisible();
  // Role boundaries: no administration.
  await page.goto('/admin/payroll');
  await expect(h1(page, 'Access denied')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('recruiter: the summer counsellor opening and its pipeline', async ({ page }) => {
  await signIn(page, 'recruiter');
  await page.goto('/admin/recruitment#openings');
  await expect(
    main(page).getByRole('row', { name: /Camp Counsellor \(summer season\)/ }),
  ).toBeVisible();
  await page.goto('/admin/recruitment#candidates');
  await expect(main(page).getByText('Riley Oduya').first()).toBeVisible();
});

test('facilities: manages the Operations department only, reads the rest of the structure', async ({
  page,
}) => {
  await signIn(page, 'facilities');
  await page.goto('/admin/organizations');
  await main(page).getByRole('link', { name: 'Harbourline Outdoor Centre' }).first().click();
  await page.waitForURL(/\/admin\/organizations\/[^/]+$/);
  await page.goto(`${new URL(page.url()).pathname}/departments`);
  const row = (name: string) => main(page).getByRole('row', { name: new RegExp(name) });
  await expect(row('Operations').getByRole('button', { name: 'Edit' })).toBeVisible();
  for (const other of ['Programs', 'Finance', 'People & Culture']) {
    await expect(row(other)).toBeVisible();
    await expect(row(other).getByRole('button', { name: 'Edit' })).toHaveCount(0);
  }
  await page.goto(`${page.url().replace(/\/departments$/, '')}/teams`);
  await expect(row('Grounds & Trails').getByRole('button', { name: 'Edit' })).toBeVisible();
  // Organization-level administration stays out of reach.
  await page.goto('/admin/payroll');
  await expect(h1(page, 'Access denied')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
});

test('studio lead: only Harbourline Studio; no payroll administration', async ({ page }) => {
  await signIn(page, 'studioLead');
  await page.goto('/admin/employees');
  await expect(main(page).getByText('Kavya Iyer').first()).toBeVisible();
  // Isolation: the centre's people are never listed.
  await expect(main(page).getByText('Sofia Martins')).toHaveCount(0);
  await expect(main(page).getByText('Harbourline Outdoor Centre')).toHaveCount(0);
  await page.goto('/admin/payroll');
  await expect(h1(page, 'Access denied')).toBeVisible();
});
