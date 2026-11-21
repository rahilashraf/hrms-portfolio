import { AuditService } from '../../src/audit/audit.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { BenefitsPayrollSource } from '../../src/benefits/benefits-payroll.source.js';
import { CompensationPayrollSource } from '../../src/compensation/compensation-payroll.source.js';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { PayrollAccessService } from '../../src/payroll/payroll-access.service.js';
import { PayrollAdjustmentService } from '../../src/payroll/payroll-adjustment.service.js';
import { PayrollCalendarService } from '../../src/payroll/payroll-calendar.service.js';
import { PayrollClock } from '../../src/payroll/payroll-common.js';
import { PayrollTimeOrchestrationService } from '../../src/payroll/payroll-time-orchestration.service.js';
import { PositionAuthorizationTargetResolver } from '../../src/authorization/position-authorization-target.resolver.js';
import { EmployeePayrollSource } from '../../src/employee/employee-payroll.source.js';
import { LeavePayrollSource } from '../../src/leave/leave-payroll.source.js';
import { PayrollLifecycleService } from '../../src/payroll/payroll-lifecycle.service.js';
import { PayrollReadService } from '../../src/payroll/payroll-read.service.js';
import { PayrollSelfService } from '../../src/payroll/payroll-self.service.js';
import { PayrollRunService } from '../../src/payroll/payroll-run.service.js';
import { PayrollSeparationService } from '../../src/payroll/payroll-separation.service.js';
import { PayrollSourceService } from '../../src/payroll/payroll-source.service.js';
import { NoStatutoryPayrollCalculator } from '../../src/payroll/statutory/statutory-payroll.contracts.js';
import { ScheduleAttendanceService } from '../../src/scheduling/schedule-attendance.service.js';
import { AttendanceSignInService } from '../../src/time/attendance-sign-in.service.js';
import { TimeDomainService } from '../../src/time/time-domain.service.js';
import { SystemClock } from '../../src/time/time.service.js';
import { createTimeService } from '../../src/time/time-jobs.js';
import type { Tx, UserSpec } from './scheduling-fixtures.js';

export const PAYROLL_PERMISSION_KEYS = [
  'payroll.read',
  'payroll.manage',
  'payroll.calculate',
  'payroll.approve',
  'payroll.finalize',
  'payroll.adjust',
] as const;

/** Users of payroll specs: payroll is organization-scoped and never implied by HR access. */
export const PAYROLL_USERS: Record<string, UserSpec[]> = {
  payrollAdmin: [{ permissions: PAYROLL_PERMISSION_KEYS, scope: 'org' }],
  payrollReader: [{ permissions: ['payroll.read'], scope: 'org' }],
  approver: [
    { permissions: ['payroll.read', 'payroll.approve'], scope: 'org' },
  ],
  finalizer: [
    { permissions: ['payroll.read', 'payroll.finalize'], scope: 'org' },
  ],
  teamPayroll: [{ permissions: PAYROLL_PERMISSION_KEYS, scope: 'teamA' }],
  hr: [
    {
      permissions: [
        'employee.read',
        'employee.manage',
        'compensation.read',
        'compensation.manage',
      ],
      scope: 'org',
    },
  ],
  orgBPayroll: [{ permissions: PAYROLL_PERMISSION_KEYS, scope: 'orgB' }],
};

export class FixedPayrollClock extends PayrollClock {
  value = new Date('2026-11-01T12:00:00.000Z');

  override now() {
    return this.value;
  }
}

export function payrollServices(
  prisma: PrismaService,
  clock: PayrollClock,
  overrides: { audit?: AuditService } = {},
) {
  const authorization = new AuthorizationService(prisma);
  const access = new PayrollAccessService(prisma, authorization);
  const audit = overrides.audit ?? new AuditService(prisma);
  const time = createTimeService(prisma);
  const compensation = new CompensationPayrollSource(prisma);
  const calendars = new PayrollCalendarService(
    prisma,
    access,
    audit,
    clock,
    time,
  );
  const timeOrchestration = new PayrollTimeOrchestrationService(
    prisma,
    access,
    audit,
    clock,
    time,
    compensation,
  );
  const schedules = new ScheduleAttendanceService(
    prisma,
    new PositionAuthorizationTargetResolver(prisma),
  );
  const presence = new AttendanceSignInService(
    prisma,
    time,
    new TimeDomainService(),
    audit,
    new SystemClock(),
    schedules,
  );
  const sources = new PayrollSourceService(
    compensation,
    new EmployeePayrollSource(prisma),
    time,
    new LeavePayrollSource(prisma),
    presence,
    schedules,
    new BenefitsPayrollSource(prisma),
  );
  const runs = new PayrollRunService(prisma, access, audit, clock, sources);
  const separation = new PayrollSeparationService(prisma);
  const reads = new PayrollReadService(prisma, access, separation);
  const lifecycle = new PayrollLifecycleService(
    prisma,
    access,
    audit,
    clock,
    runs,
    new NoStatutoryPayrollCalculator(),
    separation,
  );
  const adjustments = new PayrollAdjustmentService(
    prisma,
    access,
    audit,
    clock,
    runs,
  );
  return {
    authorization,
    access,
    audit,
    calendars,
    timeOrchestration,
    time,
    compensation,
    sources,
    runs,
    reads,
    lifecycle,
    adjustments,
    self: new PayrollSelfService(prisma),
    clock,
  };
}

export type PayrollServices = ReturnType<typeof payrollServices>;

export const d = (value: string) => new Date(`${value}T00:00:00.000Z`);

export async function payGroup(tx: Tx, organizationId: string, code: string) {
  return tx.payGroup.create({ data: { organizationId, code, name: code } });
}

/**
 * Security remediation M2: shortens a compensation record the way the application does — a
 * closure ledger entry naming who closed it, then the record, in one transaction (the database
 * refuses an end-date change without it).
 */
export async function closeCompensation(
  client: Tx | PrismaService,
  recordId: string,
  effectiveTo: Date,
  closedByUserId: string,
) {
  const close = async (tx: Tx) => {
    const record = await tx.compensationRecord.findUniqueOrThrow({
      where: { id: recordId },
    });
    await tx.compensationRecordClosure.create({
      data: {
        compensationRecordId: record.id,
        employmentAssignmentId: record.employmentAssignmentId,
        organizationId: record.organizationId,
        previousEffectiveTo: record.effectiveTo,
        newEffectiveTo: effectiveTo,
        closedByUserId,
        source: 'APPLICATION',
      },
    });
    return tx.compensationRecord.update({
      where: { id: recordId },
      data: { effectiveTo },
    });
  };
  return '$transaction' in client && typeof client.$transaction === 'function'
    ? (client as PrismaService).$transaction((tx) => close(tx))
    : close(client as Tx);
}
