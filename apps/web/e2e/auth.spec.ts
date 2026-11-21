import { expect, test } from '@playwright/test';

const identity = {
  id: 'user-1',
  personId: 'person-1',
  email: 'person@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

test.beforeEach(async ({ page }) => {
  await page.route('**/auth/refresh', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
});

test('unauthenticated dashboard navigation redirects to login', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
});

test('successful mocked login reaches the dashboard and logout returns to login', async ({
  page,
}) => {
  await page.route('**/auth/login', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken: 'test-access-token', identity }),
    }),
  );
  await page.route('**/auth/logout', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }),
  );

  await page.goto('/login');
  await page.getByLabel('Email').fill('person@example.com');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('main').getByText('person@example.com')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});
