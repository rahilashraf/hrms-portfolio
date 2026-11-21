import { RATE_LIMITED_MESSAGE } from '../auth/error-message';
import { AuthApiError } from '../auth/types';
import { featureDisabledMessage } from '../features/errors';

export function isGoogleWorkspaceForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

/** The domain error code of a Google Workspace error response, inferred for 429. */
export function googleWorkspaceErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  if (typeof code === 'string') return code;
  // A 429 without a body: the manual sync throttle (the client keeps 429 bodies, so the shared
  // Phase 19 rate limit arrives as RATE_LIMITED).
  if (error.status === 429) return 'GOOGLE_SYNC_TOO_FREQUENT';
  return null;
}

/**
 * Friendly text for every Google Workspace error code: API errors, OAuth callback results,
 * and the codes recorded on connections, bindings and sync runs.
 */
export const GOOGLE_WORKSPACE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // Deployment configuration
  GOOGLE_OAUTH_NOT_CONFIGURED:
    'Google sign-in is not configured for this deployment. Ask the platform operator to set up the Google OAuth client.',
  INTEGRATION_ENCRYPTION_NOT_CONFIGURED:
    'Credential encryption is not configured for this deployment, so no Google credentials can be stored. Ask the platform operator to configure it.',
  INTEGRATION_KEY_UNAVAILABLE:
    'The stored Google credentials cannot be decrypted (the encryption key is unavailable). Reconnect Google Workspace.',
  INTEGRATION_CIPHERTEXT_INVALID:
    'The stored Google credentials are unreadable. Disconnect and connect Google Workspace again.',

  // OAuth authorization and callback
  OAUTH_STATE_INVALID: 'The Google authorization link is invalid. Start the connection again.',
  OAUTH_STATE_USED: 'This Google authorization was already used. Start the connection again.',
  OAUTH_STATE_EXPIRED:
    'The Google authorization took longer than 10 minutes and expired. Start the connection again.',
  OAUTH_STATE_OTHER_USER:
    'The Google authorization was started by another user or in another browser. Start the connection again from this browser.',
  OAUTH_STATE_UNBOUND:
    'The Google authorization could not be matched to this browser (cookies may be blocked). Allow cookies and start again.',
  OAUTH_DENIED: 'Access was not granted in Google. Nothing was connected.',
  OAUTH_FORBIDDEN:
    'You no longer have permission to manage the Google Workspace integration for this organization.',
  OAUTH_EXCHANGE_FAILED: 'Google did not complete the authorization. Please try again.',
  OAUTH_IDENTITY_INVALID: 'Google did not confirm the account’s verified email. Please try again.',
  OAUTH_NO_REFRESH_TOKEN:
    'Google did not grant offline access. Remove the HRMS from the account’s third-party access in Google and connect again.',
  OAUTH_SCOPES_NOT_GRANTED:
    'None of the selected capabilities were fully granted. Connect again and allow every requested permission.',
  OAUTH_FAILED: 'The Google connection could not be completed. Please try again.',
  GOOGLE_WORKSPACE_ACCOUNT_REQUIRED:
    'Sign in with a Google Workspace account (a personal Gmail account cannot be connected).',
  GOOGLE_WORKSPACE_DOMAIN_MISMATCH:
    'The organization is connected to a different Workspace domain. Disconnect it before connecting another domain.',
  GOOGLE_CONNECTION_MODE_CONFLICT:
    'The organization is connected with the other connection method. Disconnect it first.',

  // Connection
  GOOGLE_CAPABILITY_REQUIRED: 'Select at least one capability.',
  GOOGLE_IMPERSONATED_USER_INVALID:
    'Enter the email of the Workspace user the service account acts as.',
  SERVICE_ACCOUNT_KEY_NOT_JSON:
    'The service-account key is not valid JSON. Paste the whole key file.',
  SERVICE_ACCOUNT_KEY_TYPE: 'The key is not a Google service-account key.',
  SERVICE_ACCOUNT_KEY_FIELDS:
    'The service-account key is missing its client email, key id, private key or project id.',
  SERVICE_ACCOUNT_KEY_TOKEN_URI: 'The service-account key must use Google’s token endpoint.',
  SERVICE_ACCOUNT_KEY_PRIVATE_KEY: 'The service-account private key is not a valid RSA key.',
  GOOGLE_SERVICE_ACCOUNT_REJECTED:
    'Google did not issue a token for this key, user and capabilities. Check that a Workspace super-admin configured domain-wide delegation for exactly these scopes.',
  GOOGLE_CONNECTION_NOT_FOUND: 'The organization is not connected to Google Workspace.',
  GOOGLE_CONNECTION_CHANGED: 'The connection changed meanwhile. Reload and try again.',
  GOOGLE_CONNECTION_REQUIRED:
    'Connect Google Workspace with the Forms capability (and an active connection) first.',
  GOOGLE_NOT_CONNECTED: 'The organization has no active Google Workspace connection.',
  GOOGLE_HEALTH_CHECK_FAILED: 'The health check could not reach Google. Try again later.',

  // Form bindings
  GOOGLE_FORM_ID_INVALID:
    'The form id is 10–200 letters, digits, "_" or "-" (the part of the form’s edit link after /d/).',
  GOOGLE_MAPPING_INVALID: 'The field mapping is invalid. Check each question id and field.',
  GOOGLE_MAPPING_VERSION: 'The mapping format is out of date. Reload the page and try again.',
  GOOGLE_MAPPING_FIELD: 'A question is mapped to a field this target does not accept.',
  GOOGLE_MAPPING_DUPLICATE:
    'A question is mapped twice, or a single-value field is mapped to more than one question.',
  GOOGLE_MAPPING_REQUIRED:
    'A required field is not mapped (recruitment intake needs the candidate’s first and last name).',
  GOOGLE_MAPPING_UNKNOWN_QUESTION: 'A mapped question id does not exist in the form.',
  GOOGLE_MAPPING_QUESTION_KIND:
    'Document fields must map file-upload questions, and other fields must not.',
  GOOGLE_BINDING_SOURCE_NOT_ALLOWED: 'This target does not take a source.',
  GOOGLE_BINDING_SOURCE_REQUIRED: 'Choose the source this form feeds.',
  GOOGLE_SOURCE_NOT_FOUND: 'The source was not found in this organization.',
  GOOGLE_SOURCE_ARCHIVED: 'The source is archived.',
  GOOGLE_SOURCE_PROVIDER: 'The source is not a Google Forms source.',
  GOOGLE_SOURCE_FORM_MISMATCH: 'The source is configured for a different form id.',
  GOOGLE_FORM_ALREADY_BOUND:
    'This form or source already has a live binding (or the form is bound by another organization).',
  GOOGLE_FORM_NOT_ACCESSIBLE: 'The connected Google account cannot open this form.',
  GOOGLE_FORM_CHECK_FAILED: 'The form could not be checked with Google. Try again.',
  GOOGLE_FORM_EMAIL_NOT_COLLECTED:
    'The form does not collect respondent emails. Map an email question or turn on email collection.',
  // Batch 7B (D1): identity comes from Google-verified emails only.
  GOOGLE_FORM_EMAIL_NOT_VERIFIED:
    'Set the form to collect verified email addresses (Settings → Responses → Collect email addresses: Verified). Typed email answers are not proof of who responded.',
  GOOGLE_FORM_IDENTITY_UNVERIFIED:
    'The form no longer collects verified email addresses. New responses are held for review and never matched to employees automatically. Turn on verified email collection.',
  GOOGLE_FORM_TOO_MANY_RESPONSES:
    'The form has too many new responses for one synchronization. It continues on the next run.',
  GOOGLE_BINDING_NOT_FOUND: 'The form binding was not found.',
  GOOGLE_BINDING_ARCHIVED: 'The form binding is archived and can no longer be changed.',

  // Synchronization
  GOOGLE_BINDING_DISABLED: 'The form binding is disabled. Enable it before synchronizing.',
  GOOGLE_SYNC_IN_PROGRESS:
    'A synchronization of this form is already running. Wait for it to finish.',
  GOOGLE_SYNC_TOO_FREQUENT:
    'This form was synchronized less than a minute ago. Wait a minute before syncing again.',
  LEASE_EXPIRED: 'The synchronization stopped unexpectedly and was abandoned.',
  DOMAIN_INGESTION_FAILED: 'The receiving HRMS module refused the responses.',
  SYNC_INTERNAL_ERROR: 'The synchronization failed unexpectedly.',

  // Google API
  GOOGLE_RATE_LIMITED: 'Google is rate limiting requests. It retries automatically later.',
  GOOGLE_UNAVAILABLE: 'Google was temporarily unavailable. It retries automatically later.',
  GOOGLE_NETWORK_ERROR: 'Google could not be reached. It retries automatically later.',
  GOOGLE_BAD_REQUEST: 'Google refused the request.',
  GOOGLE_UNAUTHORIZED: 'Google refused the credentials. Reconnect Google Workspace.',
  GOOGLE_FORBIDDEN: 'The connected account is not allowed to do this in Google.',
  GOOGLE_NOT_FOUND: 'Google could not find the form or file.',
  GOOGLE_AUTH_REVOKED: 'Access was revoked in Google. Reconnect Google Workspace.',
  GOOGLE_AUTH_FAILED: 'Google refused the credentials. Reconnect Google Workspace.',
  GOOGLE_SCOPE_NOT_GRANTED: 'A required Google permission was not granted. Reconnect with it.',
  GOOGLE_INVALID_RESPONSE: 'Google sent an unexpected response.',
  GOOGLE_HTTP_ERROR: 'Google answered with an error.',
};

/** Friendly text for a recorded error code (connection, binding, run) or a generic fallback. */
export function googleCodeText(code: string | null | undefined): string | null {
  if (!code) return null;
  return GOOGLE_WORKSPACE_ERROR_MESSAGES[code] ?? 'An error occurred.';
}

/** Friendly text for the OAuth callback error result (unknown codes are never echoed). */
export function callbackErrorMessage(code: string | null): string {
  return (
    (code && GOOGLE_WORKSPACE_ERROR_MESSAGES[code]) ||
    'The Google Workspace connection could not be completed. Please try again.'
  );
}

export function googleWorkspaceErrorMessage(
  error: unknown,
  fallback = 'Unable to load the Google Workspace integration.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const disabled = featureDisabledMessage(error);
  if (disabled) return disabled;
  const code = googleWorkspaceErrorCode(error);
  if (code === 'RATE_LIMITED') return RATE_LIMITED_MESSAGE;
  if (code && GOOGLE_WORKSPACE_ERROR_MESSAGES[code]) return GOOGLE_WORKSPACE_ERROR_MESSAGES[code];
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) return 'You do not have permission for this Google Workspace action.';
  if (error.status === 404) return 'The requested item was not found.';
  if (error.status === 409)
    return (
      error.validationMessage ||
      'This change conflicts with the current state. Reload and try again.'
    );
  if (error.status === 400) return error.validationMessage || 'Check the details and try again.';
  if (error.status === 503)
    return 'Google Workspace is not configured for this deployment (Google sign-in or credential encryption).';
  if (error.status >= 500)
    return 'The Google Workspace integration is unavailable. Please try again.';
  return fallback;
}
