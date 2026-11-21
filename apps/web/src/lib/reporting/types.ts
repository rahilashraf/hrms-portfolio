/** Phase 17 — Reporting & Analytics API shapes (mirrors apps/api/src/reporting). */

export type ReportArea =
  | 'workforce'
  | 'time'
  | 'scheduling'
  | 'leave'
  | 'compensation'
  | 'payroll'
  | 'benefits'
  | 'performance'
  | 'recruitment'
  | 'onboarding'
  | 'offboarding'
  | 'documents';

export type ReportColumnType =
  'string' | 'integer' | 'number' | 'percent' | 'money' | 'date' | 'month' | 'boolean';

export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}

export type DateMode = 'RANGE' | 'AS_OF' | 'NONE';

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

export type GroupBy =
  'month' | 'organizationalUnit' | 'department' | 'team' | 'position' | 'employmentType';

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CASUAL', 'CONTRACT'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** An organization where the caller holds report.read. */
export interface ReportOrganization {
  id: string;
  name: string;
  code: string;
  timezone: string | null;
}

/** A report the caller can run in an organization (catalog entry). */
export interface CatalogReport {
  key: string;
  title: string;
  description: string;
  sourcePermissions: string[];
  organizationPermissions: string[];
  dateMode: DateMode;
  filters: ReportFilterKey[];
  groupBy: GroupBy[] | null;
  defaultGroupBy: GroupBy | null;
  /** Small groups are suppressed (values null, row flagged `suppressed`). */
  sensitive: boolean;
  /** The caller's own records are left out. */
  excludesSelf: boolean;
  columns: ReportColumn[];
  canExport: boolean;
}

export interface CatalogArea {
  area: ReportArea;
  reports: CatalogReport[];
}

export interface ReportCatalog {
  organizationId: string;
  /** Only areas with at least one runnable report. */
  items: CatalogArea[];
}

export interface ScopeSummary {
  organizationId: string;
  placement: 'POSITION' | 'OPENING' | 'ORGANIZATION';
  /** The whole organization is in scope and no filter narrows it. */
  organizationWide: boolean;
  scopes: Array<{ type: string; id: string | null }>;
  positions: number;
  openings: number | null;
  selfExcluded: boolean;
}

export type ReportCell = string | number | boolean | null;
export type ReportRow = Record<string, ReportCell>;

export interface ReportResult {
  reportKey: string;
  area: ReportArea;
  title: string;
  generatedAt: string;
  /** The applied filters (defaults included), as identifiers and dates. */
  filters: Record<string, string>;
  scopeSummary: ScopeSummary;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** How many rows were suppressed as small groups. */
  suppressed: number;
  notes: string[];
  /** Batch 4F (Q9): the rows were capped; never present the result as complete. */
  truncated?: boolean;
}

/** Filter values sent to the API (only the report's supported, non-empty filters). */
export type ReportFilters = Partial<Record<ReportFilterKey, string>>;

export interface CsvExport {
  fileName: string;
  blob: Blob;
  /** Batch 4F (Q9): X-Report-Truncated — the file was capped (its last line says so too). */
  truncated: boolean;
}

export interface SheetsExportResult {
  spreadsheetId: string;
  /** Batch 4F (Q9): the export was capped (its last row says so). Older APIs omit it. */
  truncated?: boolean;
}
