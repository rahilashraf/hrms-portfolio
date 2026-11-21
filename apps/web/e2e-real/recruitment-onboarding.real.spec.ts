import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { REAL_STACK_WEB } from './support/stack';

/**
 * Real stack (Batch 7A): recruitment to onboarding against the real API and database, in the
 * seed's time zone and its own recruitment organization (disposable data only).
 *
 * 1. A standard Recruiter (recruitment permissions only — no employee.read, no role.assign)
 *    creates an opening from pickers (position, hiring manager), opens it, adds Casey's
 *    application and schedules an interview with Sam picked as interviewer — no id typed.
 * 2. The hirer drafts, approves and sends the offer, records its acceptance, converts Casey to
 *    an employee, then starts onboarding from the hire picker: the workflow holds the default
 *    template's tasks. Nothing starts onboarding automatically on hire.
 *
 * Sign-ins are rate limited per address (10 a minute); after its last sign-in this file waits
 * out the window so the attendance spec that follows keeps its budget.
 */

let seed: RealStackSeed;
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  seed = readSeed();
});

let lastSignInAt = 0;
const LOGIN_WINDOW_MS = 61_000;

async function signedIn(browser: Browser, account: { email: string; password: string }) {
  const context = await browser.newContext({ baseURL: REAL_STACK_WEB });
  const page = await context.newPage();
  lastSignInAt = Date.now();
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return { context, page };
}

/** First loads under `next dev` compile on demand; fail at once on an error instead. */
async function firstLoad(page: Page, path: string, heading: string | RegExp) {
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

/** Picks the option of a picker (combobox) by typing part of its label. */
async function pick(
  page: Page,
  combobox: ReturnType<Page['getByRole']>,
  text: string,
  anchored = false,
) {
  await combobox.fill(text);
  await page
    .getByRole('option', { name: new RegExp(anchored ? `^${text}` : text) })
    .first()
    .click();
}

/** Chooses the organization when the page offers a choice. */
async function chooseOrganization(page: Page, name: string) {
  const select = page.getByLabel('Organization', { exact: true });
  if (await select.count()) {
    await select.selectOption({ label: name });
  }
}

test('a standard Recruiter builds an opening and schedules an interview from pickers only', async ({
  browser,
}) => {
  const r = seed.recruitment;
  const title = `Grade 2 teacher ${seed.suffix}`;
  const { context, page } = await signedIn(browser, r.recruiter);
  try {
    // /recruitment is no longer a 404: it leads to Recruitment.
    await page.goto('/recruitment');
    await expect(page).toHaveURL(/\/admin\/recruitment/);
    await firstLoad(page, '/admin/recruitment', 'Recruitment');
    await chooseOrganization(page, r.organizationName);

    await page.getByRole('tab', { name: 'Openings' }).click();
    await page.getByRole('button', { name: 'New opening' }).click();
    const form = page.getByRole('form', { name: 'Create opening' });
    await form.getByLabel('Requisition code').fill(`REQ-${seed.suffix}`);
    await form.getByLabel('Job title').fill(title);
    await pick(
      page,
      form.getByRole('combobox', { name: 'Position (optional)' }),
      r.positionName,
      true,
    );
    await pick(
      page,
      form.getByRole('combobox', { name: 'Hiring manager (optional)' }),
      r.interviewer.name.split(' ')[1]!,
    );
    // No raw id field anywhere in the form.
    await expect(form.getByRole('textbox', { name: /\bID\b/ })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page);
    await form.getByRole('button', { name: 'Create opening' }).click();
    await expect(page.getByText('Opening created as a draft.')).toBeVisible();
    await page.getByRole('button', { name: `Open ${title}`, exact: true }).click();
    // The list reloads after every action; open the details once it has.
    await expect(page.getByText('Opening opened.')).toBeVisible();
    await page.getByRole('button', { name: `Details of ${title}` }).click();
    const details = page.getByRole('region', { name: 'Opening details' });
    await expect(details).toContainText(r.interviewer.name);
    await expect(details).toContainText(r.positionName);

    // Casey applies.
    await page.getByRole('tab', { name: 'Pipeline' }).click();
    const add = page.getByRole('form', { name: 'Add application' });
    await add
      .getByLabel('Apply to opening')
      .selectOption({ label: `${title} (REQ-${seed.suffix})` });
    await add.getByLabel('First name').fill(r.candidate.firstName);
    await add.getByLabel('Last name').fill(r.candidate.lastName);
    await add.getByLabel('Email').fill(r.candidate.email);
    await add.getByRole('button', { name: 'Add application' }).click();
    await expect(page.getByText('Application added.')).toBeVisible();
    await page
      .getByRole('link', { name: new RegExp(`Open application of .*${r.candidate.lastName}`) })
      .click();

    // An interview with Sam, picked by name.
    await expect(page.getByRole('heading', { level: 1 })).toContainText(r.candidate.lastName, {
      timeout: 60_000,
    });
    const schedule = page.getByRole('form', { name: 'Schedule interview' });
    await schedule.getByLabel('Interview title').fill('Classroom visit');
    await schedule.getByLabel('Starts at').fill(`${r.startDate}T10:00`);
    await schedule.getByLabel('Location').fill('Room 12');
    await pick(
      page,
      schedule.getByRole('combobox', { name: 'Add an interviewer' }),
      r.interviewer.name.split(' ')[1]!,
    );
    await expect(schedule.getByLabel(/user IDs/)).toHaveCount(0);
    await schedule.getByRole('button', { name: 'Schedule interview' }).click();
    await expect(page.getByText('Interview scheduled.')).toBeVisible();
    await expect(page.getByRole('listitem', { name: 'Interview Classroom visit' })).toContainText(
      r.interviewer.email,
    );
    await expectNoSeriousA11yViolations(page);
  } finally {
    await context.close();
  }
});

test('the hirer offers, converts and starts onboarding from the hire picker', async ({
  browser,
}) => {
  const r = seed.recruitment;
  const { context, page } = await signedIn(browser, r.hirer);
  try {
    await firstLoad(page, '/admin/recruitment', 'Recruitment');
    await chooseOrganization(page, r.organizationName);
    await page.getByRole('tab', { name: 'Pipeline' }).click();
    await page
      .getByRole('link', { name: new RegExp(`Open application of .*${r.candidate.lastName}`) })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(r.candidate.lastName, {
      timeout: 60_000,
    });

    // The offer: drafted on the opening's position, approved, sent, accepted.
    const offer = page.getByRole('form', { name: 'Draft offer' });
    await offer.getByLabel('Start date').fill(r.startDate);
    await offer.getByLabel('Rate amount').fill('32.50');
    await offer.getByRole('button', { name: 'Draft offer' }).click();
    await expect(page.getByText('Offer drafted.')).toBeVisible();
    for (const [action, message] of [
      ['Approve offer', 'Offer approved.'],
      ['Send offer', 'Offer sent.'],
      ['Record acceptance', 'Offer acceptance recorded.'],
    ] as const) {
      await page.getByRole('button', { name: action }).click();
      await expect(page.getByText(message)).toBeVisible();
    }

    // Conversion creates the employee; onboarding is not started automatically.
    const convert = page.getByRole('form', { name: 'Convert to employee' });
    await convert.getByRole('button', { name: 'Convert to employee' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: /Converted to employee/ }),
    ).toBeVisible();

    // Onboarding from the hire picker, then the workflow with the template's tasks.
    await firstLoad(page, '/admin/onboarding', 'Onboarding & offboarding');
    await chooseOrganization(page, r.organizationName);
    await page.getByRole('tab', { name: 'Start' }).click();
    const fromHire = page.getByRole('form', { name: 'Start onboarding from a hire' });
    await pick(page, fromHire.getByRole('combobox', { name: 'Hire' }), r.candidate.lastName);
    await expect(fromHire.getByRole('textbox', { name: /\bID\b/ })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page);
    await fromHire.getByRole('button', { name: 'Start from hire' }).click();
    await page.getByRole('link', { name: /Onboarding started from the hire/ }).click();
    await expect(page.getByText(r.employeeTaskTitle)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(r.hrTaskTitle)).toBeVisible();
    await expect(page.getByRole('main')).toContainText(r.templateName);
    await expectNoSeriousA11yViolations(page);
  } finally {
    await context.close();
    // Leave the sign-in window to the next file.
    const wait = lastSignInAt + LOGIN_WINDOW_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
});
