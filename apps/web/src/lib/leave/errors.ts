import { AuthApiError } from '../auth/types';
import { sharedErrorMessage } from '../features/errors';

export function isForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

/** Leave domain errors carry a readable server message (and a code the UI does not need). */
export function leaveErrorMessage(error: unknown, fallback = 'Unable to load leave data.'): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) {
    // Batch 6B (D5): nobody records or decides their own leave, whatever they hold.
    if (error.details?.code === 'LEAVE_SELF_APPROVAL')
      return 'You cannot record, approve or decide your own leave. Ask another leave approver.';
    return 'You do not have permission for this leave action.';
  }
  if (error.status === 404) return 'The requested leave record was not found.';
  if (error.status === 409)
    return error.validationMessage || 'This leave action conflicts with current data.';
  if (error.status === 400)
    return error.validationMessage || 'Check the leave details and try again.';
  if (error.status >= 500) return 'The Leave service is unavailable. Please try again.';
  return fallback;
}
