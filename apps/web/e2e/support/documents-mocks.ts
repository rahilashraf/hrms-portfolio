import { expect, type Page, type Route } from '@playwright/test';
import { API } from './api-origin';
import { expectNoSeriousA11yViolations } from './axe';

// Batch 10E-2: moved unchanged from e2e/batch-9-documents.spec.ts so batch-10e2.spec.ts can reuse it.
export const ORG = '11111111-1111-4111-8111-111111111111';
export const DEPT = '22222222-2222-4222-8222-222222222222';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;
const UPLOADS = {
  enabled: true,
  maxBytes: 10 * 1024 * 1024,
  allowedTypes: ['application/pdf', 'image/png', 'image/jpeg'],
};
export const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);

const identity = {
  id: 'user-9',
  personId: 'person-9',
  email: 'hr@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

export const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

export async function session(page: Page, permissions: string[], actions: Record<string, boolean>) {
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: '9-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    }),
  );
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: identity.id, email: identity.email, displayName: 'Harper HR' },
      systemPermissions: [],
      organizations: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: ['DOCUMENTS'],
          permissions,
          isEmployee: true,
          isManager: false,
        },
      ],
    }),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => json(route, { unread: 0 }));
  await page.route(`${API}/documents/organizations`, (route) =>
    json(route, {
      items: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          actions: {
            canManageTypes: false,
            canManagePolicies: false,
            canReadRecords: true,
            canManageRecords: true,
            ...actions,
          },
        },
      ],
      uploads: UPLOADS,
    }),
  );
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

export const file = (overrides: Record<string, unknown> = {}) => ({
  fileName: 'agreement.pdf',
  sizeBytes: 182_000,
  mimeType: 'application/pdf',
  scanStatus: 'NOT_SCANNED',
  downloadable: true,
  ...overrides,
});

export const version = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `v-${n}`,
  versionNumber: n,
  provider: 'INTERNAL_OBJECT_STORAGE',
  externalUrl: null,
  fileName: `agreement-v${n}.pdf`,
  mimeType: 'application/pdf',
  sizeBytes: 182_000,
  file: file({ fileName: `agreement-v${n}.pdf` }),
  legacyReference: false,
  issuedOn: null,
  effectiveOn: null,
  expiresOn: null,
  expiryStatus: 'NO_EXPIRY',
  note: null,
  referenceStatus: 'UNKNOWN',
  current: false,
  supersededAt: '2026-11-03T15:00:00.000Z',
  createdAt: `2026-11-0${n}T15:00:00.000Z`,
  ...overrides,
});

export const record = (versions: unknown[]) => ({
  id: 'doc-1',
  organizationId: ORG,
  employeeId: 'emp-1',
  employmentAssignmentId: null,
  type: {
    id: 'ty-1',
    code: 'EMPLOYMENT-AGREEMENT',
    name: 'Employment agreement',
    category: 'EMPLOYMENT_AGREEMENT',
    expiryTracked: false,
  },
  title: 'Employment agreement',
  description: null,
  confidentiality: 'HR_ONLY',
  status: 'ACTIVE',
  source: 'HR',
  provenance: null,
  archivedAt: null,
  currentVersion: (versions as Array<{ current: boolean }>).find((v) => v.current) ?? null,
  expiryStatus: 'NO_EXPIRY',
  versions,
  createdAt: '2026-11-01T15:00:00.000Z',
  actions: { canManage: true },
});

/** Batch 10F: moved unchanged from e2e/batch-10e2.spec.ts — documents administration (every list empty). */
export async function documentsAdmin(page: Page) {
  await page.route(
    (url) =>
      url.origin === API &&
      url.pathname.startsWith('/documents/') &&
      !url.pathname.startsWith('/documents/organizations'),
    (route) =>
      route.request().method() === 'GET'
        ? json(route, { items: [], nextAfterId: null })
        : json(route, { message: 'Not found' }, 404),
  );
}
