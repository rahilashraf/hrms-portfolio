import { describe, expect, it } from 'vitest';
import { isIsoCurrency } from '../common/currency.js';
import {
  assertCalendarEffectiveRange,
  assertCalendarRules,
  assertPayrollPeriodDates,
  assertPayrollRunMutable,
  isPayrollValidationCode,
  isTerminalPayrollRunStatus,
  parsePayrollCurrency,
  parsePayrollTimezone,
} from './payroll-domain.js';

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (
      (error as { getResponse?: () => { code?: string } }).getResponse?.()
        .code ?? String(error)
    );
  }
  return null;
};
const period = (
  overrides: Partial<Parameters<typeof assertPayrollPeriodDates>[0]> = {},
) => ({
  periodStart: d('2026-11-01'),
  periodEnd: d('2026-11-14'),
  payDate: d('2026-11-20'),
  // 2026-11-17 17:00 in Toronto (EST, -05:00).
  processingCutoffAt: new Date('2026-11-17T22:00:00.000Z'),
  timezone: 'America/Toronto',
  ...overrides,
});
const rules = (
  overrides: Partial<Parameters<typeof assertCalendarRules>[0]> = {},
) => ({
  cadence: 'BIWEEKLY' as const,
  anchorDate: d('2026-11-01'),
  payDateOffsetDays: 6,
  processingCutoffOffsetDays: 3,
  ...overrides,
});

describe('Payroll domain (Phase 10 Batch 1)', () => {
  it('normalizes ISO-4217 currencies and refuses anything else', () => {
    expect(parsePayrollCurrency(' cad ')).toBe('CAD');
    expect(parsePayrollCurrency('USD')).toBe('USD');
    for (const value of ['', 'CA', 'CADD', 'XYZ', '12A', 12, null, undefined]) {
      expect(codeOf(() => parsePayrollCurrency(value))).toBe(
        'PAYROLL_CURRENCY_INVALID',
      );
    }
    // Shared with Compensation, so both domains agree on what a currency is.
    expect(isIsoCurrency('EUR')).toBe(true);
    expect(isIsoCurrency('eur')).toBe(false);
  });

  it('requires an explicit IANA timezone, never a default', () => {
    expect(parsePayrollTimezone(' America/Toronto ')).toBe('America/Toronto');
    expect(parsePayrollTimezone('UTC')).toBe('UTC');
    for (const value of ['', '   ', 'Mars/Olympus', 'EST5', undefined, null]) {
      expect(codeOf(() => parsePayrollTimezone(value))).toBe(
        'PAYROLL_TIMEZONE_INVALID',
      );
    }
  });

  it('validates calendar effective ranges', () => {
    expect(
      codeOf(() => assertCalendarEffectiveRange(d('2026-11-01'), null)),
    ).toBeNull();
    expect(
      codeOf(() =>
        assertCalendarEffectiveRange(d('2026-11-01'), d('2026-11-01')),
      ),
    ).toBeNull();
    expect(
      codeOf(() =>
        assertCalendarEffectiveRange(d('2026-11-01'), d('2026-10-31')),
      ),
    ).toBe('PAYROLL_CALENDAR_EFFECTIVE_RANGE_INVALID');
  });

  it('validates calendar anchors and offsets per cadence', () => {
    expect(codeOf(() => assertCalendarRules(rules()))).toBeNull();
    expect(
      codeOf(() =>
        assertCalendarRules(
          rules({ cadence: 'SEMIMONTHLY', anchorDate: d('2026-11-16') }),
        ),
      ),
    ).toBeNull();
    expect(
      codeOf(() =>
        assertCalendarRules(
          rules({ cadence: 'SEMIMONTHLY', anchorDate: d('2026-11-15') }),
        ),
      ),
    ).toBe('PAYROLL_CALENDAR_ANCHOR_INVALID');
    expect(
      codeOf(() =>
        assertCalendarRules(
          rules({ cadence: 'MONTHLY', anchorDate: d('2026-11-29') }),
        ),
      ),
    ).toBe('PAYROLL_CALENDAR_ANCHOR_INVALID');
    // Weekly and bi-weekly calendars may start on any day.
    expect(
      codeOf(() =>
        assertCalendarRules(
          rules({ cadence: 'WEEKLY', anchorDate: d('2026-11-30') }),
        ),
      ),
    ).toBeNull();
    for (const bad of [
      { payDateOffsetDays: -32 },
      { payDateOffsetDays: 61 },
      { payDateOffsetDays: 1.5 },
      { processingCutoffOffsetDays: -1 },
      { processingCutoffOffsetDays: 61 },
    ]) {
      expect(codeOf(() => assertCalendarRules(rules(bad)))).toBe(
        'PAYROLL_CALENDAR_OFFSET_INVALID',
      );
    }
    // Paying before the period ends (salaried, current pay) is allowed.
    expect(
      codeOf(() => assertCalendarRules(rules({ payDateOffsetDays: -3 }))),
    ).toBeNull();
  });

  it('validates period dates, length, pay date and cutoff', () => {
    expect(codeOf(() => assertPayrollPeriodDates(period()))).toBeNull();
    expect(
      codeOf(() =>
        assertPayrollPeriodDates(
          period({ periodStart: d('2026-11-15'), periodEnd: d('2026-11-14') }),
        ),
      ),
    ).toBe('PAYROLL_PERIOD_DATES_INVALID');
    // A one-day period and a full 31-day month are both valid; 32 days is not.
    expect(
      codeOf(() =>
        assertPayrollPeriodDates(
          period({ periodStart: d('2026-11-14'), periodEnd: d('2026-11-14') }),
        ),
      ),
    ).toBeNull();
    expect(
      codeOf(() =>
        assertPayrollPeriodDates(
          period({
            periodStart: d('2026-12-01'),
            periodEnd: d('2026-12-31'),
            payDate: d('2026-12-31'),
            processingCutoffAt: new Date('2026-12-28T22:00:00.000Z'),
          }),
        ),
      ),
    ).toBeNull();
    expect(
      codeOf(() =>
        assertPayrollPeriodDates(
          period({
            periodStart: d('2026-12-01'),
            periodEnd: d('2027-01-01'),
            payDate: d('2027-01-05'),
          }),
        ),
      ),
    ).toBe('PAYROLL_PERIOD_DATES_INVALID');
    expect(
      codeOf(() =>
        assertPayrollPeriodDates(period({ payDate: d('2026-10-31') })),
      ),
    ).toBe('PAYROLL_PERIOD_PAY_DATE_INVALID');
  });

  it('reads the processing cutoff in the period timezone', () => {
    // 2026-11-21 03:00 UTC is still 2026-11-20 (pay date) in Toronto: allowed.
    expect(
      codeOf(() =>
        assertPayrollPeriodDates(
          period({ processingCutoffAt: new Date('2026-11-21T03:00:00.000Z') }),
        ),
      ),
    ).toBeNull();
    // The same instant is already 2026-11-21 in Tokyo: after the pay date.
    expect(
      codeOf(() =>
        assertPayrollPeriodDates(
          period({
            processingCutoffAt: new Date('2026-11-21T03:00:00.000Z'),
            timezone: 'Asia/Tokyo',
          }),
        ),
      ),
    ).toBe('PAYROLL_PERIOD_CUTOFF_INVALID');
    expect(
      codeOf(() => assertPayrollPeriodDates(period({ timezone: '' }))),
    ).toBe('PAYROLL_TIMEZONE_INVALID');
  });

  it('treats finalized and voided runs as terminal', () => {
    expect(isTerminalPayrollRunStatus('FINALIZED')).toBe(true);
    expect(isTerminalPayrollRunStatus('VOIDED')).toBe(true);
    for (const status of ['DRAFT', 'CALCULATED', 'APPROVED'] as const) {
      expect(isTerminalPayrollRunStatus(status)).toBe(false);
      expect(codeOf(() => assertPayrollRunMutable({ status }))).toBeNull();
    }
    expect(codeOf(() => assertPayrollRunMutable({ status: 'FINALIZED' }))).toBe(
      'PAYROLL_RUN_FINAL',
    );
    expect(codeOf(() => assertPayrollRunMutable({ status: 'VOIDED' }))).toBe(
      'PAYROLL_RUN_FINAL',
    );
  });

  it('accepts only stable machine-readable validation codes', () => {
    for (const code of [
      'MISSING_COMPENSATION',
      'HOURLY_SIGN_IN_ONLY_UNSUPPORTED',
      'STALE_SOURCE_DATA',
    ]) {
      expect(isPayrollValidationCode(code)).toBe(true);
    }
    for (const code of ['', 'M', 'missing_compensation', '1ABC', 'HAS SPACE']) {
      expect(isPayrollValidationCode(code)).toBe(false);
    }
  });
});
