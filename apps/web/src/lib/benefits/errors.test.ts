import { describe, expect, it } from 'vitest';
import { AuthApiError } from '../auth/types';
import { benefitsErrorCode, benefitsErrorMessage, benefitsFailureKind } from './errors';

const failure = (status: number, code?: string, message?: string) =>
  new AuthApiError('forbidden', status, message, code ? { code } : undefined);

describe('benefits errors (Batch 7C)', () => {
  it('reads the domain code of a response', () => {
    expect(benefitsErrorCode(failure(409, 'BENEFIT_NOT_ELIGIBLE'))).toBe('BENEFIT_NOT_ELIGIBLE');
    expect(benefitsErrorCode(failure(403))).toBeNull();
    expect(benefitsErrorCode(new Error('x'))).toBeNull();
  });

  it('tells a missing employee record, a disabled module and a refusal apart', () => {
    expect(benefitsFailureKind(failure(403, 'BENEFIT_NOT_AN_EMPLOYEE'))).toBe('NOT_EMPLOYEE');
    expect(benefitsFailureKind(failure(403, 'FEATURE_DISABLED'))).toBe('MODULE_DISABLED');
    expect(benefitsFailureKind(failure(403, 'BENEFIT_PERMISSION_REQUIRED'))).toBe('FORBIDDEN');
    expect(benefitsFailureKind(failure(500))).toBe('ERROR');
    expect(benefitsFailureKind(new TypeError('Failed to fetch'))).toBe('ERROR');
  });

  it('explains domain refusals instead of a generic permission message', () => {
    expect(benefitsErrorMessage(failure(403, 'BENEFIT_SELF_MANAGEMENT'))).toMatch(
      /your own benefits/,
    );
    expect(benefitsErrorMessage(failure(409, 'BENEFIT_NOT_ELIGIBLE'))).toMatch(/override reason/);
    expect(benefitsErrorMessage(failure(409, 'BENEFIT_LATER_COVERAGE'))).toMatch(/later election/);
    expect(benefitsErrorMessage(failure(409, 'BENEFIT_ELECTION_HISTORICAL'))).toMatch(/correction/);
    expect(benefitsErrorMessage(failure(409, 'BENEFIT_DEPENDENT_HISTORY_CONFLICT'))).toMatch(
      /recorded coverage/,
    );
  });

  it('keeps the API message for codes it does not know, and plain statuses', () => {
    expect(benefitsErrorMessage(failure(409, 'SOMETHING_NEW', 'Exact API text.'))).toBe(
      'Exact API text.',
    );
    expect(benefitsErrorMessage(failure(404))).toMatch(/not found/);
    expect(benefitsErrorMessage(failure(500))).toBe(
      'The Benefits service is unavailable. Please try again.',
    );
    expect(benefitsErrorMessage(new Error('x'), 'Fallback.')).toBe('Fallback.');
  });
});
