import { Inject, Injectable } from '@nestjs/common';
import {
  addDays,
  formatDate,
  localDayStart,
} from '../common/domain-support.js';
import {
  PAYROLL_BENEFIT_SOURCE,
  type PayrollBenefitSource,
} from '../benefits/benefits-payroll.source.js';
import {
  PAYROLL_COMPENSATION_SOURCE,
  type PayrollCompensationSource,
} from '../compensation/compensation-integration.contracts.js';
import {
  PAYROLL_EMPLOYMENT_SOURCE,
  type PayrollEmploymentSource,
} from '../employee/employee-payroll.source.js';
import {
  PAYROLL_LEAVE_SOURCE,
  type PayrollLeaveSource,
} from '../leave/leave-payroll.source.js';
import { ScheduleAttendanceService } from '../scheduling/schedule-attendance.service.js';
import {
  ATTENDANCE_PRESENCE_SOURCE,
  PAYROLL_TIME_SOURCE,
  type AttendancePresenceSource,
  type PayrollTimeSource,
  type PayrollTimesheetFact,
} from '../time/time-integration.contracts.js';
import type { PayrollClient } from './payroll-common.js';
import type { AssignmentSources } from './payroll-engine.js';

export interface SourceScope {
  payGroupId: string;
  periodStart: Date;
  periodEnd: Date;
  timePeriodId: string;
  timezone: string;
  /** Assignments to include even when no longer in the pay group (e.g. carrying manual lines). */
  extraAssignmentIds?: readonly string[];
}

/**
 * Phase 10 Batch 4 (and Phase 11 benefits) — collects every source fact a pay period's payroll depends on, through the
 * owning domains' payroll contracts only (Core HR, Compensation, Time, Leave, Scheduling,
 * attendance presence). Read-only: no source row is locked or changed. The population is the
 * pay group's assignments in the period (Compensation's pay-group facts).
 */
@Injectable()
export class PayrollSourceService {
  constructor(
    @Inject(PAYROLL_COMPENSATION_SOURCE)
    private readonly compensation: PayrollCompensationSource,
    @Inject(PAYROLL_EMPLOYMENT_SOURCE)
    private readonly employment: PayrollEmploymentSource,
    @Inject(PAYROLL_TIME_SOURCE) private readonly time: PayrollTimeSource,
    @Inject(PAYROLL_LEAVE_SOURCE) private readonly leave: PayrollLeaveSource,
    @Inject(ATTENDANCE_PRESENCE_SOURCE)
    private readonly presence: AttendancePresenceSource,
    private readonly schedules: ScheduleAttendanceService,
    @Inject(PAYROLL_BENEFIT_SOURCE)
    private readonly benefits: PayrollBenefitSource,
  ) {}

  async collect(
    scope: SourceScope,
    client?: PayrollClient,
  ): Promise<AssignmentSources[]> {
    const from = formatDate(scope.periodStart);
    const to = formatDate(scope.periodEnd);
    const members = await this.compensation.payGroupAssignmentsBetween(
      { payGroupId: scope.payGroupId, from, to },
      client,
    );
    const ids = [
      ...new Set([
        ...members.map((member) => member.employmentAssignmentId),
        ...(scope.extraAssignmentIds ?? []),
      ]),
    ].sort();
    const facts = await this.employment.employmentFacts(ids, client);
    const timesheets = new Map<string, PayrollTimesheetFact | null>();
    const start = localDayStart(
      scope.periodStart,
      scope.timezone,
    ).toISOString();
    const end = localDayStart(
      addDays(scope.periodEnd, 1),
      scope.timezone,
    ).toISOString();
    const result: AssignmentSources[] = [];
    for (const employment of facts) {
      const id = employment.employmentAssignmentId;
      if (!timesheets.has(employment.employeeId)) {
        timesheets.set(
          employment.employeeId,
          await this.time.payrollTimesheet(
            {
              employeeId: employment.employeeId,
              timePeriodId: scope.timePeriodId,
            },
            client,
          ),
        );
      }
      // Sequential: inside a transaction every read shares one connection.
      const compensation = await this.compensation.compensationFactsBetween(
        { employmentAssignmentId: id, from, to },
        client,
      );
      const time = await this.time.payrollAssignmentTime(
        { employmentAssignmentId: id, from, to },
        client,
      );
      const leave = await this.leave.approvedLeaveDaysBetween(
        { employmentAssignmentId: id, from, to },
        client,
      );
      const presence = await this.presence.presenceFactsBetween(
        { employmentAssignmentId: id, from, to },
        client,
      );
      const expected = await this.schedules.publishedExpectedWork(
        {
          employeeId: employment.employeeId,
          employmentAssignmentId: id,
          start,
          end,
        },
        client as never,
      );
      const benefits = await this.benefits.benefitFactsBetween(
        { employmentAssignmentId: id, from, to },
        client,
      );
      const inPeriod = expected.filter(
        (shift) => shift.workDate >= from && shift.workDate <= to,
      );
      result.push({
        employment,
        compensation,
        timesheet: timesheets.get(employment.employeeId) ?? null,
        time,
        leave,
        presence,
        expectedWork: {
          shifts: inPeriod.length,
          scheduledMinutes: inPeriod.reduce(
            (total, shift) => total + shift.scheduledMinutes,
            0,
          ),
        },
        benefits,
      });
    }
    return result;
  }
}
