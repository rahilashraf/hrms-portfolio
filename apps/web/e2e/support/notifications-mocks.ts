import { expect, type Page, type Route } from '@playwright/test';
import { API } from './api-origin';
import { expectNoSeriousA11yViolations } from './axe';

// Batch 10E-2: moved unchanged from e2e/batch-8-notifications.spec.ts so batch-10e2.spec.ts can reuse it.
export const ORG = '11111111-1111-4111-8111-111111111111';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;

const identity = {
  id: 'user-8',
  personId: 'person-8',
  email: 'ops@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

export const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

export async function session(page: Page, permissions: string[]) {
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '8-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    }),
  );
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: identity.id, email: identity.email, displayName: 'Robin Ops' },
      systemPermissions: [],
      organizations: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: ['NOTIFICATIONS', 'LEAVE', 'ATTENDANCE', 'PAYROLL'],
          permissions,
          isEmployee: true,
          isManager: false,
        },
      ],
    }),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => json(route, { unread: 0 }));
}

export async function checkAt(page: Page) {
  for (const size of Object.values(VIEWPORTS)) {
    await page.setViewportSize(size);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

export const delivery = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'leave.request-approved',
  category: 'LEAVE',
  mandatory: false,
  recipientName: 'Jordan Lee',
  channel: 'EMAIL',
  status: 'SENT',
  attemptCount: 1,
  nextAttemptAt: null,
  sentAt: '2026-11-02T15:00:05.000Z',
  lastErrorCode: null,
  suppressedReason: null,
  createdAt: '2026-11-02T15:00:00.000Z',
  updatedAt: '2026-11-02T15:00:05.000Z',
  ...overrides,
});

export const TYPES = [
  { key: 'leave.request-approved', category: 'LEAVE' },
  { key: 'payroll.payslip-available', category: 'PAYROLL' },
  { key: 'time.timesheet-approved', category: 'TIME' },
];

/** Batch 10F: moved unchanged from e2e/batch-10e2.spec.ts — notifications administration (organizations, templates, two deliveries). */
export async function notificationsAdmin(page: Page) {
  await page.route(`${API}/notifications/organizations`, (route) =>
    json(route, {
      items: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          actions: { canManageTemplates: true, canManageSettings: false, canReadDeliveries: true },
        },
      ],
    }),
  );
  await page.route(
    (url) => url.origin === API && url.pathname === '/notifications/templates',
    (route) => json(route, { items: [] }),
  );
  await page.route(
    (url) => url.origin === API && url.pathname === '/notifications/deliveries',
    (route) =>
      json(route, {
        items: [
          delivery('d-1', { recipientName: 'Alexandria Montgomery-Fitzgerald' }),
          delivery('d-2', { status: 'FAILED', attemptCount: 3 }),
        ],
        nextCursor: null,
        timezone: 'America/Toronto',
        types: TYPES,
      }),
  );
}
