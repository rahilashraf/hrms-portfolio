import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type {
  DocumentRequirement,
  DocumentType,
  DocumentVersion,
  DocumentsOrganization,
  EmployeeDocument,
  Policy,
  StoredFile,
  UploadCapability,
} from '../../lib/documents/types';
import { DocumentRecordPage } from './document-record-page';
import { DocumentsAdminPage } from './documents-admin-page';
import { fileProblem, formatBytes } from './documents-shared';
import { MyDocumentsPage } from './my-documents-page';

/**
 * Batch 9 — uploads, downloads and the D10 lifecycle in the web: files are uploaded first
 * (with progress) and attached by id, a failed save is retried without uploading again,
 * downloads ask for a fresh short-lived link each time and never show it, quarantined and
 * legacy files are explained, requirements are replaced (with history) through named pickers,
 * archived types are reactivated and retired policies copied — with confirmations.
 */
const mocks = vi.hoisted(() => ({
  api: {
    organizations: vi.fn(),
    mine: vi.fn(),
    myPolicies: vi.fn(),
    provide: vi.fn(),
    types: vi.fn(),
    archiveType: vi.fn(),
    reactivateType: vi.fn(),
    requirements: vi.fn(),
    createRequirement: vi.fn(),
    archiveRequirement: vi.fn(),
    replaceRequirement: vi.fn(),
    document: vi.fn(),
    updateDocument: vi.fn(),
    addVersion: vi.fn(),
    archiveDocument: vi.fn(),
    policies: vi.fn(),
    policyTracking: vi.fn(),
    copyPolicy: vi.fn(),
    createPolicyVersion: vi.fn(),
    upload: vi.fn(),
    versionDownload: vi.fn(),
    policyVersionDownload: vi.fn(),
    options: vi.fn(),
  },
  startDownload: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock('../../lib/documents/api', () => ({
  documentsApi: mocks.api,
  startDownload: mocks.startDownload,
}));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const api = mocks.api;
const auth = (keys: string[]) =>
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] })),
    },
  });

const UPLOADS: UploadCapability = {
  enabled: true,
  maxBytes: 10 * 1024 * 1024,
  allowedTypes: ['application/pdf', 'image/png', 'image/jpeg'],
};

const storedFile = (overrides: Partial<StoredFile> = {}): StoredFile => ({
  fileName: 'agreement.pdf',
  sizeBytes: 182_000,
  mimeType: 'application/pdf',
  scanStatus: 'NOT_SCANNED',
  downloadable: true,
  ...overrides,
});

const versionOf = (overrides: Partial<DocumentVersion> = {}): DocumentVersion => ({
  id: 'v-2',
  versionNumber: 2,
  provider: 'INTERNAL_OBJECT_STORAGE',
  externalUrl: null,
  fileName: 'agreement.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 182_000,
  file: storedFile(),
  legacyReference: false,
  issuedOn: null,
  effectiveOn: null,
  expiresOn: null,
  expiryStatus: 'NO_EXPIRY',
  note: null,
  referenceStatus: 'UNKNOWN',
  current: true,
  supersededAt: null,
  createdAt: '2026-11-01T12:00:00.000Z',
  ...overrides,
});

const documentOf = (versions: DocumentVersion[], canManage = true): EmployeeDocument => ({
  id: 'doc-1',
  organizationId: 'org-1',
  employeeId: 'emp-1',
  employmentAssignmentId: null,
  type: {
    id: 'ty-1',
    code: 'EMPLOYMENT-AGREEMENT',
    name: 'Employment agreement',
    category: 'EMPLOYMENT_AGREEMENT',
    expiryTracked: false,
  },
  title: 'Employment agreement',
  description: null,
  confidentiality: 'HR_ONLY',
  status: 'ACTIVE',
  source: 'HR',
  provenance: null,
  archivedAt: null,
  currentVersion: versions.find((v) => v.current) ?? null,
  expiryStatus: 'NO_EXPIRY',
  versions,
  createdAt: '2026-11-01T12:00:00.000Z',
  actions: { canManage },
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
    canManageRecords: true,
    ...overrides,
  },
});

const typeOf = (overrides: Partial<DocumentType> = {}): DocumentType => ({
  id: 'ty-lic',
  organizationId: 'org-1',
  code: 'LICENSE',
  name: 'Licence',
  description: null,
  category: 'LICENSE',
  defaultConfidentiality: 'HR_ONLY',
  expiryTracked: false,
  employeeProvided: true,
  archivedAt: null,
  ...overrides,
});

const pdf = (name = 'renewal.pdf', size = 2048) =>
  new File([new Uint8Array(size)], name, { type: 'application/pdf' });

const chooseFile = (form: HTMLElement, file: File) =>
  fireEvent.change(within(form).getByLabelText('File'), { target: { files: [file] } });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mocks.startDownload.mockReset();
  mocks.useAuth.mockReset();
  auth(['document.manage', 'document.restricted.read']);
  api.organizations.mockResolvedValue({ items: [organization()], uploads: UPLOADS });
});

// Batch 10E-2: tab clicks now write the section into the URL (#hash); every test starts from a
// clean address so one test's tab does not open the next.
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('Batch 9 files: client checks', () => {
  it('refuses other types, empty and oversized files before uploading', () => {
    expect(fileProblem(pdf('a.pdf'), UPLOADS)).toBeNull();
    expect(fileProblem(pdf('scan.JPEG'), UPLOADS)).toBeNull();
    expect(fileProblem(pdf('notes.docx'), UPLOADS)).toBe(
      'Only PDF, PNG and JPEG files can be uploaded.',
    );
    expect(fileProblem(pdf('empty.pdf', 0), UPLOADS)).toBe('The file is empty.');
    expect(fileProblem(pdf('big.pdf', 11 * 1024 * 1024), UPLOADS)).toBe(
      'The file is 11 MB; the limit is 10 MB.',
    );
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});

describe('Batch 9 files: record downloads', () => {
  it('downloads through a fresh link each time and never shows the link or a storage key', async () => {
    api.document.mockResolvedValue(
      documentOf([
        versionOf(),
        versionOf({
          id: 'v-1',
          versionNumber: 1,
          current: false,
          supersededAt: '2026-11-02T12:00:00.000Z',
          file: storedFile({ fileName: 'agreement-old.pdf', scanStatus: 'CLEAN' }),
        }),
      ]),
    );
    const link = {
      url: '/documents/files/secret-token.mac',
      expiresAt: '2026-11-08T12:01:00.000Z',
      fileName: 'agreement-old.pdf',
    };
    api.versionDownload.mockResolvedValue(link);
    const { container } = render(<DocumentRecordPage documentId="doc-1" />);
    const old = await screen.findByRole('row', { name: 'Version 1' });
    expect(
      within(old).getByText(/agreement-old\.pdf · .* · PDF · Scanned: no malware found/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Not scanned/).length).toBeGreaterThan(0);
    fireEvent.click(
      within(old).getByRole('button', {
        name: 'Download Employment agreement, version 1 (agreement-old.pdf)',
      }),
    );
    await waitFor(() => expect(mocks.startDownload).toHaveBeenCalledWith(link));
    expect(api.versionDownload).toHaveBeenCalledWith('doc-1', 'v-1');
    fireEvent.click(
      within(old).getByRole('button', {
        name: 'Download Employment agreement, version 1 (agreement-old.pdf)',
      }),
    );
    await waitFor(() => expect(api.versionDownload).toHaveBeenCalledTimes(2));
    expect(container.innerHTML).not.toContain('secret-token');
    expect(container.innerHTML).not.toMatch(/documents\/org|storage key/i);
  });

  it('explains quarantined, blocked, legacy and refused files', async () => {
    api.document.mockResolvedValue(
      documentOf([
        versionOf({ file: storedFile({ scanStatus: 'PENDING', downloadable: false }) }),
        versionOf({
          id: 'v-1',
          versionNumber: 1,
          current: false,
          file: storedFile({ scanStatus: 'INFECTED', downloadable: false }),
        }),
        versionOf({
          id: 'v-0',
          versionNumber: 0,
          current: false,
          file: null,
          legacyReference: true,
          fileName: 'old.pdf',
        }),
      ]),
    );
    render(<DocumentRecordPage documentId="doc-1" />);
    await screen.findByRole('row', { name: 'Version 2' });
    expect(
      within(screen.getByRole('row', { name: 'Version 2' })).getByText(
        'This file cannot be downloaded until its malware scan is complete.',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: 'Version 1' })).getByText(
        'This file was blocked by the malware scan and cannot be downloaded.',
      ),
    ).toBeInTheDocument();
    const legacy = screen.getByRole('row', { name: 'Version 0' });
    expect(within(legacy).getByText(/not available for download/)).toBeInTheDocument();
    expect(within(legacy).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /^Download/ })).toHaveLength(0);
  });

  it('shows why a download was refused', async () => {
    api.document.mockResolvedValue(documentOf([versionOf()]));
    api.versionDownload.mockRejectedValue(
      new AuthApiError('conflict', 409, 'x', { code: 'DOCUMENT_FILE_QUARANTINED' }),
    );
    render(<DocumentRecordPage documentId="doc-1" />);
    const row = await screen.findByRole('row', { name: 'Version 2' });
    fireEvent.click(within(row).getByRole('button', { name: /^Download/ }));
    expect(
      await within(row).findByText(
        'The file is waiting for its malware scan and cannot be downloaded yet.',
      ),
    ).toHaveAttribute('role', 'alert');
    expect(mocks.startDownload).not.toHaveBeenCalled();
  });
});

describe('Batch 9 files: uploading versions', () => {
  const openForm = async () => {
    api.document.mockResolvedValue(documentOf([versionOf()]));
    render(<DocumentRecordPage documentId="doc-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add version' }));
    const form = screen.getByRole('form', { name: 'Add version to Employment agreement' });
    await waitFor(() =>
      expect(within(form).getByLabelText('Stored in')).toHaveValue('INTERNAL_OBJECT_STORAGE'),
    );
    return form;
  };

  it('uploads first, then attaches the upload; a retried save does not upload again', async () => {
    const form = await openForm();
    expect(within(form).queryByLabelText('Storage key')).not.toBeInTheDocument();
    api.upload.mockImplementation(async (_target, _file, options) => {
      options.onProgress?.(512, 1024);
      return {
        id: 'up-1',
        fileName: 'renewal.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
        scanStatus: 'NOT_SCANNED',
      };
    });
    api.addVersion
      .mockRejectedValueOnce(new AuthApiError('service-unavailable', 503, undefined, {}))
      .mockResolvedValueOnce(documentOf([versionOf()]));
    const file = pdf();
    chooseFile(form, file);
    expect(within(form).getByText(/renewal\.pdf · 2 KB · PDF/)).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save new version' }));
    expect(
      await screen.findByText('The Documents service is unavailable. Please try again.'),
    ).toBeInTheDocument();
    expect(api.upload).toHaveBeenCalledWith(
      { kind: 'version', documentId: 'doc-1' },
      file,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByText('New version added.')).toBeInTheDocument();
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.addVersion).toHaveBeenLastCalledWith('doc-1', {
      provider: 'INTERNAL_OBJECT_STORAGE',
      uploadId: 'up-1',
      issuedOn: null,
      effectiveOn: null,
      expiresOn: null,
      note: null,
    });
  });

  it('uploads again when the server no longer accepts the earlier upload', async () => {
    const form = await openForm();
    api.upload.mockResolvedValueOnce({ id: 'up-1' }).mockResolvedValueOnce({ id: 'up-2' });
    api.addVersion
      .mockRejectedValueOnce(
        new AuthApiError('conflict', 409, 'x', { code: 'DOCUMENT_UPLOAD_EXPIRED' }),
      )
      .mockResolvedValueOnce(documentOf([versionOf()]));
    chooseFile(form, pdf());
    fireEvent.click(within(form).getByRole('button', { name: 'Save new version' }));
    expect(
      await screen.findByText('The upload expired before it was saved. Choose the file again.'),
    ).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save new version' }));
    await waitFor(() =>
      expect(api.addVersion).toHaveBeenLastCalledWith(
        'doc-1',
        expect.objectContaining({ uploadId: 'up-2' }),
      ),
    );
    expect(api.upload).toHaveBeenCalledTimes(2);
  });

  it('refuses a disallowed file without uploading and explains server refusals', async () => {
    const form = await openForm();
    chooseFile(form, pdf('notes.docx'));
    fireEvent.click(within(form).getByRole('button', { name: 'Save new version' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Only PDF, PNG and JPEG files can be uploaded.',
    );
    expect(api.upload).not.toHaveBeenCalled();

    api.upload.mockRejectedValue(
      new AuthApiError('unexpected', 415, undefined, { code: 'DOCUMENT_FILE_TYPE_MISMATCH' }),
    );
    chooseFile(form, pdf('photo.png'));
    fireEvent.click(within(form).getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByText(/extension does not match its contents/)).toBeInTheDocument();
    expect(api.addVersion).not.toHaveBeenCalled();
  });

  it('reports a cancelled upload and saves nothing', async () => {
    const form = await openForm();
    api.upload.mockRejectedValue(new DOMException('cancelled', 'AbortError'));
    chooseFile(form, pdf());
    fireEvent.click(within(form).getByRole('button', { name: 'Save new version' }));
    expect(
      await screen.findByText('The upload was cancelled. Nothing was saved.'),
    ).toBeInTheDocument();
    expect(api.addVersion).not.toHaveBeenCalled();
  });

  it('offers links only when uploads are not available', async () => {
    api.organizations.mockResolvedValue({
      items: [organization()],
      uploads: { ...UPLOADS, enabled: false },
    });
    api.document.mockResolvedValue(documentOf([versionOf()]));
    render(<DocumentRecordPage documentId="doc-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add version' }));
    const form = screen.getByRole('form', { name: 'Add version to Employment agreement' });
    await waitFor(() => expect(api.organizations).toHaveBeenCalled());
    const options = within(within(form).getByLabelText('Stored in'))
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'));
    expect(options).not.toContain('INTERNAL_OBJECT_STORAGE');
  });
});

describe('Batch 9 files: self-service', () => {
  it('uploads to the employee’s own organization and provides the document', async () => {
    auth([]);
    api.mine.mockResolvedValue({
      items: [
        {
          organization: { id: 'org-1', name: 'Camp' },
          documents: [],
          missing: [{ typeId: 'ty-lic', typeName: 'Licence', status: 'MISSING' }],
          providableTypes: [typeOf()],
        },
      ],
    });
    api.myPolicies.mockResolvedValue({ items: [] });
    api.upload.mockResolvedValue({ id: 'up-9' });
    api.provide.mockResolvedValue({});
    render(<MyDocumentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Provide/ }));
    const form = await screen.findByRole('form', { name: 'Provide a document' });
    await waitFor(() =>
      expect(within(form).getByLabelText('Stored in')).toHaveValue('INTERNAL_OBJECT_STORAGE'),
    );
    const file = pdf('licence.pdf');
    chooseFile(form, file);
    fireEvent.click(within(form).getByRole('button', { name: 'Save document' }));
    await waitFor(() =>
      expect(api.provide).toHaveBeenCalledWith({
        organizationId: 'org-1',
        typeId: 'ty-lic',
        title: 'Licence',
        version: expect.objectContaining({ provider: 'INTERNAL_OBJECT_STORAGE', uploadId: 'up-9' }),
      }),
    );
    expect(api.upload).toHaveBeenCalledWith(
      { kind: 'self', organizationId: 'org-1' },
      file,
      expect.anything(),
    );
  });
});

describe('Batch 9 D10: types, requirements and policies', () => {
  const requirement = (overrides: Partial<DocumentRequirement> = {}): DocumentRequirement => ({
    id: 'rq-1',
    typeId: 'ty-lic',
    typeName: 'Licence',
    employmentType: 'FULL_TIME',
    departmentId: '11111111-1111-4111-8111-111111111111',
    departmentName: 'Aquatics',
    positionId: null,
    positionName: null,
    note: 'Drivers',
    archivedAt: null,
    ...overrides,
  });

  it('reactivates an archived type after confirmation', async () => {
    auth(['document.type.manage']);
    api.organizations.mockResolvedValue({
      items: [organization({ canManageTypes: true })],
      uploads: UPLOADS,
    });
    api.types.mockResolvedValue({
      items: [typeOf({ archivedAt: '2026-10-01T12:00:00.000Z' })],
    });
    api.reactivateType.mockResolvedValue(typeOf());
    render(<DocumentsAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate Licence' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Reactivate this document type?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reactivate type' }));
    await waitFor(() => expect(api.reactivateType).toHaveBeenCalledWith('ty-lic'));
    expect(await screen.findByText('Document type reactivated.')).toBeInTheDocument();
  });

  it('shows requirements by name, replaces one with history and never asks for raw ids', async () => {
    auth(['document.type.manage']);
    api.organizations.mockResolvedValue({
      items: [organization({ canManageTypes: true })],
      uploads: UPLOADS,
    });
    api.types.mockResolvedValue({ items: [typeOf()] });
    api.requirements.mockResolvedValue({ items: [requirement()] });
    api.replaceRequirement.mockResolvedValue({
      previous: requirement({ archivedAt: '2026-11-08T12:00:00.000Z' }),
      requirement: requirement({ id: 'rq-2', employmentType: 'PART_TIME' }),
    });
    const { container } = render(<DocumentsAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Requirements' }));
    expect(await screen.findByText('Full Time · Department Aquatics')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('11111111-1111');
    expect(screen.queryByLabelText('Department ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Position ID')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Change requirement Licence' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change requirement: Licence' });
    expect(within(dialog).getByRole('button', { name: 'Replace requirement' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Employment type'), {
      target: { value: 'PART_TIME' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace requirement' }));
    await waitFor(() =>
      expect(api.replaceRequirement).toHaveBeenCalledWith('rq-1', {
        employmentType: 'PART_TIME',
        departmentId: '11111111-1111-4111-8111-111111111111',
        positionId: null,
        note: 'Drivers',
      }),
    );
    expect(
      await screen.findByText('Requirement replaced. The previous version is kept in the history.'),
    ).toBeInTheDocument();

    fireEvent.click(await screen.findByLabelText('Show archived requirements (history)'));
    await waitFor(() => expect(api.requirements).toHaveBeenLastCalledWith('org-1', true));
  });

  it('copies a retired policy into a new draft and never un-retires it', async () => {
    auth(['document.policy.manage']);
    api.organizations.mockResolvedValue({
      items: [organization({ canManagePolicies: true })],
      uploads: UPLOADS,
    });
    api.types.mockResolvedValue({ items: [] });
    const retired: Policy = {
      id: 'pol-1',
      organizationId: 'org-1',
      code: 'CONDUCT',
      title: 'Code of Conduct',
      description: null,
      typeId: null,
      status: 'RETIRED',
      acknowledgementRequired: true,
      audience: { employmentType: null, departmentId: 'd-1', departmentName: 'Aquatics' },
      currentVersion: null,
      versions: [],
      retiredAt: '2026-10-01T12:00:00.000Z',
    };
    api.policies.mockResolvedValue({ items: [retired] });
    api.policyTracking.mockResolvedValue({
      policy: retired,
      currentVersionId: null,
      counts: { audience: 0, acknowledged: 0, pending: 0 },
      items: [],
    });
    api.copyPolicy.mockResolvedValue({ ...retired, id: 'pol-2', code: 'CONDUCT-2027' });
    render(<DocumentsAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Policies' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Code of Conduct' }));
    const panel = await screen.findByRole('region', { name: 'Policy Code of Conduct' });
    expect(within(panel).getByText(/Department Aquatics/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Retire/ })).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Copy into a new draft' }));
    const form = within(panel).getByRole('form', { name: 'Copy Code of Conduct' });
    fireEvent.change(within(form).getByLabelText('New policy code'), {
      target: { value: 'CONDUCT-2027' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create draft copy' }));
    await waitFor(() =>
      expect(api.copyPolicy).toHaveBeenCalledWith('pol-1', { code: 'CONDUCT-2027' }),
    );
    expect(
      await screen.findByText(
        'Copied into the draft policy CONDUCT-2027. Add a version and publish it when ready.',
      ),
    ).toBeInTheDocument();
  });

  it('uploads a policy version file and downloads published versions', async () => {
    auth(['document.policy.manage']);
    api.organizations.mockResolvedValue({
      items: [organization({ canManagePolicies: true })],
      uploads: UPLOADS,
    });
    api.types.mockResolvedValue({ items: [] });
    const published = {
      id: 'pv-1',
      versionNumber: 1,
      versionLabel: '2026',
      provider: 'INTERNAL_OBJECT_STORAGE' as const,
      externalUrl: null,
      fileName: 'conduct.pdf',
      mimeType: 'application/pdf',
      file: storedFile({ fileName: 'conduct.pdf' }),
      legacyReference: false,
      acknowledgementStatement: 'I have read it.',
      effectiveOn: null,
      state: 'CURRENT' as const,
      publishedAt: '2026-11-01T12:00:00.000Z',
      supersededAt: null,
      referenceStatus: 'UNKNOWN' as const,
    };
    const policy: Policy = {
      id: 'pol-1',
      organizationId: 'org-1',
      code: 'CONDUCT',
      title: 'Code of Conduct',
      description: null,
      typeId: null,
      status: 'PUBLISHED',
      acknowledgementRequired: true,
      audience: { employmentType: null, departmentId: null },
      currentVersion: published,
      versions: [published],
      retiredAt: null,
    };
    api.policies.mockResolvedValue({ items: [policy] });
    api.policyTracking.mockResolvedValue({
      policy,
      currentVersionId: 'pv-1',
      counts: { audience: 0, acknowledged: 0, pending: 0 },
      items: [],
    });
    api.policyVersionDownload.mockResolvedValue({
      url: 'https://s3/x',
      expiresAt: '',
      fileName: 'conduct.pdf',
    });
    api.upload.mockResolvedValue({ id: 'up-p' });
    api.createPolicyVersion.mockResolvedValue(policy);
    render(<DocumentsAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Policies' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open Code of Conduct' }));
    const panel = await screen.findByRole('region', { name: 'Policy Code of Conduct' });
    fireEvent.click(within(panel).getByRole('button', { name: /^Download Code of Conduct 2026/ }));
    await waitFor(() => expect(api.policyVersionDownload).toHaveBeenCalledWith('pol-1', 'pv-1'));
    expect(mocks.startDownload).toHaveBeenCalled();

    const draft = within(panel).getByRole('form', { name: 'Create draft version' });
    await waitFor(() =>
      expect(within(draft).getByLabelText('Stored in')).toHaveValue('INTERNAL_OBJECT_STORAGE'),
    );
    fireEvent.change(within(draft).getByLabelText('Version label'), { target: { value: '2027' } });
    fireEvent.change(within(draft).getByLabelText('Acknowledgement statement'), {
      target: { value: 'I have read the 2027 code.' },
    });
    const file = pdf('conduct-2027.pdf');
    chooseFile(draft, file);
    fireEvent.click(within(draft).getByRole('button', { name: 'Create draft version' }));
    await waitFor(() =>
      expect(api.createPolicyVersion).toHaveBeenCalledWith('pol-1', {
        versionLabel: '2027',
        acknowledgementStatement: 'I have read the 2027 code.',
        effectiveOn: null,
        provider: 'INTERNAL_OBJECT_STORAGE',
        uploadId: 'up-p',
      }),
    );
    expect(api.upload).toHaveBeenCalledWith(
      { kind: 'policy', policyId: 'pol-1' },
      file,
      expect.anything(),
    );
  });
});
