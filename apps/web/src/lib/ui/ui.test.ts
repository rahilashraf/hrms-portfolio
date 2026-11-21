import { describe, expect, it } from 'vitest';
import { accountStatusLabel, enumLabel, scopeTypeLabel } from './labels';
import { fieldLabel, humanizeValidationMessage, humanizeValidationMessages } from './validation';
import { label } from '../time/format';

describe('enum labels', () => {
  it('humanizes keys and applies product terminology', () => {
    expect(enumLabel('FULL_TIME')).toBe('Full Time');
    expect(enumLabel('ORGANIZATIONAL_UNIT')).toBe('Business Unit');
    expect(enumLabel('EMPLOYMENT_ASSIGNMENT')).toBe('Employment');
    expect(enumLabel('TIME_ENTRY')).toBe('Attendance Record');
    expect(enumLabel('TIME_CORRECTION_REQUEST')).toBe('Time Correction');
    expect(enumLabel('ROLE_ASSIGNMENT')).toBe('User Access');
    expect(enumLabel('REPORTING')).toBe('Reports');
    expect(enumLabel(null)).toBe('—');
    // Domain helpers share the same terminology.
    expect(label('ORGANIZATIONAL_UNIT')).toBe('Business Unit');
  });

  it('labels scopes and account statuses', () => {
    expect(scopeTypeLabel('ORGANIZATIONAL_UNIT')).toBe('Business Unit');
    expect(scopeTypeLabel('SYSTEM')).toBe('All organizations');
    expect(scopeTypeLabel('TEAM')).toBe('Team');
    expect(accountStatusLabel('ACTIVE')).toBe('Active');
    expect(accountStatusLabel('PENDING_VERIFICATION')).toBe('Pending verification');
    expect(accountStatusLabel('SOMETHING_NEW')).toBe('Something New');
  });
});

describe('validation messages', () => {
  it('names fields the way users see them', () => {
    expect(fieldLabel('employeeNumber')).toBe('Employee number');
    expect(fieldLabel('items.0.amountCents')).toBe('Amount cents');
    expect(fieldLabel('positionId')).toBe('Position');
  });

  it('rewrites class-validator messages into sentences', () => {
    expect(humanizeValidationMessage('employeeNumber must be a string')).toBe(
      'Employee number must be a string.',
    );
    expect(humanizeValidationMessage('property foo should not exist')).toBe('Foo is not allowed.');
    expect(humanizeValidationMessage('Department cannot be archived.')).toBe(
      'Department cannot be archived.',
    );
    expect(
      humanizeValidationMessages([
        'email must be an email',
        'startDate must be a valid ISO 8601 date string',
      ]),
    ).toBe('Email must be an email. Start date must be a valid ISO 8601 date string.');
  });
});
