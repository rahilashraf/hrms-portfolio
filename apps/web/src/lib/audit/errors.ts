import { AuthApiError } from '../auth/types';
import { sharedErrorMessage } from '../features/errors';
import { AUDIT_MAX_RANGE_DAYS } from './types';

/** The domain code of an audit viewer error (400/404/429 bodies are kept by the client). */
export function auditErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  return typeof code === 'string' ? code : null;
}

export const AUDIT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  AUDIT_RANGE_INVALID: 'The start of the date range must be before its end.',
  AUDIT_RANGE_TOO_WIDE: `The date range may cover at most ${AUDIT_MAX_RANGE_DAYS} days. Narrow it and try again.`,
  AUDIT_CURSOR_INVALID: 'The list changed or the page link expired. Search again.',
};

export function auditErrorMessage(
  error: unknown,
  fallback = 'Unable to load the audit log.',
): string {
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  if (!(error instanceof AuthApiError)) return fallback;
  const code = auditErrorCode(error);
  if (code && AUDIT_ERROR_MESSAGES[code]) return AUDIT_ERROR_MESSAGES[code];
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403)
    return 'You do not have permission to read the audit log of this organization.';
  if (error.status === 404) return 'The organization was not found.';
  if (error.status === 400)
    return 'Check the filters: actions and entity types are codes, the actor is a user id (UUID) and dates must be valid.';
  if (error.status >= 500) return 'The audit log is unavailable. Please try again.';
  return fallback;
}
