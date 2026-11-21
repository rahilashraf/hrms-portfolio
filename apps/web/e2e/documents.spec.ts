import { expect, test, type Page, type Route } from '@playwright/test';
import { API } from './support/api-origin';

const identity = {
  id: 'documents-user',
  personId: 'person-documents-user',
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
      ? json(route, { accessToken: 'documents-token', identity }, 201)
      : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signedIn = true;
    return json(route, { accessToken: 'documents-token', identity }, 201);
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

function version(id: string, versionNumber: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    versionNumber,
    provider: 'EXTERNAL_URL',
    externalUrl: `https://docs.example.org/${id}.pdf`,
    externalFileId: null,
    fileName: null,
    mimeType: null,
    sizeBytes: null,
    issuedOn: null,
    effectiveOn: null,
    expiresOn: null,
    expiryStatus: 'NO_EXPIRY',
    note: null,
    referenceStatus: 'UNKNOWN',
    current: true,
    supersededAt: null,
    createdAt: '2026-01-01T12:00:00.000Z',
    ...overrides,
  };
}

function documentRecord(overrides: Record<string, unknown> = {}) {
  const current = version('v-1', 1);
  return {
    id: 'doc-1',
    organizationId: 'org-1',
    employeeId: 'emp-1',
    employmentAssignmentId: null,
    type: {
      id: 'ty-cert',
      code: 'CERTIFICATION',
      name: 'Certification',
      category: 'CERTIFICATION',
      expiryTracked: true,
    },
    title: 'CPR certificate',
    description: null,
    confidentiality: 'MANAGER_VISIBLE',
    status: 'ACTIVE',
    source: 'HR',
    provenance: null,
    archivedAt: null,
    currentVersion: current,
    expiryStatus: 'NO_EXPIRY',
    versions: [current],
    createdAt: '2026-01-01T12:00:00.000Z',
    actions: { canManage: false },
    ...overrides,
  };
}

const type = (id: string, code: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id,
  organizationId: 'org-1',
  code,
  name,
  description: null,
  category: 'CERTIFICATION',
  defaultConfidentiality: 'MANAGER_VISIBLE',
  expiryTracked: true,
  employeeProvided: true,
  archivedAt: null,
  ...overrides,
});

const STATEMENT = 'I have read and will follow the Code of Conduct (2026).';

function policyVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pv-2',
    versionNumber: 2,
    versionLabel: '2026',
    provider: 'EXTERNAL_URL',
    externalUrl: 'https://docs.example.org/conduct-2026',
    externalFileId: null,
    fileName: null,
    mimeType: null,
    acknowledgementStatement: STATEMENT,
    effectiveOn: '2026-09-01',
    state: 'CURRENT',
    publishedAt: '2026-09-01T12:00:00.000Z',
    supersededAt: null,
    referenceStatus: 'UNKNOWN',
    ...overrides,
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pol-1',
    organizationId: 'org-1',
    code: 'CONDUCT',
    title: 'Code of Conduct',
    description: null,
    typeId: null,
    status: 'PUBLISHED',
    acknowledgementRequired: true,
    audience: { employmentType: null, departmentId: null },
    currentVersion: policyVersion(),
    versions: [policyVersion()],
    retiredAt: null,
    ...overrides,
  };
}

test('an employee acknowledges a policy version and provides a missing document', async ({
  page,
}) => {
  await mockSession(page, []);
  let acknowledged = false;
  let provided: Record<string, unknown> | null = null;
  let ackBody: unknown = null;
  await page.route(path('/documents/me'), (route) =>
    json(route, {
      items: [
        {
          organization: { id: 'org-1', name: 'Camp' },
          documents: provided
            ? [
                documentRecord({
                  id: 'doc-lic',
                  title: 'Driver licence',
                  confidentiality: 'EMPLOYEE_VISIBLE',
                  source: 'EMPLOYEE',
                  expiryStatus: 'VALID',
                  type: {
                    id: 'ty-lic',
                    code: 'LICENSE',
                    name: 'Licence',
                    category: 'LICENSE',
                    expiryTracked: true,
                  },
                  currentVersion: version('v-lic', 1, {
                    provider: 'GOOGLE_DRIVE',
                    externalUrl: 'https://drive.google.com/file/d/licence',
                    expiresOn: '2029-05-31',
                    expiryStatus: 'VALID',
                  }),
                  actions: { canManage: false, canAddVersion: true },
                }),
              ]
            : [],
          missing: provided
            ? []
            : [
                {
                  typeId: 'ty-lic',
                  typeName: 'Licence',
                  status: 'MISSING',
                  employeeProvided: true,
                },
              ],
          providableTypes: [type('ty-lic', 'LICENSE', 'Licence')],
        },
      ],
    }),
  );
  await page.route(path('/documents/me/policies'), (route) =>
    json(route, {
      items: [
        {
          ...policy(),
          myAcknowledgement: acknowledged
            ? { id: 'ack-1', acknowledgedAt: '2026-10-06T12:00:00.000Z', statement: STATEMENT }
            : null,
          acknowledgedEarlierVersion: true,
          needsAcknowledgement: !acknowledged,
        },
      ],
    }),
  );
  await page.route(path('/documents/policies/pol-1/versions/pv-2/acknowledge'), (route) => {
    ackBody = route.request().postDataJSON();
    acknowledged = true;
    return json(
      route,
      { acknowledgementId: 'ack-1', policyVersionId: 'pv-2', created: true, statement: STATEMENT },
      201,
    );
  });
  await page.route(path('/documents/me/provide'), (route) => {
    provided = route.request().postDataJSON();
    return json(route, documentRecord(), 201);
  });

  await signIn(page);
  await expect(page.getByRole('link', { name: 'Document Records', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'My Documents' }).click();
  await expect(page.getByRole('heading', { name: 'My documents' })).toBeVisible();

  const ack = page.getByRole('form', { name: 'Acknowledge Code of Conduct' });
  await expect(ack.getByText(STATEMENT)).toBeVisible();
  await expect(
    ack.getByText('You acknowledged an earlier version.', { exact: false }),
  ).toBeVisible();
  await expect(ack.getByRole('button', { name: 'Acknowledge' })).toBeDisabled();
  await ack.getByLabel('I acknowledge the statement above.').check();
  await ack.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByText('Acknowledgement recorded.')).toBeVisible();
  await expect(page.getByText('You acknowledged version 2026 on', { exact: false })).toBeVisible();
  expect(ackBody).toEqual({ statementAccepted: true });
  await expect(page.getByRole('link', { name: 'Read Code of Conduct' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );

  const missing = page.getByRole('region', { name: 'Missing documents — Camp' });
  await missing.getByRole('button', { name: 'Provide Licence' }).click();
  const form = page.getByRole('form', { name: 'Provide a document' });
  await form.getByLabel('Title').fill('Driver licence');
  await form.getByLabel('Stored in').selectOption('GOOGLE_DRIVE');
  await form.getByLabel('Drive link (https)').fill('https://drive.google.com/file/d/licence');
  await form.getByLabel('Expires on').fill('2029-05-31');
  await form.getByRole('button', { name: 'Save document' }).click();
  await expect(page.getByText('Document provided.')).toBeVisible();
  const licence = page.getByRole('listitem', { name: 'Document Driver licence' });
  await expect(licence.getByText('Valid')).toBeVisible();
  await expect(licence.getByRole('link', { name: 'Open Driver licence' })).toHaveAttribute(
    'target',
    '_blank',
  );
  expect(provided).toEqual({
    organizationId: 'org-1',
    typeId: 'ty-lic',
    title: 'Driver licence',
    version: {
      provider: 'GOOGLE_DRIVE',
      externalUrl: 'https://drive.google.com/file/d/licence',
      externalFileId: null,
      fileName: null,
      issuedOn: null,
      effectiveOn: null,
      expiresOn: '2029-05-31',
      note: null,
    },
  });
});

const organizations = (actions: Record<string, boolean>) => ({
  items: [
    {
      id: 'org-1',
      name: 'Camp',
      code: 'CAMP',
      timezone: 'America/Toronto',
      actions: {
        canManageTypes: false,
        canManagePolicies: false,
        canReadRecords: true,
        canManageRecords: false,
        ...actions,
      },
    },
  ],
});

test('HR initializes and creates document types, then authors and publishes a policy version', async ({
  page,
}) => {
  await mockSession(page, ['document.type.manage', 'document.policy.manage']);
  let types = [] as Array<ReturnType<typeof type>>;
  let createdType: unknown = null;
  let draftBody: unknown = null;
  let state: 'published' | 'draft' | 'republished' = 'published';
  await page.route(path('/documents/organizations'), (route) =>
    json(route, organizations({ canManageTypes: true, canManagePolicies: true })),
  );
  await page.route(path('/documents/types'), (route) => {
    if (route.request().method() === 'POST') {
      createdType = route.request().postDataJSON();
      types = [...types, type('ty-fa', 'FIRST-AID', 'First aid')];
      return json(route, types.at(-1), 201);
    }
    return json(route, { items: types });
  });
  await page.route(path('/documents/types/initialize'), (route) => {
    types = [type('ty-cert', 'CERTIFICATION', 'Certification')];
    return json(route, { created: true, items: types }, 201);
  });
  const policyNow = () => {
    const current = policyVersion(
      state === 'republished' ? { id: 'pv-3', versionNumber: 3, versionLabel: '2027' } : {},
    );
    const versions =
      state === 'draft'
        ? [
            policyVersion({
              id: 'pv-3',
              versionNumber: 3,
              versionLabel: '2027',
              state: 'DRAFT',
              publishedAt: null,
            }),
            policyVersion(),
          ]
        : state === 'republished'
          ? [
              current,
              policyVersion({ state: 'SUPERSEDED', supersededAt: '2026-10-06T12:00:00.000Z' }),
            ]
          : [policyVersion()];
    return policy({ currentVersion: current, versions });
  };
  await page.route(path('/documents/policies'), (route) => json(route, { items: [policyNow()] }));
  await page.route(path('/documents/policies/pol-1/versions'), (route) => {
    draftBody = route.request().postDataJSON();
    state = 'draft';
    return json(route, policyNow(), 201);
  });
  await page.route(path('/documents/policies/pol-1/versions/pv-3/publish'), (route) => {
    state = 'republished';
    return json(route, policyNow(), 201);
  });
  await page.route(path('/documents/policies/pol-1/acknowledgements'), (route) =>
    json(route, {
      policy: policyNow(),
      currentVersionId: state === 'republished' ? 'pv-3' : 'pv-2',
      counts:
        state === 'republished'
          ? { audience: 2, acknowledged: 0, pending: 2 }
          : { audience: 2, acknowledged: 1, pending: 1 },
      items: [
        {
          employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
          status: state === 'republished' ? 'EARLIER_VERSION_ONLY' : 'ACKNOWLEDGED',
          acknowledgedAt: state === 'republished' ? null : '2026-09-03T12:00:00.000Z',
        },
        {
          employee: { id: 'emp-2', employeeNumber: 'E-2', displayName: 'Alan Turing' },
          status: 'PENDING',
          acknowledgedAt: null,
        },
      ],
    }),
  );

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Document Records', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Documents & employee records' })).toBeVisible();
  await expect(page.getByText('No document types yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Initialize default types' }).click();
  await expect(page.getByText('Default document types created.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive Certification' })).toBeVisible();

  await page.getByRole('button', { name: 'New document type' }).click();
  const typeForm = page.getByRole('form', { name: 'Create document type' });
  await typeForm.getByLabel('Type code').fill('FIRST-AID');
  await typeForm.getByLabel('Type name').fill('First aid');
  await typeForm.getByLabel('Category').selectOption('TRAINING_CERTIFICATE');
  await typeForm.getByLabel('Expiry tracked').check();
  await typeForm.getByLabel('Employees provide it').check();
  await typeForm.getByRole('button', { name: 'Create type' }).click();
  await expect(page.getByText('Document type created.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit First aid' })).toBeVisible();
  expect(createdType).toEqual({
    organizationId: 'org-1',
    code: 'FIRST-AID',
    category: 'TRAINING_CERTIFICATE',
    name: 'First aid',
    description: null,
    defaultConfidentiality: 'HR_ONLY',
    expiryTracked: true,
    employeeProvided: true,
  });

  await page.getByRole('tab', { name: 'Policies' }).click();
  await page.getByRole('button', { name: 'Open Code of Conduct' }).click();
  const panel = page.getByRole('region', { name: 'Policy Code of Conduct' });
  const tracking = panel.getByRole('region', { name: 'Acknowledgement tracking' });
  await expect(
    tracking.getByText('1 of 2 acknowledged the current version', { exact: false }),
  ).toBeVisible();

  const draft = panel.getByRole('form', { name: 'Create draft version' });
  await draft.getByLabel('Version label').fill('2027');
  await draft.getByLabel('Link (https)').fill('https://docs.example.org/conduct-2027');
  await draft.getByLabel('Acknowledgement statement').fill('I have read the 2027 Code of Conduct.');
  await draft.getByRole('button', { name: 'Create draft version' }).click();
  await expect(page.getByText('Draft version created.')).toBeVisible();
  expect(draftBody).toEqual({
    versionLabel: '2027',
    acknowledgementStatement: 'I have read the 2027 Code of Conduct.',
    effectiveOn: null,
    provider: 'EXTERNAL_URL',
    externalUrl: 'https://docs.example.org/conduct-2027',
    externalFileId: null,
    fileName: null,
  });
  await panel.getByRole('button', { name: 'Publish 2027' }).click();
  await expect(page.getByText('Version published. Employees acknowledge it anew.')).toBeVisible();
  await expect(panel.getByText('Superseded')).toBeVisible();
  await expect(
    tracking.getByText('0 of 2 acknowledged the current version', { exact: false }),
  ).toBeVisible();
  await expect(tracking.getByText('Earlier version only')).toBeVisible();
});

test('HR reviews the expiring and missing documents dashboards', async ({ page }) => {
  await mockSession(page, ['document.read']);
  const windows: string[] = [];
  await page.route(path('/documents/organizations'), (route) => json(route, organizations({})));
  await page.route(path('/documents/types'), (route) =>
    json(route, { items: [type('ty-cert', 'CERTIFICATION', 'Certification')] }),
  );
  await page.route(path('/documents/expiring'), (route) => {
    const withinDays = Number(new URL(route.request().url()).searchParams.get('withinDays') ?? 30);
    windows.push(String(withinDays));
    return json(route, {
      today: '2026-10-06',
      withinDays,
      items: [
        {
          documentId: 'doc-exp',
          title: 'Lifeguard certificate',
          type: { id: 'ty-cert', name: 'Certification' },
          employee: { id: 'emp-2', employeeNumber: 'E-2', displayName: 'Alan Turing' },
          expiresOn: '2026-09-30',
          expiryStatus: 'EXPIRED',
        },
        ...(withinDays >= 60
          ? [
              {
                documentId: 'doc-soon',
                title: 'CPR certificate',
                type: { id: 'ty-cert', name: 'Certification' },
                employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
                expiresOn: '2026-11-20',
                expiryStatus: 'VALID',
              },
            ]
          : []),
      ],
    });
  });
  await page.route(path('/documents/missing'), (route) =>
    json(route, {
      today: '2026-10-06',
      items: [
        {
          employee: { id: 'emp-3', employeeNumber: 'E-3', displayName: 'Grace Hopper' },
          missing: [
            { typeId: 'ty-lic', typeName: 'Licence', status: 'MISSING' },
            { typeId: 'ty-cert', typeName: 'Certification', status: 'EXPIRED' },
          ],
        },
      ],
    }),
  );

  await signIn(page);
  await page.goto('/admin/documents');
  await page.getByRole('tab', { name: 'Expiring' }).click();
  await expect(page.getByRole('link', { name: 'Lifeguard certificate' })).toHaveAttribute(
    'href',
    '/documents/records/doc-exp',
  );
  await expect(page.getByText('Expired', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'CPR certificate' })).toHaveCount(0);
  await page.getByLabel('Expiring within (days)').fill('60');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('link', { name: 'CPR certificate' })).toBeVisible();
  expect(windows).toEqual(['30', '60']);

  await page.getByRole('tab', { name: 'Missing' }).click();
  await expect(page.getByRole('link', { name: 'Grace Hopper' })).toHaveAttribute(
    'href',
    '/admin/employees/emp-3',
  );
  await expect(page.getByRole('cell', { name: /Licence/ })).toBeVisible();
});

test('HR adds a version to a record and keeps the full version history', async ({ page }) => {
  await mockSession(page, ['document.manage', 'document.confidential.read']);
  let added: Record<string, unknown> | null = null;
  const detail = () => {
    const v1 = version('v-1', 1, {
      expiresOn: '2026-09-30',
      expiryStatus: 'EXPIRED',
      current: !added,
      supersededAt: added ? '2026-10-06T12:00:00.000Z' : null,
    });
    const v2 = added
      ? version('v-2', 2, { expiresOn: '2028-09-30', expiryStatus: 'VALID', note: 'Renewed' })
      : null;
    return documentRecord({
      currentVersion: v2 ?? v1,
      expiryStatus: v2 ? 'VALID' : 'EXPIRED',
      versions: v2 ? [v2, v1] : [v1],
      actions: { canManage: true },
    });
  };
  await page.route(path('/documents/records/doc-1'), (route) => json(route, detail()));
  await page.route(path('/documents/records/doc-1/versions'), (route) => {
    added = route.request().postDataJSON();
    return json(route, detail(), 201);
  });

  await signIn(page);
  await page.goto('/documents/records/doc-1');
  await expect(page.getByRole('heading', { name: 'CPR certificate' })).toBeVisible();
  await expect(page.getByText('Expired', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Add version' }).click();
  const form = page.getByRole('form', { name: 'Add version to CPR certificate' });
  await form.getByLabel('Link (https)').fill('https://docs.example.org/v-2.pdf');
  await form.getByLabel('Expires on').fill('2028-09-30');
  await form.getByLabel('Version note').fill('Renewed');
  await form.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByText('New version added.')).toBeVisible();
  const history = page.getByRole('region', { name: 'Version history' });
  await expect(history.getByRole('row', { name: /Version 1/ })).toContainText('Superseded');
  await expect(history.getByRole('row', { name: /Version 2/ })).toContainText('Current');
  await expect(history.getByRole('link', { name: 'Open version 2' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  expect(added).toMatchObject({
    provider: 'EXTERNAL_URL',
    externalUrl: 'https://docs.example.org/v-2.pdf',
    expiresOn: '2028-09-30',
    note: 'Renewed',
  });
});
