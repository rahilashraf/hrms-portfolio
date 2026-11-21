import { describe, expect, it } from 'vitest';
import {
  addDays,
  chunkRange,
  endOfMonth,
  fromZoned,
  startOfWeek,
  toZoned,
  weekdayIndex,
} from './time';

describe('scheduling time helpers', () => {
  it('does date-only arithmetic without the machine timezone', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(startOfWeek('2026-10-08')).toBe('2026-10-05'); // Thursday → Monday
    expect(weekdayIndex('2026-10-11')).toBe(6); // Sunday
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
  });

  it('converts wall-clock times in a zone to instants, across daylight-saving changes', () => {
    // Toronto: EDT (-04:00) before 2026-11-01, EST (-05:00) after.
    expect(fromZoned('2026-10-08', '09:00', 'America/Toronto')).toBe('2026-10-08T13:00:00.000Z');
    expect(fromZoned('2026-11-02', '09:00', 'America/Toronto')).toBe('2026-11-02T14:00:00.000Z');
    expect(toZoned('2026-11-02T14:00:00.000Z', 'America/Toronto')).toEqual({
      date: '2026-11-02',
      time: '09:00',
    });
  });

  it('splits long ranges into API-sized windows', () => {
    expect(chunkRange('2026-10-01', '2026-12-15', 62)).toEqual([
      { from: '2026-10-01', to: '2026-12-01' },
      { from: '2026-12-02', to: '2026-12-15' },
    ]);
  });
});
