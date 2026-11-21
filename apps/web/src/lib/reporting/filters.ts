import {
  EMPLOYMENT_TYPES,
  REPORT_FILTER_KEYS,
  type CatalogReport,
  type ReportFilterKey,
  type ReportFilters,
} from './types';

/** Form state of a report's filters (every key; unsupported ones stay empty). */
export type FilterValues = Record<ReportFilterKey, string>;

/** The longest range the API accepts (apps/api reporting-domain MAX_RANGE_DAYS). */
export const MAX_RANGE_DAYS = 5 * 366;
/** Default range: the twelve months ending today (the API's default too). */
export const DEFAULT_RANGE_DAYS = 365;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Today's date (YYYY-MM-DD) in a time zone, falling back to the viewer's local date. */
export function todayIn(timezone: string | null | undefined, now = new Date()): string {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now);
      const part = (type: string) => parts.find((p) => p.type === type)?.value;
      const text = `${part('year')}-${part('month')}-${part('day')}`;
      if (DATE_ONLY.test(text)) return text;
    } catch {
      // An unknown time zone falls back to the local date.
    }
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDaysTo(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function validDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysInclusive(from: string, to: string): number {
  return (
    Math.round(
      (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
        86_400_000,
    ) + 1
  );
}

export function supports(report: Pick<CatalogReport, 'filters'>, key: ReportFilterKey): boolean {
  return report.filters.includes(key);
}

/** Defaults: the twelve months ending today, or today for as-of reports; the default grouping. */
export function defaultFilterValues(
  report: Pick<CatalogReport, 'dateMode' | 'filters' | 'defaultGroupBy' | 'groupBy'>,
  today: string,
): FilterValues {
  const values = Object.fromEntries(REPORT_FILTER_KEYS.map((key) => [key, ''])) as FilterValues;
  if (report.dateMode === 'RANGE') {
    values.to = today;
    values.from = addDaysTo(today, -(DEFAULT_RANGE_DAYS - 1));
  } else if (report.dateMode === 'AS_OF') {
    values.asOf = today;
  }
  if (supports(report, 'groupBy')) {
    values.groupBy = report.defaultGroupBy ?? report.groupBy?.[0] ?? '';
  }
  return values;
}

/** The request filters: only what the report supports, without empty values. */
export function requestFilters(
  report: Pick<CatalogReport, 'filters'>,
  values: FilterValues,
): ReportFilters {
  const filters: ReportFilters = {};
  for (const key of REPORT_FILTER_KEYS) {
    const value = values[key]?.trim();
    if (value && supports(report, key)) filters[key] = value;
  }
  return filters;
}

const ID_LABELS: Partial<Record<ReportFilterKey, string>> = {
  organizationalUnitId: 'Business unit',
  departmentId: 'Department',
  teamId: 'Team',
  positionId: 'Position',
  cycleId: 'Performance cycle',
  openingId: 'Job opening',
};

/** Client-side checks mirroring the API's (the API remains authoritative). */
export function validateFilters(
  report: Pick<CatalogReport, 'filters' | 'dateMode'>,
  filters: ReportFilters,
): string | null {
  for (const key of ['from', 'to', 'asOf'] as const) {
    const value = filters[key];
    if (value && !validDate(value)) return 'Enter dates as valid YYYY-MM-DD dates.';
  }
  if (report.dateMode === 'RANGE' && filters.from && filters.to) {
    if (filters.from > filters.to) return 'The start date must be on or before the end date.';
    if (daysInclusive(filters.from, filters.to) > MAX_RANGE_DAYS)
      return `A report may span at most ${MAX_RANGE_DAYS.toLocaleString('en-US')} days (five years).`;
  }
  for (const [key, label] of Object.entries(ID_LABELS) as Array<[ReportFilterKey, string]>) {
    const value = filters[key];
    if (value && !UUID.test(value)) return `${label} must be a valid identifier (UUID).`;
  }
  if (
    filters.employmentType &&
    !(EMPLOYMENT_TYPES as readonly string[]).includes(filters.employmentType)
  )
    return 'Choose a known employment type.';
  return null;
}
