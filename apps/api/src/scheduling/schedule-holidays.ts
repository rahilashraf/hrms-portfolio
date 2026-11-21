import type { AuthorizationTarget } from '../authorization/authorization.types.js';
import { holidayAppliesTo } from '../calendar/holiday-calendar.js';
import type { HolidayKind } from '../generated/prisma/enums.js';
import { formatDateOnly } from './schedule-recurrence.js';

/**
 * Batch R4-A.6 — read-only holiday markers for schedule views, from the organization holiday
 * calendar (Phase 8). A marker is information only: shift generation, conflicts and publishing
 * do not change (holiday-aware generation is V2), and a CLOSURE is shown as such without closing
 * anything.
 */
export interface ScheduleHolidayMarker {
  /** Date only (YYYY-MM-DD): the organization's local calendar day. */
  date: string;
  name: string;
  kind: HolidayKind;
  organizationId: string;
}

export interface HolidayCandidate {
  id: string;
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  date: Date;
  name: string;
  kind: HolidayKind;
}

/** The holiday's own place in the structure (null fields = organization-wide). */
function holidayWithin(
  holiday: HolidayCandidate,
  holidayTarget: AuthorizationTarget | null,
  view: AuthorizationTarget,
): boolean {
  if (holiday.organizationId !== view.organizationId) return false;
  if (view.type === 'ORGANIZATION') return true;
  if (!holidayTarget) return false;
  if (view.type === 'ORGANIZATIONAL_UNIT') {
    // The path runs from the unit itself up to the root.
    const unit = view.unitPathIds?.[0];
    return !!unit && (holidayTarget.unitPathIds ?? []).includes(unit);
  }
  if (view.type === 'DEPARTMENT')
    return (
      !!view.departmentId && holidayTarget.departmentId === view.departmentId
    );
  if (view.type === 'TEAM')
    return !!view.teamId && holidayTarget.teamId === view.teamId;
  return false;
}

export function markerOf(holiday: HolidayCandidate): ScheduleHolidayMarker {
  return {
    date: formatDateOnly(holiday.date),
    name: holiday.name,
    kind: holiday.kind,
    organizationId: holiday.organizationId,
  };
}

/**
 * Manager grid: a holiday is shown when it applies to a schedule the reader may see (an
 * organization-wide or enclosing holiday) or lies inside one (a team holiday within a
 * department schedule). Nothing outside the reader's visible schedules is revealed.
 */
export function holidaysForViews(
  holidays: HolidayCandidate[],
  holidayTargets: Map<string, AuthorizationTarget | null>,
  views: AuthorizationTarget[],
): ScheduleHolidayMarker[] {
  return holidays
    .filter((holiday) =>
      views.some(
        (view) =>
          holidayAppliesTo(holiday, view) ||
          holidayWithin(holiday, holidayTargets.get(holiday.id) ?? null, view),
      ),
    )
    .map(markerOf);
}

/**
 * My Schedule: a holiday is shown when it applies to one of the employee's own assignments on
 * that date (the assignment covers the date and the holiday's scope includes its position).
 */
export function holidaysForAssignments(
  holidays: HolidayCandidate[],
  assignments: Array<{
    startDate: Date;
    endDate: Date | null;
    target: AuthorizationTarget;
  }>,
): ScheduleHolidayMarker[] {
  return holidays
    .filter((holiday) =>
      assignments.some(
        (assignment) =>
          assignment.startDate.getTime() <= holiday.date.getTime() &&
          (assignment.endDate === null ||
            assignment.endDate.getTime() >= holiday.date.getTime()) &&
          holidayAppliesTo(holiday, assignment.target),
      ),
    )
    .map(markerOf);
}
