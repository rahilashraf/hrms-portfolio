import type { EmployeeAssignmentView } from '../employee/types';

export type ClockState = 'OFF_CLOCK' | 'CLOCKED_IN' | 'ON_BREAK';
export type TimeAction =
  | 'CLOCK_IN'
  | 'CLOCK_OUT'
  | 'SWITCH_ASSIGNMENT'
  | 'START_BREAK'
  | 'END_BREAK'
  | 'RESOLVE_MISSED_CLOCK_OUT'
  | 'SIGN_IN'
  | 'SIGN_OUT';
export type TimeEntryStatus = 'OPEN' | 'CLOSED' | 'VOIDED';
export type TimeCorrectionStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'SUPERSEDED';
export type TimesheetStatus = 'OPEN' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'APPROVED' | 'LOCKED';
export type TimesheetSegmentStatus = 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED';

export interface TimePage<T> {
  items: T[];
  nextAfterId: string | null;
  /**
   * Batch 4F (C10): organizations of the rows shown (or, in My Time, of the caller) that have
   * Time & attendance turned off: their records are history, read only.
   */
  attendanceDisabledOrganizationIds?: string[];
}

export interface TimeQuery {
  search?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  type?: string;
  severity?: string;
  workflowImpact?: string;
  segmentStatus?: TimesheetSegmentStatus;
  limit?: number;
  afterId?: string;
  /** Batch 4E-1: server-side filters, applied within the reader's authorization. */
  organizationId?: string;
  employeeId?: string;
  timePeriodId?: string;
  /** Batch 4F (C10): managers opt in to the history of organizations with attendance off. */
  includeDisabledOrganizations?: boolean;
}

/** Batch 4E-1: display names of the users a management record references (null: unknown). */
export type ActorNames = Record<string, string | null>;

/** A published shift open for clock-in now (offered when the time clock must not guess). */
export interface ClockInShiftOption {
  scheduledShiftId: string;
  employmentAssignmentId: string;
  workDate: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
}

export interface TimeStatus {
  state: ClockState;
  serverTime: string;
  currentTimeEntry: {
    id: string;
    employmentAssignmentId: string;
    clockedInAt: string;
    timezone: string;
    workDate: string;
  } | null;
  currentAssignment: EmployeeAssignmentView | null;
  /** Every assignment the open interval covers, payroll owner first. */
  currentCoverage?: TimeEntryCoverage[];
  currentBreakEntry: {
    id: string;
    timeEntryId: string;
    startedAt: string;
    payType: string | null;
  } | null;
  breakStartedAt: string | null;
  clockedInAt: string | null;
  eligibleAssignments: EmployeeAssignmentView[];
  activeExceptions: TimeException[];
  availableActions: TimeAction[];
  /** Published shifts open for clock-in now; several on one assignment need an explicit choice. */
  scheduledShiftOptions?: ClockInShiftOption[];
  scheduledShiftSelectionRequired?: boolean;
  /** The only published shift open now, which the time clock links on its own. */
  preselectedScheduledShiftId?: string | null;
  /** The assignment that shift (or the single eligible assignment) belongs to. */
  preselectedEmploymentAssignmentId?: string | null;
  /** R4-A.3: what the time clock flagged about this action (e.g. no published shift). */
  warnings?: TimeActionWarning[];
  /** Phase 9.5: SIGN_IN_ONLY assignments this channel may sign in for now. */
  signInAssignments?: EmployeeAssignmentView[];
  /** Batch 4D: SIGN_IN_ONLY assignments with an open sign-in to sign out of (when enabled). */
  signOutAssignments?: EmployeeAssignmentView[];
  /** Batch 4E-3 (C1): every active assignment, how attendance is recorded there and why not. */
  assignmentCapabilities?: AssignmentCapability[];
  /** Batch 4E-3 (C7): published occurrences open for sign-in now. */
  signInOptions?: SignInOption[];
  /** Phase 9.5: how each active assignment captures attendance. */
  attendanceModes?: Array<{
    employmentAssignmentId: string;
    trackingMode: 'TIME_CLOCK' | 'SIGN_IN_ONLY';
    captureMode: 'KIOSK_ONLY' | 'SELF_SERVICE' | 'KIOSK_OR_SELF_SERVICE';
  }>;
}

/** Batch 4E-3 (C1): one active assignment's attendance setup for the employee. */
export interface AssignmentCapability {
  employmentAssignmentId: string;
  position: { id: string; name: string };
  organization: { id: string; name: string };
  timezone: string | null;
  attendanceEnabled: boolean;
  clockEnabled: boolean;
  canCapture: boolean;
  trackingMode: 'TIME_CLOCK' | 'SIGN_IN_ONLY' | null;
  captureMode: 'KIOSK_ONLY' | 'SELF_SERVICE' | 'KIOSK_OR_SELF_SERVICE' | null;
  selfServiceCapture: boolean;
  kioskLocationRule: string | null;
  signOutEnabled: boolean;
  breakMode: string | null;
  assignmentSwitching: boolean;
  correctionRequestsEnabled: boolean;
  missedPunchSelfResolutionEnabled: boolean;
  allowEarlySubmission: boolean;
  unavailableReason:
    | 'ATTENDANCE_DISABLED'
    | 'NO_TIMEZONE'
    | 'CLOCK_DISABLED'
    | 'NO_PERMISSION'
    | 'KIOSK_ONLY'
    | null;
  explanation: string | null;
}

/** Batch 4E-3 (C7): a published occurrence the employee may confirm presence for now. */
export interface SignInOption extends ClockInShiftOption {
  clockInOpensAt: string;
  clockInClosesAt: string;
  signIn: { id: string; signedInAt: string } | null;
}

export type ExpectedAttendanceStatus =
  | 'UPCOMING'
  | 'DUE'
  | 'ATTENDED'
  | 'LATE'
  | 'MISSING'
  | 'NOT_RECORDED'
  | 'EXCUSED'
  | 'CANCELLED'
  | 'CHANGED_AFTER_ATTENDANCE';

/** Batch 4E-3 (C8): one of the employee's published shifts and what attendance recorded. */
export interface ExpectedAttendanceItem {
  scheduledShiftId: string;
  scheduledShiftRevisionId: string;
  revisionNumber: number;
  shiftStatus: 'ACTIVE' | 'CANCELLED';
  employmentAssignmentId: string;
  position: { id: string; name: string };
  organization: { id: string; name: string };
  workDate: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  trackingMode: 'TIME_CLOCK' | 'SIGN_IN_ONLY' | null;
  status: ExpectedAttendanceStatus;
  minutesAfterStart: number | null;
  signIn: {
    id: string;
    signedInAt: string;
    source: string;
    signedOutAt: string | null;
  } | null;
  timeEntries: Array<{
    id: string;
    clockInAt: string;
    clockOutAt: string | null;
    status: string;
  }>;
  exceptions: Array<{ id: string; type: string; status: string }>;
}

export interface TimeException {
  id: string;
  type: string;
  severity: string;
  workflowImpact: string;
  status: string;
  timeEntryId: string | null;
  employmentAssignmentId: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  reason: string | null;
  metadata?: unknown;
  employeeNumber?: string;
  employeeName?: string;
  workDate?: string | null;
  timezone?: string | null;
  assignment?: EmployeeAssignmentView | null;
  /** Batch 4C review: how and by whom it was closed. */
  employeeId?: string;
  resolutionMethod?:
    | 'SYSTEM_AUTO_RESOLUTION'
    | 'EMPLOYEE_RESOLUTION'
    | 'MANAGER_RESOLUTION'
    | 'ADMIN_RESOLUTION'
    | null;
  resolvedByUserId?: string | null;
  resolutionNote?: string | null;
  scheduledShiftId?: string | null;
  /** R4-A.5: for SCHEDULE_CHANGED_AFTER_ATTENDANCE, the changed shift's schedule (to open its revisions). */
  changedShiftScheduleId?: string | null;
  /** Batch 4E-3 (C4): the sign-in it is about (presence). */
  attendanceSignInId?: string | null;
  actors?: ActorNames;
}

export interface TimeCorrection {
  id: string;
  employeeId: string;
  employeeNumber?: string;
  employeeName?: string;
  requestorUserId: string;
  reviewerUserId: string | null;
  timeEntryId: string | null;
  breakEntryId: string | null;
  employmentAssignmentId: string | null;
  targetEmploymentAssignmentId: string | null;
  type: string;
  status: TimeCorrectionStatus;
  reason: string;
  reviewerNote: string | null;
  requestedValues: unknown;
  currentValues: unknown;
  requestedAt: string;
  reviewedAt: string | null;
  cancelledAt: string | null;
  adjustmentId: string | null;
  workDate?: string | null;
  timezone?: string | null;
  assignment?: EmployeeAssignmentView | null;
  targetAssignment?: EmployeeAssignmentView | null;
  actors?: ActorNames;
}

/**
 * Multi-assignment attendance: an assignment one physical interval covers. The interval's time
 * is counted once and paid to its payroll owner only; other covered assignments add no time.
 */
export interface TimeEntryCoverage {
  employmentAssignmentId: string;
  assignment: EmployeeAssignmentView;
  isPayrollOwner: boolean;
}

export interface TimeEntryRead {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  employmentAssignmentId: string;
  assignment: EmployeeAssignmentView;
  workDate: string;
  clockInAt: string;
  clockOutAt: string | null;
  timezone: string;
  status: TimeEntryStatus;
  source: string;
  grossMinutes: number | null;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  breakMinutes: number;
  netWorkedMinutes: number | null;
  /**
   * Batch 4E-1 (management rows): the automatic deduction allocated to this entry and its
   * payable minutes, from the same calculation timesheets use. Null for open or voided entries.
   */
  policyDeductionMinutes?: number | null;
  payableMinutes?: number | null;
  scheduledShiftId?: string | null;
  breaks?: Array<{ id: string; startAt: string; endAt: string | null; payType: string | null }>;
  /** Payroll owner first; absent from older API responses. */
  coverage?: TimeEntryCoverage[];
  exceptions: TimeException[];
  corrections: Array<{
    id: string;
    type: string;
    status: TimeCorrectionStatus;
    requestedAt: string;
    reviewedAt: string | null;
    adjustmentId: string | null;
  }>;
}

export interface TimesheetSegment {
  id: string;
  employmentAssignmentId: string;
  status: TimesheetSegmentStatus;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  reviewerNote: string | null;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  policyDeductionMinutes: number;
  netWorkedMinutes: number;
  approvedWorkedMinutes: number;
  calculatedAt: string | null;
  assignment: EmployeeAssignmentView | null;
}

export interface Timesheet {
  id: string;
  employeeId: string;
  timePeriodId: string;
  status: TimesheetStatus;
  submittedByUserId: string | null;
  submittedAt: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  lockedByUserId: string | null;
  lockedAt: string | null;
  reopenedByUserId: string | null;
  reopenedAt: string | null;
  reviewerNote: string | null;
  version: number;
  totals: Record<string, number> | null;
  period: {
    id: string;
    organizationId: string;
    startDate: string;
    endDate: string;
    status: string;
    cadence: string;
    openedAt: string | null;
    closedAt: string | null;
    lockedAt: string | null;
  } | null;
  segments: TimesheetSegment[];
  /** Batch 4F (C10): GET /time/me/timesheets/:id — false when attendance is turned off. */
  attendanceEnabled?: boolean;
  /** Management lists (Batch 4C/4E-1). */
  employee?: { id: string; employeeNumber: string; name: string };
  actors?: ActorNames;
  events: Array<{
    id: string;
    segmentId: string | null;
    actorUserId: string | null;
    type: string;
    note: string | null;
    metadata: unknown;
    occurredAt: string;
  }>;
}

export interface CorrectionRequestInput {
  type: string;
  reason: string;
  timeEntryId?: string;
  breakEntryId?: string;
  employmentAssignmentId?: string;
  targetEmploymentAssignmentId?: string;
  clockInAt?: string;
  clockOutAt?: string;
  breakStartAt?: string;
  breakEndAt?: string;
  startAt?: string;
  endAt?: string;
}

/** Batch 4C — a time period (GET /time/periods). */
export interface TimePeriod {
  id: string;
  organizationId: string;
  startDate: string;
  endDate: string;
  status: 'UPCOMING' | 'OPEN' | 'CLOSED' | 'LOCKED';
  cadence: string;
  openedAt: string | null;
  closedAt: string | null;
  lockedAt: string | null;
  payrollManaged: boolean;
  timesheetCount: number;
  /** Batch 4F (C10): false for a period of an organization with attendance turned off. */
  attendanceEnabled?: boolean;
}

export interface MaterializeResult {
  created: number;
  existing: number;
  finalized: number;
  timesheetIds: string[];
}

/** One time of a repeated local time on a daylight-saving day (409 TIME_LOCAL_TIME_AMBIGUOUS). */
export interface LocalTimeOccurrence {
  instant: string;
  offset: string;
  value: string;
}

export interface ManagerEntryInput {
  employmentAssignmentId: string;
  startAt: string;
  endAt: string;
  reason: string;
}

export interface DirectCorrectionInput {
  type: string;
  reason: string;
  clockInAt?: string;
  clockOutAt?: string;
  /** R4-A.4 (CHANGE_COVERAGE): the full set of assignments covered besides the payroll owner. */
  additionalEmploymentAssignmentIds?: string[];
}

/** Batch 4F (Q3): a capped list says so; never present partial results as complete. */
export interface Truncation {
  truncated?: boolean;
  limit?: number;
}

/** Batch 4F (Q8): one work date and assignment, published shifts vs authoritative actual time. */
export interface ScheduledVsActualRow {
  workDate: string;
  employeeId: string;
  employmentAssignmentId: string;
  employeeNumber: string | null;
  employeeName: string | null;
  positionName: string | null;
  scheduledShiftCount: number;
  scheduledMinutes: number;
  scheduledShiftIds: string[];
  closedEntryCount: number;
  openEntryCount: number;
  grossMinutes: number;
  actualMinutes: number;
  linkedActualMinutes: number;
  unscheduledActualMinutes: number;
  varianceMinutes: number;
}

export interface ScheduledVsActualQuery {
  organizationId: string;
  from: string;
  to: string;
  organizationalUnitId?: string;
  departmentId?: string;
  teamId?: string;
  employeeId?: string;
  employmentAssignmentId?: string;
  afterKey?: string;
  limit?: number;
}

export interface ScheduledVsActualResponse {
  range: { from: string; to: string };
  rows: ScheduledVsActualRow[];
  nextAfterKey: string | null;
}

/** Batch 4F (Q8): POST /time/entries/:id/scheduled-shift — the entry's link after the change. */
export interface ScheduleLinkResult {
  timeEntryId: string;
  scheduledShiftId: string | null;
  scheduledShiftRevisionId: string | null;
  revisionNumber: number | null;
  changed: boolean;
}

/** R4-A.3: a non-blocking flag returned by clock-in or switch; the action was recorded. */
export interface TimeActionWarning {
  code: string;
  message?: string;
  attendanceExceptionId?: string;
}
