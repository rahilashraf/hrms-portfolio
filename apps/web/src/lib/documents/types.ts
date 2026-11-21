/** Phase 15 Documents & Employee Records read and write models (mirror the API). */

export type DocumentCategory =
  | 'EMPLOYMENT_AGREEMENT'
  | 'OFFER_LETTER'
  | 'RESUME'
  | 'CERTIFICATION'
  | 'LICENSE'
  | 'BACKGROUND_CHECK'
  | 'HANDBOOK'
  | 'POLICY'
  | 'EVALUATION'
  | 'PAYROLL'
  | 'TAX'
  | 'IDENTIFICATION'
  | 'TRAINING_CERTIFICATE'
  | 'OTHER';
export type Confidentiality = 'EMPLOYEE_VISIBLE' | 'MANAGER_VISIBLE' | 'HR_ONLY' | 'RESTRICTED';
export type StorageProvider =
  'GOOGLE_DRIVE' | 'EXTERNAL_URL' | 'INTERNAL_OBJECT_STORAGE' | 'MANUAL_REFERENCE';
export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CASUAL' | 'CONTRACT';
export type ExpiryStatus = 'NO_EXPIRY' | 'VALID' | 'EXPIRING_SOON' | 'EXPIRED';
export type DocumentStatus = 'ACTIVE' | 'ARCHIVED';
export type DocumentSource = 'HR' | 'EMPLOYEE' | 'ONBOARDING' | 'RECRUITMENT_HANDOFF';
export type RequirementStatus = 'SATISFIED' | 'MISSING' | 'EXPIRED';
export type PolicyStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type PolicyVersionState = 'DRAFT' | 'CURRENT' | 'SUPERSEDED';
export type AcknowledgementSource = 'SELF_SERVICE' | 'ONBOARDING_TASK';
export type ReferenceStatus = 'UNKNOWN' | 'OK' | 'MISSING' | 'ACCESS_DENIED';
export type TrackingStatus = 'ACKNOWLEDGED' | 'EARLIER_VERSION_ONLY' | 'PENDING';

/** Batch 9: whether uploads can succeed here, and their limits. */
export interface UploadCapability {
  enabled: boolean;
  maxBytes: number;
  allowedTypes: string[];
}

/** The response of an upload: an id to attach to a record, version or policy version. */
export interface UploadedFile {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
}

/** A short-lived (60 s) download link; it is used at once and never stored or shown. */
export interface DownloadLink {
  url: string;
  expiresAt: string;
  fileName: string;
}

export interface PickerOption {
  id: string;
  label: string;
  description?: string;
}

export interface DocumentsOrganization {
  id: string;
  name: string;
  code: string;
  timezone: string | null;
  actions: {
    canManageTypes: boolean;
    canManagePolicies: boolean;
    canReadRecords: boolean;
    canManageRecords: boolean;
  };
}

export interface DocumentType {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  description: string | null;
  category: DocumentCategory;
  defaultConfidentiality: Confidentiality;
  expiryTracked: boolean;
  employeeProvided: boolean;
  archivedAt: string | null;
}

export interface DocumentRequirement {
  id: string;
  typeId: string;
  typeName: string | null;
  employmentType: EmploymentType | null;
  departmentId: string | null;
  departmentName?: string | null;
  positionId: string | null;
  positionName?: string | null;
  note: string | null;
  archivedAt: string | null;
}

export type ScanStatus = 'NOT_SCANNED' | 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED';

/** Batch 9: an uploaded file as readers see it (never its storage key). */
export interface StoredFile {
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  scanStatus: ScanStatus;
  /** Whether a download link can be issued now (not quarantined or infected). */
  downloadable: boolean;
}

/**
 * A storage reference: a link, a Drive file id (managers only) or an uploaded file — never file
 * contents and never an internal storage key.
 */
export interface StorageReference {
  provider: StorageProvider;
  externalUrl: string | null;
  externalFileId?: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes?: number | null;
  file?: StoredFile | null;
  /** An internal reference from before uploads existed: no file can be downloaded. */
  legacyReference?: boolean;
}

export interface DocumentVersion extends StorageReference {
  id: string;
  versionNumber: number;
  sizeBytes: number | null;
  issuedOn: string | null;
  effectiveOn: string | null;
  expiresOn: string | null;
  expiryStatus: ExpiryStatus;
  note: string | null;
  referenceStatus: ReferenceStatus;
  current: boolean;
  supersededAt: string | null;
  createdAt: string;
}

export interface EmployeeDocument {
  id: string;
  organizationId: string;
  employeeId: string;
  employmentAssignmentId: string | null;
  type: {
    id: string;
    code: string;
    name: string;
    category: DocumentCategory;
    expiryTracked: boolean;
  };
  title: string;
  description: string | null;
  confidentiality: Confidentiality;
  status: DocumentStatus;
  source: DocumentSource;
  provenance: { recruitmentHireId: string; recruitmentDocumentId: string | null } | null;
  archivedAt: string | null;
  currentVersion: DocumentVersion | null;
  expiryStatus: ExpiryStatus;
  versions: DocumentVersion[];
  createdAt: string;
  actions: { canManage: boolean; canAddVersion?: boolean };
}

export interface MissingRequirement {
  typeId: string;
  typeName: string;
  status: RequirementStatus;
  employeeProvided?: boolean;
}

export interface MyDocuments {
  organization: { id: string; name: string };
  documents: EmployeeDocument[];
  missing: MissingRequirement[];
  providableTypes: DocumentType[];
}

export interface EmployeeAcknowledgement {
  id: string;
  policy: { id: string; code: string; title: string };
  versionNumber: number;
  versionLabel: string;
  acknowledgedAt: string;
  source: AcknowledgementSource;
  current: boolean;
}

export interface EmployeeRecords {
  organization: { id: string; name: string };
  access: { clearance: number; canManage: boolean };
  documents: EmployeeDocument[];
  acknowledgements: EmployeeAcknowledgement[];
  requirements: MissingRequirement[];
}

export interface PolicyVersion extends StorageReference {
  id: string;
  versionNumber: number;
  versionLabel: string;
  acknowledgementStatement: string | null;
  effectiveOn: string | null;
  state: PolicyVersionState;
  publishedAt: string | null;
  supersededAt: string | null;
  referenceStatus: ReferenceStatus;
}

export interface Policy {
  id: string;
  organizationId: string;
  code: string;
  title: string;
  description: string | null;
  typeId: string | null;
  status: PolicyStatus;
  acknowledgementRequired: boolean;
  audience: {
    employmentType: EmploymentType | null;
    departmentId: string | null;
    departmentName?: string | null;
  };
  currentVersion: PolicyVersion | null;
  versions: PolicyVersion[];
  retiredAt: string | null;
}

export interface MyPolicy extends Policy {
  myAcknowledgement: { id: string; acknowledgedAt: string; statement: string } | null;
  acknowledgedEarlierVersion: boolean;
  needsAcknowledgement: boolean;
}

export interface AcknowledgementResult {
  acknowledgementId: string;
  policyVersionId: string;
  created: boolean;
  statement: string;
}

export interface EmployeeRef {
  id: string;
  employeeNumber: string;
  displayName: string | null;
}

export interface PolicyTracking {
  policy: Policy;
  currentVersionId: string | null;
  counts: { audience: number; acknowledged: number; pending: number };
  items: Array<{ employee: EmployeeRef; status: TrackingStatus; acknowledgedAt: string | null }>;
}

export interface ExpiryDashboard {
  today: string;
  withinDays: number;
  items: Array<{
    documentId: string;
    title: string;
    type: { id: string; name: string };
    employee: EmployeeRef;
    expiresOn: string | null;
    expiryStatus: ExpiryStatus;
  }>;
  /** Phase 19: the list was capped (1000 rows, soonest first). */
  truncated?: boolean;
}

export interface MissingDashboard {
  today: string;
  items: Array<{
    employee: EmployeeRef;
    missing: Array<{ typeId: string; typeName: string; status: RequirementStatus }>;
  }>;
  /** Phase 19: the list was capped (1000 employees). */
  truncated?: boolean;
}

export interface HandoffOutcome {
  recruitmentDocumentId: string | null;
  documentId: string;
  outcome: 'CREATED' | 'ALREADY_HANDED_OFF';
}
