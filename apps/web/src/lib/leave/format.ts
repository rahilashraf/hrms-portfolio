import { formatMinutes } from '../time/format';
import type { LeaveDisplayUnit } from './types';

export { formatDateOnly, formatInstant, formatMinutes, label } from '../time/format';

/**
 * Leave amounts are minutes everywhere; DAYS display divides by the policy's standard
 * workday (8h when unknown) and never rounds away a partial day.
 */
export function formatLeaveAmount(
  minutes: number | null | undefined,
  unit: LeaveDisplayUnit = 'HOURS',
  standardWorkdayMinutes = 480,
): string {
  if (minutes === null || minutes === undefined) return '—';
  if (unit === 'DAYS' && standardWorkdayMinutes > 0) {
    const days = Math.round((minutes / standardWorkdayMinutes) * 100) / 100;
    return `${days} ${Math.abs(days) === 1 ? 'day' : 'days'}`;
  }
  return formatMinutes(minutes);
}

/** Hours (decimal, as typed in a form) to whole minutes; null when not a number. */
/** LeaveDayOverrideDto: a day's approved amount is 0 to 1440 whole minutes (one calendar day). */
export const LEAVE_DAY_OVERRIDE_MAX_MINUTES = 1440;

/**
 * Minutes for an approver's per-day override, or an error message for the field. An empty field
 * means "no override" (null minutes).
 */
export function dayOverrideMinutes(
  value: string,
): { minutes: number | null; error: null } | { minutes: null; error: string } {
  if (value.trim() === '') return { minutes: null, error: null };
  const minutes = hoursToMinutes(value);
  if (minutes === null || minutes < 0 || minutes > LEAVE_DAY_OVERRIDE_MAX_MINUTES) {
    return { minutes: null, error: 'Enter between 0 and 24 hours.' };
  }
  return { minutes, error: null };
}

export function hoursToMinutes(value: string): number | null {
  if (value.trim() === '') return null;
  const hours = Number(value);
  if (!Number.isFinite(hours)) return null;
  return Math.round(hours * 60);
}

export function formatLeaveRange(
  startDate: string,
  endDate: string,
  startLocalTime?: string | null,
  endLocalTime?: string | null,
) {
  const [y1, m1, d1] = startDate.split('-');
  const [y2, m2, d2] = endDate.split('-');
  const first = `${m1}/${d1}/${y1}`;
  const range = startDate === endDate ? first : `${first} – ${m2}/${d2}/${y2}`;
  return startLocalTime && endLocalTime ? `${range}, ${startLocalTime}–${endLocalTime}` : range;
}

/** Today as YYYY-MM-DD in the browser's zone (for default form values only). */
export function todayIso(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
