import { describe, expect, it } from 'vitest';
import {
  RETENTION_MINIMUM_MONTHS,
  settingDefinition,
  validateSettingValue,
} from '../features/features-domain.js';
import {
  emptyRetentionCounts,
  RETENTION_DATASETS,
  retentionChanged,
  retentionMonths,
  retentionPlans,
} from './retention-domain.js';

const row = (organizationId: string, key: string, value: unknown) => ({
  organizationId,
  key,
  value,
  schemaVersion: 1,
});

describe('retention domain', () => {
  it('registers every retention period as an integer setting that defaults to off', () => {
    for (const { key } of RETENTION_DATASETS) {
      const definition = settingDefinition(key)!;
      expect(definition).toBeDefined();
      expect(definition.default).toBe(0);
      expect(definition.type).toMatchObject({
        kind: 'integer',
        min: 0,
        minWhenEnabled: RETENTION_MINIMUM_MONTHS[key],
      });
    }
    expect(RETENTION_MINIMUM_MONTHS['retention.auditLogMonths']).toBe(24);
  });

  it('accepts 0 (off) or a period at or above the hard minimum', () => {
    const audit = settingDefinition('retention.auditLogMonths')!;
    expect(validateSettingValue(audit, 0)).toBe(0);
    expect(validateSettingValue(audit, 24)).toBe(24);
    expect(validateSettingValue(audit, 240)).toBe(240);
    for (const value of [1, 12, 23, 241, -1, 2.5, '24', true]) {
      expect(() => validateSettingValue(audit, value)).toThrow();
    }
    const candidates = settingDefinition('retention.rejectedCandidateMonths')!;
    expect(() => validateSettingValue(candidates, 5)).toThrow(
      /must be 0 \(off\) or from 6 to 120/,
    );
  });

  it('treats missing, reset, foreign-version and out-of-rule values as off', () => {
    const key = 'retention.notificationMonths' as const;
    expect(retentionMonths(key, null)).toBe(0);
    expect(retentionMonths(key, { value: null, schemaVersion: 1 })).toBe(0);
    expect(retentionMonths(key, { value: 12, schemaVersion: 2 })).toBe(0);
    expect(retentionMonths(key, { value: 2, schemaVersion: 1 })).toBe(0);
    expect(retentionMonths(key, { value: '12', schemaVersion: 1 })).toBe(0);
    expect(retentionMonths(key, { value: 12, schemaVersion: 1 })).toBe(12);
  });

  it('plans only organizations with a non-zero period and honours module gates', () => {
    const plans = retentionPlans(
      [
        row('org-b', 'retention.auditLogMonths', 36),
        row('org-b', 'retention.syncLogMonths', 6),
        row('org-a', 'retention.rejectedCandidateMonths', 12),
        row('org-a', 'retention.notificationMonths', 0),
        row('org-c', 'retention.notificationMonths', 0),
        row('org-d', 'retention.syncLogMonths', 6),
      ],
      (organizationId, module) =>
        !(organizationId !== 'org-a' && module === 'GOOGLE_WORKSPACE'),
    );
    expect(plans).toEqual([
      {
        organizationId: 'org-a',
        datasets: [{ dataset: 'candidates', months: 12 }],
        gated: [],
      },
      {
        organizationId: 'org-b',
        datasets: [{ dataset: 'auditLog', months: 36 }],
        gated: [{ dataset: 'syncLogs', module: 'GOOGLE_WORKSPACE' }],
      },
      {
        organizationId: 'org-d',
        datasets: [],
        gated: [{ dataset: 'syncLogs', module: 'GOOGLE_WORKSPACE' }],
      },
    ]);
    expect(retentionPlans([], () => true)).toEqual([]);
  });

  it('reports a change only when something was purged or anonymized', () => {
    const counts = emptyRetentionCounts();
    expect(retentionChanged(counts)).toBe(false);
    counts.syncRunsDeleted = 1;
    expect(retentionChanged(counts)).toBe(true);
  });
});
