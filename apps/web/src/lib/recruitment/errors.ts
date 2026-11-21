import { AuthApiError } from '../auth/types';
import type { PossibleEmployeeMatch } from './types';
import { sharedErrorMessage } from '../features/errors';

export function isRecruitmentForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

/** The domain error code of a 400/409 recruitment response (e.g. RECRUITMENT_OFFER_EXPIRED). */
export function recruitmentErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * The employees a hire conversion may duplicate (409 RECRUITMENT_POSSIBLE_EXISTING_EMPLOYEE),
 * or null for any other error.
 */
export function possibleExistingEmployees(error: unknown): PossibleEmployeeMatch[] | null {
  if (recruitmentErrorCode(error) !== 'RECRUITMENT_POSSIBLE_EXISTING_EMPLOYEE') return null;
  const matches = (error as AuthApiError).details?.matches;
  if (!Array.isArray(matches)) return [];
  return matches.filter(
    (match): match is PossibleEmployeeMatch =>
      typeof match === 'object' &&
      match !== null &&
      typeof (match as PossibleEmployeeMatch).employeeId === 'string',
  );
}

/** Recruitment errors carry a readable server message for validation and conflicts. */
export function recruitmentErrorMessage(
  error: unknown,
  fallback = 'Unable to load recruitment information.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) {
    return error.validationMessage || 'You do not have permission for this recruitment action.';
  }
  if (error.status === 404) return 'The recruitment record was not found.';
  if (error.status === 409) {
    return error.validationMessage || 'This change conflicts with the current state of the record.';
  }
  if (error.status === 400) return error.validationMessage || 'Check the details and try again.';
  if (error.status >= 500) return 'The Recruitment service is unavailable. Please try again.';
  return fallback;
}
