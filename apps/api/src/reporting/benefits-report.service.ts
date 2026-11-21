import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  assignmentWhere,
  effectiveOnSql,
  money,
  num,
  sqlDate,
  type AreaReportService,
  type ReportOutput,
  type ReportScope,
} from './reporting-common.js';
import {
  MIN_GROUP_SIZE,
  percent,
  suppressSmallGroups,
} from './reporting-domain.js';

/**
 * Benefits reports (benefit.read), placed through the sponsoring employment assignment. The
 * current election on a date is the unsuperseded election whose coverage contains it. Costs
 * are what finalized payroll actually charged (BENEFIT deduction and employer contribution
 * lines), which also needs an organization-level payroll.read.
 */
@Injectable()
export class BenefitsReportService implements AreaReportService {
  constructor(private readonly prisma: PrismaService) {}

  run(scope: ReportScope): Promise<ReportOutput> {
    return scope.definition.key === 'benefits.enrollment'
      ? this.enrollment(scope)
      : this.contributions(scope);
  }

  private async enrollment(scope: ReportScope): Promise<ReportOutput> {
    const asOf = scope.filters.asOf!;
    const [plans, elections, [headcount]] = await Promise.all([
      this.prisma.benefitPlan.findMany({
        where: {
          organizationId: scope.organizationId,
          archivedAt: null,
          status: { not: 'DRAFT' },
        },
        select: { id: true, code: true, name: true, benefitType: true },
        orderBy: [{ code: 'asc' }],
      }),
      this.prisma.$queryRaw<
        Array<{ planId: string; enrolled: number; waived: number }>
      >(Prisma.sql`
        SELECT be."planId" AS "planId",
          COUNT(DISTINCT be."employeeId") FILTER (WHERE be."electionType" = 'ENROLLED')::int AS enrolled,
          COUNT(DISTINCT be."employeeId") FILTER (WHERE be."electionType" = 'WAIVED')::int AS waived
        FROM "BenefitEnrollment" be
        JOIN "EmploymentAssignment" ea ON ea."id" = be."employmentAssignmentId"
        WHERE be."organizationId" = ${scope.organizationId}::uuid
          AND be."supersededAt" IS NULL
          AND be."coverageStart" <= ${sqlDate(asOf)}
          AND (be."coverageEnd" IS NULL OR be."coverageEnd" >= ${sqlDate(asOf)})
          AND ${assignmentWhere(scope)}
        GROUP BY 1`),
      this.prisma.$queryRaw<Array<{ headcount: number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT ea."employeeId")::int AS headcount
        FROM "EmploymentAssignment" ea
        WHERE ${assignmentWhere(scope)} AND ${effectiveOnSql(asOf)}`),
    ]);
    const total = num(headcount?.headcount);
    const shaped = plans.map((plan) => {
      const row = elections.find((e) => e.planId === plan.id);
      const enrolled = num(row?.enrolled);
      const waived = num(row?.waived);
      return {
        planCode: plan.code,
        planName: plan.name,
        benefitType: plan.benefitType,
        enrolledEmployees: enrolled,
        waivedEmployees: waived,
        headcount: total,
        participationRate: percent(enrolled, total),
        // Batch 7C (B16): a plan's elections (enrolled or waived) counted for suppression; a
        // plan nobody elected identifies nobody.
        electedEmployees:
          enrolled + waived === 0 ? MIN_GROUP_SIZE : enrolled + waived,
      };
    });
    const result = suppressSmallGroups(shaped, 'electedEmployees', [
      'planCode',
      'planName',
      'benefitType',
      'headcount',
    ]);
    return {
      rows: result.rows.map((row) => {
        const { electedEmployees: _size, ...rest } = row;
        void _size;
        return rest;
      }),
      suppressed: result.suppressed,
      notes: [
        'Participation = employees enrolled in the plan / employees with an effective in-scope assignment on the date (eligibility rules are not re-evaluated).',
        `Plans elected by fewer than ${MIN_GROUP_SIZE} employees are suppressed.`,
      ],
    };
  }

  private async contributions(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        planCode: string;
        planName: string;
        currency: string;
        employees: number;
        deductions: string | number | null;
        contributions: string | number | null;
      }>
    >(Prisma.sql`
      WITH lines AS (
        SELECT dl."benefitSnapshotId" AS snapshot, dl."payrollRunAssignmentId" AS pra, dl."amount", 'D' AS kind
        FROM "PayrollDeductionLine" dl
        WHERE dl."category" = 'BENEFIT' AND dl."benefitSnapshotId" IS NOT NULL
        UNION ALL
        SELECT cl."benefitSnapshotId", cl."payrollRunAssignmentId", cl."amount", 'C'
        FROM "PayrollEmployerContributionLine" cl
        WHERE cl."category" = 'BENEFIT' AND cl."benefitSnapshotId" IS NOT NULL
      )
      SELECT snap."planCode" AS "planCode", snap."planName" AS "planName", snap."currency",
        COUNT(DISTINCT pra."employeeId")::int AS employees,
        COALESCE(SUM(l."amount") FILTER (WHERE l.kind = 'D'), 0) AS deductions,
        COALESCE(SUM(l."amount") FILTER (WHERE l.kind = 'C'), 0) AS contributions
      FROM lines l
      JOIN "PayrollBenefitSnapshot" snap ON snap."id" = l.snapshot
      JOIN "PayrollRunAssignment" pra ON pra."id" = l.pra
      JOIN "PayrollRun" pr ON pr."id" = pra."payrollRunId"
      JOIN "PayrollPeriod" pp ON pp."id" = pr."payrollPeriodId"
      JOIN "EmploymentAssignment" ea ON ea."id" = pra."employmentAssignmentId"
      WHERE pr."organizationId" = ${scope.organizationId}::uuid
        AND pr."status" = 'FINALIZED'
        AND pp."payDate" BETWEEN ${sqlDate(scope.filters.from!)} AND ${sqlDate(scope.filters.to!)}
        AND ${assignmentWhere(scope)}
      GROUP BY snap."planId", snap."planCode", snap."planName", snap."currency"
      ORDER BY snap."planCode", snap."currency"`);
    const shaped = rows.map((row) => ({
      planCode: row.planCode,
      planName: row.planName,
      currency: row.currency,
      employees: row.employees,
      employeeDeductions: money(row.deductions),
      employerContributions: money(row.contributions),
      totalCost: money(num(row.deductions) + num(row.contributions)),
    }));
    const result = suppressSmallGroups(
      shaped,
      'employees',
      ['planCode', 'planName', 'currency'],
      { partition: ['currency'] },
    );
    return {
      rows: result.rows,
      suppressed: result.suppressed,
      notes: [
        `Amounts charged by finalized payroll paid in the range. Plans with fewer than ${MIN_GROUP_SIZE} employees are suppressed.`,
      ],
    };
  }
}
