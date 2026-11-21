/** Phase 19 — audit viewer (mirrors apps/api/src/audit/audit-viewer.*). */

/** Required at organization scope (or SYSTEM) to read an organization's audit trail. */
export const AUDIT_READ_PERMISSION = 'audit.read';

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;
export const AUDIT_DEFAULT_RANGE_DAYS = 30;
export const AUDIT_MAX_RANGE_DAYS = 366;

/** A whitelisted, value-checked metadata value (identifiers, codes, numbers, flags). */
export type AuditMetadataScalar = string | number | boolean;
export type AuditMetadataValue = AuditMetadataScalar | AuditMetadataScalar[];

export interface AuditEntry {
  id: string;
  occurredAt: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  /** null for system actions; displayName is null when the user has no person name. */
  actor: { userId: string; displayName: string | null } | null;
  requestId: string | null;
  metadata: Record<string, AuditMetadataValue>;
}

export interface AuditPage {
  items: AuditEntry[];
  /** Pass as `cursor` (with the same filters) for the next, older page; null at the end. */
  nextCursor: string | null;
  /** The resolved window: `from` inclusive, `to` exclusive. */
  range: { from: string; to: string };
}

/**
 * Batch 2: the selector value of the System view — entries tied to no organization (e.g. the
 * sign-in events of an account outside every organization); audit.read at System scope only.
 */
export const AUDIT_SYSTEM_VIEW = 'system';

export interface AuditQuery {
  /** An organization id, or AUDIT_SYSTEM_VIEW. */
  organizationId: string;
  /** ISO 8601 instants; `to` is exclusive. Defaults: the last 30 days. */
  from?: string;
  to?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  limit?: number;
  cursor?: string | null;
}

export interface AuditOrganizationOption {
  id: string;
  /** The organization name, or its id when the name cannot be read. */
  name: string;
}

/** Batch R3.3: a person who acted in the entries the reader may see (names only, no emails). */
export interface AuditActor {
  userId: string;
  /** null when the account has no person name. */
  displayName: string | null;
}

export interface AuditActorPage {
  items: AuditActor[];
  /** Pass as `afterId` for the next page; null at the end. */
  nextAfterId: string | null;
}

export interface AuditActorQuery {
  /** An organization id, or AUDIT_SYSTEM_VIEW. */
  organizationId: string;
  /** The same window as the list (ISO instants; `to` exclusive). Defaults: the last 30 days. */
  from?: string;
  to?: string;
  query?: string;
  afterId?: string | null;
  limit?: number;
}
