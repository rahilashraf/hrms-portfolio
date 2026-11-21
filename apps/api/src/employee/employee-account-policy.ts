import { ForbiddenException } from '@nestjs/common';
import { domainError, localDateOf } from '../common/domain-support.js';
import { resolveAssignmentTimezone } from './employee-domain.service.js';

/**
 * Security remediation M1 — the pure rules of cross-organization account administration.
 *
 * Every login-access action has a class. PROTECTIVE actions (disable, sign out, cancel a pending
 * invitation) may follow a person for a while after their employment in the actor's scope ended,
 * so offboarding still works; RESTORATIVE (credential) actions need a current assignment. Both
 * also need complete grant coverage, checked by EmployeeAccountService.
 */

export const ACCOUNT_ACTIONS = [
  'invite',
  'resend',
  'cancel',
  'disable',
  'enable',
  'requirePasswordChange',
  'sendPasswordReset',
  'signOut',
  'unlock',
] as const;
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];

export type AccountActionClass = 'PROTECTIVE' | 'RESTORATIVE';

export const ACCOUNT_ACTION_CLASS: Record<AccountAction, AccountActionClass> = {
  invite: 'RESTORATIVE',
  resend: 'RESTORATIVE',
  cancel: 'PROTECTIVE',
  disable: 'PROTECTIVE',
  enable: 'RESTORATIVE',
  // Forces a credential flow the target's other administrators did not start: restorative.
  requirePasswordChange: 'RESTORATIVE',
  sendPasswordReset: 'RESTORATIVE',
  signOut: 'PROTECTIVE',
  unlock: 'RESTORATIVE',
};

/** Days after an assignment's inclusive end date during which it still authorizes protection. */
export const PROTECTIVE_WINDOW_DAYS = 90;

const DAY_MS = 86_400_000;

/** The last business date on which an assignment ended on `endDate` authorizes protection. */
export function protectiveWindowLastDay(endDate: Date): Date {
  return new Date(endDate.getTime() + PROTECTIVE_WINDOW_DAYS * DAY_MS);
}

/**
 * The assignment's business date at `instant`, with the lifecycle's time zone semantics (work
 * location, else organization; UTC when neither resolves).
 */
export function assignmentBusinessDate(
  position: {
    workLocation?: { timezone: string | null } | null;
    organization?: { timezone: string | null } | null;
  },
  instant: Date,
): Date {
  let timezone = 'UTC';
  try {
    timezone = resolveAssignmentTimezone(position);
  } catch {
    timezone = 'UTC';
  }
  return localDateOf(instant, timezone);
}

/**
 * Whether one employment assignment authorizes an action class on its business date. ACTIVE and
 * PLANNED authorize everything; an ENDED assignment authorizes protection through the 90th day
 * after its end date (inclusive); nothing else authorizes anything.
 */
export function assignmentQualifies(
  actionClass: AccountActionClass,
  assignment: { status: string; endDate: Date | null },
  businessDate: Date,
): boolean {
  if (assignment.status === 'ACTIVE' || assignment.status === 'PLANNED')
    return true;
  if (actionClass !== 'PROTECTIVE' || assignment.status !== 'ENDED')
    return false;
  if (!assignment.endDate) return false;
  return (
    businessDate.getTime() <=
    protectiveWindowLastDay(assignment.endDate).getTime()
  );
}

/** Why an action is refused by the M1 policy (safe to show: names no organization or role). */
export type AccountScopeReason =
  'NO_CURRENT_ASSIGNMENT' | 'PROTECTIVE_WINDOW_ENDED' | 'ACCESS_OUTSIDE_SCOPE';

/** Every refusal category recorded in the audit log (the earlier refusals included). */
export type AccountRefusalCategory =
  | AccountScopeReason
  | 'NO_ACCOUNT_AUTHORITY'
  | 'SELF_MANAGEMENT'
  | 'SYSTEM_OWNER_PROTECTED';

const SCOPE_MESSAGES: Record<AccountScopeReason, string> = {
  NO_CURRENT_ASSIGNMENT:
    'This action needs a current assignment in your administrative scope.',
  PROTECTIVE_WINDOW_ENDED:
    'This person’s employment in your scope ended more than 90 days ago.',
  ACCESS_OUTSIDE_SCOPE:
    'This person has access outside your administrative scope.',
};

/** The 403 an M1 policy refusal returns: a stable code and a safe reason, nothing else. */
export function accountOutsideScope(reason: AccountScopeReason) {
  return new ForbiddenException(
    domainError(403, 'ACCOUNT_OUTSIDE_SCOPE', SCOPE_MESSAGES[reason], {
      reason,
    }),
  );
}

// ─── High-risk refusals ──────────────────────────────────────────────────────

export type AccountRiskCategory =
  'SYSTEM_PRIVILEGED_TARGET' | 'CROSS_ORGANIZATION' | 'REPEATED_REFUSALS';

/** This many refused restorative attempts by one actor within the window are "repeated". */
export const REPEATED_REFUSAL_THRESHOLD = 3;
export const REPEATED_REFUSAL_WINDOW_MS = DAY_MS;

/**
 * Deterministic high-risk classification of a refused attempt (most severe first):
 * - the target holds a SYSTEM-scope grant or the System Owner role;
 * - the target is employed or holds access in an organization where the actor has no authority
 *   over them (an unrelated organization);
 * - this is at least the third refused restorative attempt by the actor within 24 hours.
 */
export function classifyRefusalRisk(input: {
  actionClass: AccountActionClass;
  targetSystemPrivileged: boolean;
  crossOrganization: boolean;
  /** Refused restorative attempts by the same actor in the window, before this one. */
  priorRestorativeRefusals: number;
}): AccountRiskCategory | null {
  if (input.targetSystemPrivileged) return 'SYSTEM_PRIVILEGED_TARGET';
  if (input.crossOrganization) return 'CROSS_ORGANIZATION';
  if (
    input.actionClass === 'RESTORATIVE' &&
    input.priorRestorativeRefusals + 1 >= REPEATED_REFUSAL_THRESHOLD
  )
    return 'REPEATED_REFUSALS';
  return null;
}

/**
 * The notification dedupe key of an alert: one per actor and subject per UTC hour, or, for
 * repeated refusals, one per actor per UTC day whatever the targets.
 */
export function refusalAlertDedupeKey(
  risk: AccountRiskCategory,
  actorUserId: string,
  subjectId: string,
  at: Date,
): string {
  const iso = at.toISOString();
  if (risk === 'REPEATED_REFUSALS')
    return `account-refused:${risk}:${actorUserId}:${iso.slice(0, 10)}`;
  return `account-refused:${risk}:${actorUserId}:${subjectId}:${iso.slice(0, 13)}`;
}

/**
 * At most this many distinct alerts per actor per UTC hour; beyond it, one summary alert for the
 * rest of the hour (a loop over many people cannot flood the security administrators).
 */
export const ALERTS_PER_ACTOR_PER_HOUR = 5;

/** The dedupe key of the hour's summary alert once the per-actor cap is reached. */
export function cappedAlertDedupeKey(actorUserId: string, at: Date): string {
  return `account-refused:CAPPED:${actorUserId}:${at.toISOString().slice(0, 13)}`;
}
