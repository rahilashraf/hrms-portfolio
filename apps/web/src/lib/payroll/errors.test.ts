import { describe, expect, it } from 'vitest';
import { AuthApiError } from '../auth/types';
import { payrollErrorMessage } from './errors';

describe('payrollErrorMessage', () => {
  it('says plainly why payroll refused an action that is not a missing permission', () => {
    const refused = (code: string) =>
      payrollErrorMessage(new AuthApiError('forbidden', 403, undefined, { code }));
    expect(refused('PAYROLL_SELF_ADJUSTMENT')).toMatch(/cannot change your own pay/);
    expect(refused('PAYROLL_SELF_APPROVAL')).toMatch(/includes your own pay/);
    expect(refused('PAYROLL_NOT_AN_EMPLOYEE')).toMatch(/not linked to an employee record/);
    expect(refused('SOMETHING_ELSE')).toBe('You do not have permission for this payroll action.');
    expect(payrollErrorMessage(new AuthApiError('forbidden', 403))).toBe(
      'You do not have permission for this payroll action.',
    );
  });

  it('keeps conflict messages from the API', () => {
    expect(
      payrollErrorMessage(
        new AuthApiError('conflict', 409, 'A cancelled adjustment cannot be cancelled.'),
      ),
    ).toBe('A cancelled adjustment cannot be cancelled.');
  });
});
