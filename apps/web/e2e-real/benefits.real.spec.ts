import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { REAL_STACK_WEB } from './support/stack';

/**
 * Real stack (Batch 7C): Benefits and their payroll against the real API and database, in the
 * seed's time zone and its own benefits organization (disposable data only).
 *
 * The benefits administrator (benefit.* and payroll.*, no employee.read) configures a plan in
 * the Benefits admin — options, monthly rates, an eligibility rule picked by department name —
 * and activates it, then finds the member by name (the Benefits employee page, no employee.read)
 * and records a spouse and a "With spouse" election. Payroll then deducts the election; a rate correction
 * makes the open run stale; after recalculation the run is approved and finalized; a second
 * correction shows as a benefit cost difference the administrator resolves explicitly (C2) —
 * the finalized run never changes. The divorce follows through the guided "Remove a dependent"
 * flow (relationship end, Single from the next day); the member reads My Benefits without any
 * HR note.
 *
 * Two sign-ins; afterwards the file waits out the sign-in rate-limit window.
 */

let seed: RealStackSeed;
let context: BrowserContext;
let page: Page;
test.describe.configure({ mode: 'serial' });

const formatted = (date: string) => {
  const [year, month, day] = date.split('-');
  return `${month}/${day}/${year}`;
};
const addDays = (date: string, days: number) => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
};

let lastSignInAt = 0;
const LOGIN_WINDOW_MS = 61_000;

async function signIn(target: Page, account: { email: string; password: string }) {
  lastSignInAt = Date.now();
  await target.goto('/login');
  await target.getByLabel('Email', { exact: true }).fill(account.email);
  await target.getByLabel('Password', { exact: true }).fill(account.password);
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
    .filter({ hasText: /unable|not found|permission|went wrong|unavailable/i });
  await expect(ready.or(failure).first()).toBeVisible({ timeout: 60_000 });
  await expect(failure).toHaveCount(0);
  await expect(ready).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  seed = readSeed();
  context = await browser.newContext({ baseURL: REAL_STACK_WEB });
  page = await context.newPage();
  await signIn(page, seed.benefits.admin);
});

test.afterAll(async () => {
  await context?.close();
  const wait = lastSignInAt + LOGIN_WINDOW_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
});

test('benefits administrator: plan → rates → rule → election → payroll → correction → explicit resolution', async () => {
  test.setTimeout(420_000);
  const b = seed.benefits;
  const planName = `Health ${seed.suffix}`;
  const planCode = `HEALTH-${seed.suffix}`;

  // ── Plan configuration in the Benefits admin ──────────────────────────────
  await firstLoad(page, '/admin/benefits', 'Benefits');
  const create = page.getByRole('form', { name: 'Create benefit plan' });
  await expect(create).toBeVisible({ timeout: 60_000 });
  await create.getByLabel('Code', { exact: true }).fill(planCode);
  await create.getByLabel('Name', { exact: true }).fill(planName);
  await create.getByLabel(/^Type/).selectOption('HEALTH');
  await create.getByLabel('Currency', { exact: true }).fill('CAD');
  await create.getByLabel('Effective from', { exact: true }).fill(b.planStart);
  await create
    .getByLabel('Provider reference (optional)', { exact: true })
    .fill(`GRP-${seed.suffix}`);
  await create
    .getByLabel('Description (optional)', { exact: true })
    .fill('Extended health and dental');
  await create.getByRole('button', { name: 'Create plan' }).click();
  await expect(page.getByText('Benefit plan created.')).toBeVisible();
  await page.getByRole('button', { name: `Open ${planName}` }).click();
  const detail = page.getByRole('region', { name: `${planName} plan` });
  await expect(detail).toBeVisible();

  const optionForm = page.getByRole('form', { name: 'Add coverage option' });
  for (const [code, name, level] of [
    ['SINGLE', 'Single', 'EMPLOYEE_ONLY'],
    ['SPOUSE', 'With spouse', 'EMPLOYEE_SPOUSE'],
  ] as const) {
    await optionForm.getByLabel('Option code', { exact: true }).fill(code);
    await optionForm.getByLabel('Option name', { exact: true }).fill(name);
    await optionForm.getByLabel(/^Coverage level/).selectOption(level);
    await optionForm.getByRole('button', { name: 'Add option' }).click();
    await expect(page.getByText('Coverage option added.')).toBeVisible();
    await expect(
      page.getByRole('region', { name: `Coverage options of ${planName}` }).getByText(name, {
        exact: false,
      }),
    ).toBeVisible();
  }
  const rateForm = page.getByRole('form', { name: 'Add rate' });
  for (const [name, employee, employer] of [
    ['Single', '30', '90'],
    ['With spouse', '60', '120'],
  ] as const) {
    await rateForm.getByLabel(/^Option/).selectOption({ label: name });
    await rateForm.getByLabel('Rate effective from', { exact: true }).fill(b.planStart);
    await rateForm.getByLabel(/^Frequency/).selectOption('MONTHLY');
    await rateForm.getByLabel('Employee amount', { exact: true }).fill(employee);
    await rateForm.getByLabel('Employer amount', { exact: true }).fill(employer);
    await rateForm.getByRole('button', { name: 'Add rate' }).click();
    await expect(page.getByText('Rate added.')).toBeVisible();
  }

  // Eligibility: the member's department, chosen by name.
  const ruleForm = page.getByRole('form', { name: 'Add eligibility rule' });
  await ruleForm.getByLabel('Rule effective from', { exact: true }).fill(b.planStart);
  await ruleForm.getByRole('combobox', { name: 'Department (optional)' }).click();
  await ruleForm.getByRole('combobox', { name: 'Department (optional)' }).fill('Member');
  await page.getByRole('option', { name: new RegExp(b.departmentName) }).click();
  await ruleForm.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByText('Eligibility rule added.')).toBeVisible();
  await expect(detail.getByText(`Department: ${b.departmentName}`)).toBeVisible();
  await expectNoSeriousA11yViolations(page);

  await detail.getByRole('button', { name: 'Activate' }).click();
  await page
    .getByRole('alertdialog', { name: `Activate ${planName}?` })
    .getByRole('button', { name: 'Activate plan' })
    .click();
  await expect(page.getByText('Plan activated.')).toBeVisible();

  // ── The member's benefits: found by name, a dependent and an election ────────
  await firstLoad(page, '/admin/benefits', 'Benefits');
  const find = page.getByRole('combobox', { name: 'Find an employee' });
  await find.click();
  await find.fill('Morgan');
  await page.getByRole('option', { name: new RegExp(b.member.name) }).click();
  await expect(
    page.getByRole('heading', { name: `${b.member.name} — benefits`, level: 1 }),
  ).toBeVisible({ timeout: 60_000 });
  const memberBenefits = page.url().replace(/^https?:\/\/[^/]+/, '');
  expect(memberBenefits).toMatch(/^\/admin\/benefits\/employees\/[0-9a-f-]{36}$/);
  const spouseName = `Sam Spouse${seed.suffix}`;
  await page.getByRole('button', { name: 'Add dependent' }).click();
  const addDependent = page.getByRole('dialog', { name: 'Add dependent' });
  await addDependent.getByLabel('First name', { exact: true }).fill('Sam');
  await addDependent.getByLabel('Last name', { exact: true }).fill(`Spouse${seed.suffix}`);
  await addDependent
    .getByLabel(/^Relationship/)
    .first()
    .selectOption('SPOUSE');
  await addDependent
    .getByLabel('Relationship start (optional)', { exact: true })
    .fill('2015-06-01');
  await addDependent.getByRole('button', { name: 'Add dependent' }).click();
  await expect(page.getByText('Dependent added.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recorded dependents' })).toContainText(spouseName);

  await page.getByRole('button', { name: 'Record election' }).click();
  const enroll = page.getByRole('dialog', { name: 'Record election' });
  await enroll.getByLabel(/^Plan/).selectOption({ label: planName });
  await enroll.getByLabel('Coverage starts', { exact: true }).fill(b.planStart);
  await enroll.getByLabel(/^Coverage option/).selectOption({ label: 'With spouse' });
  await enroll.getByLabel(new RegExp(`^${spouseName}`)).check();
  await expectNoSeriousA11yViolations(page);
  await enroll.getByRole('button', { name: 'Enroll' }).click();
  await expect(page.getByText('Enrollment recorded.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Benefit elections' })).toContainText(
    'With spouse',
  );

  // ── Payroll: calendar → period → run → calculate (the deduction appears) ──
  await firstLoad(page, '/admin/payroll?tab=calendars', 'Payroll');
  const calendar = page.getByRole('form', { name: 'New pay calendar' });
  await calendar.getByLabel('Time zone', { exact: true }).fill(seed.timezone);
  await calendar.getByLabel('First period starts', { exact: true }).fill(b.anchorDate);
  await calendar.getByRole('button', { name: 'Create calendar' }).click();
  await expect(page.getByText('Pay calendar created.')).toBeVisible();
  await page.getByRole('tab', { name: 'Pay periods' }).click();
  const generate = page.getByRole('form', { name: 'Generate pay periods' });
  await generate.getByLabel('Generate through', { exact: true }).fill(b.anchorDate);
  await generate.getByRole('button', { name: 'Generate periods' }).click();
  await expect(page.getByText('Pay periods generated.')).toBeVisible();
  await page.getByRole('button', { name: 'Create CAD run' }).click();
  await expect(page.getByText('Payroll run created.')).toBeVisible();
  const runHref = await page.getByRole('link', { name: 'Open CAD run' }).getAttribute('href');
  expect(runHref).toMatch(/^\/admin\/payroll\/runs\/[0-9a-f-]{36}$/);
  const period = `Pay period ${formatted(b.anchorDate)} – ${formatted(b.periodEnd)}`;
  await firstLoad(page, runHref!, period);
  await page.getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByText('Run calculated.')).toBeVisible();
  // 60.00 a month, 12/26 of it a bi-weekly period.
  await page.getByRole('tab', { name: 'Employees' }).click();
  const employees = page.getByRole('row', { name: new RegExp(b.member.name) });
  await expect(employees).toContainText('CAD 27.69');

  // ── A rate correction makes the open run stale ────────────────────────────
  const correctRate = async (amount: string, reason: string) => {
    await firstLoad(page, '/admin/benefits', 'Benefits');
    await page.getByRole('button', { name: `Open ${planName}` }).click();
    await page
      .getByRole('button', { name: `Correct With spouse rate from ${formatted(b.planStart)}` })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Correct the With spouse rate' });
    await dialog.getByLabel('Employee amount (CAD)', { exact: true }).fill(amount);
    await dialog.getByLabel('Reason for the correction', { exact: true }).fill(reason);
    await dialog.getByRole('button', { name: 'Correct rate' }).click();
    await expect(page.getByText('Rate corrected.')).toBeVisible();
  };
  await correctRate('80', 'Carrier invoice');
  await firstLoad(page, runHref!, period);
  await page.getByRole('button', { name: 'Check sources' }).click();
  await expect(page.getByText(/Sources changed since calculation/)).toBeVisible();
  await page.getByRole('button', { name: 'Recalculate' }).click();
  await expect(page.getByText('Run recalculated.')).toBeVisible();
  await page.getByRole('tab', { name: 'Employees' }).click();
  await expect(page.getByRole('row', { name: new RegExp(b.member.name) })).toContainText(
    'CAD 36.92',
  );
  // Security remediation M2: the administrator calculated the run, so an independent approver
  // approves and finalizes it.
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  const approverContext = await context.browser()!.newContext({ baseURL: REAL_STACK_WEB });
  const approverPage = await approverContext.newPage();
  await signIn(approverPage, b.approver);
  await firstLoad(approverPage, runHref!, period);
  await approverPage.getByRole('button', { name: 'Approve' }).click();
  await approverPage
    .getByRole('alertdialog', { name: 'Approve this payroll run?' })
    .getByRole('button', { name: 'Approve run' })
    .click();
  await expect(approverPage.getByText('Run approved.')).toBeVisible();
  await approverPage.getByRole('button', { name: 'Finalize' }).click();
  await approverPage
    .getByRole('alertdialog', { name: 'Finalize this payroll run?' })
    .getByRole('button', { name: 'Finalize run' })
    .click();
  await expect(approverPage.getByText('Run finalized.')).toBeVisible();
  await approverContext.close();

  // ── After finalization: a difference a person resolves (C2) ───────────────
  await correctRate('100', 'Second carrier invoice');
  await firstLoad(page, runHref!, period);
  await page.getByRole('tab', { name: 'Adjustments' }).click();
  const differences = page.getByRole('region', { name: 'Retroactive differences' });
  await expect(differences).toContainText('Needs a decision', { timeout: 30_000 });
  await expect(differences).toContainText('CAD 9.23');
  await expectNoSeriousA11yViolations(page);
  await page
    .getByRole('button', { name: `Resolve benefit difference for ${b.member.name}` })
    .click();
  const resolve = page.getByRole('dialog', {
    name: `Resolve benefit difference for ${b.member.name}`,
  });
  await resolve.getByLabel(/No adjustment required/).check();
  await resolve.getByLabel('Reason', { exact: true }).fill('Settled with the carrier');
  await resolve.getByRole('button', { name: 'Record decision' }).click();
  await expect(differences).toContainText('Resolved', { timeout: 30_000 });
  // The finalized run never changed.
  await page.getByRole('tab', { name: 'Employees' }).click();
  await expect(page.getByRole('row', { name: new RegExp(b.member.name) })).toContainText(
    'CAD 36.92',
  );

  // ── The divorce: relationship ended, coverage changed to Single the next day ──
  const divorce = addDays(seed.referenceDate, 1);
  await firstLoad(page, memberBenefits, `${b.member.name} — benefits`);
  await page.getByRole('button', { name: `Remove a dependent from ${planName}` }).click();
  const remove = page.getByRole('dialog', { name: `Remove a dependent from ${planName}` });
  await expect(
    remove.getByLabel('Record the end of the relationship (for example a divorce)'),
  ).toBeChecked();
  await remove.getByLabel('Relationship ended on', { exact: true }).fill(divorce);
  await expect(remove.getByLabel(/^Coverage without them from/)).toHaveValue(addDays(divorce, 1));
  await remove.getByLabel(/^Coverage option/).selectOption({ label: 'Single' });
  await remove.getByLabel('Reason (optional)', { exact: true }).fill('Divorce (HR note)');
  await expectNoSeriousA11yViolations(page);
  await remove.getByRole('button', { name: 'Remove from coverage' }).click();
  await expect(page.getByText('Dependent removed from coverage.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Benefit elections' })).toContainText('Single');
});

test('the member reads their benefits without HR notes', async ({ browser }) => {
  const b = seed.benefits;
  const memberContext = await browser.newContext({ baseURL: REAL_STACK_WEB });
  try {
    const member = await memberContext.newPage();
    await signIn(member, b.member);
    await firstLoad(member, '/benefits', 'My benefits');
    const current = member.getByRole('region', { name: 'Current and upcoming coverage' });
    await expect(current).toContainText(`Health ${seed.suffix}`, { timeout: 60_000 });
    await expect(current).toContainText('Single');
    await expect(member.getByRole('region', { name: 'Your dependents' })).toContainText('Sam');
    const text = (await member.getByRole('main').textContent()) ?? '';
    expect(text).not.toContain('Divorce');
    expect(text).not.toContain('Carrier invoice');
    await expectNoSeriousA11yViolations(member);
  } finally {
    await memberContext.close();
  }
});
