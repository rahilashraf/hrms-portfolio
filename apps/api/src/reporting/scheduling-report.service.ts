import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  assignmentWhere,
  groupKeySql,
  groupRows,
  num,
  sqlDate,
  type AreaReportService,
  type ReportOutput,
  type ReportScope,
} from './reporting-common.js';
import { percent, round2 } from './reporting-domain.js';
import {
  ENTRY_MINUTES_SQL,
  UNPAID_BREAK_MINUTES_SQL,
} from './time-report.service.js';

const SHIFT_MINUTES_SQL = Prisma.sql`
  GREATEST(0, ROUND(EXTRACT(EPOCH FROM (ss."endsAt" - ss."startsAt")) / 60))`;

/**
 * Scheduling reports (schedule.read; adherence also needs time.view): active shifts of
 * published schedules, placed through the shift's employment assignment. Every shift belongs
 * to an assignment (the scheduling model has no open, unassigned shifts), so coverage is
 * measured as shifts worked (a linked time entry) vs not worked.
 */
@Injectable()
export class SchedulingReportService implements AreaReportService {
  constructor(private readonly prisma: PrismaService) {}

  run(scope: ReportScope): Promise<ReportOutput> {
    return scope.definition.key === 'scheduling.hours'
      ? this.hours(scope)
      : this.adherence(scope);
  }

  private shiftFilter(scope: ReportScope) {
    return Prisma.sql`ss."status" = 'ACTIVE' AND s."status" = 'PUBLISHED'
      AND ss."workDate" BETWEEN ${sqlDate(scope.filters.from!)} AND ${sqlDate(scope.filters.to!)}
      AND ${assignmentWhere(scope)}`;
  }

  private async hours(scope: ReportScope): Promise<ReportOutput> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        key: string | null;
        shifts: number;
        employees: number;
        scheduledMinutes: bigint | number | null;
      }>
    >(Prisma.sql`
      SELECT ${groupKeySql(scope.filters.groupBy, Prisma.sql`ss."workDate"`)} AS key,
        COUNT(*)::int AS shifts,
        COUNT(DISTINCT ea."employeeId")::int AS employees,
        SUM(${SHIFT_MINUTES_SQL}) AS "scheduledMinutes"
      FROM "ScheduledShift" ss
      JOIN "Schedule" s ON s."id" = ss."scheduleId"
      JOIN "EmploymentAssignment" ea ON ea."id" = ss."employmentAssignmentId"
      JOIN "Position" p ON p."id" = ea."positionId"
      WHERE ${this.shiftFilter(scope)}
      GROUP BY 1
      ORDER BY 1 NULLS LAST`);
    return {
      rows: groupRows(scope, rows, (row) => ({
        shifts: row.shifts,
        employees: row.employees,
        scheduledMinutes: num(row.scheduledMinutes),
        scheduledHours: round2(num(row.scheduledMinutes) / 60),
      })),
      notes: ['Only active shifts of published schedules are counted.'],
    };
  }

  private async adherence(scope: ReportScope): Promise<ReportOutput> {
    const { groupBy } = scope.filters;
    const [shiftRows, unscheduled] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          key: string | null;
          shifts: number;
          shiftsWorked: number;
          scheduledMinutes: bigint | number | null;
          workedMinutes: bigint | number | null;
        }>
      >(Prisma.sql`
        SELECT ${groupKeySql(groupBy, Prisma.sql`ss."workDate"`)} AS key,
          COUNT(*)::int AS shifts,
          COUNT(*) FILTER (WHERE worked.entries > 0)::int AS "shiftsWorked",
          SUM(${SHIFT_MINUTES_SQL}) AS "scheduledMinutes",
          SUM(worked.minutes) AS "workedMinutes"
        FROM "ScheduledShift" ss
        JOIN "Schedule" s ON s."id" = ss."scheduleId"
        JOIN "EmploymentAssignment" ea ON ea."id" = ss."employmentAssignmentId"
        JOIN "Position" p ON p."id" = ea."positionId"
        CROSS JOIN LATERAL (
          SELECT COUNT(*) AS entries,
            COALESCE(SUM(GREATEST(0, ${ENTRY_MINUTES_SQL} - ${UNPAID_BREAK_MINUTES_SQL}))
              FILTER (WHERE te."clockOutAt" IS NOT NULL), 0) AS minutes
          FROM "TimeEntry" te
          WHERE te."scheduledShiftId" = ss."id" AND te."archivedAt" IS NULL
            AND te."status" <> 'VOIDED'
        ) worked
        WHERE ${this.shiftFilter(scope)}
        GROUP BY 1`),
      this.prisma.$queryRaw<Array<{ key: string | null; entries: number }>>(
        Prisma.sql`
        SELECT ${groupKeySql(groupBy, Prisma.sql`te."workDate"`)} AS key,
          COUNT(*)::int AS entries
        FROM "TimeEntry" te
        JOIN "EmploymentAssignment" ea ON ea."id" = te."employmentAssignmentId"
        JOIN "Position" p ON p."id" = ea."positionId"
        WHERE te."scheduledShiftId" IS NULL AND te."archivedAt" IS NULL
          AND te."status" <> 'VOIDED' AND te."clockOutAt" IS NOT NULL
          AND te."workDate" BETWEEN ${sqlDate(scope.filters.from!)} AND ${sqlDate(scope.filters.to!)}
          AND ${assignmentWhere(scope)}
        GROUP BY 1`,
      ),
    ]);
    const keys = [
      ...new Set([
        ...shiftRows.map((r) => r.key),
        ...unscheduled.map((r) => r.key),
      ]),
    ].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
    const merged = keys.map((key) => {
      const shift = shiftRows.find((r) => r.key === key);
      const shifts = num(shift?.shifts);
      const worked = num(shift?.shiftsWorked);
      const scheduledMinutes = num(shift?.scheduledMinutes);
      const workedMinutes = num(shift?.workedMinutes);
      return {
        key,
        shifts,
        shiftsWorked: worked,
        shiftsNotWorked: shifts - worked,
        coverageRate: percent(worked, shifts),
        scheduledMinutes,
        workedMinutes,
        adherenceRate: percent(workedMinutes, scheduledMinutes),
        unscheduledEntries: num(
          unscheduled.find((r) => r.key === key)?.entries,
        ),
      };
    });
    return {
      rows: groupRows(scope, merged, ({ key: _key, ...row }) => row),
      notes: [
        'A shift is worked when a non-voided time entry is linked to it; worked minutes are the linked closed entries net of recorded unpaid breaks. Unscheduled entries are closed entries without a linked shift.',
        // Batch 4F (D10): say what is not subtracted, so it is not read as payable time.
        'Worked minutes do not subtract a time policy automatic deduction: timesheets, payroll and the scheduled-vs-actual view do, so for organizations with automatic deductions they can be lower than shown here.',
      ],
    };
  }
}
