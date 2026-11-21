import { randomBytes } from 'node:crypto';
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { REAL_STACK_API, REAL_STACK_WEB } from './support/stack';

/**
 * Batch R5-B — Positions against the real API and database, in the seed's own R5-B organization
 * (its own structure administrator and department structure manager, so the other flows and their
 * login rate limits are untouched). Nothing is mocked: requests are only read, never answered.
 *
 * Each account signs in once in the browser; API calls reuse that session (a refresh, which is
 * not a login).
 */

let r5b: RealStackSeed['r5b'];

test.beforeAll(() => {
  r5b = readSeed().r5b;
});

test.describe.configure({ mode: 'serial' });

/** Fields that place or identify a Position; a staffed Position refuses any of them. */
const IDENTITY_FIELDS = [
  'jobTitleId',
  'workLocationId',
  'organizationalUnitId',
  'departmentId',
  'teamId',
];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const token = () => randomBytes(3).toString('hex').toUpperCase();

async function signIn(page: Page, account: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** The API as the signed-in browser user (its refresh cookie, not a new login). */
async function apiAs(page: Page): Promise<APIRequestContext> {
  const refreshed = await page.request.post(`${REAL_STACK_API}/auth/refresh`, {
    headers: { Origin: REAL_STACK_WEB },
  });
  expect(refreshed.ok()).toBe(true);
  const { accessToken } = (await refreshed.json()) as { accessToken: string };
  return request.newContext({
    baseURL: REAL_STACK_API,
    extraHTTPHeaders: { Origin: REAL_STACK_WEB, Authorization: `Bearer ${accessToken}` },
  });
}

async function openPositions(page: Page) {
  await page.goto(`/admin/organizations/${r5b.organizationId}/positions`);
  await expect(page.getByRole('heading', { name: 'Positions', level: 1 })).toBeVisible({
    timeout: 60_000,
  });
}

const positionRow = (page: Page, code: string) =>
  page.getByRole('row', { name: new RegExp(escapeRegExp(code)) });

test('a department structure manager creates a Position in their department from the reference options', async ({
  page,
}) => {
  await signIn(page, r5b.manager);
  await openPositions(page);

  // The staffed position sits in another department: listed (organization-wide read), but no
  // record actions for this manager.
  const outside = positionRow(page, r5b.staffedPosition.code);
  await expect(outside).toBeVisible();
  await expect(outside).toContainText(`Department: ${r5b.otherDepartment.name}`);
  await expect(outside.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(outside.getByRole('button', { name: 'Archive' })).toHaveCount(0);

  const code = `RSNEW-${token()}`;
  const name = `Operations Analyst ${code}`;
  await page.getByRole('button', { name: 'New record' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Code', { exact: true }).fill(code);
  // The active job titles and work locations of the organization, from the reference options.
  const jobTitle = page.getByLabel('Job Title');
  await expect(jobTitle.locator('option')).toHaveText([
    'Select…',
    `${r5b.jobTitle.name} (${r5b.jobTitle.code})`,
  ]);
  await jobTitle.selectOption({ label: `${r5b.jobTitle.name} (${r5b.jobTitle.code})` });
  await page
    .getByLabel('Work Location')
    .selectOption({ label: `${r5b.workLocation.name} (${r5b.workLocation.code})` });
  // Only the manager's own department is offered as a placement.
  await page.getByLabel('Placement type').selectOption('departments');
  const department = page.locator('select[name="departmentId"]');
  await expect(department.locator(`option[value="${r5b.otherDepartment.id}"]`)).toHaveCount(0);
  await department.selectOption(r5b.managerDepartment.id);

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url() === `${REAL_STACK_API}/organizations/${r5b.organizationId}/positions`,
  );
  await page.getByRole('button', { name: 'Create Position' }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const { id } = (await response.json()) as { id: string };
  await expect(page.getByRole('status').getByText('Positions created.')).toBeVisible();

  const row = positionRow(page, code);
  await expect(row).toContainText(name);
  await expect(row).toContainText(`Department: ${r5b.managerDepartment.name}`);
  await expect(row).toContainText(r5b.jobTitle.name);
  await expect(row.getByRole('button', { name: 'Edit' })).toBeEnabled();
  await expectNoSeriousA11yViolations(page);

  // The real record, read back as the manager.
  const api = await apiAs(page);
  const stored = await api.get(`/organizations/${r5b.organizationId}/positions/${id}`);
  expect(stored.ok(), await stored.text()).toBe(true);
  expect(await stored.json()).toMatchObject({
    name,
    code,
    departmentId: r5b.managerDepartment.id,
    jobTitleId: r5b.jobTitle.id,
    workLocationId: r5b.workLocation.id,
    organizationalUnitId: null,
    teamId: null,
  });
  await api.dispose();
});

test('an organization administrator renames a staffed Position without resending its identity', async ({
  page,
}) => {
  await signIn(page, r5b.admin);
  await openPositions(page);

  const staffed = r5b.staffedPosition;
  await positionRow(page, staffed.code).getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Job Title')).toHaveValue(r5b.jobTitle.id);
  await expect(page.getByLabel('Work Location')).toHaveValue(r5b.workLocation.id);
  const renamed = `${staffed.name} R${token()}`;
  await page.getByLabel('Name', { exact: true }).fill(renamed);

  // Read (never answer) the browser's PATCH.
  const patched = page.waitForRequest(
    (sent) =>
      sent.method() === 'PATCH' &&
      sent.url() ===
        `${REAL_STACK_API}/organizations/${r5b.organizationId}/positions/${staffed.id}`,
  );
  await page.getByRole('button', { name: 'Save changes' }).click();
  const sent = await patched;
  const body = sent.postDataJSON() as Record<string, unknown>;
  expect(body.name).toBe(renamed);
  for (const field of IDENTITY_FIELDS) expect(body).not.toHaveProperty(field);
  const response = await sent.response();
  expect(response?.status(), await response?.text()).toBe(200);

  await expect(page.getByRole('status').getByText('Positions updated.')).toBeVisible();
  const row = positionRow(page, staffed.code);
  await expect(row).toContainText(renamed);
  await expect(row).toContainText(`Department: ${r5b.otherDepartment.name}`);
  await expectNoSeriousA11yViolations(page);

  // The real record: renamed, its identity unchanged.
  const api = await apiAs(page);
  const stored = await api.get(`/organizations/${r5b.organizationId}/positions/${staffed.id}`);
  expect(stored.ok(), await stored.text()).toBe(true);
  expect(await stored.json()).toMatchObject({
    name: renamed,
    jobTitleId: r5b.jobTitle.id,
    workLocationId: r5b.workLocation.id,
    departmentId: r5b.otherDepartment.id,
  });
  await api.dispose();
});
