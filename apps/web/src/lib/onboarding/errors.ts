import { AuthApiError } from '../auth/types';
import { sharedErrorMessage } from '../features/errors';

export function isOnboardingForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

/** The domain error code of a 400/403/409 onboarding response (e.g. WORKFLOW_ALREADY_ACTIVE). */
export function onboardingErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  return typeof code === 'string' ? code : null;
}

/** The active workflow a WORKFLOW_ALREADY_ACTIVE conflict points at, or null. */
export function activeWorkflowId(error: unknown): string | null {
  if (onboardingErrorCode(error) !== 'WORKFLOW_ALREADY_ACTIVE') return null;
  const id = (error as AuthApiError).details?.workflowId;
  return typeof id === 'string' ? id : null;
}

/** Onboarding errors carry a readable server message for validation and conflicts. */
export function onboardingErrorMessage(
  error: unknown,
  fallback = 'Unable to load onboarding information.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) {
    return error.validationMessage || 'You do not have permission for this onboarding action.';
  }
  if (error.status === 404) return 'The onboarding record was not found.';
  if (error.status === 409) {
    return error.validationMessage || 'This change conflicts with the current state of the record.';
  }
  if (error.status === 400) return error.validationMessage || 'Check the details and try again.';
  if (error.status >= 500) return 'The Onboarding service is unavailable. Please try again.';
  return fallback;
}
