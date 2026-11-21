export type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export type LeaveClassification = 'PAID' | 'UNPAID';
export type LeaveDisplayUnit = 'HOURS' | 'DAYS';
export type LeaveDayAmountSource =
  'SCHEDULE' | 'STANDARD_DAY' | 'HOLIDAY_EXCLUDED' | 'NON_WORKDAY' | 'MANUAL_OVERRIDE';
export type LeaveLedgerEntryType =
  'GRANT' | 'ACCRUAL' | 'USAGE' | 'ADJUSTMENT' | 'CARRYOVER_FORFEIT' | 'EXPIRY' | 'REVERSAL';
export type LeavePolicyScopeType =
  'ORGANIZATION' | 'ORGANIZATIONAL_UNIT' | 'DEPARTMENT' | 'TEAM' | 'EMPLOYMENT_ASSIGNMENT';
export type LeaveAmountSource = 'SCHEDULE_THEN_STANDARD' | 'STANDARD_ONLY';
export type LeaveAccrualMethod = 'NONE' | 'ANNUAL_GRANT' | 'PERIODIC';
export type LeaveAccrualFrequency = 'MONTHLY' | 'SEMI_MONTHLY' | 'BIWEEKLY';
export type LeaveCarryoverMode = 'NONE' | 'CAPPED' | 'UNLIMITED';
export type HolidayKind = 'STATUTORY_HOLIDAY' | 'CLOSURE';
export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CASUAL' | 'CONTRACT';
export type Weekday =
  'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';

export interface LeavePage<T> {
  items: T[];
  nextAfterId: string | null;
}

export interface LeaveTypeSummary {
  id: string;
  code: string;
  name: string;
  classification: LeaveClassification;
  tracksBalance: boolean;
  displayUnit: LeaveDisplayUnit;
  /** Batch 6B (L1): an archived type's pending requests cannot be approved. */
  archived?: boolean;
}

export interface LeaveType extends LeaveTypeSummary {
  organizationId: string;
  description: string | null;
  archivedAt: string | null;
  actions?: { canEdit: boolean; canArchive: boolean };
}

/** Balances are minutes; `available` already subtracts approved future leave. */
export interface LeaveBalance {
  currentMinutes: number;
  scheduledMinutes: number;
  availableMinutes: number;
  pendingMinutes: number;
}

export interface LeaveEmployeeSummary {
  id: string;
  employeeNumber: string;
  displayName: string | null;
}

export interface MyLeaveOverview {
  employeeId: string;
  assignments: Array<{
    employmentAssignmentId: string;
    isPrimary: boolean;
    employmentType: EmploymentType;
    status: string;
    startDate: string;
    endDate: string | null;
    position: { id: string; name: string; code: string };
    organization: { id: string; name: string };
    timezone: string | null;
    asOf: string | null;
    leaveTypes: Array<{
      leaveType: LeaveTypeSummary;
      eligible: boolean;
      policy: {
        id: string;
        standardWorkdayMinutes: number;
        allowPartialDay: boolean;
        amountSource: LeaveAmountSource;
        negativeBalanceLimitMinutes: number;
        employeeMayCancelApprovedFuture: boolean;
      } | null;
      accountId: string | null;
      balance: LeaveBalance | null;
      actions: { canRequest: boolean };
    }>;
    actions: { canRequest: boolean };
  }>;
}

export interface LeaveRequestSummary {
  id: string;
  status: LeaveRequestStatus;
  employee: LeaveEmployeeSummary;
  employmentAssignmentId: string;
  positionName: string;
  leaveType: LeaveTypeSummary;
  startDate: string;
  endDate: string;
  startLocalTime: string | null;
  endLocalTime: string | null;
  timezone: string;
  requestedMinutes: number;
  approvedMinutes: number | null;
  activeMinutes: number | null;
  cancelledDayCount: number;
  submittedAt: string;
}

export interface MyLeaveRequest extends LeaveRequestSummary {
  actions: { canCancel: boolean };
}

export interface QueuedLeaveRequest extends LeaveRequestSummary {
  actions: { canApprove: boolean; canReject: boolean; canAmend: boolean };
}

export interface LeaveDay {
  date: string;
  minutes: number;
  amountSource: LeaveDayAmountSource;
  windowStart: string;
  windowEnd: string;
  absenceStart: string;
  absenceEnd: string;
  scheduledShiftRevisionIds: string[];
  holidayName: string | null;
  overrideReason: string | null;
  cancelled: boolean;
}

export interface LeaveLedgerEntry {
  id: string;
  accountId: string;
  entryType: LeaveLedgerEntryType;
  amountMinutes: number;
  effectiveDate: string;
  sourceType: string;
  policyId: string | null;
  leaveRequestId: string | null;
  leaveRequestDayId: string | null;
  reversesEntryId: string | null;
  reason: string | null;
  createdByUserId: string | null;
  postedAt: string;
}

/** A published shift the leave overlaps (Scheduling's expected-work fact plus the overlap). */
export interface CoveredShift {
  employeeId: string;
  employmentAssignmentId: string;
  scheduledShiftId: string;
  scheduledShiftRevisionId: string;
  revisionNumber: number;
  scheduleId: string;
  workLocationId: string | null;
  workDate: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  scheduledMinutes: number;
  overlapMinutes: number;
}

export interface LeaveRequestDetail extends LeaveRequestSummary {
  reason: string | null;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  requestedByUserId: string;
  /** `locked`: inside a locked time period, so the day can no longer be cancelled. */
  days: Array<LeaveDay & { id: string; cancelledByAmendmentId: string | null; locked: boolean }>;
  events: Array<{
    id: string;
    type: string;
    actorUserId: string | null;
    note: string | null;
    metadata: unknown;
    occurredAt: string;
  }>;
  amendments: Array<{
    id: string;
    type: string;
    reason: string;
    cancelledMinutes: number;
    actorUserId: string;
    createdAt: string;
  }>;
  ledgerEntries: LeaveLedgerEntry[];
  balance: Omit<LeaveBalance, 'pendingMinutes'> | null;
  coverage: { leaveRequestId: string; coveredShifts: CoveredShift[]; totalOverlapMinutes: number };
  actions: { canApprove: boolean; canReject: boolean; canAmend: boolean; canCancel: boolean };
}

export interface LeaveRequestInput {
  employmentAssignmentId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  startLocalTime?: string;
  endLocalTime?: string;
  reason?: string;
}

export interface LeavePreview {
  employmentAssignmentId: string;
  leaveType: LeaveType;
  timezone: string;
  startDate: string;
  endDate: string;
  partial: { startLocalTime: string; endLocalTime: string } | null;
  totalMinutes: number;
  days: LeaveDay[];
  balance:
    | (Omit<LeaveBalance, 'pendingMinutes'> & {
        pendingMinutes: number;
        /** The request's leave year; its balance is projected to that year's end. */
        leaveYear: { start: string; end: string };
        availableForLeaveYearMinutes: number;
        availableAfterMinutes: number;
        negativeBalanceLimitMinutes: number;
        sufficient: boolean;
      })
    | null;
}

export interface LeaveDecisionResult {
  requestId: string;
  status: LeaveRequestStatus;
  approvedMinutes?: number | null;
  cancelledMinutes?: number;
}

export interface LeaveDayOverride {
  date: string;
  minutes: number;
  reason: string;
}

export interface LeaveAmendInput {
  reason: string;
  cancelDates?: string[];
  cancelFrom?: string;
}

export interface LeaveOrganization {
  id: string;
  name: string;
  timezone: string | null;
  actions: {
    canReadRequests: boolean;
    canApprove: boolean;
    canViewBalances: boolean;
    canAdjust: boolean;
    canReadConfiguration: boolean;
    canManageTypes: boolean;
    canManagePolicies: boolean;
    canReadHolidays: boolean;
    canManageHolidays: boolean;
    /** holiday.manage at the organization: may add organization-wide (or any) holidays. */
    canManageOrganizationHolidays: boolean;
  };
  /** Scopes below the organization where the actor may add holidays (direct grants). */
  holidayScopes: Array<{
    type: 'ORGANIZATIONAL_UNIT' | 'DEPARTMENT' | 'TEAM';
    id: string;
    name: string;
  }>;
}

export interface LeaveBalanceRow {
  accountId: string;
  employee: LeaveEmployeeSummary;
  employmentAssignmentId: string;
  positionName: string;
  leaveType: LeaveTypeSummary;
  /** Null (with no balance) when the assignment's timezone does not resolve and no asOf was given. */
  asOf: string | null;
  timezoneUnresolved: boolean;
  balance: LeaveBalance | null;
  actions: { canAdjust: boolean };
}

export interface LeaveLedgerView {
  account: {
    id: string;
    employeeId: string;
    employmentAssignmentId: string;
    leaveType: Omit<LeaveTypeSummary, 'tracksBalance'>;
  };
  asOf: string;
  balance: Omit<LeaveBalance, 'pendingMinutes'>;
  entries: Array<
    LeaveLedgerEntry & { reversedByEntryId: string | null; actions: { canReverse: boolean } }
  >;
  actions: { canAdjust: boolean };
}

export interface LeaveAdjustmentInput {
  employmentAssignmentId: string;
  leaveTypeId: string;
  amountMinutes: number;
  effectiveDate: string;
  reason: string;
  idempotencyKey?: string;
}

export interface LeaveCalendar {
  range: { from: string; to: string };
  entries: Array<{
    requestId: string;
    status: LeaveRequestStatus;
    employee: LeaveEmployeeSummary;
    employmentAssignmentId: string;
    positionName: string;
    leaveType: LeaveTypeSummary;
    days: Array<{
      date: string;
      minutes: number;
      partial: boolean;
      windowStart: string;
      windowEnd: string;
    }>;
  }>;
  holidays: Array<{
    id: string;
    date: string;
    name: string;
    kind: HolidayKind;
    organizationalUnitId: string | null;
    departmentId: string | null;
    teamId: string | null;
  }>;
}

export interface Holiday {
  id: string;
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  date: string;
  name: string;
  kind: HolidayKind;
  archivedAt: string | null;
  actions?: { canEdit: boolean; canArchive: boolean };
}

export interface HolidayInput {
  organizationId: string;
  organizationalUnitId?: string;
  departmentId?: string;
  teamId?: string;
  date: string;
  name: string;
  kind: HolidayKind;
}

export interface LeaveTypeInput {
  organizationId: string;
  code: string;
  name: string;
  description?: string;
  classification: LeaveClassification;
  tracksBalance?: boolean;
  displayUnit?: LeaveDisplayUnit;
}

export interface LeavePolicySettings {
  name?: string;
  employmentTypes?: EmploymentType[];
  eligible?: boolean;
  waitingPeriodDays?: number;
  leaveYearStartMonth?: number;
  leaveYearStartDay?: number;
  amountSource?: LeaveAmountSource;
  standardWorkdayMinutes?: number;
  standardWorkdays?: Weekday[];
  excludeHolidays?: boolean;
  allowPartialDay?: boolean;
  accrualMethod?: LeaveAccrualMethod;
  annualGrantMinutes?: number | null;
  accrualFrequency?: LeaveAccrualFrequency | null;
  accrualMinutesPerPeriod?: number | null;
  accrualAnchorDate?: string | null;
  prorateFirstYear?: boolean;
  maxBalanceMinutes?: number | null;
  negativeBalanceLimitMinutes?: number;
  carryoverMode?: LeaveCarryoverMode;
  carryoverMaxMinutes?: number | null;
  carryoverExpiryDays?: number | null;
  employeeMayCancelApprovedFuture?: boolean;
}

export interface LeavePolicyInput extends LeavePolicySettings {
  leaveTypeId: string;
  organizationId: string;
  scopeType: LeavePolicyScopeType;
  organizationalUnitId?: string;
  departmentId?: string;
  teamId?: string;
  employmentAssignmentId?: string;
  effectiveFrom: string;
  effectiveTo?: string;
}

export interface LeavePolicy extends Required<Omit<LeavePolicySettings, 'name'>> {
  id: string;
  leaveTypeId: string;
  organizationId: string;
  scopeType: LeavePolicyScopeType;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  employmentAssignmentId: string | null;
  name: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  leaveType: LeaveType;
  /** Batch 6B (L7): who an assignment-scoped policy is for (listed policies only). */
  assignment?: { employeeName: string; employeeNumber: string; positionName: string } | null;
  actions?: { canEdit: boolean; canDelete: boolean; canEnd: boolean };
}

/** Batch 6B: recording leave for an employee (leave.approve), optionally approving at once. */
export interface LeaveOnBehalfInput extends LeaveRequestInput {
  approve?: boolean;
  note?: string;
}

/** Batch 6B: which policy applies to an assignment for a leave type on a date. */
export interface ResolvedLeavePolicy {
  date: string;
  policy: LeavePolicy | null;
  eligible: boolean;
}

/** Batch 6B (D4): the viewer's team, day by day — names and "Absent" only. */
export interface TeamCalendar {
  range: { from: string; to: string };
  teams: string[];
  hasTeam: boolean;
  people: Array<{
    displayName: string;
    self: boolean;
    absences: Array<{ date: string; label: 'Absent' }>;
  }>;
}

/** Batch 6B (D6): a holiday that applies to one of the viewer's own assignments. */
export interface MyHoliday {
  date: string;
  name: string;
  kind: HolidayKind;
  organizationName: string | null;
}
