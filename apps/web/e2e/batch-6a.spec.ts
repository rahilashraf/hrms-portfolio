import { expect, test } from '@playwright/test';
import { API } from './support/api-origin';
import {
  GROUP,
  ORG,
  checkAt,
  json,
  path,
  payrollServer,
  prefix,
  session,
} from './support/payroll-mocks';

/**
 * Batch 6A — the payroll workflow end to end against a stateful mocked API: pay calendar
 * (create, edit, end) → pay period → run → off-cycle adjustment (create, and cancel another) →
 * calculate → approve (confirmed) → finalize (confirmed) → payslip (printable) → payroll
 * register in Reports (CSV). Totals agree everywhere and the adjustment is counted once. axe
 * (serious/critical) and no page-wide horizontal scroll at desktop, tablet and a 375 px phone.
 */

test('payroll workflow: calendar → period → run → adjustments → approve → finalize → payslip → register', async ({
  page,
}) => {
  await session(page);
  const server = payrollServer();
  await server.install(page);
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => {
      (window as unknown as { __printed: number }).__printed += 1;
    };
  });

  await page.goto('/admin/payroll?tab=calendars');
  await expect(page.getByRole('heading', { name: 'Payroll', exact: true })).toBeVisible();

  // ── Calendar: create, edit (no periods yet) ────────────────────────────────
  const create = page.getByRole('form', { name: 'New pay calendar' });
  await create.getByLabel('First period starts').fill('2026-10-04');
  await create.getByRole('button', { name: 'Create calendar' }).click();
  await expect(page.getByText('Pay calendar created.')).toBeVisible();
  await page.getByRole('button', { name: 'Edit calendar for Biweekly' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Biweekly calendar' });
  await checkAt(page);
  await edit.getByLabel('Pay date offset (days)').fill('5');
  await edit.getByRole('button', { name: 'Save calendar' }).click();
  await expect(page.getByText('Pay calendar updated.')).toBeVisible();

  // ── Pay period and run ─────────────────────────────────────────────────────
  await page.getByRole('tab', { name: 'Pay periods' }).click();
  const generate = page.getByRole('form', { name: 'Generate pay periods' });
  await generate.getByLabel('Generate through').fill('2026-10-17');
  await generate.getByRole('button', { name: 'Generate periods' }).click();
  await expect(page.getByText('Pay periods generated.')).toBeVisible();
  await expect(page.getByLabel('Currency for new runs')).toHaveValue('CAD');
  await page.getByRole('button', { name: 'Create CAD run' }).click();
  await expect(page.getByText('Payroll run created.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open CAD run' })).toBeVisible();
  // Another currency selected: the CAD run stays listed.
  await page.getByLabel('Currency for new runs').fill('USD');
  await expect(page.getByRole('link', { name: 'Open CAD run' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create USD run' })).toBeVisible();
  await checkAt(page);

  // ── Off-cycle adjustments: one paid, one cancelled ─────────────────────────
  await page.getByRole('tab', { name: 'Adjustments' }).click();
  for (const [amount, description] of [
    ['150.00', 'Referral bonus'],
    ['999.00', 'Entered twice'],
  ]) {
    await page.getByRole('button', { name: 'New adjustment' }).click();
    const dialog = page.getByRole('dialog', { name: 'New off-cycle adjustment' });
    await expect(dialog.getByLabel('Employee and assignment')).toHaveValue('asg-1');
    if (description === 'Referral bonus') await checkAt(page);
    await dialog.getByLabel(/^Amount/).fill(amount!);
    await dialog.getByLabel(/^Description/).fill(description!);
    await dialog.getByLabel(/^Reason/).fill('Batch 6A workflow');
    await dialog.getByRole('button', { name: 'Create adjustment' }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(page.getByRole('cell', { name: /^Referral bonus/ })).toBeVisible();
  await page
    .getByRole('button', { name: 'Cancel adjustment Entered twice for Ada Lovelace' })
    .click();
  const cancel = page.getByRole('alertdialog', { name: 'Cancel this adjustment?' });
  await cancel.getByLabel(/Reason/).fill('Entered twice by mistake');
  await cancel.getByRole('button', { name: 'Cancel adjustment' }).click();
  await expect(page.getByText('Adjustment cancelled.')).toBeVisible();
  await expect(page.getByRole('cell', { name: /^Entered twice/ })).toHaveCount(0);
  expect(server.state.adjustments.map((a) => [a.description, a.status])).toEqual([
    ['Referral bonus', 'PENDING'],
    ['Entered twice', 'CANCELLED'],
  ]);

  // ── Run: calculate → approve (confirmed) → finalize (confirmed) ───────────
  await page.goto('/admin/payroll/runs/run-1');
  await page.getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByText('Run calculated.')).toBeVisible();
  await expect(page.getByText('CAD 2,150.00').first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  const approve = page.getByRole('alertdialog', { name: 'Approve this payroll run?' });
  await expect(approve).toContainText('gross CAD 2,150.00, 1 employee(s)');
  await checkAt(page);
  await approve.getByRole('button', { name: 'Approve run' }).click();
  await expect(page.getByText('Run approved.')).toBeVisible();
  await page.getByRole('button', { name: 'Finalize' }).click();
  await page
    .getByRole('alertdialog', { name: 'Finalize this payroll run?' })
    .getByRole('button', { name: 'Finalize run' })
    .click();
  await expect(page.getByText('Run finalized.')).toBeVisible();
  expect(server.state.adjustments.map((a) => a.status)).toEqual(['APPLIED', 'CANCELLED']);

  // ── Payslip: adjustment once, benefit deduction, no net pay; printable ────
  await page.getByRole('tab', { name: 'Employees' }).click();
  await page.getByRole('button', { name: 'Payslip for Ada Lovelace' }).click();
  const slip = page.getByRole('article', {
    name: 'Pay statement for Ada Lovelace, pay date 10/22/2026',
  });
  await expect(slip.getByText('Referral bonus')).toHaveCount(1);
  await expect(slip.getByText('Adjustment · Counsellor')).toBeVisible();
  await expect(slip.getByText('Benefit deduction')).toBeVisible();
  await expect(slip.getByText('CAD 2,150.00')).toBeVisible();
  await expect(slip.getByText('Not calculated', { exact: true })).toBeVisible();
  await expect(slip.getByText(/Preview/)).toHaveCount(0);
  await checkAt(page);
  await slip.getByRole('button', { name: 'Print or save as PDF' }).click();
  expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1);
  // Print styling: only the statement prints, without its buttons.
  await page.emulateMedia({ media: 'print' });
  await expect(slip.getByRole('button', { name: 'Print or save as PDF' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
  await expect(slip.getByText('Referral bonus')).toBeVisible();
  await page.emulateMedia({ media: 'screen' });

  // ── Register: from the Runs tab into Reports; totals match; CSV ───────────
  await page.goto('/admin/payroll');
  await page.getByRole('tab', { name: 'Runs' }).click();
  await page.getByRole('link', { name: /Payroll register/ }).click();
  await expect(page.getByRole('heading', { name: 'Payroll register' })).toBeVisible();
  await page.getByLabel('From', { exact: true }).fill('2026-10-01');
  await page.getByLabel('To', { exact: true }).fill('2026-10-31');
  await page.getByRole('button', { name: 'Run report' }).click();
  const table = page.getByRole('table', { name: 'Payroll register' });
  await expect(table.getByRole('row', { name: /Ada Lovelace/ })).toContainText('2,150.00');
  await expect(table.getByRole('row', { name: /Ada Lovelace/ })).toContainText('Not calculated');
  await expect(
    table.getByRole('columnheader', { name: 'Gross less recorded deductions (NOT net pay)' }),
  ).toBeVisible();
  await expect(page.getByText(/already included in Gross/)).toBeVisible();
  await checkAt(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toBe('payroll.register-2026-10-21.csv');
  expect(server.state.csvQuery).toMatchObject({
    organizationId: ORG,
    from: '2026-10-01',
    to: '2026-10-31',
  });

  // ── End the calendar (it has a period): no earlier than its last period ───
  await page.goto('/admin/payroll?tab=calendars');
  await expect(page.getByText('Rules fixed: periods generated')).toBeVisible();
  await page.getByRole('button', { name: 'End calendar for Biweekly' }).click();
  const end = page.getByRole('dialog', { name: 'End the Biweekly calendar?' });
  await expect(end).toContainText('1 pay period has been generated, the last ending 10/17/2026');
  await checkAt(page);
  await end.getByLabel('Last day of the calendar').fill('2026-10-10');
  await expect(end.getByRole('button', { name: 'End calendar' })).toBeDisabled();
  await end.getByLabel('Last day of the calendar').fill('2026-12-31');
  await end.getByRole('button', { name: 'End calendar' }).click();
  await expect(page.getByText('Pay calendar ends 12/31/2026.')).toBeVisible();
});

test('a payroll reader sees permission-limited screens and a clear error when an action is refused', async ({
  page,
}) => {
  await session(page);
  const server = payrollServer();
  await server.install(page);
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId: 'payroll-admin',
      permissions: ['payroll.read', 'payroll.adjust'].map((key) => ({
        key,
        scopes: [{ type: 'ORGANIZATION', id: ORG }],
      })),
    }),
  );
  server.state.adjustments.push({
    id: 'adj-9',
    payGroupId: GROUP,
    employeeId: 'emp-1',
    employmentAssignmentId: 'asg-1',
    currency: 'CAD',
    kind: 'EARNING',
    amount: '50.00',
    description: 'Late claim',
    reason: 'Claim',
    status: 'PENDING',
    sourceRunId: null,
    payrollRunId: null,
    retroactive: false,
    createdAt: '2026-10-18T12:00:00.000Z',
    displayName: 'Ada Lovelace',
    employeeNumber: 'E-100',
    positionName: 'Counsellor',
  });
  await page.route(path('/payroll/organizations'), (route) =>
    json(route, {
      items: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          actions: {
            canRead: true,
            canManage: false,
            canCalculate: false,
            canApprove: false,
            canFinalize: false,
            canAdjust: true,
          },
        },
      ],
    }),
  );
  await page.route(prefix('/payroll/adjustments/'), (route) =>
    json(
      route,
      { statusCode: 403, code: 'PAYROLL_SELF_ADJUSTMENT', message: 'internal text' },
      403,
    ),
  );
  await page.goto('/admin/payroll?tab=adjustments');
  await page.getByRole('button', { name: 'Cancel adjustment Late claim for Ada Lovelace' }).click();
  const cancel = page.getByRole('alertdialog', { name: 'Cancel this adjustment?' });
  await cancel.getByLabel(/Reason/).fill('Not owed');
  await cancel.getByRole('button', { name: 'Cancel adjustment' }).click();
  await expect(
    page.getByText(
      'You cannot change your own pay. Ask another payroll administrator to make this change.',
    ),
  ).toBeVisible();
  await expect(page.getByText('internal text')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Calendars' }).click();
  await expect(page.getByRole('form', { name: 'New pay calendar' })).toHaveCount(0);
  await checkAt(page);
});
