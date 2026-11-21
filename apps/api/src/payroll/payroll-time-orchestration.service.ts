import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { formatDate } from '../common/domain-support.js';
import {
  PAYROLL_COMPENSATION_SOURCE,
  type PayrollCompensationSource,
} from '../compensation/compensation-integration.contracts.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  PAYROLL_TIME_SOURCE,
  type PayrollTimeSource,
} from '../time/time-integration.contracts.js';
import { PayrollAccessService } from './payroll-access.service.js';
import {
  PayrollClock,
  writePayrollAudit,
  type PayrollRequestContext,
} from './payroll-common.js';

export interface MaterializationOutcome {
  payrollPeriodId: string;
  timePeriodId: string;
  employees: number;
  created: number;
  failed: Array<{ employeeId: string; message: string }>;
}

/**
 * Phase 10 Batch 3 — makes sure the employees a pay period will pay have their timesheets in
 * the period's TimePeriod. Time owns timesheets and creates them (PayrollTimeSource); Payroll
 * only decides who: the employees with an assignment in the pay group during the period
 * (Compensation's pay-group facts). Each employee is materialized in its own transaction, so a
 * failure never undoes the others and a retry only redoes what is missing. Never approves,
 * locks or changes time.
 */
@Injectable()
export class PayrollTimeOrchestrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PayrollAccessService,
    private readonly audit: AuditService,
    private readonly clock: PayrollClock,
    @Inject(PAYROLL_TIME_SOURCE) private readonly time: PayrollTimeSource,
    @Inject(PAYROLL_COMPENSATION_SOURCE)
    private readonly compensation: PayrollCompensationSource,
  ) {}

  /** payroll.manage on the period's organization. */
  async materialize(periodId: string, context: PayrollRequestContext) {
    const period = await this.prisma.payrollPeriod.findUnique({
      where: { id: periodId },
    });
    if (!period) throw new NotFoundException('Payroll period not found.');
    await this.access.assert(
      context.actorUserId,
      'payroll.manage',
      period.organizationId,
    );
    return this.materializePeriod(periodId, context);
  }

  /** Trusted internal entry (the worker): no actor. */
  async materializePeriod(
    periodId: string,
    context: PayrollRequestContext,
  ): Promise<MaterializationOutcome> {
    const period = await this.prisma.payrollPeriod.findUniqueOrThrow({
      where: { id: periodId },
    });
    const members = await this.compensation.payGroupAssignmentsBetween({
      payGroupId: period.payGroupId,
      from: formatDate(period.periodStart),
      to: formatDate(period.periodEnd),
    });
    const employeeIds = [
      ...new Set(members.map((member) => member.employeeId)),
    ].sort();
    const outcome: MaterializationOutcome = {
      payrollPeriodId: period.id,
      timePeriodId: period.timePeriodId,
      employees: employeeIds.length,
      created: 0,
      failed: [],
    };
    for (const employeeId of employeeIds) {
      try {
        const sheet = await this.time.ensureTimesheet({
          employeeId,
          timePeriodId: period.timePeriodId,
        });
        if (sheet.created) outcome.created += 1;
      } catch (error) {
        outcome.failed.push({
          employeeId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (outcome.failed.length === 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.payrollPeriod.update({
          where: { id: period.id },
          data: { timesheetsMaterializedAt: this.clock.now() },
        });
        await writePayrollAudit(this.audit, tx, {
          action: 'PAYROLL_TIMESHEETS_MATERIALIZED',
          entityType: 'PayrollPeriod',
          entityId: period.id,
          context,
          metadata: {
            timePeriodId: period.timePeriodId,
            employees: outcome.employees,
            created: outcome.created,
          },
        });
      });
    }
    return outcome;
  }
}
