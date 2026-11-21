/**
 * Batch 10F — the major routes of the UI acceptance suite: each with the module's existing mocked
 * API (e2e/support), its expected `PageContainer` width and what shows once it is loaded.
 */
import type { Locator, Page } from '@playwright/test';
import { API } from './api-origin';
import type { PageWidth } from './acceptance';
import { signedIn as benefitsSignedIn, benefitsWorld } from './benefits-admin-mocks';
import {
  documentsAdmin,
  json as documentsJson,
  record,
  session as documentsSession,
  version,
} from './documents-mocks';
import { notificationsAdmin, session as notificationsSession } from './notifications-mocks';
import { calculatedRun } from './payroll-mocks';
import {
  ALL as PERFORMANCE_ALL,
  mockApi,
  signedIn as performanceSignedIn,
} from './performance-admin-mocks';
import {
  application,
  json as recruitmentJson,
  ONBOARDING_HR,
  path as recruitmentPath,
  onboardingServer,
  RECRUITER,
  recruitmentServer,
  session as recruitmentSession,
} from './recruitment-onboarding-mocks';
import {
  json,
  MANAGER_PERMISSIONS,
  mockManager,
  mockMyTime,
  mockScheduling,
  ORG,
  path,
  SCHEDULING_PERMISSIONS,
  session as workforceSession,
} from './workforce-mocks';

export interface RouteCase {
  area: 'shell' | 'administration' | 'workforce' | 'payroll' | 'hr';
  path: string;
  width: PageWidth;
  setup(page: Page): Promise<void>;
  /** Visible once the page shows its loaded content (not only its heading). */
  ready(page: Page): Locator;
}

const h1 = (page: Page, name: string | RegExp) => page.getByRole('heading', { level: 1, name });

async function shellSession(page: Page, permissions: string[], options = {}) {
  await workforceSession(page, permissions, options);
}

export const ROUTES: RouteCase[] = [
  // ── Shell, account and administration ──
  {
    area: 'shell',
    path: '/dashboard',
    width: 'wide',
    setup: async (page) => {
      await shellSession(page, ['employee.read']);
      await page.route(path('/dashboard'), (route) =>
        json(route, {
          organizationId: ORG,
          cards: [
            {
              key: 'employees',
              label: 'Employees',
              value: 42,
              href: '/admin/employees',
              area: 'PEOPLE',
            },
          ],
          self: null,
          quickActions: [
            { key: 'directory', label: 'Open the directory', href: '/admin/employees' },
          ],
        }),
      );
    },
    ready: (page) =>
      page
        .getByRole('main')
        .getByRole('link', { name: /Employees/ })
        .first(),
  },
  {
    area: 'shell',
    path: '/account/security',
    width: 'narrow',
    setup: async (page) => {
      await shellSession(page, []);
      await page.route(path('/auth/sessions'), (route) =>
        json(route, {
          items: [
            {
              id: '00000000-0000-4000-8000-00000000000a',
              current: true,
              createdAt: '2026-10-29T08:00:00.000Z',
              lastUsedAt: '2026-10-29T09:00:00.000Z',
              expiresAt: '2026-11-28T08:00:00.000Z',
              ipAddress: '203.0.113.9',
              browser: 'Firefox',
              os: 'Windows',
            },
          ],
        }),
      );
    },
    ready: (page) => page.getByText('Firefox', { exact: false }).first(),
  },
  {
    area: 'administration',
    path: '/admin/organizations',
    width: 'default',
    setup: async (page) => {
      await shellSession(page, ['organization.read', 'organization.manage']);
      await page.route(path('/organizations'), (route) =>
        json(route, [
          {
            id: ORG,
            name: 'Northwind Academy',
            code: 'NWA',
            description: null,
            sortOrder: 0,
            timezone: 'America/Toronto',
            archivedAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      );
    },
    ready: (page) => page.getByRole('main').getByText('Northwind Academy').first(),
  },
  {
    area: 'administration',
    path: '/admin/audit',
    width: 'wide',
    setup: async (page) => {
      await shellSession(page, ['audit.read']);
      await page.route(path('/audit'), (route) =>
        json(route, {
          items: [
            {
              id: 'audit-1',
              occurredAt: '2026-10-05T12:00:00.000Z',
              action: 'EMPLOYEE_UPDATED',
              entityType: 'Employee',
              entityId: 'emp-1',
              actor: { userId: 'user-1', displayName: 'Ada Auditor' },
              requestId: 'req-1',
              metadata: { organizationId: ORG, changedFields: ['firstName'] },
            },
          ],
          nextCursor: null,
          range: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
        }),
      );
    },
    ready: (page) => page.getByRole('row', { name: 'Audit entry EMPLOYEE_UPDATED' }),
  },
  // ── Workforce ──
  {
    area: 'workforce',
    path: '/admin/time',
    width: 'full',
    setup: async (page) => {
      await shellSession(page, MANAGER_PERMISSIONS);
      await mockManager(page);
    },
    ready: (page) => page.getByRole('tablist').first(),
  },
  {
    area: 'workforce',
    path: '/time',
    width: 'wide',
    setup: async (page) => {
      await shellSession(page, ['time.clock'], { isEmployee: true });
      await mockMyTime(page);
    },
    ready: (page) => page.getByRole('tablist').first(),
  },
  {
    area: 'workforce',
    path: '/schedule',
    width: 'default',
    setup: async (page) => {
      await shellSession(page, ['time.clock'], { isEmployee: true });
      await mockMyTime(page);
    },
    ready: (page) => h1(page, 'My schedule'),
  },
  {
    area: 'workforce',
    path: '/admin/scheduling',
    width: 'full',
    setup: async (page) => {
      await shellSession(page, SCHEDULING_PERMISSIONS);
      await mockScheduling(page);
    },
    ready: (page) => page.getByRole('navigation', { name: /scheduling/i }).first(),
  },
  // ── Payroll ──
  {
    area: 'payroll',
    path: '/admin/payroll',
    width: 'wide',
    setup: async (page) => {
      await calculatedRun(page);
    },
    ready: (page) => page.getByRole('tablist', { name: 'Payroll sections' }),
  },
  {
    area: 'payroll',
    path: '/admin/payroll/runs/run-1',
    width: 'wide',
    setup: async (page) => {
      await calculatedRun(page);
    },
    ready: (page) => page.getByRole('tablist', { name: 'Run sections' }),
  },
  {
    area: 'payroll',
    path: '/pay',
    width: 'default',
    setup: async (page) => {
      await calculatedRun(page);
      await page.route(`${API}/payroll/me/pay`, (route) =>
        json(route, {
          netPayExplanation: 'Net pay is not shown: statutory deductions are not calculated.',
          items: [
            {
              id: 're-1',
              payrollRunId: 'run-1',
              employer: 'Northwind Academy',
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
    },
    ready: (page) => page.getByText(/2,000\.00/).first(),
  },
  // ── Recruitment and onboarding ──
  {
    area: 'hr',
    path: '/admin/recruitment',
    width: 'wide',
    setup: async (page) => {
      await recruitmentSession(page, RECRUITER);
      await recruitmentServer(page);
    },
    ready: (page) => page.getByRole('tablist').first(),
  },
  {
    area: 'hr',
    path: '/recruitment/applications/app-1',
    width: 'default',
    setup: async (page) => {
      await recruitmentSession(page, RECRUITER);
      await recruitmentServer(page);
      await page.route(recruitmentPath('/recruitment/applications/app-1'), (route) =>
        recruitmentJson(route, application('FULL')),
      );
    },
    ready: (page) => page.getByRole('region', { name: 'Stage history', exact: true }),
  },
  {
    area: 'hr',
    path: '/recruitment/candidates/cand-1',
    width: 'default',
    setup: async (page) => {
      await recruitmentSession(page, RECRUITER);
      await recruitmentServer(page);
    },
    ready: (page) => page.getByRole('region', { name: /applications/i }).first(),
  },
  {
    area: 'hr',
    path: '/admin/onboarding',
    width: 'wide',
    setup: async (page) => {
      await recruitmentSession(page, ONBOARDING_HR);
      await onboardingServer(page);
    },
    ready: (page) => page.getByRole('tablist').first(),
  },
  {
    area: 'hr',
    path: '/onboarding/workflows/wf-1',
    width: 'wide',
    setup: async (page) => {
      await recruitmentSession(page, ONBOARDING_HR);
      await onboardingServer(page);
    },
    ready: (page) => page.getByRole('region', { name: 'Workflow tasks' }),
  },
  // ── Performance, benefits, notifications, documents ──
  {
    area: 'hr',
    path: '/admin/performance',
    width: 'wide',
    setup: async (page) => {
      const api = mockApi();
      await page.route(`${API}/performance/**`, api.handle);
      await performanceSignedIn(page, PERFORMANCE_ALL);
    },
    ready: (page) => page.getByRole('tablist').first(),
  },
  {
    area: 'hr',
    path: '/admin/benefits',
    width: 'wide',
    setup: async (page) => {
      await benefitsWorld(page).install();
      await benefitsSignedIn(page, ['benefit.plan.manage', 'benefit.read']);
    },
    ready: (page) => page.getByRole('tablist').first(),
  },
  {
    area: 'hr',
    path: '/admin/notifications',
    width: 'wide',
    setup: async (page) => {
      await notificationsSession(page, [
        'notification.template.manage',
        'notification.delivery.read',
      ]);
      await notificationsAdmin(page);
    },
    ready: (page) => page.getByRole('tablist').first(),
  },
  {
    area: 'hr',
    path: '/notifications/preferences',
    width: 'narrow',
    setup: async (page) => {
      await notificationsSession(page, []);
      await page.route(`${API}/notifications/me/preferences`, (route) =>
        documentsJson(route, { items: [] }),
      );
    },
    ready: (page) => h1(page, /preferences/i),
  },
  {
    area: 'hr',
    path: '/admin/documents',
    width: 'wide',
    setup: async (page) => {
      await documentsSession(page, ['document.manage', 'document.read'], {
        canManageTypes: true,
        canManagePolicies: true,
      });
      await documentsAdmin(page);
    },
    ready: (page) => page.getByRole('tabpanel'),
  },
  {
    area: 'hr',
    path: '/documents/records/doc-1',
    width: 'default',
    setup: async (page) => {
      await documentsSession(page, ['document.read', 'document.manage'], {});
      await page.route(`${API}/documents/records/doc-1`, (route) =>
        documentsJson(route, record([version(1, { state: 'SUPERSEDED' }), version(2)])),
      );
    },
    ready: (page) => page.getByRole('region', { name: 'Versions', exact: true }),
  },
];
