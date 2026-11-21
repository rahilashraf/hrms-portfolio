import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  instantsForLocalDateTime,
  localDateTimeParts,
} from '../common/local-time.js';
import { assertIanaTimezone, isIanaTimezone } from '../common/timezone.js';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/;

export const TIME_POLICY_SECTION_KEYS = [
  'clock',
  'breaks',
  'missedPunch',
  'correction',
  'attendanceInterpretation',
  'timesheet',
  'attendance',
  // Batch 4C: no-show detection (per assignment) and attendance-only period automation
  // (organization level). Both off unless a policy enables them.
  'noShow',
  'periods',
] as const;

export type TimePolicySectionKey = (typeof TIME_POLICY_SECTION_KEYS)[number];
export type TimePolicyMode =
  | 'DISABLED'
  | 'LIVE_CLOCK'
  | 'MANUAL'
  | 'BASIC'
  | 'REVIEW_REQUIRED'
  | 'NONE'
  | 'MANUAL_PUNCH'
  | 'AUTO_DEDUCT'
  | 'PAID'
  | 'UNPAID';

export type TimePolicySectionConfig = {
  mode: TimePolicyMode;
  [key: string]: unknown;
};

export type TimeAttendancePolicyConfig = Record<
  TimePolicySectionKey,
  TimePolicySectionConfig
>;

export type TimePolicyInheritanceMode = 'INHERIT' | 'OVERRIDE';

export interface TimePolicyLayer {
  inheritanceMode: TimePolicyInheritanceMode;
  config: unknown;
}

export interface EffectiveDateRange {
  effectiveFrom: string;
  effectiveTo?: string | null;
}

export const DEFAULT_TIME_ATTENDANCE_POLICY_CONFIG: TimeAttendancePolicyConfig =
  Object.freeze({
    clock: Object.freeze({ mode: 'DISABLED' }),
    breaks: Object.freeze({ mode: 'NONE' }),
    missedPunch: Object.freeze({ mode: 'DISABLED' }),
    correction: Object.freeze({ mode: 'DISABLED' }),
    attendanceInterpretation: Object.freeze({ mode: 'BASIC' }),
    timesheet: Object.freeze({ mode: 'DISABLED' }),
    // Phase 9.5: tracking and capture modes (see time-policy.ts); the defaults are the pre-9.5
    // behaviour, TIME_CLOCK captured through self-service.
    attendance: Object.freeze({
      mode: 'BASIC',
      trackingMode: 'TIME_CLOCK',
      captureMode: 'SELF_SERVICE',
      kioskLocationRule: 'ANY_IN_ORGANIZATION',
      signInDuplicateWindowMinutes: 10,
    }),
    noShow: Object.freeze({
      mode: 'DISABLED',
      enabled: false,
      graceMinutes: 30,
    }),
    periods: Object.freeze({
      mode: 'DISABLED',
      autoGenerate: false,
      autoMaterialize: false,
      leadDays: 7,
    }),
  });

@Injectable()
export class TimeDomainService {
  isIanaTimezone(timezone: string): boolean {
    return isIanaTimezone(timezone);
  }

  assertIanaTimezone(timezone: string): string {
    return assertIanaTimezone(timezone);
  }

  deriveWorkDate(instant: Date, timezone: string): string {
    if (Number.isNaN(instant.getTime())) {
      throw new BadRequestException('instant must be a valid date.');
    }
    const parts = localDateTimeParts(
      instant,
      this.assertIanaTimezone(timezone),
    );
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  }

  parseDateOnly(value: string): Date {
    if (!DATE_ONLY_PATTERN.test(value)) {
      throw new BadRequestException('date must use YYYY-MM-DD format.');
    }
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new BadRequestException('date must be a valid calendar date.');
    }
    return date;
  }

  /**
   * A local date and time a person typed, in a timezone. Batch 4D (decision D-C):
   * - a time skipped by a daylight-saving gap is refused (400 TIME_LOCAL_TIME_NONEXISTENT);
   * - a time repeated by a fall-back overlap is refused with both valid occurrences (409
   *   TIME_LOCAL_TIME_AMBIGUOUS, `occurrences` with each instant and its offset) unless the value
   *   names one with an explicit UTC offset (`2027-11-07T01:30-04:00`);
   * - an explicit offset must be the zone's real offset at that local time, or the value is
   *   refused (400 TIME_LOCAL_TIME_OFFSET_MISMATCH): it selects an occurrence, never another zone.
   */
  parseLocalDateTime(value: string, timezone: string): Date {
    const match = LOCAL_DATE_TIME_PATTERN.exec(value);
    if (!match) {
      throw new BadRequestException(
        'datetime must use YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss format, optionally with a UTC offset.',
      );
    }
    const [
      ,
      yearValue,
      monthValue,
      dayValue,
      hourValue,
      minuteValue,
      second,
      offset,
    ] = match;
    const requested = {
      year: Number(yearValue),
      month: Number(monthValue),
      day: Number(dayValue),
      hour: Number(hourValue),
      minute: Number(minuteValue),
      second: second === undefined ? 0 : Number(second),
    };
    this.parseDateOnly(`${yearValue}-${monthValue}-${dayValue}`);
    if (requested.hour > 23 || requested.minute > 59 || requested.second > 59) {
      throw new BadRequestException('datetime must be a valid local time.');
    }
    const zone = this.assertIanaTimezone(timezone);
    const matches = instantsForLocalDateTime(requested, zone);
    if (offset !== undefined) {
      const offsetMinutes =
        offset === 'Z'
          ? 0
          : (offset.startsWith('-') ? -1 : 1) *
            (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
      const wall = Date.UTC(
        requested.year,
        requested.month - 1,
        requested.day,
        requested.hour,
        requested.minute,
        requested.second,
      );
      const instant = new Date(wall - offsetMinutes * 60_000);
      if (
        !matches.some((candidate) => candidate.getTime() === instant.getTime())
      ) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'TIME_LOCAL_TIME_OFFSET_MISMATCH',
          message: `The offset ${offset} is not the offset of ${zone} at that local time.`,
        });
      }
      return instant;
    }
    if (matches.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'TIME_LOCAL_TIME_NONEXISTENT',
        message: `The local time does not exist in ${zone} (daylight-saving gap).`,
      });
    }
    if (matches.length > 1) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'TIME_LOCAL_TIME_AMBIGUOUS',
        message: `The local time occurs twice in ${zone} (daylight-saving overlap). Send it with the UTC offset of the occurrence you mean.`,
        occurrences: matches.map((instant) => {
          // Each occurrence's offset is the wall time minus the instant (no zone lookup).
          const wall = Date.UTC(
            requested.year,
            requested.month - 1,
            requested.day,
            requested.hour,
            requested.minute,
            requested.second,
          );
          const offsetText = formatOffsetMinutes(
            Math.round((wall - instant.getTime()) / 60_000),
          );
          return {
            instant: instant.toISOString(),
            offset: offsetText,
            value: `${yearValue}-${monthValue}-${dayValue}T${hourValue}:${minuteValue}${second === undefined ? '' : `:${second}`}${offsetText}`,
          };
        }),
      });
    }
    return matches[0]!;
  }

  /**
   * A local date and time a POLICY defines (expected start or end, missed-punch expected end),
   * resolved deterministically. Batch 4D (decision D-B, "compatible" disambiguation):
   * - a time skipped by a daylight-saving gap moves forward by the gap (02:30 → 03:30);
   * - a time repeated by a fall-back overlap is its earlier occurrence.
   * It never throws for daylight saving, so a policy time can never refuse a punch.
   */
  resolvePolicyLocalDateTime(
    date: string,
    localTime: string,
    timezone: string,
  ): Date {
    const [year, month, day] = date.split('-').map(Number) as [
      number,
      number,
      number,
    ];
    const [hour, minute, second] = localTime.split(':').map(Number) as [
      number,
      number,
      number | undefined,
    ];
    const zone = this.assertIanaTimezone(timezone);
    const wall = { year, month, day, hour, minute, second: second ?? 0 };
    const matches = instantsForLocalDateTime(wall, zone);
    if (matches.length > 0) return matches[0]!;
    // A gap: read the wall time with the offset in force just before the transition.
    const wallMs = Date.UTC(year, month - 1, day, hour, minute, second ?? 0);
    const before = new Date(wallMs - 86_400_000);
    const beforeParts = localDateTimeParts(before, zone);
    const offsetBefore =
      Date.UTC(
        beforeParts.year,
        beforeParts.month - 1,
        beforeParts.day,
        beforeParts.hour,
        beforeParts.minute,
        beforeParts.second,
      ) - before.getTime();
    return new Date(wallMs - offsetBefore);
  }

  /** The local wall-clock time (YYYY-MM-DDTHH:mm) of an instant in a timezone. */
  formatLocalDateTime(instant: Date, timezone: string): string {
    const parts = localDateTimeParts(
      instant,
      this.assertIanaTimezone(timezone),
    );
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
  }

  assertEffectiveDateRange(range: EffectiveDateRange): void {
    const effectiveFrom = this.parseDateOnly(range.effectiveFrom);
    if (!range.effectiveTo) return;
    const effectiveTo = this.parseDateOnly(range.effectiveTo);
    if (effectiveTo.getTime() < effectiveFrom.getTime()) {
      throw new BadRequestException(
        'effectiveTo must be on or after effectiveFrom.',
      );
    }
  }

  isEffectiveOn(range: EffectiveDateRange, workDate: string): boolean {
    this.assertEffectiveDateRange(range);
    const target = this.parseDateOnly(workDate).getTime();
    const effectiveFrom = this.parseDateOnly(range.effectiveFrom).getTime();
    const effectiveTo = range.effectiveTo
      ? this.parseDateOnly(range.effectiveTo).getTime()
      : Number.POSITIVE_INFINITY;
    return effectiveFrom <= target && target <= effectiveTo;
  }

  resolvePolicyConfig(
    layers: readonly TimePolicyLayer[],
  ): TimeAttendancePolicyConfig {
    return this.resolvePolicyWithSources(layers).config;
  }

  /**
   * The one policy resolution (attendance runtime and the Batch 4E-2 effective-policy view):
   * layers broadest first; an OVERRIDE layer starts again from the defaults; each section merges
   * key by key. `sources` records, for every resolved key, the layer that set it last (by index
   * in `layers`) or the default, and whether an OVERRIDE layer reset it to the default.
   */
  resolvePolicyWithSources(layers: readonly TimePolicyLayer[]): {
    config: TimeAttendancePolicyConfig;
    sources: PolicySettingSources;
  } {
    let resolved = clonePolicyConfig(DEFAULT_TIME_ATTENDANCE_POLICY_CONFIG);
    let sources = defaultSources(resolved);
    layers.forEach((layer, index) => {
      const normalized = normalizePolicyConfig(layer.config);
      let base = resolved;
      if (layer.inheritanceMode === 'OVERRIDE') {
        base = clonePolicyConfig(DEFAULT_TIME_ATTENDANCE_POLICY_CONFIG);
        sources = defaultSources(base, index);
      }
      resolved = mergePolicyConfig(base, normalized);
      for (const section of TIME_POLICY_SECTION_KEYS) {
        for (const key of Object.keys(normalized[section] ?? {})) {
          sources[section][key] = { kind: 'LAYER', layerIndex: index };
        }
      }
    });
    return { config: resolved, sources };
  }
}

/** Where a resolved policy setting came from (Batch 4E-2). */
export type PolicySettingSource =
  | { kind: 'LAYER'; layerIndex: number }
  /** The built-in default; `resetByLayerIndex` when an OVERRIDE layer restored it. */
  | { kind: 'DEFAULT'; resetByLayerIndex?: number };

export type PolicySettingSources = Record<
  TimePolicySectionKey,
  Record<string, PolicySettingSource>
>;

function defaultSources(
  config: TimeAttendancePolicyConfig,
  resetByLayerIndex?: number,
): PolicySettingSources {
  const sources = {} as PolicySettingSources;
  for (const section of TIME_POLICY_SECTION_KEYS) {
    sources[section] = {};
    for (const key of Object.keys(config[section] ?? {})) {
      sources[section][key] =
        resetByLayerIndex === undefined
          ? { kind: 'DEFAULT' }
          : { kind: 'DEFAULT', resetByLayerIndex };
    }
  }
  return sources;
}

function clonePolicyConfig(
  config: TimeAttendancePolicyConfig,
): TimeAttendancePolicyConfig {
  return structuredClone(config) as TimeAttendancePolicyConfig;
}

function normalizePolicyConfig(
  config: unknown,
): Partial<TimeAttendancePolicyConfig> {
  if (!isPlainRecord(config)) {
    throw new BadRequestException('time policy config must be an object.');
  }
  const normalized: Partial<TimeAttendancePolicyConfig> = {};
  for (const key of TIME_POLICY_SECTION_KEYS) {
    const section = config[key];
    if (section === undefined) continue;
    if (!isPlainRecord(section)) {
      throw new BadRequestException(`${key} policy config must be an object.`);
    }
    normalized[key] = { ...section } as TimePolicySectionConfig;
  }
  return normalized;
}

function mergePolicyConfig(
  base: TimeAttendancePolicyConfig,
  override: Partial<TimeAttendancePolicyConfig>,
): TimeAttendancePolicyConfig {
  const merged = clonePolicyConfig(base);
  for (const key of TIME_POLICY_SECTION_KEYS) {
    const section = override[key];
    if (!section) continue;
    merged[key] = { ...merged[key], ...section };
  }
  return merged;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** "+05:30", "-04:00" or "+00:00" for an offset in minutes. */
function formatOffsetMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}
