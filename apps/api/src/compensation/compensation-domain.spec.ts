import { describe, expect, it } from 'vitest';
import {
  assertNoOverlap,
  assertSalaryArrangementPeriod,
  assertWithinAssignment,
  compensationTimezone,
  formatRateAmount,
  parseCurrency,
  parsePayBasis,
  parseRateAmount,
  parseSalaryArrangement,
  periodsOverlap,
  planChange,
  recordEffectiveOn,
  recordsOutsideAssignment,
  type AssignmentBounds,
} from './compensation-domain.js';

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const record = (id: string, from: string, to: string | null) => ({
  id,
  effectiveFrom: d(from),
  effectiveTo: to === null ? null : d(to),
});
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
const assignment = (
  overrides: Partial<AssignmentBounds> = {},
): AssignmentBounds => ({
  id: 'a',
  status: 'ACTIVE',
  startDate: d('2026-01-01'),
  endDate: null,
  ...overrides,
});

describe('compensation values', () => {
  it('accepts decimal strings only and keeps them exact', () => {
    expect(parseRateAmount('24.5').canonical).toBe('24.5000');
    expect(parseRateAmount('0.0001').canonical).toBe('0.0001');
    expect(parseRateAmount(' 12 ').canonical).toBe('12.0000');
    expect(parseRateAmount('999999999999999.9999').canonical).toBe(
      '999999999999999.9999',
    );
    expect(formatRateAmount(parseRateAmount('62000').decimal)).toBe(
      '62000.0000',
    );
    for (const bad of [
      24.5,
      '',
      '0',
      '0.0000',
      '-1',
      '1.23456',
      '01',
      '1e3',
      '1,000',
      '1000000000000000',
      null,
    ]) {
      expect(codeOf(() => parseRateAmount(bad))).toBe(
        'COMPENSATION_RATE_INVALID',
      );
    }
  });

  it('normalizes ISO-4217 currencies and refuses unknown ones', () => {
    expect(parseCurrency(' cad ')).toBe('CAD');
    expect(parseCurrency('USD')).toBe('USD');
    for (const bad of ['', 'CA', 'CADD', 'XYZ', 12]) {
      expect(codeOf(() => parseCurrency(bad))).toBe(
        'COMPENSATION_CURRENCY_INVALID',
      );
    }
  });

  it('knows exactly two pay bases', () => {
    expect(parsePayBasis('HOURLY')).toBe('HOURLY');
    expect(parsePayBasis('SALARY')).toBe('SALARY');
    expect(codeOf(() => parsePayBasis('MONTHLY'))).not.toBeNull();
  });

  it('validates salary arrangement metadata without broadening pay basis', () => {
    expect(parseSalaryArrangement('SALARY', {}).salaryArrangement).toBe(
      'ANNUAL',
    );
    const fixed = parseSalaryArrangement('SALARY', {
      salaryArrangement: 'FIXED_PERIOD',
      salaryMonthlyAmount: '4000',
      salaryPaidMonths: 10,
      salaryContractAmount: '40000',
      salaryPeriodStart: '2026-09-01',
      salaryPeriodEnd: '2027-06-30',
    });
    expect(fixed.salaryMonthlyAmount?.toFixed(4)).toBe('4000.0000');
    expect(fixed.salaryPaidMonths).toBe(10);
    expect(
      parseSalaryArrangement('SALARY', {
        salaryArrangement: 'CONTRACT_TOTAL',
        salaryContractAmount: '1000',
        salaryPeriodStart: '2026-10-04',
        salaryPeriodEnd: '2026-10-24',
      }).salaryContractAmount?.toFixed(4),
    ).toBe('1000.0000');
    expect(
      codeOf(() =>
        parseSalaryArrangement('HOURLY', { salaryArrangement: 'ANNUAL' }),
      ),
    ).toBe('COMPENSATION_SALARY_ARRANGEMENT_INVALID');
    expect(
      codeOf(() =>
        parseSalaryArrangement('SALARY', {
          salaryArrangement: 'FIXED_PERIOD',
          salaryMonthlyAmount: '4000',
          salaryPaidMonths: 9,
          salaryContractAmount: '40000',
          salaryPeriodStart: '2026-09-01',
          salaryPeriodEnd: '2027-06-30',
        }),
      ),
    ).toBe('COMPENSATION_SALARY_ARRANGEMENT_INVALID');
  });

  it('validates fixed-period paid periods as whole calendar months across month-end edges', () => {
    const fixed = (
      salaryPeriodStart: string,
      salaryPeriodEnd: string,
      salaryPaidMonths: number,
      salaryContractAmount = String(4000 * salaryPaidMonths),
    ) =>
      parseSalaryArrangement('SALARY', {
        salaryArrangement: 'FIXED_PERIOD',
        salaryMonthlyAmount: '4000',
        salaryPaidMonths,
        salaryContractAmount,
        salaryPeriodStart,
        salaryPeriodEnd,
      });
    // Year boundary, February, and leap years (2028 and 2000 leap; 2100 not).
    expect(fixed('2026-11-01', '2027-01-31', 3).salaryPaidMonths).toBe(3);
    expect(fixed('2026-02-01', '2026-02-28', 1).salaryPaidMonths).toBe(1);
    expect(fixed('2028-02-01', '2028-02-29', 1).salaryPaidMonths).toBe(1);
    expect(fixed('2027-09-01', '2028-02-29', 6).salaryPaidMonths).toBe(6);
    expect(fixed('2000-02-01', '2000-02-29', 1).salaryPaidMonths).toBe(1);
    expect(fixed('2100-02-01', '2100-02-28', 1).salaryPaidMonths).toBe(1);
    const derived = fixed('2026-09-01', '2027-06-30', 10);
    expect(derived.salaryContractAmount?.toFixed(4)).toBe('40000.0000');
    expect(derived.salaryPeriodEnd?.toISOString().slice(0, 10)).toBe(
      '2027-06-30',
    );
    for (const invalid of [
      () => fixed('2026-09-15', '2027-06-30', 10), // start not the first of a month
      () => fixed('2028-02-01', '2028-02-28', 1), // not the end of a leap February
      () => fixed('2026-09-01', '2027-06-29', 10), // end not a month end
      () => fixed('2026-09-01', '2027-07-31', 10), // end past the final paid month
      () => fixed('2026-09-01', '2027-06-30', 10, '39999'), // total not monthly × months
    ]) {
      expect(codeOf(invalid)).toBe('COMPENSATION_SALARY_ARRANGEMENT_INVALID');
    }
    // 2026 is not a leap year: February 29 is not a calendar date at all.
    expect(() => fixed('2026-02-01', '2026-02-29', 1)).toThrow(
      'salaryPeriodEnd must be a valid calendar date.',
    );
  });

  it('requires a fixed-period effective period to equal its paid period', () => {
    const salary = parseSalaryArrangement('SALARY', {
      salaryArrangement: 'FIXED_PERIOD',
      salaryMonthlyAmount: '4000',
      salaryPaidMonths: 10,
      salaryContractAmount: '40000',
      salaryPeriodStart: '2026-09-01',
      salaryPeriodEnd: '2027-06-30',
    });
    expect(() =>
      assertSalaryArrangementPeriod(salary, {
        effectiveFrom: d('2026-09-01'),
        effectiveTo: d('2027-06-30'),
      }),
    ).not.toThrow();
    for (const period of [
      { effectiveFrom: d('2026-08-01'), effectiveTo: d('2027-06-30') },
      { effectiveFrom: d('2026-09-01'), effectiveTo: d('2027-05-31') },
      { effectiveFrom: d('2026-09-01'), effectiveTo: null },
    ]) {
      expect(codeOf(() => assertSalaryArrangementPeriod(salary, period))).toBe(
        'COMPENSATION_SALARY_ARRANGEMENT_INVALID',
      );
    }
  });

  it('resolves the timezone from the work location, then the organization, never UTC by default', () => {
    expect(
      compensationTimezone({
        workLocation: { timezone: 'America/Toronto' },
        organization: { timezone: 'UTC' },
      }),
    ).toBe('America/Toronto');
    expect(
      compensationTimezone({
        workLocation: null,
        organization: { timezone: 'America/Vancouver' },
      }),
    ).toBe('America/Vancouver');
    expect(
      compensationTimezone({
        workLocation: { timezone: null },
        organization: { timezone: null },
      }),
    ).toBeNull();
  });
});

describe('compensation timeline', () => {
  const timeline = [
    record('r1', '2026-01-01', '2026-06-30'),
    record('r2', '2026-07-01', null),
  ];

  it('resolves zero or one record per date with inclusive bounds and gaps', () => {
    expect(recordEffectiveOn(timeline, d('2025-12-31'))).toBeNull();
    expect(recordEffectiveOn(timeline, d('2026-06-30'))?.id).toBe('r1');
    expect(recordEffectiveOn(timeline, d('2026-07-01'))?.id).toBe('r2');
    expect(recordEffectiveOn(timeline, d('2099-01-01'))?.id).toBe('r2');
    const gap = [
      record('r1', '2026-01-01', '2026-03-31'),
      record('r2', '2026-05-01', null),
    ];
    expect(recordEffectiveOn(gap, d('2026-04-15'))).toBeNull();
    expect(() =>
      recordEffectiveOn(
        [...timeline, record('x', '2026-06-01', '2026-06-30')],
        d('2026-06-15'),
      ),
    ).toThrow();
  });

  it('detects overlaps of inclusive, possibly open-ended periods', () => {
    expect(
      periodsOverlap(
        record('a', '2026-01-01', '2026-06-30'),
        record('b', '2026-06-30', null),
      ),
    ).toBe(true);
    expect(
      periodsOverlap(
        record('a', '2026-01-01', '2026-06-29'),
        record('b', '2026-06-30', null),
      ),
    ).toBe(false);
    expect(
      periodsOverlap(
        record('a', '2026-01-01', null),
        record('b', '2030-01-01', '2030-01-01'),
      ),
    ).toBe(true);
    expect(
      codeOf(() =>
        assertNoOverlap(timeline, record('n', '2025-01-01', '2026-01-01')),
      ),
    ).toBe('COMPENSATION_OVERLAP');
    expect(
      codeOf(() =>
        assertNoOverlap(timeline, record('n', '2025-01-01', '2025-12-31')),
      ),
    ).toBeNull();
  });

  it('plans a change as closing the covering period the day before', () => {
    const plan = planChange(timeline, d('2026-03-15'));
    expect(plan.previous.id).toBe('r1');
    expect(plan.previousNewEnd).toEqual(d('2026-03-14'));
    expect(plan.period).toEqual({
      effectiveFrom: d('2026-03-15'),
      effectiveTo: d('2026-06-30'),
    });
    expect(planChange(timeline, d('2027-01-01')).period.effectiveTo).toBeNull();
    expect(codeOf(() => planChange(timeline, d('2025-06-01')))).toBe(
      'COMPENSATION_NOT_IN_EFFECT',
    );
    expect(codeOf(() => planChange(timeline, d('2026-07-01')))).toBe(
      'COMPENSATION_CHANGE_ON_START',
    );
  });

  it('plans a contracted salary change as exactly its paid period, never over a scheduled record', () => {
    const annual = [record('a', '2026-01-01', null)];
    // Open-ended annual → fixed period: the annual closes the day before, the contract is exact.
    const plan = planChange(annual, d('2026-09-01'), d('2027-06-30'));
    expect(plan.previous.id).toBe('a');
    expect(plan.previousNewEnd).toEqual(d('2026-08-31'));
    expect(plan.period).toEqual({
      effectiveFrom: d('2026-09-01'),
      effectiveTo: d('2027-06-30'),
    });
    // A bounded covering record that outlasts the contract: still exactly the paid period.
    expect(
      planChange(
        [record('a', '2026-01-01', '2027-12-31')],
        d('2026-09-01'),
        d('2027-06-30'),
      ).period.effectiveTo,
    ).toEqual(d('2027-06-30'));
    // A change already scheduled inside the contract is never overwritten.
    const scheduled = [
      record('a', '2026-01-01', '2026-12-31'),
      record('b', '2027-01-01', null),
    ];
    expect(
      codeOf(() => planChange(scheduled, d('2026-09-01'), d('2027-06-30'))),
    ).toBe('COMPENSATION_CHANGE_OVERLAPS_SCHEDULED');
    // Ending the day before the scheduled record is fine.
    expect(
      planChange(scheduled, d('2026-09-01'), d('2026-12-31')).period,
    ).toEqual({ effectiveFrom: d('2026-09-01'), effectiveTo: d('2026-12-31') });
    // Without a contracted end the plan is unchanged (runs to the covering record's end).
    expect(planChange(scheduled, d('2026-09-01')).period.effectiveTo).toEqual(
      d('2026-12-31'),
    );
  });
});

describe('compensation on the assignment lifecycle', () => {
  it('keeps periods within the assignment and none on a cancelled one', () => {
    const ended = assignment({ status: 'ENDED', endDate: d('2026-06-30') });
    expect(
      codeOf(() =>
        assertWithinAssignment(assignment(), record('n', '2026-01-01', null)),
      ),
    ).toBeNull();
    expect(
      codeOf(() =>
        assertWithinAssignment(assignment(), record('n', '2025-12-31', null)),
      ),
    ).toBe('COMPENSATION_OUTSIDE_ASSIGNMENT');
    expect(
      codeOf(() =>
        assertWithinAssignment(ended, record('n', '2026-01-01', null)),
      ),
    ).toBeNull();
    expect(
      codeOf(() =>
        assertWithinAssignment(ended, record('n', '2026-07-01', null)),
      ),
    ).toBe('COMPENSATION_OUTSIDE_ASSIGNMENT');
    expect(
      codeOf(() =>
        assertWithinAssignment(ended, record('n', '2026-01-01', '2026-07-31')),
      ),
    ).toBe('COMPENSATION_OUTSIDE_ASSIGNMENT');
    expect(
      codeOf(() =>
        assertWithinAssignment(
          assignment(),
          record('n', '2026-03-01', '2026-02-01'),
        ),
      ),
    ).toBe('COMPENSATION_PERIOD_INVALID');
    expect(
      codeOf(() =>
        assertWithinAssignment(
          assignment({ status: 'CANCELLED' }),
          record('n', '2026-01-01', null),
        ),
      ),
    ).toBe('COMPENSATION_ASSIGNMENT_CANCELLED');
    const planned = assignment({
      status: 'PLANNED',
      startDate: d('2027-01-01'),
    });
    expect(
      codeOf(() =>
        assertWithinAssignment(planned, record('n', '2027-01-01', null)),
      ),
    ).toBeNull();
  });

  it('lists the records an assignment change would strand', () => {
    const timeline = [
      record('r1', '2026-01-01', '2026-11-30'),
      record('r2', '2026-12-01', null),
    ];
    const ids = (next: Parameters<typeof recordsOutsideAssignment>[1]) =>
      recordsOutsideAssignment(timeline, next).map((r) => r.id);
    expect(
      ids({ status: 'ACTIVE', startDate: d('2026-01-01'), endDate: null }),
    ).toEqual([]);
    expect(
      ids({
        status: 'ENDED',
        startDate: d('2026-01-01'),
        endDate: d('2026-12-31'),
      }),
    ).toEqual([]);
    expect(
      ids({
        status: 'ENDED',
        startDate: d('2026-01-01'),
        endDate: d('2026-11-30'),
      }),
    ).toEqual(['r2']);
    expect(
      ids({
        status: 'ENDED',
        startDate: d('2026-01-01'),
        endDate: d('2026-10-31'),
      }),
    ).toEqual(['r1', 'r2']);
    expect(
      ids({ status: 'ACTIVE', startDate: d('2026-02-01'), endDate: null }),
    ).toEqual(['r1']);
    expect(
      ids({ status: 'CANCELLED', startDate: d('2026-01-01'), endDate: null }),
    ).toEqual(['r1', 'r2']);
  });
});
