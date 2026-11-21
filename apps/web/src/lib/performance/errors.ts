import { AuthApiError } from '../auth/types';
import { sharedErrorMessage } from '../features/errors';

export function isPerformanceForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

/** Performance errors carry a readable server message for validation and conflicts. */
export function performanceErrorMessage(
  error: unknown,
  fallback = 'Unable to load performance information.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) {
    return error.validationMessage || 'You do not have permission for this performance action.';
  }
  if (error.status === 404) return 'The performance record was not found.';
  if (error.status === 409) {
    return error.validationMessage || 'This change conflicts with the current state of the record.';
  }
  if (error.status === 400) return error.validationMessage || 'Check the details and try again.';
  if (error.status >= 500) return 'The Performance service is unavailable. Please try again.';
  return fallback;
}

/** Batch 7B: the domain error code of a performance response (e.g. PERFORMANCE_GOAL_MANAGER_SET). */
export function performanceErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * Batch 7B: why a performance read failed, so pages never show a false empty state —
 * the account has no employee record, Performance is switched off, another permission
 * refusal, or any other failure.
 */
export type PerformanceFailureKind = 'NOT_EMPLOYEE' | 'MODULE_DISABLED' | 'FORBIDDEN' | 'ERROR';

export function performanceFailureKind(error: unknown): PerformanceFailureKind {
  const code = performanceErrorCode(error);
  if (code === 'PERFORMANCE_NOT_AN_EMPLOYEE') return 'NOT_EMPLOYEE';
  if (code === 'FEATURE_DISABLED') return 'MODULE_DISABLED';
  if (isPerformanceForbidden(error)) return 'FORBIDDEN';
  return 'ERROR';
}
