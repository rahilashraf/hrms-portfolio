import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/** Batch 2: account security — password change, sessions and the required change flow. */
const identity = {
  id: 'user-1',
  personId: 'person-1',
  email: 'person@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const path = (pathname: string) => (url: URL) => url.origin === API && url.pathname === pathname;

const sessions = [
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
  {
    id: '00000000-0000-4000-8000-00000000000b',
    current: false,
    createdAt: '2026-10-20T08:00:00.000Z',
    lastUsedAt: '2026-10-28T19:00:00.000Z',
    expiresAt: '2026-11-19T08:00:00.000Z',
    ipAddress: '198.51.100.4',
    browser: 'Safari',
    os: 'iOS',
  },
];

async function mockSession(page: Page, current: { mustChangePassword: boolean }) {
  let signedIn = false;
  const who = () => ({ ...identity, mustChangePassword: current.mustChangePassword });
  await page.route('**/auth/refresh', (route) =>
    signedIn ? json(route, { accessToken: 'token' }, 201) : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'token', identity: who() }, 201);
  });
  await page.route('**/auth/me', (route) => (signedIn ? json(route, who()) : json(route, {}, 401)));
  await page.route('**/auth/me/authorization', (route) =>
    current.mustChangePassword
      ? json(route, { statusCode: 403, code: 'PASSWORD_CHANGE_REQUIRED' }, 403)
      : json(route, { userId: identity.id, permissions: [] }),
  );
  await page.route(path('/notifications/me/unread-count'), (route) => json(route, { unread: 0 }));
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('Correct-Horse-Battery-42!');
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('a user changes their password and signs out another session from Account security', async ({
  page,
}) => {
  const state = { mustChangePassword: false };
  await mockSession(page, state);
  let listed = sessions;
  const changes: unknown[] = [];
  await page.route(path('/auth/sessions'), (route) => json(route, { items: listed }));
  await page.route(path(`/auth/sessions/${sessions[1]!.id}`), (route) => {
    listed = [sessions[0]!];
    return json(route, { success: true });
  });
  await page.route(path('/auth/change-password'), (route) => {
    changes.push(route.request().postDataJSON());
    return json(route, { success: true, revokedSessionCount: 1 });
  });

  await signIn(page);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole('link', { name: 'Account security' }).first().click();
  await expect(page).toHaveURL(/\/account\/security$/);
  await expect(page.getByRole('heading', { name: 'Account security' })).toBeVisible();

  // Field validation happens before anything is sent.
  await page.getByLabel('Current password').fill('Correct-Horse-Battery-42!');
  await page.getByLabel('New password', { exact: true }).fill('short');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Use 12 to 128 characters.')).toBeVisible();
  expect(changes).toEqual([]);

  await page.getByLabel('New password', { exact: true }).fill('Another-Long-Passphrase-7');
  await page.getByLabel('Confirm new password').fill('Another-Long-Passphrase-7');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(
    page.getByText('Your password was changed and one other session was signed out.'),
  ).toBeVisible();
  expect(changes).toEqual([
    { currentPassword: 'Correct-Horse-Battery-42!', newPassword: 'Another-Long-Passphrase-7' },
  ]);

  const list = page.getByRole('list', { name: 'Your sessions' });
  await expect(list.getByText('This device')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out Safari on iOS' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sign out session' }).click();
  await expect(page.getByText('Safari on iOS was signed out.')).toBeVisible();
  await expect(list.getByText('Safari on iOS')).toHaveCount(0);
  // Batch 3B: no serious or critical accessibility violations on the final page.
  await expectNoSeriousA11yViolations(page);
});

test('a user who must change their password sees only the change form, then the app', async ({
  page,
}) => {
  const state = { mustChangePassword: true };
  await mockSession(page, state);
  await page.route(path('/auth/change-password'), (route) => {
    state.mustChangePassword = false;
    return json(route, { success: true, revokedSessionCount: 0 });
  });

  await signIn(page);
  await expect(page).toHaveURL(/\/account\/change-password$/);
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  // The app shell (and its navigation) is not shown until the password is changed.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  // Going elsewhere leads back to the change form.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/account\/change-password$/);

  await page.getByLabel('Current password').fill('Correct-Horse-Battery-42!');
  await page.getByLabel('New password', { exact: true }).fill('Another-Long-Passphrase-7');
  await page.getByLabel('Confirm new password').fill('Another-Long-Passphrase-7');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('recovery pages are not cached, framed or sent a referrer', async ({ page }) => {
  for (const pathname of ['/login', '/reset-password', '/account/change-password']) {
    const response = await page.goto(pathname);
    const headers = response!.headers();
    // The dev server (used here) always sends its own Cache-Control; production builds send the
    // configured no-store (src/lib/security/page-headers.test.ts).
    expect(headers['cache-control'], pathname).toMatch(/no-store|no-cache/);
    expect(headers['referrer-policy'], pathname).toBe('no-referrer');
    expect(headers['x-frame-options'], pathname).toBe('DENY');
  }
});
