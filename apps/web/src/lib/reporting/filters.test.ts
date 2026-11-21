import { describe, expect, it } from 'vitest';
import {
  addDaysTo,
  defaultFilterValues,
  requestFilters,
  todayIn,
  validateFilters,
} from './filters';
import type { CatalogReport } from './types';

const UUID = '22222222-2222-4222-8222-222222222222';

const report = (overrides: Partial<CatalogReport> = {}) =>
  ({
    dateMode: 'RANGE',
    filters: ['from', 'to', 'departmentId', 'employmentType', 'groupBy'],
    groupBy: ['month', 'department'],
    defaultGroupBy: 'month',
    ...overrides,
  }) as CatalogReport;

describe('report filters', () => {
  it('defaults to the twelve months ending today, or today for as-of reports', () => {
    const range = defaultFilterValues(report(), '2026-10-06');
    expect(range.from).toBe('2025-10-07');
    expect(range.to).toBe('2026-10-06');
    expect(range.asOf).toBe('');
    expect(range.groupBy).toBe('month');
    const asOf = defaultFilterValues(
      report({ dateMode: 'AS_OF', filters: ['asOf'], groupBy: null, defaultGroupBy: null }),
      '2026-10-06',
    );
    expect(asOf.asOf).toBe('2026-10-06');
    expect(asOf.from).toBe('');
    expect(asOf.groupBy).toBe('');
    const none = defaultFilterValues(report({ dateMode: 'NONE', filters: [] }), '2026-10-06');
    expect(none.from).toBe('');
  });

  it('sends only supported, non-empty filters', () => {
    const values = defaultFilterValues(report(), '2026-10-06');
    values.departmentId = ` ${UUID} `;
    values.teamId = UUID; // not supported by this report
    expect(requestFilters(report(), values)).toEqual({
      from: '2025-10-07',
      to: '2026-10-06',
      departmentId: UUID,
      groupBy: 'month',
    });
  });

  it('validates dates, ranges, identifiers and employment types', () => {
    const r = report();
    expect(validateFilters(r, { from: '2026-01-01', to: '2026-02-01' })).toBeNull();
    expect(validateFilters(r, { from: '2026-02-30' })).toMatch(/valid YYYY-MM-DD/);
    expect(validateFilters(r, { from: '2026-03-01', to: '2026-02-01' })).toMatch(/on or before/);
    expect(validateFilters(r, { from: '2020-01-01', to: '2026-02-01' })).toMatch(/at most 1,830/);
    expect(validateFilters(r, { departmentId: 'sales' })).toMatch(/Department must be a valid/);
    expect(validateFilters(r, { employmentType: 'INTERN' })).toMatch(/employment type/);
  });

  it('computes dates', () => {
    expect(addDaysTo('2026-03-01', -1)).toBe('2026-02-28');
    expect(todayIn('Pacific/Auckland', new Date('2026-10-06T13:00:00Z'))).toBe('2026-10-07');
    expect(todayIn('America/Los_Angeles', new Date('2026-10-06T03:00:00Z'))).toBe('2026-10-05');
    expect(todayIn('Not/AZone', new Date(2026, 9, 6, 12))).toBe('2026-10-06');
  });
});
