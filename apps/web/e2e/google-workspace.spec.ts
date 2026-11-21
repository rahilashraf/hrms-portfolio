import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';

const identity = {
  id: 'google-admin',
  personId: 'person-google-admin',
  email: 'ada@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const ORG = '11111111-1111-4111-8111-111111111111';
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Matches an API path regardless of its query string. */
const path = (pathname: string) => (url: URL) => url.origin === API && url.pathname === pathname;

async function mockSession(page: Page, permissions: string[]) {
  let signedIn = false;
  await page.route('**/auth/refresh', (route) =>
    signedIn ? json(route, { accessToken: 'google-token', identity }, 201) : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'google-token', identity }, 201);
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

const SCOPE = (name: string) => `https://www.googleapis.com/auth/${name}`;

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    mode: 'OAUTH',
    status: 'ACTIVE',
    workspaceDomain: 'camp.example.com',
    accountEmail: 'admin@camp.example.com',
    serviceAccountEmail: null,
    grantedScopes: [SCOPE('forms.body.readonly'), SCOPE('forms.responses.readonly')],
    capabilities: ['FORMS'],
    credentialsAvailable: true,
    connectedAt: '2026-10-01T12:00:00.000Z',
    connectedByUserId: identity.id,
    lastHealthCheckAt: '2026-10-05T12:00:00.000Z',
    lastHealthOk: true,
    lastErrorCode: null,
    ...overrides,
  };
}

function status(current: unknown, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    canManage: true,
    oauthConfigured: true,
    encryptionConfigured: true,
    strategies: {
      OAUTH: { default: true, available: true, requiresDomainWideDelegation: false },
      SERVICE_ACCOUNT: {
        default: false,
        optional: true,
        available: true,
        requiresDomainWideDelegation: true,
      },
    },
    capabilities: [
      {
        capability: 'FORMS',
        scopes: [SCOPE('forms.body.readonly'), SCOPE('forms.responses.readonly')],
        requiresDomainWideDelegation: false,
      },
      {
        capability: 'DRIVE_METADATA',
        scopes: [SCOPE('drive.metadata.readonly')],
        requiresDomainWideDelegation: false,
      },
      {
        capability: 'GMAIL_SEND',
        scopes: [SCOPE('gmail.send')],
        requiresDomainWideDelegation: false,
      },
      {
        capability: 'SHEETS_EXPORT',
        scopes: [SCOPE('drive.file')],
        requiresDomainWideDelegation: false,
      },
    ],
    connection: current,
    previousConnections: [],
    ...overrides,
  };
}

async function mockIntegration(
  page: Page,
  state: { connection: unknown },
  extra: { bindings?: unknown[]; runs?: unknown[] } = {},
) {
  await page.route(path('/integrations/google/organizations'), (route) =>
    json(route, {
      items: [{ id: ORG, name: 'Camp', code: 'CAMP', actions: { canRead: true, canManage: true } }],
    }),
  );
  await page.route(path('/integrations/google/status'), (route) =>
    json(route, status(state.connection)),
  );
  await page.route(path('/integrations/google/sources'), (route) =>
    json(route, {
      performanceSources: [
        { id: 'ps-1', code: 'SAFETY', name: 'Safety quiz', formId: 'form-safety0001' },
      ],
      recruitmentSources: [],
    }),
  );
  await page.route(path('/integrations/google/bindings'), (route) =>
    route.request().method() === 'GET'
      ? json(route, { items: extra.bindings ?? [] })
      : route.fallback(),
  );
  await page.route(path('/integrations/google/sync-runs'), (route) => {
    const items = extra.runs ?? [];
    return json(route, { total: items.length, limit: 10, offset: 0, items });
  });
}

test('an administrator starts the Google connection and is sent only to Google', async ({
  page,
}) => {
  await mockSession(page, ['integration.google.manage']);
  await mockIntegration(page, { connection: null });
  let startBody: unknown = null;
  await page.route(path('/integrations/google/oauth/start'), (route) => {
    startBody = route.request().postDataJSON();
    return json(route, {
      authorizationUrl: `${GOOGLE_AUTH}?client_id=hrms&state=opaque`,
      expiresAt: '2026-10-06T10:10:00.000Z',
    });
  });
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body><h1>Google consent (mock)</h1></body></html>',
    }),
  );

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Integrations', exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/integrations\/google$/);
  await expect(page.getByRole('heading', { name: 'Google Workspace' })).toBeVisible();
  const form = page.getByRole('form', { name: 'Connect with Google' });
  await expect(form.getByLabel('Google Forms (read forms and responses)')).toBeChecked();
  await expect(form.getByRole('list', { name: 'Scopes for Gmail send' })).toContainText(
    SCOPE('gmail.send'),
  );
  await expect(page.getByText('Advanced: service account (domain-wide delegation)')).toBeVisible();
  await form.getByLabel('Gmail (send notification email)').check();
  await form.getByRole('button', { name: 'Connect with Google' }).click();
  await expect(page).toHaveURL(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  await expect(page.getByRole('heading', { name: 'Google consent (mock)' })).toBeVisible();
  expect(startBody).toEqual({ organizationId: ORG, capabilities: ['FORMS', 'GMAIL_SEND'] });
});

test('the OAuth callback result is shown as a banner', async ({ page }) => {
  await mockSession(page, ['integration.google.manage']);
  const state: { connection: unknown } = { connection: null };
  await mockIntegration(page, state);
  await signIn(page);

  await page.goto('/settings/integrations/google?result=error&code=OAUTH_DENIED');
  const error = page.getByRole('alert', { name: 'Google connection result' });
  await expect(error).toContainText('Google Workspace was not connected.');
  await expect(error).toContainText('Access was not granted in Google.');
  await expect(page).toHaveURL(/\/settings\/integrations\/google$/);

  await page.goto(
    '/settings/integrations/google?result=error&code=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
  );
  await expect(page.getByRole('alert', { name: 'Google connection result' })).toContainText(
    'could not be completed',
  );
  await expect(page.locator('script', { hasText: 'alert(1)' })).toHaveCount(0);

  state.connection = connection();
  await page.goto(`/settings/integrations/google?result=connected&organizationId=${ORG}`);
  await expect(page.getByRole('status', { name: 'Google connection result' })).toContainText(
    'Google Workspace connected.',
  );
  const card = page.getByRole('region', { name: 'Connection' });
  await expect(card.getByText('camp.example.com', { exact: true })).toBeVisible();
  await expect(card.getByRole('list', { name: 'Granted capabilities' })).toContainText('Forms');
});

test('an administrator binds a form, syncs it now and reviews the run history', async ({
  page,
}) => {
  await mockSession(page, ['integration.google.manage']);
  const bindings: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  await mockIntegration(page, { connection: connection() }, { bindings, runs });
  let createBody: unknown = null;
  let syncs = 0;
  await page.route(path('/integrations/google/bindings'), (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    createBody = route.request().postDataJSON();
    const body = createBody as Record<string, unknown>;
    const binding = {
      id: '33333333-3333-4333-8333-333333333333',
      organizationId: ORG,
      formId: body.formId,
      formTitle: 'Safety quiz form',
      target: body.target,
      performanceSourceId: body.performanceSourceId ?? null,
      recruitmentSourceId: null,
      mapping: body.mapping,
      mappingSchemaVersion: 1,
      enabled: true,
      cursorSubmittedAt: null,
      lastSyncAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
      consecutiveFailures: 0,
      nextSyncAfter: null,
      archivedAt: null,
      createdAt: '2026-10-06T10:00:00.000Z',
      updatedAt: '2026-10-06T10:00:00.000Z',
    };
    bindings.push(binding);
    return json(route, binding, 201);
  });
  await page.route(
    path('/integrations/google/bindings/33333333-3333-4333-8333-333333333333/sync'),
    (route) => {
      syncs += 1;
      if (syncs > 1) {
        return json(
          route,
          {
            statusCode: 429,
            code: 'GOOGLE_SYNC_TOO_FREQUENT',
            message: 'A synchronization of this form started less than a minute ago.',
          },
          429,
        );
      }
      bindings[0]!.lastSyncAt = '2026-10-06T10:01:00.000Z';
      bindings[0]!.lastSuccessAt = '2026-10-06T10:01:00.000Z';
      runs.unshift({
        id: 'run-1',
        bindingId: bindings[0]!.id,
        target: 'PERFORMANCE_EVIDENCE',
        trigger: 'MANUAL',
        triggeredByUserId: identity.id,
        status: 'SUCCEEDED',
        startedAt: '2026-10-06T10:01:00.000Z',
        finishedAt: '2026-10-06T10:01:04.000Z',
        fetched: 4,
        accepted: 3,
        duplicates: 1,
        rejected: 0,
        errorCode: null,
      });
      return json(route, {
        status: 'SUCCEEDED',
        bindingId: bindings[0]!.id,
        runId: 'run-1',
        fetched: 4,
        accepted: 3,
        duplicates: 1,
        rejected: 0,
        errorCode: null,
      });
    },
  );

  await signIn(page);
  await page.goto('/settings/integrations/google');
  await expect(page.getByText('No Google Forms are bound to this organization.')).toBeVisible();
  await page.getByRole('button', { name: 'New form binding' }).click();
  const form = page.getByRole('form', { name: 'New form binding' });
  await form.getByLabel('Target').selectOption('PERFORMANCE_EVIDENCE');
  await form.getByLabel('Source').selectOption('ps-1');
  await expect(form.getByLabel('Google Form id')).toHaveValue('form-safety0001');
  await form.getByRole('button', { name: 'Add question' }).click();
  await form.getByLabel('Question id 1').fill('q_email');
  await form.getByLabel('Field 1').selectOption('respondentEmail');
  await form.getByRole('button', { name: 'Create binding' }).click();
  await expect(page.getByText('Form Safety quiz form bound.')).toBeVisible();
  expect(createBody).toEqual({
    organizationId: ORG,
    formId: 'form-safety0001',
    target: 'PERFORMANCE_EVIDENCE',
    performanceSourceId: 'ps-1',
    mapping: {
      schemaVersion: 1,
      fields: [{ questionId: 'q_email', field: 'respondentEmail' }],
      scoreSource: 'QUIZ_TOTAL',
    },
    enabled: true,
  });

  const item = page.getByRole('listitem', { name: 'Binding Safety quiz form' });
  await expect(item).toContainText('Safety quiz (SAFETY)');
  await item.getByRole('button', { name: 'Sync now Safety quiz form' }).click();
  await expect(
    page.getByText('Synchronization finished: 4 fetched, 3 accepted, 1 duplicates, 0 rejected.'),
  ).toBeVisible();
  const history = page.getByRole('region', { name: 'Synchronization history' });
  await expect(history.getByText('Showing 1–1 of 1')).toBeVisible();
  await expect(history.getByRole('cell', { name: 'Succeeded' })).toBeVisible();
  await expect(history.getByRole('cell', { name: 'Safety quiz form' })).toBeVisible();

  await item.getByRole('button', { name: 'Sync now Safety quiz form' }).click();
  await expect(
    page.getByText('This form was synchronized less than a minute ago.', { exact: false }),
  ).toBeVisible();
});

test('an administrator disconnects Google Workspace after confirming', async ({ page }) => {
  await mockSession(page, ['integration.google.manage']);
  const state: { connection: unknown } = { connection: connection() };
  await mockIntegration(page, state);
  let disconnectBody: unknown = null;
  await page.route(path('/integrations/google/disconnect'), (route) => {
    disconnectBody = route.request().postDataJSON();
    state.connection = null;
    return json(route, { organizationId: ORG, revoked: true, connection: null });
  });
  await signIn(page);
  await page.goto('/settings/integrations/google');
  const card = page.getByRole('region', { name: 'Connection' });
  await expect(card.getByText('Connected', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Disconnect' }).click();
  // The shared, accessible confirmation (no native browser dialog).
  const dialog = page.getByRole('alertdialog', { name: 'Disconnect Google Workspace?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('Google Workspace disconnected.')).toBeVisible();
  expect(disconnectBody).toEqual({ organizationId: ORG });
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Connect with Google' })).toBeVisible();
});

test('the Google Workspace link is hidden without integration permissions', async ({ page }) => {
  await mockSession(page, ['notification.settings.manage']);
  await signIn(page);
  await expect(page.getByRole('link', { name: 'Integrations', exact: true })).toHaveCount(0);
});
