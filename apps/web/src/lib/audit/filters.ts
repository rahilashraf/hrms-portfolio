import type { GrantSnapshot } from '../authorization/types';
import type { Organization } from '../organization/types';
import {
  AUDIT_MAX_RANGE_DAYS,
  AUDIT_READ_PERMISSION,
  AUDIT_SYSTEM_VIEW,
  type AuditOrganizationOption,
  type AuditQuery,
} from './types';

/** The filter form (date inputs are local calendar days, `toDate` inclusive). */
export interface AuditFilterForm {
  fromDate: string;
  toDate: string;
  action: string;
  entityType: string;
  entityId: string;
  actorUserId: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilterForm = {
  fromDate: '',
  toDate: '',
  action: '',
  entityType: '',
  entityId: '',
  actorUserId: '',
};

// The API's DTO shapes (apps/api/src/audit/audit-viewer.dto.ts).
const ACTION = /^[A-Za-z][A-Za-z0-9_.]*$/;
const ENTITY_TYPE = /^[A-Za-z][A-Za-z0-9]*$/;
const ENTITY_ID = /^[A-Za-z0-9_.:-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Local midnight of a YYYY-MM-DD date (plus whole days), or null when invalid. */
export function localDayStart(date: string, addDays = 0): Date | null {
  const match = DATE.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const value = new Date(year, month - 1, day);
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) {
    return null;
  }
  if (addDays) value.setDate(value.getDate() + addDays);
  return value;
}

export type AuditFilterResult =
  | { ok: true; query: Omit<AuditQuery, 'organizationId' | 'cursor' | 'limit'> }
  | { ok: false; problem: string };

/**
 * Validates the filter form and turns it into query parameters. Mirrors the API's checks so
 * a typo is explained before a request is sent; the API re-validates everything.
 */
export function auditFilterQuery(form: AuditFilterForm): AuditFilterResult {
  const query: Omit<AuditQuery, 'organizationId' | 'cursor' | 'limit'> = {};
  const fromDate = form.fromDate.trim();
  const toDate = form.toDate.trim();
  let from: Date | null = null;
  let to: Date | null = null;
  if (fromDate) {
    from = localDayStart(fromDate);
    if (!from) return { ok: false, problem: 'Enter a valid start date.' };
    query.from = from.toISOString();
  }
  if (toDate) {
    // The end date is inclusive in the form; the API's `to` is exclusive.
    if (!localDayStart(toDate)) return { ok: false, problem: 'Enter a valid end date.' };
    to = localDayStart(toDate, 1)!;
    query.to = to.toISOString();
  }
  if (from && to) {
    if (from.getTime() >= to.getTime()) {
      return { ok: false, problem: 'The start date must be on or before the end date.' };
    }
    // Local days can be 23–25 hours long; allow for daylight saving changes.
    if (to.getTime() - from.getTime() > AUDIT_MAX_RANGE_DAYS * DAY_MS + 2 * 3_600_000) {
      return {
        ok: false,
        problem: `The date range may cover at most ${AUDIT_MAX_RANGE_DAYS} days.`,
      };
    }
  }
  const action = form.action.trim();
  if (action) {
    if (action.length > 100 || !ACTION.test(action)) {
      return {
        ok: false,
        problem: 'The action is a code such as EMPLOYEE_CREATED (letters, digits, _ and .).',
      };
    }
    query.action = action;
  }
  const entityType = form.entityType.trim();
  if (entityType) {
    if (entityType.length > 100 || !ENTITY_TYPE.test(entityType)) {
      return {
        ok: false,
        problem: 'The entity type is a name such as Employee (letters and digits only).',
      };
    }
    query.entityType = entityType;
  }
  const entityId = form.entityId.trim();
  if (entityId) {
    if (entityId.length > 100 || !ENTITY_ID.test(entityId)) {
      return {
        ok: false,
        problem: 'The entity id may contain only letters, digits and _ . : -',
      };
    }
    query.entityId = entityId;
  }
  const actorUserId = form.actorUserId.trim();
  if (actorUserId) {
    if (!UUID.test(actorUserId)) {
      return { ok: false, problem: 'The actor user id must be a UUID.' };
    }
    query.actorUserId = actorUserId;
  }
  return { ok: true, query };
}

/**
 * The organizations whose audit log the user may read, from the authorization snapshot:
 * audit.read at ORGANIZATION scope (an id) or SYSTEM scope (every organization). Unit, department
 * or team grants do not cover an organization's audit trail. `all` = a SYSTEM grant.
 */
export function auditReadScopes(snapshot: GrantSnapshot | null | undefined): {
  all: boolean;
  organizationIds: string[];
} {
  const ids: string[] = [];
  let all = false;
  for (const permission of snapshot?.permissions ?? []) {
    if (permission.key !== AUDIT_READ_PERMISSION) continue;
    for (const scope of permission.scopes) {
      if (scope.type === 'SYSTEM') all = true;
      else if (scope.type === 'ORGANIZATION' && scope.id && !ids.includes(scope.id)) {
        ids.push(scope.id);
      }
    }
  }
  return { all, organizationIds: ids };
}

/**
 * The organization selector options: the readable organizations named from the organizations
 * list (which needs organization.read; without it, an organization is shown by its id).
 */
export function auditOrganizationOptions(
  snapshot: GrantSnapshot | null | undefined,
  organizations: readonly Pick<Organization, 'id' | 'name'>[],
): AuditOrganizationOption[] {
  const { all, organizationIds } = auditReadScopes(snapshot);
  const names = new Map(organizations.map((organization) => [organization.id, organization.name]));
  const ids = all
    ? [...new Set([...organizations.map((organization) => organization.id), ...organizationIds])]
    : organizationIds;
  const options = ids
    .map((id) => ({ id, name: names.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Batch 2: System-scope readers also see the entries tied to no organization.
  return all ? [...options, { id: AUDIT_SYSTEM_VIEW, name: 'System (no organization)' }] : options;
}

/** Metadata values as plain text (arrays joined with commas). */
export function auditMetadataText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}
