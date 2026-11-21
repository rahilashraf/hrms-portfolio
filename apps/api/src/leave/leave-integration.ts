import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type {
  ApprovedAbsenceInterval,
  ApprovedAbsenceSource,
} from '../time/time-integration.contracts.js';
import type { LeaveClient, LeaveRequestContext } from './leave-common.js';

/**
 * The narrow contract Time & Attendance implements for Leave. Time depends on Leave (it
 * consumes approved absence), so Leave cannot import Time: Time registers this at start-up.
 */
export interface LeaveTimeIntegration {
  /**
   * Per employee, the given dates (YYYY-MM-DD) inside a LOCKED TimePeriod of the organization
   * or a LOCKED timesheet of that employee. `lock` reads the rows FOR SHARE (mutations, inside
   * their transaction); read models pass false. One pair of queries for any number of rows.
   */
  lockedDates(
    client: LeaveClient,
    input: {
      organizationId: string;
      employeeDates: ReadonlyMap<string, readonly Date[]>;
    },
    options: { lock: boolean },
  ): Promise<Map<string, Set<string>>>;
  /**
   * Re-interprets the assignment's attendance on the leave's dates (and any entry whose actual
   * time overlaps the absence intervals), in the same transaction. Finalized time is untouched.
   */
  absenceChanged(
    client: LeaveClient,
    input: {
      employeeId: string;
      employmentAssignmentId: string;
      dates: readonly Date[];
      intervals: readonly { start: Date; end: Date }[];
    },
    context: LeaveRequestContext,
  ): Promise<void>;
}

@Injectable()
export class LeaveIntegrationRegistry {
  private time: LeaveTimeIntegration | null = null;

  registerTime(integration: LeaveTimeIntegration) {
    this.time = integration;
  }

  async lockedDates(
    client: LeaveClient,
    input: Parameters<LeaveTimeIntegration['lockedDates']>[1],
    options: { lock: boolean },
  ): Promise<Map<string, Set<string>>> {
    return this.time
      ? this.time.lockedDates(client, input, options)
      : new Map();
  }

  async absenceChanged(
    client: LeaveClient,
    input: Parameters<LeaveTimeIntegration['absenceChanged']>[1],
    context: LeaveRequestContext,
  ) {
    if (this.time && input.intervals.length > 0) {
      await this.time.absenceChanged(client, input, context);
    }
  }
}

/**
 * Binds Time & Attendance's APPROVED_ABSENCE_SOURCE. Returns the absence interval of every
 * approved, uncancelled leave day overlapping [start, end): absence, never worked time.
 */
@Injectable()
export class LeaveAbsenceSource implements ApprovedAbsenceSource {
  constructor(private readonly prisma: PrismaService) {}

  async approvedAbsences(
    query: { employeeId: string; start: string; end: string },
    client?: unknown,
  ): Promise<ApprovedAbsenceInterval[]> {
    const db = (client as LeaveClient | undefined) ?? this.prisma;
    const days = await db.leaveRequestDay.findMany({
      where: {
        cancelledByAmendmentId: null,
        absenceStart: { lt: new Date(query.end) },
        absenceEnd: { gt: new Date(query.start) },
        request: { employeeId: query.employeeId, status: 'APPROVED' },
      },
      select: {
        id: true,
        absenceStart: true,
        absenceEnd: true,
        request: {
          select: {
            employmentAssignmentId: true,
            account: {
              select: { leaveType: { select: { classification: true } } },
            },
          },
        },
      },
      orderBy: { absenceStart: 'asc' },
    });
    return days.map((day) => ({
      employeeId: query.employeeId,
      employmentAssignmentId: day.request.employmentAssignmentId,
      start: day.absenceStart.toISOString(),
      end: day.absenceEnd.toISOString(),
      classification: day.request.account.leaveType.classification,
      sourceId: day.id,
    }));
  }
}
