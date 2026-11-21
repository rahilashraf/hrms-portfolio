import { BadRequestException } from '@nestjs/common';

/**
 * The shape of an IANA time zone identifier: "Area/Location" (any depth, e.g. Etc/GMT+5) or
 * UTC. Never a raw UTC offset such as "+05:30" (Intl accepts those, but they are not zones),
 * and never a bare legacy abbreviation such as EST or EST5EDT: those resolve, but to fixed or
 * US-rule offsets easily mistaken for local time (EST has no daylight saving), so they stay
 * refused as before.
 */
const IANA_IDENTIFIER =
  /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

/**
 * Domain-neutral IANA timezone validation shared by every bounded context (Time & Attendance,
 * Scheduling, Organizations, Payroll…) so they all accept the same names.
 *
 * Batch 4D (decision D-A): any Area/Location identifier (or UTC) the runtime's time zone
 * database resolves is valid, current names and aliases alike (Asia/Kolkata as well as Asia/Calcutta, Europe/Kyiv as well
 * as Europe/Kiev, Etc/UTC). Before 4D only the names ICU *lists* were accepted, which are the
 * legacy spellings, so current names were refused. Values are stored as entered; nothing is
 * rewritten.
 */
export function isIanaTimezone(timezone: string): boolean {
  const normalized = timezone.trim();
  if (normalized === '' || !IANA_IDENTIFIER.test(normalized)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export function assertIanaTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (!isIanaTimezone(normalized)) {
    throw new BadRequestException('timezone must be a valid IANA time zone.');
  }
  return normalized;
}
