import { AuthApiError } from '../auth/types';
import { sharedErrorMessage } from '../features/errors';

export function isReportingForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

/**
 * The domain error code of a reporting error. The shared client reads error bodies only for
 * 400/409/422, so a 403 is inferred as REPORT_ACCESS_DENIED (the only 403 of the area) and a 404
 * stays ambiguous (REPORT_NOT_FOUND or REPORT_FILTER_NOT_FOUND) unless its body was read (the
 * CSV export reads every body).
 */
export function reportingErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  if (typeof code === 'string') return code;
  if (error.status === 403) return 'REPORT_ACCESS_DENIED';
  return null;
}

export function isGoogleConnectionRequired(error: unknown): boolean {
  return reportingErrorCode(error) === 'GOOGLE_CONNECTION_REQUIRED';
}

export const REPORTING_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  REPORT_NOT_FOUND: 'This report does not exist.',
  REPORT_FILTER_NOT_FOUND:
    'A selected unit, department, team, position, cycle or opening is outside your reporting scope or no longer exists.',
  REPORT_ACCESS_DENIED:
    'You do not have access to this report in this organization (it needs report access and the source data permission; exports also need report export access).',
  REPORT_FILTER_UNSUPPORTED: 'This report does not support one of the selected filters.',
  REPORT_FILTER_INVALID:
    'A filter value is invalid. Dates are YYYY-MM-DD and identifiers must be valid UUIDs.',
  REPORT_RANGE_INVALID: 'The start date must be on or before the end date.',
  REPORT_RANGE_TOO_LONG:
    'The date range is too long or too far from today. A report may span at most five years (1,830 days).',
  GOOGLE_CONNECTION_REQUIRED:
    'Exporting to Google Sheets needs an active Google Workspace connection with the Sheets export capability.',
  GOOGLE_EXPORT_FAILED:
    'Google Sheets did not accept the export. Check the Google Workspace connection and try again.',
};

export function reportingErrorMessage(
  error: unknown,
  fallback = 'Unable to load reports.',
): string {
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  const code = reportingErrorCode(error);
  if (code && REPORTING_ERROR_MESSAGES[code]) return REPORTING_ERROR_MESSAGES[code];
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 404)
    return 'The report, or something a filter names, was not found in your reporting scope.';
  if (error.status === 409)
    return error.validationMessage || 'The request conflicts with the current state. Try again.';
  if (error.status === 400) return error.validationMessage || 'Check the filters and try again.';
  if (error.status >= 500) return 'Reporting is unavailable. Please try again.';
  return fallback;
}
