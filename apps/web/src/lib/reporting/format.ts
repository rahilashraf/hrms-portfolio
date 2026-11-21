import type {
  EmploymentType,
  GroupBy,
  ReportArea,
  ReportColumn,
  ReportColumnType,
  ReportRow,
} from './types';

/** The minimum group size of sensitive reports (apps/api reporting-domain MIN_GROUP_SIZE). */
export const MIN_GROUP_SIZE = 5;
export const SUPPRESSED_TEXT = `Suppressed (fewer than ${MIN_GROUP_SIZE})`;
export const SUPPRESSED_EXPLANATION = `This group has fewer than ${MIN_GROUP_SIZE} people, so its values are hidden to protect privacy. A second small group may also be hidden so the first cannot be worked out from a total.`;

export const AREA_LABELS: Record<ReportArea, string> = {
  workforce: 'Workforce',
  time: 'Time & attendance',
  scheduling: 'Scheduling',
  leave: 'Leave',
  compensation: 'Compensation',
  payroll: 'Payroll',
  benefits: 'Benefits',
  performance: 'Performance',
  recruitment: 'Recruitment',
  onboarding: 'Onboarding',
  offboarding: 'Offboarding',
  documents: 'Documents',
};

export const GROUP_BY_LABELS: Record<GroupBy, string> = {
  month: 'Month',
  organizationalUnit: 'Business unit',
  department: 'Department',
  team: 'Team',
  position: 'Position',
  employmentType: 'Employment type',
};

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  FULL_TIME: 'Full time',
  PART_TIME: 'Part time',
  CASUAL: 'Casual',
  CONTRACT: 'Contract',
};

const NUMERIC_TYPES: readonly ReportColumnType[] = ['integer', 'number', 'percent', 'money'];

export function isNumericColumn(column: Pick<ReportColumn, 'type'>): boolean {
  return NUMERIC_TYPES.includes(column.type);
}

const integerFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const moneyFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const monthFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Whether a cell is hidden by small-group suppression (null in a suppressed row). */
export function isSuppressedCell(row: ReportRow, column: Pick<ReportColumn, 'key'>): boolean {
  return row.suppressed === true && (row[column.key] === null || row[column.key] === undefined);
}

function toNumber(value: string | number | boolean): number | null {
  if (typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/** A report value for display, by column type. */
export function formatValue(
  type: ReportColumnType,
  value: string | number | boolean | null | undefined,
  currency?: string | null,
): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (type) {
    case 'integer': {
      const number = toNumber(value);
      return number === null ? String(value) : integerFormat.format(number);
    }
    case 'number': {
      const number = toNumber(value);
      return number === null ? String(value) : numberFormat.format(number);
    }
    case 'percent': {
      const number = toNumber(value);
      return number === null ? String(value) : `${numberFormat.format(number)}%`;
    }
    case 'money': {
      const number = toNumber(value);
      if (number === null) return String(value);
      const amount = moneyFormat.format(number);
      return currency ? `${currency} ${amount}` : amount;
    }
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return String(value);
      const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
      return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
    }
    case 'month': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) return String(value);
      const date = new Date(`${value}-01T00:00:00Z`);
      return Number.isNaN(date.getTime()) ? value : monthFormat.format(date);
    }
    case 'boolean':
      return value === true ? 'Yes' : value === false ? 'No' : String(value);
    default:
      return String(value);
  }
}

/** A row's currency (from its `currency` column), used to label money cells. */
export function rowCurrency(row: ReportRow): string | null {
  const currency = row.currency;
  return typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : null;
}

/** A cell for display: suppressed cells read SUPPRESSED_TEXT; money carries the row's currency. */
export function formatCell(column: ReportColumn, row: ReportRow): string {
  if (isSuppressedCell(row, column)) return SUPPRESSED_TEXT;
  return formatValue(column.type, row[column.key], rowCurrency(row));
}

/** The table's columns: the group key (an identifier) is left out when a group label exists. */
export function visibleColumns(columns: readonly ReportColumn[]): ReportColumn[] {
  const hasLabel = columns.some((column) => column.key === 'groupLabel');
  return columns.filter((column) => !(hasLabel && column.key === 'groupKey'));
}

export interface ChartSpec {
  column: ReportColumn;
  labelColumns: ReportColumn[];
  bars: Array<{ label: string; value: number | null; text: string; suppressed: boolean }>;
  max: number;
}

const MAX_CHART_ROWS = 40;

/**
 * A simple bar visualization of one count-like column, when it helps: 2–40 rows, a label to
 * show and at least one positive value. Integer counts are preferred over rates and money;
 * identifier-like columns (codes, rating values) are never charted.
 */
export function chartSpec(
  columns: readonly ReportColumn[],
  rows: readonly ReportRow[],
): ChartSpec | null {
  if (rows.length < 2 || rows.length > MAX_CHART_ROWS) return null;
  const candidates = columns.filter(
    (column) =>
      isNumericColumn(column) &&
      !/(Value|Code|Change|From|To)$/.test(column.key) &&
      !['bucketFrom', 'bucketTo'].includes(column.key),
  );
  const column =
    candidates.find((candidate) => candidate.type === 'integer') ??
    candidates.find((candidate) => candidate.type !== 'money') ??
    candidates[0];
  if (!column) return null;
  const textColumns = visibleColumns(columns).filter(
    (candidate) =>
      ['string', 'month', 'date'].includes(candidate.type) && !/Code$/.test(candidate.key),
  );
  // A text column with the same value on every row (one currency, a payroll report's "Net pay:
  // Not calculated") tells the bars apart no better than nothing, and would read as if it
  // described the charted value; it labels bars only when nothing else does.
  const varying = textColumns.filter((candidate) =>
    rows.some((row) => row[candidate.key] !== rows[0]![candidate.key]),
  );
  const labelColumns = varying.length > 0 ? varying : textColumns;
  const bucketColumns = columns.filter((candidate) =>
    ['bucketFrom', 'bucketTo'].includes(candidate.key),
  );
  if (labelColumns.length === 0 && bucketColumns.length === 0) return null;
  const bars = rows.map((row) => {
    const raw = row[column.key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    const parts = [...labelColumns, ...bucketColumns].map((labelColumn) =>
      formatCell(labelColumn, row),
    );
    return {
      label: parts.join(' · ') || '—',
      value,
      text: formatCell(column, row),
      suppressed: isSuppressedCell(row, column),
    };
  });
  const max = Math.max(0, ...bars.map((bar) => bar.value ?? 0));
  if (max <= 0) return null;
  return { column, labelColumns, bars, max };
}

/** "Oct 6, 2026, 9:30 AM" in the viewer's time zone. */
export function generatedAtText(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
