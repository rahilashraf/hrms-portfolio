import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import { documentsApi, startDownload } from './api';
import {
  currentPolicyVersionId,
  documentsErrorCode,
  documentsErrorMessage,
  isDocumentsForbidden,
  isDocumentsNotFound,
} from './errors';

const { apiRequest, apiUpload } = vi.hoisted(() => ({ apiRequest: vi.fn(), apiUpload: vi.fn() }));

vi.mock('../auth/api-client', () => ({ apiRequest, apiUpload }));
vi.mock('../api-config', () => ({ getApiBaseUrl: () => 'https://api.example.test' }));

beforeEach(() => {
  apiRequest.mockClear();
  apiRequest.mockResolvedValue({});
});

const calls = () =>
  apiRequest.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET', call[1]?.body]);

const version = { provider: 'EXTERNAL_URL' as const, externalUrl: 'https://x.test/a' };

describe('documentsApi', () => {
  it('maps organization, self-service, type and requirement routes', async () => {
    await documentsApi.organizations();
    await documentsApi.mine();
    await documentsApi.myPolicies();
    await documentsApi.provide({ organizationId: 'org-1', typeId: 'ty-1', title: 'CPR', version });
    await documentsApi.types('org-1');
    await documentsApi.types('org-1', true);
    await documentsApi.createType({
      organizationId: 'org-1',
      code: 'FIRST-AID',
      name: 'First aid',
      category: 'CERTIFICATION',
      defaultConfidentiality: 'MANAGER_VISIBLE',
    });
    await documentsApi.initializeTypes('org-1');
    await documentsApi.updateType('ty/1', { name: 'First aid 2' });
    await documentsApi.archiveType('ty-1');
    await documentsApi.requirements('org-1');
    await documentsApi.createRequirement({ organizationId: 'org-1', typeId: 'ty-1' });
    await documentsApi.archiveRequirement('rq-1');
    expect(calls()).toEqual([
      ['/documents/organizations', 'GET', undefined],
      ['/documents/me', 'GET', undefined],
      ['/documents/me/policies', 'GET', undefined],
      [
        '/documents/me/provide',
        'POST',
        JSON.stringify({ organizationId: 'org-1', typeId: 'ty-1', title: 'CPR', version }),
      ],
      ['/documents/types?organizationId=org-1', 'GET', undefined],
      ['/documents/types?organizationId=org-1&includeArchived=true', 'GET', undefined],
      [
        '/documents/types',
        'POST',
        JSON.stringify({
          organizationId: 'org-1',
          code: 'FIRST-AID',
          name: 'First aid',
          category: 'CERTIFICATION',
          defaultConfidentiality: 'MANAGER_VISIBLE',
        }),
      ],
      ['/documents/types/initialize', 'POST', JSON.stringify({ organizationId: 'org-1' })],
      ['/documents/types/ty%2F1', 'PATCH', JSON.stringify({ name: 'First aid 2' })],
      ['/documents/types/ty-1/archive', 'POST', undefined],
      ['/documents/requirements?organizationId=org-1', 'GET', undefined],
      [
        '/documents/requirements',
        'POST',
        JSON.stringify({ organizationId: 'org-1', typeId: 'ty-1' }),
      ],
      ['/documents/requirements/rq-1/archive', 'POST', undefined],
    ]);
  });

  it('maps record, dashboard and hand-off routes', async () => {
    await documentsApi.createDocument({
      organizationId: 'org-1',
      employeeId: 'emp-1',
      typeId: 'ty-1',
      title: 'Contract',
      version,
    });
    await documentsApi.document('doc-1');
    await documentsApi.updateDocument('doc-1', { confidentiality: 'HR_ONLY' });
    await documentsApi.addVersion('doc-1', { ...version, expiresOn: '2027-01-01' });
    await documentsApi.archiveDocument('doc-1', 'Duplicate');
    await documentsApi.employeeRecords('emp-1');
    await documentsApi.expiring('org-1');
    await documentsApi.expiring('org-1', 60);
    await documentsApi.missing('org-1');
    await documentsApi.handoff('hire-1', {
      documents: [{ recruitmentDocumentId: 'cd-1', typeId: 'ty-1' }],
      offer: null,
    });
    expect(calls()).toEqual([
      [
        '/documents/records',
        'POST',
        JSON.stringify({
          organizationId: 'org-1',
          employeeId: 'emp-1',
          typeId: 'ty-1',
          title: 'Contract',
          version,
        }),
      ],
      ['/documents/records/doc-1', 'GET', undefined],
      ['/documents/records/doc-1', 'PATCH', JSON.stringify({ confidentiality: 'HR_ONLY' })],
      [
        '/documents/records/doc-1/versions',
        'POST',
        JSON.stringify({ ...version, expiresOn: '2027-01-01' }),
      ],
      ['/documents/records/doc-1/archive', 'POST', JSON.stringify({ reason: 'Duplicate' })],
      ['/documents/employees/emp-1', 'GET', undefined],
      ['/documents/expiring?organizationId=org-1', 'GET', undefined],
      ['/documents/expiring?organizationId=org-1&withinDays=60', 'GET', undefined],
      ['/documents/missing?organizationId=org-1', 'GET', undefined],
      [
        '/documents/handoff/hire-1',
        'POST',
        JSON.stringify({
          documents: [{ recruitmentDocumentId: 'cd-1', typeId: 'ty-1' }],
          offer: null,
        }),
      ],
    ]);
  });

  it('maps policy routes', async () => {
    await documentsApi.policies('org-1');
    await documentsApi.createPolicy({ organizationId: 'org-1', code: 'CODE', title: 'Conduct' });
    await documentsApi.updatePolicy('pol-1', { acknowledgementRequired: false });
    await documentsApi.createPolicyVersion('pol-1', { versionLabel: '2026', ...version });
    await documentsApi.publishPolicyVersion('pol-1', 'pv-1');
    await documentsApi.retirePolicy('pol-1');
    await documentsApi.acknowledgePolicy('pol-1', 'pv-1');
    await documentsApi.policyTracking('pol-1');
    expect(calls()).toEqual([
      ['/documents/policies?organizationId=org-1', 'GET', undefined],
      [
        '/documents/policies',
        'POST',
        JSON.stringify({ organizationId: 'org-1', code: 'CODE', title: 'Conduct' }),
      ],
      ['/documents/policies/pol-1', 'PATCH', JSON.stringify({ acknowledgementRequired: false })],
      [
        '/documents/policies/pol-1/versions',
        'POST',
        JSON.stringify({ versionLabel: '2026', ...version }),
      ],
      ['/documents/policies/pol-1/versions/pv-1/publish', 'POST', undefined],
      ['/documents/policies/pol-1/retire', 'POST', undefined],
      [
        '/documents/policies/pol-1/versions/pv-1/acknowledge',
        'POST',
        JSON.stringify({ statementAccepted: true }),
      ],
      ['/documents/policies/pol-1/acknowledgements', 'GET', undefined],
    ]);
  });
});

describe('documents errors', () => {
  it('maps domain codes to friendly messages and reads the current version of a conflict', () => {
    const error = new AuthApiError('conflict', 409, 'A newer version was published.', {
      code: 'POLICY_VERSION_NOT_CURRENT',
      currentVersionId: 'pv-2',
    });
    expect(documentsErrorCode(error)).toBe('POLICY_VERSION_NOT_CURRENT');
    expect(currentPolicyVersionId(error)).toBe('pv-2');
    expect(documentsErrorMessage(error)).toBe(
      'A newer version of this policy was published. Review it before acknowledging.',
    );
    expect(
      documentsErrorMessage(
        new AuthApiError('validation', 400, 'Links must be https URLs.', {
          code: 'DOCUMENT_URL_INVALID',
        }),
      ),
    ).toBe('Document links must be https:// URLs.');
    expect(
      documentsErrorMessage(
        new AuthApiError('conflict', 409, 'Server says no.', { code: 'SOMETHING_NEW' }),
      ),
    ).toBe('Server says no.');
    expect(
      currentPolicyVersionId(new AuthApiError('conflict', 409, 'x', { code: 'X' })),
    ).toBeNull();
    expect(documentsErrorCode(new Error('x'))).toBeNull();
  });

  it('maps statuses to readable messages', () => {
    expect(isDocumentsForbidden(new AuthApiError('forbidden', 403))).toBe(true);
    expect(isDocumentsNotFound(new AuthApiError('unexpected', 404))).toBe(true);
    expect(documentsErrorMessage(new AuthApiError('forbidden', 403))).toBe(
      'You do not have permission for this documents action.',
    );
    expect(documentsErrorMessage(new AuthApiError('unexpected', 404))).toBe(
      'The document record was not found.',
    );
    expect(documentsErrorMessage(new AuthApiError('service-unavailable', 503))).toBe(
      'The Documents service is unavailable. Please try again.',
    );
    expect(documentsErrorMessage(new Error('x'), 'Fallback')).toBe('Fallback');
  });
});

describe('Batch 9 files and lifecycle routes', () => {
  it('uploads multipart to the authorized target, never sending a path or key', async () => {
    apiUpload.mockResolvedValue({ id: 'up-1' });
    const file = new File(['%PDF-'], '../../etc/passwd.pdf', { type: 'application/pdf' });
    const signal = new AbortController().signal;
    await documentsApi.upload({ kind: 'record', organizationId: 'o 1', employeeId: 'e-1' }, file, {
      signal,
    });
    await documentsApi.upload({ kind: 'version', documentId: 'd-1' }, file);
    await documentsApi.upload({ kind: 'self', organizationId: 'o-1' }, file);
    await documentsApi.upload({ kind: 'policy', policyId: 'p-1' }, file);
    expect(apiUpload.mock.calls.map((call) => call[0])).toEqual([
      '/documents/uploads?organizationId=o+1&employeeId=e-1',
      '/documents/uploads?documentId=d-1',
      '/documents/uploads?organizationId=o-1&self=true',
      '/documents/uploads?policyId=p-1',
    ]);
    const form = apiUpload.mock.calls[0]![1] as FormData;
    expect([...form.keys()]).toEqual(['file']);
    expect(apiUpload.mock.calls[0]![2]).toEqual({ signal });
  });

  it('maps download links, options and the D10 routes', async () => {
    await documentsApi.versionDownload('d/1', 'v-1');
    await documentsApi.policyVersionDownload('p-1', 'v-2');
    await documentsApi.options('org-1', 'department', { search: 'aq', afterId: 'x' });
    await documentsApi.reactivateType('ty-1');
    await documentsApi.replaceRequirement('rq-1', { employmentType: 'CASUAL' });
    await documentsApi.copyPolicy('p-1', { code: 'C-2' });
    await documentsApi.requirements('org-1', true);
    expect(calls()).toEqual([
      ['/documents/records/d%2F1/versions/v-1/download-url', 'POST', undefined],
      ['/documents/policies/p-1/versions/v-2/download-url', 'POST', undefined],
      [
        '/documents/options?organizationId=org-1&kind=department&search=aq&afterId=x',
        'GET',
        undefined,
      ],
      ['/documents/types/ty-1/reactivate', 'POST', undefined],
      [
        '/documents/requirements/rq-1/replace',
        'POST',
        JSON.stringify({ employmentType: 'CASUAL' }),
      ],
      ['/documents/policies/p-1/copy', 'POST', JSON.stringify({ code: 'C-2' })],
      ['/documents/requirements?organizationId=org-1&includeArchived=true', 'GET', undefined],
    ]);
  });

  it('starts a download from a relative or absolute link without keeping it in the page', () => {
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.href);
    });
    startDownload({ url: '/documents/files/t.m', expiresAt: '', fileName: 'a.pdf' });
    startDownload({
      url: 'https://objects.example.test/x?X-Amz-Signature=s',
      expiresAt: '',
      fileName: 'b.pdf',
    });
    expect(clicked).toEqual([
      'https://api.example.test/documents/files/t.m',
      'https://objects.example.test/x?X-Amz-Signature=s',
    ]);
    expect(document.querySelectorAll('a').length).toBe(0);
    click.mockRestore();
  });

  it('explains upload and download errors', () => {
    const error = (status: number, code?: string) =>
      new AuthApiError('unexpected', status, undefined, code ? { code } : {});
    expect(documentsErrorMessage(error(413))).toBe('The file is larger than the upload limit.');
    expect(documentsErrorMessage(error(415))).toBe('Only PDF, PNG and JPEG files can be uploaded.');
    expect(documentsErrorMessage(error(422, 'DOCUMENT_FILE_INFECTED'))).toBe(
      'The malware scan flagged this file. It was not saved.',
    );
    expect(documentsErrorMessage(error(409, 'DOCUMENT_LEGACY_REFERENCE'))).toMatch(
      /cannot be downloaded/,
    );
    expect(documentsErrorMessage(error(0, 'UPLOAD_NETWORK'))).toMatch(/connection was lost/);
    expect(documentsErrorMessage(new DOMException('x', 'AbortError'))).toBe(
      'The upload was cancelled. Nothing was saved.',
    );
  });
});
