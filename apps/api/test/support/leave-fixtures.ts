import { HolidayService } from '../../src/calendar/holiday.service.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { LeaveAccessService } from '../../src/leave/leave-access.service.js';
import { LeaveConfigService } from '../../src/leave/leave-config.service.js';
import { LeaveEntitlementService } from '../../src/leave/leave-entitlement.service.js';
import {
  LeaveAbsenceSource,
  LeaveIntegrationRegistry,
} from '../../src/leave/leave-integration.js';
import { LeaveLedgerService } from '../../src/leave/leave-ledger.service.js';
import { LeaveRequestService } from '../../src/leave/leave-request.service.js';
import { LeaveViewService } from '../../src/leave/leave-view.service.js';
import { ScheduleAttendanceService } from '../../src/scheduling/schedule-attendance.service.js';
import { TimeDomainService } from '../../src/time/time-domain.service.js';
import { TimeLeaveIntegration } from '../../src/time/time-leave.integration.js';
import { SystemClock, TimeService } from '../../src/time/time.service.js';
import {
  ALL_SCHEDULE_PERMISSIONS,
  ctx,
  schedulingServices,
  type SchedulingFixtures,
  type Tx,
} from './scheduling-fixtures.js';

export const LEAVE_PERMISSIONS = [
  'leave.request',
  'leave.read',
  'leave.approve',
  'leave.adjust',
  'leave.manage_policy',
  'holiday.manage',
] as const;

export const TIME_PERMISSIONS = [
  'time.clock',
  'time.view',
  'time.correct',
  'time.approve',
  'time.timesheet.approve',
  'time.timesheet.manage',
] as const;

/**
 * Users of the Phase 8 specs. self1/self2 are Employee 1/2 (request leave anywhere in Org A).
 * hr: every leave/holiday permission at Org A. teamApprover approves Team A only.
 * deptBReader reads Dept B leave. outsider holds everything in Org B.
 */
export const LEAVE_USERS = {
  admin: [{ permissions: ALL_SCHEDULE_PERMISSIONS, scope: 'org' as const }],
  self1: [
    { permissions: ['leave.request', 'time.clock'], scope: 'org' as const },
  ],
  self2: [
    { permissions: ['leave.request', 'time.clock'], scope: 'org' as const },
    { permissions: ['leave.approve', 'leave.read'], scope: 'teamA' as const },
  ],
  hr: [
    {
      permissions: [...LEAVE_PERMISSIONS, ...TIME_PERMISSIONS],
      scope: 'org' as const,
    },
  ],
  hr2: [{ permissions: [...LEAVE_PERMISSIONS], scope: 'org' as const }],
  teamApprover: [
    { permissions: ['leave.approve', 'leave.read'], scope: 'teamA' as const },
  ],
  deptBReader: [{ permissions: ['leave.read'], scope: 'deptB' as const }],
  outsider: [{ permissions: [...LEAVE_PERMISSIONS], scope: 'orgB' as const }],
  /** Scoped holiday managers: Dept B only, Team A only. */
  deptBHolidays: [{ permissions: ['holiday.manage'], scope: 'deptB' as const }],
  teamAHolidays: [{ permissions: ['holiday.manage'], scope: 'teamA' as const }],
};

export class FixedClock extends SystemClock {
  value = new Date('2027-03-02T14:00:00.000Z');
  override now() {
    return new Date(this.value);
  }
}

export function leaveServices(
  prisma: PrismaService,
  clock: SystemClock = new FixedClock(),
) {
  const svc = schedulingServices(prisma);
  const access = new LeaveAccessService(prisma, svc.authorization);
  const config = new LeaveConfigService(
    prisma,
    svc.authorization,
    access,
    svc.audit,
  );
  const ledger = new LeaveLedgerService(prisma, access, svc.audit);
  const holidays = new HolidayService(prisma, svc.authorization, svc.audit);
  const attendance = new ScheduleAttendanceService(
    prisma,
    svc.targets,
    svc.policyResolver,
  );
  const registry = new LeaveIntegrationRegistry();
  const requests = new LeaveRequestService(
    prisma,
    access,
    config,
    ledger,
    holidays,
    attendance,
    registry,
    svc.audit,
  );
  const views = new LeaveViewService(
    prisma,
    access,
    ledger,
    attendance,
    registry,
  );
  const entitlements = new LeaveEntitlementService(prisma, ledger);
  // Specs process entitlements as of 2026–2027 dates; the clock sits after them.
  entitlements.now = () => new Date('2030-01-01T12:00:00.000Z');
  const absences = new LeaveAbsenceSource(prisma);
  const time = new TimeService(
    prisma,
    new TimeDomainService(),
    svc.authorization,
    svc.targets,
    svc.audit,
    clock,
    attendance,
    absences,
  );
  const timeLeave = new TimeLeaveIntegration(registry, time);
  timeLeave.onModuleInit();
  return {
    ...svc,
    access,
    config,
    ledger,
    holidays,
    attendance,
    registry,
    requests,
    views,
    entitlements,
    absences,
    time,
  };
}

export type LeaveServices = ReturnType<typeof leaveServices>;

/** Org A gets a timezone; returns PAID vacation and UNPAID personal types with org policies. */
export async function seedLeaveConfig(
  tx: Tx,
  fx: SchedulingFixtures,
  svc: LeaveServices,
  policy: Record<string, unknown> = {},
) {
  await tx.organization.update({
    where: { id: fx.orgA },
    data: { timezone: 'America/Toronto' },
  });
  const hr = ctx(fx.users.hr!);
  const vacation = await svc.config.createType(
    {
      organizationId: fx.orgA,
      code: 'VAC',
      name: 'Vacation',
      classification: 'PAID',
    },
    hr,
  );
  const personal = await svc.config.createType(
    {
      organizationId: fx.orgA,
      code: 'PERS',
      name: 'Personal',
      classification: 'UNPAID',
      tracksBalance: false,
    },
    hr,
  );
  const vacationPolicy = await svc.config.createPolicy(
    {
      leaveTypeId: vacation.id,
      organizationId: fx.orgA,
      scopeType: 'ORGANIZATION',
      effectiveFrom: '2026-01-01',
      negativeBalanceLimitMinutes: 0,
      ...policy,
    } as never,
    hr,
  );
  const personalPolicy = await svc.config.createPolicy(
    {
      leaveTypeId: personal.id,
      organizationId: fx.orgA,
      scopeType: 'ORGANIZATION',
      effectiveFrom: '2026-01-01',
    } as never,
    hr,
  );
  return { vacation, personal, vacationPolicy, personalPolicy };
}

/** Grants minutes to an assignment's account through a manual adjustment. */
export async function grantMinutes(
  svc: LeaveServices,
  fx: SchedulingFixtures,
  employmentAssignmentId: string,
  leaveTypeId: string,
  minutes: number,
  effectiveDate = '2026-01-01',
) {
  return svc.ledger.adjust(
    {
      employmentAssignmentId,
      leaveTypeId,
      amountMinutes: minutes,
      effectiveDate,
      reason: 'Opening balance',
    },
    ctx(fx.users.hr!),
  );
}
