/**
 * Batch R4-A.2 — how an HR profile edit is recorded in the `EMPLOYEE_UPDATED` audit entry.
 *
 * Each field that actually changed is listed with a masked hint of its value before and after
 * (null when empty), so the entry shows what changed, and roughly how, without the append-only
 * audit log becoming a copy of personal data (Phase 19: the log holds identifiers, not names or
 * contact details):
 * - names (legal and preferred): first character only (`A***`);
 * - personal email: first character and top-level domain only (`a***@***.com`);
 * - phone: last two digits only (`***34`).
 * The full values stay on the person record, behind its own access control.
 *
 * Unchanged fields (omitted, or sent with their current value) are not recorded. Nothing else
 * from the person (or any credential) is included.
 */
export const PROFILE_FIELDS = [
  'firstName',
  'middleName',
  'lastName',
  'preferredName',
  'personalEmail',
  'phone',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** Legal identity: may be corrected, never cleared. */
export const REQUIRED_PROFILE_FIELDS: readonly ProfileField[] = [
  'firstName',
  'lastName',
];

/** `Ada` → `A***` (the first character, never more); empty → `***`. */
export function maskName(value: string): string {
  const first = Array.from(value.trim())[0];
  return first ? `${first}***` : '***';
}

/**
 * `ada@lovelace.example` → `a***@***.example`: the first character and the top-level domain only
 * (a personal domain can itself identify someone). Anything without a usable `@` → `***`.
 */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return '***';
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot >= 0 && dot < domain.length - 1 ? domain.slice(dot) : '';
  return `${Array.from(value)[0]}***@***${tld}`;
}

/** `+1 (416) 555-0134` → `***34`; fewer than four digits → `***`. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-2)}` : '***';
}

function represent(field: ProfileField, value: string | null): string | null {
  if (value === null) return null;
  if (field === 'personalEmail') return maskEmail(value);
  if (field === 'phone') return maskPhone(value);
  return maskName(value);
}

export interface ProfileAuditChanges {
  /** Fields whose value changed (including those cleared), sorted. */
  changed: ProfileField[];
  /** Fields set to empty (null), sorted. */
  cleared: ProfileField[];
  /** Masked before and after for each changed field (null when empty). */
  changes: Partial<
    Record<ProfileField, { before: string | null; after: string | null }>
  >;
  /** The changed fields whose values are masked above (every changed field). */
  masked: ProfileField[];
}

export function profileAuditChanges(
  before: Record<ProfileField, string | null>,
  input: Partial<Record<ProfileField, string | null | undefined>>,
): ProfileAuditChanges {
  const result: ProfileAuditChanges = {
    changed: [],
    cleared: [],
    changes: {},
    masked: [],
  };
  for (const field of PROFILE_FIELDS) {
    const next = input[field];
    if (next === undefined) continue;
    const previous = before[field] ?? null;
    if (next === previous) continue;
    result.changed.push(field);
    if (next === null) result.cleared.push(field);
    result.changes[field] = {
      before: represent(field, previous),
      after: represent(field, next),
    };
    result.masked.push(field);
  }
  result.changed.sort();
  result.cleared.sort();
  result.masked.sort();
  return result;
}
