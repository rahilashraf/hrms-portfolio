import { describe, expect, it } from 'vitest';
import { displayName, humanize } from './employee-shared';

describe('employee display helpers', () => {
  it('prefers preferred name and falls back safely', () => {
    expect(
      displayName({
        preferredName: 'Ada',
        firstName: 'Augusta',
        lastName: 'Lovelace',
        middleName: null,
      }),
    ).toBe('Ada');
    expect(
      displayName({
        preferredName: null,
        firstName: 'Augusta',
        lastName: 'Lovelace',
        middleName: null,
      }),
    ).toBe('Augusta Lovelace');
    expect(
      displayName({ preferredName: null, firstName: null, lastName: null, middleName: null }),
    ).toBe('Unnamed employee');
  });

  it('humanizes enum labels', () => {
    expect(humanize('FULL_TIME')).toBe('Full Time');
  });
});
