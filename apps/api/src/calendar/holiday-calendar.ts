import type { AuthorizationTarget } from '../authorization/authorization.types.js';

export interface HolidayRow {
  id: string;
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  date: Date;
  name: string;
  kind: string;
}

/**
 * Whether a holiday applies to a position placement: an organization-wide holiday applies to
 * every position of the organization; a unit holiday to positions in that unit or below it; a
 * department or team holiday to positions placed in it.
 */
export function holidayAppliesTo(
  holiday: Pick<
    HolidayRow,
    'organizationId' | 'organizationalUnitId' | 'departmentId' | 'teamId'
  >,
  target: AuthorizationTarget,
): boolean {
  if (holiday.organizationId !== target.organizationId) return false;
  if (holiday.organizationalUnitId) {
    return (target.unitPathIds ?? []).includes(holiday.organizationalUnitId);
  }
  if (holiday.departmentId) return holiday.departmentId === target.departmentId;
  if (holiday.teamId) return holiday.teamId === target.teamId;
  return true;
}
