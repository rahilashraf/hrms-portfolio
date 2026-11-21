import { describe, expect, it } from 'vitest';
import { isFutureDateOnly, localDateOnly } from './lifecycle';

describe('employee lifecycle date helpers', () => {
  it('formats the local calendar day without parsing assignment date strings', () => {
    expect(localDateOnly(new Date(2026, 0, 2, 23, 30))).toBe('2026-01-02');
  });

  it('compares normalized date-only strings without timezone drift', () => {
    expect(isFutureDateOnly('2026-10-02', '2026-10-02')).toBe(false);
    expect(isFutureDateOnly('2026-10-03', '2026-10-02')).toBe(true);
    expect(isFutureDateOnly('2026-10-01', '2026-10-02')).toBe(false);
  });
});
