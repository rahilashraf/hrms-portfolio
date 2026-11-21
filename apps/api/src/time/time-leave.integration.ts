import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type {
  LeaveClient,
  LeaveRequestContext,
} from '../leave/leave-common.js';
import {
  LeaveIntegrationRegistry,
  type LeaveTimeIntegration,
} from '../leave/leave-integration.js';
import { TimeService } from './time.service.js';

/**
 * Phase 8 — Time & Attendance's side of the Leave contract. Time imports Leave (it consumes
 * approved absence through APPROVED_ABSENCE_SOURCE), so Leave cannot import Time; this provider
 * registers itself with Leave's registry instead, keeping the module graph acyclic.
 *
 * - lockedDates: a date is locked when its organization's TimePeriod is LOCKED or the
 *   employee's timesheet for that period is LOCKED. Leave refuses to change such dates. The
 *   rows are read FOR SHARE, after Leave's own locks (assignment → account → request), so the
 *   lock order extends to Leave → TimePeriod → Timesheet; Time never takes Leave locks.
 * - absenceChanged: re-interprets attendance (late/early exceptions) in the same transaction.
 */
@Injectable()
export class TimeLeaveIntegration
  implements LeaveTimeIntegration, OnModuleInit
{
  constructor(
    private readonly registry: LeaveIntegrationRegistry,
    private readonly time: TimeService,
  ) {}

  onModuleInit() {
    this.registry.registerTime(this);
  }

  async lockedDates(
    client: LeaveClient,
    input: {
      organizationId: string;
      employeeDates: ReadonlyMap<string, readonly Date[]>;
    },
    options: { lock: boolean },
  ): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    const all = [...input.employeeDates.values()].flat();
    if (all.length === 0) return result;
    const from = new Date(Math.min(...all.map((d) => d.getTime())));
    const to = new Date(Math.max(...all.map((d) => d.getTime())));
    // With lock: FOR SHARE, so a period or timesheet cannot be locked between this check and
    // the commit of the leave change that relied on it (locking UPDATEs the row and waits).
    const share = options.lock ? Prisma.sql`FOR SHARE` : Prisma.empty;
    const periods = await client.$queryRaw<
      { id: string; startDate: Date; endDate: Date; status: string }[]
    >(
      Prisma.sql`
        SELECT "id", "startDate", "endDate", "status"::text AS "status" FROM "TimePeriod"
        WHERE "organizationId" = ${input.organizationId}::uuid
          AND "startDate" <= ${to}::date AND "endDate" >= ${from}::date
        ORDER BY "id"
        ${share}`,
    );
    const employeeIds = [...input.employeeDates.keys()];
    const timesheets = periods.length
      ? await client.$queryRaw<
          { employeeId: string; timePeriodId: string; status: string }[]
        >(
          Prisma.sql`
            SELECT "employeeId", "timePeriodId", "status"::text AS "status" FROM "Timesheet"
            WHERE "employeeId" IN (${Prisma.join(employeeIds.map((id) => Prisma.sql`${id}::uuid`))})
              AND "timePeriodId" IN (${Prisma.join(periods.map((p) => Prisma.sql`${p.id}::uuid`))})
            ORDER BY "id"
            ${share}`,
        )
      : [];
    for (const [employeeId, dates] of input.employeeDates) {
      const lockedPeriods = periods.filter(
        (p) =>
          p.status === 'LOCKED' ||
          timesheets.some(
            (t) =>
              t.employeeId === employeeId &&
              t.timePeriodId === p.id &&
              t.status === 'LOCKED',
          ),
      );
      const locked = new Set<string>();
      for (const date of dates) {
        if (
          lockedPeriods.some((p) => p.startDate <= date && date <= p.endDate)
        ) {
          locked.add(date.toISOString().slice(0, 10));
        }
      }
      result.set(employeeId, locked);
    }
    return result;
  }

  async absenceChanged(
    client: LeaveClient,
    input: {
      employeeId: string;
      employmentAssignmentId: string;
      dates: readonly Date[];
      intervals: readonly { start: Date; end: Date }[];
    },
    context: LeaveRequestContext,
  ) {
    await this.time.recalculateAttendanceForAbsences(
      client as Prisma.TransactionClient,
      input,
      context,
    );
  }
}
