import { expect, test, type Page } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';
import { benefitsWorld, signedIn as benefitsSignedIn } from './support/benefits-admin-mocks';
import {
  json,
  ORG as DOCUMENTS_ORG,
  record,
  session as documentsSession,
  version,
  documentsAdmin,
} from './support/documents-mocks';
import {
  notificationsAdmin,
  ORG as NOTIFICATIONS_ORG,
  session as notificationsSession,
} from './support/notifications-mocks';
import { ALL, mockApi, signedIn as performanceSignedIn } from './support/performance-admin-mocks';

/**
 * Batch 10E-2 — performance, benefits, notifications and documents against the mocked APIs of
 * batches 7B, 7C, 8 and 9 (their setup moved to e2e/support unchanged):
 * - the admin pages deep-link their sections with `#hash` and write the picked tab into the URL
 *   (Performance kept #hash; Benefits, Notifications and Documents had no deep link);
 * - loading, denied and loaded states share the page's width and "Access denied" never flashes
 *   while permissions load; denied users trigger no module request;
 * - every section fits 1280, 820 and 375 px, passes axe (serious/critical) and scrolls its tables
 *   in named, keyboard-focusable regions; document versions keep their "Version N" row names;
 * - checkboxes are at least 24 px; a button that becomes enabled is fully opaque at once (the
 *   batch-9-documents color-contrast flake).
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

/** Every horizontally scrolling table container is a named, focusable region. */
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

async function checkAtAllWidths(page: Page, ready: () => Promise<void>) {
  for (const size of [VIEWPORTS.desktop, VIEWPORTS.tablet, VIEWPORTS.phone]) {
    await page.setViewportSize(size);
    await ready();
    await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(1);
    await scrollersAreAccessible(page);
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

const frameWidth = (page: Page) =>
  page
    .evaluate(() => {
      const first = document.querySelector('main')?.firstElementChild as HTMLElement | null;
      return first ? Math.round(first.getBoundingClientRect().width) : 0;
    })
    .catch(() => 0);

/** Samples the frame's width until `done` is visible; it must never change. */
async function widthsUntil(page: Page, done: ReturnType<Page['getByRole']>) {
  const widths: number[] = [];
  let sawDenied = false;
  for (let i = 0; i < 120 && !(await done.isVisible().catch(() => false)); i += 1) {
    // Batch 10F: the route skeleton is sampled too — it renders in the page's own width.
    const width = await frameWidth(page);
    if (width) widths.push(width);
    sawDenied ||= await page
      .getByRole('heading', { name: 'Access denied' })
      .isVisible()
      .catch(() => false);
    await page.waitForTimeout(40);
  }
  await expect(done).toBeVisible();
  widths.push(await frameWidth(page));
  return { widths: [...new Set(widths)], sawDenied };
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

/** Answers the authorization snapshot late (after the module's own session mocks). */
async function slowAuthorization(page: Page, permissions: string[], orgId: string) {
  await page.route(`${API}/auth/me/authorization`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await json(route, {
      userId: 'user',
      permissions: permissions.map((key) => ({
        key,
        scopes: [{ type: 'ORGANIZATION', id: orgId }],
      })),
    });
  });
}

// ─── Performance ────────────────────────────────────────────────────────────

test('/admin/performance: #hash links open a section; picking a tab writes it; keys and Back/Forward follow', async ({
  page,
}) => {
  const api = mockApi();
  await page.route(`${API}/performance/**`, api.handle);
  await performanceSignedIn(page, ALL);
  await page.goto('/admin/performance#attention');
  await expect(tab(page, 'Needs attention')).toHaveAttribute('aria-selected', 'true');

  await tab(page, 'Templates').click();
  await expect(page).toHaveURL(/\/admin\/performance#templates$/);
  await tab(page, 'Templates').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Competencies')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/#competencies$/);

  await page.evaluate(() => {
    window.location.hash = 'scales';
  });
  await expect(tab(page, 'Rating scales')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(tab(page, 'Competencies')).toHaveAttribute('aria-selected', 'true');

  for (const [name, hash] of [
    ['Review cycles', 'cycles'],
    ['Templates', 'templates'],
    ['Evidence sources', 'evidence'],
    ['Needs attention', 'attention'],
  ] as const) {
    await page.goto('about:blank');
    await page.goto(`/admin/performance#${hash}`);
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await checkAtAllWidths(page, async () => {
      await expect(page.getByRole('tabpanel')).toBeVisible();
    });
  }
});

// ─── Benefits ───────────────────────────────────────────────────────────────

test('/admin/benefits: sections deep-link with #hash, and the plans section fits and passes axe', async ({
  page,
}) => {
  const world = benefitsWorld(page);
  await world.install();
  await benefitsSignedIn(page, ['benefit.plan.manage', 'benefit.read']);
  await page.goto('/admin/benefits#attention');
  await expect(tab(page, 'Needs attention')).toHaveAttribute('aria-selected', 'true');
  await tab(page, 'Plans').click();
  await expect(page).toHaveURL(/\/admin\/benefits#plans$/);
  await checkAtAllWidths(page, async () => {
    await expect(page.getByRole('heading', { name: 'Benefits', level: 1 })).toBeVisible();
  });
  // The plan editor's checkboxes are real targets.
  const checkboxes = page.getByRole('main').getByRole('checkbox');
  for (let i = 0; i < (await checkboxes.count()); i += 1) {
    const box = await checkboxes.nth(i).boundingBox();
    if (!box) continue;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
  }
});

// ─── Notifications ──────────────────────────────────────────────────────────

test('/admin/notifications: #deliveries deep-links the delivery log; picking a tab writes it', async ({
  page,
}) => {
  await notificationsSession(page, ['notification.template.manage', 'notification.delivery.read']);
  await notificationsAdmin(page);
  await page.goto('/admin/notifications#deliveries');
  await expect(tab(page, 'Delivery log')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Notification deliveries' })).toBeVisible();
  await checkAtAllWidths(page, async () => {
    await expect(page.getByRole('region', { name: 'Notification deliveries' })).toBeVisible();
  });
  await tab(page, 'Templates').click();
  await expect(page).toHaveURL(/\/admin\/notifications#templates$/);
});

test('email preferences: 24 px checkboxes, and Save is fully opaque the moment it is enabled', async ({
  page,
}) => {
  await notificationsSession(page, []);
  await page.route(`${API}/notifications/me/preferences`, (route) =>
    json(route, {
      inApp: 'ALWAYS',
      items: ['SECURITY', 'LEAVE', 'PAYROLL', 'BENEFITS'].map((category) => {
        const mandatory = category === 'SECURITY';
        return { category, mandatory, configurable: !mandatory, emailEnabled: true };
      }),
    }),
  );
  await page.goto('/notifications/preferences');
  const leave = page.getByLabel('Email for Leave');
  await expect(leave).toBeChecked();
  await page.setViewportSize(VIEWPORTS.phone);
  for (const name of ['Email for Leave', 'Email for Payroll', 'Email for Benefits']) {
    const box = await page.getByLabel(name).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  }
  await page.setViewportSize(VIEWPORTS.desktop);

  // Root cause of the batch-9-documents flake: a disabled button (60% opacity) that became
  // enabled faded back over 150 ms, so its text was briefly below 4.5:1. Now it never fades.
  const save = page.getByRole('button', { name: /^Save/ });
  await expect(save).toBeDisabled();
  await leave.uncheck();
  await expect(save).toBeEnabled();
  const style = await save.evaluate((el) => {
    const computed = getComputedStyle(el);
    return { opacity: computed.opacity, transition: computed.transitionProperty };
  });
  expect(style.opacity).toBe('1');
  expect(style.transition).not.toMatch(/opacity|\ball\b/);
  await expectNoSeriousA11yViolations(page);
  await checkAtAllWidths(page, async () => {
    await expect(leave).toBeVisible();
  });
});

// ─── Documents ──────────────────────────────────────────────────────────────

test('/admin/documents: sections deep-link with #hash, picking one writes it, and each fits', async ({
  page,
}) => {
  await documentsSession(page, ['document.manage', 'document.read'], {
    canManageTypes: true,
    canManagePolicies: true,
  });
  await documentsAdmin(page);
  await page.goto('/admin/documents#policies');
  await expect(tab(page, 'Policies')).toHaveAttribute('aria-selected', 'true');
  await tab(page, 'Missing').click();
  await expect(page).toHaveURL(/\/admin\/documents#missing$/);
  await tab(page, 'Missing').focus();
  await page.keyboard.press('Home');
  await expect(tab(page, 'Document types')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/#types$/);
  for (const [name, hash] of [
    ['Document types', 'types'],
    ['Requirements', 'requirements'],
    ['Policies', 'policies'],
    ['Expiring', 'expiring'],
    ['Missing', 'missing'],
  ] as const) {
    await page.goto('about:blank');
    await page.goto(`/admin/documents#${hash}`);
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await checkAtAllWidths(page, async () => {
      await expect(page.getByRole('tabpanel')).toBeVisible();
    });
  }
});

test('a document record: versions are a named table whose rows keep their "Version N" names', async ({
  page,
}) => {
  await documentsSession(page, ['document.read', 'document.manage'], {});
  await page.route(`${API}/documents/records/doc-1`, (route) =>
    json(route, record([version(1, { state: 'SUPERSEDED' }), version(2)])),
  );
  await page.goto('/documents/records/doc-1');
  const versions = page.getByRole('region', { name: 'Versions', exact: true });
  await expect(versions).toBeVisible();
  await expect(versions).toHaveAttribute('tabindex', '0');
  await expect(versions.getByRole('row', { name: 'Version 1' })).toBeVisible();
  await expect(versions.getByRole('row', { name: 'Version 2' })).toBeVisible();
  await checkAtAllWidths(page, async () => {
    await expect(versions).toBeVisible();
  });
});

// ─── Loading and denied states ──────────────────────────────────────────────

const ADMIN_PAGES = [
  {
    path: '/admin/performance',
    heading: 'Performance management',
    permissions: ALL,
    setup: async (page: Page) => {
      const api = mockApi();
      await page.route(`${API}/performance/**`, api.handle);
      await performanceSignedIn(page, ALL);
    },
    org: 'org-1',
  },
  {
    path: '/admin/benefits',
    heading: 'Benefits',
    permissions: ['benefit.read'],
    setup: async (page: Page) => {
      await benefitsWorld(page).install();
      await benefitsSignedIn(page, ['benefit.read']);
    },
    org: 'org-1',
  },
  {
    path: '/admin/notifications',
    heading: 'Notifications administration',
    permissions: ['notification.delivery.read'],
    setup: async (page: Page) => {
      await notificationsSession(page, ['notification.delivery.read']);
      await notificationsAdmin(page);
    },
    org: NOTIFICATIONS_ORG,
  },
  {
    path: '/admin/documents',
    heading: 'Documents & employee records',
    permissions: ['document.read'],
    setup: async (page: Page) => {
      await documentsSession(page, ['document.read'], {});
      await documentsAdmin(page);
    },
    org: DOCUMENTS_ORG,
  },
];

for (const target of ADMIN_PAGES) {
  test(`${target.path}: loading, never "Access denied", in the page's width while permissions load`, async ({
    page,
  }) => {
    await target.setup(page);
    await slowAuthorization(page, target.permissions, target.org);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(target.path, { waitUntil: 'commit' });
    const { widths, sawDenied } = await widthsUntil(
      page,
      page.getByRole('heading', { level: 1, name: target.heading, exact: true }),
    );
    expect(sawDenied).toBe(false);
    expect(widths).toHaveLength(1);
  });

  test(`${target.path}: without its permission, the denied state in the page's width and no module request`, async ({
    page,
  }) => {
    await target.setup(page);
    await slowAuthorization(page, ['employee.read'], target.org);
    const moduleName = target.path.split('/')[2]!;
    const requests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      // The shell's notification bell (one shared unread-count request) is not module data.
      if (url.pathname === '/notifications/me/unread-count') return;
      if (url.origin === API && url.pathname.startsWith(`/${moduleName}/`))
        requests.push(url.pathname);
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(target.path, { waitUntil: 'commit' });
    const { widths } = await widthsUntil(
      page,
      page.getByRole('heading', { level: 1, name: 'Access denied' }),
    );
    expect(widths).toHaveLength(1);
    await expectNoSeriousA11yViolations(page);
    expect(requests).toEqual([]);
  });
}
