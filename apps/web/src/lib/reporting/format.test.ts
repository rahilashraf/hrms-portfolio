import { describe, expect, it } from 'vitest';
import {
  chartSpec,
  formatCell,
  formatValue,
  isSuppressedCell,
  rowCurrency,
  SUPPRESSED_TEXT,
  visibleColumns,
} from './format';
import type { ReportColumn } from './types';

const col = (key: string, type: ReportColumn['type'], label = key): ReportColumn => ({
  key,
  label,
  type,
});

describe('formatValue', () => {
  it('formats each column type', () => {
    expect(formatValue('integer', 1234567)).toBe('1,234,567');
    expect(formatValue('number', 12.345)).toBe('12.35');
    expect(formatValue('number', 3)).toBe('3');
    expect(formatValue('percent', 12.5)).toBe('12.5%');
    expect(formatValue('percent', 100)).toBe('100%');
    expect(formatValue('money', 1234.5)).toBe('1,234.50');
    expect(formatValue('money', 1234.5, 'CAD')).toBe('CAD 1,234.50');
    expect(formatValue('money', -20, 'USD')).toBe('USD -20.00');
    expect(formatValue('date', '2026-10-06')).toBe('Oct 6, 2026');
    expect(formatValue('month', '2026-01')).toBe('Jan 2026');
    expect(formatValue('boolean', true)).toBe('Yes');
    expect(formatValue('boolean', false)).toBe('No');
    expect(formatValue('string', 'Sales')).toBe('Sales');
  });

  it('shows missing values as an em dash and keeps unparseable values', () => {
    expect(formatValue('integer', null)).toBe('—');
    expect(formatValue('string', '')).toBe('—');
    expect(formatValue('date', 'soon')).toBe('soon');
    expect(formatValue('month', '2026-13-01')).toBe('2026-13-01');
    expect(formatValue('integer', 'n/a')).toBe('n/a');
  });
});

describe('formatCell', () => {
  it('labels money with the row currency', () => {
    const row = { currency: 'EUR', gross: 1000 };
    expect(rowCurrency(row)).toBe('EUR');
    expect(formatCell(col('gross', 'money'), row)).toBe('EUR 1,000.00');
    expect(rowCurrency({ currency: 'not a code' })).toBeNull();
    expect(formatCell(col('gross', 'money'), { gross: 5 })).toBe('5.00');
  });

  it('shows suppressed nulls as suppressed and other nulls as a dash', () => {
    const suppressed = { groupLabel: 'Sales', employees: null, suppressed: true };
    expect(isSuppressedCell(suppressed, col('employees', 'integer'))).toBe(true);
    expect(formatCell(col('employees', 'integer'), suppressed)).toBe(SUPPRESSED_TEXT);
    expect(SUPPRESSED_TEXT).toBe('Suppressed (fewer than 5)');
    expect(formatCell(col('groupLabel', 'string'), suppressed)).toBe('Sales');
    expect(formatCell(col('suppressed', 'boolean'), suppressed)).toBe('Yes');
    expect(formatCell(col('rate', 'percent'), { rate: null, suppressed: false })).toBe('—');
  });
});

describe('visibleColumns', () => {
  it('hides the group key identifier when a group label exists', () => {
    expect(
      visibleColumns([
        col('groupKey', 'string'),
        col('groupLabel', 'string'),
        col('n', 'integer'),
      ]).map((c) => c.key),
    ).toEqual(['groupLabel', 'n']);
    expect(visibleColumns([col('groupKey', 'string')]).map((c) => c.key)).toEqual(['groupKey']);
  });
});

describe('chartSpec', () => {
  const columns = [
    col('groupKey', 'string'),
    col('groupLabel', 'string', 'Group'),
    col('averageRate', 'money'),
    col('employees', 'integer', 'Employees'),
  ];

  it('charts the first count column with group labels', () => {
    const spec = chartSpec(columns, [
      { groupKey: 'a', groupLabel: 'Sales', averageRate: 10, employees: 10 },
      { groupKey: 'b', groupLabel: 'Ops', averageRate: null, employees: null, suppressed: true },
      { groupKey: 'c', groupLabel: 'R&D', averageRate: 5, employees: 5 },
    ]);
    expect(spec?.column.key).toBe('employees');
    expect(spec?.max).toBe(10);
    expect(spec?.bars.map((bar) => [bar.label, bar.value, bar.text, bar.suppressed])).toEqual([
      ['Sales', 10, '10', false],
      ['Ops', null, SUPPRESSED_TEXT, true],
      ['R&D', 5, '5', false],
    ]);
  });

  it('skips identifier-like numbers and charts nothing when it would not help', () => {
    const rating = chartSpec(
      [col('ratingLabel', 'string'), col('ratingValue', 'integer'), col('reviews', 'integer')],
      [
        { ratingLabel: 'Meets', ratingValue: 3, reviews: 9 },
        { ratingLabel: 'Exceeds', ratingValue: 4, reviews: 6 },
      ],
    );
    expect(rating?.column.key).toBe('reviews');
    expect(chartSpec(columns, [{ groupLabel: 'One', employees: 3 }])).toBeNull();
    expect(
      chartSpec(columns, [
        { groupLabel: 'A', employees: 0 },
        { groupLabel: 'B', employees: 0 },
      ]),
    ).toBeNull();
    expect(chartSpec([col('n', 'integer')], [{ n: 1 }, { n: 2 }])).toBeNull();
  });

  it('labels payroll bars by group only, never with "Not calculated" net pay', () => {
    const spec = chartSpec(
      [
        col('groupKey', 'string'),
        col('groupLabel', 'string', 'Group'),
        col('currency', 'string'),
        col('employees', 'integer'),
        col('gross', 'money'),
        col('grossLessRecordedDeductions', 'money'),
        col('netPay', 'string', 'Net pay'),
      ],
      [
        {
          groupKey: 'a',
          groupLabel: 'Sales',
          currency: 'CAD',
          employees: 4,
          gross: '100.00',
          grossLessRecordedDeductions: '90.00',
          netPay: 'Not calculated',
        },
        {
          groupKey: 'b',
          groupLabel: 'Ops',
          currency: 'CAD',
          employees: 6,
          gross: '200.00',
          grossLessRecordedDeductions: '180.00',
          netPay: 'Not calculated',
        },
      ],
    );
    expect(spec?.column.key).toBe('employees');
    expect(spec?.bars.map((bar) => bar.label)).toEqual(['Sales', 'Ops']);
  });

  it('keeps constant text labels when no other column tells the bars apart', () => {
    const spec = chartSpec(
      [col('periodStart', 'date'), col('currency', 'string'), col('runs', 'integer')],
      [
        { periodStart: '2026-01-01', currency: 'CAD', runs: 1 },
        { periodStart: '2026-01-01', currency: 'CAD', runs: 2 },
      ],
    );
    expect(spec?.labelColumns.map((column) => column.key)).toEqual(['periodStart', 'currency']);
  });
});
