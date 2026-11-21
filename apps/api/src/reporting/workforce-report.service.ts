import { Injectable } from '@nestjs/common';
import { formatDate } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  assignmentWhere,
  effectiveOnSql,
  groupKeySql,
  groupRows,
  num,
  type AreaReportService,
  type ReportOutput,
  type ReportScope,
} from './reporting-common.js';
import { monthsInRange, round2, turnoverRate } from './reporting-domain.js';

/**
 * Workforce reports from Core HR (employee.read): headcount = distinct employees with an
 * assignment effective on the date (not cancelled, started, not ended — Core HR's own rule),
 * hires = employees whose hire date falls in a period with an in-scope assignment effective on
 * or after it, terminations = employees whose termination date falls in a period with an
 * in-scope assignment effective on that date.
 */
@Injectable()
export class WorkforceReportService implements AreaReportService {
  constructor(private readonly prisma: PrismaService) {}

  run(scope: ReportScope): Promise<ReportOutput> {
    switch (scope.definition.key) {
      case 'workforce.headcount_trend':
        return this.trend(scope);
      case 'workforce.turnover':
        return this.turnover(scope);
      case 'workforce.distribution':
        return this.distribution(scope);
      default:
        return this.assignmentStatus(scope);
    }
  }

  /** Per window: headcount at its first and last day, hires and terminations within it. */
  private async windows(
    scope: ReportScope,
    windows: Array<{ key: string; start: Date; end: Date }>,
  ) {
    const values = Prisma.join(
      windows.map(
        (w) =>
          Prisma.sql`(${w.key}::text, ${formatDate(w.start)}::date, ${formatDate(w.end)}::date)`,
      ),
    );
    return this.prisma.$queryRaw<
      Array<{
        key: string;
        headcountStart: number;
        headcountEnd: number;
        hires: number;
        terminations: number;
      }>
    >(Prisma.sql`
      WITH windows(key, start_date, end_date) AS (VALUES ${values}),
      a AS (
        SELECT ea."employeeId", ea."startDate", ea."endDate"
        FROM "EmploymentAssignment" ea
        WHERE ${assignmentWhere(scope)} AND ea."status" <> 'CANCELLED'
      )
      SELECT w.key,
        (SELECT COUNT(DISTINCT a."employeeId") FROM a
          WHERE a."startDate" <= w.start_date AND (a."endDate" IS NULL OR a."endDate" >= w.start_date))::int AS "headcountStart",
        (SELECT COUNT(DISTINCT a."employeeId") FROM a
          WHERE a."startDate" <= w.end_date AND (a."endDate" IS NULL OR a."endDate" >= w.end_date))::int AS "headcountEnd",
        (SELECT COUNT(DISTINCT e."id") FROM "Employee" e JOIN a ON a."employeeId" = e."id"
          WHERE e."hireDate" BETWEEN w.start_date AND w.end_date
            AND a."startDate" <= w.end_date
            AND (a."endDate" IS NULL OR a."endDate" >= e."hireDate"))::int AS "hires",
        (SELECT COUNT(DISTINCT e."id") FROM "Employee" e JOIN a ON a."employeeId" = e."id"
          WHERE e."terminationDate" BETWEEN w.start_date AND w.end_date
            AND a."startDate" <= e."terminationDate"
            AND (a."endDate" IS NULL OR a."endDate" >= e."terminationDate"))::int AS "terminations"
      FROM windows w
      ORDER BY w.start_date`);
  }

  private async trend(scope: ReportScope): Promise<ReportOutput> {
    const months = monthsInRange(scope.filters.from!, scope.filters.to!);
    const rows = await this.windows(scope, months);
    return {
      rows: rows.map((row) => ({
        month: row.key,
        headcountStart: row.headcountStart,
        headcountEnd: row.headcountEnd,
        hires: row.hires,
        terminations: row.terminations,
        turnoverRate: turnoverRate(
          row.terminations,
          row.headcountStart,
          row.headcountEnd,
        ),
      })),
      notes: [
        'Headcount counts distinct employees with an effective in-scope assignment on the day; a rehire keeps the original hire date.',
      ],
    };
  }

  private async turnover(scope: ReportScope): Promise<ReportOutput> {
    const from = scope.filters.from!;
    const to = scope.filters.to!;
    const [row] = await this.windows(scope, [
      { key: 'range', start: from, end: to },
    ]);
    const start = row?.headcountStart ?? 0;
    const end = row?.headcountEnd ?? 0;
    const terminations = row?.terminations ?? 0;
    return {
      rows: [
        {
          from: formatDate(from),
          to: formatDate(to),
          headcountStart: start,
          headcountEnd: end,
          averageHeadcount: round2((start + end) / 2),
          hires: row?.hires ?? 0,
          terminations,
          turnoverRate: turnoverRate(terminations, start, end),
        },
      ],
      notes: [
        'Turnover rate = terminations / average of the opening and closing headcounts.',
      ],
    };
  }

  private async distribution(scope: ReportScope): Promise<ReportOutput> {
    const asOf = scope.filters.asOf!;
    const rows = await this.prisma.$queryRaw<
      Array<{ key: string | null; headcount: number; assignments: number }>
    >(Prisma.sql`
      SELECT ${groupKeySql(scope.filters.groupBy)} AS key,
        COUNT(DISTINCT ea."employeeId")::int AS headcount,
        COUNT(*)::int AS assignments
      FROM "EmploymentAssignment" ea
      JOIN "Position" p ON p."id" = ea."positionId"
      WHERE ${assignmentWhere(scope)} AND ${effectiveOnSql(asOf)}
      GROUP BY 1
      ORDER BY 1 NULLS LAST`);
    return {
      rows: groupRows(scope, rows, (row) => ({
        headcount: row.headcount,
        assignments: row.assignments,
      })),
      notes: [
        'An employee with assignments in several groups is counted in each of them.',
      ],
    };
  }

  private async assignmentStatus(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{ status: string; assignments: number; employees: number }>
    >(Prisma.sql`
      SELECT ea."status"::text AS status,
        COUNT(*)::int AS assignments,
        COUNT(DISTINCT ea."employeeId")::int AS employees
      FROM "EmploymentAssignment" ea
      WHERE ${assignmentWhere(scope)}
      GROUP BY 1`);
    const order = ['PLANNED', 'ACTIVE', 'ENDED', 'CANCELLED'];
    return {
      rows: order.map((status) => {
        const row = rows.find((r) => r.status === status);
        return {
          status,
          assignments: num(row?.assignments),
          employees: num(row?.employees),
        };
      }),
    };
  }
}
