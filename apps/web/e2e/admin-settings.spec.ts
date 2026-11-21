import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';

const identity = {
  id: 'features-user',
  personId: 'person-features-user',
  email: 'ada@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const ORG = '7d3c3c5e-0000-4000-8000-0000000000aa';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Matches an API path regardless of its query string. */
const path = (pathname: string) => (url: URL) => url.origin === API && url.pathname === pathname;

async function mockSession(page: Page, permissions: string[]) {
  let signedIn = false;
  await page.route('**/auth/refresh', (route) =>
    signedIn ? json(route, { accessToken: 'features-token', identity }, 201) : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'features-token', identity }, 201);
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
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

type Module = {
  module: string;
  name: string;
  requires: string[];
  enabled: boolean;
  version: number;
};

/** A small stateful stand-in for the /admin/features API. */
function featuresServer() {
  const modules: Module[] = [
    { module: 'ATTENDANCE', name: 'Time & attendance', requires: [], enabled: true, version: 0 },
    { module: 'COMPENSATION', name: 'Compensation', requires: [], enabled: true, version: 0 },
    {
      module: 'PAYROLL',
      name: 'Payroll',
      requires: ['COMPENSATION', 'ATTENDANCE'],
      enabled: true,
      version: 0,
    },
    { module: 'DOCUMENTS', name: 'Documents', requires: [], enabled: true, version: 0 },
  ];
  const settings = [
    {
      key: 'documents.selfServiceProvide',
      section: 'DOCUMENTS',
      name: 'Employees provide documents',
      description: 'Employees may provide their own documents through self-service.',
      type: { kind: 'boolean' },
      value: true as boolean | number | string,
      default: true,
      isDefault: true,
      schemaVersion: 1,
      version: 0,
      updatedAt: null as string | null,
      updatedByUserId: null as string | null,
    },
  ];
  const history: Array<Record<string, unknown>> = [];
  const bodies: Array<{ url: string; body: unknown }> = [];
  let clock = Date.parse('2026-10-06T10:00:00.000Z');

  const enabled = (m: string) => modules.find((x) => x.module === m)?.enabled ?? true;
  const moduleShape = (m: Module) => ({
    module: m.module,
    name: m.name,
    description: `${m.name} module.`,
    enabled: m.enabled,
    isDefault: m.version === 0,
    requires: m.requires,
    dependents: modules.filter((x) => x.requires.includes(m.module)).map((x) => x.module),
    blockedBy: m.requires.filter((r) => !enabled(r)),
    version: m.version,
    updatedAt: null,
    updatedByUserId: null,
  });
  const record = (
    kind: string,
    subject: string,
    oldValue: unknown,
    newValue: unknown,
    version: number,
  ) => {
    clock += 60_000;
    history.unshift({
      id: `change-${history.length + 1}`,
      kind,
      subject,
      oldValue,
      newValue,
      version,
      actorUserId: identity.id,
      changedAt: new Date(clock).toISOString(),
    });
  };

  return {
    modules,
    bodies,
    async install(page: Page) {
      await page.route(path('/admin/features/organizations'), (route) =>
        json(route, {
          items: [
            { id: ORG, name: 'Camp', code: 'CAMP', actions: { canRead: true, canManage: true } },
          ],
        }),
      );
      await page.route(path('/admin/features'), (route) =>
        json(route, {
          organization: { id: ORG, name: 'Camp', code: 'CAMP' },
          canManage: true,
          core: ['Organization structure', 'Employees', 'Employment assignments', 'Audit'],
          modules: modules.map(moduleShape),
          settings,
          linked: {
            timeAttendance: {
              available: true,
              endpoint: `/time/policies?organizationId=${ORG}`,
              activeLayers: 1,
              currentLayers: 1,
              organizationLayer: null,
            },
            notifications: { available: false, reason: 'FORBIDDEN' },
            googleWorkspace: { available: false, reason: 'FEATURE_DISABLED' },
          },
        }),
      );
      await page.route(path('/admin/features/history'), (route) => {
        const url = new URL(route.request().url());
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const before = url.searchParams.get('before');
        const rows = history.filter((h) => !before || (h.changedAt as string) < before);
        return json(route, {
          items: rows.slice(0, limit),
          nextBefore: rows.length > limit ? (rows[limit - 1]!.changedAt as string) : null,
        });
      });
      await page.route(/\/admin\/features\/modules\/[A-Z_]+$/, (route) => {
        const name = new URL(route.request().url()).pathname.split('/').pop()!;
        const body = route.request().postDataJSON() as {
          organizationId: string;
          enabled: boolean;
          expectedVersion: number;
        };
        bodies.push({ url: route.request().url(), body });
        const target = modules.find((m) => m.module === name)!;
        if (body.expectedVersion !== target.version) {
          return json(
            route,
            { statusCode: 409, code: 'FEATURE_VERSION_CONFLICT', currentVersion: target.version },
            409,
          );
        }
        const dependents = modules.filter((m) => m.requires.includes(name) && m.enabled);
        if (!body.enabled && dependents.length) {
          return json(
            route,
            {
              statusCode: 409,
              code: 'FEATURE_DEPENDENTS_ENABLED',
              message: 'Payroll depends on Compensation; disable it first.',
              module: name,
              dependents: dependents.map((m) => m.module),
            },
            409,
          );
        }
        const old = target.enabled;
        target.enabled = body.enabled;
        target.version += 1;
        record('MODULE', name, old, body.enabled, target.version);
        return json(route, { module: moduleShape(target) });
      });
      await page.route(/\/admin\/features\/settings\/[^/]+(\/reset)?$/, (route) => {
        const parts = new URL(route.request().url()).pathname.split('/');
        const reset = parts.at(-1) === 'reset';
        const key = decodeURIComponent(reset ? parts.at(-2)! : parts.at(-1)!);
        const body = route.request().postDataJSON() as { value?: boolean; expectedVersion: number };
        bodies.push({ url: route.request().url(), body });
        const target = settings.find((s) => s.key === key)!;
        if (body.expectedVersion !== target.version) {
          return json(route, { statusCode: 409, code: 'FEATURE_VERSION_CONFLICT' }, 409);
        }
        const old = target.isDefault ? null : target.value;
        target.version += 1;
        target.value = reset ? target.default : body.value!;
        target.isDefault = reset;
        target.updatedAt = new Date(clock).toISOString();
        record('SETTING', key, old, reset ? null : body.value, target.version);
        return json(route, { setting: target });
      });
    },
  };
}

test('an administrator disables a module after confirming and sees dependency refusals', async ({
  page,
}) => {
  await mockSession(page, ['feature.manage']);
  const server = featuresServer();
  await server.install(page);

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Features', exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings & features' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Core HR areas' }).getByRole('listitem')).toHaveCount(
    4,
  );

  // A required module is locked while its dependent is enabled.
  const compensation = page.getByRole('switch', { name: 'Compensation enabled' });
  await expect(compensation).toBeDisabled();
  await expect(page.getByText('Turn off Payroll first: it depends on Compensation.')).toBeVisible();

  // Disabling asks for confirmation; cancelling changes nothing.
  const documents = page.getByRole('switch', { name: 'Documents enabled' });
  await documents.click();
  const dialog = page.getByRole('alertdialog', { name: 'Turn off Documents?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Data is kept.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(documents).toBeChecked();
  expect(server.bodies).toHaveLength(0);

  await documents.click();
  await page.getByRole('button', { name: 'Turn off Documents' }).click();
  await expect(page.getByText('Documents turned off.')).toBeVisible();
  await expect(documents).not.toBeChecked();
  expect(server.bodies.at(-1)?.body).toEqual({
    organizationId: ORG,
    enabled: false,
    expectedVersion: 0,
  });
  await expect(page.getByRole('region', { name: 'Change history' }).getByRole('row')).toHaveCount(
    2,
  );

  // Turn Payroll off, then Compensation becomes switchable…
  await page.getByRole('switch', { name: 'Payroll enabled' }).click();
  await page.getByRole('button', { name: 'Turn off Payroll' }).click();
  await expect(page.getByText('Payroll turned off.')).toBeVisible();
  await expect(compensation).toBeEnabled();
  // …but someone re-enables Payroll meanwhile: the API refuses and the page reloads.
  server.modules.find((m) => m.module === 'PAYROLL')!.enabled = true;
  await compensation.click();
  await page.getByRole('button', { name: 'Turn off Compensation' }).click();
  await expect(
    page.getByRole('alert').filter({
      hasText: 'This module cannot be turned off while Payroll depends on it. Turn it off first.',
    }),
  ).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Payroll enabled' })).toBeChecked();
  await expect(compensation).toBeDisabled();
  await expect(compensation).toBeChecked();

  // Linked sections show the summary or why they are unavailable.
  const time = page.getByRole('article', { name: 'Time & attendance policy' });
  await expect(time.getByRole('link', { name: 'Manage attendance policies' })).toHaveAttribute(
    'href',
    '/admin/time',
  );
  await expect(
    page
      .getByRole('article', { name: 'Google Workspace' })
      .getByText('This module is turned off for the organization.'),
  ).toBeVisible();
});

test('an administrator edits and resets a setting and reviews the history', async ({ page }) => {
  await mockSession(page, ['feature.manage']);
  const server = featuresServer();
  await server.install(page);

  await signIn(page);
  await page.goto('/admin/settings');
  const item = page.getByRole('listitem', { name: 'Setting Employees provide documents' });
  const control = item.getByRole('switch', { name: 'Employees provide documents' });
  await expect(control).toBeChecked();
  await expect(item.getByText('Default', { exact: true })).toBeVisible();
  await expect(item.getByRole('button', { name: /Reset/ })).toBeDisabled();
  await expect(page.getByText('No changes have been made', { exact: false })).toBeVisible();

  await control.click();
  await expect(page.getByText('Employees provide documents saved.')).toBeVisible();
  await expect(control).not.toBeChecked();
  await expect(item.getByText('Customized')).toBeVisible();
  expect(server.bodies.at(-1)?.body).toEqual({
    organizationId: ORG,
    value: false,
    expectedVersion: 0,
  });

  await item.getByRole('button', { name: 'Reset Employees provide documents to default' }).click();
  await expect(page.getByText('Employees provide documents reset to its default.')).toBeVisible();
  await expect(control).toBeChecked();
  await expect(item.getByText('Default', { exact: true })).toBeVisible();
  expect(server.bodies.at(-1)).toEqual({
    url: `${API}/admin/features/settings/documents.selfServiceProvide/reset`,
    body: { organizationId: ORG, expectedVersion: 1 },
  });

  const history = page.getByRole('region', { name: 'Change history' });
  const rows = history.getByRole('row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText('Employees provide documents');
  await expect(rows.nth(1)).toContainText('Off');
  await expect(rows.nth(1)).toContainText('Default');
  await expect(rows.nth(1)).toContainText('You');
  await expect(rows.nth(2)).toContainText('Default');
  await expect(rows.nth(2)).toContainText('Off');
  await expect(history.getByRole('button', { name: 'Load more' })).toHaveCount(0);
});

test('the change history loads older pages', async ({ page }) => {
  await mockSession(page, ['feature.read']);
  const server = featuresServer();
  await server.install(page);
  const items = Array.from({ length: 25 }, (_, index) => ({
    id: `h-${index}`,
    kind: 'MODULE',
    subject: index % 2 ? 'DOCUMENTS' : 'PAYROLL',
    oldValue: true,
    newValue: false,
    version: 25 - index,
    actorUserId: null,
    changedAt: new Date(Date.parse('2026-10-06T10:00:00.000Z') - index * 60_000).toISOString(),
  }));
  await page.route(path('/admin/features/history'), (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get('limit'));
    const before = url.searchParams.get('before');
    const rows = items.filter((h) => !before || h.changedAt < before);
    return json(route, {
      items: rows.slice(0, limit),
      nextBefore: rows.length > limit ? rows[limit - 1]!.changedAt : null,
    });
  });

  await signIn(page);
  await page.goto('/admin/settings');
  const history = page.getByRole('region', { name: 'Change history' });
  await expect(history.getByRole('row')).toHaveCount(21);
  await history.getByRole('button', { name: 'Load more' }).click();
  await expect(history.getByRole('row')).toHaveCount(26);
  await expect(history.getByRole('button', { name: 'Load more' })).toHaveCount(0);
  await expect(history.getByRole('row').nth(1)).toContainText('System');
});

test('Settings & features is hidden without feature permissions', async ({ page }) => {
  await mockSession(page, ['organization.read', 'notification.settings.manage']);
  await signIn(page);
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Organization' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Features', exact: true }),
  ).toHaveCount(0);
  await page.goto('/admin/settings');
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.getByText('You do not have permission to manage features.')).toBeVisible();
});
