import { BadRequestException } from '@nestjs/common';
import type { ScheduleDayOfWeek } from '../generated/prisma/enums.js';

/** ISO weekday order: Monday is day 0 of a rotation week. */
export const SCHEDULE_DAYS_OF_WEEK = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const satisfies readonly ScheduleDayOfWeek[];

export const MAX_ROTATION_WEEKS = 52;
const MINUTES_PER_DAY = 24 * 60;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A recurring local wall-clock interval. Times are minutes after local midnight. An end at or
 * before the start ends on the following local calendar day, so 22:00–06:00 is an overnight
 * rule and an equal start and end is a full 24 hours.
 */
export interface RecurrenceInterval {
  weekIndex: number;
  dayOfWeek: ScheduleDayOfWeek;
  startMinute: number;
  endMinute: number;
}

/** Strict HH:mm (00:00–23:59). Seconds and 24:00 are not accepted. */
export function parseLocalTime(value: string, label: string): number {
  const match = LOCAL_TIME.exec(value);
  if (!match) {
    throw new BadRequestException(
      `${label} must be a local time in HH:mm format.`,
    );
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatLocalTime(minute: number): string {
  const hours = Math.floor(minute / 60);
  return `${String(hours).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/**
 * Postgres TIME is exchanged with Prisma as a UTC Date on 1970-01-01. These two functions are
 * the only place that representation is touched; the domain works in minutes.
 */
export function minuteToTimeColumn(minute: number): Date {
  return new Date(minute * 60_000);
}

export function timeColumnToMinute(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

export function durationMinutes(interval: RecurrenceInterval): number {
  return interval.endMinute > interval.startMinute
    ? interval.endMinute - interval.startMinute
    : interval.endMinute + MINUTES_PER_DAY - interval.startMinute;
}

export function assertRotationWeeks(rotationWeeks: number) {
  if (
    !Number.isInteger(rotationWeeks) ||
    rotationWeeks < 1 ||
    rotationWeeks > MAX_ROTATION_WEEKS
  ) {
    throw new BadRequestException(
      `rotationWeeks must be an integer from 1 to ${MAX_ROTATION_WEEKS}.`,
    );
  }
}

/** weekIndex is 0-based: 0 … rotationWeeks − 1. */
export function assertWeekIndex(weekIndex: number, rotationWeeks: number) {
  if (
    !Number.isInteger(weekIndex) ||
    weekIndex < 0 ||
    weekIndex >= rotationWeeks
  ) {
    throw new BadRequestException(
      `weekIndex must be from 0 to ${rotationWeeks - 1} for a ${rotationWeeks}-week rotation.`,
    );
  }
}

/** A rotation's week 0 starts on its anchor, so the anchor must be the first day of a week. */
export function assertAnchorMonday(anchorDate: Date) {
  if (anchorDate.getUTCDay() !== 1) {
    throw new BadRequestException('anchorDate must be a Monday.');
  }
}

/**
 * The rotation week a local date falls in: whole weeks from the anchor week, modulo the
 * rotation, on DATE values (UTC midnight), never server or ISO calendar week numbers. Dates
 * before the anchor wrap backwards. Batch 6 uses this to expand patterns.
 */
export function rotationWeekOf(
  anchorDate: Date,
  localDate: Date,
  rotationWeeks: number,
): number {
  const days = Math.round(
    (localDate.getTime() - anchorDate.getTime()) / (MINUTES_PER_DAY * 60_000),
  );
  const weeks = Math.floor(days / 7);
  return ((weeks % rotationWeeks) + rotationWeeks) % rotationWeeks;
}

/**
 * Finds two rules of one rotation whose local intervals overlap. The rotation is a cycle of
 * rotationWeeks × 7 days, so an overnight rule overlaps the next day's rules, and the last
 * week's Sunday overnight wraps into week 0's Monday. Intervals are half-open: touching
 * rules (one ends when the next starts) do not overlap. This is structural, local-time
 * validation only; concrete DST instants and cross-assignment conflicts belong to generation.
 */
export function findOverlappingRules<T extends RecurrenceInterval>(
  rules: readonly T[],
  rotationWeeks: number,
): [T, T] | null {
  const cycle = rotationWeeks * 7 * MINUTES_PER_DAY;
  const spans = rules.map((rule) => {
    const start =
      (rule.weekIndex * 7 + SCHEDULE_DAYS_OF_WEEK.indexOf(rule.dayOfWeek)) *
        MINUTES_PER_DAY +
      rule.startMinute;
    return { rule, start, end: start + durationMinutes(rule) };
  });
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      const a = spans[i]!;
      const b = spans[j]!;
      for (const shift of [-cycle, 0, cycle]) {
        if (a.start < b.end + shift && b.start + shift < a.end) {
          return [a.rule, b.rule];
        }
      }
    }
  }
  return null;
}

// ─── Occurrences (Phase 7 Batch 6) ────────────────────────────────────────────

const DAY_MS = MINUTES_PER_DAY * 60_000;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The ISO weekday of a DATE value (UTC midnight), independent of any runtime timezone. */
export function dayOfWeekOf(
  date: Date,
): (typeof SCHEDULE_DAYS_OF_WEEK)[number] {
  return SCHEDULE_DAYS_OF_WEEK[(date.getUTCDay() + 6) % 7]!;
}

/** The Monday that starts the week containing a DATE value. */
export function weekStartOf(date: Date): Date {
  return addDays(date, -SCHEDULE_DAYS_OF_WEEK.indexOf(dayOfWeekOf(date)));
}

/**
 * The stable identity of one recurrence occurrence: the pattern, the rule, and the local date
 * the occurrence starts on. Generating the same occurrence again always yields the same key.
 */
export function occurrenceKey(
  patternId: string,
  ruleId: string,
  localDate: Date,
): string {
  return `v1:${patternId}:${ruleId}:${formatDateOnly(localDate)}`;
}

export type LocalTimeErrorCode = 'LOCAL_TIME_NONEXISTENT';

export class LocalTimeError extends Error {
  constructor(
    readonly code: LocalTimeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolvedLocalTime {
  instant: Date;
  /** The wall-clock time occurred twice (a fall-back repeat); the earlier instant was used. */
  ambiguous: boolean;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(instant: Date, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
  );
}

/** UTC offset in minutes of an IANA timezone at an instant. */
function offsetMinutes(instant: number, timezone: string): number {
  return Math.round(
    (localParts(new Date(instant), timezone) - instant) / 60_000,
  );
}

/**
 * Resolves a local wall-clock time on a local date in an IANA timezone to an instant, without
 * consulting the runtime timezone. Generation policy for daylight-saving transitions:
 * - a NONEXISTENT time (skipped by a spring-forward gap) is an error; it is never shifted;
 * - an AMBIGUOUS time (repeated by a fall-back overlap) resolves to the EARLIER instant, the
 *   first time the wall clock shows it, and is reported as ambiguous.
 * Phase 6 rejects both for typed user input, where the user can clarify; a generator cannot
 * ask, so ambiguity gets one deterministic, documented answer while gaps still fail loudly.
 */
export function resolveLocalTime(
  localDate: Date,
  minute: number,
  timezone: string,
): ResolvedLocalTime {
  const wall = localDate.getTime() + minute * 60_000;
  // Transitions are far more than a day apart, so the offsets a day before and after the wall
  // time cover every candidate interpretation.
  const offsets = new Set([
    offsetMinutes(wall - DAY_MS, timezone),
    offsetMinutes(wall + DAY_MS, timezone),
  ]);
  const candidates = [...offsets]
    .map((offset) => wall - offset * 60_000)
    .filter((instant) => localParts(new Date(instant), timezone) === wall)
    .sort((a, b) => a - b);
  if (candidates.length === 0) {
    throw new LocalTimeError(
      'LOCAL_TIME_NONEXISTENT',
      `${formatDateOnly(localDate)} ${formatLocalTime(minute)} does not exist in ${timezone} (daylight-saving gap).`,
    );
  }
  return {
    instant: new Date(candidates[0]!),
    ambiguous: candidates.length > 1,
  };
}

export interface ResolvedOccurrence {
  workDate: Date;
  startsAt: Date;
  endsAt: Date;
  ambiguous: boolean;
}

/**
 * The concrete interval of a rule on a local date. workDate is always the local start date;
 * an overnight rule (end at or before start) ends on the following local date.
 */
export function resolveOccurrence(
  localDate: Date,
  interval: Pick<RecurrenceInterval, 'startMinute' | 'endMinute'>,
  timezone: string,
): ResolvedOccurrence {
  const start = resolveLocalTime(localDate, interval.startMinute, timezone);
  const end = resolveLocalTime(
    interval.endMinute > interval.startMinute
      ? localDate
      : addDays(localDate, 1),
    interval.endMinute,
    timezone,
  );
  if (end.instant.getTime() <= start.instant.getTime()) {
    throw new LocalTimeError(
      'LOCAL_TIME_NONEXISTENT',
      `The occurrence on ${formatDateOnly(localDate)} has no positive duration in ${timezone}.`,
    );
  }
  return {
    workDate: localDate,
    startsAt: start.instant,
    endsAt: end.instant,
    ambiguous: start.ambiguous || end.ambiguous,
  };
}
