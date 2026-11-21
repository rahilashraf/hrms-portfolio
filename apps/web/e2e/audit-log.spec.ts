import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';

const identity = {
  id: 'audit-user',
  personId: 'person-audit-user',
  email: 'auditor@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const ORG = '7d3c3c5e-0000-4000-8000-0000000000bb';
const ACTOR = '0b9a7c66-1111-4222-8333-444455556666';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Matches an API path regardless of its query string. */
const path = (pathname: string) => (url: URL) => url.origin === API && url.pathname === pathname;

async function mockSession(page: Page, permissions: string[]) {
  let signedIn = false;
  await page.route('**/auth/refresh', (route) =>
    signedIn ? json(route, { accessToken: 'audit-token', identity }, 201) : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'audit-token', identity }, 201);
  });
  await page.route('**/auth/me', (route) =>
    signedIn ? json(route, identity) : json(route, {}, 401),
  );
  await page.route('**/auth/me/authorization', (route) =>
    json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({
        key,
        scopes: [{ type: 'ORGANIZATION', id: ORG }],
      })),
    }),
  );
  await page.route(path('/notifications/me/unread-count'), (route) => json(route, { unread: 0 }));
  // The auditor has no organization.read: the organization is shown by its id.
  await page.route(path('/organizations'), (route) =>
    json(route, { statusCode: 403, message: 'Forbidden' }, 403),
  );
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const entry = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  occurredAt: new Date(Date.parse('2026-10-05T12:00:00.000Z') - n * 60_000).toISOString(),
  action: 'EMPLOYEE_UPDATED',
  entityType: 'Employee',
  entityId: `emp-${n}`,
  actor: { userId: ACTOR, displayName: 'Ada Auditor' },
  requestId: `req-${n}`,
  metadata: { organizationId: ORG, changedFields: ['firstName', 'lastName'] },
  ...overrides,
});

test('an auditor filters the audit log, loads more and sees metadata as text', async ({ page }) => {
  await mockSession(page, ['audit.read']);
  const requests: URL[] = [];
  await page.route(path('/audit'), (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const cursor = url.searchParams.get('cursor');
    const range = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };
    if (!url.searchParams.get('action')) {
      return json(route, {
        items: [
          entry(1, {
            action: 'SETTING_CHANGED',
            metadata: {
              organizationId: ORG,
              key: 'retention.auditLogMonths',
              status: '<script>window.__pwned = true</script>',
            },
          }),
        ],
        nextCursor: null,
        range,
      });
    }
    if (!cursor) {
      return json(route, { items: [entry(2), entry(3)], nextCursor: 'page-2', range });
    }
    return json(route, {
      items: [entry(4, { actor: null, requestId: null })],
      nextCursor: null,
      range,
    });
  });

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Audit Log', exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/audit$/);
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Organization' })).toHaveValue(ORG);

  // Metadata is rendered as text, never as markup.
  const first = page.getByRole('row', { name: 'Audit entry SETTING_CHANGED' });
  await expect(first).toBeVisible();
  await expect(first.getByText('retention.auditLogMonths')).toBeVisible();
  await expect(first.getByText('<script>window.__pwned = true</script>')).toBeVisible();
  expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBeUndefined();
  expect(requests[0]!.searchParams.get('organizationId')).toBe(ORG);
  expect(requests[0]!.searchParams.get('limit')).toBe('50');

  // A malformed id typed by hand (Batch R3.3: "Enter an ID instead" in the actor picker) is
  // explained without a request.
  await page.getByRole('button', { name: 'Enter an ID instead' }).click();
  await page.getByRole('textbox', { name: 'User id' }).fill('someone');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('The actor user id must be a UUID.')).toBeVisible();
  expect(requests).toHaveLength(1);

  await page.getByRole('textbox', { name: 'User id' }).fill(ACTOR);
  await page.getByLabel('Action').fill('EMPLOYEE_UPDATED');
  await page.getByRole('combobox', { name: 'Record type', exact: true }).selectOption('Employee');
  await page.getByLabel('From (date)').fill('2026-09-01');
  await page.getByLabel('To (date, inclusive)').fill('2026-09-30');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('row', { name: 'Audit entry EMPLOYEE_UPDATED' })).toHaveCount(2);
  const filtered = requests.at(-1)!;
  expect(filtered.searchParams.get('action')).toBe('EMPLOYEE_UPDATED');
  expect(filtered.searchParams.get('entityType')).toBe('Employee');
  expect(filtered.searchParams.get('actorUserId')).toBe(ACTOR);
  expect(filtered.searchParams.get('from')).toBeTruthy();
  expect(filtered.searchParams.get('to')).toBeTruthy();
  expect(filtered.searchParams.get('cursor')).toBeNull();

  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByRole('row', { name: 'Audit entry EMPLOYEE_UPDATED' })).toHaveCount(3);
  const more = requests.at(-1)!;
  expect(more.searchParams.get('cursor')).toBe('page-2');
  expect(more.searchParams.get('action')).toBe('EMPLOYEE_UPDATED');
  await expect(page.getByText('System')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  await expect(page.getByText('Ada Auditor').first()).toBeVisible();
});

test('the API refusal of a too wide range is explained', async ({ page }) => {
  await mockSession(page, ['audit.read']);
  await page.route(path('/audit'), (route) =>
    json(
      route,
      {
        statusCode: 400,
        code: 'AUDIT_RANGE_TOO_WIDE',
        message: 'A query covers at most 366 days.',
      },
      400,
    ),
  );
  await signIn(page);
  await page.goto('/admin/audit');
  await expect(page.getByText(/may cover at most 366 days/)).toBeVisible();
});

test('sign-in and account security events read as names, with reason codes but no addresses (Batch 2)', async ({
  page,
}) => {
  await mockSession(page, ['audit.read']);
  await page.route(path('/audit'), (route) =>
    json(route, {
      items: [
        entry(1, {
          action: 'AUTH_LOGIN_FAILED',
          entityType: 'User',
          actor: null,
          metadata: { organizationId: ORG, reasonCode: 'INVALID_PASSWORD' },
        }),
        entry(2, {
          action: 'EMPLOYEE_ACCOUNT_PASSWORD_CHANGE_REQUIRED',
          entityType: 'User',
          metadata: { organizationId: ORG, signedOut: true, revokedSessionCount: 2 },
        }),
      ],
      nextCursor: null,
      range: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
    }),
  );
  await signIn(page);
  await page.goto('/admin/audit');
  const failed = page.getByRole('row', { name: 'Audit entry AUTH_LOGIN_FAILED' });
  await expect(failed.getByText('Sign-in failed')).toBeVisible();
  await expect(failed.getByText('INVALID_PASSWORD')).toBeVisible();
  await expect(
    page
      .getByRole('row', { name: 'Audit entry EMPLOYEE_ACCOUNT_PASSWORD_CHANGE_REQUIRED' })
      .getByText('Password change required'),
  ).toBeVisible();
  // Organization-scoped readers get no System view.
  await expect(page.getByRole('option', { name: 'System (no organization)' })).toHaveCount(0);
});

test('Audit log is hidden without audit.read', async ({ page }) => {
  await mockSession(page, ['feature.manage', 'role.read']);
  await signIn(page);
  await expect(
    page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Features', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Audit Log' })).toHaveCount(0);
  await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
});
