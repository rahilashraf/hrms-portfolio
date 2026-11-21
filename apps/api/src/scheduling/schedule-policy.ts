import type {
  SchedulePeriodType,
  SchedulePolicyConflictSeverity,
  ScheduleScopeType,
  UnscheduledWorkMode,
} from '../generated/prisma/enums.js';

/** Every setting a SchedulePolicy row may carry. A null column means "inherit". */
export const SCHEDULE_POLICY_FIELDS = [
  'generationHorizonDays',
  'defaultSchedulePeriod',
  'autoCreateSchedules',
  'unscheduledWorkMode',
  'clockInEarlyMinutes',
  'clockInLateMinutes',
  'overlapConflictSeverity',
  'minimumRestMinutes',
  'maximumShiftDurationMinutes',
  'requireWorkLocation',
  'allowManagerConflictOverride',
] as const;

export type SchedulePolicyField = (typeof SCHEDULE_POLICY_FIELDS)[number];

export interface SchedulePolicySettings {
  /** Rolling horizon (days) background generation keeps materialized. */
  generationHorizonDays: number;
  /** Schedule container segmentation for generation. Only WEEKLY exists today. */
  defaultSchedulePeriod: SchedulePeriodType;
  /** Whether generation may create missing DRAFT containers; otherwise it reuses drafts only. */
  autoCreateSchedules: boolean;
  /** Clock-in behaviour with no matching published shift (Batch 9). */
  unscheduledWorkMode: UnscheduledWorkMode;
  /** Clock-in eligibility window around a shift start (Batch 9); not attendance lateness. */
  clockInEarlyMinutes: number;
  clockInLateMinutes: number;
  /** Severity of cross-assignment overlap. Same-assignment overlap is always an ERROR. */
  overlapConflictSeverity: SchedulePolicyConflictSeverity;
  /** Minimum gap between an Employee's shifts; null or 0 disables the check. */
  minimumRestMinutes: number | null;
  /** Longest shift before a warning; null disables the check. */
  maximumShiftDurationMinutes: number | null;
  /** New or changed shifts (and generated occurrences) must have a WorkLocation. */
  requireWorkLocation: boolean;
  /** Whether overrideable conflict WARNINGs may be overridden; if not, they block. */
  allowManagerConflictOverride: boolean;
}

/**
 * Built-in defaults when no effective policy sets a field. They reproduce the behaviour of
 * Batches 1–6 exactly (90-day horizon, weekly auto-created containers, overlap WARNING with
 * overrides allowed, no rest/duration checks, optional WorkLocation) and Phase 6's unrestricted
 * clock-in (unscheduled work allowed).
 */
export const DEFAULT_SCHEDULE_POLICY: Readonly<SchedulePolicySettings> = {
  generationHorizonDays: 90,
  defaultSchedulePeriod: 'WEEKLY',
  autoCreateSchedules: true,
  unscheduledWorkMode: 'ALLOW_UNSCHEDULED',
  clockInEarlyMinutes: 60,
  clockInLateMinutes: 120,
  overlapConflictSeverity: 'WARNING',
  minimumRestMinutes: null,
  maximumShiftDurationMinutes: null,
  requireWorkLocation: false,
  allowManagerConflictOverride: true,
};

export type PolicySettingSource =
  { policyId: string; scopeType: ScheduleScopeType } | 'DEFAULT';

export interface ResolvedSchedulePolicy extends SchedulePolicySettings {
  /** Which policy (or the built-in default) supplied each setting. */
  sources: Record<SchedulePolicyField, PolicySettingSource>;
}

export type SchedulePolicyRow = {
  id: string;
  scopeType: ScheduleScopeType;
  effectiveFrom: Date;
  effectiveTo: Date | null;
} & { [K in SchedulePolicyField]: SchedulePolicySettings[K] | null };

/**
 * Resolves the settings in effect on a local DATE. layers are ordered most specific first
 * (TEAM, DEPARTMENT, organizational units leaf to root, ORGANIZATION); each holds that exact
 * scope's policy rows, of which at most one is effective on any date. For every field the first
 * effective layer that sets it wins, else the built-in default.
 */
export function resolveSchedulePolicy(
  layers: readonly (readonly SchedulePolicyRow[])[],
  date: Date,
): ResolvedSchedulePolicy {
  const effective = layers
    .map((rows) =>
      rows.find(
        (row) =>
          row.effectiveFrom <= date &&
          (row.effectiveTo === null || row.effectiveTo >= date),
      ),
    )
    .filter((row): row is SchedulePolicyRow => !!row);
  const resolved = {
    ...DEFAULT_SCHEDULE_POLICY,
    sources: {} as ResolvedSchedulePolicy['sources'],
  } as ResolvedSchedulePolicy;
  for (const field of SCHEDULE_POLICY_FIELDS) {
    const source = effective.find((row) => row[field] !== null);
    (resolved as unknown as Record<string, unknown>)[field] = source
      ? source[field]
      : DEFAULT_SCHEDULE_POLICY[field];
    resolved.sources[field] = source
      ? { policyId: source.id, scopeType: source.scopeType }
      : 'DEFAULT';
  }
  return resolved;
}

/** The conflict-relevant part of a resolved policy (Batch 3 rules plus Batch 7 settings). */
export interface ConflictPolicy {
  overlapConflictSeverity: SchedulePolicyConflictSeverity;
  minimumRestMinutes: number | null;
  maximumShiftDurationMinutes: number | null;
  allowManagerConflictOverride: boolean;
}

export const DEFAULT_CONFLICT_POLICY: Readonly<ConflictPolicy> = {
  overlapConflictSeverity: DEFAULT_SCHEDULE_POLICY.overlapConflictSeverity,
  minimumRestMinutes: DEFAULT_SCHEDULE_POLICY.minimumRestMinutes,
  maximumShiftDurationMinutes:
    DEFAULT_SCHEDULE_POLICY.maximumShiftDurationMinutes,
  allowManagerConflictOverride:
    DEFAULT_SCHEDULE_POLICY.allowManagerConflictOverride,
};

export function conflictPolicyOf(
  policy: SchedulePolicySettings,
): ConflictPolicy {
  return {
    overlapConflictSeverity: policy.overlapConflictSeverity,
    minimumRestMinutes: policy.minimumRestMinutes,
    maximumShiftDurationMinutes: policy.maximumShiftDurationMinutes,
    allowManagerConflictOverride: policy.allowManagerConflictOverride,
  };
}

/** Minutes either side of a shift that conflict evaluation must look at. */
export function conflictSearchMarginMinutes(policy: ConflictPolicy): number {
  return Math.max(policy.minimumRestMinutes ?? 0, 0);
}
