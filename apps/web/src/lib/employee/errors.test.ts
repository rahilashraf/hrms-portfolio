import { describe, expect, it } from 'vitest';
import { AuthApiError } from '../auth/types';
import {
  employeeAccountErrorMessage,
  employeeAssignmentActionErrorMessage,
  employeeLifecycleActionErrorMessage,
  revokeGrantsErrorMessage,
} from './errors';

const forbidden = (details: Record<string, unknown>) =>
  new AuthApiError('forbidden', 403, undefined, details);

describe('Batch 5E: lifecycle authorization messages', () => {
  it('names the refused action for LIFECYCLE_SELF_TARGET', () => {
    expect(
      employeeLifecycleActionErrorMessage(
        forbidden({ code: 'LIFECYCLE_SELF_TARGET', action: 'TERMINATE' }),
      ),
    ).toBe('You cannot change your own employment.');
    expect(
      employeeAssignmentActionErrorMessage(
        forbidden({ code: 'LIFECYCLE_SELF_TARGET', action: 'CREATE_ASSIGNMENT' }),
      ),
    ).toBe('You cannot change your own assignments. Ask another administrator.');
    expect(
      employeeAssignmentActionErrorMessage(
        forbidden({ code: 'LIFECYCLE_SELF_TARGET', action: 'TRANSFER_ASSIGNMENT' }),
      ),
    ).toBe('You cannot transfer your own assignment. Ask another administrator.');
  });

  it('explains assignment refusals by code instead of a generic permission message', () => {
    expect(
      employeeAssignmentActionErrorMessage(
        new AuthApiError('conflict', 409, 'The employee is inactive; reactivate them first.', {
          code: 'EMPLOYEE_NOT_ACTIVE',
        }),
      ),
    ).toBe('Only an active employee can be changed this way.');
    expect(
      employeeAssignmentActionErrorMessage(forbidden({ code: 'LIFECYCLE_SCOPE_INCOMPLETE' })),
    ).toMatch(/affects employment you do not manage/);
    // Without a domain code the previous messages stay.
    expect(employeeAssignmentActionErrorMessage(forbidden({}))).toBe(
      'You do not have permission to manage this assignment.',
    );
  });

  it('revocation: says nothing was revoked, for each refusal', () => {
    expect(
      revokeGrantsErrorMessage(
        forbidden({ code: 'LIFECYCLE_SELF_TARGET', action: 'REVOKE_GRANTS' }),
      ),
    ).toBe(
      'You cannot revoke grants on your own employment record. Ask another administrator. Nothing was revoked.',
    );
    expect(revokeGrantsErrorMessage(new AuthApiError('unexpected', 404))).toBe(
      'A selected grant, the employee or their login is no longer available to you. Nothing was revoked; refresh the access review.',
    );
    expect(
      revokeGrantsErrorMessage(
        forbidden({ message: 'System Owner assignments are bootstrap-managed.' }),
      ),
    ).toBe(
      'System Owner grants are managed at setup and cannot be revoked here. Nothing was revoked.',
    );
    expect(revokeGrantsErrorMessage(forbidden({}))).toBe(
      'You do not have permission to revoke one of the selected grants. Nothing was revoked.',
    );
    expect(revokeGrantsErrorMessage(new Error('x'))).toBe('Unable to revoke these grants.');
  });
});

describe('Security remediation M1: login-access scope refusals', () => {
  it('shows the safe reason of ACCOUNT_OUTSIDE_SCOPE, never server text', () => {
    expect(
      employeeAccountErrorMessage(
        forbidden({
          code: 'ACCOUNT_OUTSIDE_SCOPE',
          reason: 'NO_CURRENT_ASSIGNMENT',
          message: 'anything the server says',
        }),
      ),
    ).toBe('This needs a current assignment in your administrative scope.');
    expect(
      employeeAccountErrorMessage(
        forbidden({ code: 'ACCOUNT_OUTSIDE_SCOPE', reason: 'PROTECTIVE_WINDOW_ENDED' }),
      ),
    ).toMatch(/more than 90 days ago/);
    // An unknown or missing reason falls back to the generic scope message.
    for (const reason of ['SOMETHING_NEW', undefined])
      expect(
        employeeAccountErrorMessage(forbidden({ code: 'ACCOUNT_OUTSIDE_SCOPE', reason })),
      ).toMatch(/^This person has access outside your administrative scope\./);
    // Other 403s keep the earlier message.
    expect(employeeAccountErrorMessage(forbidden({}))).toBe(
      'You do not have permission to manage this employee’s login access.',
    );
  });
});
