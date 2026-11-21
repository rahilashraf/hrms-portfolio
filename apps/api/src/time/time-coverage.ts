import { BadRequestException } from '@nestjs/common';

/**
 * Multi-assignment attendance coverage — pure rules.
 *
 * One TimeEntry is one physical work interval: its clock-in/out and breaks are the only source of
 * elapsed minutes. `TimeEntry.employmentAssignmentId` is the interval's payroll owner: timesheet
 * segments, payroll worked-time outputs and reporting attribute the interval's minutes to it
 * alone, so an interval is paid exactly once however many assignments it covers. Coverage rows
 * (TimeEntryAssignmentCoverage) name every assignment the interval covers — the owner included —
 * and never add time. Switching assignments still closes one interval and opens another.
 */

/** At most this many assignments (owner included) share one physical interval. */
export const MAX_COVERED_ASSIGNMENTS = 10;

/**
 * The additional (non-owner) assignments of a capture or correction request: duplicates and the
 * owner itself are dropped, order is kept. Throws when the request would exceed the limit.
 */
export function additionalCoverage(
  ownerAssignmentId: string,
  requested: readonly string[] | undefined,
): string[] {
  const additional: string[] = [];
  for (const id of requested ?? []) {
    if (id === ownerAssignmentId || additional.includes(id)) continue;
    additional.push(id);
  }
  if (additional.length + 1 > MAX_COVERED_ASSIGNMENTS) {
    throw new BadRequestException(
      `One time entry covers at most ${MAX_COVERED_ASSIGNMENTS} assignments.`,
    );
  }
  return additional;
}

export interface CoverageRow<A> {
  employmentAssignmentId: string;
  removedAt: Date | null;
  employmentAssignment: A;
}

export interface CoveredAssignment<A> {
  employmentAssignmentId: string;
  assignment: A;
  isPayrollOwner: boolean;
}

/**
 * The assignments an entry covers now: its payroll owner first (always, even for an entry
 * recorded before coverage existed), then its active secondary coverage in recorded order.
 */
export function coveredAssignments<A>(entry: {
  employmentAssignmentId: string;
  employmentAssignment: A;
  assignmentCoverages?: ReadonlyArray<CoverageRow<A>> | null;
}): CoveredAssignment<A>[] {
  const result: CoveredAssignment<A>[] = [
    {
      employmentAssignmentId: entry.employmentAssignmentId,
      assignment: entry.employmentAssignment,
      isPayrollOwner: true,
    },
  ];
  for (const row of entry.assignmentCoverages ?? []) {
    if (row.removedAt) continue;
    if (
      result.some(
        (covered) =>
          covered.employmentAssignmentId === row.employmentAssignmentId,
      )
    ) {
      continue;
    }
    result.push({
      employmentAssignmentId: row.employmentAssignmentId,
      assignment: row.employmentAssignment,
      isPayrollOwner: false,
    });
  }
  return result;
}

/** The secondary (non-owner) assignment ids an entry covers now. */
export function secondaryCoverageIds(entry: {
  employmentAssignmentId: string;
  assignmentCoverages?: ReadonlyArray<{
    employmentAssignmentId: string;
    removedAt: Date | null;
  }> | null;
}): string[] {
  const ids: string[] = [];
  for (const row of entry.assignmentCoverages ?? []) {
    if (
      row.removedAt ||
      row.employmentAssignmentId === entry.employmentAssignmentId
    )
      continue;
    if (!ids.includes(row.employmentAssignmentId))
      ids.push(row.employmentAssignmentId);
  }
  return ids;
}

/** Same members, any order. */
export function sameAssignmentSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((id) => set.has(id));
}
