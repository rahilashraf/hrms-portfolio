/**
 * Phase 7 Batch 10 — the narrow contracts other domains use with Scheduling. Scheduling owns
 * expected work: concrete published ScheduledShifts and their immutable revisions. These are
 * types and pure helpers only; no Leave, payroll, shift-change or coverage models exist yet.
 */

/**
 * One unit of published expected work: the latest immutable revision of an ACTIVE shift in a
 * PUBLISHED Schedule. Never a pattern or rule — recurrence is not visible outside Scheduling.
 */
export interface PublishedExpectedWorkFact {
  employeeId: string;
  employmentAssignmentId: string;
  scheduledShiftId: string;
  scheduledShiftRevisionId: string;
  revisionNumber: number;
  scheduleId: string;
  workLocationId: string | null;
  /** The local calendar date of startsAt in `timezone` (YYYY-MM-DD). */
  workDate: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  /** Computed from the stored instants, so DST days and overnight shifts are exact. */
  scheduledMinutes: number;
}

/** Expected work overlapping [start, end) for one employee (optionally one assignment). */
export interface PublishedExpectedWorkQuery {
  employeeId: string;
  employmentAssignmentId?: string;
  start: string;
  end: string;
}

export interface PublishedExpectedWorkSource {
  publishedExpectedWork(
    query: PublishedExpectedWorkQuery,
  ): Promise<PublishedExpectedWorkFact[]>;
}

/**
 * Future Leave/PTO contract. A Leave domain asks Scheduling which expected work an absence
 * request covers (to size it and show the affected shifts); Scheduling never reads Leave.
 * Approved absence reaches attendance interpretation only through Time & Attendance's
 * APPROVED_ABSENCE_SOURCE hook. Leave never cancels or edits shifts implicitly; if a business
 * rule wants shifts removed, it calls the published cancel workflow with a reason.
 */
export interface LeaveExpectedWorkRequest extends PublishedExpectedWorkQuery {
  /** The future Leave request id, for traceability only. */
  leaveRequestId: string;
}

export interface LeaveExpectedWorkCoverage {
  leaveRequestId: string;
  coveredShifts: Array<
    PublishedExpectedWorkFact & {
      /** Minutes of the shift inside the requested absence interval. */
      overlapMinutes: number;
    }
  >;
  totalOverlapMinutes: number;
}

/**
 * Future payroll contract. Payroll consumes expected-work facts (for scheduled-vs-paid review,
 * premiums keyed on scheduled time, or reporting) but never pays from schedules: paid time is
 * Time & Attendance's PayrollApprovedTimeOutput. Facts are always tied to an immutable revision
 * so a later schedule correction never changes what a closed payroll period saw.
 */
export interface PayrollExpectedWorkFact extends PublishedExpectedWorkFact {
  /** The workDate's payroll period, resolved by Time & Attendance's TimePeriod. */
  timePeriodId?: string | null;
}

/**
 * Future shift-change and coverage requests. A request is a proposal; applying it always goes
 * through existing published-change workflows with reasons and revisions:
 *   - CHANGE: correct shift A (same employee; times, location) → a CORRECTED revision.
 *   - COVERAGE: cancel shift A and add shift B for the covering assignment → a CANCELLED
 *     revision on A and a PUBLISHED_BASELINE on B. A published shift is never invisibly
 *     reassigned to another employee.
 */
export type ShiftChangeRequestType = 'CHANGE' | 'COVERAGE';

export type ShiftChangeRequestStatus =
  'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'APPLIED';

export interface ShiftChangeRequestContract {
  type: ShiftChangeRequestType;
  status: ShiftChangeRequestStatus;
  scheduleId: string;
  /** Shift A, pinned to the revision the requester saw (stale requests are rejected). */
  scheduledShiftId: string;
  basedOnRevisionId: string;
  requestedByUserId: string;
  reason: string;
  /** CHANGE only: the corrected fields of shift A. */
  change?: {
    startsAt?: string;
    endsAt?: string;
    workLocationId?: string | null;
  };
  /** COVERAGE only: the replacement shift B for the covering assignment. */
  coverage?: {
    coveringEmploymentAssignmentId: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
    workLocationId?: string | null;
  };
}

/** The two published-change steps a COVERAGE request applies, in order, in one transaction. */
export function coverageApplicationSteps(request: ShiftChangeRequestContract) {
  if (request.type !== 'COVERAGE' || !request.coverage) {
    throw new Error(
      'Only a COVERAGE request with a replacement shift has coverage steps.',
    );
  }
  if (!request.reason.trim()) {
    throw new Error('A coverage request requires a reason.');
  }
  return [
    {
      action: 'CANCEL_PUBLISHED_SHIFT' as const,
      scheduleId: request.scheduleId,
      scheduledShiftId: request.scheduledShiftId,
      expectedRevisionId: request.basedOnRevisionId,
      reason: request.reason,
    },
    {
      action: 'ADD_PUBLISHED_SHIFT' as const,
      scheduleId: request.scheduleId,
      employmentAssignmentId: request.coverage.coveringEmploymentAssignmentId,
      startsAt: request.coverage.startsAt,
      endsAt: request.coverage.endsAt,
      timezone: request.coverage.timezone,
      workLocationId: request.coverage.workLocationId ?? null,
      reason: request.reason,
    },
  ];
}

/** Minutes of [startsAt, endsAt) inside [start, end); 0 when they do not overlap. */
export function overlapMinutes(
  fact: { startsAt: string; endsAt: string },
  interval: { start: string; end: string },
): number {
  const from = Math.max(Date.parse(fact.startsAt), Date.parse(interval.start));
  const to = Math.min(Date.parse(fact.endsAt), Date.parse(interval.end));
  return to > from ? Math.round((to - from) / 60_000) : 0;
}
