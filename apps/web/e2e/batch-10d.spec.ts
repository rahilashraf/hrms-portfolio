import { expect, test, type Page } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';
import { calculatedRun, json, ORG, path } from './support/payroll-mocks';

/**
 * Batch 10D — payroll screens against the stateful mocked payroll API (batch 6A's):
 * - /admin/payroll keeps its `?tab=` deep links, writes the picked tab into the URL (other
 *   parameters kept) and follows Back/Forward; the run page's sections get the same `?tab=`;
 * - loading, never "Access denied", in the page's own width while permissions load;
 * - every payroll table scrolls inside a named, focusable region (axe
 *   `scrollable-region-focusable` on the pay groups table at 375 px before);
 * - approve/finalize confirmations, validation issues, read-only users and My pay at
 *   1280/820/375 px with axe (serious/critical) and no page-wide horizontal scroll.
 */
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;

async function pageOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function checkAtAllWidths(page: Page, ready: () => Promise<void>) {
  for (const size of [VIEWPORTS.desktop, VIEWPORTS.tablet, VIEWPORTS.phone]) {
    await page.setViewportSize(size);
    await ready();
    await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(1);
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

/** Every horizontally scrolling table container is a named, focusable region (tab strips, whose
 * tabs are focusable themselves, are not tables). */
async function scrollersAreAccessible(page: Page) {
  const offenders = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('main *'))
      .filter((el) => {
        const style = getComputedStyle(el);
        return (
          (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          el.scrollWidth > el.clientWidth + 1 &&
          el.querySelector('table') !== null
        );
      })
      .filter(
        (el) =>
          !(el.getAttribute('role') === 'region' && el.getAttribute('aria-label')) ||
          el.tabIndex < 0,
      )
      .map((el) => el.className),
  );
  expect(offenders).toEqual([]);
}

async function readerPermissions(page: Page, keys: string[]) {
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId: 'payroll-admin',
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    }),
  );
}

// ─── Payroll administration (/admin/payroll) ────────────────────────────────

const adminTab = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Payroll sections' }).getByRole('tab', { name, exact: true });

test('/admin/payroll: ?tab= deep links, picking a tab and Back/Forward follow the URL', async ({
  page,
}) => {
  await calculatedRun(page);
  await page.goto('/admin/payroll?tab=calendars&from=run-guidance');
  await expect(adminTab(page, 'Calendars')).toHaveAttribute('aria-selected', 'true');
  // Picking a tab writes it (other parameters kept); the first tab needs no parameter.
  await adminTab(page, 'Runs').click();
  await expect(page).toHaveURL(/\/admin\/payroll\?tab=runs&from=run-guidance$/);
  await adminTab(page, 'Overview').click();
  await expect(page).toHaveURL(/\/admin\/payroll\?from=run-guidance$/);
  // Back/Forward and new history entries follow the URL.
  await page.goto('/admin/payroll?tab=periods');
  await expect(adminTab(page, 'Pay periods')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(adminTab(page, 'Overview')).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(adminTab(page, 'Pay periods')).toHaveAttribute('aria-selected', 'true');
  // An unknown tab opens the first one.
  await page.goto('/admin/payroll?tab=not-a-tab');
  await expect(adminTab(page, 'Overview')).toHaveAttribute('aria-selected', 'true');
});

test('/admin/payroll: every section fits, passes axe, and its tables scroll in named regions', async ({
  page,
}) => {
  await calculatedRun(page);
  for (const tab of ['overview', 'pay-groups', 'calendars', 'periods', 'runs', 'adjustments']) {
    await page.goto(`/admin/payroll?tab=${tab}`);
    const panel = page.getByRole('tabpanel');
    await expect(panel).toBeVisible();
    await checkAtAllWidths(page, () => expect(panel).toBeVisible());
    await page.setViewportSize(VIEWPORTS.phone);
    await scrollersAreAccessible(page);
    await page.setViewportSize(VIEWPORTS.desktop);
  }
});

// ─── A payroll run (/admin/payroll/runs/:id) ───────────────────────────────

const runTab = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Run sections' }).getByRole('tab', { name, exact: true });

test('a run: ?tab= deep links its sections; the Employees row buttons and Back/Forward follow', async ({
  page,
}) => {
  await calculatedRun(page);
  await page.goto('/admin/payroll/runs/run-1?tab=validation');
  await expect(runTab(page, 'Validation')).toHaveAttribute('aria-selected', 'true');
  await runTab(page, 'Employees').click();
  await expect(page).toHaveURL(/\/admin\/payroll\/runs\/run-1\?tab=employees$/);
  // The API's amounts, formatted as before (nothing is recomputed in the table).
  await expect(page.getByRole('region', { name: 'Employees in this run' })).toContainText(
    'CAD 2,000.00',
  );
  await page
    .getByRole('button', { name: /^Earnings for / })
    .first()
    .click();
  await expect(runTab(page, 'Earnings')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\?tab=earnings$/);
  await page.goto('/admin/payroll/runs/run-1?tab=deductions');
  await expect(runTab(page, 'Deductions')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(runTab(page, 'Earnings')).toHaveAttribute('aria-selected', 'true');
  await runTab(page, 'Summary').click();
  await expect(page).toHaveURL(/\/admin\/payroll\/runs\/run-1$/);
});

test('a run: every section fits, passes axe, and its tables scroll in named regions', async ({
  page,
}) => {
  await calculatedRun(page);
  for (const tab of [
    'summary',
    'employees',
    'earnings',
    'deductions',
    'payslip',
    'validation',
    'adjustments',
  ]) {
    await page.goto(`/admin/payroll/runs/run-1?tab=${tab}`);
    const panel = page.getByRole('tabpanel');
    await expect(panel).toBeVisible();
    await checkAtAllWidths(page, () => expect(panel).toBeVisible());
    await page.setViewportSize(VIEWPORTS.phone);
    await scrollersAreAccessible(page);
    await page.setViewportSize(VIEWPORTS.desktop);
  }
});

test('a run: validation issues say their severity in words, and a run with errors still loads', async ({
  page,
}) => {
  await calculatedRun(page);
  await page.route(path('/payroll/runs/run-1/issues'), (route) =>
    json(route, {
      items: [
        {
          id: 'issue-1',
          severity: 'ERROR',
          code: 'MISSING_COMPENSATION',
          message: 'Ada Lovelace has no compensation in effect for this period.',
          employee: { id: 'emp-1', displayName: 'Ada Lovelace', employeeNumber: 'E-100' },
          assignment: { id: 'asg-1', positionName: 'Counsellor' },
        },
        {
          id: 'issue-2',
          severity: 'WARNING',
          code: 'OVERTIME_REVIEW',
          message: 'Overtime above the usual range.',
          employee: null,
          assignment: null,
        },
      ],
    }),
  );
  await page.goto('/admin/payroll/runs/run-1?tab=validation');
  const region = page.getByRole('region', { name: 'Validation issues' });
  await expect(region.getByText('Error', { exact: true })).toBeVisible();
  await expect(region.getByText('Warning', { exact: true })).toBeVisible();
  await expect(region.getByText('MISSING_COMPENSATION')).toBeVisible();
  await checkAtAllWidths(page, () => expect(region).toBeVisible());
});

test('a run: approve and finalize ask first, and actions stay disabled while a request runs', async ({
  page,
}) => {
  await calculatedRun(page);
  let releaseApprove: () => void = () => undefined;
  const approveGate = new Promise<void>((resolve) => {
    releaseApprove = resolve;
  });
  let approvals = 0;
  await page.route(path('/payroll/runs/run-1/approve'), async (route) => {
    approvals += 1;
    await approveGate;
    await route.fallback();
  });
  await page.goto('/admin/payroll/runs/run-1');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Approve this payroll run?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('gross');
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize(VIEWPORTS.phone);
  await expect(dialog.getByRole('button', { name: 'Approve run' })).toBeInViewport();
  await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(1);
  await page.setViewportSize(VIEWPORTS.desktop);
  await dialog.getByRole('button', { name: 'Approve run' }).click();
  // While the approval is in flight, the run actions cannot be pressed again.
  await expect(page.getByRole('button', { name: 'Recalculate' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  releaseApprove();
  await expect(page.getByText('Run approved.')).toBeVisible();
  expect(approvals).toBe(1);
  await page.getByRole('button', { name: 'Finalize', exact: true }).click();
  const finalize = page.getByRole('alertdialog', { name: 'Finalize this payroll run?' });
  await expect(finalize).toBeVisible();
  await finalize.getByRole('button', { name: 'Cancel' }).click();
  await expect(finalize).toBeHidden();
  await expect(page.getByRole('button', { name: 'Finalize', exact: true })).toBeFocused();
});

test('a payroll reader sees the run without any action button', async ({ page }) => {
  const run = await calculatedRun(page);
  run.state.run = { status: 'FINALIZED', calculated: true };
  await readerPermissions(page, ['payroll.read']);
  await page.goto('/admin/payroll/runs/run-1');
  await expect(runTab(page, 'Summary')).toHaveAttribute('aria-selected', 'true');
  for (const name of ['Calculate', 'Recalculate', 'Approve', 'Finalize', 'Void']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await checkAtAllWidths(page, () => expect(runTab(page, 'Summary')).toBeVisible());
});

// ─── Loading and access ────────────────────────────────────────────────────

for (const target of [
  { path: '/admin/payroll', heading: 'Payroll' },
  { path: '/admin/payroll/runs/run-1', heading: /^Pay period/ },
]) {
  test(`${target.path}: loading, never "Access denied", in the page's width while permissions load`, async ({
    page,
  }) => {
    await calculatedRun(page);
    await page.route(`${API}/auth/me/authorization`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await json(route, {
        userId: 'payroll-admin',
        permissions: ['payroll.read', 'payroll.approve'].map((key) => ({
          key,
          scopes: [{ type: 'ORGANIZATION', id: ORG }],
        })),
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(target.path, { waitUntil: 'commit' });
    const h1 = page.getByRole('heading', { level: 1, name: target.heading });
    const widths: number[] = [];
    let sawDenied = false;
    for (let i = 0; i < 100 && !(await h1.isVisible().catch(() => false)); i += 1) {
      const sample = await page
        .evaluate(() => {
          const first = document.querySelector('main')?.firstElementChild as HTMLElement | null;
          return {
            width: first ? Math.round(first.getBoundingClientRect().width) : 0,
            denied: /Access denied/.test(document.body.innerText),
          };
        })
        .catch(() => ({ width: 0, denied: false }));
      if (sample.width) widths.push(sample.width);
      sawDenied ||= sample.denied;
      await page.waitForTimeout(40);
    }
    await expect(h1).toBeVisible();
    const loaded = await page.evaluate(() =>
      Math.round(
        (document.querySelector('main')?.firstElementChild as HTMLElement).getBoundingClientRect()
          .width,
      ),
    );
    expect(sawDenied).toBe(false);
    expect([...new Set([...widths, loaded])]).toEqual([loaded]);
  });
}

test('without a payroll permission, payroll pages show the denied state (no payroll data)', async ({
  page,
}) => {
  await calculatedRun(page);
  await readerPermissions(page, ['employee.read']);
  const payrollRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === API && url.pathname.startsWith('/payroll/'))
      payrollRequests.push(url.pathname);
  });
  for (const target of ['/admin/payroll', '/admin/payroll/runs/run-1']) {
    await page.goto(target);
    await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeVisible();
    await expect(page.getByText('Biweekly')).toHaveCount(0);
  }
  // No payroll data is even requested before or after the denial.
  expect(payrollRequests).toEqual([]);
});

// ─── My pay (/pay) ─────────────────────────────────────────────────────────

test('My pay: the statement list fits, passes axe and scrolls in a named region', async ({
  page,
}) => {
  await calculatedRun(page);
  await readerPermissions(page, []);
  await page.route(`${API}/payroll/me/pay`, (route) =>
    json(route, {
      netPayExplanation: 'Net pay is not shown: statutory deductions are not calculated.',
      items: [
        {
          id: 're-1',
          payrollRunId: 'run-1',
          employer: 'Northwind Academy of Performing Arts and Outdoor Education',
          currency: 'CAD',
          payDate: '2026-10-22',
          periodStart: '2026-10-04',
          periodEnd: '2026-10-17',
          grossAmount: '2000.00',
          deductionAmount: '0.00',
          netAmount: null,
        },
      ],
    }),
  );
  await page.goto('/pay');
  const h1 = page.getByRole('heading', { level: 1, name: 'My pay statements' });
  await expect(page.getByText(/2,000\.00/).first()).toBeVisible();
  await checkAtAllWidths(page, () => expect(h1).toBeVisible());
  await page.setViewportSize(VIEWPORTS.phone);
  await scrollersAreAccessible(page);
});
