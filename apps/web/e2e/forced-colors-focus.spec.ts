import { expect, test, type Page } from '@playwright/test';
import { API } from './support/api-origin';
import { ROUTES } from './support/acceptance-routes';
import { expectNoSeriousA11yViolations } from './support/axe';
import {
  expectFocusIndicators,
  expectFocusedIndicator,
  readFocus,
  type FocusMode,
} from './support/focus';
import { type KioskMock, mockKiosk } from './support/kiosk-mocks';
import { json, path, session as workforceSession } from './support/workforce-mocks';
import { calculatedRun } from './support/payroll-mocks';

/**
 * Batch 11C — keyboard focus stays visible in ordinary display and in Windows forced-colours
 * mode (emulated: `forced-colors: active`, which removes box-shadow rings and applies system
 * colours). Controls that draw a ring use Tailwind's `outline-hidden`, whose transparent outline
 * the system paints in forced colours; `outline-none` would leave nothing. See
 * src/app/globals.css and src/lib/a11y/focus-classes.test.ts.
 *
 * Covered: every route of the UI acceptance table (administration, scheduling, payroll,
 * recruitment, onboarding, performance, benefits, notifications, documents…), the shell
 * navigation, sign-in, the employee directory, tabs, a confirmation dialog, the access-denied
 * state and the kiosk. Emulation is Chromium's, not a real Windows high-contrast session.
 */

// FOCUS_MODES=forced (or ordinary) runs one mode only, e.g. to compare against older code.
const MODES: FocusMode[] = process.env.FOCUS_MODES
  ? (process.env.FOCUS_MODES.split(',') as FocusMode[])
  : ['ordinary', 'forced'];

async function applyMode(page: Page, mode: FocusMode) {
  await page.emulateMedia({ forcedColors: mode === 'forced' ? 'active' : 'none' });
}

/** Restarts the keyboard walk at the top of main (the skip-link target). */
async function fromMain(page: Page) {
  await page.locator('#main-content').focus();
}

test.describe('Focus indicators: routes (ordinary and forced colours)', () => {
  for (const route of ROUTES) {
    test(`[${route.area}] ${route.path}`, async ({ page }) => {
      await route.setup(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(route.path);
      await expect(route.ready(page)).toBeVisible();
      for (const mode of MODES) {
        await applyMode(page, mode);
        await fromMain(page);
        // Every route has at least one focusable control in main except notification preferences
        // while each category is mandatory; the shell is checked separately below.
        await expectFocusIndicators(page, {
          mode,
          stops: 10,
          minimum: route.path === '/notifications/preferences' ? 0 : 1,
        });
      }
    });
  }
});

test.describe('Focus indicators: shell, sign-in, employees, tabs, dialogs, denied, kiosk', () => {
  test('shell navigation: skip link, brand, sidebar links, organization and account controls', async ({
    page,
  }) => {
    await workforceSession(page, ['employee.read', 'time.clock']);
    await page.route(path('/dashboard'), (route) =>
      json(route, { organizationId: 'org-1', cards: [], self: null, quickActions: [] }),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const mode of MODES) {
      await applyMode(page, mode);
      // A fresh page, so Tab starts at the top: the skip link, the sidebar, the account panel.
      await page.goto('/dashboard');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const seen = await expectFocusIndicators(page, { mode, stops: 30, scope: null });
      expect(seen.some((label) => /^a .*Skip/i.test(label))).toBe(true);
      expect(seen.filter((label) => label.startsWith('a ')).length).toBeGreaterThan(2);
    }
  });

  test('sign-in: email, password, show-password and the submit button', async ({ page }) => {
    await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
    await page.route(`${API}/auth/refresh`, (route) => json(route, {}, 401));
    for (const mode of MODES) {
      await applyMode(page, mode);
      await page.goto('/login');
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
      const seen = await expectFocusIndicators(page, { mode, stops: 6, scope: null });
      expect(seen.some((label) => label.startsWith('input'))).toBe(true);
      await page.getByRole('button', { name: 'Sign in' }).focus();
      await expectFocusedIndicator(page, mode);
    }
    await applyMode(page, 'ordinary');
    await expectNoSeriousA11yViolations(page);
  });

  test('employee directory: search, filters, the table and its links', async ({ page }) => {
    await workforceSession(page, ['employee.read']);
    await page.route(`${API}/employees**`, (route) =>
      json(route, {
        items: [
          {
            id: 'employee-1',
            employeeNumber: 'EMP-000001',
            status: 'ACTIVE',
            person: {
              firstName: 'Ada',
              middleName: null,
              lastName: 'Lovelace',
              preferredName: null,
            },
            displayAssignment: null,
          },
        ],
        nextAfterId: null,
      }),
    );
    await page.goto('/admin/employees');
    await expect(page.getByRole('link', { name: /EMP-000001|Ada Lovelace/ }).first()).toBeVisible();
    for (const mode of MODES) {
      await applyMode(page, mode);
      await fromMain(page);
      await expectFocusIndicators(page, { mode, stops: 10 });
    }
  });

  test('tabs: the selected tab and arrow-key movement between tabs', async ({ page }) => {
    await calculatedRun(page);
    await page.goto('/admin/payroll/runs/run-1');
    const tablist = page.getByRole('tablist', { name: 'Run sections' });
    await expect(tablist).toBeVisible();
    for (const mode of MODES) {
      await applyMode(page, mode);
      await tablist.getByRole('tab', { selected: true }).focus();
      await expectFocusedIndicator(page, mode);
      await page.keyboard.press('ArrowRight');
      const state = await readFocus(page, mode, '[role=tablist]');
      expect(state?.label).toMatch(/role=tab/);
      await expectFocusedIndicator(page, mode);
    }
  });

  test('dialogs: a confirmation dialog takes focus and its controls show focus', async ({
    page,
  }) => {
    await calculatedRun(page);
    await page.goto('/admin/payroll/runs/run-1');
    await expect(page.getByRole('tablist', { name: 'Run sections' })).toBeVisible();
    for (const mode of MODES) {
      await applyMode(page, mode);
      // Opened from the keyboard, as a keyboard user would (a mouse click rightly shows no
      // focus ring on the dialog's first control).
      await page
        .getByRole('button', { name: /^Approve/ })
        .first()
        .focus();
      await page.keyboard.press('Enter');
      // A confirmation is an alertdialog (focus starts on Cancel).
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      await expectFocusedIndicator(page, mode);
      await expectFocusIndicators(page, { mode, stops: 3, scope: '[role=alertdialog]' });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });

  test('chip filters: a visually hidden radio shows focus on its chip label', async ({ page }) => {
    const route = ROUTES.find((candidate) => candidate.path === '/admin/time')!;
    await route.setup(page);
    await page.goto('/admin/time#exceptions');
    const all = page.getByRole('radio', { name: 'All statuses' });
    await expect(all).toBeAttached();
    for (const mode of MODES) {
      await applyMode(page, mode);
      await all.focus();
      await expectFocusedIndicator(page, mode);
    }
  });

  test('access denied: the restricted state keeps visible focus', async ({ page }) => {
    await workforceSession(page, ['employee.read']);
    for (const mode of MODES) {
      await applyMode(page, mode);
      await page.goto('/admin/payroll');
      await expect(page.getByRole('heading', { level: 1, name: 'Access denied' })).toBeVisible();
      await expectFocusIndicators(page, { mode, stops: 12, scope: null });
    }
  });

  test('kiosk: start, the employee number, the PIN (shown by its visual stand-in) and the keypad', async ({
    page,
  }) => {
    await mockKiosk(page, kioskWorld());
    await page.setViewportSize({ width: 1180, height: 820 });
    for (const mode of MODES) {
      await applyMode(page, mode);
      await page.goto('/kiosk');
      const start = page.getByRole('button', { name: 'Tap to start' });
      await start.focus();
      await expectFocusedIndicator(page, mode);
      await page.keyboard.press('Enter');
      const number = page.getByLabel('Employee number');
      await expect(number).toBeFocused();
      await expectFocusedIndicator(page, mode);
      await expectFocusIndicators(page, { mode, stops: 2, scope: null });
      await number.fill('e-100');
      await number.focus();
      await page.keyboard.press('Enter');
      const pin = page.getByLabel(/PIN/);
      await expect(pin).toBeFocused();
      // The PIN field is visually hidden; its dots show its focus instead (support/focus.ts
      // reads the stand-in of a visually hidden control).
      await expectFocusedIndicator(page, mode);
      // On to the keypad by keyboard (keypad buttons keep a mouse or touch from taking focus
      // away from the PIN field, so only keyboard focus shows a ring there).
      await expectFocusIndicators(page, { mode, stops: 3, scope: null });
    }
  });
});

function kioskWorld(): KioskMock {
  return {
    enrolled: true,
    identification: {
      token: 'token-1',
      expiresInSeconds: 90,
      employee: { firstName: 'Ada' },
      state: 'OFF_CLOCK',
      actions: [
        {
          action: 'CLOCK_IN',
          employmentAssignmentId: 'assignment-1',
          label: 'Clock in · Counsellor',
        },
      ],
    },
    actions: [],
  };
}
