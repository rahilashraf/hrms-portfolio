import { AuthApiError } from '../auth/types';
import { sharedErrorMessage } from '../features/errors';

export function isCompensationForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

/** Compensation errors carry a readable server message for validation and conflicts. */
export function compensationErrorMessage(
  error: unknown,
  fallback = 'Unable to load compensation.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403)
    return 'You do not have permission to view or change this compensation.';
  if (error.status === 404) return 'The compensation record or assignment was not found.';
  if (error.status === 409)
    return error.validationMessage || 'This compensation change conflicts with current data.';
  if (error.status === 400)
    return error.validationMessage || 'Check the compensation details and try again.';
  if (error.status >= 500) return 'The Compensation service is unavailable. Please try again.';
  return fallback;
}
