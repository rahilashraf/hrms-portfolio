import { describe, expect, it } from 'vitest';
import { formatDateOnly } from './date';

describe('formatDateOnly', () => {
  it('preserves the literal calendar date', () => {
    expect(formatDateOnly('2026-09-01')).toBe('Sep 1, 2026');
    expect(formatDateOnly('2026-09-30')).toBe('Sep 30, 2026');
  });

  it('handles null and malformed values without timezone conversion', () => {
    expect(formatDateOnly(null)).toBe('—');
    expect(formatDateOnly('not-a-date')).toBe('not-a-date');
  });
});
