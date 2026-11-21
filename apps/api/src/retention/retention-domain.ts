import {
  effectiveSettingValue,
  RETENTION_MINIMUM_MONTHS,
  settingDefinition,
  type FeatureModule,
  type RetentionSettingKey,
} from '../features/features-domain.js';

/**
 * Phase 19 — opt-in data retention. Pure rules only.
 *
 * Every retention.* setting defaults to 0 (off): nothing is purged or anonymized until an
 * organization opts in. HR records (employees, assignments, time, leave, payroll, documents,
 * reviews) are never purged by retention; employee documents are archived, never deleted.
 *
 * The age rule of every dataset is enforced twice: by the job's selection and again by the
 * database triggers of prisma/migrations/20270126090000_phase19_data_hardening, which open only
 * inside a retention transaction (`hrms.retention_purge = 'on'`) and re-read the
 * organization's own setting — so an application bug can never purge a young row.
 */

export type RetentionDataset =
  'candidates' | 'notifications' | 'deliveryLogs' | 'syncLogs' | 'auditLog';

export interface RetentionDatasetDefinition {
  dataset: RetentionDataset;
  key: RetentionSettingKey;
  /** The module that must be enabled for the dataset to be processed (null: core). */
  module: FeatureModule | null;
}

/** Processing order: candidates and notifications before the logs they could also touch. */
export const RETENTION_DATASETS: readonly RetentionDatasetDefinition[] =
  Object.freeze([
    {
      dataset: 'candidates',
      key: 'retention.rejectedCandidateMonths',
      module: 'RECRUITMENT',
    },
    {
      dataset: 'notifications',
      key: 'retention.notificationMonths',
      module: 'NOTIFICATIONS',
    },
    {
      dataset: 'deliveryLogs',
      key: 'retention.deliveryLogMonths',
      module: 'NOTIFICATIONS',
    },
    {
      dataset: 'syncLogs',
      key: 'retention.syncLogMonths',
      module: 'GOOGLE_WORKSPACE',
    },
    { dataset: 'auditLog', key: 'retention.auditLogMonths', module: null },
  ]);

export const RETENTION_SETTING_KEYS = RETENTION_DATASETS.map((d) => d.key);

/** Rows per batch transaction, and batches per dataset and organization in one run. */
export const RETENTION_BATCH_SIZE = 500;
export const RETENTION_MAX_BATCHES = 20;

/**
 * The effective retention period of a stored setting row: 0 (off) without a row, after a
 * reset, under another schema version, or for any value the registry would refuse (including
 * anything below the hard minimum).
 */
export function retentionMonths(
  key: RetentionSettingKey,
  row: { value: unknown; schemaVersion: number } | null | undefined,
): number {
  const definition = settingDefinition(key);
  if (!definition) return 0;
  const { value } = effectiveSettingValue(definition, row);
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
    return 0;
  return value >= RETENTION_MINIMUM_MONTHS[key] ? value : 0;
}

export interface RetentionPlan {
  organizationId: string;
  /** Datasets to process now, with their period in months (in processing order). */
  datasets: Array<{ dataset: RetentionDataset; months: number }>;
  /** Datasets with a period whose module is disabled for the organization. */
  gated: Array<{ dataset: RetentionDataset; module: FeatureModule }>;
}

/**
 * One plan per organization with at least one non-zero retention setting. Organizations
 * without any are not processed at all.
 */
export function retentionPlans(
  rows: ReadonlyArray<{
    organizationId: string;
    key: string;
    value: unknown;
    schemaVersion: number;
  }>,
  moduleEnabled: (organizationId: string, module: FeatureModule) => boolean,
): RetentionPlan[] {
  const organizations = [
    ...new Set(rows.map((row) => row.organizationId)),
  ].sort();
  const plans: RetentionPlan[] = [];
  for (const organizationId of organizations) {
    const plan: RetentionPlan = { organizationId, datasets: [], gated: [] };
    for (const definition of RETENTION_DATASETS) {
      const row = rows.find(
        (r) => r.organizationId === organizationId && r.key === definition.key,
      );
      const months = retentionMonths(definition.key, row);
      if (months === 0) continue;
      if (
        definition.module &&
        !moduleEnabled(organizationId, definition.module)
      )
        plan.gated.push({
          dataset: definition.dataset,
          module: definition.module,
        });
      else plan.datasets.push({ dataset: definition.dataset, months });
    }
    if (plan.datasets.length > 0 || plan.gated.length > 0) plans.push(plan);
  }
  return plans;
}

export interface RetentionCounts {
  candidatesAnonymized: number;
  intakeSubmissionsRedacted: number;
  notificationsDeleted: number;
  deliveriesDeleted: number;
  deliveryAttemptsDeleted: number;
  syncRunsDeleted: number;
  auditEntriesDeleted: number;
}

export function emptyRetentionCounts(): RetentionCounts {
  return {
    candidatesAnonymized: 0,
    intakeSubmissionsRedacted: 0,
    notificationsDeleted: 0,
    deliveriesDeleted: 0,
    deliveryAttemptsDeleted: 0,
    syncRunsDeleted: 0,
    auditEntriesDeleted: 0,
  };
}

export function retentionChanged(counts: RetentionCounts) {
  return Object.values(counts).some((count) => count > 0);
}

/** The redacted values written by candidate anonymization (the triggers require exactly these). */
export const ANONYMIZED_CANDIDATE = Object.freeze({
  firstName: 'Anonymized',
  lastName: 'Candidate',
  documentTitle: 'Redacted',
  documentRemovalReason: 'Removed by data retention.',
  offerWithdrawalReason: 'Redacted',
});
