import { apiRequest } from '../auth/api-client';
import { AUDIT_SYSTEM_VIEW } from './types';
import type { AuditActorPage, AuditActorQuery, AuditPage, AuditQuery } from './types';

const OPTIONAL_KEYS = ['from', 'to', 'action', 'entityType', 'entityId', 'actorUserId'] as const;

export function auditQueryString(query: AuditQuery): string {
  // Batch 2: the System view (entries tied to no organization) takes no organization.
  const params = new URLSearchParams(
    query.organizationId === AUDIT_SYSTEM_VIEW
      ? { scope: 'system' }
      : { organizationId: query.organizationId },
  );
  for (const key of OPTIONAL_KEYS) {
    const value = query[key]?.trim();
    if (value) params.set(key, value);
  }
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  return params.toString();
}

export const auditApi = {
  /** GET /audit — newest first; needs audit.read at organization scope. */
  list(query: AuditQuery): Promise<AuditPage> {
    return apiRequest(`/audit?${auditQueryString(query)}`);
  },
  /**
   * GET /audit/actors (Batch R3.3) — the people who acted in the entries the reader may see, in
   * the same window as the list; same permission. For the actor filter.
   */
  actors(query: AuditActorQuery): Promise<AuditActorPage> {
    const params = new URLSearchParams(
      query.organizationId === AUDIT_SYSTEM_VIEW
        ? { scope: 'system' }
        : { organizationId: query.organizationId },
    );
    for (const key of ['from', 'to', 'query', 'afterId'] as const) {
      const value = query[key]?.trim();
      if (value) params.set(key, value);
    }
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    return apiRequest(`/audit/actors?${params.toString()}`);
  },
};
