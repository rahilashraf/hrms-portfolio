import { BadRequestException } from '@nestjs/common';
import { isIsoCurrency } from '../common/currency.js';
import {
  domainError,
  formatDate,
  parseDateOnly,
} from '../common/domain-support.js';
import type {
  BenefitCoverageLevel,
  BenefitDependentRelationship,
  BenefitElectionType,
} from '../generated/prisma/client.js';

/**
 * Phase 11 — pure Benefits domain rules (no Nest services, no database). Each rule mirrors, and
 * fails before, the matching constraint of the phase11 benefits migrations.
 *
 * Dates are date-only values (UTC-midnight Dates); ranges are inclusive and a null end is open.
 */

/** Plan and option codes: same shape as pay-group codes. */
const CODE = /^[A-Z0-9_-]{2,64}$/;
/** Money amounts: non-negative, at most two decimals, Decimal(19,2) headroom. */
const AMOUNT = /^\d{1,17}(\.\d{1,2})?$/;

export interface DateRange {
  from: Date;
  /** Inclusive; null when open-ended. */
  to: Date | null;
}

function invalid(code: string, message: string): never {
  throw new BadRequestException(domainError(400, code, message));
}

export function parseBenefitCode(value: unknown, field = 'code'): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!CODE.test(code)) {
    invalid(
      'BENEFIT_CODE_INVALID',
      `${field} must be 2–64 characters: letters, digits, "_" or "-" (e.g. "HEALTH-BASIC").`,
    );
  }
  return code;
}

export function parseBenefitCurrency(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!isIsoCurrency(code)) {
    invalid(
      'BENEFIT_CURRENCY_INVALID',
      'currency must be an ISO-4217 code such as "CAD".',
    );
  }
  return code;
}

/** A non-negative money amount with at most two decimals, as a fixed 2-decimal string. */
export function parseBenefitAmount(value: unknown, field: string): string {
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  if (!AMOUNT.test(text)) {
    invalid(
      'BENEFIT_AMOUNT_INVALID',
      `${field} must be a non-negative amount with at most two decimals.`,
    );
  }
  const [whole, fraction = ''] = text.split('.');
  return `${BigInt(whole!).toString()}.${fraction.padEnd(2, '0')}`;
}

/** An inclusive date range; `to` may be open (null) and is never before `from`. */
export function parseBenefitRange(
  from: string,
  to: string | null | undefined,
  labels: { from: string; to: string } = {
    from: 'effectiveFrom',
    to: 'effectiveTo',
  },
): DateRange {
  const start = parseDateOnly(from, labels.from);
  const end = to ? parseDateOnly(to, labels.to) : null;
  if (end && end < start) {
    invalid(
      'BENEFIT_DATE_RANGE_INVALID',
      `${labels.to} must not be before ${labels.from}.`,
    );
  }
  return { from: start, to: end };
}

const END = Number.POSITIVE_INFINITY;
const time = (date: Date | null) => (date ? date.getTime() : END);

export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.from.getTime() <= time(b.to) && b.from.getTime() <= time(a.to);
}

export function rangeContains(outer: DateRange, inner: DateRange): boolean {
  return (
    inner.from.getTime() >= outer.from.getTime() &&
    time(inner.to) <= time(outer.to)
  );
}

/** The part of `range` inside `within`, or null when they do not meet. */
export function clipRange(
  range: DateRange,
  within: DateRange,
): DateRange | null {
  if (!rangesOverlap(range, within)) return null;
  const from = range.from > within.from ? range.from : within.from;
  const to = time(range.to) <= time(within.to) ? range.to : within.to;
  return { from, to };
}

export function dateInRange(date: Date, range: DateRange): boolean {
  return (
    date.getTime() >= range.from.getTime() && date.getTime() <= time(range.to)
  );
}

/** Whole years between a birth date and a date (birthdays on Feb 29 count from Mar 1). */
export function ageOn(dateOfBirth: Date, date: Date): number {
  let age = date.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const month = date.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (
    month < 0 ||
    (month === 0 && date.getUTCDate() < dateOfBirth.getUTCDate())
  ) {
    age -= 1;
  }
  return age;
}

export interface DependentFacts {
  relationship: BenefitDependentRelationship;
  dateOfBirth: Date | null;
  relationshipStartDate: Date | null;
  relationshipEndDate: Date | null;
}

/**
 * Whether a dependent can be covered on a date: the relationship is in effect, and a child is
 * born and not older than the plan's age limit (inclusive).
 */
export function dependentEligibleOn(
  dependent: DependentFacts,
  date: Date,
  childMaxAge: number | null,
): boolean {
  if (dependent.relationshipStartDate && date < dependent.relationshipStartDate)
    return false;
  if (dependent.relationshipEndDate && date > dependent.relationshipEndDate)
    return false;
  if (dependent.relationship === 'CHILD') {
    if (!dependent.dateOfBirth || date < dependent.dateOfBirth) return false;
    if (
      childMaxAge !== null &&
      ageOn(dependent.dateOfBirth, date) > childMaxAge
    )
      return false;
  }
  return true;
}

/** Covered dependents must match the option's coverage level. */
export function assertCoverageMatchesDependents(
  level: BenefitCoverageLevel,
  relationships: readonly BenefitDependentRelationship[],
) {
  const spouses = relationships.filter((r) => r === 'SPOUSE').length;
  const children = relationships.filter((r) => r === 'CHILD').length;
  const ok =
    level === 'EMPLOYEE_ONLY'
      ? relationships.length === 0
      : level === 'EMPLOYEE_SPOUSE'
        ? spouses === 1 && relationships.length === 1
        : level === 'EMPLOYEE_CHILDREN'
          ? children >= 1 && spouses === 0
          : level === 'FAMILY'
            ? relationships.length >= 1 && spouses <= 1
            : true;
  if (!ok) {
    invalid(
      'BENEFIT_DEPENDENTS_MISMATCH',
      {
        EMPLOYEE_ONLY: 'Employee-only coverage covers no dependents.',
        EMPLOYEE_SPOUSE:
          'Employee + spouse coverage covers exactly one spouse or partner.',
        EMPLOYEE_CHILDREN:
          'Employee + children coverage covers at least one child and no spouse.',
        FAMILY:
          'Family coverage covers at least one dependent and at most one spouse.',
        CUSTOM: '',
      }[level],
    );
  }
}

export type BenefitEnrollmentStatus =
  'PENDING' | 'ACTIVE' | 'ENDED' | 'WAIVED' | 'SUPERSEDED';

/**
 * An election segment's status on a date (the organization's local today): derived from its
 * dates, never stored, so no background job is needed to keep it right.
 */
export function enrollmentStatusOn(
  record: {
    electionType: BenefitElectionType;
    coverageStart: Date;
    coverageEnd: Date | null;
    supersededAt: Date | null;
  },
  today: Date,
): BenefitEnrollmentStatus {
  if (record.supersededAt) return 'SUPERSEDED';
  if (record.electionType === 'WAIVED') return 'WAIVED';
  if (today < record.coverageStart) return 'PENDING';
  if (record.coverageEnd && today > record.coverageEnd) return 'ENDED';
  return 'ACTIVE';
}

/** YYYY-MM-DD of a date-only value, or null. */
export function isoDate(value: Date | null | undefined): string | null {
  return value ? formatDate(value) : null;
}

// ─── Eligibility ─────────────────────────────────────────────────────────────

export interface EligibilityAssignmentFacts {
  status: 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
  startDate: Date;
  endDate: Date | null;
  employmentType: string;
  organizationId: string;
  /** The position's unit and its ancestors, nearest first. */
  unitPathIds: readonly string[];
  departmentId: string | null;
  positionId: string;
  /** The employee's hire date (service is counted from it). */
  hireDate: Date;
}

export interface EligibilityRuleFacts {
  id: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  organizationalUnitId: string | null;
  includeSubunits: boolean;
  departmentId: string | null;
  positionId: string | null;
  employmentTypes: readonly string[];
  minimumServiceDays: number | null;
}

export type EligibilityCriterion =
  'UNIT' | 'DEPARTMENT' | 'POSITION' | 'EMPLOYMENT_TYPE' | 'SERVICE';

export interface EligibilityResult {
  eligible: boolean;
  /** Why not (empty when eligible). */
  reasons: Array<
    | 'OTHER_ORGANIZATION'
    | 'ASSIGNMENT_NOT_ACTIVE'
    | 'PLAN_NOT_IN_EFFECT'
    | 'NO_RULE_IN_EFFECT'
    | 'NO_MATCHING_RULE'
  >;
  matchedRuleIds: string[];
  rules: Array<{
    ruleId: string;
    matched: boolean;
    failed: EligibilityCriterion[];
  }>;
}

/** Days of service on a date, counting the hire date as day 1. */
export function serviceDaysOn(hireDate: Date, date: Date): number {
  return Math.floor((date.getTime() - hireDate.getTime()) / 86_400_000) + 1;
}

/**
 * Whether an assignment is offered a plan on a date. The assignment must be live (not cancelled)
 * on the date and in the plan's organization, and the plan in effect. Then: a plan that never
 * had rules is offered to everyone; otherwise one rule in effect on the date must match all of
 * its criteria (AND within a rule, OR across rules). Pure: the caller supplies the facts.
 */
export function evaluateEligibility(input: {
  assignment: EligibilityAssignmentFacts;
  plan: {
    organizationId: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  };
  rules: readonly EligibilityRuleFacts[];
  date: Date;
}): EligibilityResult {
  const { assignment, plan, date } = input;
  const reasons: EligibilityResult['reasons'] = [];
  if (assignment.organizationId !== plan.organizationId)
    reasons.push('OTHER_ORGANIZATION');
  if (
    assignment.status === 'CANCELLED' ||
    !dateInRange(date, { from: assignment.startDate, to: assignment.endDate })
  ) {
    reasons.push('ASSIGNMENT_NOT_ACTIVE');
  }
  if (!dateInRange(date, { from: plan.effectiveFrom, to: plan.effectiveTo })) {
    reasons.push('PLAN_NOT_IN_EFFECT');
  }
  const inEffect = input.rules.filter((rule) =>
    dateInRange(date, { from: rule.effectiveFrom, to: rule.effectiveTo }),
  );
  const results = inEffect.map((rule) => {
    const failed: EligibilityCriterion[] = [];
    if (rule.organizationalUnitId) {
      const matches = rule.includeSubunits
        ? assignment.unitPathIds.includes(rule.organizationalUnitId)
        : assignment.unitPathIds[0] === rule.organizationalUnitId;
      if (!matches) failed.push('UNIT');
    }
    if (rule.departmentId && rule.departmentId !== assignment.departmentId) {
      failed.push('DEPARTMENT');
    }
    if (rule.positionId && rule.positionId !== assignment.positionId)
      failed.push('POSITION');
    if (
      rule.employmentTypes.length > 0 &&
      !rule.employmentTypes.includes(assignment.employmentType)
    ) {
      failed.push('EMPLOYMENT_TYPE');
    }
    if (
      rule.minimumServiceDays !== null &&
      serviceDaysOn(assignment.hireDate, date) < rule.minimumServiceDays
    ) {
      failed.push('SERVICE');
    }
    return { ruleId: rule.id, matched: failed.length === 0, failed };
  });
  const matchedRuleIds = results.filter((r) => r.matched).map((r) => r.ruleId);
  if (input.rules.length > 0) {
    if (inEffect.length === 0) reasons.push('NO_RULE_IN_EFFECT');
    else if (matchedRuleIds.length === 0) reasons.push('NO_MATCHING_RULE');
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    matchedRuleIds,
    rules: results,
  };
}
