import type {
  LeaveDayAmountSource,
  LeavePolicy,
} from '../generated/prisma/client.js';
import type { PublishedExpectedWorkFact } from '../scheduling/scheduling-integration.contracts.js';
import { dayOfWeekOf } from '../scheduling/schedule-recurrence.js';
import {
  formatDate,
  localDayBounds,
  localInstant,
  minutesBetween,
  overlapMinutesOf,
} from './leave-common.js';

export interface SizedLeaveDay {
  date: Date;
  minutes: number;
  amountSource: LeaveDayAmountSource;
  /** The requested window: the whole local day, or the partial-day times. */
  windowStart: Date;
  windowEnd: Date;
  /** The absence Time & Attendance sees; a full day also covers its shifts (overnight). */
  absenceStart: Date;
  absenceEnd: Date;
  scheduledShiftRevisionIds: string[];
  holidayName: string | null;
  policyId: string;
  overrideReason: string | null;
}

export interface LeaveSizingInput {
  dates: readonly Date[];
  timezone: string;
  partial: { startLocalTime: string; endLocalTime: string } | null;
  policyFor: (date: Date) => LeavePolicy;
  holidays: ReadonlyMap<string, string>;
  /** Dates covered by an applicable PUBLISHED Schedule. */
  scheduleDates: ReadonlySet<string>;
  /** Published expected work of the assignment around the range. */
  expectedWork: readonly PublishedExpectedWorkFact[];
}

/**
 * Phase 8 — deterministic, server-side leave sizing per local date. The client never supplies
 * minutes. For each date, in the assignment's timezone (so DST days are 23 or 25 hours):
 *  1. SCHEDULE_THEN_STANDARD and an applicable PUBLISHED Schedule covers the date →
 *     the published shifts whose workDate is that date (an overnight shift belongs to the date
 *     it starts), or 0 (NON_WORKDAY) when the employee has none that day. The schedule is
 *     authoritative: an employee rostered on a holiday takes that shift as leave;
 *  2. otherwise a holiday or closure, when the policy excludes holidays → 0 (HOLIDAY_EXCLUDED);
 *  3. otherwise the policy's standard workday minutes on its standard workdays, else 0.
 * A partial day counts only the requested window (capped by the standard day).
 */
export function sizeLeaveDays(input: LeaveSizingInput): SizedLeaveDay[] {
  return input.dates.map((date) => {
    const key = formatDate(date);
    const policy = input.policyFor(date);
    const day = localDayBounds(date, input.timezone);
    const window = input.partial
      ? {
          start: localInstant(
            date,
            input.partial.startLocalTime,
            input.timezone,
          ),
          end: localInstant(date, input.partial.endLocalTime, input.timezone),
        }
      : day;
    const base = {
      date,
      windowStart: window.start,
      windowEnd: window.end,
      absenceStart: window.start,
      absenceEnd: window.end,
      scheduledShiftRevisionIds: [] as string[],
      holidayName: input.holidays.get(key) ?? null,
      policyId: policy.id,
      overrideReason: null,
    };
    // A published schedule decides the day (even a holiday the employee is rostered on);
    // holiday exclusion belongs to the standard-workday rules only.
    if (
      policy.amountSource === 'SCHEDULE_THEN_STANDARD' &&
      input.scheduleDates.has(key)
    ) {
      const shifts = input.expectedWork
        .filter((fact) => fact.workDate === key)
        .map((fact) => ({
          start: new Date(fact.startsAt),
          end: new Date(fact.endsAt),
          revisionId: fact.scheduledShiftRevisionId,
          minutes: fact.scheduledMinutes,
        }));
      if (shifts.length === 0) {
        return { ...base, minutes: 0, amountSource: 'NON_WORKDAY' as const };
      }
      const minutes = input.partial
        ? shifts.reduce(
            (sum, shift) => sum + overlapMinutesOf(shift, window),
            0,
          )
        : shifts.reduce((sum, shift) => sum + shift.minutes, 0);
      const absence = input.partial
        ? window
        : {
            start: new Date(
              Math.min(
                window.start.getTime(),
                ...shifts.map((s) => s.start.getTime()),
              ),
            ),
            end: new Date(
              Math.max(
                window.end.getTime(),
                ...shifts.map((s) => s.end.getTime()),
              ),
            ),
          };
      return {
        ...base,
        minutes,
        amountSource: 'SCHEDULE' as const,
        absenceStart: absence.start,
        absenceEnd: absence.end,
        scheduledShiftRevisionIds: shifts.map((s) => s.revisionId),
      };
    }
    if (policy.excludeHolidays && input.holidays.has(key)) {
      return { ...base, minutes: 0, amountSource: 'HOLIDAY_EXCLUDED' as const };
    }
    if (!policy.standardWorkdays.includes(dayOfWeekOf(date))) {
      return { ...base, minutes: 0, amountSource: 'NON_WORKDAY' as const };
    }
    const minutes = input.partial
      ? Math.min(
          minutesBetween(window.start, window.end),
          policy.standardWorkdayMinutes,
        )
      : policy.standardWorkdayMinutes;
    return { ...base, minutes, amountSource: 'STANDARD_DAY' as const };
  });
}

/** Applies approver overrides (each with a reason) to sized days. */
export function applyDayOverrides(
  days: readonly SizedLeaveDay[],
  overrides: readonly { date: string; minutes: number; reason: string }[],
): SizedLeaveDay[] {
  const byDate = new Map(overrides.map((o) => [o.date, o]));
  return days.map((day) => {
    const override = byDate.get(formatDate(day.date));
    if (!override) return day;
    return {
      ...day,
      minutes: override.minutes,
      amountSource: 'MANUAL_OVERRIDE' as const,
      overrideReason: override.reason.trim(),
    };
  });
}

export function windowsOverlap(
  a: { windowStart: Date; windowEnd: Date },
  b: { windowStart: Date; windowEnd: Date },
) {
  return a.windowStart < b.windowEnd && b.windowStart < a.windowEnd;
}
