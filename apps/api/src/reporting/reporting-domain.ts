import { BadRequestException } from '@nestjs/common';
import {
  addDays,
  daysBetweenInclusive,
  domainError,
  formatDate,
  parseDateOnly,
} from '../common/domain-support.js';

/**
 * Phase 17 — pure reporting rules: filter parsing and limits, month math, small-group
 * suppression, ratios and medians, and CSV encoding (RFC 4180 quoting plus spreadsheet
 * formula-injection neutralization). No database access here.
 */

/** Groups (buckets, departments, periods…) smaller than this are suppressed in sensitive reports. */
export const MIN_GROUP_SIZE = 5;
/** The longest date range a report may span (five years). */
export const MAX_RANGE_DAYS = 5 * 366;
/** Default range when none is given: the twelve months ending today. */
export const DEFAULT_RANGE_DAYS = 365;
/** Results are capped; a capped result says so in its notes. */
export const MAX_RESULT_ROWS = 5_000;

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CASUAL',
  'CONTRACT',
] as const;
export type EmploymentTypeValue = (typeof EMPLOYMENT_TYPES)[number];

export const GROUP_BY_VALUES = [
  'month',
  'organizationalUnit',
  'department',
  'team',
  'position',
  'employmentType',
] as const;
export type GroupBy = (typeof GROUP_BY_VALUES)[number];

export const REPORT_FILTER_KEYS = [
  'from',
  'to',
  'asOf',
  'organizationalUnitId',
  'departmentId',
  'teamId',
  'positionId',
  'employmentType',
  'groupBy',
  'cycleId',
  'openingId',
] as const;
export type ReportFilterKey = (typeof REPORT_FILTER_KEYS)[number];

export type DateMode = 'RANGE' | 'AS_OF' | 'NONE';

export interface RawReportFilters {
  from?: string;
  to?: string;
  asOf?: string;
  organizationalUnitId?: string;
  departmentId?: string;
  teamId?: string;
  positionId?: string;
  employmentType?: string;
  groupBy?: string;
  cycleId?: string;
  openingId?: string;
}

export interface ReportFilters {
  from: Date | null;
  to: Date | null;
  asOf: Date | null;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  positionId: string | null;
  employmentType: EmploymentTypeValue | null;
  groupBy: GroupBy | null;
  cycleId: string | null;
  openingId: string | null;
}

export interface FilterSpec {
  dateMode: DateMode;
  filters: readonly ReportFilterKey[];
  groupBy?: readonly GroupBy[];
  defaultGroupBy?: GroupBy;
}

export function invalidFilter(code: string, message: string) {
  return new BadRequestException(domainError(400, code, message));
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates a report's filters against its definition: only supported filters may be given,
 * dates are strict YYYY-MM-DD, `from` ≤ `to`, the range spans at most MAX_RANGE_DAYS and stays
 * within MAX_RANGE_DAYS of today. Defaults: the twelve months ending today, or today for as-of
 * reports.
 */
export function parseReportFilters(
  spec: FilterSpec,
  raw: RawReportFilters,
  today: Date,
): ReportFilters {
  for (const key of REPORT_FILTER_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') continue;
    if (!spec.filters.includes(key)) {
      throw invalidFilter(
        'REPORT_FILTER_UNSUPPORTED',
        `This report does not support the ${key} filter.`,
      );
    }
  }
  const id = (key: ReportFilterKey) => {
    const value = raw[key];
    if (value === undefined || value === '') return null;
    if (!UUID.test(value))
      throw invalidFilter('REPORT_FILTER_INVALID', `${key} must be a UUID.`);
    return value.toLowerCase();
  };
  const date = (key: 'from' | 'to' | 'asOf') => {
    const value = raw[key];
    if (value === undefined || value === '') return null;
    try {
      return parseDateOnly(value, key);
    } catch {
      throw invalidFilter(
        'REPORT_FILTER_INVALID',
        `${key} must be a valid YYYY-MM-DD date.`,
      );
    }
  };

  let from: Date | null = null;
  let to: Date | null = null;
  let asOf: Date | null = null;
  if (spec.dateMode === 'RANGE') {
    to = date('to') ?? today;
    from = date('from') ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
    if (from > to)
      throw invalidFilter(
        'REPORT_RANGE_INVALID',
        'from must be on or before to.',
      );
    if (daysBetweenInclusive(from, to) > MAX_RANGE_DAYS)
      throw invalidFilter(
        'REPORT_RANGE_TOO_LONG',
        `A report may span at most ${MAX_RANGE_DAYS} days.`,
      );
  } else if (spec.dateMode === 'AS_OF') {
    asOf = date('asOf') ?? today;
    if (daysBetweenInclusive(asOf, today) > MAX_RANGE_DAYS)
      throw invalidFilter(
        'REPORT_RANGE_TOO_LONG',
        `asOf may be at most ${MAX_RANGE_DAYS} days in the past.`,
      );
  }
  if (asOf && asOf > addDays(today, MAX_RANGE_DAYS))
    throw invalidFilter('REPORT_RANGE_TOO_LONG', 'asOf is too far ahead.');
  if (to && to > addDays(today, MAX_RANGE_DAYS))
    throw invalidFilter('REPORT_RANGE_TOO_LONG', 'to is too far ahead.');

  const employmentType = raw.employmentType || null;
  if (
    employmentType &&
    !(EMPLOYMENT_TYPES as readonly string[]).includes(employmentType)
  ) {
    throw invalidFilter(
      'REPORT_FILTER_INVALID',
      'employmentType is not a known employment type.',
    );
  }
  let groupBy: GroupBy | null = null;
  if (spec.groupBy) {
    const value = raw.groupBy || spec.defaultGroupBy || spec.groupBy[0]!;
    if (!(spec.groupBy as readonly string[]).includes(value)) {
      throw invalidFilter(
        'REPORT_FILTER_INVALID',
        `groupBy must be one of: ${spec.groupBy.join(', ')}.`,
      );
    }
    groupBy = value as GroupBy;
  }
  return {
    from,
    to,
    asOf,
    organizationalUnitId: id('organizationalUnitId'),
    departmentId: id('departmentId'),
    teamId: id('teamId'),
    positionId: id('positionId'),
    employmentType: employmentType as EmploymentTypeValue | null,
    groupBy,
    cycleId: id('cycleId'),
    openingId: id('openingId'),
  };
}

/** The filters as echoed in a result or an audit record (identifiers and dates only). */
export function describeFilters(filters: ReportFilters) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === null) continue;
    out[key] = value instanceof Date ? formatDate(value) : String(value);
  }
  return out;
}

export function hasPlacementFilter(filters: ReportFilters) {
  return Boolean(
    filters.organizationalUnitId ||
    filters.departmentId ||
    filters.teamId ||
    filters.positionId ||
    filters.employmentType,
  );
}

// ─── Month math (date-only values, UTC midnight) ────────────────────────────

export function monthStart(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function addMonths(date: Date, months: number) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
}

export function monthEnd(date: Date) {
  return addDays(addMonths(date, 1), -1);
}

export function monthKey(date: Date) {
  return formatDate(date).slice(0, 7);
}

/** Calendar months overlapping [from, to], each clipped to the range. */
export function monthsInRange(from: Date, to: Date) {
  const months: Array<{ key: string; start: Date; end: Date }> = [];
  for (let month = monthStart(from); month <= to; month = addMonths(month, 1)) {
    const start = month < from ? from : month;
    const end = monthEnd(month) > to ? to : monthEnd(month);
    months.push({ key: monthKey(month), start, end });
  }
  return months;
}

// ─── Ratios, medians, suppression ───────────────────────────────────────────

/** A percentage with two decimals, or null when the denominator is zero. */
export function percent(numerator: number, denominator: number) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

export function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export function median(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Turnover: terminations over the average of the opening and closing headcounts. */
export function turnoverRate(
  terminations: number,
  headcountStart: number,
  headcountEnd: number,
) {
  return percent(terminations, (headcountStart + headcountEnd) / 2);
}

export type ReportRow = Record<string, string | number | boolean | null>;

/**
 * Small-group suppression: a row whose population (`sizeKey`) is below MIN_GROUP_SIZE keeps
 * only its identifying columns (`keep`); every other value becomes null and the row is
 * flagged `suppressed: true`. Complementary suppression: when exactly one row of a partition
 * (rows sharing the `partition` columns) would be suppressed, the next smallest row of that
 * partition is suppressed too, so the hidden value cannot be derived from a known total.
 */
export function suppressSmallGroups(
  rows: readonly ReportRow[],
  sizeKey: string,
  keep: readonly string[],
  options: { partition?: readonly string[]; minimum?: number } = {},
) {
  const minimum = options.minimum ?? MIN_GROUP_SIZE;
  const size = (row: ReportRow) =>
    typeof row[sizeKey] === 'number' ? (row[sizeKey] as number) : 0;
  const hide = new Set<number>();
  rows.forEach((row, index) => {
    if (size(row) < minimum) hide.add(index);
  });
  if (options.partition) {
    const partitions = new Map<string, number[]>();
    rows.forEach((row, index) => {
      const key = JSON.stringify(options.partition!.map((k) => row[k]));
      partitions.set(key, [...(partitions.get(key) ?? []), index]);
    });
    for (const members of partitions.values()) {
      const hidden = members.filter((index) => hide.has(index));
      const shown = members.filter((index) => !hide.has(index));
      if (hidden.length === 1 && shown.length > 0) {
        shown.sort((a, b) => size(rows[a]!) - size(rows[b]!));
        hide.add(shown[0]!);
      }
    }
  }
  const out = rows.map((row, index) => {
    if (!hide.has(index)) return { ...row, suppressed: false };
    const masked: ReportRow = {};
    for (const [key, value] of Object.entries(row))
      masked[key] = keep.includes(key) ? value : null;
    masked.suppressed = true;
    return masked;
  });
  return { rows: out, suppressed: hide.size };
}

/** Fixed-width bucket of a pay rate: [floor(rate / width) * width, + width). */
export function bucketOf(rate: number, width: number) {
  const from = Math.floor(rate / width) * width;
  return { from, to: from + width };
}

// ─── CSV ────────────────────────────────────────────────────────────────────

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Neutralizes spreadsheet formula injection: a text cell starting with = + - @, a tab or a
 * carriage return is prefixed with a single quote so spreadsheet software treats it as text.
 * Numbers are emitted as numbers (a negative number is not a formula).
 */
export function neutralizeFormula(value: string) {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

/** One RFC 4180 field: quoted when it holds a comma, quote, CR or LF; quotes doubled. */
export function csvField(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'string' ? neutralizeFormula(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180 CSV with CRLF line breaks and a header row of column labels. */
export function toCsv(
  columns: ReadonlyArray<{ key: string; label: string }>,
  rows: readonly ReportRow[],
  /** Batch 4F (Q9): a capped export says so in the file itself, never looking complete. */
  truncationNote?: string | null,
) {
  const lines = [columns.map((column) => csvField(column.label)).join(',')];
  for (const row of rows)
    lines.push(columns.map((column) => csvField(row[column.key])).join(','));
  if (truncationNote) lines.push(csvField(`TRUNCATED: ${truncationNote}`));
  return `${lines.join('\r\n')}\r\n`;
}

/** A safe download file name: report key and date, [a-z0-9._-] only. */
export function exportFileName(reportKey: string, generatedAt: Date) {
  const base = reportKey
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${base || 'report'}-${formatDate(generatedAt)}.csv`;
}
