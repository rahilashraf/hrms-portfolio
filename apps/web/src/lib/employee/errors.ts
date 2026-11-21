import { rateLimitedMessage } from '../auth/error-message';
import { AuthApiError } from '../auth/types';
import type { EmployeeAccountScopeReason } from './types';

export function employeeErrorMessage(
  error: unknown,
  fallback = 'Unable to load employees.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  if (error.validationMessage) return error.validationMessage;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) return 'You do not have permission to view employees.';
  if (error.status === 404) return 'Employee not found.';
  if (error.status >= 500) return 'The Employee service is unavailable. Please try again.';
  return fallback;
}

export function employeeActionErrorMessage(
  error: unknown,
  fallback = 'Unable to save employee changes.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  if (error.validationMessage) return error.validationMessage;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) return 'You do not have permission to manage employees.';
  if (error.status === 404) return 'Employee not found.';
  if (error.status >= 500) return 'The Employee service is unavailable. Please try again.';
  return fallback;
}

export function employeeAssignmentActionErrorMessage(
  error: unknown,
  fallback = 'Unable to update assignment.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  // Batch 5E: the lifecycle codes assignment changes share (one's own employment, an inactive
  // or terminated employee, incomplete authority) are explained, not reduced to "no permission".
  const code = lifecycleErrorCode(error);
  if (code && LIFECYCLE_CODE_MESSAGES[code]) return lifecycleCodeMessage(error, code);
  if (error.validationMessage) return error.validationMessage;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) return 'You do not have permission to manage this assignment.';
  if (error.status === 404) return 'Employee or assignment not found.';
  if (error.status >= 500) return 'The Employee service is unavailable. Please try again.';
  return fallback;
}

export function employeeManagerActionErrorMessage(
  error: unknown,
  fallback = 'Unable to update manager.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  if (error.validationMessage) return error.validationMessage;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) return 'You do not have permission to manage this assignment.';
  if (error.status === 404) return 'Employee, assignment, or manager not found.';
  if (error.status >= 500) return 'The Employee service is unavailable. Please try again.';
  return fallback;
}

/**
 * Batch 5C: lifecycle and transfer domain codes, explained in plain language. The server message
 * is used for any code not listed (it is written for people, too).
 */
const LIFECYCLE_CODE_MESSAGES: Record<string, string> = {
  LIFECYCLE_SCOPE_INCOMPLETE:
    'This change affects employment you do not manage. An administrator of every affected organization, or a System administrator, must make it.',
  LIFECYCLE_SELF_TARGET: 'You cannot change your own employment.',
  LIFECYCLE_FINALIZED_RECORDS:
    'Approved timesheets or finalized payroll fall after this date. Choose a later date, or have those records reopened first.',
  TERMINATION_ALREADY_SCHEDULED:
    'A termination is already scheduled for this employee. Reschedule or cancel it instead.',
  TERMINATION_ALREADY_EFFECTIVE:
    'This termination has already taken effect for at least one assignment and can no longer be changed.',
  TERMINATION_NOT_SCHEDULED: 'This termination is no longer scheduled. Refresh to see its status.',
  TERMINATION_NOT_DUE:
    'This termination is not due yet: the last day has not passed in any affected time zone.',
  TERMINATION_BEFORE_HIRE: 'The last day of employment cannot be before the hire date.',
  TERMINATION_ASSIGNMENT_CHANGED:
    'The employee’s assignments changed after this termination was scheduled. Refresh and review it.',
  TERMINATION_SYSTEM_ACTOR_REQUIRED:
    'This employee holds System-level roles; only a System administrator can terminate them.',
  TERMINATION_SYSTEM_GRANTS_ACK_REQUIRED:
    'This employee holds System-level roles. Decide for each one whether it is revoked or kept.',
  TERMINATION_GRANT_DECISION_REQUIRED:
    'Each System-level role needs a decision: revoke it, or request to keep it until a date. A System administrator decides.',
  TERMINATION_KEEP_APPROVAL_INVALID:
    'An approved exception for a System-level role is no longer valid: its approver can no longer grant that role, or the role changed. Record a new decision and have an eligible System administrator approve it.',
  TERMINATION_KEEP_APPROVAL_REQUIRED:
    'A request to keep a System-level role is waiting for approval by another System administrator. Approve, reject or withdraw it first.',
  TERMINATION_KEEP_INVALID:
    'A role can be kept only with a reason of at least 10 characters and an end date no later than 30 days after the last day, for a grant that is still in place.',
  TERMINATION_KEEP_EXPIRED:
    'This request to keep a role has already expired. Record a new decision.',
  TERMINATION_KEEP_OUTSIDE_SCOPE:
    'This role grant is not in an organization the termination ends, so the termination does not change it.',
  TERMINATION_KEEP_NOT_AUTHORIZED:
    'You cannot decide about this role grant. Approving a keep needs the authority to grant this role where it applies: role assignment there, plus each of the role’s permissions.',
  TERMINATION_KEEP_NOT_PENDING:
    'This request is no longer waiting for approval. Refresh to see its status.',
  TERMINATION_KEEP_SELF_APPROVAL:
    'You requested this exception, so you cannot approve or reject it. Another administrator must review it.',
  EMPLOYEE_ALREADY_TERMINATED: 'This employee is already terminated.',
  EMPLOYEE_NOT_ACTIVE: 'Only an active employee can be changed this way.',
  EMPLOYEE_NOT_INACTIVE: 'Only an inactive employee can be reactivated.',
  EMPLOYEE_NOT_TERMINATED: 'Only a terminated employee can be rehired.',
  EMPLOYEE_CHANGED_CONCURRENTLY:
    'Someone else changed this employee at the same time. Refresh and try again.',
  REHIRE_ASSIGNMENT_REQUIRED: 'A rehire needs the new assignment.',
  REHIRE_BEFORE_TERMINATION: 'The new assignment must start after the last day of employment.',
  ASSIGNMENT_IN_SCHEDULED_TERMINATION:
    'This assignment is part of a scheduled termination. Change the termination instead.',
  TRANSFER_SAME_POSITION: 'Choose a different position for the transfer.',
  TRANSFER_SOURCE_NOT_ACTIVE: 'Only a current assignment can be transferred.',
  TRANSFER_SOURCE_CHANGED:
    'This assignment changed after you opened the transfer. Refresh and try again.',
  TRANSFER_DATE_OUTSIDE_ASSIGNMENT:
    'The effective date must fall after the assignment’s start and on or before its end.',
  MANAGER_ORGANIZATION_MISMATCH: 'The manager must work in the same organization.',
  MANAGER_ASSIGNMENT_ENDED: 'The chosen manager’s assignment has ended.',
  POSITION_ARCHIVED: 'The chosen position is archived.',
  ORGANIZATION_ARCHIVED: 'The organization is archived.',
};

/** Batch 5E: LIFECYCLE_SELF_TARGET names the refused action; say what was refused. */
const SELF_TARGET_MESSAGES: Record<string, string> = {
  REVOKE_GRANTS:
    'You cannot revoke grants on your own employment record. Ask another administrator.',
  CREATE_ASSIGNMENT: 'You cannot change your own assignments. Ask another administrator.',
  CORRECT_ASSIGNMENT: 'You cannot change your own assignments. Ask another administrator.',
  ACTIVATE_ASSIGNMENT: 'You cannot change your own assignments. Ask another administrator.',
  APPLY_ASSIGNMENT_END: 'You cannot change your own assignments. Ask another administrator.',
  TRANSFER_ASSIGNMENT: 'You cannot transfer your own assignment. Ask another administrator.',
};

function lifecycleCodeMessage(error: AuthApiError, code: string): string {
  if (code === 'LIFECYCLE_SELF_TARGET') {
    const action = error.details?.action;
    if (typeof action === 'string' && SELF_TARGET_MESSAGES[action])
      return SELF_TARGET_MESSAGES[action];
  }
  return LIFECYCLE_CODE_MESSAGES[code]!;
}

export function lifecycleErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  return typeof code === 'string' ? code : null;
}

export function employeeLifecycleActionErrorMessage(
  error: unknown,
  fallback = 'Unable to update employee status.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const code = lifecycleErrorCode(error);
  if (code && LIFECYCLE_CODE_MESSAGES[code]) return lifecycleCodeMessage(error, code);
  if (error.validationMessage) return error.validationMessage;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403)
    return 'You do not have permission to change this employee’s employment.';
  if (error.status === 409)
    return 'This employee changed while you were working. Refresh and try again.';
  if (error.status === 404) return 'Employee not found.';
  if (error.status >= 500) return 'The Employee service is unavailable. Please try again.';
  return fallback;
}

/**
 * Batch 5E: revoking grants from the access review. The API checks every selected grant before
 * revoking any (all or nothing), so a refusal means nothing changed.
 */
export function revokeGrantsErrorMessage(error: unknown): string {
  const fallback = 'Unable to revoke these grants.';
  if (!(error instanceof AuthApiError)) return fallback;
  const code = lifecycleErrorCode(error);
  if (code && LIFECYCLE_CODE_MESSAGES[code])
    return `${lifecycleCodeMessage(error, code)} Nothing was revoked.`;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 404)
    return 'A selected grant, the employee or their login is no longer available to you. Nothing was revoked; refresh the access review.';
  if (error.status === 403) {
    const message = error.details?.message;
    if (typeof message === 'string' && /System Owner/i.test(message))
      return 'System Owner grants are managed at setup and cannot be revoked here. Nothing was revoked.';
    return 'You do not have permission to revoke one of the selected grants. Nothing was revoked.';
  }
  return employeeLifecycleActionErrorMessage(error, fallback);
}

export function isEmployeeForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

/** Login access errors: email configuration and delivery are explained, not hidden. */
/** Security remediation M1: why a login-access action is unavailable (no hidden details). */
export const ACCOUNT_SCOPE_REASON_TEXT: Record<EmployeeAccountScopeReason, string> = {
  ACCESS_OUTSIDE_SCOPE:
    'This person has access outside your administrative scope. An administrator who covers all of their access can do this.',
  NO_CURRENT_ASSIGNMENT: 'This needs a current assignment in your administrative scope.',
  PROTECTIVE_WINDOW_ENDED:
    'Their employment in your scope ended more than 90 days ago, so you can no longer change this login.',
};

export function employeeAccountErrorMessage(
  error: unknown,
  fallback = 'Unable to update login access.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const code = error.details?.code;
  if (code === 'ACCOUNT_EMAIL_UNAVAILABLE')
    return 'Account email is not set up. Connect Google Workspace with Gmail sending for this organization, or ask the system administrator to configure the SMTP server, then try again.';
  if (code === 'ACCOUNT_EMAIL_DELIVERY_FAILED')
    return 'The email could not be sent. No link was left usable; try again later.';
  // Security remediation M1: a scope refusal (e.g. the flags were stale), with its safe reason.
  if (code === 'ACCOUNT_OUTSIDE_SCOPE') {
    const reason = error.details?.reason;
    return typeof reason === 'string' && Object.hasOwn(ACCOUNT_SCOPE_REASON_TEXT, reason)
      ? ACCOUNT_SCOPE_REASON_TEXT[reason as EmployeeAccountScopeReason]
      : ACCOUNT_SCOPE_REASON_TEXT.ACCESS_OUTSIDE_SCOPE;
  }
  if (error.validationMessage) return error.validationMessage;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403)
    return 'You do not have permission to manage this employee’s login access.';
  if (error.status === 404) return 'Employee not found.';
  if (error.status === 429)
    return rateLimitedMessage(error) ?? 'Too many requests. Please wait a moment and try again.';
  if (error.status >= 500) return 'The Employee service is unavailable. Please try again.';
  return fallback;
}
