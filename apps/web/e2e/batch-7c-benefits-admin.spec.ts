import { expect, test } from '@playwright/test';
import { API } from './support/api-origin';
import { benefitsWorld, checkAt, json, signedIn } from './support/benefits-admin-mocks';

/**
 * Batch 7C — benefits administration against a mocked, stateful API: a plan is created with
 * every field and edited; a coverage option is edited; a rate is corrected with a reason; an
 * eligibility rule is added from the department picker (shown by name) and ended; the plan is
 * closed after confirmation and discontinued with a reason (elections kept by default). axe
 * (serious/critical) and no page-wide horizontal scroll at desktop, tablet and a 375 px phone.
 */

test('a plan manager configures a plan end to end with confirmations and named pickers', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const world = benefitsWorld(page);
  await world.install();
  await signedIn(page, ['benefit.plan.manage', 'benefit.read']);
  await page.goto('/admin/benefits');
  await expect(page.getByRole('heading', { name: 'Benefits', level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('tabpanel')).toBeVisible();

  // ── A plan with every field ──────────────────────────────────────────────
  const create = page.getByRole('form', { name: 'Create benefit plan' });
  await create.getByLabel('Code').fill('HEALTH');
  await create.getByLabel('Name').fill('Health');
  await create.getByLabel('Effective from').fill('2026-01-01');
  await create.getByLabel('Provider (optional)').fill('Carrier');
  await create.getByLabel('Provider reference (optional)').fill('GRP-1');
  await create.getByLabel('Description (optional)').fill('Extended health');
  await create.getByLabel('Show the employer cost to employees').check();
  await checkAt(page);
  await create.getByRole('button', { name: 'Create plan' }).click();
  await expect(page.getByText('Benefit plan created.')).toBeVisible();
  await page.getByRole('button', { name: 'Open Health' }).click();
  const region = page.getByRole('region', { name: 'Health plan' });
  await expect(region.getByText('GRP-1')).toBeVisible();

  // Draft: the start date is editable; the code never is.
  await region.getByRole('button', { name: 'Edit plan' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Health' });
  await expect(edit.getByLabel('Effective from')).toBeVisible();
  await edit.getByLabel('Provider reference').fill('GRP-2');
  await edit.getByRole('button', { name: 'Save plan' }).click();
  await expect(page.getByText('Plan updated.')).toBeVisible();

  // ── Option, rate and a correction ────────────────────────────────────────
  const option = page.getByRole('form', { name: 'Add coverage option' });
  await option.getByLabel('Option code').fill('SINGLE');
  await option.getByLabel('Option name').fill('Single');
  await option.getByRole('button', { name: 'Add option' }).click();
  await expect(page.getByText('Coverage option added.')).toBeVisible();
  await region.getByRole('button', { name: 'Edit option Single' }).click();
  const optionDialog = page.getByRole('dialog', { name: 'Edit option Single' });
  await optionDialog.getByLabel('Option name').fill('Employee only');
  await optionDialog.getByRole('button', { name: 'Save option' }).click();
  await expect(page.getByText('Coverage option updated.')).toBeVisible();
  const rateForm = page.getByRole('form', { name: 'Add rate' });
  await rateForm.getByLabel('Rate effective from').fill('2026-01-01');
  await rateForm.getByLabel('Employee amount').fill('25.00');
  await rateForm.getByLabel('Employer amount').fill('75.00');
  await rateForm.getByRole('button', { name: 'Add rate' }).click();
  await expect(page.getByText('Rate added.')).toBeVisible();
  await region.getByRole('button', { name: /^Correct Employee only rate from/ }).click();
  const correct = page.getByRole('dialog', { name: 'Correct the Employee only rate' });
  await correct.getByLabel('Employee amount (CAD)').fill('26.00');
  await expect(correct.getByRole('button', { name: 'Correct rate' })).toBeDisabled();
  await correct.getByLabel('Reason for the correction').fill('Carrier invoice');
  await checkAt(page);
  await correct.getByRole('button', { name: 'Correct rate' }).click();
  await expect(page.getByText('Rate corrected.')).toBeVisible();
  await expect(region.getByText('Superseded rates (1)')).toBeVisible();

  // ── Eligibility by name ──────────────────────────────────────────────────
  const ruleForm = page.getByRole('form', { name: 'Add eligibility rule' });
  await ruleForm.getByLabel('Rule effective from').fill('2026-01-01');
  await ruleForm.getByRole('combobox', { name: 'Department (optional)' }).click();
  await page.getByRole('option', { name: /Dept A/ }).click();
  await ruleForm.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByText('Eligibility rule added.')).toBeVisible();
  await expect(region.getByText('Department: Dept A')).toBeVisible();
  await region.getByRole('button', { name: /^End rule from 2026-01-01/ }).click();
  const endRule = page.getByRole('dialog', { name: 'End this eligibility rule?' });
  await endRule.getByLabel('Last day of the rule').fill('2026-12-31');
  await endRule.getByRole('button', { name: 'End rule' }).click();
  await expect(page.getByText('Eligibility rule ended.')).toBeVisible();

  // ── Activation, closure and discontinuation, confirmed ───────────────────
  await region.getByRole('button', { name: 'Activate' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Activate plan' }).click();
  await expect(page.getByText('Plan activated.')).toBeVisible();
  await region.getByRole('button', { name: 'Close to new elections' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close plan' }).click();
  await expect(page.getByText('Plan closed to new elections.')).toBeVisible();
  await region.getByRole('button', { name: 'Discontinue…' }).click();
  const discontinue = page.getByRole('dialog', { name: 'Discontinue Health?' });
  await discontinue.getByLabel('Last day of the plan').fill('2026-12-31');
  await discontinue.getByLabel('Reason').fill('Carrier exit');
  await expect(discontinue.getByRole('checkbox')).not.toBeChecked();
  await checkAt(page);
  await discontinue.getByRole('button', { name: 'Discontinue plan' }).click();
  await expect(page.getByText('Plan discontinued.')).toBeVisible();
  await checkAt(page);

  const sent = (suffix: string) =>
    world.calls.filter((call) => call.path.endsWith(suffix)).map((call) => call.body);
  expect(sent('/benefits/plans')[0]).toMatchObject({
    providerReference: 'GRP-1',
    description: 'Extended health',
    showEmployerCostToEmployee: true,
  });
  expect(
    world.calls.find((call) => call.method === 'PATCH' && call.path.endsWith('plan-1'))?.body,
  ).not.toHaveProperty('code');
  expect(sent('/correct')).toEqual([
    expect.objectContaining({ employeeAmount: '26.00', reason: 'Carrier invoice' }),
  ]);
  expect(sent('/eligibility-rules')[0]).toMatchObject({ departmentId: 'dept-a' });
  expect(sent('/discontinue')).toEqual([
    { effectiveTo: '2026-12-31', endElections: false, reason: 'Carrier exit' },
  ]);
});

test('a benefits reader sees plans read-only and Benefits being turned off with a retry', async ({
  page,
}) => {
  test.setTimeout(120_000);
  let attempts = 0;
  await page.route(`${API}/benefits/organizations`, (route) =>
    json(route, {
      items: [
        {
          id: 'org-1',
          name: 'Camp',
          code: 'CAMP',
          timezone: 'America/Toronto',
          actions: { canManagePlans: false },
        },
      ],
    }),
  );
  await page.route(`${API}/benefits/attention?*`, (route) => json(route, { items: [] }));
  await page.route(`${API}/benefits/plans?*`, (route) => {
    attempts += 1;
    return attempts === 1
      ? json(route, { code: 'FEATURE_DISABLED', message: 'Disabled' }, 403)
      : json(route, { items: [] });
  });
  await signedIn(page, ['benefit.read']);
  await page.goto('/admin/benefits');
  const alert = page.getByRole('main').getByRole('alert');
  await expect(alert).toContainText('turned off', { timeout: 60_000 });
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText(/No current benefit plans/)).toBeVisible();
  await expect(page.getByRole('form', { name: 'Create benefit plan' })).toHaveCount(0);
  await checkAt(page);
});
