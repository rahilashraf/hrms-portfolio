import { AuthApiError } from '../auth/types';
import { sharedErrorMessage } from '../features/errors';

export function isBenefitsForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

/** Batch 7C: the domain error code of a benefits response (e.g. BENEFIT_NOT_ELIGIBLE). */
export function benefitsErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * Batch 7C: what each domain refusal means for the person acting, in their words (the API's
 * own message stays the fallback for codes without a better explanation here).
 */
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  BENEFIT_SELF_MANAGEMENT:
    'You cannot change your own benefits; ask another benefits administrator.',
  BENEFIT_PERMISSION_REQUIRED: 'You do not have permission for this benefits action.',
  BENEFIT_NOT_AN_EMPLOYEE: 'Your account is not linked to an employee record.',
  BENEFIT_NOT_ELIGIBLE:
    'The assignment is not eligible for this plan on that date. Give an override reason to continue anyway.',
  BENEFIT_ELECTION_HISTORICAL:
    'This coverage has already ended. Fix past coverage with a correction instead.',
  BENEFIT_LATER_COVERAGE:
    'Coverage continues in a later election of this plan. End or rescind that election first.',
  BENEFIT_DEPENDENT_HISTORY_CONFLICT:
    'This change would make recorded coverage invalid. Correct the elections covering this dependent first.',
  BENEFIT_DEPENDENT_INELIGIBLE:
    'A selected dependent is not eligible (relationship dates, age limit or archived). Remove them from the coverage.',
  BENEFIT_DEPENDENT_COVERED:
    'The dependent is covered by current or future elections. Change those elections first.',
  BENEFIT_DEPENDENT_RELATIONSHIP_FIXED:
    'A dependent who has been covered keeps their relationship. Add a new dependent instead.',
  BENEFIT_ARCHIVED: 'This plan or option is archived; it can no longer be changed.',
  BENEFIT_PLAN_HAS_COVERAGE:
    'Elections still continue under this plan. End them first, or end them with the plan.',
  BENEFIT_PLAN_HAS_NO_OPTIONS: 'Add a coverage option before activating the plan.',
  BENEFIT_OPTION_HAS_COVERAGE: 'Elections still use this option. Change or end them first.',
  BENEFIT_PLAN_START_AFTER_RATE:
    'A rate starts before that date. Correct the rate before moving the plan start.',
  BENEFIT_RATE_GAP_EXCEEDED:
    'A later rate starts before this one would end. End this rate by the day before that rate.',
  BENEFIT_RATE_FUTURE_EXISTS:
    'A rate already starts on or after this date. Correct that rate instead.',
  BENEFIT_RATE_EXISTS: 'A rate already starts on this date. Correct that rate instead.',
  BENEFIT_RATE_OVERLAP: 'The dates overlap another rate of this option.',
  BENEFIT_RATE_SUPERSEDED: 'This rate was already corrected. Correct its replacement instead.',
  BENEFIT_ELECTION_OVERLAP:
    'The employee already has an election for this plan on these dates. Change or end it instead.',
  BENEFIT_ELECTION_SUPERSEDED:
    'This election was replaced meanwhile. Reload and act on its replacement.',
  BENEFIT_REASON_REQUIRED: 'Give a reason for this change.',
  BENEFIT_PLAN_CODE_TAKEN: 'Another plan of the organization already uses this code.',
  BENEFIT_PLAN_DATES_CONFLICT:
    'Rates or elections fall outside the new plan dates. Reload and try again.',
};

/** Benefits errors carry a readable server message for validation and conflicts. */
export function benefitsErrorMessage(
  error: unknown,
  fallback = 'Unable to load benefits.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  const code = benefitsErrorCode(error);
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403)
    return error.validationMessage || 'You do not have permission for this benefits action.';
  if (error.status === 404) return 'The benefits record was not found. It may have been removed.';
  if (error.status === 409)
    return error.validationMessage || 'This benefits change conflicts with current data.';
  if (error.status === 400)
    return error.validationMessage || 'Check the benefits details and try again.';
  if (error.status >= 500) return 'The Benefits service is unavailable. Please try again.';
  return fallback;
}

/**
 * Batch 7C: why a benefits read failed, so pages never show a false empty state — the account
 * has no employee record, Benefits is switched off, another permission refusal, or any other
 * failure.
 */
export type BenefitsFailureKind = 'NOT_EMPLOYEE' | 'MODULE_DISABLED' | 'FORBIDDEN' | 'ERROR';

export function benefitsFailureKind(error: unknown): BenefitsFailureKind {
  const code = benefitsErrorCode(error);
  if (code === 'BENEFIT_NOT_AN_EMPLOYEE') return 'NOT_EMPLOYEE';
  if (code === 'FEATURE_DISABLED') return 'MODULE_DISABLED';
  if (isBenefitsForbidden(error)) return 'FORBIDDEN';
  return 'ERROR';
}
