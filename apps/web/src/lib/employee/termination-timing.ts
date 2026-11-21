import type { EmployeeTerminationPreview } from './types';

/**
 * Batch 5C (D2) — when each assignment of a termination takes effect.
 *
 * The API applies a termination per assignment: an assignment ends (or, not yet started, is
 * cancelled) once the last day has passed in its own time zone — the local date there is later
 * than the last day (the last day is inclusive). On the day it is recorded, assignments whose day
 * has already passed are applied at once; the others wait.
 *
 * This mirrors that rule for the confirmation the dialog asks for, on this device's clock and each
 * assignment's time zone from the preview. It never claims "nothing ends today" without being
 * sure: an assignment whose time zone cannot be read here, or a preview the API itself reports as
 * not scheduled while every assignment here looks still to come, counts as ending now
 * (conservative). The API stays authoritative and decides on submit.
 */

export type TerminationTimingKind = 'SCHEDULED' | 'PARTIAL' | 'IMMEDIATE';

export interface TimedAssignment {
  employmentAssignmentId: string;
  positionName: string;
  organizationName: string;
  timezone: string;
  /** The local date in the assignment's time zone now, or null when it cannot be computed. */
  localDate: string | null;
  /** END or CANCEL (an assignment that has not started is cancelled). */
  action: string;
}

export interface TerminationTiming {
  kind: TerminationTimingKind;
  /** Assignments that end (or are cancelled) as soon as the termination is recorded. */
  immediate: TimedAssignment[];
  /** Assignments that keep running through the last day. */
  later: TimedAssignment[];
  /** Any immediate effect needs an explicit confirmation. */
  requiresConfirmation: boolean;
  /** Something could not be determined here; the confirmation is asked to be safe. */
  uncertain: boolean;
}

/** The local YYYY-MM-DD date in an IANA time zone, or null when the zone is unusable. */
export function localDateIn(timezone: string, now: Date = new Date()): string | null {
  if (!timezone) return null;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    );
    const value = `${parts.year}-${parts.month}-${parts.day}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function terminationTiming(
  preview: Pick<EmployeeTerminationPreview, 'terminationDate' | 'scheduled' | 'assignments'>,
  now: Date = new Date(),
): TerminationTiming {
  const lastDay = preview.terminationDate;
  const immediate: TimedAssignment[] = [];
  const later: TimedAssignment[] = [];
  let uncertain = false;
  for (const assignment of preview.assignments) {
    const localDate = localDateIn(assignment.timezone, now);
    const timed: TimedAssignment = {
      employmentAssignmentId: assignment.employmentAssignmentId,
      positionName: assignment.positionName,
      organizationName: assignment.organizationName,
      timezone: assignment.timezone,
      localDate,
      action: assignment.action,
    };
    if (localDate === null) {
      uncertain = true;
      immediate.push(timed);
    } else if (localDate > lastDay) {
      immediate.push(timed);
    } else {
      later.push(timed);
    }
  }
  // The API reports "not scheduled" when the day has passed everywhere. If this device sees it
  // still to come somewhere, the clocks disagree: treat it as ending now.
  if (!preview.scheduled && later.length > 0) {
    uncertain = true;
    immediate.push(...later.splice(0));
  }
  const kind: TerminationTimingKind =
    preview.assignments.length === 0
      ? preview.scheduled
        ? 'SCHEDULED'
        : 'IMMEDIATE'
      : immediate.length === 0
        ? 'SCHEDULED'
        : later.length === 0
          ? 'IMMEDIATE'
          : 'PARTIAL';
  return { kind, immediate, later, requiresConfirmation: kind !== 'SCHEDULED', uncertain };
}

/**
 * Batch 5C (D1) — a reschedule to a later last day. The preview is computed from the assignments
 * as they are now, already shortened to the current last day by the scheduled termination; the
 * API restores each assignment's original end date before applying the new one, which the
 * preview cannot show. Earlier or equal dates preview accurately.
 */
export function isLaterReschedule(currentLastDay: string | null | undefined, proposed: string) {
  return Boolean(currentLastDay) && proposed > (currentLastDay as string);
}
