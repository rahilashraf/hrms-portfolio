import { expect, test, type Page, type Request } from '@playwright/test';
import { API } from './support/api-origin';
import { json, type KioskMock, mockKiosk } from './support/kiosk-mocks';

/**
 * Phase 9.5 — the onsite kiosk runs on its device cookie alone: no user session, no
 * /auth/refresh, no HR navigation. These tests drive the kiosk against a mocked API.
 */

/** Every request the kiosk page sends to the API, to prove it never touches user auth. */
function recordApiRequests(page: Page) {
  const requests: string[] = [];
  page.on('request', (request: Request) => {
    if (request.url().startsWith(API)) requests.push(new URL(request.url()).pathname);
  });
  return requests;
}

async function identify(page: Page) {
  await page.getByRole('button', { name: 'Tap to start' }).click();
  await page.getByLabel('Employee number').fill('e-100');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  for (const digit of '582914')
    await page.getByRole('button', { name: digit, exact: true }).click();
}

test('enrolls a kiosk and clocks an employee in without any user session', async ({ page }) => {
  const mock: KioskMock = {
    enrolled: false,
    identification: {
      token: 'token-1',
      expiresInSeconds: 90,
      employee: { firstName: 'Ada' },
      state: 'OFF_CLOCK',
      actions: [
        {
          action: 'CLOCK_IN',
          employmentAssignmentId: 'assignment-1',
          label: 'Clock in · Counsellor',
        },
      ],
    },
    actions: [],
  };
  await mockKiosk(page, mock);
  const requests = recordApiRequests(page);

  const response = await page.goto('/kiosk');
  // (next dev rewrites Cache-Control; the production no-store header is set in next.config.)
  expect(response?.headers()['x-frame-options']).toBe('DENY');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");

  await page.getByLabel('Enrollment code').fill('abcd-efgh-jkmn');
  await page.getByRole('button', { name: 'Enroll kiosk' }).click();
  await expect(page.getByText('Camp · Main lodge')).toBeVisible();

  await identify(page);
  await expect(page.getByRole('heading', { name: 'Hello, Ada' })).toBeVisible();
  await page.getByRole('button', { name: 'Clock in · Counsellor' }).click();
  await expect(page.getByRole('heading', { name: 'Clocked in' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Clock in · Counsellor — 9:02 AM');

  expect(mock.actions).toEqual([
    expect.objectContaining({
      token: 'token-1',
      action: 'CLOCK_IN',
      employmentAssignmentId: 'assignment-1',
    }),
  ]);
  expect(requests.filter((path) => path.startsWith('/auth/'))).toEqual([]);
  // No HR navigation on the kiosk.
  await expect(page.getByRole('link')).toHaveCount(0);
});

test('signs an employee in for sign-in-only work', async ({ page }) => {
  const mock: KioskMock = {
    enrolled: true,
    identification: {
      token: 'token-2',
      expiresInSeconds: 90,
      employee: { firstName: 'Grace' },
      state: 'OFF_CLOCK',
      actions: [
        { action: 'SIGN_IN', employmentAssignmentId: 'assignment-2', label: 'Sign in · Lifeguard' },
      ],
    },
    actions: [],
  };
  await mockKiosk(page, mock);
  const requests = recordApiRequests(page);

  await page.goto('/kiosk');
  await identify(page);
  await expect(page.getByRole('button', { name: /clock/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in · Lifeguard' }).click();
  await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible();

  expect(mock.actions).toEqual([
    expect.objectContaining({ action: 'SIGN_IN', employmentAssignmentId: 'assignment-2' }),
  ]);
  expect(requests.filter((path) => path.startsWith('/auth/'))).toEqual([]);
});

// ─── Self-service on a KIOSK_ONLY assignment ─────────────────────────────────

const identity = {
  id: 'kiosk-only-user',
  personId: 'person-kiosk-only',
  email: 'kiosk-only@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

test('self-service offers no clock buttons on kiosk-only work and points to the kiosk', async ({
  page,
}) => {
  await page.route('**/auth/refresh', (route) => route.fulfill(json({}, 401)));
  await page.route('**/auth/login', (route) =>
    route.fulfill(json({ accessToken: 'kiosk-only-token', identity }, 201)),
  );
  await page.route('**/auth/me/authorization', (route) =>
    route.fulfill(
      json({
        userId: identity.id,
        permissions: [{ key: 'time.clock', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] }],
      }),
    ),
  );
  await page.route(`${API}/time/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/time/me/status') {
      return route.fulfill(
        json({
          state: 'OFF_CLOCK',
          serverTime: '2026-10-05T13:00:00.000Z',
          currentTimeEntry: null,
          currentAssignment: null,
          currentBreakEntry: null,
          breakStartedAt: null,
          clockedInAt: null,
          eligibleAssignments: [],
          activeExceptions: [],
          availableActions: [],
          signInAssignments: [],
          attendanceModes: [
            {
              employmentAssignmentId: 'assignment-1',
              trackingMode: 'TIME_CLOCK',
              captureMode: 'KIOSK_ONLY',
            },
          ],
        }),
      );
    }
    if (path === '/time/me/entries') return route.fulfill(json({ items: [], nextAfterId: null }));
    if (path === '/time/me/exceptions') return route.fulfill(json({ exceptions: [] }));
    if (path === '/time/me/corrections') return route.fulfill(json({ corrections: [] }));
    if (path === '/time/me/timesheets') return route.fulfill(json({ timesheets: [] }));
    if (path === '/time/me/attendance-pin') return route.fulfill(json({ hasPin: true }));
    return route.fulfill(json({}, 404));
  });

  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole('link', { name: 'My Time', exact: true }).click();

  await expect(page.getByRole('note')).toContainText('onsite kiosk only');
  for (const name of ['Clock In', 'Clock Out', 'Start Break', 'Sign In']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Change PIN' })).toBeVisible();
});
