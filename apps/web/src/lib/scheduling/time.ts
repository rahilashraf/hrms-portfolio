/**
 * Date-only and zoned wall-clock helpers for scheduling. Dates are `YYYY-MM-DD` strings handled
 * in UTC arithmetic (no local-machine timezone leaks); shifts are converted between a work
 * location's IANA timezone and the absolute instants the API stores.
 */

const DAY_MS = 86_400_000;

function parseDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return formatDate(parseDate(date) + days * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndex(date: string): number {
  return (new Date(parseDate(date)).getUTCDay() + 6) % 7;
}

export function startOfWeek(date: string): string {
  return addDays(date, -weekdayIndex(date));
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return formatDate(Date.UTC(y!, m!, 0));
}

export function addMonths(date: string, months: number): string {
  const [y, m] = date.split('-').map(Number);
  return formatDate(Date.UTC(y!, m! - 1 + months, 1));
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The latest calendar date in effect anywhere on Earth (UTC+14). The API treats a policy or
 * pattern as started once its first day has begun anywhere, so it can be edited or deleted only
 * while its start is after this date.
 */
export function latestDateAnywhere(now = new Date()): string {
  return todayIn('Etc/GMT-14', now);
}

/** Today's date in a timezone (falls back to UTC for an invalid zone). */
export function todayIn(timezone: string | null | undefined, now = new Date()): string {
  return zonedParts(now, timezone).date;
}

function zonedParts(instant: Date, timezone: string | null | undefined) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(instant);
  } catch {
    return zonedParts(instant, 'UTC');
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    seconds: Number(get('second')),
  };
}

/** The wall-clock date and HH:mm of an instant in a timezone. */
export function toZoned(iso: string, timezone: string | null | undefined) {
  const { date, time } = zonedParts(new Date(iso), timezone);
  return { date, time };
}

/**
 * The instant (ISO, UTC) of a wall-clock date and time in a timezone. Uses the zone's offset at
 * that moment, so daylight-saving changes are respected; a nonexistent local time resolves
 * forward by the gap (the API reports the shift as invalid if it disagrees).
 */
export function fromZoned(date: string, time: string, timezone: string): string {
  const [h, min] = time.split(':').map(Number);
  const wall = parseDate(date) + ((h ?? 0) * 60 + (min ?? 0)) * 60_000;
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const zoned = zonedParts(new Date(guess), timezone);
    const shown = parseDate(zoned.date) + timeMinutes(zoned.time) * 60_000 + zoned.seconds * 1000;
    const delta = wall - shown;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess).toISOString();
}

function timeMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** "9:00 AM" style time of an instant in a timezone. */
export function formatTime(iso: string, timezone: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeStyle: 'short',
      timeZone: timezone || 'UTC',
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeStyle: 'short', timeZone: 'UTC' }).format(
      new Date(iso),
    );
  }
}

/** "Mon, Oct 5" for a date-only value. */
export function formatDay(date: string, style: 'short' | 'long' = 'short'): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: style === 'long' ? 'long' : 'short',
    month: 'short',
    day: 'numeric',
    ...(style === 'long' ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(parseDate(date)));
}

export function formatMonth(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(parseDate(date)));
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Splits [from, to] into consecutive windows of at most `maxDays` days (inclusive). */
export function chunkRange(
  from: string,
  to: string,
  maxDays: number,
): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (let start = from; start <= to; start = addDays(start, maxDays)) {
    const end = addDays(start, maxDays - 1);
    out.push({ from: start, to: end < to ? end : to });
  }
  return out;
}
