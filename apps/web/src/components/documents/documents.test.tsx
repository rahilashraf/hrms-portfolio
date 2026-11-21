import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type {
  DocumentType,
  DocumentVersion,
  DocumentsOrganization,
  EmployeeDocument,
  MyPolicy,
  Policy,
  PolicyVersion,
} from '../../lib/documents/types';
import type { ApplicationDetail } from '../../lib/recruitment/types';
import { OnboardingAdminPage } from '../onboarding/onboarding-admin-page';
import { ApplicationPage } from '../recruitment/application-page';
import { DocumentRecordPage } from './document-record-page';
import { DocumentsAdminPage } from './documents-admin-page';
import { EmployeeDocumentsSection } from './employee-documents-section';
import { MyDocumentsPage } from './my-documents-page';

const mocks = vi.hoisted(() => ({
  api: {
    organizations: vi.fn(),
    mine: vi.fn(),
    myPolicies: vi.fn(),
    provide: vi.fn(),
    types: vi.fn(),
    createType: vi.fn(),
    initializeTypes: vi.fn(),
    updateType: vi.fn(),
    archiveType: vi.fn(),
    requirements: vi.fn(),
    createRequirement: vi.fn(),
    archiveRequirement: vi.fn(),
    createDocument: vi.fn(),
    document: vi.fn(),
    updateDocument: vi.fn(),
    addVersion: vi.fn(),
    archiveDocument: vi.fn(),
    employeeRecords: vi.fn(),
    expiring: vi.fn(),
    missing: vi.fn(),
    handoff: vi.fn(),
    policies: vi.fn(),
    createPolicy: vi.fn(),
    updatePolicy: vi.fn(),
    createPolicyVersion: vi.fn(),
    publishPolicyVersion: vi.fn(),
    retirePolicy: vi.fn(),
    acknowledgePolicy: vi.fn(),
    policyTracking: vi.fn(),
    upload: vi.fn(),
    versionDownload: vi.fn(),
    policyVersionDownload: vi.fn(),
    options: vi.fn(),
    reactivateType: vi.fn(),
    replaceRequirement: vi.fn(),
    copyPolicy: vi.fn(),
  },
  startDownload: vi.fn(),
  onboarding: {
    organizations: vi.fn(),
    templates: vi.fn(),
    createTemplate: vi.fn(),
    startFromHire: vi.fn(),
  },
  recruitment: { application: vi.fn() },
  employee: { get: vi.fn() },
  useAuth: vi.fn(),
}));

vi.mock('../../lib/documents/api', () => ({
  documentsApi: mocks.api,
  startDownload: mocks.startDownload,
}));
vi.mock('../../lib/onboarding/api', () => ({ onboardingApi: mocks.onboarding }));
vi.mock('../../lib/recruitment/api', () => ({ recruitmentApi: mocks.recruitment }));
vi.mock('../../lib/employee/api', () => ({ employeeApi: mocks.employee }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const api = mocks.api;
const auth = (keys: string[]) =>
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] })),
    },
  });

const versionOf = (overrides: Partial<DocumentVersion> = {}): DocumentVersion => ({
  id: 'v-1',
  versionNumber: 1,
  provider: 'GOOGLE_DRIVE',
  externalUrl: 'https://drive.google.com/file/d/cpr-1',
  externalFileId: null,
  fileName: 'cpr.pdf',
  mimeType: null,
  sizeBytes: null,
  issuedOn: '2025-10-01',
  effectiveOn: null,
  expiresOn: '2026-10-20',
  expiryStatus: 'EXPIRING_SOON',
  note: null,
  referenceStatus: 'UNKNOWN',
  current: true,
  supersededAt: null,
  createdAt: '2025-10-01T12:00:00.000Z',
  ...overrides,
});

const documentOf = (overrides: Partial<EmployeeDocument> = {}): EmployeeDocument => {
  const current = versionOf();
  return {
    id: 'doc-1',
    organizationId: 'org-1',
    employeeId: 'emp-1',
    employmentAssignmentId: null,
    type: {
      id: 'ty-cpr',
      code: 'CERTIFICATION',
      name: 'Certification',
      category: 'CERTIFICATION',
      expiryTracked: true,
    },
    title: 'CPR certificate',
    description: null,
    confidentiality: 'EMPLOYEE_VISIBLE',
    status: 'ACTIVE',
    source: 'EMPLOYEE',
    provenance: null,
    archivedAt: null,
    currentVersion: current,
    expiryStatus: 'EXPIRING_SOON',
    versions: [current],
    createdAt: '2025-10-01T12:00:00.000Z',
    actions: { canManage: false, canAddVersion: true },
    ...overrides,
  };
};

const typeOf = (overrides: Partial<DocumentType> = {}): DocumentType => ({
  id: 'ty-cpr',
  organizationId: 'org-1',
  code: 'CERTIFICATION',
  name: 'Certification',
  description: null,
  category: 'CERTIFICATION',
  defaultConfidentiality: 'MANAGER_VISIBLE',
  expiryTracked: true,
  employeeProvided: true,
  archivedAt: null,
  ...overrides,
});

const policyVersion = (overrides: Partial<PolicyVersion> = {}): PolicyVersion => ({
  id: 'pv-2',
  versionNumber: 2,
  versionLabel: '2026',
  provider: 'EXTERNAL_URL',
  externalUrl: 'https://docs.example.org/conduct-2026',
  externalFileId: null,
  fileName: null,
  mimeType: null,
  acknowledgementStatement: 'I have read and will follow the Code of Conduct (2026).',
  effectiveOn: '2026-09-01',
  state: 'CURRENT',
  publishedAt: '2026-09-01T12:00:00.000Z',
  supersededAt: null,
  referenceStatus: 'UNKNOWN',
  ...overrides,
});

const policyOf = (overrides: Partial<Policy> = {}): Policy => ({
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
});

const myPolicy = (overrides: Partial<MyPolicy> = {}): MyPolicy => ({
  ...policyOf(),
  myAcknowledgement: null,
  acknowledgedEarlierVersion: true,
  needsAcknowledgement: true,
  ...overrides,
});

const organization = (
  overrides: Partial<DocumentsOrganization['actions']> = {},
): DocumentsOrganization => ({
  id: 'org-1',
  name: 'Camp',
  code: 'CAMP',
  timezone: 'America/Toronto',
  actions: {
    canManageTypes: false,
    canManagePolicies: false,
    canReadRecords: true,
    canManageRecords: false,
    ...overrides,
  },
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const fn of Object.values(mocks.onboarding)) fn.mockReset();
  mocks.recruitment.application.mockReset();
  mocks.useAuth.mockReset();
  auth([]);
});

// Batch 10E-2: tab clicks now write the section into the URL (#hash); every test starts from a
// clean address so one test's tab does not open the next.
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('MyDocumentsPage', () => {
  const mine = () => ({
    items: [
      {
        organization: { id: 'org-1', name: 'Camp' },
        documents: [documentOf()],
        missing: [
          { typeId: 'ty-lic', typeName: 'Licence', status: 'MISSING', employeeProvided: true },
          {
            typeId: 'ty-bg',
            typeName: 'Background check',
            status: 'EXPIRED',
            employeeProvided: false,
          },
        ],
        providableTypes: [typeOf(), typeOf({ id: 'ty-lic', code: 'LICENSE', name: 'Licence' })],
      },
    ],
  });

  it('shows my documents with expiry, missing requirements and an acknowledged policy', async () => {
    api.mine.mockResolvedValue(mine());
    api.myPolicies.mockResolvedValue({
      items: [
        myPolicy({
          needsAcknowledgement: false,
          acknowledgedEarlierVersion: false,
          myAcknowledgement: {
            id: 'ack-1',
            acknowledgedAt: '2026-09-02T12:00:00.000Z',
            statement: 'I have read and will follow the Code of Conduct (2026).',
          },
        }),
      ],
    });
    render(<MyDocumentsPage />);
    const document = await screen.findByRole('listitem', { name: 'Document CPR certificate' });
    expect(within(document).getByText('Expiring soon')).toBeInTheDocument();
    expect(within(document).getByText(/Version 1 · Expires 10\/20\/2026/)).toBeInTheDocument();
    expect(within(document).getByRole('link', { name: 'Open CPR certificate' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(within(document).getByRole('link', { name: 'Version history' })).toHaveAttribute(
      'href',
      '/documents/records/doc-1',
    );
    const missing = screen.getByRole('region', { name: 'Missing documents — Camp' });
    expect(within(missing).getByText('Licence')).toBeInTheDocument();
    expect(within(missing).getByText('Expired')).toBeInTheDocument();
    expect(within(missing).getByText('HR records this document.')).toBeInTheDocument();
    const policy = screen.getByRole('listitem', { name: 'Policy Code of Conduct' });
    expect(within(policy).getByText(/You acknowledged version 2026 on/)).toBeInTheDocument();
    expect(
      screen.queryByRole('form', { name: 'Acknowledge Code of Conduct' }),
    ).not.toBeInTheDocument();
  });

  it('acknowledges the current version only after the statement is accepted', async () => {
    api.mine.mockResolvedValue({ items: [] });
    api.myPolicies.mockResolvedValue({ items: [myPolicy()] });
    api.acknowledgePolicy.mockResolvedValue({ created: true });
    render(<MyDocumentsPage />);
    const form = await screen.findByRole('form', { name: 'Acknowledge Code of Conduct' });
    expect(
      within(form).getByText('I have read and will follow the Code of Conduct (2026).'),
    ).toBeInTheDocument();
    expect(
      within(form).getByText(
        'You acknowledged an earlier version. This version needs a new acknowledgement.',
      ),
    ).toBeInTheDocument();
    const button = within(form).getByRole('button', { name: 'Acknowledge' });
    expect(button).toBeDisabled();
    fireEvent.click(within(form).getByLabelText('I acknowledge the statement above.'));
    fireEvent.click(button);
    await waitFor(() => expect(api.acknowledgePolicy).toHaveBeenCalledWith('pol-1', 'pv-2'));
    expect(await screen.findByText('Acknowledgement recorded.')).toBeInTheDocument();
  });

  it('reloads and explains when a newer version was published meanwhile', async () => {
    api.mine.mockResolvedValue({ items: [] });
    api.myPolicies.mockResolvedValue({ items: [myPolicy()] });
    api.acknowledgePolicy.mockRejectedValue(
      new AuthApiError('conflict', 409, 'A newer version was published.', {
        code: 'POLICY_VERSION_NOT_CURRENT',
        currentVersionId: 'pv-3',
      }),
    );
    render(<MyDocumentsPage />);
    const form = await screen.findByRole('form', { name: 'Acknowledge Code of Conduct' });
    fireEvent.click(within(form).getByLabelText('I acknowledge the statement above.'));
    fireEvent.click(within(form).getByRole('button', { name: 'Acknowledge' }));
    expect(
      await screen.findByText(
        'A newer version of this policy was published. Review it before acknowledging.',
      ),
    ).toBeInTheDocument();
    expect(api.myPolicies).toHaveBeenCalledTimes(2);
  });

  it('provides a Google Drive reference for a missing employee-provided document', async () => {
    api.mine.mockResolvedValue(mine());
    api.myPolicies.mockResolvedValue({ items: [] });
    api.provide.mockResolvedValue(documentOf());
    render(<MyDocumentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Provide Licence' }));
    const form = screen.getByRole('form', { name: 'Provide a document' });
    expect(within(form).getByLabelText('Document type')).toHaveValue('ty-lic');
    expect(within(form).getByLabelText('Title')).toHaveValue('Licence');
    fireEvent.change(within(form).getByLabelText('Stored in'), {
      target: { value: 'GOOGLE_DRIVE' },
    });
    fireEvent.change(within(form).getByLabelText('Expires on'), {
      target: { value: '2028-05-31' },
    });
    fireEvent.change(within(form).getByLabelText('Drive link (https)'), {
      target: { value: 'javascript:alert(1)' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save document' }));
    expect(
      await within(form).findByText('Document links must start with https://.'),
    ).toBeInTheDocument();
    expect(api.provide).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText('Drive link (https)'), { target: { value: '' } });
    fireEvent.change(within(form).getByLabelText('Drive file ID'), {
      target: { value: '1AbC-licence' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save document' }));
    await waitFor(() =>
      expect(api.provide).toHaveBeenCalledWith({
        organizationId: 'org-1',
        typeId: 'ty-lic',
        title: 'Licence',
        version: {
          provider: 'GOOGLE_DRIVE',
          externalUrl: null,
          externalFileId: '1AbC-licence',
          fileName: null,
          issuedOn: null,
          effectiveOn: null,
          expiresOn: '2028-05-31',
          note: null,
        },
      }),
    );
    expect(await screen.findByText('Document provided.')).toBeInTheDocument();
  });

  it('adds a new version to my own provided document', async () => {
    api.mine.mockResolvedValue(mine());
    api.myPolicies.mockResolvedValue({ items: [] });
    api.addVersion.mockResolvedValue(documentOf());
    render(<MyDocumentsPage />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add a new version of CPR certificate' }),
    );
    const form = screen.getByRole('form', { name: 'Add version to CPR certificate' });
    fireEvent.change(within(form).getByLabelText('Link (https)'), {
      target: { value: 'https://example.org/cpr-2026.pdf' },
    });
    fireEvent.change(within(form).getByLabelText('Expires on'), {
      target: { value: '2028-10-01' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save new version' }));
    await waitFor(() =>
      expect(api.addVersion).toHaveBeenCalledWith('doc-1', {
        provider: 'EXTERNAL_URL',
        externalUrl: 'https://example.org/cpr-2026.pdf',
        externalFileId: null,
        fileName: null,
        issuedOn: null,
        effectiveOn: null,
        expiresOn: '2028-10-01',
        note: null,
      }),
    );
    expect(await screen.findByText('New version added.')).toBeInTheDocument();
  });
});

describe('DocumentsAdminPage', () => {
  it('is forbidden without document permissions', () => {
    auth(['employee.manage']);
    render(<DocumentsAdminPage />);
    expect(screen.getByText('You do not have permission to view documents.')).toBeInTheDocument();
    expect(api.organizations).not.toHaveBeenCalled();
  });

  it('initializes default types, creates one and archives another', async () => {
    auth(['document.type.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ canManageTypes: true })] });
    api.types.mockResolvedValueOnce({ items: [] }).mockResolvedValue({ items: [typeOf()] });
    api.initializeTypes.mockResolvedValue({ created: true, items: [typeOf()] });
    api.createType.mockResolvedValue(typeOf());
    api.archiveType.mockResolvedValue(typeOf());
    render(<DocumentsAdminPage />);
    expect(await screen.findByText(/No document types yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Initialize default types' }));
    await waitFor(() => expect(api.initializeTypes).toHaveBeenCalledWith('org-1'));
    expect(await screen.findByText('Default document types created.')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Archive Certification' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New document type' }));
    const form = screen.getByRole('form', { name: 'Create document type' });
    fireEvent.change(within(form).getByLabelText('Type code'), { target: { value: 'FIRST-AID' } });
    fireEvent.change(within(form).getByLabelText('Type name'), { target: { value: 'First aid' } });
    fireEvent.change(within(form).getByLabelText('Category'), {
      target: { value: 'TRAINING_CERTIFICATE' },
    });
    fireEvent.change(within(form).getByLabelText('Default confidentiality'), {
      target: { value: 'MANAGER_VISIBLE' },
    });
    fireEvent.click(within(form).getByLabelText('Expiry tracked'));
    fireEvent.click(within(form).getByLabelText('Employees provide it'));
    fireEvent.click(within(form).getByRole('button', { name: 'Create type' }));
    await waitFor(() =>
      expect(api.createType).toHaveBeenCalledWith({
        organizationId: 'org-1',
        code: 'FIRST-AID',
        category: 'TRAINING_CERTIFICATE',
        name: 'First aid',
        description: null,
        defaultConfidentiality: 'MANAGER_VISIBLE',
        expiryTracked: true,
        employeeProvided: true,
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Archive Certification' }));
    // Archiving is confirmed first: Cancel sends nothing.
    fireEvent.click(
      within(
        await screen.findByRole('alertdialog', { name: 'Archive this document type?' }),
      ).getByRole('button', { name: 'Cancel' }),
    );
    expect(api.archiveType).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive Certification' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive type' }),
    );
    await waitFor(() => expect(api.archiveType).toHaveBeenCalledWith('ty-cpr'));
  });

  it('explains a type that still has requirements', async () => {
    auth(['document.type.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ canManageTypes: true })] });
    api.types.mockResolvedValue({ items: [typeOf()] });
    api.archiveType.mockRejectedValue(
      new AuthApiError('conflict', 409, 'Archive the requirements of this type first.', {
        code: 'DOCUMENT_TYPE_REQUIRED',
      }),
    );
    render(<DocumentsAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive Certification' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive type' }),
    );
    expect(
      await screen.findByText('Archive the requirements that use this type first.'),
    ).toBeInTheDocument();
  });

  it('adds and archives requirements', async () => {
    auth(['document.type.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ canManageTypes: true })] });
    api.types.mockResolvedValue({ items: [typeOf()] });
    api.requirements.mockResolvedValue({
      items: [
        {
          id: 'rq-1',
          typeId: 'ty-cpr',
          typeName: 'Certification',
          employmentType: 'CASUAL',
          departmentId: null,
          positionId: null,
          note: 'Lifeguards',
          archivedAt: null,
        },
      ],
    });
    api.createRequirement.mockResolvedValue({});
    api.archiveRequirement.mockResolvedValue({});
    render(<DocumentsAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Requirements' }));
    expect(await screen.findByRole('cell', { name: 'Casual' })).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Add requirement' });
    fireEvent.change(within(form).getByLabelText('Employment type'), {
      target: { value: 'FULL_TIME' },
    });
    fireEvent.change(within(form).getByLabelText('Requirement note'), {
      target: { value: 'All staff' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add requirement' }));
    await waitFor(() =>
      expect(api.createRequirement).toHaveBeenCalledWith({
        organizationId: 'org-1',
        typeId: 'ty-cpr',
        employmentType: 'FULL_TIME',
        departmentId: null,
        positionId: null,
        note: 'All staff',
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Archive requirement Certification' }),
    );
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Archive requirement',
      }),
    );
    await waitFor(() => expect(api.archiveRequirement).toHaveBeenCalledWith('rq-1'));
  });

  it('creates a draft version, publishes it and tracks acknowledgements', async () => {
    auth(['document.policy.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ canManagePolicies: true })] });
    api.types.mockResolvedValue({ items: [] });
    const superseded = policyVersion({
      id: 'pv-1',
      versionNumber: 1,
      versionLabel: '2025',
      state: 'SUPERSEDED',
    });
    api.policies.mockResolvedValue({
      items: [policyOf({ versions: [policyVersion(), superseded] })],
    });
    api.policyTracking.mockResolvedValue({
      policy: policyOf(),
      currentVersionId: 'pv-2',
      counts: { audience: 2, acknowledged: 1, pending: 1 },
      items: [
        {
          employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
          status: 'ACKNOWLEDGED',
          acknowledgedAt: '2026-09-03T12:00:00.000Z',
        },
        {
          employee: { id: 'emp-2', employeeNumber: 'E-2', displayName: 'Alan Turing' },
          status: 'EARLIER_VERSION_ONLY',
          acknowledgedAt: null,
        },
      ],
    });
    api.createPolicyVersion.mockResolvedValue(policyOf());
    api.publishPolicyVersion.mockResolvedValue(policyOf());
    render(<DocumentsAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Policies' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Code of Conduct' }));
    const panel = screen.getByRole('region', { name: 'Policy Code of Conduct' });
    expect(within(panel).getByText('Superseded')).toBeInTheDocument();
    const tracking = within(panel).getByRole('region', { name: 'Acknowledgement tracking' });
    expect(
      await within(tracking).findByText(/1 of 2 acknowledged the current version · 1 pending/),
    ).toBeInTheDocument();
    expect(within(tracking).getByText('Earlier version only')).toBeInTheDocument();

    const form = within(panel).getByRole('form', { name: 'Create draft version' });
    fireEvent.change(within(form).getByLabelText('Version label'), { target: { value: '2027' } });
    fireEvent.change(within(form).getByLabelText('Link (https)'), {
      target: { value: 'https://docs.example.org/conduct-2027' },
    });
    fireEvent.change(within(form).getByLabelText('Acknowledgement statement'), {
      target: { value: 'I have read the 2027 Code of Conduct.' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create draft version' }));
    await waitFor(() =>
      expect(api.createPolicyVersion).toHaveBeenCalledWith('pol-1', {
        versionLabel: '2027',
        acknowledgementStatement: 'I have read the 2027 Code of Conduct.',
        effectiveOn: null,
        provider: 'EXTERNAL_URL',
        externalUrl: 'https://docs.example.org/conduct-2027',
        externalFileId: null,
        fileName: null,
      }),
    );

    api.policies.mockResolvedValue({
      items: [
        policyOf({
          versions: [
            policyVersion({
              id: 'pv-3',
              versionNumber: 3,
              versionLabel: '2027',
              state: 'DRAFT',
              publishedAt: null,
            }),
            policyVersion(),
          ],
        }),
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Publish 2027' }));
    await waitFor(() => expect(api.publishPolicyVersion).toHaveBeenCalledWith('pol-1', 'pv-3'));
    expect(
      await screen.findByText('Version published. Employees acknowledge it anew.'),
    ).toBeInTheDocument();
  });

  it('creates a policy', async () => {
    auth(['document.policy.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ canManagePolicies: true })] });
    api.types.mockResolvedValue({
      items: [typeOf({ id: 'ty-pol', code: 'POLICY', name: 'Policy' })],
    });
    api.policies.mockResolvedValue({ items: [] });
    api.createPolicy.mockResolvedValue(policyOf());
    render(<DocumentsAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Policies' }));
    fireEvent.click(await screen.findByRole('button', { name: 'New policy' }));
    const form = screen.getByRole('form', { name: 'Create policy' });
    fireEvent.change(within(form).getByLabelText('Policy code'), { target: { value: 'TECH' } });
    fireEvent.change(within(form).getByLabelText('Policy title'), {
      target: { value: 'Technology use' },
    });
    fireEvent.change(within(form).getByLabelText('Document type (optional)'), {
      target: { value: 'ty-pol' },
    });
    fireEvent.change(within(form).getByLabelText('Audience employment type'), {
      target: { value: 'FULL_TIME' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create policy' }));
    await waitFor(() =>
      expect(api.createPolicy).toHaveBeenCalledWith({
        organizationId: 'org-1',
        code: 'TECH',
        typeId: 'ty-pol',
        title: 'Technology use',
        description: null,
        acknowledgementRequired: true,
        audienceEmploymentType: 'FULL_TIME',
        audienceDepartmentId: null,
      }),
    );
  });

  it('shows the expiry dashboard for a chosen window and the missing dashboard', async () => {
    auth(['document.read']);
    api.organizations.mockResolvedValue({ items: [organization()] });
    api.types.mockResolvedValue({ items: [] });
    api.expiring.mockImplementation((_org: string, withinDays: number) =>
      Promise.resolve({
        today: '2026-10-06',
        withinDays,
        items: [
          {
            documentId: 'doc-1',
            title: 'CPR certificate',
            type: { id: 'ty-cpr', name: 'Certification' },
            employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
            expiresOn: '2026-10-20',
            expiryStatus: 'EXPIRING_SOON',
          },
        ],
        truncated: false,
      }),
    );
    api.missing.mockResolvedValue({
      today: '2026-10-06',
      items: [
        {
          employee: { id: 'emp-2', employeeNumber: 'E-2', displayName: 'Alan Turing' },
          missing: [{ typeId: 'ty-lic', typeName: 'Licence', status: 'MISSING' }],
        },
      ],
      truncated: true,
    });
    render(<DocumentsAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Expiring' }));
    expect(await screen.findByRole('link', { name: 'CPR certificate' })).toHaveAttribute(
      'href',
      '/documents/records/doc-1',
    );
    expect(api.expiring).toHaveBeenCalledWith('org-1', 30);
    fireEvent.change(screen.getByLabelText('Expiring within (days)'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(api.expiring).toHaveBeenCalledWith('org-1', 90));
    expect(await screen.findByText(/within 90 days of 10\/06\/2026/)).toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Missing' }));
    expect(await screen.findByRole('link', { name: 'Alan Turing' })).toHaveAttribute(
      'href',
      '/admin/employees/emp-2',
    );
    expect(screen.getByText('Licence')).toBeInTheDocument();
    expect(screen.getByText('Missing', { selector: 'span' })).toBeInTheDocument();
    // A capped list says so.
    expect(screen.getByRole('note')).toHaveTextContent(
      'Showing the first 1 results — narrow the filters to see more.',
    );
  });
});

describe('DocumentRecordPage', () => {
  const history = () =>
    documentOf({
      confidentiality: 'HR_ONLY',
      source: 'HR',
      currentVersion: versionOf({
        id: 'v-2',
        versionNumber: 2,
        expiresOn: '2028-10-01',
        expiryStatus: 'VALID',
      }),
      expiryStatus: 'VALID',
      versions: [
        versionOf({ id: 'v-2', versionNumber: 2, expiresOn: '2028-10-01', expiryStatus: 'VALID' }),
        versionOf({
          id: 'v-1',
          versionNumber: 1,
          externalUrl: 'javascript:alert(1)',
          current: false,
          supersededAt: '2026-10-01T12:00:00.000Z',
          expiryStatus: 'EXPIRED',
        }),
      ],
      actions: { canManage: true },
    });

  it('shows every version, marking superseded ones, and renders only https links', async () => {
    auth(['document.manage', 'document.confidential.read']);
    api.document.mockResolvedValue(history());
    render(<DocumentRecordPage documentId="doc-1" />);
    expect(await screen.findByRole('heading', { name: 'CPR certificate' })).toBeInTheDocument();
    expect(screen.getByText('HR only')).toBeInTheDocument();
    const v1 = screen.getByRole('row', { name: 'Version 1' });
    expect(within(v1).getByText(/Superseded/)).toBeInTheDocument();
    expect(within(v1).queryByRole('link')).not.toBeInTheDocument();
    const v2 = screen.getByRole('row', { name: 'Version 2' });
    expect(within(v2).getByText('Current')).toBeInTheDocument();
    const link = within(v2).getByRole('link', { name: 'Open version 2' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('adds a version, reclassifies and archives with a reason', async () => {
    auth(['document.manage', 'document.restricted.read']);
    api.document.mockResolvedValue(history());
    api.addVersion.mockResolvedValue(history());
    api.updateDocument.mockResolvedValue(history());
    api.archiveDocument.mockResolvedValue({
      ...history(),
      status: 'ARCHIVED',
      actions: { canManage: false },
    });
    render(<DocumentRecordPage documentId="doc-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add version' }));
    const add = screen.getByRole('form', { name: 'Add version to CPR certificate' });
    fireEvent.change(within(add).getByLabelText('Stored in'), {
      target: { value: 'MANUAL_REFERENCE' },
    });
    fireEvent.change(within(add).getByLabelText('File name'), {
      target: { value: 'cpr-3.pdf' },
    });
    fireEvent.change(within(add).getByLabelText('Expires on'), { target: { value: '2029-10-01' } });
    fireEvent.click(within(add).getByRole('button', { name: 'Save new version' }));
    await waitFor(() =>
      expect(api.addVersion).toHaveBeenCalledWith('doc-1', {
        provider: 'MANUAL_REFERENCE',
        externalUrl: null,
        externalFileId: null,
        fileName: 'cpr-3.pdf',
        issuedOn: null,
        effectiveOn: null,
        expiresOn: '2029-10-01',
        note: null,
      }),
    );
    expect(within(add).queryByLabelText('Storage key')).not.toBeInTheDocument();
    expect(await screen.findByText('New version added.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit or reclassify' }));
    const edit = screen.getByRole('form', { name: 'Edit document' });
    fireEvent.change(within(edit).getByLabelText('Confidentiality'), {
      target: { value: 'RESTRICTED' },
    });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.updateDocument).toHaveBeenCalledWith('doc-1', {
        title: 'CPR certificate',
        description: null,
        confidentiality: 'RESTRICTED',
      }),
    );
    expect(await screen.findByText('Document reclassified.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const archive = screen.getByRole('form', { name: 'Archive document' });
    expect(within(archive).getByRole('button', { name: 'Archive document' })).toBeDisabled();
    fireEvent.change(within(archive).getByLabelText('Reason for archiving'), {
      target: { value: 'Uploaded to the wrong employee' },
    });
    fireEvent.click(within(archive).getByRole('button', { name: 'Archive document' }));
    await waitFor(() =>
      expect(api.archiveDocument).toHaveBeenCalledWith('doc-1', 'Uploaded to the wrong employee'),
    );
    expect(await screen.findByText('Document archived.')).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add version' })).not.toBeInTheDocument();
  });

  it('shows not found for an unreachable document', async () => {
    api.document.mockRejectedValue(new AuthApiError('unexpected', 404));
    render(<DocumentRecordPage documentId="doc-x" />);
    expect(await screen.findByRole('heading', { name: 'Document not found' })).toBeInTheDocument();
  });
});

describe('EmployeeDocumentsSection', () => {
  const records = () => ({
    items: [
      {
        organization: { id: 'org-1', name: 'Camp' },
        access: { clearance: 2, canManage: true },
        documents: [documentOf({ actions: { canManage: true } })],
        acknowledgements: [
          {
            id: 'ack-1',
            policy: { id: 'pol-1', code: 'CONDUCT', title: 'Code of Conduct' },
            versionNumber: 2,
            versionLabel: '2026',
            acknowledgedAt: '2026-09-02T12:00:00.000Z',
            source: 'ONBOARDING_TASK' as const,
            current: true,
          },
        ],
        requirements: [
          {
            typeId: 'ty-lic',
            typeName: 'Licence',
            status: 'MISSING' as const,
            employeeProvided: true,
          },
        ],
      },
    ],
  });

  it('lists records, requirements and acknowledgements and creates a record', async () => {
    api.employeeRecords.mockResolvedValue(records());
    api.types.mockResolvedValue({
      items: [
        typeOf({
          id: 'ty-agr',
          code: 'EMPLOYMENT-AGREEMENT',
          name: 'Employment agreement',
          expiryTracked: false,
          defaultConfidentiality: 'EMPLOYEE_VISIBLE',
        }),
      ],
    });
    api.createDocument.mockResolvedValue(documentOf());
    // Batch 5C: the record can name one of the employee's assignments in this organization.
    const assignment = (id: string, organizationId: string, name: string, status = 'ACTIVE') => ({
      id,
      status,
      position: { id: `p-${id}`, name, code: name },
      organization: { id: organizationId, name: organizationId, code: organizationId },
    });
    mocks.employee.get.mockResolvedValue({
      id: 'emp-1',
      assignments: {
        current: [
          assignment('asg-1', 'org-1', 'Counsellor'),
          assignment('asg-x', 'org-2', 'Elsewhere'),
        ],
        upcoming: [],
        historical: [assignment('asg-0', 'org-1', 'Aide', 'ENDED')],
        cancelled: [],
      },
    });
    render(<EmployeeDocumentsSection employeeId="emp-1" />);
    expect(await screen.findByRole('link', { name: 'Open CPR certificate' })).toHaveAttribute(
      'href',
      '/documents/records/doc-1',
    );
    expect(api.employeeRecords).toHaveBeenCalledWith('emp-1');
    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByText('Missing')).toBeInTheDocument();
    expect(screen.getByText(/Code of Conduct — version 2026 \(current\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add document record' }));
    const form = screen.getByRole('form', { name: 'Add document record' });
    await waitFor(() => expect(within(form).getByLabelText('Document type')).toHaveValue('ty-agr'));
    fireEvent.change(within(form).getByLabelText('Title'), {
      target: { value: 'Signed employment agreement' },
    });
    const linked = await within(form).findByLabelText('Assignment (optional)');
    // Only this organization's assignments are offered.
    expect(Array.from((linked as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
      'The employee (no specific assignment)',
      'Counsellor',
      'Aide (ended)',
    ]);
    fireEvent.change(linked, { target: { value: 'asg-1' } });
    fireEvent.change(within(form).getByLabelText('Stored in'), {
      target: { value: 'MANUAL_REFERENCE' },
    });
    fireEvent.change(within(form).getByLabelText('Version note'), {
      target: { value: 'Filing cabinet B' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save record' }));
    await waitFor(() =>
      expect(api.createDocument).toHaveBeenCalledWith({
        organizationId: 'org-1',
        employeeId: 'emp-1',
        typeId: 'ty-agr',
        employmentAssignmentId: 'asg-1',
        title: 'Signed employment agreement',
        description: null,
        confidentiality: null,
        version: {
          provider: 'MANUAL_REFERENCE',
          externalUrl: null,
          externalFileId: null,
          fileName: null,
          issuedOn: null,
          effectiveOn: null,
          expiresOn: null,
          note: 'Filing cabinet B',
        },
      }),
    );
    expect(await screen.findByText('Document record added.')).toBeInTheDocument();
  });

  it('is hidden when the records are not accessible', async () => {
    api.employeeRecords.mockRejectedValue(new AuthApiError('forbidden', 403));
    const { container } = render(<EmployeeDocumentsSection employeeId="emp-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    cleanup();
    api.employeeRecords.mockRejectedValue(new AuthApiError('unexpected', 404));
    const again = render(<EmployeeDocumentsSection employeeId="emp-1" />);
    await waitFor(() => expect(again.container).toBeEmptyDOMElement());
  });
});

describe('ApplicationPage document hand-off', () => {
  const hiredApplication = {
    id: 'app-1',
    view: 'FULL',
    status: 'HIRED',
    source: 'DIRECT',
    sourceDetail: null,
    appliedAt: '2026-09-02T00:00:00.000Z',
    stageEnteredAt: '2026-09-10T00:00:00.000Z',
    stage: { id: 's-9', name: 'Hired', kind: 'HIRED' },
    organization: { id: 'org-1', name: 'Camp' },
    opening: {
      id: 'op-1',
      code: 'REQ-1',
      title: 'Camp Counsellor',
      status: 'OPEN',
      positionId: 'pos-1',
      employmentType: 'CASUAL',
    },
    candidate: {
      id: 'cand-1',
      organizationId: 'org-1',
      displayName: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      preferredName: null,
      status: 'ACTIVE',
      source: 'DIRECT',
      internal: false,
      internalEmployee: null,
      mergedIntoCandidateId: null,
      hired: true,
      email: null,
      phone: null,
      location: null,
      notes: null,
      createdAt: '2026-09-02T00:00:00.000Z',
    },
    interviews: [],
    documents: [
      {
        id: 'cd-1',
        candidateId: 'cand-1',
        applicationId: 'app-1',
        kind: 'RESUME',
        title: 'Ada résumé',
        provider: 'EXTERNAL_URL',
        externalUrl: 'https://example.org/ada.pdf',
        externalFileId: null,
        fileName: null,
        mimeType: null,
        addedAt: '2026-09-02T00:00:00.000Z',
        removedAt: null,
      },
      {
        id: 'cd-2',
        candidateId: 'cand-1',
        applicationId: 'app-1',
        kind: 'CERTIFICATE',
        title: 'First aid',
        provider: 'EXTERNAL_URL',
        externalUrl: 'https://example.org/first-aid.pdf',
        externalFileId: null,
        fileName: null,
        mimeType: null,
        addedAt: '2026-09-02T00:00:00.000Z',
        removedAt: null,
      },
    ],
    dispositionReason: null,
    dispositionAt: null,
    transitions: [],
    activity: [],
    hire: {
      id: 'hire-1',
      personId: 'p-1',
      employeeId: 'emp-9',
      employmentAssignmentId: 'asg-9',
      compensationRecordId: null,
      internalCandidate: false,
      createdEmployee: true,
      convertedByUserId: 'u-1',
      convertedAt: '2026-10-06T00:00:00.000Z',
    },
    screening: null,
    offers: [],
    actions: {
      canManage: false,
      canMoveStage: false,
      canScreen: false,
      canScheduleInterview: false,
      canWithdraw: false,
      canReject: false,
      canCreateOffer: false,
      canApproveOffer: false,
      canHire: false,
    },
  } as unknown as ApplicationDetail;

  const types = [
    typeOf({ id: 'ty-res', code: 'RESUME', name: 'Résumé' }),
    typeOf({ id: 'ty-cert', code: 'CERTIFICATION', name: 'Certification' }),
    typeOf({ id: 'ty-offer', code: 'OFFER-LETTER', name: 'Offer letter' }),
    typeOf({ id: 'ty-other', code: 'OTHER', name: 'Other' }),
  ];

  it('moves selected documents and the offer, showing what was already moved', async () => {
    auth(['recruitment.manage', 'document.manage']);
    mocks.recruitment.application.mockResolvedValue(hiredApplication);
    api.types.mockResolvedValue({ items: types });
    api.employeeRecords.mockResolvedValue({
      items: [
        {
          organization: { id: 'org-1', name: 'Camp' },
          access: { clearance: 2, canManage: true },
          documents: [
            documentOf({
              id: 'doc-res',
              source: 'RECRUITMENT_HANDOFF',
              provenance: { recruitmentHireId: 'hire-1', recruitmentDocumentId: 'cd-1' },
            }),
          ],
          acknowledgements: [],
          requirements: [],
        },
      ],
    });
    api.handoff.mockResolvedValue({
      outcomes: [
        { recruitmentDocumentId: 'cd-2', documentId: 'doc-cert', outcome: 'CREATED' },
        { recruitmentDocumentId: null, documentId: 'doc-offer', outcome: 'ALREADY_HANDED_OFF' },
      ],
    });
    render(<ApplicationPage applicationId="app-1" />);
    const panel = await screen.findByRole('region', { name: 'Move documents to employee record' });
    await waitFor(() => expect(api.types).toHaveBeenCalledWith('org-1'));
    expect(
      await within(panel).findByRole('link', { name: 'Already moved — open record' }),
    ).toHaveAttribute('href', '/documents/records/doc-res');
    const move = within(panel).getByRole('button', { name: 'Move to employee record' });
    expect(move).toBeDisabled();
    fireEvent.click(within(panel).getByLabelText(/First aid/));
    expect(within(panel).getByLabelText('Record type for First aid')).toHaveValue('ty-cert');
    fireEvent.click(within(panel).getByLabelText('Also record the accepted offer'));
    expect(within(panel).getByLabelText('Offer letter type')).toHaveValue('ty-offer');
    fireEvent.click(move);
    await waitFor(() =>
      expect(api.handoff).toHaveBeenCalledWith('hire-1', {
        documents: [{ recruitmentDocumentId: 'cd-2', typeId: 'ty-cert' }],
        offer: { typeId: 'ty-offer' },
      }),
    );
    expect(
      await within(panel).findByText(/1 moved to the employee record, 1 already moved earlier\./),
    ).toBeInTheDocument();
  });

  it('is hidden without document.manage and explains a refusal', async () => {
    auth(['recruitment.manage']);
    mocks.recruitment.application.mockResolvedValue(hiredApplication);
    render(<ApplicationPage applicationId="app-1" />);
    await screen.findByRole('region', { name: 'Hired' });
    expect(
      screen.queryByRole('region', { name: 'Move documents to employee record' }),
    ).not.toBeInTheDocument();
    expect(api.types).not.toHaveBeenCalled();
    cleanup();

    auth(['document.manage']);
    api.types.mockResolvedValue({ items: types });
    api.employeeRecords.mockRejectedValue(new AuthApiError('forbidden', 403));
    api.handoff.mockRejectedValue(
      new AuthApiError('validation', 400, 'x', { code: 'DOCUMENT_HANDOFF_INVALID' }),
    );
    render(<ApplicationPage applicationId="app-1" />);
    const panel = await screen.findByRole('region', { name: 'Move documents to employee record' });
    await waitFor(() => expect(api.types).toHaveBeenCalled());
    fireEvent.click(await within(panel).findByLabelText(/Ada résumé/));
    fireEvent.click(within(panel).getByRole('button', { name: 'Move to employee record' }));
    expect(
      await within(panel).findByText('Only current documents of the hired candidate can be moved.'),
    ).toBeInTheDocument();
  });
});

describe('Onboarding template editor document references', () => {
  const onboardingOrg = {
    id: 'org-1',
    name: 'Camp',
    code: 'CAMP',
    timezone: 'America/Toronto',
    actions: { canManageTemplates: true, onboarding: false, offboarding: false },
  };

  it('picks a policy and a document type from the documents lists', async () => {
    auth(['onboarding.template.manage']);
    mocks.onboarding.organizations.mockResolvedValue({ items: [onboardingOrg] });
    mocks.onboarding.templates.mockResolvedValue({ items: [] });
    mocks.onboarding.createTemplate.mockResolvedValue({});
    api.policies.mockResolvedValue({ items: [policyOf()] });
    api.types.mockResolvedValue({ items: [typeOf()] });
    render(<OnboardingAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    const form = screen.getByRole('form', { name: 'Create template' });
    fireEvent.change(within(form).getByLabelText('Template code'), { target: { value: 'STAFF' } });
    fireEvent.change(within(form).getByLabelText('Template name'), { target: { value: 'Staff' } });
    const first = within(form).getByRole('group', { name: 'Task 1' });
    fireEvent.change(within(first).getByLabelText('Title'), {
      target: { value: 'Code of Conduct' },
    });
    expect(api.policies).not.toHaveBeenCalled();
    fireEvent.change(within(first).getByLabelText('Reference type'), {
      target: { value: 'POLICY_DOCUMENT' },
    });
    expect(within(first).queryByLabelText('Reference link (https)')).not.toBeInTheDocument();
    fireEvent.change(await within(first).findByLabelText('Policy'), { target: { value: 'pol-1' } });
    expect(within(first).getByLabelText('Reference label')).toHaveValue('Code of Conduct');
    expect(within(first).getByLabelText('Acknowledgement required')).toBeChecked();
    fireEvent.change(within(first).getByLabelText('Acknowledgement statement'), {
      target: { value: 'I have read the Code of Conduct.' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add task' }));
    const second = within(form).getByRole('group', { name: 'Task 2' });
    fireEvent.change(within(second).getByLabelText('Title'), { target: { value: 'CPR' } });
    fireEvent.change(within(second).getByLabelText('Reference type'), {
      target: { value: 'DOCUMENT_TYPE' },
    });
    fireEvent.change(within(second).getByLabelText('Document type'), {
      target: { value: 'ty-cpr' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(mocks.onboarding.createTemplate).toHaveBeenCalled());
    const tasks = mocks.onboarding.createTemplate.mock.calls[0]![0].tasks;
    expect(tasks[0]).toMatchObject({
      ownerType: 'EMPLOYEE',
      acknowledgementRequired: true,
      referenceType: 'POLICY_DOCUMENT',
      referenceUrl: null,
      referenceExternalId: 'pol-1',
      referenceLabel: 'Code of Conduct',
    });
    expect(tasks[1]).toMatchObject({
      ownerType: 'EMPLOYEE',
      acknowledgementRequired: false,
      referenceType: 'DOCUMENT_TYPE',
      referenceExternalId: 'ty-cpr',
      referenceLabel: 'Certification',
    });
    expect(api.policies).toHaveBeenCalledTimes(1);
  });

  it('falls back to typing the id when the documents lists cannot be loaded', async () => {
    auth(['onboarding.template.manage']);
    mocks.onboarding.organizations.mockResolvedValue({ items: [onboardingOrg] });
    mocks.onboarding.templates.mockResolvedValue({ items: [] });
    api.policies.mockRejectedValue(new AuthApiError('forbidden', 403));
    api.types.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<OnboardingAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    const first = screen.getByRole('group', { name: 'Task 1' });
    fireEvent.change(within(first).getByLabelText('Reference type'), {
      target: { value: 'POLICY_DOCUMENT' },
    });
    const input = await within(first).findByLabelText('Policy ID');
    fireEvent.change(input, { target: { value: 'pol-typed' } });
    expect(input).toHaveValue('pol-typed');
    fireEvent.change(within(first).getByLabelText('Reference type'), {
      target: { value: 'DOCUMENT_TYPE' },
    });
    expect(await within(first).findByLabelText('Document type ID')).toHaveValue('');
  });
});
