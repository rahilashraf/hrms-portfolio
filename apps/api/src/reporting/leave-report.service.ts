import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  assignmentWhere,
  effectiveOnSql,
  localDateSql,
  num,
  sqlDate,
  type AreaReportService,
  type ReportOutput,
  type ReportScope,
} from './reporting-common.js';
import { round2 } from './reporting-domain.js';

/**
 * Leave reports (leave.read), placed through the request's / account's employment assignment.
 * Usage is the approved request days not cancelled by an amendment; balances follow the
 * ledger's own semantics (net entries effective on or before the date — no stored balance).
 */
@Injectable()
export class LeaveReportService implements AreaReportService {
  constructor(private readonly prisma: PrismaService) {}

  run(scope: ReportScope): Promise<ReportOutput> {
    switch (scope.definition.key) {
      case 'leave.usage':
        return this.usage(scope);
      case 'leave.balances':
        return this.balances(scope);
      default:
        return this.requests(scope);
    }
  }

  private async usage(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        month: string;
        code: string;
        name: string;
        classification: string;
        days: number;
        minutes: bigint | number;
        employees: number;
      }>
    >(Prisma.sql`
      SELECT to_char(d."date", 'YYYY-MM') AS month, lt."code", lt."name",
        lt."classification"::text AS classification,
        COUNT(*)::int AS days,
        SUM(d."minutes") AS minutes,
        COUNT(DISTINCT lr."employeeId")::int AS employees
      FROM "LeaveRequestDay" d
      JOIN "LeaveRequest" lr ON lr."id" = d."requestId"
      JOIN "LeaveType" lt ON lt."id" = lr."leaveTypeId"
      JOIN "EmploymentAssignment" ea ON ea."id" = lr."employmentAssignmentId"
      WHERE lr."status" = 'APPROVED' AND d."cancelledByAmendmentId" IS NULL
        AND d."minutes" > 0
        AND d."date" BETWEEN ${sqlDate(scope.filters.from!)} AND ${sqlDate(scope.filters.to!)}
        AND ${assignmentWhere(scope)}
      GROUP BY 1, lt."id", lt."code", lt."name", lt."classification"
      ORDER BY 1, lt."code"`);
    return {
      rows: rows.map((row) => ({
        month: row.month,
        leaveTypeCode: row.code,
        leaveTypeName: row.name,
        classification: row.classification,
        days: row.days,
        minutes: num(row.minutes),
        hours: round2(num(row.minutes) / 60),
        employees: row.employees,
      })),
      notes: [
        'Approved leave days with time off (holidays and non-workdays excluded), minus days cancelled by an amendment.',
      ],
    };
  }

  private async balances(scope: ReportScope): Promise<ReportOutput> {
    const asOf = scope.filters.asOf!;
    const rows = await this.prisma.$queryRaw<
      Array<{
        code: string;
        name: string;
        accounts: number;
        total: bigint | number | null;
      }>
    >(Prisma.sql`
      SELECT lt."code", lt."name", COUNT(*)::int AS accounts,
        SUM(balance.minutes) AS total
      FROM "LeaveAccount" la
      JOIN "LeaveType" lt ON lt."id" = la."leaveTypeId"
      JOIN "EmploymentAssignment" ea ON ea."id" = la."employmentAssignmentId"
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(le."amountMinutes"), 0) AS minutes
        FROM "LeaveLedgerEntry" le
        WHERE le."accountId" = la."id" AND le."effectiveDate" <= ${sqlDate(asOf)}
      ) balance
      WHERE lt."tracksBalance" AND ${effectiveOnSql(asOf)} AND ${assignmentWhere(scope)}
      GROUP BY lt."id", lt."code", lt."name"
      ORDER BY lt."code"`);
    return {
      rows: rows.map((row) => {
        const total = num(row.total);
        return {
          leaveTypeCode: row.code,
          leaveTypeName: row.name,
          accounts: row.accounts,
          totalMinutes: total,
          averageMinutes: row.accounts ? round2(total / row.accounts) : null,
          totalHours: round2(total / 60),
        };
      }),
      notes: [
        'Balance = net ledger entries effective on or before the date, for accounts of assignments effective on it.',
      ],
    };
  }

  private async requests(scope: ReportScope): Promise<ReportOutput> {
    const submitted = localDateSql(scope, Prisma.sql`lr."submittedAt"`);
    const rows = await this.prisma.$queryRaw<
      Array<{ code: string; name: string; status: string; count: number }>
    >(Prisma.sql`
      SELECT lt."code", lt."name", lr."status"::text AS status, COUNT(*)::int AS count
      FROM "LeaveRequest" lr
      JOIN "LeaveType" lt ON lt."id" = lr."leaveTypeId"
      JOIN "EmploymentAssignment" ea ON ea."id" = lr."employmentAssignmentId"
      WHERE ${submitted} BETWEEN ${sqlDate(scope.filters.from!)} AND ${sqlDate(scope.filters.to!)}
        AND ${assignmentWhere(scope)}
      GROUP BY lt."id", lt."code", lt."name", 3`);
    const types = [
      ...new Map(rows.map((r) => [r.code, r.name])).entries(),
    ].sort(([a], [b]) => a.localeCompare(b));
    return {
      rows: types.map(([code, name]) => {
        const of = (status: string) =>
          num(rows.find((r) => r.code === code && r.status === status)?.count);
        const values = {
          pending: of('PENDING'),
          approved: of('APPROVED'),
          rejected: of('REJECTED'),
          cancelled: of('CANCELLED'),
        };
        return {
          leaveTypeCode: code,
          leaveTypeName: name,
          total: Object.values(values).reduce((a, b) => a + b, 0),
          ...values,
        };
      }),
    };
  }
}
