import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  assignmentWhere,
  groupKeySql,
  groupRows,
  localDateSql,
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
 * Performance reports (performance.read), placed through the reviewed / goal assignment (and,
 * for evidence, any of the employee's assignments, as the evidence domain reads it). The
 * caller's own reviews, goals and evidence are left out: performance.read never covers them.
 * Ratings and assessment results are suppressed below the minimum group size.
 */
@Injectable()
export class PerformanceReportService implements AreaReportService {
  constructor(private readonly prisma: PrismaService) {}

  run(scope: ReportScope): Promise<ReportOutput> {
    switch (scope.definition.key) {
      case 'performance.cycle_completion':
        return this.completion(scope);
      case 'performance.rating_distribution':
        return this.ratings(scope);
      case 'performance.goals':
        return this.goals(scope);
      default:
        return this.evidence(scope);
    }
  }

  /** Cycles of the organization overlapping the range (or the one filtered). */
  private cycles(scope: ReportScope) {
    const { from, to, cycleId } = scope.filters;
    return Prisma.sql`c."organizationId" = ${scope.organizationId}::uuid
      AND (${cycleId}::uuid IS NULL OR c."id" = ${cycleId}::uuid)
      AND c."periodStart" <= ${sqlDate(to!)} AND c."periodEnd" >= ${sqlDate(from!)}`;
  }

  private async completion(scope: ReportScope): Promise<ReportOutput> {
    const today = sqlDate(scope.today);
    const rows = await this.prisma.$queryRaw<
      Array<{
        code: string;
        name: string;
        status: string;
        reviews: number;
        completed: number;
        selfSubmitted: number;
        reviewerSubmitted: number;
        acknowledged: number;
        overdueSelf: number;
        overdueReviewer: number;
      }>
    >(Prisma.sql`
      SELECT c."code", c."name", c."status"::text AS status,
        COUNT(*)::int AS reviews,
        COUNT(*) FILTER (WHERE r."finalizedAt" IS NOT NULL)::int AS completed,
        COUNT(*) FILTER (WHERE r."selfStatus" = 'SUBMITTED')::int AS "selfSubmitted",
        COUNT(*) FILTER (WHERE r."reviewerStatus" = 'SUBMITTED')::int AS "reviewerSubmitted",
        COUNT(*) FILTER (WHERE r."acknowledgedAt" IS NOT NULL)::int AS acknowledged,
        COUNT(*) FILTER (WHERE c."status" = 'OPEN' AND r."selfStatus" IN ('NOT_STARTED', 'IN_PROGRESS')
          AND c."selfReviewDueDate" < ${today})::int AS "overdueSelf",
        COUNT(*) FILTER (WHERE c."status" = 'OPEN' AND r."reviewerStatus" IN ('NOT_STARTED', 'IN_PROGRESS')
          AND c."reviewerDueDate" < ${today})::int AS "overdueReviewer"
      FROM "PerformanceCycle" c
      JOIN "PerformanceReview" r ON r."cycleId" = c."id"
      JOIN "EmploymentAssignment" ea ON ea."id" = r."employmentAssignmentId"
      WHERE ${this.cycles(scope)} AND ${assignmentWhere(scope)}
      GROUP BY c."id", c."code", c."name", c."status", c."periodStart"
      ORDER BY c."periodStart", c."code"`);
    return {
      rows: rows.map((row) => ({
        cycleCode: row.code,
        cycleName: row.name,
        cycleStatus: row.status,
        reviews: row.reviews,
        completed: row.completed,
        completionRate: percent(row.completed, row.reviews),
        selfSubmitted: row.selfSubmitted,
        reviewerSubmitted: row.reviewerSubmitted,
        acknowledged: row.acknowledged,
        overdueSelf: row.overdueSelf,
        overdueReviewer: row.overdueReviewer,
      })),
      notes: [
        'A review is completed once finalized. Overdue parts are unsubmitted parts of open cycles past their due date.',
      ],
    };
  }

  private async ratings(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        code: string;
        name: string;
        value: number;
        label: string | null;
        reviews: number;
      }>
    >(Prisma.sql`
      SELECT c."code", c."name", r."overallRatingValue" AS value,
        MAX(r."overallRatingLabel") AS label,
        COUNT(DISTINCT r."employeeId")::int AS reviews
      FROM "PerformanceCycle" c
      JOIN "PerformanceReview" r ON r."cycleId" = c."id"
      JOIN "EmploymentAssignment" ea ON ea."id" = r."employmentAssignmentId"
      WHERE ${this.cycles(scope)} AND ${assignmentWhere(scope)}
        AND r."finalizedAt" IS NOT NULL AND r."overallRatingValue" IS NOT NULL
      GROUP BY c."id", c."code", c."name", c."periodStart", r."overallRatingValue"
      ORDER BY c."periodStart", c."code", r."overallRatingValue"`);
    const result = suppressSmallGroups(
      rows.map((row) => ({
        cycleCode: row.code,
        cycleName: row.name,
        ratingValue: row.value,
        ratingLabel: row.label,
        reviews: row.reviews,
      })),
      'reviews',
      ['cycleCode', 'cycleName', 'ratingValue', 'ratingLabel'],
      { partition: ['cycleCode'] },
    );
    return {
      rows: result.rows,
      suppressed: result.suppressed,
      notes: [
        `Overall ratings of finalized reviews. Ratings held by fewer than ${MIN_GROUP_SIZE} employees are suppressed (with one more rating when a single one would be).`,
      ],
    };
  }

  private async goals(scope: ReportScope): Promise<ReportOutput> {
    const { from, to } = scope.filters;
    const rows = await this.prisma.$queryRaw<
      Array<{
        key: string | null;
        goals: number;
        notStarted: number;
        inProgress: number;
        completed: number;
        cancelled: number;
        overdue: number;
      }>
    >(Prisma.sql`
      SELECT ${groupKeySql(scope.filters.groupBy)} AS key,
        COUNT(*)::int AS goals,
        COUNT(*) FILTER (WHERE g."status" = 'NOT_STARTED')::int AS "notStarted",
        COUNT(*) FILTER (WHERE g."status" = 'IN_PROGRESS')::int AS "inProgress",
        COUNT(*) FILTER (WHERE g."status" = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (WHERE g."status" = 'CANCELLED')::int AS cancelled,
        COUNT(*) FILTER (WHERE g."status" IN ('NOT_STARTED', 'IN_PROGRESS')
          AND g."dueDate" < ${sqlDate(scope.today)})::int AS overdue
      FROM "PerformanceGoal" g
      JOIN "EmploymentAssignment" ea ON ea."id" = g."employmentAssignmentId"
      JOIN "Position" p ON p."id" = ea."positionId"
      WHERE g."organizationId" = ${scope.organizationId}::uuid
        AND (g."dueDate" BETWEEN ${sqlDate(from!)} AND ${sqlDate(to!)}
          OR (g."dueDate" IS NULL AND g."startDate" BETWEEN ${sqlDate(from!)} AND ${sqlDate(to!)}))
        AND ${assignmentWhere(scope)}
      GROUP BY 1
      ORDER BY 1 NULLS LAST`);
    return {
      rows: groupRows(scope, rows, (row) => ({
        goals: row.goals,
        notStarted: row.notStarted,
        inProgress: row.inProgress,
        completed: row.completed,
        cancelled: row.cancelled,
        overdue: row.overdue,
        completionRate: percent(row.completed, row.goals - row.cancelled),
      })),
      notes: ['Completion rate = completed / goals not cancelled.'],
    };
  }

  private async evidence(scope: ReportScope): Promise<ReportOutput> {
    const completed = localDateSql(scope, Prisma.sql`ev."completedAt"`);
    const rows = await this.prisma.$queryRaw<
      Array<{
        kind: string;
        provider: string;
        records: number;
        employees: number;
        passed: number;
        failed: number;
      }>
    >(Prisma.sql`
      SELECT ev."kind"::text AS kind, ev."provider"::text AS provider,
        COUNT(*)::int AS records,
        COUNT(DISTINCT ev."employeeId")::int AS employees,
        COUNT(*) FILTER (WHERE ev."passed" = true)::int AS passed,
        COUNT(*) FILTER (WHERE ev."passed" = false)::int AS failed
      FROM "PerformanceEvidence" ev
      WHERE ev."organizationId" = ${scope.organizationId}::uuid
        AND ev."status" = 'ACTIVE' AND ev."supersededAt" IS NULL
        AND ${completed} BETWEEN ${sqlDate(scope.filters.from!)} AND ${sqlDate(scope.filters.to!)}
        AND EXISTS (
          SELECT 1 FROM "EmploymentAssignment" ea
          WHERE ea."employeeId" = ev."employeeId" AND ea."status" <> 'CANCELLED'
            AND ${assignmentWhere(scope)}
        )
      GROUP BY 1, 2
      ORDER BY 1, 2`);
    const result = suppressSmallGroups(
      rows.map((row) => ({
        kind: row.kind,
        provider: row.provider,
        records: row.records,
        employees: row.employees,
        passed: row.passed,
        failed: row.failed,
        passRate: percent(row.passed, row.passed + row.failed),
      })),
      'employees',
      ['kind', 'provider'],
      { partition: [] },
    );
    return {
      rows: result.rows,
      suppressed: result.suppressed,
      notes: [
        `Current (not withdrawn, not superseded) evidence completed in the range. Groups with fewer than ${MIN_GROUP_SIZE} employees are suppressed.`,
      ],
    };
  }
}
