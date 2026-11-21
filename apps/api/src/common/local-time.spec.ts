import { describe, expect, it } from 'vitest';
import {
  instantsForLocalDateTime,
  localDateTimeParts,
  type LocalDateTimeParts,
  wallClockMs,
} from './local-time.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const iso = (dates: Date[]) => dates.map((date) => date.toISOString());

/**
 * The Phase 6 algorithm, kept as the reference: try every whole minute within ±14 hours of the
 * naive UTC reading and keep the instants whose wall clock matches exactly.
 */
function referenceInstants(parts: LocalDateTimeParts, timezone: string) {
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const matches: string[] = [];
  for (
    let candidate = guess - 14 * HOUR;
    candidate <= guess + 14 * HOUR;
    candidate += MINUTE
  ) {
    const local = localDateTimeParts(new Date(candidate), timezone);
    if (
      local.year === parts.year &&
      local.month === parts.month &&
      local.day === parts.day &&
      local.hour === parts.hour &&
      local.minute === parts.minute &&
      local.second === parts.second
    ) {
      matches.push(new Date(candidate).toISOString());
    }
  }
  return matches;
}

/** UTC offset changes of a zone between two instants, located to the minute. */
function transitions(timezone: string, from: number, to: number) {
  const offset = (instant: number) =>
    wallClockMs(localDateTimeParts(new Date(instant), timezone)) - instant;
  const found: number[] = [];
  let previous = offset(from);
  for (let at = from + 6 * HOUR; at <= to; at += 6 * HOUR) {
    const current = offset(at);
    if (current === previous) continue;
    let low = at - 6 * HOUR;
    let high = at;
    while (high - low > MINUTE) {
      const middle = low + Math.floor((high - low) / 2 / MINUTE) * MINUTE;
      if (offset(middle) === previous) low = middle;
      else high = middle;
    }
    found.push(high);
    previous = current;
  }
  return found;
}

const ZONES = [
  'UTC',
  'America/Toronto',
  'America/Regina',
  'America/St_Johns',
  'America/Santiago',
  'Europe/London',
  'Europe/Dublin',
  'Africa/Casablanca',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'Pacific/Apia',
  'Pacific/Kiritimati',
  'Antarctica/Troll',
];

describe('instantsForLocalDateTime', () => {
  it('finds no instant in a daylight-saving gap and two in an overlap', () => {
    const at = (day: number, month: number, hour: number, minute: number) => ({
      year: 2026,
      month,
      day,
      hour,
      minute,
      second: 0,
    });
    expect(
      instantsForLocalDateTime(at(8, 3, 2, 30), 'America/Toronto'),
    ).toEqual([]);
    expect(
      iso(instantsForLocalDateTime(at(1, 11, 1, 30), 'America/Toronto')),
    ).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
    expect(
      iso(instantsForLocalDateTime(at(2, 10, 22, 0), 'America/Toronto')),
    ).toEqual(['2026-10-03T02:00:00.000Z']);
  });

  it('keeps seconds and handles fractional-hour offsets', () => {
    expect(
      iso(
        instantsForLocalDateTime(
          { year: 2026, month: 10, day: 2, hour: 22, minute: 0, second: 30 },
          'UTC',
        ),
      ),
    ).toEqual(['2026-10-02T22:00:30.000Z']);
    expect(
      iso(
        instantsForLocalDateTime(
          { year: 2026, month: 1, day: 15, hour: 9, minute: 0, second: 15 },
          'Asia/Kathmandu',
        ),
      ),
    ).toEqual(['2026-01-15T03:15:15.000Z']);
    expect(
      iso(
        instantsForLocalDateTime(
          { year: 2026, month: 6, day: 15, hour: 9, minute: 0, second: 0 },
          'Pacific/Chatham',
        ),
      ),
    ).toEqual(['2026-06-14T20:15:00.000Z']);
  });

  it('finds nothing on a calendar day a zone skipped entirely', () => {
    // Samoa moved across the date line: 2011-12-30 never happened in Apia.
    expect(
      instantsForLocalDateTime(
        { year: 2011, month: 12, day: 30, hour: 12, minute: 0, second: 0 },
        'Pacific/Apia',
      ),
    ).toEqual([]);
  });

  it('never matches historical offsets that include seconds, like the previous search', () => {
    // Toronto kept local mean time (UTC-5:17:32) until 1895.
    const lmt = {
      year: 1850,
      month: 3,
      day: 15,
      hour: 9,
      minute: 30,
      second: 0,
    };
    expect(instantsForLocalDateTime(lmt, 'America/Toronto')).toEqual([]);
    expect(referenceInstants(lmt, 'America/Toronto')).toEqual([]);
  });

  it('gives exactly the answers of the previous minute-by-minute search', () => {
    const from = Date.UTC(2024, 0, 1);
    const to = Date.UTC(2027, 0, 1);
    let compared = 0;
    for (const timezone of ZONES) {
      const readings: LocalDateTimeParts[] = [];
      for (const transition of transitions(timezone, from, to)) {
        // Readings across the gap or overlap, on both sides of the change.
        const local = localDateTimeParts(new Date(transition), timezone);
        const base = Date.UTC(
          local.year,
          local.month - 1,
          local.day,
          local.hour,
          local.minute,
        );
        for (let step = -150; step <= 150; step += 30) {
          const reading = new Date(base + step * MINUTE);
          readings.push({
            year: reading.getUTCFullYear(),
            month: reading.getUTCMonth() + 1,
            day: reading.getUTCDate(),
            hour: reading.getUTCHours(),
            minute: reading.getUTCMinutes(),
            second: step % 60 === 0 ? 0 : 45,
          });
        }
      }
      readings.push(
        { year: 2026, month: 7, day: 1, hour: 0, minute: 0, second: 0 },
        { year: 2026, month: 12, day: 31, hour: 23, minute: 59, second: 59 },
        { year: 1900, month: 1, day: 1, hour: 12, minute: 0, second: 0 },
      );
      for (const reading of readings) {
        expect(
          iso(instantsForLocalDateTime(reading, timezone)),
          `${timezone} ${JSON.stringify(reading)}`,
        ).toEqual(referenceInstants(reading, timezone));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(300);
  }, 60_000);
});
