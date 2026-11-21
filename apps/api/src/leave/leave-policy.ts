import type { AuthorizationTarget } from '../authorization/authorization.types.js';
import type {
  EmploymentType,
  LeavePolicy,
} from '../generated/prisma/client.js';
import { addDays } from './leave-common.js';

/**
 * Phase 8 — whole-record LeavePolicy resolution. For one assignment, leave type and local date
 * the most specific effective policy wins:
 *   EMPLOYMENT_ASSIGNMENT → TEAM → DEPARTMENT → ORGANIZATIONAL_UNIT (leaf → root) → ORGANIZATION.
 * Within one level, a policy listing the assignment's employment type beats one that applies
 * to all employment types. Settings are never merged across policies: an entitlement is one
 * coherent record. Ambiguous configurations are rejected when written (see policiesConflict).
 */
export interface LeavePolicySubject {
  employmentAssignmentId: string;
  employmentType: EmploymentType;
  target: AuthorizationTarget;
}

export function policyEffectiveOn(
  policy: Pick<LeavePolicy, 'effectiveFrom' | 'effectiveTo'>,
  date: Date,
) {
  return (
    policy.effectiveFrom <= date &&
    (policy.effectiveTo === null || date <= policy.effectiveTo)
  );
}

function levelsOf(subject: LeavePolicySubject) {
  return [
    (p: LeavePolicy) =>
      p.scopeType === 'EMPLOYMENT_ASSIGNMENT' &&
      p.employmentAssignmentId === subject.employmentAssignmentId,
    (p: LeavePolicy) =>
      p.scopeType === 'TEAM' &&
      !!subject.target.teamId &&
      p.teamId === subject.target.teamId,
    (p: LeavePolicy) =>
      p.scopeType === 'DEPARTMENT' &&
      !!subject.target.departmentId &&
      p.departmentId === subject.target.departmentId,
    ...(subject.target.unitPathIds ?? []).map(
      (unitId) => (p: LeavePolicy) =>
        p.scopeType === 'ORGANIZATIONAL_UNIT' &&
        p.organizationalUnitId === unitId,
    ),
    (p: LeavePolicy) =>
      p.scopeType === 'ORGANIZATION' &&
      p.organizationId === subject.target.organizationId,
  ];
}

export function resolveLeavePolicy(
  policies: readonly LeavePolicy[],
  subject: LeavePolicySubject,
  date: Date,
): LeavePolicy | null {
  for (const matchesLevel of levelsOf(subject)) {
    const candidates = policies.filter(
      (policy) =>
        matchesLevel(policy) &&
        policyEffectiveOn(policy, date) &&
        (policy.employmentTypes.length === 0 ||
          policy.employmentTypes.includes(subject.employmentType)),
    );
    if (candidates.length === 0) continue;
    const specific = candidates.filter((p) => p.employmentTypes.length > 0);
    const pool = specific.length > 0 ? specific : candidates;
    // Writes reject overlaps, so the pool has one row; sort only for determinism.
    return [...pool].sort((a, b) => a.id.localeCompare(b.id))[0]!;
  }
  return null;
}

/**
 * Two policies of the same leave type and exact scope target are ambiguous when their periods
 * overlap and their employment-type sets are both "all" or intersect. An "all" policy and a
 * type-specific one may coexist: the specific one wins for its types.
 */
export function employmentTypeSetsConflict(
  a: readonly EmploymentType[],
  b: readonly EmploymentType[],
) {
  if (a.length === 0 && b.length === 0) return true;
  if (a.length === 0 || b.length === 0) return false;
  return a.some((type) => b.includes(type));
}

export function periodsOverlap(
  a: { effectiveFrom: Date; effectiveTo: Date | null },
  b: { effectiveFrom: Date; effectiveTo: Date | null },
) {
  return (
    (a.effectiveTo === null || b.effectiveFrom <= a.effectiveTo) &&
    (b.effectiveTo === null || a.effectiveFrom <= b.effectiveTo)
  );
}

// ─── Leave years ─────────────────────────────────────────────────────────────

/** The first date of the leave year containing a date, for a start month/day (day ≤ 28). */
export function leaveYearStartOf(
  date: Date,
  policy: Pick<LeavePolicy, 'leaveYearStartMonth' | 'leaveYearStartDay'>,
): Date {
  const year = date.getUTCFullYear();
  const candidate = new Date(
    Date.UTC(year, policy.leaveYearStartMonth - 1, policy.leaveYearStartDay),
  );
  return candidate <= date
    ? candidate
    : new Date(
        Date.UTC(
          year - 1,
          policy.leaveYearStartMonth - 1,
          policy.leaveYearStartDay,
        ),
      );
}

export function nextLeaveYearStart(yearStart: Date): Date {
  return new Date(
    Date.UTC(
      yearStart.getUTCFullYear() + 1,
      yearStart.getUTCMonth(),
      yearStart.getUTCDate(),
    ),
  );
}

export function leaveYearEndOf(yearStart: Date): Date {
  return addDays(nextLeaveYearStart(yearStart), -1);
}

// ─── Settings validation ─────────────────────────────────────────────────────

export type LeavePolicySettings = Pick<
  LeavePolicy,
  | 'accrualMethod'
  | 'annualGrantMinutes'
  | 'accrualFrequency'
  | 'accrualMinutesPerPeriod'
  | 'accrualAnchorDate'
  | 'carryoverMode'
  | 'carryoverMaxMinutes'
  | 'carryoverExpiryDays'
  | 'standardWorkdays'
>;

/** Mirrors the LeavePolicy check constraints with readable messages. Returns problems. */
export function leavePolicySettingProblems(
  settings: LeavePolicySettings,
): string[] {
  const problems: string[] = [];
  switch (settings.accrualMethod) {
    case 'NONE':
      if (
        settings.annualGrantMinutes !== null ||
        settings.accrualFrequency !== null ||
        settings.accrualMinutesPerPeriod !== null ||
        settings.accrualAnchorDate !== null
      ) {
        problems.push('accrualMethod NONE takes no grant or accrual settings.');
      }
      break;
    case 'ANNUAL_GRANT':
      if (settings.annualGrantMinutes === null) {
        problems.push(
          'accrualMethod ANNUAL_GRANT requires annualGrantMinutes.',
        );
      }
      if (
        settings.accrualFrequency !== null ||
        settings.accrualMinutesPerPeriod !== null ||
        settings.accrualAnchorDate !== null
      ) {
        problems.push(
          'accrualMethod ANNUAL_GRANT takes no periodic accrual settings.',
        );
      }
      break;
    case 'PERIODIC':
      if (settings.annualGrantMinutes !== null) {
        problems.push('accrualMethod PERIODIC takes no annualGrantMinutes.');
      }
      if (
        settings.accrualFrequency === null ||
        settings.accrualMinutesPerPeriod === null
      ) {
        problems.push(
          'accrualMethod PERIODIC requires accrualFrequency and accrualMinutesPerPeriod.',
        );
      }
      if (
        (settings.accrualFrequency === 'BIWEEKLY') !==
        (settings.accrualAnchorDate !== null)
      ) {
        problems.push(
          'accrualAnchorDate is required for, and only for, BIWEEKLY accrual.',
        );
      }
      break;
  }
  if (
    (settings.carryoverMode === 'CAPPED') !==
    (settings.carryoverMaxMinutes !== null)
  ) {
    problems.push(
      'carryoverMaxMinutes is required for, and only for, CAPPED carryover.',
    );
  }
  if (
    settings.carryoverExpiryDays !== null &&
    settings.carryoverMode === 'NONE'
  ) {
    problems.push('carryoverExpiryDays requires carryover.');
  }
  return problems;
}
