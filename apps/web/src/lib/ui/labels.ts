/**
 * Phase 20 — shared user-facing labels for API enum keys. Raw keys (ORGANIZATIONAL_UNIT,
 * TIME_ENTRY…) are never shown; product terminology overrides plain humanizing.
 */

/** Product terminology for keys whose plain humanized form is not the preferred term. */
export const TERMINOLOGY: Readonly<Record<string, string>> = {
  ORGANIZATIONAL_UNIT: 'Business Unit',
  ORGANIZATION_UNIT: 'Business Unit',
  EMPLOYMENT_ASSIGNMENT: 'Employment',
  ROLE_ASSIGNMENT: 'User Access',
  TIME_ENTRY: 'Attendance Record',
  TIME_CORRECTION_REQUEST: 'Time Correction',
  REPORTING: 'Reports',
  SYSTEM: 'All organizations',
};

/** "FULL_TIME" → "Full Time"; terminology overrides apply. Empty values render as "—". */
export function enumLabel(value: string | null | undefined): string {
  if (!value) return '—';
  const term = TERMINOLOGY[value];
  if (term) return term;
  return value
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Authorization scope types as users see them. */
export const SCOPE_TYPE_LABELS: Readonly<Record<string, string>> = {
  SYSTEM: 'All organizations',
  ORGANIZATION: 'Organization',
  ORGANIZATIONAL_UNIT: 'Business Unit',
  DEPARTMENT: 'Department',
  TEAM: 'Team',
};

export function scopeTypeLabel(type: string | null | undefined): string {
  return (type && SCOPE_TYPE_LABELS[type]) || enumLabel(type);
}

/** Account (user) statuses. */
export const ACCOUNT_STATUS_LABELS: Readonly<Record<string, string>> = {
  ACTIVE: 'Active',
  INVITED: 'Invited',
  PENDING_VERIFICATION: 'Pending verification',
  LOCKED: 'Locked',
  DISABLED: 'Disabled',
  SUSPENDED: 'Suspended',
};

export function accountStatusLabel(status: string | null | undefined): string {
  return (status && ACCOUNT_STATUS_LABELS[status]) || enumLabel(status);
}
