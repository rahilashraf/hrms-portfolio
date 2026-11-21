import { apiRequest, apiUpload, type UploadOptions } from '../auth/api-client';
import { getApiBaseUrl } from '../api-config';
import type {
  AcknowledgementResult,
  Confidentiality,
  DocumentCategory,
  DocumentRequirement,
  DocumentsOrganization,
  DocumentType,
  DownloadLink,
  EmployeeDocument,
  EmployeeRecords,
  EmploymentType,
  ExpiryDashboard,
  HandoffOutcome,
  MissingDashboard,
  MyDocuments,
  MyPolicy,
  PickerOption,
  Policy,
  PolicyTracking,
  StorageProvider,
  UploadCapability,
  UploadedFile,
} from './types';

const enc = encodeURIComponent;

function send<T>(method: 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  return apiRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** `?organizationId=…` plus any defined filters. */
function query(
  organizationId: string,
  filters: Record<string, string | number | boolean | undefined> = {},
) {
  const params = new URLSearchParams({ organizationId });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return `?${params.toString()}`;
}

export interface StorageReferenceInput {
  provider: StorageProvider;
  externalUrl?: string | null;
  /** Batch 9: the id of an upload (internal storage); storage keys are never sent. */
  uploadId?: string | null;
  externalFileId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface VersionInput extends StorageReferenceInput {
  issuedOn?: string | null;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  note?: string | null;
}

export interface TypeInput {
  organizationId: string;
  code: string;
  name: string;
  description?: string | null;
  category: DocumentCategory;
  defaultConfidentiality: Confidentiality;
  expiryTracked?: boolean;
  employeeProvided?: boolean;
}

export interface TypeUpdate {
  name?: string;
  description?: string | null;
  defaultConfidentiality?: Confidentiality;
  expiryTracked?: boolean;
  employeeProvided?: boolean;
}

export interface RequirementInput {
  organizationId: string;
  typeId: string;
  employmentType?: EmploymentType | null;
  departmentId?: string | null;
  positionId?: string | null;
  note?: string | null;
}

export interface CreateDocumentInput {
  organizationId: string;
  employeeId: string;
  employmentAssignmentId?: string | null;
  typeId: string;
  title: string;
  description?: string | null;
  confidentiality?: Confidentiality | null;
  version: VersionInput;
}

export interface DocumentUpdate {
  title?: string;
  description?: string | null;
  confidentiality?: Confidentiality;
}

export interface ProvideInput {
  organizationId: string;
  typeId: string;
  title: string;
  workflowTaskId?: string | null;
  version: VersionInput;
}

export interface PolicyInput {
  organizationId: string;
  code: string;
  title: string;
  description?: string | null;
  typeId?: string | null;
  acknowledgementRequired?: boolean;
  audienceEmploymentType?: EmploymentType | null;
  audienceDepartmentId?: string | null;
}

export interface PolicyUpdate {
  title?: string;
  description?: string | null;
  acknowledgementRequired?: boolean;
  audienceEmploymentType?: EmploymentType | null;
  audienceDepartmentId?: string | null;
}

export interface PolicyVersionInput extends StorageReferenceInput {
  versionLabel: string;
  acknowledgementStatement?: string | null;
  effectiveOn?: string | null;
}

export interface HandoffInput {
  documents: Array<{
    recruitmentDocumentId: string;
    typeId: string;
    confidentiality?: Confidentiality | null;
  }>;
  offer?: { typeId: string; confidentiality?: Confidentiality | null } | null;
}

/** Where an upload is for; it is authorized before the file is accepted. */
export type UploadTarget =
  | { kind: 'record'; organizationId: string; employeeId: string }
  | { kind: 'version'; documentId: string }
  | { kind: 'self'; organizationId: string }
  | { kind: 'policy'; policyId: string };

function uploadQuery(target: UploadTarget): string {
  const params = new URLSearchParams();
  if (target.kind === 'record') {
    params.set('organizationId', target.organizationId);
    params.set('employeeId', target.employeeId);
  } else if (target.kind === 'version') params.set('documentId', target.documentId);
  else if (target.kind === 'self') {
    params.set('organizationId', target.organizationId);
    params.set('self', 'true');
  } else params.set('policyId', target.policyId);
  return `?${params.toString()}`;
}

/**
 * Starts a browser download from a short-lived link without keeping it: local links are
 * relative to the API, S3 links are absolute. The link is never rendered or stored.
 */
export function startDownload(link: DownloadLink, doc: Document = document): void {
  const href = link.url.startsWith('/') ? `${getApiBaseUrl()}${link.url}` : link.url;
  const anchor = doc.createElement('a');
  anchor.href = href;
  anchor.rel = 'noopener noreferrer';
  anchor.download = link.fileName;
  anchor.style.display = 'none';
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export const documentsApi = {
  // ─── Batch 9: files ───────────────────────────────────────────────────────
  upload(target: UploadTarget, file: File, options: UploadOptions = {}): Promise<UploadedFile> {
    const form = new FormData();
    form.append('file', file, file.name);
    return apiUpload(`/documents/uploads${uploadQuery(target)}`, form, options);
  },
  versionDownload(documentId: string, versionId: string): Promise<DownloadLink> {
    return send(
      'POST',
      `/documents/records/${enc(documentId)}/versions/${enc(versionId)}/download-url`,
    );
  },
  policyVersionDownload(policyId: string, versionId: string): Promise<DownloadLink> {
    return send(
      'POST',
      `/documents/policies/${enc(policyId)}/versions/${enc(versionId)}/download-url`,
    );
  },
  options(
    organizationId: string,
    kind: 'department' | 'position',
    filters: { search?: string; afterId?: string; limit?: number } = {},
  ): Promise<{ items: PickerOption[]; nextAfterId: string | null }> {
    return apiRequest(`/documents/options${query(organizationId, { kind, ...filters })}`);
  },
  reactivateType(typeId: string): Promise<DocumentType> {
    return send('POST', `/documents/types/${enc(typeId)}/reactivate`);
  },
  replaceRequirement(
    requirementId: string,
    input: {
      employmentType?: EmploymentType | null;
      departmentId?: string | null;
      positionId?: string | null;
      note?: string | null;
    },
  ): Promise<{ previous: DocumentRequirement; requirement: DocumentRequirement }> {
    return send('POST', `/documents/requirements/${enc(requirementId)}/replace`, input);
  },
  copyPolicy(policyId: string, input: { code: string; title?: string }): Promise<Policy> {
    return send('POST', `/documents/policies/${enc(policyId)}/copy`, input);
  },

  // ─── Organizations and self-service ───────────────────────────────────────
  /** Organizations, plus (Batch 9) whether file uploads are available and their limits. */
  organizations(): Promise<{ items: DocumentsOrganization[]; uploads?: UploadCapability }> {
    return apiRequest('/documents/organizations');
  },
  mine(): Promise<{ items: MyDocuments[] }> {
    return apiRequest('/documents/me');
  },
  myPolicies(): Promise<{ items: MyPolicy[] }> {
    return apiRequest('/documents/me/policies');
  },
  provide(input: ProvideInput): Promise<EmployeeDocument> {
    return send('POST', '/documents/me/provide', input);
  },

  // ─── Types and requirements ───────────────────────────────────────────────
  types(organizationId: string, includeArchived = false): Promise<{ items: DocumentType[] }> {
    return apiRequest(
      `/documents/types${query(organizationId, includeArchived ? { includeArchived } : {})}`,
    );
  },
  createType(input: TypeInput): Promise<DocumentType> {
    return send('POST', '/documents/types', input);
  },
  initializeTypes(organizationId: string): Promise<{ created: boolean; items: DocumentType[] }> {
    return send('POST', '/documents/types/initialize', { organizationId });
  },
  updateType(typeId: string, input: TypeUpdate): Promise<DocumentType> {
    return send('PATCH', `/documents/types/${enc(typeId)}`, input);
  },
  archiveType(typeId: string): Promise<DocumentType> {
    return send('POST', `/documents/types/${enc(typeId)}/archive`);
  },
  requirements(
    organizationId: string,
    includeArchived = false,
  ): Promise<{ items: DocumentRequirement[] }> {
    return apiRequest(
      `/documents/requirements${query(organizationId, includeArchived ? { includeArchived } : {})}`,
    );
  },
  createRequirement(input: RequirementInput): Promise<DocumentRequirement> {
    return send('POST', '/documents/requirements', input);
  },
  archiveRequirement(requirementId: string): Promise<DocumentRequirement> {
    return send('POST', `/documents/requirements/${enc(requirementId)}/archive`);
  },

  // ─── Employee records ─────────────────────────────────────────────────────
  createDocument(input: CreateDocumentInput): Promise<EmployeeDocument> {
    return send('POST', '/documents/records', input);
  },
  document(documentId: string): Promise<EmployeeDocument> {
    return apiRequest(`/documents/records/${enc(documentId)}`);
  },
  updateDocument(documentId: string, input: DocumentUpdate): Promise<EmployeeDocument> {
    return send('PATCH', `/documents/records/${enc(documentId)}`, input);
  },
  addVersion(documentId: string, input: VersionInput): Promise<EmployeeDocument> {
    return send('POST', `/documents/records/${enc(documentId)}/versions`, input);
  },
  archiveDocument(documentId: string, reason: string): Promise<EmployeeDocument> {
    return send('POST', `/documents/records/${enc(documentId)}/archive`, { reason });
  },
  employeeRecords(employeeId: string): Promise<{ items: EmployeeRecords[] }> {
    return apiRequest(`/documents/employees/${enc(employeeId)}`);
  },
  expiring(organizationId: string, withinDays?: number): Promise<ExpiryDashboard> {
    return apiRequest(`/documents/expiring${query(organizationId, { withinDays })}`);
  },
  missing(organizationId: string): Promise<MissingDashboard> {
    return apiRequest(`/documents/missing${query(organizationId)}`);
  },
  handoff(hireId: string, input: HandoffInput): Promise<{ outcomes: HandoffOutcome[] }> {
    return send('POST', `/documents/handoff/${enc(hireId)}`, input);
  },

  // ─── Policies ─────────────────────────────────────────────────────────────
  policies(organizationId: string): Promise<{ items: Policy[] }> {
    return apiRequest(`/documents/policies${query(organizationId)}`);
  },
  createPolicy(input: PolicyInput): Promise<Policy> {
    return send('POST', '/documents/policies', input);
  },
  updatePolicy(policyId: string, input: PolicyUpdate): Promise<Policy> {
    return send('PATCH', `/documents/policies/${enc(policyId)}`, input);
  },
  createPolicyVersion(policyId: string, input: PolicyVersionInput): Promise<Policy> {
    return send('POST', `/documents/policies/${enc(policyId)}/versions`, input);
  },
  publishPolicyVersion(policyId: string, versionId: string): Promise<Policy> {
    return send('POST', `/documents/policies/${enc(policyId)}/versions/${enc(versionId)}/publish`);
  },
  retirePolicy(policyId: string): Promise<Policy> {
    return send('POST', `/documents/policies/${enc(policyId)}/retire`);
  },
  acknowledgePolicy(policyId: string, versionId: string): Promise<AcknowledgementResult> {
    return send(
      'POST',
      `/documents/policies/${enc(policyId)}/versions/${enc(versionId)}/acknowledge`,
      { statementAccepted: true },
    );
  },
  policyTracking(policyId: string): Promise<PolicyTracking> {
    return apiRequest(`/documents/policies/${enc(policyId)}/acknowledgements`);
  },
};
