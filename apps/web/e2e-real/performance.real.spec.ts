import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { REAL_STACK_WEB } from './support/stack';

/**
 * Real stack (Batch 7B): one performance review cycle against the real API and database, in the
 * seed's time zone and its own performance organization (disposable data only).
 *
 * The performance administrator (performance permissions only) creates a cycle whose window
 * contains "today" in the organization's time zone, adds Pat through the assignment picker and
 * opens it. Pat writes and submits the self review; Mel, Pat's manager, writes the reviewer part
 * with an overall rating — which a reader of the organization would not see until submitted; HR
 * finalizes; Pat sees the outcome and acknowledges it.
 *
 * Three sign-ins (each session is kept for the whole flow); afterwards the file waits out the
 * sign-in rate-limit window so the attendance spec that follows keeps its budget.
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
    .filter({ hasText: /unable|not found|permission|went wrong|unavailable/i });
  await expect(ready.or(failure).first()).toBeVisible({ timeout: 60_000 });
  await expect(failure).toHaveCount(0);
  await expect(ready).toBeVisible();
}

test('a performance cycle from creation to acknowledgement, with the draft rating kept private', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const p = seed.performance;
  const cycleName = `Teacher review ${seed.suffix} cycle`;
  const hr = await signedIn(browser, p.hr);
  const pat = await signedIn(browser, p.employee);
  const mel = await signedIn(browser, p.manager);
  try {
    // ── HR: create, target and open the cycle ──────────────────────────────
    await firstLoad(hr.page, '/admin/performance#cycles', /performance/i);
    const orgSelect = hr.page.getByLabel('Organization', { exact: true });
    if (await orgSelect.count()) await orgSelect.selectOption({ label: p.organizationName });
    const create = hr.page.getByRole('form', { name: 'Create review cycle' });
    await create.getByLabel('Code').fill(`TR-${seed.suffix}`);
    await create.getByLabel('Name').fill(cycleName);
    await create.getByLabel('Template').selectOption({ label: p.templateName });
    await create.getByLabel('Review period start').fill(p.cycle.periodStart);
    await create.getByLabel('Review period end').fill(p.cycle.periodEnd);
    await create.getByLabel('Window opens').fill(p.cycle.windowStart);
    await create.getByLabel('Window closes').fill(p.cycle.windowEnd);
    await create.getByLabel('Self review due').fill(p.cycle.selfDue);
    await create.getByLabel('Reviewer due').fill(p.cycle.reviewerDue);
    await create.getByRole('button', { name: 'Create cycle' }).click();
    await expect(hr.page.getByText('Review cycle created.')).toBeVisible();
    const cycles = hr.page.getByRole('region', { name: 'Review cycles' });
    const row = cycles.getByRole('row').filter({ hasText: cycleName });
    await row.getByRole('button', { name: 'Add reviews' }).click();
    const add = hr.page.getByRole('dialog', { name: `Add reviews to ${cycleName}` });
    await add.getByRole('combobox', { name: 'Employee assignment' }).fill('Pat');
    await hr.page.getByRole('option', { name: new RegExp(p.employee.name) }).click();
    await add.getByRole('button', { name: 'Add chosen reviews' }).click();
    await expect(add.getByText(/1 added/)).toBeVisible();
    await add.getByRole('button', { name: 'Cancel' }).click();
    await expectNoSeriousA11yViolations(hr.page);
    await row.getByRole('button', { name: 'Open', exact: true }).click();
    await hr.page.getByRole('alertdialog').getByRole('button', { name: 'Open cycle' }).click();
    await expect(hr.page.getByText('Cycle opened.')).toBeVisible();

    // ── Pat: the self review ───────────────────────────────────────────────
    await firstLoad(pat.page, '/performance', 'My performance');
    const mine = pat.page.getByRole('row').filter({ hasText: cycleName });
    await mine.getByRole('link', { name: 'Open' }).click();
    const selfForm = pat.page.getByRole('form', { name: 'Review form' });
    await selfForm.getByLabel(`${p.ratingPrompt} rating`).selectOption('3');
    await selfForm.getByLabel(`${p.textPrompt} answer`).fill('Ran the reading club');
    await selfForm.getByRole('button', { name: 'Submit self review' }).click();
    await pat.page
      .getByRole('alertdialog', { name: 'Submit your self review?' })
      .getByRole('button', { name: 'Submit self review' })
      .click();
    await expect(pat.page.getByText('Submitted.')).toBeVisible();
    const reviewUrl = pat.page.url();

    // ── Mel: the reviewer part with an overall rating ──────────────────────
    await firstLoad(mel.page, '/performance', 'My performance');
    await mel.page.getByRole('tab', { name: /Reviews to write/ }).click();
    await mel.page.getByRole('link', { name: 'Write review' }).click();
    const reviewerForm = mel.page.getByRole('form', { name: 'Review form' });
    await reviewerForm.getByLabel(`${p.ratingPrompt} rating`).selectOption('4');
    await reviewerForm.getByLabel(`${p.textPrompt} answer`).fill('An exceptional year');
    await reviewerForm.getByLabel('Overall rating').selectOption('4');
    await reviewerForm.getByRole('button', { name: 'Save draft' }).click();
    await expect(mel.page.getByText(/saved/i).first()).toBeVisible();
    // Before submission the employee sees no outcome.
    await pat.page.goto(reviewUrl);
    await expect(pat.page.getByText(/Overall rating: 4/)).toHaveCount(0);
    await reviewerForm.getByRole('button', { name: 'Submit review' }).click();
    await mel.page
      .getByRole('alertdialog', { name: 'Submit this review?' })
      .getByRole('button', { name: 'Submit review' })
      .click();
    await expect(mel.page.getByText('Submitted.')).toBeVisible();
    await expectNoSeriousA11yViolations(mel.page);

    // ── HR: finalize ───────────────────────────────────────────────────────
    await hr.page.goto(reviewUrl.replace(/^https?:\/\/[^/]+/, ''));
    const actions = hr.page.getByRole('region', { name: 'HR actions' });
    await expect(actions).toBeVisible({ timeout: 60_000 });
    await actions.getByRole('button', { name: 'Finalize' }).click();
    await hr.page
      .getByRole('alertdialog', { name: 'Finalize this review?' })
      .getByRole('button', { name: 'Finalize review' })
      .click();
    await expect(hr.page.getByText('Review finalized and shared with the employee.')).toBeVisible();

    // ── Pat: the outcome and the acknowledgement ───────────────────────────
    await pat.page.goto(reviewUrl);
    await expect(pat.page.getByText(/Overall rating: 4 — Exceptional/)).toBeVisible({
      timeout: 60_000,
    });
    const ack = pat.page.getByRole('form', { name: 'Acknowledge review' });
    await ack.getByLabel('Comment (optional)').fill('Thank you');
    await ack.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(pat.page.getByText('Review acknowledged.')).toBeVisible();
    await expectNoSeriousA11yViolations(pat.page);
  } finally {
    await hr.context.close();
    await pat.context.close();
    await mel.context.close();
    const wait = lastSignInAt + LOGIN_WINDOW_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
});
