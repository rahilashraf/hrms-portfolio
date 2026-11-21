/**
 * Wall-clock conversions in IANA time zones that never consult the runtime's own time zone.
 * Formatters are expensive to construct, so one is cached per zone.
 */

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** Furthest an instant may be from its naive UTC reading (the widest real UTC offsets). */
const MAX_OFFSET_MS = 14 * HOUR_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
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
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/** The wall-clock reading of an instant in an IANA time zone. */
export function localDateTimeParts(
  instant: Date,
  timezone: string,
): LocalDateTimeParts {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(timezone).formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts[type];
    if (!value) throw new Error(`Unable to derive local ${type}.`);
    return Number(value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** A wall-clock reading as milliseconds on the UTC time line (the reading "as if UTC"). */
export function wallClockMs(parts: LocalDateTimeParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

/**
 * Every instant at which the wall clock in `timezone` reads exactly `parts`, ascending:
 * none inside a daylight-saving gap, two inside an overlap, otherwise one.
 *
 * Only offsets of whole minutes up to ±14 hours count, so historical local mean time offsets
 * that include seconds never match (the Phase 6 minute-by-minute search behaved the same way).
 */
export function instantsForLocalDateTime(
  parts: LocalDateTimeParts,
  timezone: string,
): Date[] {
  const wall = wallClockMs(parts);
  // Transitions are far more than a day apart, so the offsets in force over the surrounding
  // days cover every interpretation of the reading.
  const offsets = new Set<number>();
  for (const probe of [-36, -12, 0, 12, 36]) {
    const instant = wall + probe * HOUR_MS;
    offsets.add(
      wallClockMs(localDateTimeParts(new Date(instant), timezone)) - instant,
    );
  }
  const instants: number[] = [];
  for (const offset of offsets) {
    const instant = wall - offset;
    if (Math.abs(offset) > MAX_OFFSET_MS || offset % MINUTE_MS !== 0) continue;
    if (
      wallClockMs(localDateTimeParts(new Date(instant), timezone)) === wall &&
      !instants.includes(instant)
    ) {
      instants.push(instant);
    }
  }
  return instants.sort((a, b) => a - b).map((instant) => new Date(instant));
}
