import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';

/**
 * Batch 4E-2 — attendance administration against a stateful mocked API: replacing a policy from
 * a date (with its warning), the effective policy of an assignment found through assignment
 * attendance (two organizations), kiosk rename and move among several kiosks, and a manager's
 * sign-out record. Accessibility (axe) at desktop and tablet widths and keyboard use.
 *
 * Screenshots for review are written when REVIEW_SCREENSHOTS_DIR is set.
 */

const identity = {
  id: 'admin-user',
  personId: 'person-admin',
  email: 'admin@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

const permissions = ['time.view', 'time.correct', 'time.manage_policy', 'time.device.manage'].map(
  (key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] }),
);

const organization = {
  id: 'org-1',
  name: 'Camp',
  code: 'CAMP',
  timezone: 'America/Toronto',
  workLocations: [{ id: 'loc-1', name: 'Main lodge', timezone: 'America/Toronto' }],
  physicalSites: [
    { id: 'site-1', name: 'Main campus' },
    { id: 'site-2', name: 'Lake site' },
  ],
  actions: {
    canViewSignIns: true,
    canCorrectSignIns: true,
    canManageDevices: true,
    canManagePolicies: true,
    canManagePins: false,
    canViewAttendance: true,
    canCorrectTime: true,
    canReviewExceptions: false,
    canReviewCorrections: false,
    canApproveTimesheets: false,
    canManageTimesheets: false,
    canManagePeriods: false,
  },
};

interface World {
  requests: Array<{ method: string; path: string; body: unknown }>;
  policies: Array<Record<string, unknown>>;
  devices: Array<Record<string, unknown>>;
  signOut: Record<string, unknown> | null;
}

const modes = (trackingMode: string, captureMode: string, signOutEnabled = false) => ({
  trackingMode,
  captureMode,
  kioskLocationRule: 'ANY_IN_ORGANIZATION',
  signInDuplicateWindowMinutes: 10,
  signOutEnabled,
});

function assignmentRow(
  id: string,
  org: { id: string; name: string },
  position: string,
  tracking: string,
  capture: string,
  chain: Array<Record<string, unknown>>,
) {
  return {
    id,
    employee: { id: 'employee-1', employeeNumber: 'E-100', name: 'Ada Lovelace' },
    assignment: {
      id,
      status: 'ACTIVE',
      startDate: '2026-01-01',
      endDate: null,
      isPrimary: id === 'assignment-1',
      position: { id: `position-${id}`, name: position, code: position.slice(0, 4).toUpperCase() },
      organization: { ...org, code: org.name.toUpperCase() },
      workLocation: null,
    },
    date: '2027-03-02',
    timezone: 'America/Toronto',
    attendance: modes(tracking, capture, tracking === 'SIGN_IN_ONLY'),
    clock: { mode: tracking === 'TIME_CLOCK' ? 'LIVE_CLOCK' : 'DISABLED' },
    breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30, autoDeductAfterMinutes: 360 },
    chain,
  };
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockApi(page: Page): Promise<World> {
  const world: World = {
    requests: [],
    policies: [
      {
        id: 'policy-org',
        scopeType: 'ORGANIZATION',
        organizationId: 'org-1',
        organizationalUnitId: null,
        departmentId: null,
        teamId: null,
        employmentAssignmentId: null,
        inheritanceMode: 'INHERIT',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        config: { clock: { mode: 'LIVE_CLOCK' }, breaks: { mode: 'NONE' } },
        archivedAt: null,
        actions: { canEnd: true, canArchive: false },
        scopeName: 'Camp',
        updatedAt: '2026-10-01T12:00:00.000Z',
      },
      {
        id: 'policy-system',
        scopeType: 'SYSTEM',
        organizationId: null,
        organizationalUnitId: null,
        departmentId: null,
        teamId: null,
        employmentAssignmentId: null,
        inheritanceMode: 'INHERIT',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        config: { correction: { employeeRequestsEnabled: true } },
        archivedAt: null,
        actions: { canEnd: false, canArchive: false },
        scopeName: 'System',
        updatedAt: '2025-01-01T00:00:00.000Z',
      },
    ],
    devices: ['Front desk', 'Gym', 'Pool'].map((name, index) => ({
      id: `device-${index + 1}`,
      organizationId: 'org-1',
      physicalSite: { id: 'site-1', name: 'Main campus' },
      name,
      status: 'ACTIVE',
      enrolled: true,
      credentialIssuedAt: '2026-10-01T12:00:00.000Z',
      enrollmentPending: false,
      enrollmentExpiresAt: null,
      lastSeenAt: '2026-11-02T12:00:00.000Z',
      lastSeenIp: null,
      revokedAt: null,
      revokedReason: null,
      createdAt: '2026-10-01T12:00:00.000Z',
    })),
    signOut: null,
  };
  await page.route(`${API}/**`, (route) => json(route, { message: 'Not found' }, 404));
  await page.route('**/auth/refresh', (route) => json(route, {}, 401));
  await page.route('**/auth/login', (route) =>
    json(route, { accessToken: 'admin-token', identity }, 201),
  );
  await page.route('**/auth/me/authorization', (route) =>
    json(route, { userId: identity.id, permissions }),
  );
  await page.route(`${API}/time/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const body = route.request().postDataJSON() as unknown;
    world.requests.push({ method, path: `${url.pathname}${url.search}`, body });
    const empty = { items: [], nextAfterId: null };
    switch (`${method} ${url.pathname}`) {
      case 'GET /time/manage/organizations':
        return json(route, { items: [organization] });
      case 'GET /time/policies':
        return json(route, { items: world.policies });
      case 'POST /time/policies/policy-org/supersede': {
        const input = body as { effectiveFrom: string; config: Record<string, unknown> };
        world.policies[0] = {
          ...world.policies[0],
          effectiveTo: '2026-12-31',
          updatedAt: '2026-11-03T10:00:00.000Z',
        };
        const created = {
          ...world.policies[0],
          id: 'policy-org-2',
          effectiveFrom: input.effectiveFrom,
          effectiveTo: null,
          config: input.config,
        };
        world.policies.push(created);
        return json(route, { ended: world.policies[0], created }, 201);
      }
      case 'GET /time/policies/inherited':
        // Above an organization: the system layer only (resolved by the API in reality).
        return json(route, {
          date: url.searchParams.get('date'),
          determinable: true,
          config: { correction: { employeeRequestsEnabled: true } },
          settings: {
            correction: {
              employeeRequestsEnabled: { value: true, source: 'LAYER', layerId: 'policy-system' },
            },
          },
          chain: [
            {
              id: 'policy-system',
              scopeType: 'SYSTEM',
              scopeName: 'System',
              inheritanceMode: 'INHERIT',
              effectiveFrom: '2025-01-01',
              effectiveTo: null,
              config: { correction: { employeeRequestsEnabled: true } },
            },
          ],
        });
      case 'GET /time/manage/assignment-attendance': {
        const chain = [
          {
            id: 'policy-system',
            scopeType: 'SYSTEM',
            scopeName: 'System',
            inheritanceMode: 'INHERIT',
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
          },
          {
            id: 'policy-org-2',
            scopeType: 'ORGANIZATION',
            scopeName: 'Camp',
            inheritanceMode: 'INHERIT',
            effectiveFrom: '2027-01-01',
            effectiveTo: null,
          },
        ];
        return json(route, {
          items: [
            assignmentRow(
              'assignment-1',
              { id: 'org-1', name: 'Camp' },
              'Counsellor',
              'TIME_CLOCK',
              'KIOSK_OR_SELF_SERVICE',
              chain,
            ),
            assignmentRow(
              'assignment-2',
              { id: 'org-2', name: 'School' },
              'Volunteer',
              'SIGN_IN_ONLY',
              'KIOSK_ONLY',
              [],
            ),
          ],
          nextAfterId: null,
        });
      }
      case 'GET /time/policies/effective':
        return json(route, {
          date: url.searchParams.get('date') ?? '2027-03-02',
          timezone: 'America/Toronto',
          assignment: {
            id: 'assignment-1',
            employeeId: 'employee-1',
            status: 'ACTIVE',
            position: { id: 'position-1', name: 'Counsellor' },
            organization: { id: 'org-1', name: 'Camp' },
          },
          config: {
            clock: { mode: 'LIVE_CLOCK' },
            breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30, autoDeductAfterMinutes: 360 },
            correction: { employeeRequestsEnabled: true },
            attendance: modes('TIME_CLOCK', 'KIOSK_OR_SELF_SERVICE'),
          },
          settings: {
            clock: { mode: { value: 'LIVE_CLOCK', source: 'LAYER', layerId: 'policy-org-2' } },
            breaks: {
              mode: { value: 'AUTO_DEDUCT', source: 'LAYER', layerId: 'policy-org-2' },
              autoDeductMinutes: { value: 30, source: 'LAYER', layerId: 'policy-org-2' },
              autoDeductAfterMinutes: { value: 360, source: 'LAYER', layerId: 'policy-org-2' },
            },
            correction: {
              employeeRequestsEnabled: { value: true, source: 'LAYER', layerId: 'policy-system' },
            },
            attendance: {
              trackingMode: { value: 'TIME_CLOCK', source: 'DEFAULT' },
              captureMode: {
                value: 'KIOSK_OR_SELF_SERVICE',
                source: 'LAYER',
                layerId: 'policy-assignment',
              },
            },
          },
          chain: [
            {
              id: 'policy-system',
              scopeType: 'SYSTEM',
              scopeName: 'System',
              inheritanceMode: 'INHERIT',
              effectiveFrom: '2025-01-01',
              effectiveTo: null,
            },
            {
              id: 'policy-org-2',
              scopeType: 'ORGANIZATION',
              scopeName: 'Camp',
              inheritanceMode: 'INHERIT',
              effectiveFrom: '2027-01-01',
              effectiveTo: null,
            },
            {
              id: 'policy-assignment',
              scopeType: 'EMPLOYMENT_ASSIGNMENT',
              scopeName: 'Ada Lovelace · Counsellor',
              inheritanceMode: 'INHERIT',
              effectiveFrom: '2026-06-01',
              effectiveTo: null,
            },
          ],
          attendance: modes('TIME_CLOCK', 'KIOSK_OR_SELF_SERVICE'),
        });
      case 'GET /time/devices':
        return json(route, { items: world.devices });
      case 'GET /time/manage/sign-ins':
        return json(route, {
          items: [
            {
              id: 'sign-in-1',
              employeeId: 'employee-1',
              employmentAssignmentId: 'assignment-2',
              signedInAt: '2026-11-02T13:05:00.000Z',
              timezone: 'America/Toronto',
              workDate: '2026-11-02',
              source: 'KIOSK',
              attendanceDeviceId: 'device-1',
              workLocationId: null,
              scheduledShiftId: null,
              scheduledShiftRevisionId: null,
              status: 'ACTIVE',
              voidedAt: null,
              voidReason: null,
              replacesSignInId: null,
              recordedByUserId: null,
              reason: null,
              createdAt: '2026-11-02T13:05:00.000Z',
              positionName: 'Volunteer',
              employeeNumber: 'E-100',
              employeeName: 'Ada Lovelace',
              device: { id: 'device-1', name: 'Front desk' },
              workLocation: null,
              exceptions: [],
              actions: { canVoid: true, canCorrect: true },
              signOut: world.signOut,
            },
          ],
        });
      case 'POST /time/sign-ins/sign-in-1/sign-out': {
        const input = body as { signedOutAt: string; reason: string };
        world.signOut = {
          id: 'sign-out-1',
          signInId: 'sign-in-1',
          employmentAssignmentId: 'assignment-2',
          signedOutAt: '2026-11-02T17:30:00.000Z',
          source: 'MANUAL',
          attendanceDeviceId: null,
          recordedByUserId: 'admin-user',
          reason: input.reason,
          status: 'ACTIVE',
          voidedAt: null,
          voidReason: null,
        };
        return json(route, world.signOut, 201);
      }
      default:
        if (method === 'PATCH' && url.pathname.startsWith('/time/devices/')) {
          const id = url.pathname.split('/').at(-1);
          const input = body as { name?: string; physicalSiteId?: string };
          world.devices = world.devices.map((device) =>
            device.id === id
              ? {
                  ...device,
                  ...(input.name ? { name: input.name } : {}),
                  ...(input.physicalSiteId
                    ? {
                        physicalSite: organization.physicalSites.find(
                          (site) => site.id === input.physicalSiteId,
                        ),
                      }
                    : {}),
                }
              : device,
          );
          return json(
            route,
            world.devices.find((device) => device.id === id),
          );
        }
        if (method === 'GET' && url.pathname.startsWith('/time/')) return json(route, empty);
        return json(route, {}, 404);
    }
  });
  return world;
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function openAttendancePolicies(page: Page) {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Attendance Policies' })
    .click();
  await expect(page.getByRole('tab', { name: 'Attendance policies' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

async function screenshot(page: Page, name: string, element?: Locator) {
  const directory = process.env.REVIEW_SCREENSHOTS_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.png`);
  if (element) await element.screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
}

async function noHorizontalScroll(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
}

test('an administrator replaces a policy from a date and inspects an assignment’s effective policy', async ({
  page,
}) => {
  const world = await mockApi(page);
  await signIn(page);
  await openAttendancePolicies(page);

  // The layers by name; the system layer is read-only.
  const camp = page
    .getByRole('listitem')
    .filter({ hasText: 'Camp' })
    .filter({ hasText: 'Organization' })
    .first();
  await expect(camp).toContainText('Time clock: On (clock in and out)');
  await expect(page.getByText('System policy · read-only')).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '1-policies');

  // Replace from a date: breaks become an automatic deduction (warned about pay).
  await page.getByRole('button', { name: 'Change from a date for Camp' }).click();
  const editor = page.getByRole('form', { name: 'Change policy from a date' });
  await editor.getByLabel('Replace from').fill('2027-01-01');
  // Blank settings show what they inherit on that date, from the API's resolution.
  const corrections = editor.getByRole('group', { name: 'Corrections' });
  await expect(corrections.getByText(/Blank inherits Yes \(inherited from System/)).toBeVisible();
  expect(
    world.requests.find((request) => request.path.startsWith('/time/policies/inherited'))?.path,
  ).toBe('/time/policies/inherited?scopeType=ORGANIZATION&organizationId=org-1&date=2027-01-01');
  const breaks = editor.getByRole('group', { name: 'Breaks and automatic deduction' });
  await breaks.getByLabel('Breaks', { exact: true }).selectOption('AUTO_DEDUCT');
  await breaks.getByLabel('Deduction (minutes)').fill('30');
  await screenshot(page, '2-policy-editor', breaks);
  await editor.getByRole('button', { name: 'Replace policy' }).click();
  const warning = page.getByRole('alertdialog', { name: 'Save these policy changes?' });
  await expect(warning).toContainText('payable minutes');
  await expectNoSeriousA11yViolations(page);
  await warning.getByRole('button', { name: 'Save policy' }).click();
  await expect(page.getByText(/Policy replaced from 01\/01\/2027/)).toBeVisible();
  const supersede = world.requests.find((request) => request.path.endsWith('/supersede'));
  expect(supersede?.body).toEqual({
    effectiveFrom: '2027-01-01',
    inheritanceMode: 'INHERIT',
    expectedUpdatedAt: '2026-10-01T12:00:00.000Z',
    config: {
      clock: { mode: 'LIVE_CLOCK' },
      breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30 },
    },
  });

  // Assignment attendance: one employee, two organizations, two modes.
  await page.getByRole('tab', { name: 'Assignment attendance' }).click();
  await page.getByLabel('Employee name, number or position').fill('Ada');
  const table = page.getByRole('region', { name: 'Assignment attendance' });
  await expect(table.getByRole('row', { name: /School/ })).toContainText(
    'Presence only (not payable)',
  );
  await expect(table.getByRole('row', { name: /Camp/ })).toContainText('Timed attendance');
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '3-assignment-attendance');

  // Its effective policy: where each setting comes from.
  await table
    .getByRole('button', { name: /Inspect the effective policy of Ada Lovelace, Counsellor/ })
    .click();
  await expect(page.getByRole('tab', { name: 'Effective policy' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const breaksSettings = page.getByRole('region', {
    name: 'Breaks and automatic deduction: effective settings',
  });
  await expect(breaksSettings.getByRole('row', { name: /^Breaks/ })).toContainText(
    'Inherited from Camp (Organization)',
  );
  const capture = page.getByRole('region', { name: 'Tracking and capture: effective settings' });
  await expect(capture.getByRole('row', { name: /^Capture/ })).toContainText(
    'Set for this assignment',
  );
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '4-effective-policy');
});

test('kiosks are renamed and moved among several, and a manager records a sign-out', async ({
  page,
}) => {
  const world = await mockApi(page);
  await signIn(page);
  await openAttendancePolicies(page);

  await page.getByRole('tab', { name: 'Kiosks' }).click();
  await expect(page.getByRole('button', { name: /^Rename or move/ })).toHaveCount(3);
  await page.getByRole('button', { name: 'Rename or move Pool' }).click();
  const form = page.getByRole('form', { name: 'Rename or move kiosk' });
  await form.getByLabel('Name').fill('Pool deck');
  await form.getByLabel('Site').selectOption('site-2');
  await form.getByRole('button', { name: 'Save kiosk' }).click();
  await expect(page.getByText('Kiosk updated.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename or move Pool deck' })).toBeVisible();
  expect(world.requests.find((request) => request.method === 'PATCH')?.body).toEqual({
    name: 'Pool deck',
    physicalSiteId: 'site-2',
  });
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '5-kiosks');

  await page.getByRole('tab', { name: 'Sign-ins', exact: true }).click();
  // Row actions carry the row's name (sr-only): "Record sign-out Ada Lovelace, Nov 2, …".
  await page.getByRole('button', { name: /^Record sign-out Ada Lovelace,/ }).click();
  const signOut = page.getByRole('form', { name: 'Record sign-out' });
  await expect(signOut).toContainText('never payable time');
  await signOut.getByLabel(/Signed out at/).fill('2026-11-02T12:30');
  await signOut.getByLabel('Reason').fill('Left after the session');
  await signOut.getByRole('button', { name: 'Record sign-out' }).click();
  await expect(page.getByText('Sign-out recorded.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Void sign-out Ada Lovelace,/ })).toBeVisible();
  await screenshot(page, '7-sign-out-recorded');
});

test('tablet: no page-wide horizontal scroll, accessible policy editor', async ({ page }) => {
  await mockApi(page);
  await signIn(page);
  await openAttendancePolicies(page);
  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(page.getByRole('form', { name: 'Add attendance policy' })).toBeVisible();
  await noHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page);
  await screenshot(page, '6-policies-tablet');
});

test('keyboard: the warning dialog traps focus and returns it', async ({ page }) => {
  await mockApi(page);
  await signIn(page);
  await openAttendancePolicies(page);
  const form = page.getByRole('form', { name: 'Add attendance policy' });
  await form.getByLabel('Effective from').fill('2027-01-01');
  await form.getByLabel('Capture').selectOption('KIOSK_ONLY');
  const submit = form.getByRole('button', { name: 'Add policy' });
  await submit.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'Save these policy changes?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(submit).toBeFocused();
});
