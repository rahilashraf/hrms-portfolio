import { describe, expect, it } from 'vitest';
import { formatDateOnly, formatInstant, formatMinutes, label } from './format';

describe('time format helpers', () => {
  it('formats minutes and enum labels for operational tables', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatMinutes(null)).toBe('—');
    expect(label('CHANGES_REQUESTED')).toBe('Changes Requested');
  });

  it('formats dates and instants with the authoritative timezone', () => {
    expect(formatDateOnly('2026-10-03')).toBe('10/03/2026');
    expect(formatInstant('2026-10-03T02:00:00.000Z', 'America/Toronto')).toContain('Oct');
    expect(formatInstant(null, 'America/Toronto')).toBe('—');
  });
});
