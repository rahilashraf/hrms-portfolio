import { expect, test } from '@playwright/test';
import { API } from './support/api-origin';
import { ALL, checkAt, mockApi, signedIn } from './support/performance-admin-mocks';

/**
 * Batch 7B — performance administration against a mocked, stateful API: a cycle is created,
 * reviews are added from the performance picker, the cycle is opened and closed with a reason;
 * a rating scale used by an active template refuses archiving and names that template; a
 * competency is edited; evidence is recorded, corrected and its history read; an unmatched
 * result (unverified email) is rejected with a reason. axe (serious/critical) and no page-wide
 * horizontal scroll at desktop, tablet and a 375 px phone.
 */

test.describe('Batch 7B performance administration', () => {
  test('cycle: create → targeted add → open → close with a reason', async ({ page }) => {
    const api = mockApi();
    await page.route(`${API}/performance/**`, api.handle);
    await signedIn(page, ALL);
    await page.goto('/admin/performance#cycles');
    await expect(page.getByText('No review cycles yet.')).toBeVisible();
    await checkAt(page);

    const create = page.getByRole('form', { name: 'Create review cycle' });
    await create.getByLabel('Code').fill('ANNUAL-2026');
    await create.getByLabel('Name').fill('Annual review 2026');
    await create.getByLabel('Review period start').fill('2026-01-01');
    await create.getByLabel('Review period end').fill('2026-12-31');
    await create.getByLabel('Window opens').fill('2026-11-01');
    await create.getByLabel('Window closes').fill('2026-12-15');
    await create.getByRole('button', { name: 'Create cycle' }).click();
    await expect(page.getByText('Review cycle created.')).toBeVisible();
    const cycles = page.getByRole('region', { name: 'Review cycles' });
    await expect(cycles.getByText('Annual review 2026')).toBeVisible();

    await cycles.getByRole('button', { name: 'Add reviews' }).click();
    const add = page.getByRole('dialog', { name: 'Add reviews to Annual review 2026' });
    await add.getByRole('combobox', { name: 'Employee assignment' }).focus();
    await page.getByRole('option', { name: /Ada Lovelace/ }).click();
    await expect(add.getByRole('list', { name: 'Chosen employees' })).toContainText('Ada Lovelace');
    await checkAt(page);
    await add.getByRole('button', { name: 'Add chosen reviews' }).click();
    await expect(
      add.getByText('1 added, 0 already in the cycle, 0 without a reviewer.'),
    ).toBeVisible();
    await add.getByRole('button', { name: 'Cancel' }).click();

    await cycles.getByRole('button', { name: 'Show Annual review 2026' }).click();
    const detail = page.getByRole('region', { name: 'Details of Annual review 2026' });
    await expect(
      detail.getByRole('region', { name: 'Reviews of Annual review 2026' }),
    ).toContainText('Ada Lovelace');
    await checkAt(page);

    await cycles.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Open cycle' }).click();
    await expect(page.getByText('Cycle opened.')).toBeVisible();

    await cycles.getByRole('button', { name: 'Close', exact: true }).click();
    const close = page.getByRole('alertdialog', { name: 'Close Annual review 2026?' });
    await close.getByLabel(/Reason/).fill('Calibration complete');
    await checkAt(page);
    await close.getByRole('button', { name: 'Close cycle' }).click();
    await expect(page.getByText('Cycle closed.')).toBeVisible();
    expect(api.state.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /performance/cycles',
      'POST /performance/cycles/cyc-1/reviews',
      'POST /performance/cycles/cyc-1/open',
      'POST /performance/cycles/cyc-1/close',
    ]);
    expect(api.state.calls[1]!.body).toEqual({ assignmentIds: ['asg-1'] });
    expect(api.state.calls[3]!.body).toEqual({
      closeIncomplete: true,
      reason: 'Calibration complete',
    });
  });

  test('configuration: edit a competency; archiving a scale in use names the template', async ({
    page,
  }) => {
    const api = mockApi();
    await page.route(`${API}/performance/**`, api.handle);
    await signedIn(page, ALL);
    await page.goto('/admin/performance#competencies');
    await page.getByRole('button', { name: 'Edit Communication' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit Communication' });
    await edit.getByLabel('Category').fill('Core');
    await checkAt(page);
    await edit.getByRole('button', { name: 'Save competency' }).click();
    await expect(page.getByText('Competency saved.')).toBeVisible();

    await page.getByRole('tab', { name: 'Rating scales' }).click();
    await page.getByRole('button', { name: 'Archive Five point' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archive scale' }).click();
    await expect(
      page.getByText(
        'In use by active templates: Annual review (ANNUAL). Archive or replace those templates first.',
      ),
    ).toBeVisible();
    await checkAt(page);
  });

  test('evidence: record, correct with a reason, read the history', async ({ page }) => {
    const api = mockApi();
    await page.route(`${API}/performance/**`, api.handle);
    await signedIn(page, ALL);
    await page.goto('/admin/performance#records');
    const record = page.getByRole('form', { name: 'Record evidence' });
    await record.getByRole('combobox', { name: 'Employee' }).focus();
    await page.getByRole('option', { name: /Ada Lovelace/ }).click();
    await record.getByLabel('Title').fill('First Aid');
    await record.getByLabel('Completed on').fill('2026-05-20');
    await checkAt(page);
    await record.getByRole('button', { name: 'Record evidence' }).click();
    await expect(page.getByText('Evidence recorded.')).toBeVisible();

    const section = page.getByRole('region', { name: 'Employee evidence' });
    await section.getByRole('combobox', { name: 'Employee' }).focus();
    await page.getByRole('option', { name: /Ada Lovelace/ }).click();
    await section.getByRole('button', { name: 'Correct First Aid' }).click();
    const correct = page.getByRole('dialog', { name: 'Correct First Aid' });
    await correct.getByLabel('Title').fill('First Aid (CPR)');
    await correct.getByLabel('Reason for the correction').fill('Course name');
    await checkAt(page);
    await correct.getByRole('button', { name: 'Save correction' }).click();
    await expect(page.getByText('Evidence corrected.')).toBeVisible();

    await section.getByRole('button', { name: 'History of First Aid (CPR)' }).click();
    const history = page.getByRole('dialog', { name: 'History of First Aid (CPR)' });
    await expect(history.getByText('Reason: Course name')).toBeVisible();
    await expect(history.getByText(/Recorded by Hana HR · superseded/)).toBeVisible();
    await checkAt(page);
    const correction = api.state.calls.find((c) => c.path.endsWith('/correct'));
    expect(correction?.body).toMatchObject({ title: 'First Aid (CPR)', reason: 'Course name' });
  });

  test('intake: an unverified email is quarantined and rejected with a reason', async ({
    page,
  }) => {
    const api = mockApi();
    await page.route(`${API}/performance/**`, api.handle);
    await signedIn(page, ALL);
    await page.goto('/admin/performance#intake');
    const results = page.getByRole('region', { name: 'Imported results' });
    await expect(results.getByText('Unverified', { exact: true })).toBeVisible();
    await expect(results.getByText('visitor@example.org')).toBeVisible();
    await checkAt(page);
    await results.getByRole('button', { name: 'Reject resp-1' }).click();
    const reject = page.getByRole('alertdialog', { name: 'Reject resp-1?' });
    await reject.getByLabel(/Reason/).fill('A visitor, not staff');
    await checkAt(page);
    await reject.getByRole('button', { name: 'Reject result' }).click();
    await expect(page.getByText('Every imported result is matched to an employee.')).toBeVisible();
    expect(api.state.calls).toEqual([
      {
        method: 'POST',
        path: '/performance/evidence-intake/in-1/resolve',
        body: { action: 'REJECT', note: 'A visitor, not staff' },
      },
    ]);
  });
});
