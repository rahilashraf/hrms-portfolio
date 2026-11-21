import { AUTH_ERROR_MESSAGES, AuthApiError } from './types';
import type { AuthErrorCategory } from './types';

export function authErrorMessage(
  error: unknown,
  fallback: AuthErrorCategory = 'unexpected',
  unauthorizedMessage?: string,
): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'category' in error &&
    typeof error.category === 'string' &&
    error.category in AUTH_ERROR_MESSAGES
  ) {
    if (error.category === 'invalid-credentials' && unauthorizedMessage) {
      return unauthorizedMessage;
    }
    return AUTH_ERROR_MESSAGES[error.category as AuthErrorCategory];
  }
  return AUTH_ERROR_MESSAGES[fallback];
}

/** Shown whenever an API route refuses a request with 429 (Phase 19 rate limiting). */
export const RATE_LIMITED_MESSAGE = AUTH_ERROR_MESSAGES['rate-limited'];

/**
 * Whether an API error is a rate-limit refusal: 429 with the shared `RATE_LIMITED` code (the
 * client keeps 429 bodies in `details`), or a 429 without any code. A 429 carrying another
 * domain code (e.g. GOOGLE_SYNC_TOO_FREQUENT, KIOSK_RATE_LIMITED) is left to its domain.
 */
export function isRateLimited(error: unknown): boolean {
  if (!(error instanceof AuthApiError) || error.status !== 429) return false;
  const code = error.details?.code;
  return code === undefined || code === 'RATE_LIMITED';
}

/** The friendly rate-limit message (with the wait, when the API said), or null otherwise. */
export function rateLimitedMessage(error: unknown): string | null {
  if (!isRateLimited(error)) return null;
  const seconds = (error as AuthApiError).details?.retryAfterSeconds;
  if (typeof seconds !== 'number' || seconds <= 0) return RATE_LIMITED_MESSAGE;
  const wait =
    seconds < 60
      ? `${seconds} second${seconds === 1 ? '' : 's'}`
      : `${Math.ceil(seconds / 60)} minute${Math.ceil(seconds / 60) === 1 ? '' : 's'}`;
  return `Too many attempts — please wait about ${wait} and try again.`;
}
