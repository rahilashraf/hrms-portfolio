import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Security remediation M1 — the employee profile's Login access section against a mocked API:
 * actions the administrator's scope rules out are listed with the server's safe reason (and not
 * offered), nothing flashes while the account loads, a refusal on stale flags shows the reason and
 * reloads, the remaining actions work by keyboard, and there are no serious axe violations or
 * page-wide horizontal scroll at desktop, tablet and phone widths.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const EMP = '55555555-5555-4555-8555-555555555555';
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;
const HR = ['employee.read', 'employee.manage', 'employee.account.manage'];

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type Capability = { allowed: boolean; reason: string | null };
const ACTIONS = [
  'invite',
  'resend',
  'cancel',
  'disable',
  'enable',
  'requirePasswordChange',
  'sendPasswordReset',
  'signOut',
  'unlock',
] as const;
type Action = (typeof ACTIONS)[number];

function loginAccount(
  status: string,
  capabilities: Partial<Record<Action, Capability>>,
  extra: Record<string, unknown> = {},
) {
  const all = Object.fromEntries(
    ACTIONS.map((action) => [action, capabilities[action] ?? { allowed: false, reason: null }]),
  ) as Record<Action, Capability>;
  return {
    employeeId: EMP,
    status,
    email: 'ada@example.com',
    invitationExpiresAt: null,
    lastLoginAt: '2026-11-01T14:00:00.000Z',
    mustChangePassword: false,
    lockedUntil: null,
    activeSessionCount: status === 'ACTIVE' ? 2 : 0,
    actions: Object.fromEntries(ACTIONS.map((action) => [action, all[action].allowed])),
    capabilities: all,
    ...extra,
  };
}

async function session(page: Page) {
  const identity = {
    id: 'user-hr',
    personId: 'person-hr',
    email: 'hr@example.com',
    status: 'ACTIVE',
    emailVerifiedAt: null,
    mustChangePassword: false,
  };
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route(`${API}/auth/refresh`, (route) => json(route, { accessToken: 'm1-token' }));
  await page.route(`${API}/auth/me`, (route) => json(route, identity));
  await page.route(`${API}/auth/me/authorization`, (route) =>
    json(route, {
      userId: identity.id,
      permissions: HR.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })),
    }),
  );
  await page.route(`${API}/auth/me/workspace`, (route) =>
    json(route, {
      user: { id: identity.id, email: identity.email, displayName: 'Morgan Reedley' },
      systemPermissions: [],
      organizations: [
        {
          id: ORG,
          name: 'Northwind Academy',
          code: 'NWA',
          timezone: 'America/Toronto',
          branding: null,
          enabledModules: ['ATTENDANCE', 'LEAVE'],
          permissions: HR,
          isEmployee: false,
          isManager: false,
        },
      ],
    }),
  );
  await page.route(`${API}/notifications/me/unread-count`, (route) => json(route, { unread: 0 }));
}

interface Server {
  /** Account responses in order; the last one repeats. */
  accounts: unknown[];
  /** Answers to POST /account/<path>. */
  mutations?: Record<string, { status: number; body: unknown }>;
  /** Holds the first account read until released. */
  holdFirstRead?: Promise<void>;
}

async function employeeServer(page: Page, setup: Server) {
  const posts: string[] = [];
  let reads = 0;
  await page.route(
    (url) => url.origin === API && url.pathname.startsWith(`/employees/${EMP}`),
    async (route) => {
      const request = route.request();
      const rest = new URL(request.url()).pathname.slice(`/employees/${EMP}`.length);
      if (rest === '')
        return json(route, {
          id: EMP,
          employeeNumber: 'E-0005',
          status: 'ACTIVE',
          hireDate: '2026-01-05',
          terminationDate: null,
          person: {
            firstName: 'Ada',
            middleName: null,
            lastName: 'Lovelace',
            preferredName: null,
            personalEmail: null,
            phone: null,
          },
          assignments: { current: [], upcoming: [], historical: [], cancelled: [] },
        });
      if (rest === '/capabilities')
        return json(route, {
          employeeId: EMP,
          organizationIds: [ORG],
          tabs: {
            overview: true,
            employment: true,
            compensation: false,
            time: false,
            leave: false,
            benefits: false,
            documents: false,
            performance: false,
          },
          actions: {
            edit: false,
            changePosition: false,
            assignManager: false,
            addCompensation: false,
            manageDocuments: false,
            startOffboarding: false,
            manageLifecycle: false,
          },
        });
      if (rest === '/terminations') return json(route, { items: [] });
      if (rest === '/account' && request.method() === 'GET') {
        reads += 1;
        if (reads === 1 && setup.holdFirstRead) await setup.holdFirstRead;
        const body = setup.accounts[Math.min(reads - 1, setup.accounts.length - 1)];
        return json(route, body);
      }
      if (rest.startsWith('/account/') && request.method() === 'POST') {
        const action = rest.slice('/account/'.length);
        posts.push(action);
        const answer = setup.mutations?.[action];
        if (answer) return json(route, answer.body, answer.status);
        return json(route, setup.accounts.at(-1));
      }
      return json(route, { message: 'Not found' }, 404);
    },
  );
  return { posts, reads: () => reads };
}

async function checkAt(page: Page) {
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

const allowed: Capability = { allowed: true, reason: null };

test('lists scope-limited actions with safe reasons, and keeps the allowed ones keyboard-operable', async ({
  page,
}) => {
  await session(page);
  const server = await employeeServer(page, {
    accounts: [
      loginAccount('ACTIVE', {
        disable: allowed,
        signOut: allowed,
        sendPasswordReset: { allowed: false, reason: 'ACCESS_OUTSIDE_SCOPE' },
        requirePasswordChange: { allowed: false, reason: 'ACCESS_OUTSIDE_SCOPE' },
      }),
    ],
  });
  await page.goto(`/admin/employees/${EMP}#overview`);
  const section = page.getByRole('region', { name: 'Login access' });
  const unavailable = section.getByRole('list', { name: 'Unavailable login actions' });
  await expect(unavailable).toHaveText(
    'Send password reset link, Require password change: This person has access outside your administrative scope. An administrator who covers all of their access can do this.',
  );
  await expect(section.getByRole('button', { name: 'Send password reset link' })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Require password change' })).toHaveCount(0);
  // No other organization or role is ever named.
  await expect(section).not.toContainText('Org B');
  await checkAt(page);

  // The allowed actions work from the keyboard, with their confirmations.
  const disable = section.getByRole('button', { name: 'Disable login' });
  await disable.focus();
  await page.keyboard.press('Enter');
  const form = section.getByRole('form', { name: 'Disable login' });
  await expect(form).toBeVisible();
  await form.getByLabel('Reason (optional)').fill('Left the organization');
  await form.getByLabel('Reason (optional)').press('Enter');
  await expect(
    section.getByText('Login access disabled. All sessions were signed out.'),
  ).toBeVisible();
  expect(server.posts).toEqual(['disable']);
});

test('shows only the loading status while the account loads, with no actions or reasons flashing', async ({
  page,
}) => {
  await session(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await employeeServer(page, {
    holdFirstRead: held,
    accounts: [
      loginAccount('DISABLED', {
        enable: { allowed: false, reason: 'NO_CURRENT_ASSIGNMENT' },
      }),
    ],
  });
  await page.goto(`/admin/employees/${EMP}#overview`);
  const section = page.getByRole('region', { name: 'Login access' });
  await expect(section.getByRole('status')).toHaveText('Loading login access…');
  await expect(section.getByRole('button')).toHaveCount(0);
  await expect(section.getByRole('list', { name: 'Unavailable login actions' })).toHaveCount(0);
  release();
  await expect(section.getByRole('list', { name: 'Unavailable login actions' })).toHaveText(
    'Enable login: This needs a current assignment in your administrative scope.',
  );
  await expect(section.getByRole('button', { name: 'Enable login' })).toHaveCount(0);
  await checkAt(page);
});

test('a refusal on stale flags shows the safe reason once, reloads, and offers the action no more', async ({
  page,
}) => {
  await session(page);
  const server = await employeeServer(page, {
    accounts: [
      loginAccount('DISABLED', { enable: allowed }),
      loginAccount('DISABLED', {
        enable: { allowed: false, reason: 'ACCESS_OUTSIDE_SCOPE' },
      }),
    ],
    mutations: {
      enable: {
        status: 403,
        body: {
          statusCode: 403,
          error: 'Forbidden',
          code: 'ACCOUNT_OUTSIDE_SCOPE',
          reason: 'ACCESS_OUTSIDE_SCOPE',
          message: 'This person has access outside your administrative scope.',
        },
      },
    },
  });
  await page.goto(`/admin/employees/${EMP}#overview`);
  const section = page.getByRole('region', { name: 'Login access' });
  await section.getByRole('button', { name: 'Enable login' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Re-enable' }).click();
  await expect(section.getByRole('alert')).toHaveText(
    'This person has access outside your administrative scope. An administrator who covers all of their access can do this.',
  );
  await expect(section.getByRole('button', { name: 'Enable login' })).toHaveCount(0);
  await expect(section.getByRole('list', { name: 'Unavailable login actions' })).toBeVisible();
  expect(server.posts).toEqual(['enable']);
  expect(server.reads()).toBe(2);
  await checkAt(page);
});

test('an administrator refused even the read sees no Login access section', async ({ page }) => {
  await session(page);
  await employeeServer(page, { accounts: [] });
  // Registered last, so it answers the account read.
  await page.route(
    (url) => url.origin === API && url.pathname === `/employees/${EMP}/account`,
    (route) =>
      json(
        route,
        {
          statusCode: 403,
          message: "Only a System Owner can manage a System Owner's login access.",
        },
        403,
      ),
  );
  await page.goto(`/admin/employees/${EMP}#overview`);
  await expect(page.getByRole('heading', { name: 'Ada Lovelace' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Login access' })).toHaveCount(0);
});
