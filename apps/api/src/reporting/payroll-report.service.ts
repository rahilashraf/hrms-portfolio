import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  groupKeySql,
  groupRows,
  iso,
  money,
  num,
  sqlDate,
  uuids,
  type AreaReportService,
  type ReportOutput,
  type ReportScope,
} from './reporting-common.js';
import {
  hasPlacementFilter,
  MAX_RESULT_ROWS,
  MIN_GROUP_SIZE,
  round2,
  suppressSmallGroups,
  type ReportRow,
} from './reporting-domain.js';

/** Net pay is never reported (see the class comment): rows carry this instead. */
export const NET_PAY_NOT_CALCULATED = 'Not calculated';
export const NET_PAY_NOTE =
  'Net pay is not calculated: statutory deductions (such as income tax and social insurance contributions) are not part of payroll yet. "Recorded deductions" are only the deductions payroll records (benefit, manual and adjustment lines), so "Gross less recorded deductions" is not net pay.';

/**
 * Payroll reports (organization-level payroll.read): only FINALIZED runs, dated by their
 * period's pay date. Amounts come from the runs' per-assignment results (the run totals are
 * their sums), so placement filters narrow over the paid assignment's position. Total cost =
 * gross + employer contributions.
 *
 * Net pay is never reported: payroll does not calculate statutory deductions yet, so gross less
 * the deductions payroll does record (benefit, manual and adjustment lines) is shown under its own
 * name and is not net pay.
 */
@Injectable()
export class PayrollReportService implements AreaReportService {
  constructor(private readonly prisma: PrismaService) {}

  run(scope: ReportScope): Promise<ReportOutput> {
    switch (scope.definition.key) {
      case 'payroll.period_totals':
        return this.periodTotals(scope);
      case 'payroll.register':
        return this.register(scope);
      default:
        return this.byGroup(scope);
    }
  }

  private where(scope: ReportScope) {
    return Prisma.sql`pr."organizationId" = ${scope.organizationId}::uuid
      AND pr."status" = 'FINALIZED'
      AND pp."payDate" BETWEEN ${sqlDate(scope.filters.from!)} AND ${sqlDate(scope.filters.to!)}
      AND pra."positionId" = ANY(${uuids(scope.positionIds)})
      AND (${scope.filters.employmentType}::text IS NULL OR pra."employmentType"::text = ${scope.filters.employmentType}::text)`;
  }

  private async periodTotals(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        payGroupId: string;
        payGroupCode: string;
        periodStart: Date;
        periodEnd: Date;
        payDate: Date;
        currency: string;
        runs: number;
        employees: number;
        gross: string | number | null;
        deductions: string | number | null;
        contributions: string | number | null;
      }>
    >(Prisma.sql`
      SELECT pr."payGroupId" AS "payGroupId", pg."code" AS "payGroupCode",
        pp."periodStart" AS "periodStart", pp."periodEnd" AS "periodEnd", pp."payDate" AS "payDate",
        pr."currency",
        COUNT(DISTINCT pr."id")::int AS runs,
        COUNT(DISTINCT pra."employeeId")::int AS employees,
        SUM(pra."grossAmount") AS gross,
        SUM(pra."deductionAmount") AS deductions,
        SUM(pra."employerContributionAmount") AS contributions
      FROM "PayrollRun" pr
      JOIN "PayrollPeriod" pp ON pp."id" = pr."payrollPeriodId"
      JOIN "PayGroup" pg ON pg."id" = pr."payGroupId"
      JOIN "PayrollRunAssignment" pra ON pra."payrollRunId" = pr."id"
      WHERE ${this.where(scope)}
      GROUP BY pr."payGroupId", pg."code", pp."id", pp."periodStart", pp."periodEnd", pp."payDate", pr."currency"
      ORDER BY pg."code", pr."currency", pp."payDate", pp."periodStart"`);
    let shaped: ReportRow[] = rows.map((row) => {
      const gross = num(row.gross);
      const deductions = num(row.deductions);
      const contributions = num(row.contributions);
      return {
        payGroupCode: row.payGroupCode,
        periodStart: iso(row.periodStart),
        periodEnd: iso(row.periodEnd),
        payDate: iso(row.payDate),
        currency: row.currency,
        runs: row.runs,
        employees: row.employees,
        gross: money(gross),
        deductions: money(deductions),
        employerContributions: money(contributions),
        grossLessRecordedDeductions: money(gross - deductions),
        netPay: NET_PAY_NOT_CALCULATED,
        totalCost: money(gross + contributions),
      };
    });
    let suppressed = 0;
    const notes = [
      'Only finalized runs, by pay date. Total cost = gross + employer contributions.',
      NET_PAY_NOTE,
    ];
    if (hasPlacementFilter(scope.filters)) {
      // A narrowed payroll total is a per-group breakdown: small groups are suppressed.
      const result = suppressSmallGroups(shaped, 'employees', [
        'payGroupCode',
        'periodStart',
        'periodEnd',
        'payDate',
        'currency',
      ]);
      shaped = result.rows;
      suppressed = result.suppressed;
      notes.push(
        `Narrowed periods with fewer than ${MIN_GROUP_SIZE} employees are suppressed.`,
      );
    } else {
      shaped = shaped.map((row) => ({ ...row, suppressed: false }));
    }
    // Period-over-period change within a pay group and currency (never across a suppressed row).
    let previous: ReportRow | null = null;
    for (const row of shaped) {
      const comparable =
        previous &&
        previous.payGroupCode === row.payGroupCode &&
        previous.currency === row.currency &&
        !previous.suppressed &&
        !row.suppressed;
      row.grossChange = comparable
        ? round2(num(row.gross) - num(previous!.gross))
        : null;
      row.totalCostChange = comparable
        ? round2(num(row.totalCost) - num(previous!.totalCost))
        : null;
      previous = row;
    }
    return { rows: shaped, suppressed, notes };
  }

  /**
   * Batch 6A — the payroll register: one row per finalized run and employee (the employee's paid
   * assignments in scope), by pay date, named as the run recorded them (the payslip's snapshot). Gross, recorded deductions and employer contributions are
   * the run's stored per-assignment results (the same totals the run detail and the payslip show).
   * Adjustment earnings and deductions are a breakdown of amounts ALREADY INCLUDED in gross and
   * recorded deductions (calculation sums every earning and deduction line, adjustment lines
   * included); they are never added again. Per-currency totals are computed over the whole
   * result, not only the rows shown.
   */
  private async register(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        payDate: Date;
        periodStart: Date;
        periodEnd: Date;
        payGroupCode: string;
        employeeNumber: string;
        displayName: string;
        currency: string;
        gross: string | number | null;
        deductions: string | number | null;
        adjustmentEarnings: string | number | null;
        adjustmentDeductions: string | number | null;
        contributions: string | number | null;
      }>
    >(Prisma.sql`
      WITH paid AS (
        SELECT pr."id" AS "runId", pra."payrollRunEmployeeId" AS "runEmployeeId", pr."currency",
          pp."payDate", pp."periodStart", pp."periodEnd", pg."code" AS "payGroupCode",
          SUM(pra."grossAmount") AS gross,
          SUM(pra."deductionAmount") AS deductions,
          SUM(pra."employerContributionAmount") AS contributions,
          array_agg(pra."id") AS "assignmentIds"
        FROM "PayrollRun" pr
        JOIN "PayrollPeriod" pp ON pp."id" = pr."payrollPeriodId"
        JOIN "PayGroup" pg ON pg."id" = pr."payGroupId"
        JOIN "PayrollRunAssignment" pra ON pra."payrollRunId" = pr."id"
        WHERE ${this.where(scope)}
        GROUP BY pr."id", pra."payrollRunEmployeeId", pr."currency", pp."payDate", pp."periodStart", pp."periodEnd", pg."code"
      )
      SELECT paid."payDate", paid."periodStart", paid."periodEnd", paid."payGroupCode",
        pre."employeeNumber", pre."displayName", paid."currency", paid.gross, paid.deductions, paid.contributions,
        (SELECT COALESCE(SUM(el."amount"), 0) FROM "PayrollEarningLine" el
          WHERE el."payrollRunId" = paid."runId" AND el."origin" = 'ADJUSTMENT'
            AND el."payrollRunAssignmentId" = ANY(paid."assignmentIds")) AS "adjustmentEarnings",
        (SELECT COALESCE(SUM(dl."amount"), 0) FROM "PayrollDeductionLine" dl
          WHERE dl."payrollRunId" = paid."runId" AND dl."category" = 'ADJUSTMENT'
            AND dl."payrollRunAssignmentId" = ANY(paid."assignmentIds")) AS "adjustmentDeductions"
      FROM paid
      JOIN "PayrollRunEmployee" pre ON pre."id" = paid."runEmployeeId"
      ORDER BY paid."payDate", paid."payGroupCode", paid."currency", pre."employeeNumber", paid."runId"
      LIMIT ${MAX_RESULT_ROWS + 1}`);
    const shaped: ReportRow[] = rows.map((row) => {
      const gross = num(row.gross);
      const deductions = num(row.deductions);
      return {
        payDate: iso(row.payDate),
        periodStart: iso(row.periodStart),
        periodEnd: iso(row.periodEnd),
        payGroupCode: row.payGroupCode,
        employeeNumber: row.employeeNumber,
        employeeName: row.displayName,
        currency: row.currency,
        gross: money(gross),
        deductions: money(deductions),
        adjustmentEarnings: money(num(row.adjustmentEarnings)),
        adjustmentDeductions: money(num(row.adjustmentDeductions)),
        employerContributions: money(num(row.contributions)),
        grossLessRecordedDeductions: money(gross - deductions),
        netPay: NET_PAY_NOT_CALCULATED,
      };
    });
    const totals = await this.prisma.$queryRaw<
      Array<{
        currency: string;
        gross: string | number | null;
        deductions: string | number | null;
        contributions: string | number | null;
      }>
    >(Prisma.sql`
      SELECT pr."currency",
        SUM(pra."grossAmount") AS gross,
        SUM(pra."deductionAmount") AS deductions,
        SUM(pra."employerContributionAmount") AS contributions
      FROM "PayrollRun" pr
      JOIN "PayrollPeriod" pp ON pp."id" = pr."payrollPeriodId"
      JOIN "PayrollRunAssignment" pra ON pra."payrollRunId" = pr."id"
      WHERE ${this.where(scope)}
      GROUP BY pr."currency"
      ORDER BY pr."currency"`);
    const notes = [
      'Only finalized runs, by pay date: one row per run and employee. Amounts are the finalized run results shown on the run detail and the payslip.',
      'Adjustment earnings and adjustment deductions are already included in Gross and Recorded deductions; they are shown as a breakdown and must not be added again.',
      NET_PAY_NOTE,
      ...totals.map((total) => {
        const gross = num(total.gross);
        const deductions = num(total.deductions);
        return `Totals (${total.currency}): gross ${money(gross)}, recorded deductions ${money(deductions)}, employer contributions ${money(num(total.contributions))}, gross less recorded deductions ${money(gross - deductions)}.`;
      }),
    ];
    return { rows: shaped, notes };
  }

  private async byGroup(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        key: string | null;
        currency: string;
        employees: number;
        gross: string | number | null;
        deductions: string | number | null;
        contributions: string | number | null;
      }>
    >(Prisma.sql`
      SELECT ${groupKeySql(scope.filters.groupBy, undefined, Prisma.sql`pra."employmentType"::text`)} AS key,
        pr."currency",
        COUNT(DISTINCT pra."employeeId")::int AS employees,
        SUM(pra."grossAmount") AS gross,
        SUM(pra."deductionAmount") AS deductions,
        SUM(pra."employerContributionAmount") AS contributions
      FROM "PayrollRun" pr
      JOIN "PayrollPeriod" pp ON pp."id" = pr."payrollPeriodId"
      JOIN "PayrollRunAssignment" pra ON pra."payrollRunId" = pr."id"
      JOIN "Position" p ON p."id" = pra."positionId"
      WHERE ${this.where(scope)}
      GROUP BY 1, 2
      ORDER BY 2, 1 NULLS LAST`);
    const shaped = groupRows(scope, rows, (row) => {
      const gross = num(row.gross);
      const deductions = num(row.deductions);
      const contributions = num(row.contributions);
      return {
        currency: row.currency,
        employees: row.employees,
        gross: money(gross),
        deductions: money(deductions),
        employerContributions: money(contributions),
        grossLessRecordedDeductions: money(gross - deductions),
        netPay: NET_PAY_NOT_CALCULATED,
        totalCost: money(gross + contributions),
      };
    }).sort((a, b) => String(a.currency).localeCompare(String(b.currency)));
    const result = suppressSmallGroups(
      shaped,
      'employees',
      ['groupKey', 'groupLabel', 'currency'],
      { partition: ['currency'] },
    );
    return {
      rows: result.rows,
      suppressed: result.suppressed,
      notes: [
        NET_PAY_NOTE,
        `Groups with fewer than ${MIN_GROUP_SIZE} employees are suppressed (with one more group when a single one would be). Groups follow the paid position's current placement.`,
      ],
    };
  }
}
