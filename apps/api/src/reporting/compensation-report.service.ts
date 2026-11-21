import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  assignmentWhere,
  effectiveOnSql,
  groupKeySql,
  groupRows,
  money,
  num,
  sqlDate,
  type AreaReportService,
  type ReportOutput,
  type ReportScope,
} from './reporting-common.js';
import {
  monthsInRange,
  suppressSmallGroups,
  MIN_GROUP_SIZE,
} from './reporting-domain.js';

/** Bucket widths of the pay distribution, per pay basis (in the record's currency). */
export const PAY_BUCKET_WIDTH = { HOURLY: 5, SALARY: 10_000 } as const;

/**
 * Compensation reports (compensation.read), placed through the record's employment assignment.
 * The current record on a date is the unsuperseded record whose effective window contains it,
 * of an assignment effective on it. Never per-person values: distributions and averages are
 * suppressed below the minimum group size (counted in distinct employees).
 */
@Injectable()
export class CompensationReportService implements AreaReportService {
  constructor(private readonly prisma: PrismaService) {}

  run(scope: ReportScope): Promise<ReportOutput> {
    switch (scope.definition.key) {
      case 'compensation.distribution':
        return this.distribution(scope);
      case 'compensation.by_group':
        return this.byGroup(scope);
      default:
        return this.changes(scope);
    }
  }

  private current(scope: ReportScope) {
    const asOf = scope.filters.asOf!;
    return Prisma.sql`cr."organizationId" = ${scope.organizationId}::uuid
      AND cr."supersededAt" IS NULL
      AND cr."effectiveFrom" <= ${sqlDate(asOf)}
      AND (cr."effectiveTo" IS NULL OR cr."effectiveTo" >= ${sqlDate(asOf)})
      AND ${effectiveOnSql(asOf)} AND ${assignmentWhere(scope)}`;
  }

  private async distribution(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        payBasis: string;
        salaryArrangement: string | null;
        currency: string;
        bucket: string | number;
        employees: number;
      }>
    >(Prisma.sql`
      SELECT cr."payBasis"::text AS "payBasis",
        COALESCE(cr."salaryArrangement"::text, CASE WHEN cr."payBasis" = 'SALARY' THEN 'ANNUAL' END) AS "salaryArrangement",
        cr."currency",
        FLOOR(cr."rateAmount" / (CASE cr."payBasis" WHEN 'HOURLY' THEN ${PAY_BUCKET_WIDTH.HOURLY}::numeric ELSE ${PAY_BUCKET_WIDTH.SALARY}::numeric END))
          * (CASE cr."payBasis" WHEN 'HOURLY' THEN ${PAY_BUCKET_WIDTH.HOURLY}::numeric ELSE ${PAY_BUCKET_WIDTH.SALARY}::numeric END) AS bucket,
        COUNT(DISTINCT ea."employeeId")::int AS employees
      FROM "CompensationRecord" cr
      JOIN "EmploymentAssignment" ea ON ea."id" = cr."employmentAssignmentId"
      WHERE ${this.current(scope)}
      GROUP BY 1, 2, 3, 4
      ORDER BY 1, 2, 3, 4`);
    const shaped = rows.map((row) => {
      const width =
        PAY_BUCKET_WIDTH[row.payBasis as keyof typeof PAY_BUCKET_WIDTH];
      const from = num(row.bucket);
      return {
        payBasis: row.payBasis,
        currency: row.currency,
        bucketFrom: from,
        bucketTo: from + width,
        salaryArrangement: row.salaryArrangement,
        employees: row.employees,
      };
    });
    const result = suppressSmallGroups(
      shaped,
      'employees',
      ['payBasis', 'salaryArrangement', 'currency', 'bucketFrom', 'bucketTo'],
      { partition: ['payBasis', 'salaryArrangement', 'currency'] },
    );
    return {
      rows: result.rows,
      suppressed: result.suppressed,
      notes: [
        `Buckets with fewer than ${MIN_GROUP_SIZE} employees are suppressed (with one more bucket when a single one would be). Rates are as recorded (hourly rate, annual salary, monthly fixed-period salary, or contract total), never converted between currencies.`,
      ],
    };
  }

  private async byGroup(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        key: string | null;
        payBasis: string;
        salaryArrangement: string | null;
        currency: string;
        employees: number;
        average: string | number | null;
        median: string | number | null;
      }>
    >(Prisma.sql`
      SELECT ${groupKeySql(scope.filters.groupBy)} AS key,
        cr."payBasis"::text AS "payBasis",
        COALESCE(cr."salaryArrangement"::text, CASE WHEN cr."payBasis" = 'SALARY' THEN 'ANNUAL' END) AS "salaryArrangement",
        cr."currency",
        COUNT(DISTINCT ea."employeeId")::int AS employees,
        AVG(cr."rateAmount") AS average,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cr."rateAmount") AS median
      FROM "CompensationRecord" cr
      JOIN "EmploymentAssignment" ea ON ea."id" = cr."employmentAssignmentId"
      JOIN "Position" p ON p."id" = ea."positionId"
      WHERE ${this.current(scope)}
      GROUP BY 1, 2, 3, 4
      ORDER BY 2, 3, 4, 1 NULLS LAST`);
    const shaped = groupRows(scope, rows, (row) => ({
      payBasis: row.payBasis,
      salaryArrangement: row.salaryArrangement,
      currency: row.currency,
      employees: row.employees,
      averageRate: money(row.average),
      medianRate: money(row.median),
    })).sort((a, b) =>
      `${String(a.payBasis)}:${String(a.salaryArrangement)}:${String(a.currency)}`.localeCompare(
        `${String(b.payBasis)}:${String(b.salaryArrangement)}:${String(b.currency)}`,
      ),
    );
    const result = suppressSmallGroups(
      shaped,
      'employees',
      ['groupKey', 'groupLabel', 'payBasis', 'salaryArrangement', 'currency'],
      { partition: ['payBasis', 'salaryArrangement', 'currency'] },
    );
    return {
      rows: result.rows,
      suppressed: result.suppressed,
      notes: [
        `Groups with fewer than ${MIN_GROUP_SIZE} employees are suppressed. Employer compensation cost is not modelled outside payroll; see the payroll reports.`,
      ],
    };
  }

  private async changes(scope: ReportScope): Promise<ReportOutput> {
    const { from, to } = scope.filters;
    const rows = await this.prisma.$queryRaw<
      Array<{
        month: string;
        changes: number;
        corrections: number;
        assignments: number;
      }>
    >(Prisma.sql`
      SELECT to_char(cr."effectiveFrom", 'YYYY-MM') AS month,
        COUNT(*) FILTER (WHERE cr."recordType" = 'CHANGE' AND cr."supersededAt" IS NULL)::int AS changes,
        COUNT(*) FILTER (WHERE cr."recordType" = 'CORRECTION')::int AS corrections,
        COUNT(DISTINCT cr."employmentAssignmentId")
          FILTER (WHERE (cr."recordType" = 'CHANGE' AND cr."supersededAt" IS NULL) OR cr."recordType" = 'CORRECTION')::int AS assignments
      FROM "CompensationRecord" cr
      JOIN "EmploymentAssignment" ea ON ea."id" = cr."employmentAssignmentId"
      WHERE cr."organizationId" = ${scope.organizationId}::uuid
        AND cr."recordType" IN ('CHANGE', 'CORRECTION')
        AND cr."effectiveFrom" BETWEEN ${sqlDate(from!)} AND ${sqlDate(to!)}
        AND ${assignmentWhere(scope)}
      GROUP BY 1`);
    return {
      rows: monthsInRange(from!, to!).map((month) => {
        const row = rows.find((r) => r.month === month.key);
        return {
          month: month.key,
          changes: num(row?.changes),
          corrections: num(row?.corrections),
          assignments: num(row?.assignments),
        };
      }),
      notes: [
        'Counts of change records (not later corrected) and correction records by effective month; no amounts.',
      ],
    };
  }
}
