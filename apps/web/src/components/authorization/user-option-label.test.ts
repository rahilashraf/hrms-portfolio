import { describe, expect, it } from 'vitest';
import { userOptionLabel } from './access-control';

describe('userOptionLabel', () => {
  it('shows name, employee number and email so a user can be found by any of them', () => {
    expect(
      userOptionLabel({
        id: 'u1',
        email: 'ada@example.com',
        status: 'ACTIVE',
        displayName: 'Ada Lovelace',
        employeeNumber: 'EMP-7',
      }),
    ).toBe('Ada Lovelace (EMP-7) · ada@example.com');
  });

  it('marks invited users, whose roles apply only after activation', () => {
    expect(
      userOptionLabel({
        id: 'u2',
        email: 'new@example.com',
        status: 'INVITED',
        displayName: null,
        employeeNumber: null,
      }),
    ).toBe('new@example.com · invited (roles apply after activation)');
  });
});
