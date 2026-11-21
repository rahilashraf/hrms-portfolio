import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../e2e/support/axe';
import { readSeed, type RealStackSeed } from './support/seed';
import { disposableDatabaseUrl, REAL_STACK_API, REAL_STACK_WEB } from './support/stack';

/**
 * Real stack (Batch 9): document files against the real API, database and local object storage
 * (a throwaway directory; never S3), in the seed's time zone.
 *
 * 1. HR uploads a PDF to the employee's record (employee visible) from the employee profile.
 * 2. The employee sees it in My Documents and downloads exactly those bytes.
 * 3. HR reclassifies it HR only: the employee no longer sees it, and asking for a file link
 *    as the employee is a 404.
 * 4. A manager who reads only up to manager-visible documents gets 404 for the record and its
 *    file.
 * 5. An administrator of another organization gets 404.
 * 6. HR adds a PNG as version 2; version 1 is kept and still downloads.
 * 7. Downloads never expose internal storage keys (pages and API responses).
 * 8. Uploads and link issuance are audited with ids only (no key, link or token).
 */

let seed: RealStackSeed;
test.describe.configure({ mode: 'serial', timeout: 300_000 });
test.beforeAll(() => {
  seed = readSeed();
});
// Sign-ins are rate limited per address (a real feature): this file signs in a few accounts, so
// it reuses the HR session and, at the end, lets the window pass before the next file signs in.
let hrSession: { context: BrowserContext; page: Page } | null = null;
test.afterAll(async () => {
  await hrSession?.context.close();
  await new Promise((resolve) => setTimeout(resolve, 65_000));
});

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1',
);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR', 'latin1'),
  Buffer.alloc(17),
  Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
]);
const STORAGE_KEY = /documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}/;

async function signedIn(browser: Browser, account: { email: string; password: string }) {
  const context = await browser.newContext({ baseURL: REAL_STACK_WEB, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  // The whole real-stack run signs in many accounts from one address: the login rate limiter
  // (a real feature, left as is) may ask to wait; wait the time it states and try again.
  for (let attempt = 0; ; attempt += 1) {
    await page.getByRole('button', { name: 'Sign in' }).click();
    const limited = page.getByRole('alert').filter({ hasText: /Too many attempts/ });
    await expect
      .poll(async () => /\/dashboard$/.test(page.url()) || (await limited.isVisible()), {
        timeout: 30_000,
      })
      .toBe(true);
    if (attempt >= 3 || /\/dashboard$/.test(page.url())) break;
    const seconds = Number((await limited.innerText()).match(/(\d+) seconds/)?.[1] ?? 60);
    await page.waitForTimeout((seconds + 2) * 1_000);
  }
  await expect(page).toHaveURL(/\/dashboard$/);
  return { context, page };
}

/** The API as one account (for the refusals the UI cannot even ask for), from the web origin. */
async function apiAs(account: { email: string; password: string }): Promise<APIRequestContext> {
  const anonymous = await request.newContext({
    baseURL: REAL_STACK_API,
    extraHTTPHeaders: { Origin: REAL_STACK_WEB },
  });
  let login = await anonymous.post('/auth/login', {
    data: { email: account.email, password: account.password },
  });
  for (let attempt = 0; login.status() === 429 && attempt < 3; attempt += 1) {
    const seconds = Number(login.headers()['retry-after'] ?? 60);
    await new Promise((resolve) => setTimeout(resolve, (seconds + 2) * 1_000));
    login = await anonymous.post('/auth/login', {
      data: { email: account.email, password: account.password },
    });
  }
  expect(login.ok()).toBe(true);
  const { accessToken } = (await login.json()) as { accessToken: string };
  await anonymous.dispose();
  return request.newContext({
    baseURL: REAL_STACK_API,
    extraHTTPHeaders: { Origin: REAL_STACK_WEB, Authorization: `Bearer ${accessToken}` },
  });
}

/** Rows from the disposable database (read-only checks of what the API recorded). */
function sql(query: string): string {
  // psql does not take Prisma's `schema` parameter.
  const url = new URL(disposableDatabaseUrl(process.env.DATABASE_URL));
  url.searchParams.delete('schema');
  return execFileSync('psql', [url.toString(), '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    encoding: 'utf8',
  }).trim();
}

async function downloadBytes(page: Page, click: () => Promise<void>) {
  const download = page.waitForEvent('download');
  await click();
  const file = await download;
  const path = await file.path();
  return { name: file.suggestedFilename(), bytes: readFileSync(path!) };
}

let documentId = '';
let version1Id = '';

test('HR uploads a PDF, the employee downloads it, reclassification hides it', async ({
  browser,
}) => {
  const d = seed.documents;
  // 1. HR uploads a PDF to the employee's record from the profile.
  hrSession = await signedIn(browser, d.hr);
  const hr = hrSession;
  await hr.page.goto(`/admin/employees/${d.employee.employeeId}#documents`);
  await expect(hr.page.getByRole('heading', { name: 'Documents', level: 2 })).toBeVisible({
    timeout: 60_000,
  });
  await hr.page.getByRole('button', { name: 'Add document record' }).click();
  const form = hr.page.getByRole('form', { name: 'Add document record' });
  await expect(form.getByLabel('Stored in')).toHaveValue('INTERNAL_OBJECT_STORAGE', {
    timeout: 30_000,
  });
  await form.getByLabel('Document type').selectOption({ label: d.typeName });
  await form.getByLabel('Title').fill('Signed employment agreement');
  await form.getByLabel('Confidentiality').selectOption('EMPLOYEE_VISIBLE');
  await form.getByLabel('File', { exact: true }).setInputFiles({
    name: 'agreement.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await expectNoSeriousA11yViolations(hr.page);
  await form.getByRole('button', { name: 'Save record' }).click();
  await expect(hr.page.getByText('Document record added.')).toBeVisible({ timeout: 30_000 });
  const row = hr.page.getByRole('row').filter({ hasText: 'Signed employment agreement' });
  await expect(row).toBeVisible();
  documentId = sql(
    `select id from "EmployeeDocument" where "organizationId" = '${d.organizationId}' and title = 'Signed employment agreement'`,
  );
  expect(documentId).toMatch(/^[0-9a-f-]{36}$/);
  version1Id = sql(
    `select id from "EmployeeDocumentVersion" where "documentId" = '${documentId}' and "versionNumber" = 1`,
  );
  // The stored object is attached, of the right organization, detected as a PDF with its hash.
  expect(
    sql(
      `select o.status || '|' || o."detectedMimeType" || '|' || o."sizeBytes" || '|' || (o."organizationId" = '${d.organizationId}')
         from "DocumentStoredObject" o join "EmployeeDocumentVersion" v on v."storedObjectId" = o.id
        where v.id = '${version1Id}'`,
    ),
  ).toBe(`ATTACHED|application/pdf|${PDF.length}|true`);

  // 2. The employee sees it and downloads exactly the uploaded bytes.
  const employee = await signedIn(browser, d.employee);
  await employee.page.goto('/documents');
  const mine = employee.page.getByRole('listitem', {
    name: 'Document Signed employment agreement',
  });
  await expect(mine).toBeVisible({ timeout: 30_000 });
  const got = await downloadBytes(employee.page, () =>
    mine.getByRole('button', { name: /^Download Signed employment agreement/ }).click(),
  );
  expect(got.name).toBe('agreement.pdf');
  expect(got.bytes.equals(PDF)).toBe(true);
  await expectNoSeriousA11yViolations(employee.page);
  // 7. No internal storage key on either page.
  expect(await employee.page.content()).not.toMatch(STORAGE_KEY);
  expect(await hr.page.content()).not.toMatch(STORAGE_KEY);

  // 3. HR reclassifies it HR only; the employee loses access (404, not a leak).
  await hr.page.goto(`/documents/records/${documentId}`);
  await hr.page.getByRole('button', { name: 'Edit or reclassify' }).click();
  const edit = hr.page.getByRole('form', { name: 'Edit document' });
  await edit.getByLabel('Confidentiality').selectOption('HR_ONLY');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(hr.page.getByText('HR only').first()).toBeVisible();
  await employee.page.reload();
  await expect(employee.page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(
    employee.page.getByRole('listitem', { name: 'Document Signed employment agreement' }),
  ).toHaveCount(0);
  const asEmployee = await apiAs(d.employee);
  expect(
    (
      await asEmployee.post(`/documents/records/${documentId}/versions/${version1Id}/download-url`)
    ).status(),
  ).toBe(404);
  expect((await asEmployee.get(`/documents/records/${documentId}`)).status()).toBe(404);
  await asEmployee.dispose();
  await employee.context.close();
});

test('managers without HR clearance and other organizations get 404', async () => {
  const d = seed.documents;
  // 4. A manager who reads only up to manager-visible documents.
  const manager = await apiAs(d.manager);
  expect((await manager.get(`/documents/records/${documentId}`)).status()).toBe(404);
  expect(
    (
      await manager.post(`/documents/records/${documentId}/versions/${version1Id}/download-url`)
    ).status(),
  ).toBe(404);
  await manager.dispose();
  // 5. An administrator of another organization (every document permission there).
  const outsider = await apiAs(d.outsider);
  expect((await outsider.get(`/documents/records/${documentId}`)).status()).toBe(404);
  expect(
    (
      await outsider.post(`/documents/records/${documentId}/versions/${version1Id}/download-url`)
    ).status(),
  ).toBe(404);
  expect(
    (
      await outsider.post(`/documents/uploads?documentId=${documentId}`, {
        multipart: { file: { name: 'x.pdf', mimeType: 'application/pdf', buffer: PDF } },
      })
    ).status(),
  ).toBe(404);
  await outsider.dispose();
});

test('a new version keeps the previous one; downloads and audit expose no key', async ({
  browser,
}) => {
  const d = seed.documents;
  hrSession ??= await signedIn(browser, d.hr);
  const hr = hrSession;
  // 6. HR adds a PNG as version 2.
  await hr.page.goto(`/documents/records/${documentId}`);
  await hr.page.getByRole('button', { name: 'Add version' }).click();
  const form = hr.page.getByRole('form', { name: 'Add version to Signed employment agreement' });
  await expect(form.getByLabel('Stored in')).toHaveValue('INTERNAL_OBJECT_STORAGE', {
    timeout: 30_000,
  });
  await form.getByLabel('File', { exact: true }).setInputFiles({
    name: 'agreement-scan.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await form.getByRole('button', { name: 'Save new version' }).click();
  await expect(hr.page.getByText('New version added.')).toBeVisible({ timeout: 30_000 });
  const v1 = hr.page.getByRole('row', { name: 'Version 1' });
  const v2 = hr.page.getByRole('row', { name: 'Version 2' });
  await expect(v1.getByText(/Superseded/)).toBeVisible();
  await expect(v2.getByText('Current')).toBeVisible();
  await expectNoSeriousA11yViolations(hr.page);
  // The earlier version still downloads, byte for byte.
  const old = await downloadBytes(hr.page, () =>
    v1.getByRole('button', { name: /^Download Signed employment agreement, version 1/ }).click(),
  );
  expect(old.bytes.equals(PDF)).toBe(true);
  const current = await downloadBytes(hr.page, () =>
    v2.getByRole('button', { name: /^Download Signed employment agreement, version 2/ }).click(),
  );
  expect(current.name).toBe('agreement-scan.png');
  expect(current.bytes.equals(PNG)).toBe(true);

  // 7. Neither the page nor the API's record response carries a storage key or link.
  expect(await hr.page.content()).not.toMatch(STORAGE_KEY);
  const asHr = await apiAs(d.hr);
  const detail = await (await asHr.get(`/documents/records/${documentId}`)).text();
  expect(detail).not.toMatch(STORAGE_KEY);
  expect(detail).not.toContain('storageKey');
  // A link is short-lived and bound to one object: it works once issued, and a tampered one
  // is refused.
  const link = (await (
    await asHr.post(`/documents/records/${documentId}/versions/${version1Id}/download-url`)
  ).json()) as { url: string; expiresAt: string };
  expect(link.url).toMatch(/^\/documents\/files\//);
  expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(61_000);
  const anonymous = await request.newContext({ baseURL: REAL_STACK_API });
  const served = await anonymous.get(link.url);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-disposition']).toMatch(/^attachment;/);
  expect(served.headers()['x-content-type-options']).toBe('nosniff');
  expect((await anonymous.get(`${link.url.slice(0, -2)}xx`)).status()).toBe(404);
  await anonymous.dispose();
  await asHr.dispose();

  // 8. Uploads and link issuance are audited with ids only.
  const audit = sql(
    `select action || ' ' || coalesce(metadata::text, '') from "AuditLog"
      where action in ('DOCUMENT_FILE_UPLOADED', 'DOCUMENT_FILE_URL_ISSUED')
        and metadata->>'organizationId' = '${d.organizationId}' order by "occurredAt"`,
  );
  const lines = audit.split('\n').filter(Boolean);
  expect(lines.filter((l) => l.startsWith('DOCUMENT_FILE_UPLOADED'))).toHaveLength(2);
  expect(
    lines.filter((l) => l.startsWith('DOCUMENT_FILE_URL_ISSUED')).length,
  ).toBeGreaterThanOrEqual(4);
  expect(audit).not.toMatch(STORAGE_KEY);
  expect(audit).not.toMatch(/\/documents\/files\/|X-Amz|https?:\/\//);
});
