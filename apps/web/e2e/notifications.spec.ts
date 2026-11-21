import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';

const identity = {
  id: 'notifications-user',
  personId: 'person-notifications-user',
  email: 'ada@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Matches an API path regardless of its query string. */
const path = (pathname: string) => (url: URL) => url.origin === API && url.pathname === pathname;

async function mockSession(page: Page, permissions: string[]) {
  let signedIn = false;
  await page.route('**/auth/refresh', (route) =>
    signedIn
      ? json(route, { accessToken: 'notifications-token', identity }, 201)
      : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'notifications-token', identity }, 201);
  });
  await page.route('**/auth/me', (route) =>
    signedIn ? json(route, identity) : json(route, {}, 401),
  );
  await page.route('**/auth/me/authorization', (route) =>
    json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({
        key,
        scopes: [{ type: 'ORGANIZATION', id: 'org-1' }],
      })),
    }),
  );
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

function notification(id: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    organizationId: 'org-1',
    organization: { id: 'org-1', name: 'Camp' },
    type: 'onboarding.tasks-due',
    category: 'ONBOARDING',
    mandatory: false,
    title,
    body: `${title} — details.`,
    link: '/onboarding',
    sourceDomain: 'ONBOARDING',
    createdAt: '2026-10-05T12:00:00.000Z',
    readAt: null as string | null,
    archivedAt: null as string | null,
    ...overrides,
  };
}

const CATEGORIES = [
  'SECURITY',
  'HR_REQUIRED',
  'ONBOARDING',
  'DOCUMENTS',
  'PERFORMANCE',
  'RECRUITMENT',
  'LEAVE',
  'SCHEDULING',
  'PAYROLL',
  'BENEFITS',
  'GENERAL',
];

function categories(off: string[] = []) {
  return CATEGORIES.map((category) => {
    const mandatory = category === 'SECURITY' || category === 'HR_REQUIRED';
    return {
      category,
      mandatory,
      configurable: !mandatory,
      emailEnabled: mandatory || !off.includes(category),
    };
  });
}

test('the bell counts unread notifications and the center marks them read', async ({ page }) => {
  await mockSession(page, []);
  const READ_AT = '2026-10-06T10:00:00.000Z';
  const items = [
    notification('n-1', 'Onboarding tasks need your attention'),
    notification('n-2', 'A document needs renewal', {
      category: 'DOCUMENTS',
      link: '//evil.example.com/phish',
    }),
    notification('n-3', 'Required documents are missing', {
      category: 'HR_REQUIRED',
      mandatory: true,
      link: '/documents',
    }),
  ];
  let readAllBody: unknown = null;
  await page.route(path('/notifications/me/unread-count'), (route) =>
    json(route, { unread: items.filter((item) => !item.readAt).length }),
  );
  await page.route(path('/notifications/me'), (route) => {
    const url = new URL(route.request().url());
    const unreadOnly = url.searchParams.get('unreadOnly') === 'true';
    return json(route, {
      items:
        url.searchParams.get('archived') === 'true'
          ? []
          : items.filter((item) => !unreadOnly || !item.readAt),
      nextCursor: null,
    });
  });
  await page.route(path('/notifications/me/n-1/read'), (route) => {
    items[0]!.readAt = READ_AT;
    return json(route, items[0]);
  });
  await page.route(path('/notifications/me/read-all'), (route) => {
    readAllBody = route.request().postDataJSON();
    const updated = items.filter((item) => !item.readAt).length;
    for (const item of items) item.readAt ??= READ_AT;
    return json(route, { updated });
  });

  await signIn(page);
  await expect(page.getByRole('link', { name: 'Notification Settings' })).toHaveCount(0);
  const bell = page.getByRole('link', { name: 'Notifications, 3 unread' });
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();

  const first = page.getByRole('listitem', {
    name: 'Notification Onboarding tasks need your attention',
  });
  await expect(first).toHaveAttribute('data-unread', 'true');
  await expect(
    first.getByRole('link', { name: 'Open Onboarding tasks need your attention' }),
  ).toHaveAttribute('href', '/onboarding');
  // A protocol-relative link is never rendered.
  await expect(
    page.getByRole('listitem', { name: 'Notification A document needs renewal' }).getByRole('link'),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('listitem', { name: 'Notification Required documents are missing' })
      .getByText('Mandatory'),
  ).toBeVisible();

  await first
    .getByRole('button', { name: 'Mark Onboarding tasks need your attention read' })
    .click();
  await expect(first).toHaveAttribute('data-unread', 'false');
  await expect(page.getByRole('link', { name: 'Notifications, 2 unread' })).toBeVisible();

  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByText('2 notifications marked read.')).toBeVisible();
  expect(readAllBody).toEqual({});
  await expect(page.getByRole('link', { name: 'Notifications', exact: true })).toBeVisible();
  await expect(page.locator('li[data-unread="true"]')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Unread' }).click();
  await expect(page.getByText('You have no unread notifications.')).toBeVisible();
});

test('a user turns off email for a category while mandatory ones stay locked', async ({ page }) => {
  await mockSession(page, []);
  let saved: unknown = null;
  await page.route(path('/notifications/me/unread-count'), (route) => json(route, { unread: 0 }));
  await page.route(path('/notifications/me'), (route) =>
    json(route, { items: [], nextCursor: null }),
  );
  await page.route(path('/notifications/me/preferences'), (route) => {
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      return json(route, { inApp: 'ALWAYS', items: categories(['LEAVE']) });
    }
    return json(route, { inApp: 'ALWAYS', items: categories() });
  });

  await signIn(page);
  await page.getByRole('link', { name: 'Notifications', exact: true }).click();
  await expect(page.getByText('You have no notifications.')).toBeVisible();
  await page.getByRole('link', { name: 'Email preferences' }).click();
  await expect(page.getByRole('heading', { name: 'Notification preferences' })).toBeVisible();
  await expect(
    page.getByText('In-app notifications are always on', { exact: false }),
  ).toBeVisible();

  const security = page.getByLabel('Email for Security');
  await expect(security).toBeChecked();
  await expect(security).toBeDisabled();
  await expect(page.getByLabel('Email for Required HR notices')).toBeDisabled();
  await expect(page.getByText('Mandatory — always emailed')).toHaveCount(2);

  await page.getByLabel('Email for Leave').uncheck();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByText('Email preferences saved.')).toBeVisible();
  const body = saved as { preferences: Array<{ category: string; emailEnabled: boolean }> };
  expect(body.preferences).toHaveLength(9);
  expect(body.preferences).toContainEqual({ category: 'LEAVE', emailEnabled: false });
  expect(body.preferences.map((item) => item.category)).not.toContain('SECURITY');
  await expect(page.getByLabel('Email for Leave')).not.toBeChecked();
});

test('an administrator edits a template override with a live preview and email settings', async ({
  page,
}) => {
  await mockSession(page, ['notification.template.manage', 'notification.settings.manage']);
  const systemTemplate = {
    id: 'sys-1',
    organizationId: null,
    key: 'onboarding.tasks-due',
    category: 'ONBOARDING',
    subjectTemplate: 'Onboarding tasks need your attention',
    bodyTemplate:
      'You have {{overdueCount}} overdue and {{dueSoonCount}} upcoming workflow tasks: {{taskTitles}}.',
    allowedVariables: ['overdueCount', 'dueSoonCount', 'taskTitles'],
    mandatory: false,
    status: 'ACTIVE',
    version: 1,
    system: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
  };
  let override = {
    ...systemTemplate,
    id: '7d3c3c5e-0000-4000-8000-000000000001',
    organizationId: 'org-1',
    system: false,
    version: 1,
    subjectTemplate: 'Camp onboarding reminder',
    bodyTemplate: '{{overdueCount}} tasks are overdue.',
  };
  const sample: Record<string, string> = {
    overdueCount: '1',
    dueSoonCount: '2',
    taskTitles: 'Set up accounts',
  };
  const render = (text: string) =>
    text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => sample[name] ?? '');
  let patchBody: unknown = null;
  let settingsBody: unknown = null;
  let settings = {
    organizationId: 'org-1',
    emailEnabled: true,
    suppressMandatoryEmail: false,
    categories: categories(),
    updatedAt: null as string | null,
  };

  await page.route(path('/notifications/me/unread-count'), (route) => json(route, { unread: 0 }));
  await page.route(path('/notifications/organizations'), (route) =>
    json(route, {
      items: [
        {
          id: 'org-1',
          name: 'Camp',
          code: 'CAMP',
          timezone: 'America/Toronto',
          actions: { canManageTemplates: true, canManageSettings: true },
        },
      ],
    }),
  );
  await page.route(path('/notifications/templates'), (route) =>
    json(route, {
      items: [
        {
          key: 'onboarding.tasks-due',
          category: 'ONBOARDING',
          mandatory: false,
          allowedVariables: systemTemplate.allowedVariables,
          sample,
          system: systemTemplate,
          override,
        },
      ],
    }),
  );
  await page.route(path('/notifications/templates/preview'), (route) => {
    const url = new URL(route.request().url());
    const body = url.searchParams.get('bodyTemplate') ?? override.bodyTemplate;
    if (/\{\{\s*secret\s*\}\}/.test(body)) {
      return json(
        route,
        {
          statusCode: 400,
          code: 'NOTIFICATION_TEMPLATE_PLACEHOLDER',
          message: 'bodyTemplate uses unknown placeholders: secret.',
        },
        400,
      );
    }
    return json(route, {
      key: 'onboarding.tasks-due',
      variables: sample,
      subject: render(url.searchParams.get('subjectTemplate') ?? override.subjectTemplate),
      body: render(body),
    });
  });
  await page.route(path(`/notifications/templates/${override.id}`), (route) => {
    patchBody = route.request().postDataJSON();
    override = { ...override, ...(patchBody as object), version: override.version + 1 };
    return json(route, override);
  });
  await page.route(path('/notifications/settings'), (route) => {
    if (route.request().method() === 'PUT') {
      settingsBody = route.request().postDataJSON();
      const body = settingsBody as typeof settings;
      settings = {
        ...settings,
        emailEnabled: body.emailEnabled,
        suppressMandatoryEmail: body.suppressMandatoryEmail,
        updatedAt: '2026-10-06T10:00:00.000Z',
      };
      return json(route, settings);
    }
    return json(route, settings);
  });

  await signIn(page);
  await page.getByRole('link', { name: 'Notification Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Notifications administration' })).toBeVisible();

  const card = page.getByRole('region', { name: 'onboarding.tasks-due' });
  await expect(card.getByText('System default (read-only)')).toBeVisible();
  await expect(card.getByText('Custom template · version 1')).toBeVisible();
  await expect(
    card
      .getByRole('list', { name: 'Allowed variables for onboarding.tasks-due' })
      .getByText('{{taskTitles}}'),
  ).toBeVisible();
  await card.getByRole('button', { name: 'Edit custom template onboarding.tasks-due' }).click();
  const form = card.getByRole('form', { name: 'Edit template onboarding.tasks-due' });
  await expect(form.getByLabel('Subject')).toHaveValue('Camp onboarding reminder');
  const preview = form.getByRole('region', { name: 'Preview onboarding.tasks-due' });
  await expect(preview.getByText('1 tasks are overdue.')).toBeVisible();

  await form.getByLabel('Body').fill('Hi {{secret}}');
  await expect(
    preview.getByText('The template uses a placeholder this notification does not provide.', {
      exact: false,
    }),
  ).toBeVisible();
  await form
    .getByLabel('Body')
    .fill('{{overdueCount}} overdue and {{dueSoonCount}} upcoming tasks: {{taskTitles}}.');
  await expect(preview.getByText('1 overdue and 2 upcoming tasks: Set up accounts.')).toBeVisible();
  await form.getByRole('button', { name: 'Save custom template' }).click();
  await expect(page.getByText('Custom template for onboarding.tasks-due saved.')).toBeVisible();
  expect(patchBody).toEqual({
    subjectTemplate: 'Camp onboarding reminder',
    bodyTemplate: '{{overdueCount}} overdue and {{dueSoonCount}} upcoming tasks: {{taskTitles}}.',
  });
  await expect(card.getByText('Custom template · version 2')).toBeVisible();

  await page.getByRole('tab', { name: 'Email settings' }).click();
  const settingsForm = page.getByRole('form', { name: 'Organization email settings' });
  await expect(settingsForm.getByLabel('Email for Security')).toBeDisabled();
  await expect(settingsForm.getByLabel('Also suppress mandatory email')).toHaveCount(0);
  await settingsForm.getByLabel('Send notification email for this organization').uncheck();
  await expect(
    settingsForm.getByText('Email is turned off for this organization.', { exact: false }),
  ).toBeVisible();
  await settingsForm.getByLabel('Also suppress mandatory email').check();
  await expect(settingsForm.getByRole('alert')).toContainText(
    'people will not receive security or required HR notices by email',
  );
  await settingsForm.getByLabel('Email for Payroll').uncheck();
  await settingsForm.getByRole('button', { name: 'Save email settings' }).click();
  await expect(page.getByText('Notification email settings saved.')).toBeVisible();
  const sent = settingsBody as {
    organizationId: string;
    emailEnabled: boolean;
    suppressMandatoryEmail: boolean;
    categories: Array<{ category: string; emailEnabled: boolean }>;
  };
  expect(sent.organizationId).toBe('org-1');
  expect(sent.emailEnabled).toBe(false);
  expect(sent.suppressMandatoryEmail).toBe(true);
  expect(sent.categories).toContainEqual({ category: 'PAYROLL', emailEnabled: false });
  expect(sent.categories.map((item) => item.category)).not.toContain('HR_REQUIRED');
});
