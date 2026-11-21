import { expect, test } from '@playwright/test';
import { pageWidthFor } from '../src/lib/navigation/page-width';
import { frame, MAX_WIDTH_PX } from './support/acceptance';
import { API } from './support/api-origin';
import { json, ORG, path, session as workforceSession } from './support/workforce-mocks';

/**
 * Batch 11C — the route-loading skeleton (app/(app)/(authenticated)/loading.tsx) shows in the
 * destination page's width, deterministically.
 *
 * The skeleton only appears when a loading boundary mounts fresh: navigating to a dynamic route
 * under another top-level segment, whose prefetch stops at the loading boundary. The test lets
 * that prefetch through and holds the navigation's own RSC request, so the skeleton stays on
 * screen until it is measured. App code is unchanged. (Between pages that share an already-shown
 * boundary, React's transition keeps the old page instead; see the Batch 11C notes, §6.)
 */
const DESTINATION = '/admin/employees/employee-1';

const assignment = {
  id: 'assignment-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-09-01',
  endDate: null,
  isPrimary: true,
  position: { id: 'position-1', name: 'Platform Engineer', code: 'PE-1' },
  jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  placement: { type: 'TEAM', id: 'team-1', name: 'Platform', code: 'PLAT' },
  workLocation: null,
  manager: null,
};

test('the route skeleton renders in the destination width, then the page keeps it', async ({
  page,
}) => {
  await workforceSession(page, ['employee.read']);
  await page.route(path('/dashboard'), (route) =>
    json(route, {
      organizationId: ORG,
      cards: [],
      self: null,
      quickActions: [{ key: 'employee', label: 'Open Ada Lovelace', href: DESTINATION }],
    }),
  );
  await page.route(`${API}/employees**`, (route) =>
    json(route, {
      id: 'employee-1',
      employeeNumber: 'EMP-000001',
      status: 'ACTIVE',
      hireDate: '2026-01-02',
      terminationDate: null,
      person: {
        firstName: 'Ada',
        middleName: null,
        lastName: 'Lovelace',
        preferredName: null,
        personalEmail: null,
        phone: null,
      },
      displayAssignment: assignment,
      assignments: { current: [assignment], upcoming: [], historical: [], cancelled: [] },
    }),
  );
  // Hold the navigation's RSC request (prefetches pass), so the skeleton can be measured.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  await page.route(
    (url) => url.pathname === DESTINATION && url.searchParams.has('_rsc'),
    async (route) => {
      if (route.request().headers()['next-router-prefetch']) return route.continue();
      held += 1;
      await released;
      await route.continue();
    },
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard');
  const source = `${MAX_WIDTH_PX[pageWidthFor('/dashboard')]}px`;
  const destination = `${MAX_WIDTH_PX[pageWidthFor(DESTINATION)]}px`;
  // The case is only meaningful if the two widths differ.
  expect(source).not.toBe(destination);
  const link = page.getByRole('link', { name: 'Open Ada Lovelace' });
  await expect(link).toBeVisible();
  expect((await frame(page))?.maxWidth).toBe(source);
  // Let the link's prefetch (up to the loading boundary) arrive before navigating.
  await page.waitForLoadState('networkidle');

  await link.click();
  const skeleton = page
    .getByRole('main')
    .getByRole('status')
    .filter({ hasText: /^Loading page…$/ });
  await expect(skeleton).toBeVisible();
  expect(held).toBeGreaterThan(0);
  expect((await frame(page))?.maxWidth, 'skeleton in the destination width').toBe(destination);

  release();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(skeleton).toHaveCount(0);
  expect((await frame(page))?.maxWidth, 'loaded page in the same width').toBe(destination);
});
