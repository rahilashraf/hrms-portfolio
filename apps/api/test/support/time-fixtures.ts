import { LeaveAbsenceSource } from '../../src/leave/leave-integration.js';
import { ScheduleAttendanceService } from '../../src/scheduling/schedule-attendance.service.js';
import { TimeDomainService } from '../../src/time/time-domain.service.js';
import { SystemClock, TimeService } from '../../src/time/time.service.js';
import { schedulingServices, type Tx } from './scheduling-fixtures.js';

export const TIME_PERMISSIONS = [
  'time.clock',
  'time.view',
  'time.correct',
  'time.approve',
  'time.timesheet.approve',
  'time.timesheet.manage',
] as const;

/** Live clocking with breaks, switching, missed-punch detection and employee corrections. */
export const LIVE_TIME_POLICY = {
  clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
  breaks: { mode: 'MANUAL_PUNCH' },
  missedPunch: {
    enabled: true,
    maxOpenDurationMinutes: 600,
    detectionGraceMinutes: 0,
    employeeResolutionEnabled: true,
  },
  correction: { employeeRequestsEnabled: true },
};

/** America/Toronto is EST (-05:00) in early March 2027. */
export const toronto = (local: string) => new Date(`${local}:00-05:00`);

/**
 * Batch 4A: timesheets are submitted and approved once their period has ended. Moves the clock to
 * noon UTC the day after `endDate` (YYYY-MM-DD or a date column), past its end in every timezone.
 */
export function afterPeriodEnd(clock: FixedClock, endDate: string | Date) {
  const day =
    typeof endDate === 'string' ? endDate : endDate.toISOString().slice(0, 10);
  clock.value = new Date(Date.parse(`${day}T00:00:00.000Z`) + 36 * 3_600_000);
}

export class FixedClock extends SystemClock {
  value = toronto('2027-03-02T09:00');
  override now() {
    return new Date(this.value);
  }
}

/** Time, Scheduling and authorization services over one (rollback) client and a fixed clock. */
export function timeServices(
  client: Parameters<typeof schedulingServices>[0],
  clock: SystemClock,
  /** Batch 4C: bind Leave's approved absences, as the API and worker do. */
  options: { absences?: boolean } = {},
) {
  const svc = schedulingServices(client);
  const schedules = new ScheduleAttendanceService(
    client,
    svc.targets,
    svc.policyResolver,
  );
  const time = new TimeService(
    client,
    new TimeDomainService(),
    svc.authorization,
    svc.targets,
    svc.audit,
    clock,
    schedules,
    options.absences ? new LeaveAbsenceSource(client) : undefined,
  );
  return { ...svc, schedules, time };
}

export async function seedTimePolicy(
  tx: Tx,
  organizationId: string,
  config: Record<string, unknown> = LIVE_TIME_POLICY,
) {
  return tx.timeAttendancePolicy.create({
    data: {
      scopeType: 'ORGANIZATION',
      organizationId,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      config: config as object,
    },
  });
}
