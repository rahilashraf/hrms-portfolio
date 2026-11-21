import { describe, expect, it } from 'vitest';
import {
  fixedPeriodEnd,
  formatAmount,
  formatPeriod,
  formatRate,
  isFirstOfMonth,
  isValidRate,
  multiplyAmount,
  parsePaidMonths,
} from './format';

describe('compensation format', () => {
  it('formats exact decimal strings without floating point', () => {
    expect(formatAmount('24.5000')).toBe('24.50');
    expect(formatAmount('62000.0000')).toBe('62,000.00');
    expect(formatAmount('24.1234')).toBe('24.1234');
    expect(formatAmount('999999999999999.9999')).toBe('999,999,999,999,999.9999');
    expect(formatAmount(null)).toBe('—');
  });

  it('labels rates by basis and periods by inclusive dates', () => {
    expect(formatRate('24.5000', 'CAD', 'HOURLY')).toBe('CAD 24.50 / hour');
    expect(formatRate('62000.0000', 'USD', 'SALARY')).toBe('USD 62,000.00 / year');
    expect(formatRate('4000.0000', 'CAD', 'SALARY', 'FIXED_PERIOD')).toBe('CAD 4,000.00 / month');
    expect(formatRate('1000.0000', 'CAD', 'SALARY', 'CONTRACT_TOTAL')).toBe(
      'CAD 1,000.00 contract',
    );
    expect(formatPeriod('2026-01-01', '2026-06-30')).toBe('01/01/2026 – 06/30/2026');
    expect(formatPeriod('2026-07-01', null)).toBe('07/01/2026 – ongoing');
  });

  it('validates typed rates like the API', () => {
    for (const ok of ['24.5', '62000', '0.0001', ' 12 ']) expect(isValidRate(ok)).toBe(true);
    for (const bad of ['', '0', '0.00', '-1', '1.23456', '01', '1e3', '1,000', 'abc']) {
      expect(isValidRate(bad)).toBe(false);
    }
  });

  it('derives the fixed-period paid-through date at the end of the final paid month', () => {
    expect(fixedPeriodEnd('2026-09-01', 10)).toBe('2027-06-30');
    expect(fixedPeriodEnd('2026-01-01', 1)).toBe('2026-01-31');
    expect(fixedPeriodEnd('2026-11-01', 3)).toBe('2027-01-31');
    expect(fixedPeriodEnd('2026-12-01', 1)).toBe('2026-12-31');
    expect(fixedPeriodEnd('2026-02-01', 1)).toBe('2026-02-28');
    expect(fixedPeriodEnd('2028-02-01', 1)).toBe('2028-02-29');
    expect(fixedPeriodEnd('2027-09-01', 6)).toBe('2028-02-29');
    expect(fixedPeriodEnd('2100-02-01', 1)).toBe('2100-02-28');
    expect(fixedPeriodEnd('2000-02-01', 1)).toBe('2000-02-29');
    expect(fixedPeriodEnd('2026-04-01', 1)).toBe('2026-04-30');
    expect(fixedPeriodEnd('2026-01-01', 120)).toBe('2035-12-31');
    expect(fixedPeriodEnd('2026-09-02', 10)).toBeNull();
    expect(fixedPeriodEnd('2026-13-01', 1)).toBeNull();
    expect(fixedPeriodEnd('', 1)).toBeNull();
    expect(fixedPeriodEnd('2026-09-01', 0)).toBeNull();
    expect(fixedPeriodEnd('2026-09-01', 121)).toBeNull();
    expect(isFirstOfMonth('2026-09-01')).toBe(true);
    expect(isFirstOfMonth('2026-09-30')).toBe(false);
  });

  it('multiplies exact amounts by paid months without floating point', () => {
    expect(multiplyAmount('4000', 10)).toBe('40000');
    expect(multiplyAmount(' 4000.50 ', 10)).toBe('40005');
    expect(multiplyAmount('0.1', 3)).toBe('0.3');
    expect(multiplyAmount('1234.5678', 12)).toBe('14814.8136');
    expect(multiplyAmount('0.0001', 1)).toBe('0.0001');
    expect(multiplyAmount('999999999999999.9999', 120)).toBe('119999999999999999.988');
    expect(multiplyAmount('1e3', 2)).toBeNull();
    expect(multiplyAmount('1.23456', 2)).toBeNull();
  });

  it('parses paid months as a whole number from 1 to 120', () => {
    expect(parsePaidMonths(' 10 ')).toBe(10);
    expect(parsePaidMonths('120')).toBe(120);
    for (const bad of ['', '0', '121', '1.5', '-1', '01', 'ten']) {
      expect(parsePaidMonths(bad)).toBeNull();
    }
  });
});
