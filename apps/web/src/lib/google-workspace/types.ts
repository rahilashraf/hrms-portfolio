/** Phase 16.5 Google Workspace integration read and write models (mirror the API). */

export type GoogleCapability = 'FORMS' | 'DRIVE_METADATA' | 'GMAIL_SEND' | 'SHEETS_EXPORT';
export type GoogleConnectionMode = 'OAUTH' | 'SERVICE_ACCOUNT';
export type GoogleConnectionStatus =
  'ACTIVE' | 'ERROR' | 'DISCONNECTED' | 'CREDENTIALS_UNAVAILABLE';
export type GoogleFormBindingTarget =
  'PERFORMANCE_EVIDENCE' | 'RECRUITMENT_INTAKE' | 'ONBOARDING_TASKS';
export type GoogleSyncRunStatus = 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
export type GoogleSyncTrigger = 'MANUAL' | 'SCHEDULED';
export type GoogleScoreSource = 'QUIZ_TOTAL' | 'NONE';

export interface GoogleOrganization {
  id: string;
  name: string;
  code: string;
  actions: { canRead: boolean; canManage: boolean };
}

/** The connection summary: never tokens, keys or verifiers. */
export interface GoogleConnectionSummary {
  id: string;
  mode: GoogleConnectionMode;
  status: GoogleConnectionStatus;
  workspaceDomain: string | null;
  accountEmail: string | null;
  serviceAccountEmail: string | null;
  grantedScopes: string[];
  capabilities: GoogleCapability[];
  credentialsAvailable: boolean;
  connectedAt: string | null;
  connectedByUserId: string | null;
  lastHealthCheckAt: string | null;
  lastHealthOk: boolean | null;
  lastErrorCode: string | null;
}

export interface GooglePreviousConnection {
  id: string;
  mode: GoogleConnectionMode;
  workspaceDomain: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  disconnectedByUserId: string | null;
}

export interface GoogleCapabilityInfo {
  capability: GoogleCapability;
  scopes: string[];
  requiresDomainWideDelegation: boolean;
}

export interface GoogleWorkspaceStatus {
  organizationId: string;
  canManage: boolean;
  oauthConfigured: boolean;
  encryptionConfigured: boolean;
  strategies: {
    OAUTH: { default: boolean; available: boolean; requiresDomainWideDelegation: boolean };
    SERVICE_ACCOUNT: {
      default?: boolean;
      optional: boolean;
      available: boolean;
      requiresDomainWideDelegation: boolean;
    };
  };
  capabilities: GoogleCapabilityInfo[];
  connection: GoogleConnectionSummary | null;
  previousConnections: GooglePreviousConnection[];
}

export interface OAuthStartResult {
  authorizationUrl: string;
  expiresAt: string;
}

export interface ServiceAccountInput {
  organizationId: string;
  keyJson: string;
  impersonatedUser: string;
  capabilities: GoogleCapability[];
}

export interface ConnectionResult {
  organizationId: string;
  connection: GoogleConnectionSummary | null;
}

export interface DisconnectResult extends ConnectionResult {
  revoked: boolean;
}

export interface HealthCheckResult extends ConnectionResult {
  result: 'ACTIVE' | 'ERROR' | 'CREDENTIALS_UNAVAILABLE' | 'UNKNOWN';
}

export interface GoogleFormSource {
  id: string;
  code: string;
  name: string;
  formId: string | null;
}

export interface GoogleSources {
  performanceSources: GoogleFormSource[];
  recruitmentSources: GoogleFormSource[];
}

export interface FieldMappingEntry {
  questionId: string;
  field: string;
  label?: string;
}

export interface FormFieldMapping {
  schemaVersion: 1;
  fields: FieldMappingEntry[];
  scoreSource?: GoogleScoreSource;
}

export interface GoogleFormBinding {
  id: string;
  organizationId: string;
  formId: string;
  formTitle: string | null;
  target: GoogleFormBindingTarget;
  performanceSourceId: string | null;
  recruitmentSourceId: string | null;
  mapping: FormFieldMapping;
  mappingSchemaVersion: number;
  enabled: boolean;
  cursorSubmittedAt: string | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
  nextSyncAfter: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBindingInput {
  organizationId: string;
  formId: string;
  target: GoogleFormBindingTarget;
  performanceSourceId?: string;
  recruitmentSourceId?: string;
  mapping: FormFieldMapping;
  enabled?: boolean;
}

export interface UpdateBindingInput {
  mapping?: FormFieldMapping;
  enabled?: boolean;
}

export type SyncResult =
  | { status: 'SKIPPED'; bindingId: string; reason: string }
  | {
      status: GoogleSyncRunStatus;
      bindingId: string;
      runId: string;
      fetched: number;
      accepted: number;
      duplicates: number;
      rejected: number;
      errorCode: string | null;
    };

export interface GoogleSyncRun {
  id: string;
  bindingId: string;
  target: GoogleFormBindingTarget;
  trigger: GoogleSyncTrigger;
  triggeredByUserId: string | null;
  status: GoogleSyncRunStatus;
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  errorCode: string | null;
}

export interface SyncRunQuery {
  organizationId: string;
  bindingId?: string | null;
  limit?: number;
  offset?: number;
}

export interface SyncRunPage {
  total: number;
  limit: number;
  offset: number;
  items: GoogleSyncRun[];
}
