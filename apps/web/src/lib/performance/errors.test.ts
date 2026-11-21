import { describe, expect, it } from 'vitest';
import { AuthApiError } from '../auth/types';
import { performanceErrorCode, performanceErrorMessage, performanceFailureKind } from './errors';

const failure = (status: number, code?: string, message?: string) =>
  new AuthApiError('forbidden', status, message, code ? { code } : undefined);

describe('performance errors (Batch 7B)', () => {
  it('reads the domain code of a response', () => {
    expect(performanceErrorCode(failure(403, 'PERFORMANCE_GOAL_MANAGER_SET'))).toBe(
      'PERFORMANCE_GOAL_MANAGER_SET',
    );
    expect(performanceErrorCode(failure(403))).toBeNull();
    expect(performanceErrorCode(new Error('x'))).toBeNull();
  });

  it('tells a missing employee record, a disabled module and a refusal apart', () => {
    expect(performanceFailureKind(failure(403, 'PERFORMANCE_NOT_AN_EMPLOYEE'))).toBe(
      'NOT_EMPLOYEE',
    );
    expect(performanceFailureKind(failure(403, 'FEATURE_DISABLED'))).toBe('MODULE_DISABLED');
    expect(performanceFailureKind(failure(403))).toBe('FORBIDDEN');
    expect(performanceFailureKind(failure(500))).toBe('ERROR');
    expect(performanceFailureKind(new TypeError('Failed to fetch'))).toBe('ERROR');
  });

  it('shows the API message of a conflict, such as a goal under review', () => {
    expect(
      performanceErrorMessage(
        failure(
          409,
          'PERFORMANCE_GOAL_UNDER_REVIEW',
          'The goal is linked to a review in progress.',
        ),
      ),
    ).toBe('The goal is linked to a review in progress.');
    expect(performanceErrorMessage(failure(500))).toBe(
      'The Performance service is unavailable. Please try again.',
    );
  });
});
