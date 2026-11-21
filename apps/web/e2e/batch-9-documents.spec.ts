import { expect, test } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';
import {
  DEPT,
  ORG,
  PDF,
  checkAt,
  file,
  json,
  record,
  session,
  version,
} from './support/documents-mocks';

/**
 * Batch 9 — document files and the D10 lifecycle against a mocked API: HR uploads a new PDF
 * version (progress, then attach by upload id) and downloads a historical version through a
 * fresh short-lived link (a real browser download, the link never shown); quarantined and
 * legacy files are explained; an employee provides a document by upload; an administrator
 * reactivates a type, replaces a requirement through named pickers (history kept) and copies a
 * retired policy. axe (serious/critical) and no page-wide horizontal scroll at 1280, 820 and a
 * 375 px phone, with the forms and dialogs open.
 */

test('HR uploads a new version and downloads a historical one without seeing its link', async ({
  page,
}) => {
  await session(page, ['document.manage', 'document.restricted.read'], {});
  let versions: unknown[] = [
    version(2, {
      current: true,
      supersededAt: null,
      file: file({ scanStatus: 'PENDING', downloadable: false }),
    }),
    version(1, { file: file({ fileName: 'agreement-v1.pdf', scanStatus: 'CLEAN' }) }),
    version(0, { file: null, legacyReference: true, fileName: 'paper-scan.pdf' }),
  ];
  await page.route(`${API}/documents/records/doc-1`, (route) => json(route, record(versions)));
  let uploadQuery = '';
  await page.route(`${API}/documents/uploads?*`, async (route) => {
    uploadQuery = new URL(route.request().url()).search;
    const body = route.request().postDataBuffer() ?? Buffer.alloc(0);
    expect(body.includes(Buffer.from('filename="renewal.pdf"'))).toBe(true);
    await json(
      route,
      {
        id: 'up-1',
        fileName: 'renewal.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
        scanStatus: 'NOT_SCANNED',
      },
      201,
    );
  });
  let attached: unknown = null;
  await page.route(`${API}/documents/records/doc-1/versions`, async (route) => {
    attached = route.request().postDataJSON();
    versions = [
      version(3, { current: true, supersededAt: null, file: file({ fileName: 'renewal.pdf' }) }),
      ...versions,
    ];
    await json(route, record(versions), 201);
  });
  let linkRequests = 0;
  await page.route(`${API}/documents/records/doc-1/versions/v-1/download-url`, (route) => {
    linkRequests += 1;
    return json(route, {
      url: `/documents/files/opaque-token-${linkRequests}.mac`,
      expiresAt: '2026-11-08T15:01:00.000Z',
      fileName: 'agreement-v1.pdf',
    });
  });
  await page.route(`${API}/documents/files/*`, (route) =>
    route.fulfill({
      status: 200,
      body: PDF,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="agreement-v1.pdf"',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    }),
  );

  await page.goto('/documents/records/doc-1');
  await expect(page.getByRole('heading', { name: 'Employment agreement' })).toBeVisible();
  const v2 = page.getByRole('row', { name: 'Version 2' });
  await expect(
    v2.getByText('This file cannot be downloaded until its malware scan is complete.'),
  ).toBeVisible();
  await expect(
    page.getByRole('row', { name: 'Version 0' }).getByText(/not available for download/),
  ).toBeVisible();
  await checkAt(page);

  const v1 = page.getByRole('row', { name: 'Version 1' });
  const download = page.waitForEvent('download');
  await v1.getByRole('button', { name: /^Download Employment agreement, version 1/ }).click();
  expect((await download).suggestedFilename()).toBe('agreement-v1.pdf');
  expect(linkRequests).toBe(1);
  expect(await page.content()).not.toContain('opaque-token');

  await page.getByRole('button', { name: 'Add version' }).click();
  const form = page.getByRole('form', { name: 'Add version to Employment agreement' });
  await expect(form.getByLabel('Stored in')).toHaveValue('INTERNAL_OBJECT_STORAGE');
  await expect(form.getByLabel('Storage key')).toHaveCount(0);
  await form.getByLabel('File', { exact: true }).setInputFiles({
    name: 'renewal.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await expect(form.getByText(/renewal\.pdf · \d+ B · PDF/)).toBeVisible();
  await checkAt(page);
  await form.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText('New version added.')).toBeVisible();
  expect(uploadQuery).toBe('?documentId=doc-1');
  expect(attached).toEqual({
    provider: 'INTERNAL_OBJECT_STORAGE',
    uploadId: 'up-1',
    issuedOn: null,
    effectiveOn: null,
    expiresOn: null,
    note: null,
  });
  await expect(page.getByRole('row', { name: 'Version 3' })).toBeVisible();
});

test('a disallowed file is refused before upload with a clear message', async ({ page }) => {
  await session(page, ['document.manage', 'document.restricted.read'], {});
  await page.route(`${API}/documents/records/doc-1`, (route) =>
    json(route, record([version(1, { current: true, supersededAt: null })])),
  );
  let uploads = 0;
  await page.route(`${API}/documents/uploads?*`, (route) => {
    uploads += 1;
    return json(route, {}, 500);
  });
  await page.goto('/documents/records/doc-1');
  await page.getByRole('button', { name: 'Add version' }).click();
  const form = page.getByRole('form', { name: 'Add version to Employment agreement' });
  await form.getByLabel('File', { exact: true }).setInputFiles({
    name: 'notes.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from('PK'),
  });
  await expect(form.getByText('Only PDF, PNG and JPEG files can be uploaded.')).toBeVisible();
  await form.getByRole('button', { name: 'Save new version' }).click();
  await expect(form.getByRole('alert')).toHaveText('Only PDF, PNG and JPEG files can be uploaded.');
  expect(uploads).toBe(0);
  await checkAt(page);
});

test('an employee provides a document by uploading it', async ({ page }) => {
  await session(page, [], {});
  await page.route(`${API}/documents/me`, (route) =>
    json(route, {
      items: [
        {
          organization: { id: ORG, name: 'Northwind Academy' },
          documents: [],
          missing: [
            {
              typeId: 'ty-lic',
              typeName: 'Driver licence',
              status: 'MISSING',
              employeeProvided: true,
            },
          ],
          providableTypes: [
            {
              id: 'ty-lic',
              organizationId: ORG,
              code: 'LICENSE',
              name: 'Driver licence',
              description: null,
              category: 'LICENSE',
              defaultConfidentiality: 'EMPLOYEE_VISIBLE',
              expiryTracked: false,
              employeeProvided: true,
              archivedAt: null,
            },
          ],
        },
      ],
    }),
  );
  await page.route(`${API}/documents/me/policies`, (route) => json(route, { items: [] }));
  let uploadQuery = '';
  await page.route(`${API}/documents/uploads?*`, (route) => {
    uploadQuery = new URL(route.request().url()).search;
    return json(route, { id: 'up-self' }, 201);
  });
  let provided: unknown = null;
  await page.route(`${API}/documents/me/provide`, (route) => {
    provided = route.request().postDataJSON();
    return json(route, {}, 201);
  });
  await page.goto('/documents');
  await page
    .getByRole('button', { name: /Provide/ })
    .first()
    .click();
  const form = page.getByRole('form', { name: 'Provide a document' });
  await expect(form.getByLabel('Stored in')).toHaveValue('INTERNAL_OBJECT_STORAGE');
  await form.getByLabel('File', { exact: true }).setInputFiles({
    name: 'licence.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]),
  });
  await checkAt(page);
  await form.getByRole('button', { name: 'Save document' }).click();
  await expect(page.getByText('Document provided.')).toBeVisible();
  expect(uploadQuery).toBe(`?organizationId=${ORG}&self=true`);
  expect(provided).toMatchObject({
    organizationId: ORG,
    typeId: 'ty-lic',
    version: { provider: 'INTERNAL_OBJECT_STORAGE', uploadId: 'up-self' },
  });
});

test('an administrator reactivates a type, replaces a requirement and copies a retired policy', async ({
  page,
}) => {
  await session(page, ['document.type.manage', 'document.policy.manage'], {
    canManageTypes: true,
    canManagePolicies: true,
  });
  const type = (archivedAt: string | null) => ({
    id: 'ty-lic',
    organizationId: ORG,
    code: 'LICENSE',
    name: 'Driver licence',
    description: null,
    category: 'LICENSE',
    defaultConfidentiality: 'HR_ONLY',
    expiryTracked: false,
    employeeProvided: true,
    archivedAt,
  });
  let archived: string | null = '2026-10-01T12:00:00.000Z';
  await page.route(`${API}/documents/types?*`, (route) => json(route, { items: [type(archived)] }));
  await page.route(`${API}/documents/types/ty-lic/reactivate`, (route) => {
    archived = null;
    return json(route, type(null));
  });
  const requirement = (overrides: Record<string, unknown> = {}) => ({
    id: 'rq-1',
    typeId: 'ty-lic',
    typeName: 'Driver licence',
    employmentType: 'FULL_TIME',
    departmentId: DEPT,
    departmentName: 'Transport',
    positionId: null,
    positionName: null,
    note: 'Drivers',
    archivedAt: null,
    ...overrides,
  });
  let requirements = [requirement()];
  await page.route(`${API}/documents/requirements?*`, (route) => {
    const history = new URL(route.request().url()).searchParams.get('includeArchived') === 'true';
    return json(route, {
      items: requirements.filter((r) => history || r.archivedAt === null),
    });
  });
  let replaced: unknown = null;
  await page.route(`${API}/documents/requirements/rq-1/replace`, (route) => {
    replaced = route.request().postDataJSON();
    requirements = [
      requirement({ archivedAt: '2026-11-08T15:00:00.000Z' }),
      requirement({ id: 'rq-2', employmentType: 'PART_TIME' }),
    ];
    return json(route, { previous: requirements[0], requirement: requirements[1] });
  });
  await page.route(`${API}/documents/options?*`, (route) =>
    json(route, {
      items: [{ id: DEPT, label: 'Transport', description: 'TRN' }],
      nextAfterId: null,
    }),
  );
  const retired = {
    id: 'pol-1',
    organizationId: ORG,
    code: 'CONDUCT',
    title: 'Code of Conduct',
    description: null,
    typeId: null,
    status: 'RETIRED',
    acknowledgementRequired: true,
    audience: { employmentType: null, departmentId: DEPT, departmentName: 'Transport' },
    currentVersion: null,
    versions: [],
    retiredAt: '2026-10-01T12:00:00.000Z',
  };
  await page.route(`${API}/documents/policies?*`, (route) => json(route, { items: [retired] }));
  await page.route(`${API}/documents/policies/pol-1/acknowledgements`, (route) =>
    json(route, {
      policy: retired,
      currentVersionId: null,
      counts: { audience: 0, acknowledged: 0, pending: 0 },
      items: [],
    }),
  );
  let copied: unknown = null;
  await page.route(`${API}/documents/policies/pol-1/copy`, (route) => {
    copied = route.request().postDataJSON();
    return json(route, { ...retired, id: 'pol-2', code: 'CONDUCT-2027', status: 'DRAFT' }, 201);
  });

  await page.goto('/admin/documents');
  await page.getByRole('button', { name: 'Reactivate Driver licence' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Reactivate this document type?' });
  await expect(confirm).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await confirm.getByRole('button', { name: 'Reactivate type' }).click();
  await expect(page.getByText('Document type reactivated.')).toBeVisible();

  await page.getByRole('tab', { name: 'Requirements' }).click();
  await expect(page.getByText('Full Time · Department Transport')).toBeVisible();
  expect(await page.content()).not.toContain(DEPT);
  await expect(page.getByLabel('Department ID')).toHaveCount(0);
  await checkAt(page);
  await page.getByRole('button', { name: 'Change requirement Driver licence' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change requirement: Driver licence' });
  await dialog.getByLabel('Employment type').selectOption('PART_TIME');
  await checkAt(page);
  await dialog.getByRole('button', { name: 'Replace requirement' }).click();
  await expect(
    page.getByText('Requirement replaced. The previous version is kept in the history.'),
  ).toBeVisible();
  expect(replaced).toEqual({
    employmentType: 'PART_TIME',
    departmentId: DEPT,
    positionId: null,
    note: 'Drivers',
  });
  await page.getByLabel('Show archived requirements (history)').check();
  await expect(page.getByRole('row').filter({ hasText: 'Archived' })).toHaveCount(1);
  await expect(page.getByText('Part Time · Department Transport')).toBeVisible();

  await page.getByRole('tab', { name: 'Policies' }).click();
  await page.getByRole('button', { name: 'Open Code of Conduct' }).click();
  const panel = page.getByRole('region', { name: 'Policy Code of Conduct' });
  await panel.getByRole('button', { name: 'Copy into a new draft' }).click();
  const copy = panel.getByRole('form', { name: 'Copy Code of Conduct' });
  await copy.getByLabel('New policy code').fill('CONDUCT-2027');
  await checkAt(page);
  await copy.getByRole('button', { name: 'Create draft copy' }).click();
  await expect(page.getByText(/Copied into the draft policy CONDUCT-2027/)).toBeVisible();
  expect(copied).toEqual({ code: 'CONDUCT-2027' });
});
