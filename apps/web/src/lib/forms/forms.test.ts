import { describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import { validationProperty } from '../ui/validation';
import { applyApiErrors } from './api-errors';
import { dateString, optionalDateString, optionalText, recordId, requiredText } from './schemas';

describe('form schemas', () => {
  it('trims and bounds text, turning empty optional text into null', () => {
    expect(requiredText('a name', 5).safeParse('  ').error?.issues[0]?.message).toBe(
      'Enter a name.',
    );
    expect(requiredText('a name', 5).safeParse('abcdef').success).toBe(false);
    expect(requiredText('a name').parse('  Ada ')).toBe('Ada');
    expect(optionalText().parse('  ')).toBeNull();
  });

  it('accepts real calendar dates and record identifiers only', () => {
    expect(dateString('a start date').safeParse('2026-02-28').success).toBe(true);
    expect(dateString('a start date').safeParse('2026-02-30').success).toBe(false);
    expect(dateString('a start date').safeParse('2026-13-01').success).toBe(false);
    expect(dateString('a start date').safeParse('').error?.issues[0]?.message).toBe(
      'Enter a start date.',
    );
    expect(optionalDateString().parse('')).toBeNull();
    expect(recordId('an employee').safeParse('emp-1').success).toBe(false);
    expect(recordId('an employee').parse('00000000-0000-4000-8000-000000000001')).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
  });
});

describe('API error mapping', () => {
  it('reads the property a validation message is about', () => {
    expect(validationProperty('employeeNumber must be a string')).toBe('employeeNumber');
    expect(validationProperty('items.0.amountCents must not be less than 0')).toBe(
      'items.0.amountCents',
    );
    expect(validationProperty('property foo should not exist')).toBe('foo');
    expect(validationProperty('The period is closed.')).toBeNull();
  });

  it('places nested messages on their root field and leaves other errors to the caller', () => {
    const setError = vi.fn();
    expect(
      applyApiErrors(
        new AuthApiError('validation', 400, undefined, {
          message: ['items.0.amountCents must not be less than 0'],
        }),
        setError,
        { fields: { items: 'items' } },
      ),
    ).toEqual({ placed: 1, message: null });
    expect(setError).toHaveBeenCalledWith(
      'items',
      { type: 'server', message: 'Amount cents must not be less than 0.' },
      { shouldFocus: true },
    );
    expect(applyApiErrors(new Error('network'), setError)).toEqual({ placed: 0, message: null });
    expect(
      applyApiErrors(new AuthApiError('conflict', 409, 'The period is closed.'), setError),
    ).toEqual({ placed: 0, message: null });
  });
});
