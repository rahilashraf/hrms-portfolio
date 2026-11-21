'use client';

import { AuthApiError } from '../../../lib/auth/types';
import { benefitsErrorCode, benefitsErrorMessage } from '../../../lib/benefits/errors';
import type { CoverageLevel, Dependent, Election, Relationship } from '../../../lib/benefits/types';
import { formatDateOnly } from '../../../lib/payroll/format';

/** Batch 7C — small building blocks of the employee benefits screens. */

export const fieldLabel = 'block text-sm font-medium text-slate-800';
export const hintText = 'mt-1 text-xs text-slate-600';

// Batch 10E-2: the shared label/hint wiring (was a local copy here and in two other modules).
export { ControlField as Field } from '../../ui/form/form-field';

export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  SPOUSE: 'Spouse or partner',
  CHILD: 'Child',
  OTHER: 'Other',
};

export const fullName = (person: { firstName: string; lastName: string }) =>
  `${person.firstName} ${person.lastName}`;

/** The next calendar day of an ISO date (`YYYY-MM-DD`). */
export function nextDay(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

/**
 * Why a dependent cannot be (newly) covered on a date, or null: archived, relationship not
 * started or already ended. The API checks the age limit and decides; this only explains.
 */
export function dependentBlocker(dependent: Dependent | undefined, date: string): string | null {
  if (!dependent) return 'no longer recorded';
  if (dependent.archived) return 'archived';
  if (date && dependent.relationshipStartDate && date < dependent.relationshipStartDate)
    return `relationship starts ${formatDateOnly(dependent.relationshipStartDate)}`;
  if (date && dependent.relationshipEndDate && date > dependent.relationshipEndDate)
    return `relationship ended ${formatDateOnly(dependent.relationshipEndDate)}`;
  return null;
}

/** The coverage level that fits the remaining dependents (for suggesting an option). */
export function levelFor(relationships: readonly Relationship[]): CoverageLevel {
  const spouses = relationships.filter((r) => r === 'SPOUSE').length;
  const children = relationships.filter((r) => r === 'CHILD').length;
  if (relationships.length === 0) return 'EMPLOYEE_ONLY';
  if (spouses > 0 && children > 0) return 'FAMILY';
  if (spouses > 0 && relationships.length === spouses) return 'EMPLOYEE_SPOUSE';
  if (children > 0 && relationships.length === children) return 'EMPLOYEE_CHILDREN';
  return 'FAMILY';
}

/**
 * A save error, explained: the later elections the API names for BENEFIT_LATER_COVERAGE
 * (never ended silently), otherwise the code-aware benefits message.
 */
export function saveErrorMessage(cause: unknown, elections: readonly Election[] = []): string {
  const message = benefitsErrorMessage(cause, 'Unable to save the benefits change.');
  if (benefitsErrorCode(cause) !== 'BENEFIT_LATER_COVERAGE' || !(cause instanceof AuthApiError))
    return message;
  const later = Array.isArray(cause.details?.elections)
    ? (cause.details.elections as Array<{
        id: string;
        coverageStart: string;
        coverageEnd: string | null;
      }>)
    : [];
  const count =
    typeof cause.details?.laterElections === 'number' ? cause.details.laterElections : later.length;
  const named = later.map((row) => {
    const plan = elections.find((item) => item.id === row.id);
    return `${plan ? `${plan.plan.name} ${plan.option?.name ?? ''}`.trim() : 'Election'} from ${formatDateOnly(row.coverageStart)}${row.coverageEnd ? ` to ${formatDateOnly(row.coverageEnd)}` : ''}`;
  });
  const unnamed = count - named.length;
  return [
    message,
    named.length > 0 ? `Later coverage: ${named.join('; ')}.` : '',
    unnamed > 0
      ? `${unnamed} later election${unnamed === 1 ? '' : 's'} outside your access also continue${unnamed === 1 ? 's' : ''} it.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Whether a save failed because eligibility needs an override reason. */
export const needsOverride = (cause: unknown) =>
  benefitsErrorCode(cause) === 'BENEFIT_NOT_ELIGIBLE';
