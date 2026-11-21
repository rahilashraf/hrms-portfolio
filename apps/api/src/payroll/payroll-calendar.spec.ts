import { describe, expect, it } from 'vitest';
import { formatDate } from '../common/domain-support.js';
import {
  assertCalendarSeries,
  firstPeriodStartOnOrAfter,
  isPeriodStart,
  periodStartingOn,
  periodsBetween,
  type PayrollCalendarRules,
} from './payroll-calendar.js';

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const rules = (
  overrides: Partial<PayrollCalendarRules> = {},
): PayrollCalendarRules => ({
  cadence: 'BIWEEKLY',
  anchorDate: d('2026-01-04'),
  payDateOffsetDays: 5,
  processingCutoffOffsetDays: 2,
  timezone: 'America/Toronto',
  ...overrides,
});
const shape = (calendar: PayrollCalendarRules, from: string, through: string) =>
  periodsBetween(calendar, {
    from: d(from),
    through: d(through),
    limit: 100,
  }).map((period) => [
    formatDate(period.periodStart),
    formatDate(period.periodEnd),
    formatDate(period.payDate),
  ]);
const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { getResponse(): { code: string } }).getResponse().code;
  }
  return null;
};

describe('Payroll period series (Phase 10 Batch 2)', () => {
  it('generates weekly periods aligned to the anchor', () => {
    expect(
      shape(
        rules({ cadence: 'WEEKLY', anchorDate: d('2026-10-04') }),
        '2026-10-05',
        '2026-10-25',
      ),
    ).toEqual([
      ['2026-10-11', '2026-10-17', '2026-10-22'],
      ['2026-10-18', '2026-10-24', '2026-10-29'],
      ['2026-10-25', '2026-10-31', '2026-11-05'],
    ]);
  });

  it('generates bi-weekly periods across a year boundary', () => {
    expect(shape(rules(), '2026-12-01', '2027-01-20')).toEqual([
      ['2026-12-06', '2026-12-19', '2026-12-24'],
      ['2026-12-20', '2027-01-02', '2027-01-07'],
      ['2027-01-03', '2027-01-16', '2027-01-21'],
      ['2027-01-17', '2027-01-30', '2027-02-04'],
    ]);
  });

  it('generates semi-monthly halves, including February and leap years', () => {
    const semi = rules({
      cadence: 'SEMIMONTHLY',
      anchorDate: d('2026-01-01'),
      payDateOffsetDays: 0,
    });
    expect(shape(semi, '2027-02-01', '2027-03-01')).toEqual([
      ['2027-02-01', '2027-02-15', '2027-02-15'],
      ['2027-02-16', '2027-02-28', '2027-02-28'],
      ['2027-03-01', '2027-03-15', '2027-03-15'],
    ]);
    expect(shape(semi, '2028-02-16', '2028-02-16')).toEqual([
      ['2028-02-16', '2028-02-29', '2028-02-29'],
    ]);
  });

  it('generates monthly periods from the anchor day', () => {
    expect(
      shape(
        rules({
          cadence: 'MONTHLY',
          anchorDate: d('2026-01-01'),
          payDateOffsetDays: 0,
        }),
        '2026-12-01',
        '2027-02-01',
      ),
    ).toEqual([
      ['2026-12-01', '2026-12-31', '2026-12-31'],
      ['2027-01-01', '2027-01-31', '2027-01-31'],
      ['2027-02-01', '2027-02-28', '2027-02-28'],
    ]);
    expect(
      shape(
        rules({
          cadence: 'MONTHLY',
          anchorDate: d('2026-01-15'),
          payDateOffsetDays: 3,
        }),
        '2027-01-20',
        '2027-03-15',
      ),
    ).toEqual([
      ['2027-02-15', '2027-03-14', '2027-03-17'],
      ['2027-03-15', '2027-04-14', '2027-04-17'],
    ]);
  });

  it('places the cutoff at the end of the local cutoff day, across DST changes', () => {
    // Pay 2027-03-16; cutoff 2 days before = 2027-03-14, the day DST starts in Toronto:
    // its end is 2027-03-15 00:00 EDT (04:00 UTC).
    const spring = periodStartingOn(
      rules({ anchorDate: d('2027-02-27'), payDateOffsetDays: 4 }),
      d('2027-02-27'),
    );
    expect(formatDate(spring.payDate)).toBe('2027-03-16');
    expect(spring.processingCutoffAt.toISOString()).toBe(
      '2027-03-15T03:59:59.999Z',
    );
    // Fall back (2026-11-01): the end of that day is 2026-11-02 00:00 EST (05:00 UTC).
    const fall = periodStartingOn(
      rules({ anchorDate: d('2026-10-18'), payDateOffsetDays: 3 }),
      d('2026-10-18'),
    );
    expect(formatDate(fall.payDate)).toBe('2026-11-03');
    expect(fall.processingCutoffAt.toISOString()).toBe(
      '2026-11-02T04:59:59.999Z',
    );
    // The same dates in Tokyo: no DST, the instant follows the zone.
    const tokyo = periodStartingOn(
      rules({
        anchorDate: d('2027-02-27'),
        payDateOffsetDays: 4,
        timezone: 'Asia/Tokyo',
      }),
      d('2027-02-27'),
    );
    expect(tokyo.processingCutoffAt.toISOString()).toBe(
      '2027-03-14T14:59:59.999Z',
    );
  });

  it('stops at the calendar end and the limit', () => {
    const weekly = rules({ cadence: 'WEEKLY', anchorDate: d('2026-10-04') });
    expect(
      periodsBetween(weekly, {
        from: d('2026-10-04'),
        through: d('2026-12-31'),
        endBy: d('2026-10-24'),
        limit: 100,
      }).map((p) => formatDate(p.periodEnd)),
    ).toEqual(['2026-10-10', '2026-10-17', '2026-10-24']);
    expect(
      periodsBetween(weekly, {
        from: d('2026-10-04'),
        through: d('2027-12-31'),
        limit: 2,
      }),
    ).toHaveLength(2);
  });

  it('knows which dates start periods', () => {
    const biweekly = rules();
    expect(isPeriodStart(biweekly, d('2026-01-18'))).toBe(true);
    expect(isPeriodStart(biweekly, d('2026-01-11'))).toBe(false);
    // Before the anchor the rhythm still holds (used for alignment only).
    expect(isPeriodStart(biweekly, d('2025-12-21'))).toBe(true);
    expect(
      formatDate(firstPeriodStartOnOrAfter(biweekly, d('2026-01-05'))),
    ).toBe('2026-01-18');
    const semi = rules({ cadence: 'SEMIMONTHLY', anchorDate: d('2026-01-16') });
    expect(formatDate(firstPeriodStartOnOrAfter(semi, d('2026-01-17')))).toBe(
      '2026-02-01',
    );
  });

  it('requires a calendar range of whole periods, starting at or after the anchor', () => {
    const biweekly = rules();
    expect(
      codeOf(() => assertCalendarSeries(biweekly, d('2026-01-18'), null)),
    ).toBeNull();
    expect(
      codeOf(() =>
        assertCalendarSeries(biweekly, d('2026-01-18'), d('2026-01-31')),
      ),
    ).toBeNull();
    for (const [from, to] of [
      ['2026-01-19', null],
      ['2025-12-21', null],
      ['2026-01-18', '2026-01-30'],
    ] as const) {
      expect(
        codeOf(() =>
          assertCalendarSeries(biweekly, d(from), to ? d(to) : null),
        ),
      ).toBe('PAYROLL_CALENDAR_SERIES_INVALID');
    }
    // A weekly calendar cannot pay 7 days before its period ends (before it starts).
    expect(
      codeOf(() =>
        assertCalendarSeries(
          rules({
            cadence: 'WEEKLY',
            anchorDate: d('2026-01-04'),
            payDateOffsetDays: -7,
          }),
          d('2026-01-04'),
          null,
        ),
      ),
    ).toBe('PAYROLL_CALENDAR_SERIES_INVALID');
  });
});
