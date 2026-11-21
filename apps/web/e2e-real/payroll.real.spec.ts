import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { REAL_STACK_WEB } from './support/stack';

/**
 * Real stack (Batch 6A): the payroll workflow against the real API and database, in the seed's
 * time zone, in the seed's own payroll organization (disposable data only). A payroll
 * administrator creates and edits a pay calendar, generates the first period, creates the CAD
 * run, adds an off-cycle earning and cancels a mistaken one and calculates; with payroll dual
 * control (M2) neither they nor an approver who authored the payee's compensation may approve
 * it, so an independent approver approves and finalizes (both confirmed). The administrator
 * prints the payslip, downloads the payroll register and ends the calendar.
 * The employee then reads the same pay statement in My Pay. Register, run and payslip agree:
 * 2,000.00 salary + 150.00 adjustment = 2,150.00 gross, the adjustment counted once.
 */

let seed: RealStackSeed;
let context: BrowserContext;
let page: Page;
test.describe.configure({ mode: 'serial' });

const formatted = (date: string) => {
  const [year, month, day] = date.split('-');
  return `${month}/${day}/${year}`;
};

/**
 * Sign-ins are rate limited per address (10 a minute, API LOGIN_IP_LIMIT/LOGIN_IP_WINDOW_MS) and
 * the attendance spec that follows needs most of that budget: after its last sign-in this file
 * waits out the window, so no window it counted in is still open when the next file starts.
 */
let lastSignInAt = 0;
const LOGIN_WINDOW_MS = 61_000;

async function signIn(target: Page, account: { email: string; password: string }) {
  lastSignInAt = Date.now();
  await target.goto('/login');
  await target.getByLabel('Email').fill(account.email);
  await target.getByLabel('Password').fill(account.password);
  await target.getByRole('button', { name: 'Sign in' }).click();
  await expect(target).toHaveURL(/\/dashboard$/);
}

/** First loads under `next dev` compile on demand; fail at once on an error instead. */
async function firstLoad(target: Page, path: string, heading: string) {
  await target.goto(path);
  const ready = target.getByRole('heading', { name: heading, level: 1 });
  const failure = target
    .getByRole('main')
    .getByRole('alert')
    .filter({ hasText: /unable|not found|permission|error|went wrong|unavailable/i });
  await expect(ready.or(failure).first()).toBeVisible({ timeout: 60_000 });
  await expect(failure).toHaveCount(0);
  await expect(ready).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  seed = readSeed();
  context = await browser.newContext({ baseURL: REAL_STACK_WEB, acceptDownloads: true });
  await context.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed += 1;
    };
  });
  page = await context.newPage();
  await signIn(page, seed.payroll.admin);
});

test.afterAll(async () => {
  await context?.close();
  const wait = lastSignInAt + LOGIN_WINDOW_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
});

test('payroll administrator: calendar → period → run → adjustments → approve → finalize → payslip → register', async () => {
  const p = seed.payroll;
  expect(p.payDate < seed.referenceDate).toBe(true);
  await firstLoad(page, '/admin/payroll?tab=calendars', 'Payroll');

  // ── Pay calendar: create, then edit while it has no periods ───────────────
  const create = page.getByRole('form', { name: 'New pay calendar' });
  await create.getByLabel('Time zone').fill(seed.timezone);
  await create.getByLabel('First period starts').fill(p.anchorDate);
  await create.getByRole('button', { name: 'Create calendar' }).click();
  await expect(page.getByText('Pay calendar created.')).toBeVisible();
  await page.getByRole('button', { name: `Edit calendar for ${p.payGroupName}` }).click();
  const edit = page.getByRole('dialog', { name: `Edit ${p.payGroupName} calendar` });
  await edit.getByLabel('Cutoff before pay date (days)').fill('3');
  await expectNoSeriousA11yViolations(page);
  await edit.getByRole('button', { name: 'Save calendar' }).click();
  await expect(page.getByText('Pay calendar updated.')).toBeVisible();

  // ── Pay period and the CAD run ─────────────────────────────────────────────
  await page.getByRole('tab', { name: 'Pay periods' }).click();
  const generate = page.getByRole('form', { name: 'Generate pay periods' });
  await generate.getByLabel('Generate through').fill(p.anchorDate);
  await generate.getByRole('button', { name: 'Generate periods' }).click();
  await expect(page.getByText('Pay periods generated.')).toBeVisible();
  await expect(page.getByRole('cell', { name: formatted(p.payDate) })).toBeVisible();
  await page.getByRole('button', { name: 'Create CAD run' }).click();
  await expect(page.getByText('Payroll run created.')).toBeVisible();
  const openRun = page.getByRole('link', { name: 'Open CAD run' });
  const runHref = await openRun.getAttribute('href');
  expect(runHref).toMatch(/^\/admin\/payroll\/runs\/[0-9a-f-]{36}$/);
  await expectNoSeriousA11yViolations(page);

  // ── Off-cycle adjustments: one to pay, one cancelled ──────────────────────
  await page.getByRole('tab', { name: 'Adjustments' }).click();
  for (const [amount, description] of [
    ['150.00', 'Referral bonus'],
    ['999.00', 'Entered twice'],
  ] as const) {
    await page.getByRole('button', { name: 'New adjustment' }).click();
    const dialog = page.getByRole('dialog', { name: 'New off-cycle adjustment' });
    const picker = dialog.getByLabel('Employee and assignment');
    await expect(picker).toContainText(
      `${p.employee.name} · ${p.employee.employeeNumber} · ${p.positionName}`,
    );
    await expect(dialog.getByLabel('Currency')).toHaveValue('CAD');
    await dialog.getByLabel(/^Amount/).fill(amount);
    await dialog.getByLabel(/^Description/).fill(description);
    await dialog.getByLabel(/^Reason/).fill(`Real-stack ${seed.suffix}`);
    if (description === 'Referral bonus') await expectNoSeriousA11yViolations(page);
    await dialog.getByRole('button', { name: 'Create adjustment' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('cell', { name: new RegExp(`^${description}`) })).toBeVisible();
  }
  await page
    .getByRole('button', { name: `Cancel adjustment Entered twice for ${p.employee.name}` })
    .click();
  const cancel = page.getByRole('alertdialog', { name: 'Cancel this adjustment?' });
  await cancel.getByLabel(/Reason/).fill('Entered twice by mistake');
  await cancel.getByRole('button', { name: 'Cancel adjustment' }).click();
  await expect(page.getByText('Adjustment cancelled.')).toBeVisible();
  await expect(page.getByRole('cell', { name: /^Entered twice/ })).toHaveCount(0);

  // ── Calculate → approve (confirmed) → finalize (confirmed) ────────────────
  await firstLoad(
    page,
    runHref!,
    `Pay period ${formatted(p.anchorDate)} – ${formatted(p.periodEnd)}`,
  );
  await page.getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByText('Run calculated.')).toBeVisible();
  await expect(page.getByText('CAD 2,150.00').first()).toBeVisible();
  // Security remediation M2: the preparer (who calculated the run and added its adjustments)
  // cannot approve it; the reason is shown and the action is not offered.
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(
    page.getByText('You calculated this run: another administrator must approve and finalize it.'),
  ).toBeVisible();

  // An approver who authored the payee's compensation is refused too.
  const browser = context.browser()!;
  const compensationContext = await browser.newContext({ baseURL: REAL_STACK_WEB });
  const compensationPage = await compensationContext.newPage();
  await signIn(compensationPage, p.compensationApprover);
  await firstLoad(
    compensationPage,
    runHref!,
    `Pay period ${formatted(p.anchorDate)} – ${formatted(p.periodEnd)}`,
  );
  await expect(
    compensationPage.getByText(
      'You changed compensation this run pays: another administrator must approve it.',
    ),
  ).toBeVisible();
  await expect(compensationPage.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await compensationContext.close();

  // An independent approver approves and finalizes (both confirmed).
  const approverContext = await browser.newContext({ baseURL: REAL_STACK_WEB });
  const approverPage = await approverContext.newPage();
  await signIn(approverPage, p.approver);
  await firstLoad(
    approverPage,
    runHref!,
    `Pay period ${formatted(p.anchorDate)} – ${formatted(p.periodEnd)}`,
  );
  await approverPage.getByRole('button', { name: 'Approve' }).click();
  const approve = approverPage.getByRole('alertdialog', { name: 'Approve this payroll run?' });
  await expect(approve).toContainText('gross CAD 2,150.00, 1 employee(s)');
  await expectNoSeriousA11yViolations(approverPage);
  await approve.getByRole('button', { name: 'Approve run' }).click();
  await expect(approverPage.getByText('Run approved.')).toBeVisible();
  await approverPage.getByRole('button', { name: 'Finalize' }).click();
  await approverPage
    .getByRole('alertdialog', { name: 'Finalize this payroll run?' })
    .getByRole('button', { name: 'Finalize run' })
    .click();
  await expect(approverPage.getByText('Run finalized.')).toBeVisible();
  // Who did what is on the run; a finalized run offers no void (it can never be voided).
  await approverPage.getByRole('tab', { name: 'Summary' }).click();
  const summary = approverPage.getByRole('main');
  await expect(summary.getByText(p.admin.name).first()).toBeVisible();
  await expect(summary.getByText(p.approver.name).first()).toBeVisible();
  await expect(approverPage.getByRole('form', { name: 'Void run' })).toHaveCount(0);
  await approverContext.close();

  await firstLoad(
    page,
    runHref!,
    `Pay period ${formatted(p.anchorDate)} – ${formatted(p.periodEnd)}`,
  );
  await expect(page.getByRole('button', { name: /^(Calculate|Recalculate)$/ })).toHaveCount(0);

  // ── Administrator payslip: printable, adjustment once, no net pay ─────────
  await page.getByRole('tab', { name: 'Employees' }).click();
  await page.getByRole('button', { name: `Payslip for ${p.employee.name}` }).click();
  const slip = page.getByRole('article', {
    name: `Pay statement for ${p.employee.name}, pay date ${formatted(p.payDate)}`,
  });
  await expect(slip.getByText('Referral bonus')).toHaveCount(1);
  await expect(slip.getByText('Entered twice')).toHaveCount(0);
  await expect(slip.getByText('CAD 2,150.00')).toBeVisible();
  await expect(slip.getByText('Not calculated', { exact: true })).toBeVisible();
  await expect(slip.getByText(/Preview/)).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
  await slip.getByRole('button', { name: 'Print or save as PDF' }).click();
  expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);

  // ── Payroll register in Reports: same totals; CSV download ────────────────
  await firstLoad(page, '/admin/payroll', 'Payroll');
  await page.getByRole('tab', { name: 'Runs' }).click();
  await page.getByRole('link', { name: /Payroll register/ }).click();
  await expect(page.getByRole('heading', { name: 'Payroll register', level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByLabel('From', { exact: true }).fill(p.anchorDate);
  await page.getByLabel('To', { exact: true }).fill(p.payDate);
  await page.getByRole('button', { name: 'Run report' }).click();
  const table = page.getByRole('table', { name: 'Payroll register' });
  const row = table.getByRole('row', { name: new RegExp(p.employee.employeeNumber) });
  await expect(row).toContainText('2,150.00');
  await expect(row).toContainText('150.00');
  await expect(row).toContainText('Not calculated');
  await expect(page.getByText('Totals (CAD): gross 2150, recorded deductions 0')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^payroll-register-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await download.path())!, 'utf8').split('\r\n');
  expect(csv[0]).toContain('Gross less recorded deductions (NOT net pay)');
  expect(csv.filter((line) => line.includes(p.employee.employeeNumber))).toEqual([
    expect.stringContaining(',CAD,2150,0,150,0,0,2150,Not calculated'),
  ]);

  // ── End the calendar: no earlier than its generated period ────────────────
  await firstLoad(page, '/admin/payroll?tab=calendars', 'Payroll');
  await page.getByRole('button', { name: `End calendar for ${p.payGroupName}` }).click();
  const end = page.getByRole('dialog', { name: `End the ${p.payGroupName} calendar?` });
  await expect(end).toContainText(`the last ending ${formatted(p.periodEnd)}`);
  await expect(end.getByLabel('Last day of the calendar')).toHaveAttribute('min', p.periodEnd);
  await end.getByLabel('Last day of the calendar').fill(p.periodEnd);
  await end.getByRole('button', { name: 'End calendar' }).click();
  await expect(page.getByText(`Pay calendar ends ${formatted(p.periodEnd)}.`)).toBeVisible();
});

test('the employee reads the same finalized pay statement in My Pay', async ({ browser }) => {
  const p = seed.payroll;
  const employeeContext = await browser.newContext({ baseURL: REAL_STACK_WEB });
  try {
    const employee = await employeeContext.newPage();
    await signIn(employee, p.employee);
    await firstLoad(employee, '/pay', 'My pay statements');
    await employee
      .getByRole('button', { name: `View pay statement for ${formatted(p.payDate)}` })
      .click();
    const slip = employee.getByRole('article', {
      name: `Pay statement for ${p.employee.name}, pay date ${formatted(p.payDate)}`,
    });
    await expect(slip.getByText('Referral bonus')).toHaveCount(1);
    await expect(slip.getByText('Adjustment · ' + p.positionName)).toBeVisible();
    await expect(slip.getByText('CAD 2,150.00').first()).toBeVisible();
    await expect(slip.getByText('Not calculated', { exact: true })).toBeVisible();
    await expectNoSeriousA11yViolations(employee);
  } finally {
    await employeeContext.close();
  }
});
