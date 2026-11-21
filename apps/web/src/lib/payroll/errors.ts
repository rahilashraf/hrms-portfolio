import { AuthApiError } from '../auth/types';
import { sharedErrorMessage } from '../features/errors';

/** Batch 6A: payroll refusals that are not a missing permission, said plainly. */
const FORBIDDEN_MESSAGES: Record<string, string> = {
  PAYROLL_SELF_ADJUSTMENT:
    'You cannot change your own pay. Ask another payroll administrator to make this change.',
  PAYROLL_SELF_APPROVAL:
    'You cannot approve or finalize a run that includes your own pay. Ask another payroll administrator.',
  PAYROLL_NOT_AN_EMPLOYEE: 'Your account is not linked to an employee record.',
};

/**
 * Security remediation M2: why an approval or finalization is not allowed (dual control and the
 * own-pay rule). The server decides; these are the explanations shown beside the actions and
 * for a refusal.
 */
export const PAYROLL_BLOCKED_MESSAGES: Record<string, string> = {
  OWN_PAY:
    'This run includes your own pay: another payroll administrator must approve and finalize it.',
  APPROVER_NOT_ELIGIBLE: 'Only an active administrator account can approve or finalize payroll.',
  CALCULATOR_UNKNOWN_RECALCULATE:
    'This run was calculated before calculations were attributed: recalculate it, then have someone else approve it.',
  CALCULATED_BY_YOU: 'You calculated this run: another administrator must approve and finalize it.',
  ADJUSTMENT_BY_YOU:
    'This run carries an adjustment you added: another administrator must approve it.',
  ADJUSTMENT_CANCELLED_BY_YOU:
    'You cancelled an adjustment this run carried: another administrator must approve it.',
  MANUAL_LINE_BY_YOU:
    'You added or reversed a manual line on this run: another administrator must approve it.',
  COMPENSATION_CHANGED_BY_YOU:
    'You changed compensation this run pays: another administrator must approve it.',
  INDEPENDENT_APPROVAL_REQUIRED:
    'This run’s approval was not independent of its preparation: recalculate it and have it approved again.',
};

export function isPayrollForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

/** Payroll errors carry a readable server message for validation, conflicts and staleness. */
export function payrollErrorMessage(error: unknown, fallback = 'Unable to load payroll.'): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) {
    const code = typeof error.details?.code === 'string' ? error.details.code : null;
    const reason = typeof error.details?.reason === 'string' ? error.details.reason : null;
    if (code === 'PAYROLL_SEPARATION_OF_DUTIES' && reason && PAYROLL_BLOCKED_MESSAGES[reason])
      return PAYROLL_BLOCKED_MESSAGES[reason];
    return (
      (code && FORBIDDEN_MESSAGES[code]) ||
      error.validationMessage ||
      'You do not have permission for this payroll action.'
    );
  }
  if (error.status === 404) return 'The payroll record was not found.';
  if (error.status === 409)
    return error.validationMessage || 'This payroll action conflicts with the current state.';
  if (error.status === 400)
    return error.validationMessage || 'Check the payroll details and try again.';
  if (error.status >= 500) return 'The Payroll service is unavailable. Please try again.';
  return fallback;
}
