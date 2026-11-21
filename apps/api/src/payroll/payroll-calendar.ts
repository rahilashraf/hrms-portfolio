import { BadRequestException } from '@nestjs/common';
import {
  addDays,
  domainError,
  formatDate,
  localDayStart,
} from '../common/domain-support.js';
import type { PayrollCalendarCadence } from '../generated/prisma/client.js';

/**
 * Phase 10 Batch 2 — the deterministic pay-period series of a payroll calendar. Pure date-only
 * arithmetic on local calendar dates (UTC-midnight Date values, never shifted by the runtime
 * timezone); the calendar's IANA timezone is used only to turn the processing cutoff date into
 * an instant. Periods tile time without gaps or overlaps:
 *
 * - WEEKLY / BIWEEKLY: 7 / 14 days, every period starting a whole number of periods after the
 *   anchor date.
 * - SEMIMONTHLY: the 1st–15th and the 16th–last day of every month.
 * - MONTHLY: from the anchor's day of the month (1–28) to the day before it in the next month.
 *
 * Pay date = period end + payDateOffsetDays. Processing cutoff = the end of the local day that
 * is processingCutoffOffsetDays before the pay date.
 */

export interface PayrollCalendarRules {
  cadence: PayrollCalendarCadence;
  anchorDate: Date;
  payDateOffsetDays: number;
  processingCutoffOffsetDays: number;
  timezone: string;
}

export interface GeneratedPayrollPeriod {
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  processingCutoffAt: Date;
}

/** The shortest period of each cadence (a February second half has 13 days). */
export const MIN_PERIOD_DAYS: Record<PayrollCalendarCadence, number> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
  SEMIMONTHLY: 13,
  MONTHLY: 28,
};

/** Periods per year, for salary periodization (annual / periods). */
export const PERIODS_PER_YEAR: Record<PayrollCalendarCadence, number> = {
  WEEKLY: 52,
  BIWEEKLY: 26,
  SEMIMONTHLY: 24,
  MONTHLY: 12,
};

const DAY_MS = 86_400_000;

function fixedLength(cadence: PayrollCalendarCadence): number | null {
  return cadence === 'WEEKLY' ? 7 : cadence === 'BIWEEKLY' ? 14 : null;
}

function utcDate(year: number, monthIndex: number, day: number) {
  return new Date(Date.UTC(year, monthIndex, day));
}

/** Whether `date` starts a period of the series. */
export function isPeriodStart(
  rules: Pick<PayrollCalendarRules, 'cadence' | 'anchorDate'>,
  date: Date,
): boolean {
  const length = fixedLength(rules.cadence);
  if (length !== null) {
    const days = Math.round(
      (date.getTime() - rules.anchorDate.getTime()) / DAY_MS,
    );
    return ((days % length) + length) % length === 0;
  }
  const day = date.getUTCDate();
  if (rules.cadence === 'SEMIMONTHLY') return day === 1 || day === 16;
  return day === rules.anchorDate.getUTCDate();
}

/** The start of the period after the one starting on `start` (which must be a period start). */
export function nextPeriodStart(
  rules: Pick<PayrollCalendarRules, 'cadence' | 'anchorDate'>,
  start: Date,
): Date {
  const length = fixedLength(rules.cadence);
  if (length !== null) return addDays(start, length);
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  if (rules.cadence === 'SEMIMONTHLY') {
    return start.getUTCDate() === 1
      ? utcDate(year, month, 16)
      : utcDate(year, month + 1, 1);
  }
  return utcDate(year, month + 1, rules.anchorDate.getUTCDate());
}

/** The first period start on or after `date`. */
export function firstPeriodStartOnOrAfter(
  rules: Pick<PayrollCalendarRules, 'cadence' | 'anchorDate'>,
  date: Date,
): Date {
  const length = fixedLength(rules.cadence);
  if (length !== null) {
    const days = Math.round(
      (date.getTime() - rules.anchorDate.getTime()) / DAY_MS,
    );
    const offset = ((days % length) + length) % length;
    return offset === 0 ? date : addDays(date, length - offset);
  }
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  if (rules.cadence === 'SEMIMONTHLY') {
    if (day === 1) return date;
    return day <= 16 ? utcDate(year, month, 16) : utcDate(year, month + 1, 1);
  }
  const anchorDay = rules.anchorDate.getUTCDate();
  return day <= anchorDay
    ? utcDate(year, month, anchorDay)
    : utcDate(year, month + 1, anchorDay);
}

/** The full period (with pay date and cutoff) starting on `start`. */
export function periodStartingOn(
  rules: PayrollCalendarRules,
  start: Date,
): GeneratedPayrollPeriod {
  const periodEnd = addDays(nextPeriodStart(rules, start), -1);
  const payDate = addDays(periodEnd, rules.payDateOffsetDays);
  const cutoffDate = addDays(payDate, -rules.processingCutoffOffsetDays);
  // The last instant of the local cutoff day (a DST change only moves where midnight falls).
  const processingCutoffAt = new Date(
    localDayStart(addDays(cutoffDate, 1), rules.timezone).getTime() - 1,
  );
  return { periodStart: start, periodEnd, payDate, processingCutoffAt };
}

/**
 * The periods of the series that start on or after `from`, start on or before `through`, and
 * (when `endBy` is given) end on or before it. At most `limit` periods.
 */
export function periodsBetween(
  rules: PayrollCalendarRules,
  range: { from: Date; through: Date; endBy?: Date | null; limit: number },
): GeneratedPayrollPeriod[] {
  const periods: GeneratedPayrollPeriod[] = [];
  for (
    let start = firstPeriodStartOnOrAfter(rules, range.from);
    start <= range.through && periods.length < range.limit;
    start = nextPeriodStart(rules, start)
  ) {
    const period = periodStartingOn(rules, start);
    if (range.endBy && period.periodEnd > range.endBy) break;
    periods.push(period);
  }
  return periods;
}

/**
 * A calendar's effective range must consist of whole periods of its series: it starts on a
 * period start (not before the anchor) and, when ended, ends on a period end. Pay dates must
 * not fall before their period starts for any period of the cadence.
 */
export function assertCalendarSeries(
  rules: PayrollCalendarRules,
  effectiveFrom: Date,
  effectiveTo: Date | null,
) {
  const fail = (message: string): never => {
    throw new BadRequestException(
      domainError(400, 'PAYROLL_CALENDAR_SERIES_INVALID', message),
    );
  };
  if (effectiveFrom < rules.anchorDate) {
    fail('effectiveFrom must not be before the anchor date.');
  }
  if (!isPeriodStart(rules, effectiveFrom)) {
    fail(
      `effectiveFrom (${formatDate(effectiveFrom)}) must be the first day of a pay period of this calendar.`,
    );
  }
  if (effectiveTo && !isPeriodStart(rules, addDays(effectiveTo, 1))) {
    fail(
      `effectiveTo (${formatDate(effectiveTo)}) must be the last day of a pay period of this calendar.`,
    );
  }
  if (rules.payDateOffsetDays < -(MIN_PERIOD_DAYS[rules.cadence] - 1)) {
    fail(
      `A ${rules.cadence.toLowerCase()} calendar cannot pay more than ${MIN_PERIOD_DAYS[rules.cadence] - 1} days before a period ends.`,
    );
  }
}
