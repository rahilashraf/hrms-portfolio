import { instantsForLocalDateTime } from '../../src/common/local-time.js';

/**
 * Date planning for the real-stack seed (Batch 4, PR 4.0). Every date the browser flow uses comes
 * from one reference instant and one IANA timezone, computed here once at seeding and handed to
 * the specs in the seed file, so nothing depends on the test runner's clock, its timezone, or
 * the date changing between seeding and the tests. Pure functions; any timezone works.
 */

/** America/Toronto: the deliberate default, because it observes daylight-saving time. */
export const REAL_STACK_DEFAULT_TIMEZONE = 'America/Toronto';

/** How many days the seeded period covers, ending the day before the reference date. */
export const REAL_STACK_PERIOD_DAYS = 7;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{2}:\d{2}$/;

/** The calendar date (YYYY-MM-DD) an instant falls on in a timezone. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** A calendar date moved by whole days (pure calendar arithmetic; no timezone involved). */
export function shiftDate(date: string, days: number): string {
  if (!DATE_ONLY.test(date)) throw new Error(`Not a date: ${date}`);
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The instant a local date and time names in a timezone. Refuses a time that doesn't exist
 * (spring-forward gap) or occurs twice (fall-back overlap), so a plan is never ambiguous.
 */
export function localInstant(
  date: string,
  time: string,
  timeZone: string,
): Date {
  if (!DATE_ONLY.test(date) || !LOCAL_TIME.test(time)) {
    throw new Error(`Not a local date and time: ${date} ${time}`);
  }
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const instants = instantsForLocalDateTime(
    { year, month, day, hour, minute, second: 0 },
    timeZone,
  );
  if (instants.length !== 1) {
    throw new Error(
      `${date} ${time} is ${instants.length === 0 ? 'skipped' : 'repeated'} in ${timeZone}.`,
    );
  }
  return instants[0]!;
}

export interface RealStackDatePlan {
  timezone: string;
  /** The seed's single reference instant (ISO). */
  referenceInstant: string;
  /** Its calendar date in the timezone. */
  referenceDate: string;
  /** The past attendance record: the day before the reference date, 09:00–12:00 local. */
  pastEntry: {
    workDate: string;
    clockInAt: Date;
    clockOutAt: Date;
    /** The employee's corrected clock-out, as typed into the form (local, YYYY-MM-DDTHH:mm). */
    correctedClockOutLocal: string;
    correctedClockOutAt: Date;
  };
  /**
   * The time period: the REAL_STACK_PERIOD_DAYS days ending the day before the reference date,
   * so it has ended (Batch 4A: timesheets are submitted once their period ends).
   */
  period: { startDate: string; endDate: string };
}

/**
 * Every date the real-stack flow needs, from one reference instant. The past record and its
 * correction always lie before the reference instant (the correction ends at 13:00 the day
 * before, at least 11 hours earlier). The period is the week ending the day before the reference
 * date: it has ended, so its timesheet can be submitted, and it holds the past record. Live
 * punches made while the tests run (on the reference date or later) fall after it.
 */
export function planRealStackDates(
  reference: Date,
  timezone: string = REAL_STACK_DEFAULT_TIMEZONE,
): RealStackDatePlan {
  if (Number.isNaN(reference.getTime())) {
    throw new Error('The reference instant is not a valid date.');
  }
  const referenceDate = localDate(reference, timezone);
  const workDate = shiftDate(referenceDate, -1);
  const plan: RealStackDatePlan = {
    timezone,
    referenceInstant: reference.toISOString(),
    referenceDate,
    pastEntry: {
      workDate,
      clockInAt: localInstant(workDate, '09:00', timezone),
      clockOutAt: localInstant(workDate, '12:00', timezone),
      correctedClockOutLocal: `${workDate}T13:00`,
      correctedClockOutAt: localInstant(workDate, '13:00', timezone),
    },
    period: {
      startDate: shiftDate(referenceDate, -REAL_STACK_PERIOD_DAYS),
      endDate: shiftDate(referenceDate, -1),
    },
  };
  if (plan.pastEntry.correctedClockOutAt.getTime() >= reference.getTime()) {
    throw new Error('The planned correction would not be in the past.');
  }
  return plan;
}

/** The reference instant for a run: REAL_STACK_REFERENCE_INSTANT (to reproduce one), else now. */
export function referenceInstantFrom(
  environment: NodeJS.ProcessEnv,
  now: () => Date = () => new Date(),
): Date {
  const configured = environment.REAL_STACK_REFERENCE_INSTANT;
  if (!configured) return now();
  const parsed = new Date(configured);
  if (
    Number.isNaN(parsed.getTime()) ||
    !/(Z|[+-]\d{2}:\d{2})$/.test(configured)
  ) {
    throw new Error(
      'REAL_STACK_REFERENCE_INSTANT must be an ISO instant with an offset, e.g. 2027-03-02T14:00:00Z.',
    );
  }
  return parsed;
}
