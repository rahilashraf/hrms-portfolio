import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  assignmentWhere,
  groupKeySql,
  groupRows,
  localDateSql,
  nullableNum,
  sqlDate,
  type AreaReportService,
  type ReportOutput,
  type ReportScope,
} from './reporting-common.js';
import { percent, round2 } from './reporting-domain.js';

/**
 * Onboarding (onboarding.read) and offboarding (offboarding.read — never implied by onboarding
 * access) reports, placed through the workflow's employment assignment. The caller's own
 * workflows are left out, as the workflow domain never shows them through grants. Never a
 * reason, note or task text: counts and durations only.
 */
@Injectable()
export class WorkflowReportService implements AreaReportService {
  constructor(private readonly prisma: PrismaService) {}

  async run(scope: ReportScope): Promise<ReportOutput> {
    const kind =
      scope.definition.key === 'offboarding.workflows'
        ? 'OFFBOARDING'
        : 'ONBOARDING';
    const started = localDateSql(scope, Prisma.sql`w."startedAt"`);
    const rows = await this.prisma.$queryRaw<
      Array<{
        key: string | null;
        workflows: number;
        active: number;
        completed: number;
        cancelled: number;
        overdueTasks: number;
        medianDays: string | number | null;
      }>
    >(Prisma.sql`
      SELECT ${groupKeySql(scope.filters.groupBy, started)} AS key,
        COUNT(*)::int AS workflows,
        COUNT(*) FILTER (WHERE w."status" = 'ACTIVE')::int AS active,
        COUNT(*) FILTER (WHERE w."status" = 'COMPLETED')::int AS completed,
        COUNT(*) FILTER (WHERE w."status" = 'CANCELLED')::int AS cancelled,
        COALESCE(SUM(overdue.tasks) FILTER (WHERE w."status" = 'ACTIVE'), 0)::int AS "overdueTasks",
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (w."completedAt" - w."startedAt")) / 86400
        ) FILTER (WHERE w."status" = 'COMPLETED' AND w."completedAt" IS NOT NULL) AS "medianDays"
      FROM "EmployeeWorkflow" w
      JOIN "EmploymentAssignment" ea ON ea."id" = w."employmentAssignmentId"
      JOIN "Position" p ON p."id" = ea."positionId"
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS tasks
        FROM "EmployeeWorkflowTask" t
        WHERE t."workflowId" = w."id"
          AND t."status" IN ('NOT_STARTED', 'IN_PROGRESS')
          AND t."dueDate" < ${sqlDate(scope.today)}
      ) overdue
      WHERE w."organizationId" = ${scope.organizationId}::uuid
        AND w."kind"::text = ${kind}::text
        AND ${started} BETWEEN ${sqlDate(scope.filters.from!)} AND ${sqlDate(scope.filters.to!)}
        AND ${assignmentWhere(scope)}
      GROUP BY 1
      ORDER BY 1 NULLS LAST`);
    return {
      rows: groupRows(scope, rows, (row) => {
        const median = nullableNum(row.medianDays);
        return {
          workflows: row.workflows,
          active: row.active,
          completed: row.completed,
          cancelled: row.cancelled,
          completionRate: percent(row.completed, row.workflows - row.cancelled),
          overdueTasks: row.overdueTasks,
          medianDaysToComplete: median === null ? null : round2(median),
        };
      }),
      notes: [
        'Workflows started in the range. Completion rate = completed / workflows not cancelled. Overdue tasks are open tasks past their due date in active workflows.',
      ],
    };
  }
}
