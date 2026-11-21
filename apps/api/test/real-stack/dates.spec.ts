import { describe, expect, it } from 'vitest';
import {
  localDate,
  localInstant,
  planRealStackDates,
  REAL_STACK_DEFAULT_TIMEZONE,
  referenceInstantFrom,
  shiftDate,
} from './dates.js';

const TORONTO = REAL_STACK_DEFAULT_TIMEZONE;

describe('real-stack date planning', () => {
  it('defaults to America/Toronto, a daylight-saving zone, on purpose', () => {
    expect(TORONTO).toBe('America/Toronto');
  });

  describe('local calendar dates', () => {
    it('reads the date in the timezone, not in UTC or the runner’s zone', () => {
      // 03:59 UTC on 1 November is 23:59 on 31 October in Toronto (EDT, -04:00)...
      expect(localDate(new Date('2026-11-01T03:59:00Z'), TORONTO)).toBe(
        '2026-10-31',
      );
      // ...and one minute later it is midnight there.
      expect(localDate(new Date('2026-11-01T04:00:00Z'), TORONTO)).toBe(
        '2026-11-01',
      );
      // East of UTC the local date runs ahead.
      expect(localDate(new Date('2026-10-31T19:00:00Z'), 'Asia/Kolkata')).toBe(
        '2026-11-01',
      );
    });

    it('moves dates by whole calendar days across months, years and leap days', () => {
      expect(shiftDate('2026-11-01', -1)).toBe('2026-10-31');
      expect(shiftDate('2027-01-01', -1)).toBe('2026-12-31');
      expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
      expect(shiftDate('2026-10-28', 7)).toBe('2026-11-04');
      expect(() => shiftDate('2026-11-1', 1)).toThrow(/Not a date/);
    });
  });

  describe('local instants', () => {
    it('uses the offset in force on that date (daylight-saving changes)', () => {
      // 1 November 2026 is the fall-back day: 09:00 is already EST (-05:00).
      expect(localInstant('2026-11-01', '09:00', TORONTO).toISOString()).toBe(
        '2026-11-01T14:00:00.000Z',
      );
      expect(localInstant('2026-10-31', '09:00', TORONTO).toISOString()).toBe(
        '2026-10-31T13:00:00.000Z',
      );
      // 14 March 2027 is the spring-forward day: 09:00 is EDT (-04:00).
      expect(localInstant('2027-03-14', '09:00', TORONTO).toISOString()).toBe(
        '2027-03-14T13:00:00.000Z',
      );
    });

    it('works for any timezone, including half-hour and 45-minute offsets', () => {
      expect(
        localInstant('2026-11-01', '09:00', 'Asia/Kolkata').toISOString(),
      ).toBe('2026-11-01T03:30:00.000Z');
      expect(
        localInstant('2026-11-01', '09:00', 'Pacific/Chatham').toISOString(),
      ).toBe('2026-10-31T19:15:00.000Z');
      expect(localInstant('2026-11-01', '09:00', 'UTC').toISOString()).toBe(
        '2026-11-01T09:00:00.000Z',
      );
    });

    it('refuses skipped and repeated local times instead of guessing', () => {
      expect(() => localInstant('2027-03-14', '02:30', TORONTO)).toThrow(
        /skipped/,
      );
      expect(() => localInstant('2026-11-01', '01:30', TORONTO)).toThrow(
        /repeated/,
      );
    });
  });

  describe('the plan', () => {
    it('derives every date from the one reference instant', () => {
      const plan = planRealStackDates(new Date('2026-11-02T15:00:00Z'));
      expect(plan).toEqual({
        timezone: TORONTO,
        referenceInstant: '2026-11-02T15:00:00.000Z',
        referenceDate: '2026-11-02',
        pastEntry: {
          workDate: '2026-11-01',
          clockInAt: new Date('2026-11-01T14:00:00.000Z'),
          clockOutAt: new Date('2026-11-01T17:00:00.000Z'),
          correctedClockOutLocal: '2026-11-01T13:00',
          correctedClockOutAt: new Date('2026-11-01T18:00:00.000Z'),
        },
        period: { startDate: '2026-10-26', endDate: '2026-11-01' },
      });
    });

    it('is deterministic: the same reference always gives the same plan', () => {
      const reference = new Date('2027-03-15T12:00:00Z');
      expect(planRealStackDates(reference)).toEqual(
        planRealStackDates(new Date(reference)),
      );
    });

    it.each([
      // Just before local midnight, when the UTC date is already the next day.
      ['2026-11-01T03:59:00Z', '2026-10-31', '2026-10-30'],
      // Just after local midnight.
      ['2026-11-01T04:00:00Z', '2026-11-01', '2026-10-31'],
      // The first minute of the reference date, on the day after spring-forward.
      ['2027-03-15T04:00:00Z', '2027-03-15', '2027-03-14'],
      // The last minute of the year.
      ['2027-01-01T04:59:00Z', '2026-12-31', '2026-12-30'],
    ])(
      'reference %s: the reference date is %s, the past record is on %s, and its correction is earlier',
      (instant, referenceDate, workDate) => {
        const reference = new Date(instant);
        const plan = planRealStackDates(reference);
        expect(plan.referenceDate).toBe(referenceDate);
        expect(plan.pastEntry.workDate).toBe(workDate);
        expect(plan.pastEntry.correctedClockOutAt.getTime()).toBeLessThan(
          reference.getTime(),
        );
        expect(plan.pastEntry.clockInAt.getTime()).toBeLessThan(
          plan.pastEntry.clockOutAt.getTime(),
        );
      },
    );

    it('plans a period that has ended and holds the past record; live punches fall after it', () => {
      // Seeded a minute before local midnight; the tests clock in that day or the next.
      const plan = planRealStackDates(new Date('2026-11-01T03:59:00Z'));
      expect(plan.period.endDate < plan.referenceDate).toBe(true);
      expect(plan.pastEntry.workDate >= plan.period.startDate).toBe(true);
      expect(plan.pastEntry.workDate <= plan.period.endDate).toBe(true);
      for (const days of [0, 1, 7]) {
        expect(shiftDate(plan.referenceDate, days) > plan.period.endDate).toBe(
          true,
        );
      }
    });

    it('plans in any timezone given (the harness is not tied to Toronto)', () => {
      const plan = planRealStackDates(
        new Date('2026-10-31T19:00:00Z'),
        'Asia/Kolkata',
      );
      expect(plan.timezone).toBe('Asia/Kolkata');
      expect(plan.referenceDate).toBe('2026-11-01');
      expect(plan.pastEntry.workDate).toBe('2026-10-31');
      expect(plan.pastEntry.clockInAt.toISOString()).toBe(
        '2026-10-31T03:30:00.000Z',
      );
    });

    it('refuses an invalid reference instant', () => {
      expect(() => planRealStackDates(new Date('nope'))).toThrow(/not a valid/);
    });
  });

  describe('the reference instant for a run', () => {
    it('is now unless REAL_STACK_REFERENCE_INSTANT names one', () => {
      const now = new Date('2026-11-01T12:00:00Z');
      expect(referenceInstantFrom({}, () => now)).toBe(now);
      expect(
        referenceInstantFrom(
          { REAL_STACK_REFERENCE_INSTANT: '2027-03-02T14:00:00Z' },
          () => now,
        ).toISOString(),
      ).toBe('2027-03-02T14:00:00.000Z');
    });

    it('requires an explicit offset, so the runner’s timezone never changes it', () => {
      for (const value of ['2027-03-02T14:00:00', '2027-03-02', 'tomorrow']) {
        expect(() =>
          referenceInstantFrom({ REAL_STACK_REFERENCE_INSTANT: value }),
        ).toThrow(/ISO instant with an offset/);
      }
    });
  });
});
