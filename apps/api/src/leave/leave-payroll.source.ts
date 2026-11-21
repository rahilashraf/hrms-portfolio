import { Injectable } from '@nestjs/common';
import { formatDate, parseDateOnly } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type { LeaveClient } from './leave-common.js';

/**
 * Phase 10 — approved leave as Payroll consumes it: one fact per approved, uncancelled leave
 * day, with the minutes frozen at approval, its PAID/UNPAID classification and the schedule
 * revisions it was sized from. Leave owns these facts; Payroll never changes them (a later
 * amendment cancels days, which Payroll sees as changed sources, never as rewritten history).
 */
export const PAYROLL_LEAVE_SOURCE = Symbol('PAYROLL_LEAVE_SOURCE');

export interface PayrollLeaveFact {
  leaveRequestId: string;
  leaveRequestDayId: string;
  leaveTypeId: string;
  leaveTypeCode: string;
  classification: 'PAID' | 'UNPAID';
  employmentAssignmentId: string;
  /** YYYY-MM-DD local date of the leave day. */
  date: string;
  minutes: number;
  scheduledShiftRevisionIds: string[];
}

export interface PayrollLeaveSource {
  approvedLeaveDaysBetween(
    query: { employmentAssignmentId: string; from: string; to: string },
    client?: unknown,
  ): Promise<PayrollLeaveFact[]>;
}

@Injectable()
export class LeavePayrollSource implements PayrollLeaveSource {
  constructor(private readonly prisma: PrismaService) {}

  async approvedLeaveDaysBetween(
    query: { employmentAssignmentId: string; from: string; to: string },
    client?: unknown,
  ): Promise<PayrollLeaveFact[]> {
    const db = (client as LeaveClient | undefined) ?? this.prisma;
    const days = await db.leaveRequestDay.findMany({
      where: {
        cancelledByAmendmentId: null,
        date: {
          gte: parseDateOnly(query.from, 'from'),
          lte: parseDateOnly(query.to, 'to'),
        },
        request: {
          employmentAssignmentId: query.employmentAssignmentId,
          status: 'APPROVED',
        },
      },
      include: {
        request: {
          select: {
            id: true,
            employmentAssignmentId: true,
            account: {
              select: {
                leaveType: {
                  select: { id: true, code: true, classification: true },
                },
              },
            },
          },
        },
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });
    return days.map((day) => ({
      leaveRequestId: day.request.id,
      leaveRequestDayId: day.id,
      leaveTypeId: day.request.account.leaveType.id,
      leaveTypeCode: day.request.account.leaveType.code,
      classification: day.request.account.leaveType.classification,
      employmentAssignmentId: day.request.employmentAssignmentId,
      date: formatDate(day.date),
      minutes: day.minutes,
      scheduledShiftRevisionIds: [...day.scheduledShiftRevisionIds].sort(),
    }));
  }
}
