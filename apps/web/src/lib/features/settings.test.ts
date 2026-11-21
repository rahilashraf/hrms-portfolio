import { describe, expect, it } from 'vitest';
import {
  CORE_SECTION_LABEL,
  integerRangeText,
  isRetentionSetting,
  parseIntegerSetting,
  settingSectionLabel,
} from './settings';

const retention = { kind: 'integer' as const, min: 0, max: 120, minWhenEnabled: 6 };
const plain = { kind: 'integer' as const, min: 1, max: 30 };

describe('settings sections', () => {
  it('labels the CORE section and modules', () => {
    expect(CORE_SECTION_LABEL).toBe('Core HR & audit');
    expect(settingSectionLabel('CORE')).toBe('Core HR & audit');
    expect(settingSectionLabel('RECRUITMENT')).toBe('Recruitment');
    expect(settingSectionLabel('UNKNOWN')).toBe('UNKNOWN');
  });

  it('recognizes retention keys', () => {
    expect(isRetentionSetting('retention.auditLogMonths')).toBe(true);
    expect(isRetentionSetting('performance.retentionDays')).toBe(false);
  });
});

describe('parseIntegerSetting', () => {
  it('accepts 0 (off) or a value from minWhenEnabled to max', () => {
    expect(parseIntegerSetting(retention, '0')).toEqual({ value: 0, problem: null });
    expect(parseIntegerSetting(retention, '6')).toEqual({ value: 6, problem: null });
    expect(parseIntegerSetting(retention, '120')).toEqual({ value: 120, problem: null });
    for (const draft of ['1', '5', '121', '-1']) {
      expect(parseIntegerSetting(retention, draft)).toEqual({
        value: null,
        problem: 'Enter 0 to turn this off, or a number from 6 to 120.',
      });
    }
  });

  it('keeps the plain min–max rule without minWhenEnabled', () => {
    expect(parseIntegerSetting(plain, '1')).toEqual({ value: 1, problem: null });
    expect(parseIntegerSetting(plain, '0')).toEqual({
      value: null,
      problem: 'Enter a number from 1 to 30.',
    });
    expect(parseIntegerSetting(plain, '31').problem).toBe('Enter a number from 1 to 30.');
  });

  it('requires a whole number', () => {
    for (const draft of ['', ' ', '2.5', 'abc']) {
      expect(parseIntegerSetting(retention, draft)).toEqual({
        value: null,
        problem: 'Enter a whole number.',
      });
    }
  });

  it('describes the accepted range', () => {
    expect(integerRangeText(retention)).toBe('0 (off) or 6–120');
    expect(integerRangeText(plain)).toBe('1–30');
    // A floor that is not above min adds nothing.
    expect(integerRangeText({ kind: 'integer', min: 5, max: 9, minWhenEnabled: 6 })).toBe('5–9');
  });
});
