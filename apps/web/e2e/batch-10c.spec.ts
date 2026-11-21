import { expect, test, type Page } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';
import {
  identity,
  json,
  MANAGER_PERMISSIONS,
  mockManager,
  mockMyTime,
  mockScheduling,
  northwind,
  ORG,
  SCHEDULING_PERMISSIONS,
  session,
} from './support/workforce-mocks';

/**
 * Batch 10C — workforce screens (time, attendance, scheduling, kiosk) against a mocked API:
 * - /admin/time: its sections are real tabs (`#hash` deep links, Back/Forward), the page shows
 *   loading (never "Access denied") in its own width while permissions load, and attendance's
 *   sub-tabs follow `?attendanceTab=` (also from a same-page sidebar link);
 * - My Time keeps its `?tab=` links (other parameters kept, Back/Forward);
 * - attendance panels keep the heading order (no h1 → h3 jump);
 * - the schedule calendar's day buttons and the kiosk's controls are usable touch/keyboard
 *   targets;
 * - each route: no page-wide horizontal scroll and no serious/critical axe at 1280/820/375 px.
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

/** Headings in <main> in document order, as levels (e.g. [1, 2, 3]). */
async function headingLevels(page: Page) {
  return page
    .locator('main')
    .locator('h1, h2, h3, h4, h5, h6')
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => (node as HTMLElement).offsetParent !== null)
        .map((node) => Number(node.tagName.slice(1))),
    );
}

function noSkippedLevels(levels: number[]) {
  return levels.every((level, index) => index === 0 || level <= levels[index - 1]! + 1);
}

async function slowAuthorization(page: Page, permissions: string[], delayMs = 1_500) {
  await page.route(`${API}/auth/me/authorization`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    });
  });
}

// ─── Time operations (/admin/time) ──────────────────────────────────────────

const timeTab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

test('/admin/time: sections are tabs that follow #hash deep links and Back/Forward', async ({
  page,
}) => {
  await session(page, MANAGER_PERMISSIONS);
  await mockManager(page);
  await page.goto('/admin/time#corrections');
  const tablist = page.getByRole('tablist', { name: 'Time operations sections' });
  await expect(tablist).toBeVisible();
  await expect(timeTab(page, 'Corrections')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel').first()).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = 'records';
  });
  await expect(timeTab(page, 'Records')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(timeTab(page, 'Corrections')).toHaveAttribute('aria-selected', 'true');
  // Arrow keys move between sections and select them (the shared TabList).
  await timeTab(page, 'Corrections').focus();
  await page.keyboard.press('ArrowRight');
  await expect(timeTab(page, 'Timesheets')).toBeFocused();
  await expect(timeTab(page, 'Timesheets')).toHaveAttribute('aria-selected', 'true');
  await checkAtAllWidths(page, () => expect(tablist).toBeVisible());
});

test('/admin/time: loading, never "Access denied", in the page width while permissions load', async ({
  page,
}) => {
  await session(page, MANAGER_PERMISSIONS);
  await mockManager(page);
  await slowAuthorization(page, MANAGER_PERMISSIONS);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/admin/time', { waitUntil: 'commit' });
  const h1 = page.getByRole('heading', { level: 1, name: 'Time operations' });
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

test('/admin/time: attendance sub-tabs follow ?attendanceTab= (deep link, sidebar link, picking)', async ({
  page,
}) => {
  await session(page, MANAGER_PERMISSIONS);
  await mockManager(page);
  await page.goto('/admin/time?attendanceTab=expected#attendance');
  const subTab = (name: string) =>
    page.getByRole('tablist', { name: 'Attendance' }).getByRole('tab', { name, exact: true });
  await expect(subTab('Expected sign-ins')).toHaveAttribute('aria-selected', 'true');
  // Picking a sub-tab writes it into the URL (other parameters and the hash kept).
  await subTab('Effective policy').click();
  await expect(subTab('Effective policy')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/admin\/time\?attendanceTab=effective#attendance$/);
  // A same-page link (as the sidebar's attendance links) switches the sub-tab.
  await page.evaluate(() => {
    window.history.pushState(null, '', '/admin/time?attendanceTab=assignments#attendance');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(subTab('Assignment attendance')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(subTab('Effective policy')).toHaveAttribute('aria-selected', 'true');
  // The first sub-tab needs no parameter.
  await subTab('Sign-ins').click();
  await expect(page).toHaveURL(/\/admin\/time#attendance$/);
});

test('/admin/time: attendance panels keep the heading order (h1 → h2 → h3)', async ({ page }) => {
  await session(page, MANAGER_PERMISSIONS);
  await mockManager(page);
  for (const tab of ['effective', 'assignments', 'sign-ins', 'expected']) {
    await page.goto(`/admin/time?attendanceTab=${tab}#attendance`);
    await expect(page.getByRole('heading', { level: 1, name: 'Time operations' })).toBeVisible();
    await expect(page.getByRole('tabpanel').last().getByRole('heading').first()).toBeVisible();
    const levels = await headingLevels(page);
    expect({ tab, ok: noSkippedLevels(levels), levels }).toMatchObject({ tab, ok: true });
  }
});

test('/admin/time: every section fits and passes axe at three widths', async ({ page }) => {
  await session(page, MANAGER_PERMISSIONS);
  await mockManager(page);
  for (const hash of [
    'overview',
    'records',
    'exceptions',
    'corrections',
    'timesheets',
    'scheduled',
  ]) {
    await page.goto(`/admin/time#${hash}`);
    const panel = page.getByRole('tabpanel').first();
    await checkAtAllWidths(page, () => expect(panel).toBeVisible());
  }
});

test("/admin/time: the sidebar's same-page attendance links switch the sub-tab", async ({
  page,
}) => {
  await session(page, MANAGER_PERMISSIONS);
  await mockManager(page);
  // An organization where the manager also administers kiosks and policies.
  await page.route(`${API}/time/manage/organizations*`, (route) =>
    json(route, {
      items: [
        {
          ...northwind,
          actions: { ...northwind.actions, canManageDevices: true, canManagePolicies: true },
        },
      ],
    }),
  );
  await page.goto('/admin/time#records');
  await expect(timeTab(page, 'Records')).toHaveAttribute('aria-selected', 'true');
  const sidebar = page.getByRole('navigation', { name: 'Primary' });
  const subTab = (name: string) =>
    page.getByRole('tablist', { name: 'Attendance' }).getByRole('tab', { name, exact: true });
  await sidebar.getByRole('link', { name: 'Kiosk Management' }).click();
  await expect(timeTab(page, 'Attendance')).toHaveAttribute('aria-selected', 'true');
  await expect(subTab('Kiosks')).toHaveAttribute('aria-selected', 'true');
  expect(noSkippedLevels(await headingLevels(page))).toBe(true);
  await sidebar.getByRole('link', { name: 'Attendance Policies' }).click();
  await expect(subTab('Attendance policies')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/admin\/time\?attendanceTab=policies#attendance$/);
  const levels = await headingLevels(page);
  expect(noSkippedLevels(levels)).toBe(true);
  await checkAtAllWidths(page, () => expect(subTab('Attendance policies')).toBeVisible());
});

test('/admin/time: switching the attendance organization drops the previous sub-tab from the URL', async ({
  page,
}) => {
  await session(page, MANAGER_PERMISSIONS);
  await mockManager(page);
  await page.route(`${API}/time/manage/organizations*`, (route) =>
    json(route, {
      items: [
        {
          ...northwind,
          actions: { ...northwind.actions, canManageDevices: true, canManagePolicies: true },
        },
        { ...northwind, id: 'org-b', name: 'Harbor Day Camp' },
      ],
    }),
  );
  await page.goto('/admin/time?attendanceTab=kiosks#attendance');
  const subTab = (name: string) =>
    page.getByRole('tablist', { name: 'Attendance' }).getByRole('tab', { name, exact: true });
  await expect(subTab('Kiosks')).toHaveAttribute('aria-selected', 'true');
  await page
    .getByRole('tabpanel')
    .first()
    .getByRole('combobox', { name: 'Organization' })
    .selectOption('org-b');
  await expect(subTab('Sign-ins')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/admin\/time#attendance$/);
});

// ─── My Time (/time) ────────────────────────────────────────────────────────

test('My Time: ?tab= deep links, picking a tab and Back/Forward follow the URL', async ({
  page,
}) => {
  await session(page, ['time.clock'], { isEmployee: true });
  await mockMyTime(page);
  await page.goto('/time?tab=history');
  const tab = (name: string) =>
    page.getByRole('tablist', { name: 'My Time' }).getByRole('tab', { name, exact: true });
  await expect(tab('History')).toHaveAttribute('aria-selected', 'true');
  await tab('Timesheets').click();
  await expect(page).toHaveURL(/\/time\?tab=timesheets$/);
  await expect(tab('Timesheets')).toHaveAttribute('aria-selected', 'true');
  await tab('Today').click();
  await expect(page).toHaveURL(/\/time$/);
  await page.goto('/time?tab=requests');
  await expect(tab('Requests')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(tab('Today')).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(tab('Requests')).toHaveAttribute('aria-selected', 'true');
  for (const name of ['Today', 'History', 'Timesheets', 'Requests']) {
    await tab(name).click();
    await checkAtAllWidths(page, () => expect(tab(name)).toHaveAttribute('aria-selected', 'true'));
  }
});

// ─── Scheduling ─────────────────────────────────────────────────────────────

test('scheduling: day buttons in the calendar are at least 24 px tall; pages fit at three widths', async ({
  page,
}) => {
  await session(page, SCHEDULING_PERMISSIONS);
  await mockScheduling(page);
  await page.goto('/admin/scheduling');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.setViewportSize(VIEWPORTS.phone);
  for (const view of ['week', 'month']) {
    await page
      .getByRole('group', { name: 'Calendar view' })
      .getByRole('button', { name: view })
      .click();
    const region = page.getByRole('region', {
      name: view === 'week' ? 'Week calendar' : 'Month calendar',
    });
    // Batch R3.5: switching the view first renders the new layout with the previous shifts, then
    // shows "Loading shifts…" (the region is gone) until the refetch lands, so a one-off snapshot
    // could measure no buttons. Poll the measurement until the settled calendar is there.
    await expect
      .poll(async () => {
        const heights = await region
          .locator('button')
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
        return heights.length > 0 ? Math.min(...heights) : 0;
      })
      .toBeGreaterThanOrEqual(24);
    await expect(region).toHaveAttribute('tabindex', '0');
  }
  await page.setViewportSize(VIEWPORTS.desktop);
  for (const path of [
    '/admin/scheduling',
    '/admin/scheduling/templates',
    '/admin/scheduling/patterns',
    '/admin/scheduling/policies',
    '/admin/scheduling/reports',
  ]) {
    await page.goto(path);
    await checkAtAllWidths(page, () =>
      expect(page.getByRole('heading', { level: 1 })).toBeVisible(),
    );
  }
});

const draftSchedule = {
  id: 'schedule-draft',
  organizationId: ORG,
  scopeType: 'ORGANIZATION',
  organizationalUnitId: null,
  departmentId: null,
  teamId: null,
  name: 'Fall programs week 46 — waterfront and outdoor education',
  periodStart: '2026-11-09',
  periodEnd: '2026-11-15',
  type: 'WEEKLY',
  status: 'DRAFT',
  publishedAt: null,
  publishedByUserId: null,
  createdAt: '2026-11-01T12:00:00.000Z',
  updatedAt: '2026-11-01T12:00:00.000Z',
};

test('scheduling: the shift editor and the publish confirmation fit and pass axe', async ({
  page,
}) => {
  await session(page, [...SCHEDULING_PERMISSIONS, 'schedule.publish']);
  await mockScheduling(page);
  const published: string[] = [];
  await page.route(`${API}/schedules**`, (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname.endsWith('/publish')) {
      published.push(url.pathname);
      return json(route, { ...draftSchedule, status: 'PUBLISHED' }, 201);
    }
    return json(route, { items: [draftSchedule], nextAfterId: null });
  });
  await page.goto('/admin/scheduling');
  const row = page.getByRole('listitem').filter({ hasText: draftSchedule.name });
  await expect(row.getByText('Draft', { exact: true })).toBeVisible();
  // Shift editing: the editor opens in the shift panel with labelled fields.
  await row.getByRole('button', { name: 'Add shift' }).click();
  const editor = page.getByRole('form', { name: 'Add a draft shift' });
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Save shift' })).toBeVisible();
  expect(noSkippedLevels(await headingLevels(page))).toBe(true);
  await checkAtAllWidths(page, () => expect(editor).toBeVisible());
  // Publishing asks first (focus in the dialog), then publishes.
  await row.getByRole('button', { name: /^Publish/ }).click();
  const dialog = page.getByRole('alertdialog', { name: `Publish “${draftSchedule.name}”?` });
  await expect(dialog).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.setViewportSize(VIEWPORTS.phone);
  await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(1);
  await expect(dialog.getByRole('button', { name: 'Publish' })).toBeInViewport();
  await page.setViewportSize(VIEWPORTS.desktop);
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText(`“${draftSchedule.name}” published.`)).toBeVisible();
  expect(published).toEqual([`/schedules/${draftSchedule.id}/publish`]);
});

test('My schedule: fits and passes axe at three widths', async ({ page }) => {
  await session(page, ['time.clock'], { isEmployee: true });
  await mockMyTime(page);
  await page.goto('/schedule');
  await checkAtAllWidths(page, () =>
    expect(page.getByRole('heading', { level: 1, name: 'My schedule' })).toBeVisible(),
  );
});

// ─── Kiosk ──────────────────────────────────────────────────────────────────

async function kioskApi(page: Page) {
  await page.route(`${API}/kiosk/**`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/kiosk/session')
      return json(route, {
        device: { id: 'device-1', name: 'Front desk' },
        location: { name: 'Main building', timezone: 'America/Toronto' },
        organization: { name: 'Northwind Academy' },
        interactionSeconds: 90,
      });
    if (pathname === '/kiosk/cancel') return json(route, { cancelled: true }, 201);
    return json(route, {}, 404);
  });
}

test('kiosk: controls show a visible focus ring and are comfortable touch targets', async ({
  page,
}) => {
  await kioskApi(page);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/kiosk');
  const start = page.getByRole('button', { name: 'Tap to start' });
  await expect(start).toBeVisible();
  await start.click();
  await page.getByLabel('Employee number').fill('E-200');
  const next = page.getByRole('button', { name: 'Next', exact: true });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  const ring = await next.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe('none');
  await next.click();
  const keys = page.getByRole('button', { name: /^[0-9]$/ });
  await expect(keys).toHaveCount(10);
  for (const size of [
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 375, height: 812 },
  ]) {
    await page.setViewportSize(size);
    const boxes = await keys.evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect()),
    );
    for (const box of boxes) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(1);
    await expectNoSeriousA11yViolations(page);
  }
});
