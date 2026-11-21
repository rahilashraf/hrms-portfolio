import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { disposableDatabaseUrl, REAL_STACK_WEB } from './support/stack';

/**
 * Real stack (Batch 8): event notifications against the real API, database and the worker's
 * two notification jobs (run through the API package's CLI, as the worker would), in the
 * seed's time zone. Runs after the leave and payroll flows (file order):
 *
 * - Leave: the leave administrator recorded and approved Taylor's leave (leave spec) — Taylor's
 *   inbox has the "submitted on your behalf" and "approved" notices. Taylor now requests leave
 *   themself — the leave administrator (an approver) gets "awaiting a decision"; Taylor's
 *   teammate (no approval permission) gets nothing.
 * - Payroll: the finalized run (payroll spec) — the payroll employee's inbox has "pay
 *   statement available" with dates only, no amount.
 * - Email through the development transport; the delivery log shows the deliveries and their
 *   attempts to the leave administrator (notification.delivery.read), never message text.
 * - No leak across organizations: neither employee sees the other organization's notices.
 */

let seed: RealStackSeed;
test.describe.configure({ mode: 'serial', timeout: 300_000 });
test.beforeAll(() => {
  seed = readSeed();
});

/** The worker's job, run once (publish committed events, or deliver pending email). */
function job(command: 'publish' | 'deliver') {
  const output = execFileSync(
    'pnpm',
    ['exec', 'tsx', 'test/real-stack/notifications-cli.ts', command],
    {
      cwd: resolve(__dirname, '../../api'),
      env: {
        ...process.env,
        DATABASE_URL: disposableDatabaseUrl(process.env.DATABASE_URL),
        NODE_ENV: 'test',
        REAL_STACK_E2E: '1',
      },
      encoding: 'utf8',
    },
  );
  return JSON.parse(output.trim().split('\n').at(-1)!) as Record<string, unknown>;
}

const formatted = (date: string) => {
  const [year, month, day] = date.split('-');
  return `${month}/${day}/${year}`;
};
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

async function signedIn(browser: Browser, account: { email: string; password: string }) {
  const context = await browser.newContext({ baseURL: REAL_STACK_WEB });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  // The whole real-stack run signs in many accounts from one address: the login rate limiter
  // (a real feature, left as is) may ask to wait; wait the time it states and try again.
  for (let attempt = 0; ; attempt += 1) {
    await page.getByRole('button', { name: 'Sign in' }).click();
    const limited = page.getByRole('alert').filter({ hasText: /Too many attempts/ });
    await expect
      .poll(async () => /\/dashboard$/.test(page.url()) || (await limited.isVisible()), {
        timeout: 30_000,
      })
      .toBe(true);
    if (attempt >= 3 || /\/dashboard$/.test(page.url())) break;
    const seconds = Number((await limited.innerText()).match(/(\d+) seconds/)?.[1] ?? 60);
    await page.waitForTimeout((seconds + 2) * 1_000);
  }
  await expect(page).toHaveURL(/\/dashboard$/);
  return { context, page };
}

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

const inbox = (page: Page) => page.getByRole('list', { name: 'Notifications' });

test('leave: the employee and the approver see the right notices', async ({ browser }) => {
  const l = seed.leave;
  // Taylor requests leave themself (a pending request for the approvers).
  const requestStart = addDays(l.leaveStart, 14);
  const taylor = await signedIn(browser, l.taylor);
  try {
    await firstLoad(taylor.page, '/leave', 'Leave');
    await taylor.page.getByLabel('Start date').fill(requestStart);
    await taylor.page.getByLabel('End date').fill(requestStart);
    await taylor.page.getByRole('button', { name: 'Preview' }).click();
    await taylor.page.getByRole('button', { name: /^Submit/ }).click();
    await expect(taylor.page.getByText('Leave requested.')).toBeVisible();

    const published = job('publish') as { sources: Array<{ source: string; created: number }> };
    expect(
      published.sources.find((source) => source.source === 'events.leave-request')?.created,
    ).toBeGreaterThanOrEqual(3);
    // A second run (an overlapping or restarted worker) adds nothing.
    const again = job('publish') as { sources: Array<{ created: number }> };
    expect(again.sources.every((source) => source.created === 0)).toBe(true);

    await firstLoad(taylor.page, '/notifications', 'Notifications');
    const mine = inbox(taylor.page);
    await expect(mine.getByText('Your leave was approved')).toBeVisible();
    await expect(
      mine.getByText(`Your leave from ${l.leaveStart} to ${l.leaveEnd} was approved.`),
    ).toBeVisible();
    await expect(mine.getByText('Leave request awaiting a decision')).toHaveCount(1);
    // Never the leave type; never the other organization's notices.
    await expect(mine).not.toContainText(l.leaveTypeName);
    await expect(mine).not.toContainText('pay statement');
    await expectNoSeriousA11yViolations(taylor.page);
  } finally {
    await taylor.context.close();
  }

  const admin = await signedIn(browser, l.admin);
  try {
    await firstLoad(admin.page, '/notifications', 'Notifications');
    const list = inbox(admin.page);
    await expect(
      list.getByText(
        `A leave request for ${l.taylor.name} from ${requestStart} to ${requestStart} was submitted and awaits a decision.`,
      ),
    ).toBeVisible();
    await expect(list).not.toContainText(l.leaveTypeName);
    await list
      .getByRole('link', { name: /Open Leave request awaiting a decision/ })
      .first()
      .click();
    await expect(admin.page).toHaveURL(/\/admin\/leave$/);
  } finally {
    await admin.context.close();
  }

  // The teammate holds no approval permission: nothing about Taylor's leave.
  const teammate = await signedIn(browser, l.quinn);
  try {
    await firstLoad(teammate.page, '/notifications', 'Notifications');
    await expect(teammate.page.getByRole('main')).not.toContainText(l.taylor.name);
  } finally {
    await teammate.context.close();
  }
});

test('payroll: the employee is told their pay statement is available, without amounts', async ({
  browser,
}) => {
  const p = seed.payroll;
  const employee = await signedIn(browser, p.employee);
  try {
    await firstLoad(employee.page, '/notifications', 'Notifications');
    const list = inbox(employee.page);
    const notice = list
      .getByRole('listitem')
      .filter({ hasText: 'Your pay statement is available' });
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText(`(pay date ${p.payDate}) is available.`);
    await expect(notice).not.toContainText(/CAD|\$|2,150|2150/);
    // Nothing from the leave organization.
    await expect(list).not.toContainText('leave');
    await notice.getByRole('link', { name: /Open Your pay statement is available/ }).click();
    await expect(employee.page).toHaveURL(/\/pay$/);
    await expectNoSeriousA11yViolations(employee.page);
  } finally {
    await employee.context.close();
  }
});

test('email through the development transport and the delivery log', async ({ browser }) => {
  const delivered = job('deliver') as { sent: number; errors: unknown[] };
  expect(delivered.errors).toEqual([]);
  expect(delivered.sent).toBeGreaterThanOrEqual(1);

  const l = seed.leave;
  const admin = await signedIn(browser, l.admin);
  try {
    await firstLoad(admin.page, '/admin/notifications', 'Notifications administration');
    const table = admin.page.getByRole('table', { name: /Notification deliveries/ });
    await expect(table.getByText(l.taylor.name).first()).toBeVisible();
    const filters = admin.page.getByRole('form', { name: 'Delivery log filters' });
    await filters.getByLabel('Event').selectOption('leave.request-approved');
    await filters.getByLabel('Channel').selectOption('EMAIL');
    await filters.getByRole('button', { name: 'Apply filters' }).click();
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByText('Sent', { exact: true })).toBeVisible();
    // Never the message text, the address, or another organization's deliveries.
    await expect(table).not.toContainText('was approved');
    await expect(table).not.toContainText(l.taylor.email);
    await expect(table).not.toContainText(seed.payroll.employee.name);
    await admin.page
      .getByRole('button', { name: `Attempts for Leave approved to ${l.taylor.name}` })
      .click();
    const dialog = admin.page.getByRole('dialog', { name: 'Delivery attempts' });
    await expect(dialog.getByText('Delivered to the provider')).toBeVisible();
    await expect(dialog.getByText('dev-log')).toBeVisible();
    await expectNoSeriousA11yViolations(admin.page);
    await admin.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  } finally {
    await admin.context.close();
  }
  void formatted;
});
