import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  assignmentWhere,
  groupKeySql,
  groupRows,
  localDateSql,
  num,
  sqlDate,
  type AreaReportService,
  type ReportOutput,
  type ReportScope,
} from './reporting-common.js';
import { MAX_RESULT_ROWS, round2 } from './reporting-domain.js';
import { formatDate } from '../common/domain-support.js';

/** A person's display name (preferred first name), as the Time screens show it. */
function displayName(row: {
  firstName: string | null;
  preferredName: string | null;
  lastName: string | null;
}) {
  return (
    [row.preferredName ?? row.firstName, row.lastName]
      .filter(Boolean)
      .join(' ') || null
  );
}

const EXCEPTION_TYPES = [
  'LATE_ARRIVAL',
  'EARLY_DEPARTURE',
  'MISSING_CLOCK_OUT',
  'AUTO_CLOSED_CLOCK_OUT',
  'OPEN_BREAK_AUTO_CLOSED',
  'LONG_SHIFT',
  'UNSCHEDULED_WORK',
  'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
  'LATE_SIGN_IN',
  'UNSCHEDULED_SIGN_IN',
  // Batch 4F (Q9): every type is reported.
  'RECORDED_AFTER_APPROVAL',
  'NO_SHOW',
] as const;

const CORRECTION_TYPES = [
  'ADD_MISSING_CLOCK_IN',
  'ADD_MISSING_CLOCK_OUT',
  'CHANGE_CLOCK_IN',
  'CHANGE_CLOCK_OUT',
  'CHANGE_BREAK_START',
  'CHANGE_BREAK_END',
  'ADD_BREAK',
  'REMOVE_BREAK',
  'CHANGE_ASSIGNMENT',
  'ADD_MISSING_TIME_ENTRY',
  'CHANGE_COVERAGE',
] as const;

/** Net minutes of one closed entry: gross minus recorded unpaid breaks (alias `te`). */
export const ENTRY_MINUTES_SQL = Prisma.sql`
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (te."clockOutAt" - te."clockInAt")) / 60))`;
export const UNPAID_BREAK_MINUTES_SQL = Prisma.sql`
  COALESCE((SELECT SUM(GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (b."endAt" - b."startAt")) / 60)))
    FROM "BreakEntry" b
    WHERE b."timeEntryId" = te."id" AND b."removedAt" IS NULL AND b."endAt" IS NOT NULL
      AND b."payType" = 'UNPAID'), 0)`;

/**
 * Time & attendance reports (time.view), placed through the time entry's / exception's /
 * correction's employment assignment. Records without an assignment cannot be placed and are
 * left out.
 */
@Injectable()
export class TimeReportService implements AreaReportService {
  constructor(private readonly prisma: PrismaService) {}

  run(scope: ReportScope): Promise<ReportOutput> {
    switch (scope.definition.key) {
      case 'time.hours':
        return this.hours(scope);
      case 'time.exceptions':
        return this.exceptions(scope);
      case 'time.timesheet-detail':
        return this.timesheetDetail(scope);
      case 'time.sign-ins':
        return this.signIns(scope);
      default:
        return this.corrections(scope);
    }
  }

  private async hours(scope: ReportScope): Promise<ReportOutput> {
    const { from, to, groupBy } = scope.filters;
    const rows = await this.prisma.$queryRaw<
      Array<{
        key: string | null;
        closedEntries: number;
        openEntries: number;
        employees: number;
        grossMinutes: bigint | number | null;
        unpaidBreakMinutes: bigint | number | null;
      }>
    >(Prisma.sql`
      SELECT ${groupKeySql(groupBy, Prisma.sql`te."workDate"`)} AS key,
        COUNT(*) FILTER (WHERE te."clockOutAt" IS NOT NULL)::int AS "closedEntries",
        COUNT(*) FILTER (WHERE te."clockOutAt" IS NULL)::int AS "openEntries",
        COUNT(DISTINCT te."employeeId")::int AS employees,
        SUM(${ENTRY_MINUTES_SQL}) FILTER (WHERE te."clockOutAt" IS NOT NULL) AS "grossMinutes",
        SUM(${UNPAID_BREAK_MINUTES_SQL}) FILTER (WHERE te."clockOutAt" IS NOT NULL) AS "unpaidBreakMinutes"
      FROM "TimeEntry" te
      JOIN "EmploymentAssignment" ea ON ea."id" = te."employmentAssignmentId"
      JOIN "Position" p ON p."id" = ea."positionId"
      WHERE te."archivedAt" IS NULL AND te."status" <> 'VOIDED'
        AND te."workDate" BETWEEN ${sqlDate(from!)} AND ${sqlDate(to!)}
        AND ${assignmentWhere(scope)}
      GROUP BY 1
      ORDER BY 1 NULLS LAST`);
    return {
      rows: groupRows(scope, rows, (row) => {
        const gross = num(row.grossMinutes);
        const unpaid = num(row.unpaidBreakMinutes);
        return {
          closedEntries: row.closedEntries,
          openEntries: row.openEntries,
          employees: row.employees,
          grossMinutes: gross,
          unpaidBreakMinutes: unpaid,
          netMinutes: Math.max(0, gross - unpaid),
          netHours: round2(Math.max(0, gross - unpaid) / 60),
        };
      }),
      notes: [
        'Net minutes subtract recorded unpaid breaks only; a time policy auto-deduction is applied by timesheets and payroll, not here. Voided and archived entries are excluded.',
      ],
    };
  }

  /**
   * Batch 4F (Q9): one row per timesheet segment of the organization's periods overlapping the
   * range, only for assignments in the caller's authorized scope (row-level, in the query).
   * Approved minutes are the snapshot stored at approval (shown only for an approved segment);
   * the live columns are the segment's latest calculation, which can differ after approval
   * (time recorded later is flagged, never folded into the snapshot).
   */
  private async timesheetDetail(scope: ReportScope): Promise<ReportOutput> {
    const { from, to } = scope.filters;
    const rows = await this.prisma.$queryRaw<
      Array<{
        periodStart: Date;
        periodEnd: Date;
        employeeNumber: string;
        firstName: string | null;
        preferredName: string | null;
        lastName: string | null;
        position: string;
        timesheetStatus: string;
        segmentStatus: string;
        approvedWorkedMinutes: number;
        netWorkedMinutes: number;
        grossMinutes: number;
        policyDeductionMinutes: number;
      }>
    >(Prisma.sql`
      SELECT tp."startDate" AS "periodStart", tp."endDate" AS "periodEnd",
        e."employeeNumber", pe."firstName", pe."preferredName", pe."lastName",
        p."name" AS position, ts."status"::text AS "timesheetStatus",
        tss."status"::text AS "segmentStatus", tss."approvedWorkedMinutes",
        tss."netWorkedMinutes", tss."grossMinutes", tss."policyDeductionMinutes"
      FROM "TimesheetSegment" tss
      JOIN "Timesheet" ts ON ts."id" = tss."timesheetId"
      JOIN "TimePeriod" tp ON tp."id" = ts."timePeriodId"
      JOIN "EmploymentAssignment" ea ON ea."id" = tss."employmentAssignmentId"
      JOIN "Position" p ON p."id" = ea."positionId"
      JOIN "Employee" e ON e."id" = ts."employeeId"
      JOIN "Person" pe ON pe."id" = e."personId"
      WHERE tp."organizationId" = ${scope.organizationId}::uuid
        AND p."organizationId" = tp."organizationId"
        AND tp."startDate" <= ${sqlDate(to!)} AND tp."endDate" >= ${sqlDate(from!)}
        AND ${assignmentWhere(scope)}
      ORDER BY tp."startDate", e."employeeNumber", p."name", tss."id"
      LIMIT ${MAX_RESULT_ROWS + 1}`);
    return {
      rows: rows.map((row) => {
        const approved =
          row.segmentStatus === 'APPROVED' ? row.approvedWorkedMinutes : null;
        return {
          periodStart: formatDate(row.periodStart),
          periodEnd: formatDate(row.periodEnd),
          employeeNumber: row.employeeNumber,
          employeeName: displayName(row),
          position: row.position,
          timesheetStatus: row.timesheetStatus,
          segmentStatus: row.segmentStatus,
          approvedMinutes: approved,
          approvedHours: approved === null ? null : round2(approved / 60),
          liveNetMinutes: row.netWorkedMinutes,
          liveGrossMinutes: row.grossMinutes,
          livePolicyDeductionMinutes: row.policyDeductionMinutes,
          differsFromApproved:
            approved === null ? null : approved !== row.netWorkedMinutes,
        };
      }),
      notes: [
        'Approved minutes are the snapshot stored when the segment was approved (the payroll figure); they are blank until then. Live minutes are the latest calculation and can differ after approval: time recorded later is flagged for review, never added to an approved snapshot.',
        "Only the period organization's segments of assignments in your authorized scope are listed. No contact details are included.",
      ],
    };
  }

  /**
   * Batch 4F (Q9): one row per presence sign-in in the range (work date), only for assignments
   * in the caller's authorized scope. Local times use each sign-in's own time zone.
   */
  private async signIns(scope: ReportScope): Promise<ReportOutput> {
    const { from, to } = scope.filters;
    const rows = await this.prisma.$queryRaw<
      Array<{
        workDate: Date;
        employeeNumber: string;
        firstName: string | null;
        preferredName: string | null;
        lastName: string | null;
        position: string;
        signedInAt: string;
        timezone: string;
        source: string;
        status: string;
        scheduledShiftStart: string | null;
        signedOutAt: string | null;
      }>
    >(Prisma.sql`
      SELECT s."workDate", e."employeeNumber", pe."firstName", pe."preferredName",
        pe."lastName", p."name" AS position,
        to_char(s."signedInAt" AT TIME ZONE s."timezone", 'YYYY-MM-DD HH24:MI') AS "signedInAt",
        s."timezone", s."source"::text AS source, s."status"::text AS status,
        to_char(r."startsAt" AT TIME ZONE r."timezone", 'YYYY-MM-DD HH24:MI') AS "scheduledShiftStart",
        (SELECT to_char(so."signedOutAt" AT TIME ZONE s."timezone", 'YYYY-MM-DD HH24:MI')
           FROM "AttendanceSignOut" so
           WHERE so."signInId" = s."id" AND so."status" = 'ACTIVE'
           ORDER BY so."signedOutAt" DESC LIMIT 1) AS "signedOutAt"
      FROM "AttendanceSignIn" s
      JOIN "EmploymentAssignment" ea ON ea."id" = s."employmentAssignmentId"
      JOIN "Position" p ON p."id" = ea."positionId"
      JOIN "Employee" e ON e."id" = s."employeeId"
      JOIN "Person" pe ON pe."id" = e."personId"
      LEFT JOIN "ScheduledShiftRevision" r ON r."id" = s."scheduledShiftRevisionId"
      WHERE s."workDate" BETWEEN ${sqlDate(from!)} AND ${sqlDate(to!)}
        AND ${assignmentWhere(scope)}
      ORDER BY s."workDate", s."signedInAt", s."id"
      LIMIT ${MAX_RESULT_ROWS + 1}`);
    return {
      rows: rows.map((row) => ({
        workDate: formatDate(row.workDate),
        employeeNumber: row.employeeNumber,
        employeeName: displayName(row),
        position: row.position,
        signedInAt: row.signedInAt,
        timezone: row.timezone,
        source: row.source,
        status: row.status,
        scheduledShiftStart: row.scheduledShiftStart,
        signedOutAt: row.signedOutAt,
      })),
      notes: [
        'Presence sign-ins record attendance only: they carry no minutes and are never payable time. Voided sign-ins are listed with their status. No contact details or device identifiers are included.',
      ],
    };
  }

  private async exceptions(scope: ReportScope): Promise<ReportOutput> {
    const { from, to } = scope.filters;
    const detected = localDateSql(scope, Prisma.sql`ax."detectedAt"`);
    const rows = await this.prisma.$queryRaw<
      Array<{ type: string; status: string; count: number }>
    >(Prisma.sql`
      SELECT ax."type"::text AS type, ax."status"::text AS status, COUNT(*)::int AS count
      FROM "AttendanceException" ax
      LEFT JOIN "TimeEntry" ate ON ate."id" = ax."timeEntryId"
      JOIN "EmploymentAssignment" ea
        ON ea."id" = COALESCE(ax."employmentAssignmentId", ate."employmentAssignmentId")
      WHERE ${detected} BETWEEN ${sqlDate(from!)} AND ${sqlDate(to!)}
        AND ${assignmentWhere(scope)}
      GROUP BY 1, 2`);
    return {
      rows: EXCEPTION_TYPES.map((type) => {
        const of = (status: string) =>
          num(rows.find((r) => r.type === type && r.status === status)?.count);
        const open = of('OPEN');
        const resolved = of('RESOLVED');
        const dismissed = of('DISMISSED');
        const superseded = of('SUPERSEDED');
        return {
          type,
          total: open + resolved + dismissed + superseded,
          open,
          resolved,
          dismissed,
          superseded,
        };
      }),
      notes: [
        "Exceptions are dated by detection (organization-local date) and placed through their assignment, or their time entry's assignment; any without either cannot be placed and are excluded.",
      ],
    };
  }

  private async corrections(scope: ReportScope): Promise<ReportOutput> {
    const { from, to } = scope.filters;
    const requested = localDateSql(scope, Prisma.sql`tcr."requestedAt"`);
    const rows = await this.prisma.$queryRaw<
      Array<{ type: string; status: string; count: number }>
    >(Prisma.sql`
      SELECT tcr."type"::text AS type, tcr."status"::text AS status, COUNT(*)::int AS count
      FROM "TimeCorrectionRequest" tcr
      JOIN "EmploymentAssignment" ea
        ON ea."id" = COALESCE(tcr."employmentAssignmentId", tcr."targetEmploymentAssignmentId")
      WHERE ${requested} BETWEEN ${sqlDate(from!)} AND ${sqlDate(to!)}
        AND ${assignmentWhere(scope)}
      GROUP BY 1, 2`);
    return {
      rows: CORRECTION_TYPES.map((type) => {
        const of = (status: string) =>
          num(rows.find((r) => r.type === type && r.status === status)?.count);
        const values = {
          pending: of('PENDING'),
          approved: of('APPROVED'),
          rejected: of('REJECTED'),
          cancelled: of('CANCELLED'),
          superseded: of('SUPERSEDED'),
        };
        return {
          type,
          total: Object.values(values).reduce((a, b) => a + b, 0),
          ...values,
        };
      }),
      notes: [
        'Corrections are dated by request (organization-local date) and placed through their (target) assignment.',
      ],
    };
  }
}
