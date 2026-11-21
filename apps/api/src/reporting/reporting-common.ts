import { Injectable } from '@nestjs/common';
import type { AuthorizationTarget } from '../authorization/authorization.types.js';
import {
  formatDate,
  localDateOf,
  parseDateOnly,
} from '../common/domain-support.js';
import { isIanaTimezone } from '../common/timezone.js';
import type { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  MAX_RESULT_ROWS,
  type GroupBy,
  type ReportFilters,
  type ReportRow,
} from './reporting-domain.js';
import type { ReportColumn, ReportDefinition } from './reporting-registry.js';

export type ReportingClient = PrismaService | Prisma.TransactionClient;

/** The reporting clock (overridden in tests). */
@Injectable()
export class ReportingClock {
  now(): Date {
    return new Date();
  }
}

export function reportingToday(now: Date, timezone: string | null) {
  if (timezone && isIanaTimezone(timezone))
    return localDateOf(now, timezone.trim());
  return parseDateOnly(formatDate(now), 'today');
}

export interface PositionInfo {
  id: string;
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  name: string;
  code: string;
  target: AuthorizationTarget;
}

export interface OpeningInfo {
  id: string;
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  positionId: string | null;
  employmentType: string;
  hiringManagerEmployeeId: string | null;
  target: AuthorizationTarget;
}

export interface ScopeSummary {
  organizationId: string;
  placement: ReportDefinition['placement'];
  /** The whole organization is in scope and no filter narrows it. */
  organizationWide: boolean;
  /** The caller's report scopes in this organization that also hold every source permission. */
  scopes: Array<{ type: string; id: string | null }>;
  positions: number;
  openings: number | null;
  selfExcluded: boolean;
}

/** Everything a report service needs: what it may aggregate over, already authorized. */
export interface ReportScope {
  definition: ReportDefinition;
  organizationId: string;
  organizationTimezone: string | null;
  now: Date;
  today: Date;
  filters: ReportFilters;
  /** Positions inside the authorized scope after filters (POSITION and ORGANIZATION placement). */
  positionIds: string[];
  /** Openings inside the authorized scope after filters (OPENING placement). */
  openingIds: string[];
  /** The caller's own Employee, excluded when the definition says so (else null). */
  excludedEmployeeId: string | null;
  /** The caller's identity for excluding their own candidacy (recruitment). */
  self: {
    employeeId: string | null;
    personId: string | null;
    email: string | null;
  };
  /** Per position: highest readable document confidentiality rank (-1 none). Documents only. */
  documentClearance: Map<string, number>;
  labels: {
    units: Map<string, string>;
    departments: Map<string, string>;
    teams: Map<string, string>;
    positions: Map<string, string>;
  };
  summary: ScopeSummary;
}

export interface ReportResult {
  reportKey: string;
  area: string;
  title: string;
  generatedAt: string;
  filters: Record<string, string>;
  scopeSummary: ScopeSummary;
  columns: ReportColumn[];
  rows: ReportRow[];
  suppressed: number;
  notes: string[];
  /** Batch 4F (Q9): rows were capped (the notes say so; a CSV export marks it too). */
  truncated: boolean;
}

export interface ReportOutput {
  rows: ReportRow[];
  suppressed?: number;
  notes?: string[];
}

/** A report service computes one area's reports from authoritative tables, read-only. */
export interface AreaReportService {
  run(scope: ReportScope): Promise<ReportOutput>;
}

// ─── SQL fragments (parameters only; identifiers come from fixed whitelists) ───

export const uuids = (ids: readonly string[]) =>
  Prisma.sql`${[...ids]}::uuid[]`;

/** Assignment filter: inside the scope's positions, employment type, minus the caller if excluded. */
export function assignmentWhere(scope: ReportScope, alias = 'ea') {
  const a = Prisma.raw(alias);
  return Prisma.sql`${a}."positionId" = ANY(${uuids(scope.positionIds)})
    AND (${scope.filters.employmentType}::text IS NULL OR ${a}."employmentType"::text = ${scope.filters.employmentType}::text)
    AND (${scope.excludedEmployeeId}::uuid IS NULL OR ${a}."employeeId" <> ${scope.excludedEmployeeId}::uuid)`;
}

/** The SQL group key of a groupBy (assignment alias `ea`, position alias `p`). */
export function groupKeySql(
  groupBy: GroupBy | null,
  dateExpression: Prisma.Sql = Prisma.sql`NULL::date`,
  employmentTypeExpression: Prisma.Sql = Prisma.sql`ea."employmentType"::text`,
) {
  switch (groupBy) {
    case 'month':
      return Prisma.sql`to_char(${dateExpression}, 'YYYY-MM')`;
    case 'organizationalUnit':
      return Prisma.sql`p."organizationalUnitId"::text`;
    case 'department':
      return Prisma.sql`p."departmentId"::text`;
    case 'team':
      return Prisma.sql`p."teamId"::text`;
    case 'position':
      return Prisma.sql`p."id"::text`;
    case 'employmentType':
      return employmentTypeExpression;
    default:
      return Prisma.sql`'ALL'::text`;
  }
}

export function groupLabel(
  scope: ReportScope,
  groupBy: GroupBy | null,
  key: string | null,
) {
  if (groupBy === 'month' || groupBy === 'employmentType' || !groupBy)
    return key ?? '(none)';
  const map =
    groupBy === 'organizationalUnit'
      ? scope.labels.units
      : groupBy === 'department'
        ? scope.labels.departments
        : groupBy === 'team'
          ? scope.labels.teams
          : scope.labels.positions;
  if (!key) {
    return groupBy === 'organizationalUnit'
      ? '(No unit)'
      : groupBy === 'department'
        ? '(No department)'
        : groupBy === 'team'
          ? '(No team)'
          : '(none)';
  }
  return map.get(key) ?? key;
}

export const num = (value: unknown) =>
  value === null || value === undefined ? 0 : Number(value);

export const nullableNum = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

export const money = (value: unknown) =>
  value === null || value === undefined
    ? null
    : Math.round(Number(value) * 100) / 100;

export const iso = (value: Date | null | undefined) =>
  value ? formatDate(value) : null;

/** Caps a result; a capped result says so. */
export function capRows(rows: ReportRow[], notes: string[]) {
  if (rows.length <= MAX_RESULT_ROWS) return rows;
  notes.push(
    `The result was capped at ${MAX_RESULT_ROWS} rows; narrow the filters to see the rest.`,
  );
  return rows.slice(0, MAX_RESULT_ROWS);
}

/** The organization-local calendar date of a timestamptz expression. */
export function localDateSql(scope: ReportScope, expression: Prisma.Sql) {
  const timezone =
    scope.organizationTimezone && isIanaTimezone(scope.organizationTimezone)
      ? scope.organizationTimezone.trim()
      : 'UTC';
  return Prisma.sql`(${expression} AT TIME ZONE ${timezone}::text)::date`;
}

/** Effective on a date, as Core HR defines it: not cancelled, started, not yet ended. */
export function effectiveOnSql(date: Date, alias = 'ea') {
  const a = Prisma.raw(alias);
  return Prisma.sql`${a}."status" <> 'CANCELLED' AND ${a}."startDate" <= ${sqlDate(date)} AND (${a}."endDate" IS NULL OR ${a}."endDate" >= ${sqlDate(date)})`;
}

/** A date-only value as a SQL date parameter (a string: never shifted by the session time zone). */
export function sqlDate(date: Date) {
  return Prisma.sql`${formatDate(date)}::date`;
}

/**
 * Report rows from grouped SQL rows: labelled groups in a stable order — months by key,
 * structural groups by name, the "none" group last.
 */
export function groupRows<T extends { key: string | null }>(
  scope: ReportScope,
  rows: readonly T[],
  map: (row: T) => ReportRow,
) {
  const groupBy = scope.filters.groupBy;
  const shaped: ReportRow[] = rows.map((row) => ({
    groupKey: row.key,
    groupLabel: groupLabel(scope, groupBy, row.key),
    ...map(row),
  }));
  const sortKey = (row: ReportRow) =>
    String(
      (groupBy === 'month' || groupBy === 'employmentType'
        ? row.groupKey
        : row.groupLabel) ?? '',
    );
  return shaped.sort((a, b) =>
    a.groupKey === null && b.groupKey !== null
      ? 1
      : b.groupKey === null && a.groupKey !== null
        ? -1
        : sortKey(a).localeCompare(sortKey(b)),
  );
}
