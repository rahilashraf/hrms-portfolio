import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AuthorizationTarget } from '../authorization/authorization.types.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  LocalTimeError,
  resolveLocalTime,
} from '../scheduling/schedule-recurrence.js';

/** Shared helpers for the Phase 8 calendar and leave domains: date-only values, local-day
 * bounds, request context, structured errors and placement → authorization targets. */
export type DomainClient = Prisma.TransactionClient | PrismaService;

export interface DomainRequestContext {
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// ─── Date-only values (UTC-midnight Date objects, never shifted by runtime tz) ────

export function parseDateOnly(value: string, label: string): Date {
  if (!DATE_ONLY.test(value)) {
    throw new BadRequestException(`${label} must use YYYY-MM-DD format.`);
  }
  const [year, month, day] = value.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new BadRequestException(`${label} must be a valid calendar date.`);
  }
  return date;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function daysBetweenInclusive(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
}

export function eachDate(from: Date, to: Date): Date[] {
  const dates: Date[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) dates.push(day);
  return dates;
}

export function minDate(a: Date, b: Date) {
  return a <= b ? a : b;
}

export function maxDate(a: Date, b: Date) {
  return a >= b ? a : b;
}

/** The local calendar date of an instant in an IANA timezone, as a date-only value. */
export function localDateOf(instant: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return new Date(
    Date.UTC(
      Number(part('year')),
      Number(part('month')) - 1,
      Number(part('day')),
    ),
  );
}

/**
 * The first instant of a local date. Midnight itself can be skipped by a DST gap in some
 * zones; the day then starts at the first minute that exists.
 */
export function localDayStart(date: Date, timezone: string): Date {
  for (let minute = 0; minute < 180; minute += 1) {
    try {
      return resolveLocalTime(date, minute, timezone).instant;
    } catch (error) {
      if (!(error instanceof LocalTimeError)) throw error;
    }
  }
  throw new BadRequestException(
    'Unable to resolve the start of the local day.',
  );
}

/** [start, end) of a local date: 23, 24 or 25 hours across DST transitions. */
export function localDayBounds(date: Date, timezone: string) {
  return {
    start: localDayStart(date, timezone),
    end: localDayStart(addDays(date, 1), timezone),
  };
}

/** A local wall-clock time ("HH:mm") on a local date; DST gaps are rejected, never shifted. */
export function localInstant(date: Date, time: string, timezone: string): Date {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  try {
    return resolveLocalTime(date, hour * 60 + minute, timezone).instant;
  } catch (error) {
    if (error instanceof LocalTimeError) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'LOCAL_TIME_NONEXISTENT',
        message: error.message,
      });
    }
    throw error;
  }
}

/**
 * The calendar dates currently in effect somewhere on Earth: the earliest (UTC−12) and the
 * latest (UTC+14). Used, as in Scheduling, to judge "already started" conservatively.
 */
export function currentDates(now = Date.now()) {
  const date = (offsetHours: number) =>
    new Date(
      new Date(now + offsetHours * 3_600_000).toISOString().slice(0, 10),
    );
  return { earliest: date(-12), latest: date(14) };
}

export function minutesBetween(start: Date, end: Date) {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
}

export function overlapMinutesOf(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
) {
  return minutesBetween(
    new Date(Math.max(a.start.getTime(), b.start.getTime())),
    new Date(Math.min(a.end.getTime(), b.end.getTime())),
  );
}

// ─── Organization placement → authorization targets (no per-row queries) ─────

export interface PositionPlacement {
  id: string;
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
}

/**
 * Builds authorization targets for many positions from one unit query, exactly as
 * PositionAuthorizationTargetResolver.resolvePosition does per position: the position's own
 * placement columns, with the unit path (leaf → root) of its organizational unit.
 */
export async function positionTargets(
  client: DomainClient,
  positions: readonly PositionPlacement[],
): Promise<Map<string, AuthorizationTarget>> {
  const organizationIds = [...new Set(positions.map((p) => p.organizationId))];
  const units = organizationIds.length
    ? await client.organizationalUnit.findMany({
        where: { organizationId: { in: organizationIds } },
        select: { id: true, parentUnitId: true },
      })
    : [];
  const parent = new Map(units.map((u) => [u.id, u.parentUnitId]));
  const pathOf = (leaf: string | null) => {
    const path: string[] = [];
    for (
      let unit = leaf;
      unit && !path.includes(unit);
      unit = parent.get(unit) ?? null
    ) {
      path.push(unit);
    }
    return path;
  };
  const result = new Map<string, AuthorizationTarget>();
  for (const position of positions) {
    result.set(position.id, {
      type: position.teamId
        ? 'TEAM'
        : position.departmentId
          ? 'DEPARTMENT'
          : position.organizationalUnitId
            ? 'ORGANIZATIONAL_UNIT'
            : 'ORGANIZATION',
      organizationId: position.organizationId,
      unitPathIds: pathOf(position.organizationalUnitId),
      departmentId: position.departmentId,
      teamId: position.teamId,
    });
  }
  return result;
}

export function requireActor(context: DomainRequestContext): string {
  if (!context.actorUserId) throw new ForbiddenException();
  return context.actorUserId;
}

export function domainError(
  status: 400 | 403 | 404 | 409,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  const error =
    status === 400
      ? 'Bad Request'
      : status === 403
        ? 'Forbidden'
        : status === 404
          ? 'Not Found'
          : 'Conflict';
  return { statusCode: status, error, code, message, ...extra };
}

export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function advisoryLock(
  client: Prisma.TransactionClient,
  key: string,
) {
  await client.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}
