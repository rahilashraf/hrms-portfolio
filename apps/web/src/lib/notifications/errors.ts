import { AuthApiError } from '../auth/types';
import { sharedErrorMessage } from '../features/errors';

export function isNotificationsForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

export function isNotificationsNotFound(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 404;
}

/** The domain error code of a 400/409 notifications response (e.g. NOTIFICATION_TEMPLATE_EXISTS). */
export function notificationsErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  return typeof code === 'string' ? code : null;
}

/** Friendly messages for the notifications domain error codes (the API's message is the fallback). */
export const NOTIFICATIONS_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  NOTIFICATION_TEMPLATE_INVALID:
    'The subject (up to 200 characters) and body (up to 2000 characters) are required and cannot contain control characters.',
  NOTIFICATION_TEMPLATE_SYNTAX:
    'A placeholder is malformed. Write placeholders as {{name}}, and do not use other braces.',
  NOTIFICATION_TEMPLATE_PLACEHOLDER:
    'The template uses a placeholder this notification does not provide. Use only the listed variables.',
  NOTIFICATION_TEMPLATE_LINK:
    'Templates cannot contain links or web addresses; notifications link to the right page themselves.',
  NOTIFICATION_TEMPLATE_EXISTS:
    'This organization already has a custom template for this notification. Edit or archive it instead.',
  NOTIFICATION_TEMPLATE_ARCHIVED: 'This custom template is archived and can no longer be edited.',
  NOTIFICATION_TYPE_UNKNOWN: 'This notification type is not known.',
  NOTIFICATION_CATEGORY_MANDATORY:
    'Security and required HR notices are always sent; their email cannot be turned off.',
  NOTIFICATION_CATEGORY_DUPLICATE: 'A category was listed twice. Reload the page and try again.',
  NOTIFICATION_CATEGORY_UNKNOWN: 'This notification category is not known.',
  NOTIFICATION_MANDATORY_SUPPRESSION:
    'Mandatory email can only be suppressed while organization email is turned off.',
  NOTIFICATION_CURSOR_INVALID: 'The list position expired. Reload your notifications.',
  NOTIFICATION_LINK_INVALID: 'Notifications can only link to pages of this application.',
  NOTIFICATION_DEDUPE_INVALID: 'The notification could not be recorded (invalid identifier).',
  NOTIFICATION_RECIPIENT_INVALID: 'The recipient does not belong to this organization.',
  NOTIFICATION_SOURCE_INVALID: 'The notification source is not valid.',
};

/** Notifications errors carry a readable message for validation and conflicts. */
export function notificationsErrorMessage(
  error: unknown,
  fallback = 'Unable to load notifications.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  const code = notificationsErrorCode(error);
  if (code && NOTIFICATIONS_ERROR_MESSAGES[code]) return NOTIFICATIONS_ERROR_MESSAGES[code];
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) return 'You do not have permission for this notifications action.';
  if (error.status === 404) return 'The notification was not found.';
  if (error.status === 409) {
    return (
      error.validationMessage ||
      'This change conflicts with the current state. Reload and try again.'
    );
  }
  if (error.status === 400) return error.validationMessage || 'Check the details and try again.';
  if (error.status >= 500) return 'The Notifications service is unavailable. Please try again.';
  return fallback;
}
