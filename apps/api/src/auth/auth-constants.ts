/** Account security limits and link lifetimes (shared by the API and the worker). */
export const FAILED_LOGIN_THRESHOLD = 5;
export const TEMPORARY_LOCK_MS = 15 * 60_000;
export const PASSWORD_RESET_TOKEN_LIFETIME_MS = 30 * 60_000;
export const INVITATION_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60_000;
export const EMAIL_VERIFICATION_TOKEN_LIFETIME_MS = 24 * 60 * 60_000;
