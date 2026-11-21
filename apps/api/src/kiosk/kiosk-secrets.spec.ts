import { describe, expect, it } from 'vitest';
import {
  enrollmentCode,
  normalizeEmployeeNumber,
  normalizeEnrollmentCode,
  PIN_PATTERN,
  randomPin,
  randomSecret,
  sha256,
  weakPin,
} from './kiosk-secrets.js';

describe('kiosk secrets', () => {
  it('generates unambiguous, typeable enrollment codes compared loosely', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = enrollmentCode();
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
      expect(
        normalizeEnrollmentCode(code.toLowerCase().replace('-', ' ')),
      ).toBe(code.replace('-', ''));
    }
  });

  it('generates random device secrets and stores only their SHA-256', () => {
    const a = randomSecret();
    const b = randomSecret();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(sha256(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses trivial PINs and never issues one', () => {
    for (const pin of [
      '000000',
      '111111',
      '123456',
      '654321',
      '012345',
      '987654',
    ]) {
      expect(weakPin(pin)).toBe(true);
    }
    for (const pin of ['482915', '135790', '120345'])
      expect(weakPin(pin)).toBe(false);
    for (let i = 0; i < 200; i += 1) {
      const pin = randomPin();
      expect(pin).toMatch(PIN_PATTERN);
      expect(weakPin(pin)).toBe(false);
    }
  });

  it('normalizes employee numbers', () => {
    expect(normalizeEmployeeNumber('  emp-000123 ')).toBe('EMP-000123');
  });
});
