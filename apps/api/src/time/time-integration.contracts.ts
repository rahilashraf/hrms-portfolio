export type ExpectedWorkSourceType = 'POLICY' | 'SCHEDULE';
export type ApprovedAbsenceClassification = 'PAID' | 'UNPAID';
export type ApprovedTimeFinalizationStatus = 'APPROVED' | 'LOCKED';

export interface ExpectedWorkContext {
  employmentAssignmentId: string;
  expectedStart: string;
  expectedEnd: string;
  sourceType: ExpectedWorkSourceType;
  sourceId?: string | null;
}

export interface ApprovedAbsenceInterval {
  employeeId: string;
  employmentAssignmentId?: string | null;
  start: string;
  end: string;
  classification?: ApprovedAbsenceClassification | null;
  sourceId: string;
}

/**
 * Leave/PTO hook (bound by the Phase 8 Leave module). Time & Attendance asks for approved
 * absence overlapping an expected-work interval and trims the expectation by it (see
 * trimExpectedWorkForAbsences): approved leave is absence, never worked time.
 */
export const APPROVED_ABSENCE_SOURCE = Symbol('APPROVED_ABSENCE_SOURCE');

export interface ApprovedAbsenceSource {
  /**
   * `client` is the caller's database transaction, so absence decided earlier in the same
   * transaction is visible. Implementations fall back to their own connection without it.
   */
  approvedAbsences(
    query: {
      employeeId: string;
      start: string;
      end: string;
    },
    client?: unknown,
  ): Promise<ApprovedAbsenceInterval[]>;
}

export interface PayrollApprovedTimeOutput {
  employeeId: string;
  employmentAssignmentId: string;
  timePeriodId: string;
  workDate: string;
  approvedWorkedMinutes: number;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  policyDeductionMinutes: number;
  finalizationStatus: ApprovedTimeFinalizationStatus;
  timesheetId: string;
  timesheetSegmentId: string;
  timesheetVersion: number;
}

export function approvedAbsenceOverlapsExpectedWork(
  expected: ExpectedWorkContext,
  absence: ApprovedAbsenceInterval,
): boolean {
  if (
    absence.employmentAssignmentId &&
    absence.employmentAssignmentId !== expected.employmentAssignmentId
  ) {
    return false;
  }
  const expectedStart = parseContractInstant(
    expected.expectedStart,
    'expectedStart',
  );
  const expectedEnd = parseContractInstant(expected.expectedEnd, 'expectedEnd');
  const absenceStart = parseContractInstant(absence.start, 'absence.start');
  const absenceEnd = parseContractInstant(absence.end, 'absence.end');
  if (expectedEnd.getTime() <= expectedStart.getTime()) {
    throw new Error('Expected work end must be after start.');
  }
  if (absenceEnd.getTime() <= absenceStart.getTime()) {
    throw new Error('Approved absence end must be after start.');
  }
  return (
    absenceStart.getTime() < expectedEnd.getTime() &&
    absenceEnd.getTime() > expectedStart.getTime()
  );
}

function parseContractInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return parsed;
}

/**
 * The part of an expected-work window that approved absence does not cover. Absence covering
 * the expected start moves the start to the absence end (a morning appointment: lateness is
 * judged from its end); absence covering the expected end moves the end to the absence start
 * (leaving early for leave is not an early departure). A window covered entirely yields null:
 * no expectation at all. Absence strictly inside the window changes neither bound. Absence of
 * another assignment of the same employee is ignored.
 */
export function trimExpectedWorkForAbsences(
  expected: ExpectedWorkContext,
  absences: readonly ApprovedAbsenceInterval[],
): { expectedStart: string; expectedEnd: string } | null {
  let start = parseContractInstant(
    expected.expectedStart,
    'expectedStart',
  ).getTime();
  let end = parseContractInstant(expected.expectedEnd, 'expectedEnd').getTime();
  const relevant = absences
    .filter(
      (absence) =>
        !absence.employmentAssignmentId ||
        absence.employmentAssignmentId === expected.employmentAssignmentId,
    )
    .map((absence) => ({
      start: parseContractInstant(absence.start, 'absence.start').getTime(),
      end: parseContractInstant(absence.end, 'absence.end').getTime(),
    }))
    .filter((absence) => absence.end > absence.start);
  for (let moved = true; moved && start < end;) {
    moved = false;
    for (const absence of relevant) {
      if (absence.start <= start && absence.end > start) {
        start = absence.end;
        moved = true;
      }
      if (absence.start < end && absence.end >= end) {
        end = absence.start;
        moved = true;
      }
    }
  }
  if (start >= end) return null;
  return {
    expectedStart: new Date(start).toISOString(),
    expectedEnd: new Date(end).toISOString(),
  };
}

/**
 * Phase 9.5 — presence facts for Payroll and reporting (Phase 10). A sign-in states that the
 * employee attended a work occurrence at an instant; it has no end and no duration. Payroll may
 * use presence for attendance compliance or salaried presence, but must never derive worked
 * minutes (or pay time) from it: SIGN_IN_ONLY attendance is not in PayrollApprovedTimeOutput.
 */
export const ATTENDANCE_PRESENCE_SOURCE = Symbol('ATTENDANCE_PRESENCE_SOURCE');

export interface AttendancePresenceFact {
  signInId: string;
  employeeId: string;
  employmentAssignmentId: string;
  /** Local date (YYYY-MM-DD) in the assignment's timezone. */
  workDate: string;
  signedInAt: string;
  timezone: string;
  /** KIOSK (trusted device), LIVE_CLOCK (self-service), MANUAL (recorded by a manager). */
  source: 'KIOSK' | 'LIVE_CLOCK' | 'MANUAL' | 'SYSTEM';
  scheduledShiftId: string | null;
  scheduledShiftRevisionId: string | null;
}

export interface AttendancePresenceSource {
  /** ACTIVE (not voided) sign-ins of an assignment with work dates in [from, to]. */
  presenceFactsBetween(
    query: { employmentAssignmentId: string; from: string; to: string },
    client?: unknown,
  ): Promise<AttendancePresenceFact[]>;
}

/**
 * Phase 10 — what Payroll asks of Time. Time owns TimePeriods and timesheets: Payroll requests
 * the TimePeriod matching a pay period and the timesheets of the employees it will pay, and Time
 * creates them with its own rules. Never approves, locks or changes time.
 */
export const PAYROLL_TIME_SOURCE = Symbol('PAYROLL_TIME_SOURCE');

export type PayrollTimePeriodCadence =
  'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';

export interface PayrollTimeSource {
  /**
   * The organization's TimePeriod for exactly [startDate, endDate] (YYYY-MM-DD), created OPEN if
   * missing, in the caller's transaction. Idempotent and safe under concurrency (one TimePeriod
   * per organization and dates; pay groups with the same dates share it).
   */
  ensureTimePeriod(
    client: unknown,
    input: {
      organizationId: string;
      startDate: string;
      endDate: string;
      cadence: PayrollTimePeriodCadence;
      payrollPeriodId: string | null;
    },
    context: {
      actorUserId?: string;
      userAgent?: string;
      correlationId?: string;
    },
  ): Promise<{ timePeriodId: string; created: boolean }>;

  /**
   * Materializes (creates if missing, then recomputes while still mutable) the employee's
   * timesheet of the TimePeriod in its own transaction. Approved or locked timesheets are never
   * touched. Idempotent and retryable.
   */
  ensureTimesheet(input: {
    employeeId: string;
    timePeriodId: string;
  }): Promise<{ timesheetId: string; status: string; created: boolean }>;

  /**
   * The employee's timesheet of the TimePeriod, or null when none exists. `workDates` are the
   * approved work-date outputs frozen at approval (APPROVED or LOCKED only; empty otherwise):
   * the only worked time Payroll may pay.
   */
  payrollTimesheet(
    query: { employeeId: string; timePeriodId: string },
    client?: unknown,
  ): Promise<PayrollTimesheetFact | null>;

  /**
   * Time facts of one assignment over [from, to]: its attendance timezone (null when it cannot
   * be resolved), its tracking mode per date, and how many time entries it has (closed and
   * still open) — so Payroll can tell "no time" from "time not yet approved".
   */
  payrollAssignmentTime(
    query: { employmentAssignmentId: string; from: string; to: string },
    client?: unknown,
  ): Promise<PayrollAssignmentTimeFact>;
}

export interface PayrollTimesheetFact {
  timesheetId: string;
  employeeId: string;
  timePeriodId: string;
  status: 'OPEN' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'APPROVED' | 'LOCKED';
  version: number;
  finalizationStatus: ApprovedTimeFinalizationStatus | null;
  workDates: PayrollApprovedTimeOutput[];
  segments: Array<{
    timesheetSegmentId: string;
    employmentAssignmentId: string;
    status: string;
  }>;
}

export interface PayrollAssignmentTimeFact {
  timezone: string | null;
  days: Array<{
    date: string;
    trackingMode: 'TIME_CLOCK' | 'SIGN_IN_ONLY' | null;
  }>;
  closedEntries: number;
  openEntries: number;
}
