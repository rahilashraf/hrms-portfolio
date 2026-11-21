import { describe, expect, it } from 'vitest';
import { AuthApiError } from '../auth/types';
import {
  isGoogleConnectionRequired,
  isReportingForbidden,
  REPORTING_ERROR_MESSAGES,
  reportingErrorCode,
  reportingErrorMessage,
} from './errors';

const coded = (status: number, code: string, message = 'server text') =>
  new AuthApiError('validation', status, message, { statusCode: status, code, message });

describe('reporting errors', () => {
  it('reads domain codes from bodies and infers the 403', () => {
    expect(reportingErrorCode(coded(400, 'REPORT_RANGE_TOO_LONG'))).toBe('REPORT_RANGE_TOO_LONG');
    expect(reportingErrorCode(new AuthApiError('forbidden', 403))).toBe('REPORT_ACCESS_DENIED');
    expect(reportingErrorCode(new AuthApiError('unexpected', 404))).toBeNull();
    expect(reportingErrorCode(new Error('x'))).toBeNull();
    expect(isReportingForbidden(new AuthApiError('forbidden', 403))).toBe(true);
    expect(isReportingForbidden(new AuthApiError('unexpected', 404))).toBe(false);
  });

  it('has friendly text for every reporting error code', () => {
    for (const code of [
      'REPORT_NOT_FOUND',
      'REPORT_FILTER_NOT_FOUND',
      'REPORT_ACCESS_DENIED',
      'REPORT_FILTER_UNSUPPORTED',
      'REPORT_FILTER_INVALID',
      'REPORT_RANGE_INVALID',
      'REPORT_RANGE_TOO_LONG',
      'GOOGLE_CONNECTION_REQUIRED',
      'GOOGLE_EXPORT_FAILED',
    ]) {
      expect(reportingErrorMessage(coded(400, code))).toBe(REPORTING_ERROR_MESSAGES[code]);
    }
  });

  it('falls back by status', () => {
    expect(reportingErrorMessage(new AuthApiError('unexpected', 404))).toMatch(
      /not found in your reporting scope/,
    );
    expect(reportingErrorMessage(new AuthApiError('forbidden', 403))).toBe(
      REPORTING_ERROR_MESSAGES.REPORT_ACCESS_DENIED,
    );
    expect(reportingErrorMessage(new AuthApiError('unauthenticated', 401))).toMatch(/expired/);
    expect(
      reportingErrorMessage(new AuthApiError('validation', 400, 'organizationId must be a UUID')),
    ).toBe('organizationId must be a UUID');
    expect(reportingErrorMessage(new AuthApiError('service-unavailable', 503))).toMatch(
      /unavailable/,
    );
    expect(reportingErrorMessage(new Error('x'), 'Fallback')).toBe('Fallback');
  });

  it('recognizes the missing Google connection', () => {
    expect(isGoogleConnectionRequired(coded(409, 'GOOGLE_CONNECTION_REQUIRED'))).toBe(true);
    expect(isGoogleConnectionRequired(coded(409, 'GOOGLE_EXPORT_FAILED'))).toBe(false);
  });
});
