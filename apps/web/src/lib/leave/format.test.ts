import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  dayOverrideMinutes,
  formatLeaveAmount,
  formatLeaveRange,
  hoursToMinutes,
} from './format';

describe('leave format helpers', () => {
  it('formats minute amounts in hours or days', () => {
    expect(formatLeaveAmount(480)).toBe('8h');
    expect(formatLeaveAmount(-90)).toBe('-1h 30m');
    expect(formatLeaveAmount(480, 'DAYS')).toBe('1 day');
    expect(formatLeaveAmount(1200, 'DAYS')).toBe('2.5 days');
    expect(formatLeaveAmount(450, 'DAYS', 450)).toBe('1 day');
    expect(formatLeaveAmount(null)).toBe('—');
  });

  it('parses hours to minutes and formats ranges', () => {
    expect(hoursToMinutes('7.5')).toBe(450);
    expect(hoursToMinutes('-2')).toBe(-120);
    expect(hoursToMinutes('')).toBeNull();
    expect(hoursToMinutes('abc')).toBeNull();
    expect(formatLeaveRange('2027-03-08', '2027-03-08')).toBe('03/08/2027');
    expect(formatLeaveRange('2027-03-08', '2027-03-10')).toBe('03/08/2027 – 03/10/2027');
    expect(formatLeaveRange('2027-03-08', '2027-03-08', '09:00', '12:00')).toBe(
      '03/08/2027, 09:00–12:00',
    );
    expect(addDaysIso('2027-02-27', 2)).toBe('2027-03-01');
  });
});

describe('dayOverrideMinutes', () => {
  it('accepts 0 to 24 hours as whole minutes and treats an empty field as no override', () => {
    expect(dayOverrideMinutes('')).toEqual({ minutes: null, error: null });
    expect(dayOverrideMinutes('0')).toEqual({ minutes: 0, error: null });
    expect(dayOverrideMinutes('7.25')).toEqual({ minutes: 435, error: null });
    expect(dayOverrideMinutes('24')).toEqual({ minutes: 1440, error: null });
  });

  it('refuses what the API would reject instead of dropping it silently', () => {
    for (const value of ['24.25', '48', '-1', 'abc']) {
      expect(dayOverrideMinutes(value)).toEqual({
        minutes: null,
        error: 'Enter between 0 and 24 hours.',
      });
    }
  });
});
