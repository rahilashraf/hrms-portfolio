import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertIanaTimezone, isIanaTimezone } from './timezone.js';

describe('timezone', () => {
  it('accepts canonical IANA zones and UTC', () => {
    expect(isIanaTimezone('America/Toronto')).toBe(true);
    expect(isIanaTimezone('UTC')).toBe(true);
  });

  it('accepts current names and their aliases alike (Batch 4D, D-A)', () => {
    for (const zone of [
      'Asia/Kolkata',
      'Asia/Calcutta',
      'Europe/Kyiv',
      'Europe/Kiev',
      'Asia/Kathmandu',
      'America/Argentina/Buenos_Aires',
      'Australia/Adelaide',
      'Etc/UTC',
      'Etc/GMT+5',
    ]) {
      expect(isIanaTimezone(zone)).toBe(true);
    }
    expect(assertIanaTimezone(' Asia/Kolkata ')).toBe('Asia/Kolkata');
  });

  it('rejects raw offsets and bare abbreviations', () => {
    for (const zone of ['+05:30', '-04:00', 'EST', 'EST5EDT', 'GMT+5']) {
      expect(isIanaTimezone(zone)).toBe(false);
    }
  });

  it('rejects blank, abbreviated, and unknown zones', () => {
    expect(isIanaTimezone('')).toBe(false);
    expect(isIanaTimezone('   ')).toBe(false);
    expect(isIanaTimezone('EST')).toBe(false);
    expect(isIanaTimezone('NotATimezone/Fake')).toBe(false);
  });

  it('returns the trimmed zone or throws BadRequestException', () => {
    expect(assertIanaTimezone('  Europe/London ')).toBe('Europe/London');
    expect(() => assertIanaTimezone('EST')).toThrow(BadRequestException);
    expect(() => assertIanaTimezone('')).toThrow(
      'timezone must be a valid IANA time zone.',
    );
  });
});
