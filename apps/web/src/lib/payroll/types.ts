/** Phase 10 Payroll read and write models (mirror the API; money is a decimal string). */

export type PayrollCadence = 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY';
export type PayrollPeriodStatus = 'UPCOMING' | 'OPEN' | 'PROCESSING' | 'FINALIZED';
export type PayrollRunStatus = 'DRAFT' | 'CALCULATED' | 'APPROVED' | 'FINALIZED' | 'VOIDED';
export type PayrollIssueSeverity = 'ERROR' | 'WARNING' | 'INFO';
export type ManualLineKind = 'EARNING' | 'DEDUCTION' | 'CONTRIBUTION';
export type PayrollAdjustmentStatus = 'PENDING' | 'APPLIED' | 'CANCELLED';

export interface PayrollActions {
  canRead: boolean;
  canManage: boolean;
  canCalculate: boolean;
  canApprove: boolean;
  canFinalize: boolean;
  canAdjust: boolean;
}

export interface PayrollOrganization {
  id: string;
  name: string;
  code: string;
  timezone: string | null;
  actions: PayrollActions;
}

export interface PayrollCalendar {
  id: string;
  organizationId: string;
  payGroupId: string;
  cadence: PayrollCadence;
  timezone: string;
  anchorDate: string;
  payDateOffsetDays: number;
  processingCutoffOffsetDays: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  salaryUnpaidLeaveRule: 'UNCONFIGURED' | 'HOURLY_EQUIVALENT';
  salaryStandardAnnualHours: string | null;
  periodCount: number;
  payGroup?: { id: string; code: string; name: string };
  actions?: { canUpdate: boolean; canEnd: boolean };
}

export interface SalaryUnpaidLeaveRuleInput {
  rule: 'UNCONFIGURED' | 'HOURLY_EQUIVALENT';
  standardAnnualHours: string | null;
}

export interface PayrollPayGroup {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  archived: boolean;
  periodCount: number;
  currentCalendar: PayrollCalendar | null;
}

export interface PayrollPeriod {
  id: string;
  organizationId: string;
  payGroupId: string;
  payrollCalendarId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  processingCutoffAt: string;
  timezone: string;
  status: PayrollPeriodStatus;
  timePeriodId: string;
  timesheetsMaterializedAt: string | null;
  payGroup?: { code: string; name: string };
}

export interface PayrollTotals {
  grossAmount: string | null;
  deductionAmount: string | null;
  employerContributionAmount: string | null;
  netAmount: null;
  netStatus: 'STATUTORY_NOT_CALCULATED' | 'CALCULATED';
}

export interface PayrollRunSummary {
  id: string;
  organizationId: string;
  status: PayrollRunStatus;
  currency: string;
  payGroup: { id: string; code: string; name: string };
  period: {
    id: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    status: PayrollPeriodStatus;
    timezone: string;
  };
  calculatedAt: string | null;
  calculationVersion: string | null;
  sourceFingerprint: string | null;
  approvedAt: string | null;
  finalizedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  statutoryStatus: 'NOT_CALCULATED' | 'CALCULATED';
  totals: PayrollTotals;
  employeeCount?: number;
}

export interface PayrollRunAssignmentSummary {
  id: string;
  employmentAssignmentId: string;
  positionName: string;
  employmentType: string;
  grossAmount: string | null;
  deductionAmount: string | null;
  employerContributionAmount: string | null;
}

export interface PayrollRunEmployeeSummary {
  id: string;
  employeeId: string;
  employeeNumber: string;
  displayName: string;
  grossAmount: string | null;
  deductionAmount: string | null;
  employerContributionAmount: string | null;
  assignments: PayrollRunAssignmentSummary[];
}

/**
 * Security remediation M2: why the viewer cannot approve or finalize (server-decided; the
 * buttons only mirror it).
 */
export type PayrollBlockedReason =
  | 'OWN_PAY'
  | 'APPROVER_NOT_ELIGIBLE'
  | 'CALCULATOR_UNKNOWN_RECALCULATE'
  | 'CALCULATED_BY_YOU'
  | 'ADJUSTMENT_BY_YOU'
  | 'ADJUSTMENT_CANCELLED_BY_YOU'
  | 'MANUAL_LINE_BY_YOU'
  | 'COMPENSATION_CHANGED_BY_YOU'
  | 'INDEPENDENT_APPROVAL_REQUIRED';

export interface PayrollRunActor {
  userId: string;
  name: string | null;
}

export interface PayrollRunDetail extends PayrollRunSummary {
  organization: { id: string; name: string };
  /** M2: the organization's payroll dual control (absent on older API versions). */
  dualControl?: boolean;
  calculatedBy?: PayrollRunActor | null;
  approvedBy?: PayrollRunActor | null;
  finalizedBy?: PayrollRunActor | null;
  issueCounts: Record<PayrollIssueSeverity, number>;
  employees: PayrollRunEmployeeSummary[];
  actions: {
    canCalculate: boolean;
    canApprove: boolean;
    approveBlockedReason?: PayrollBlockedReason | null;
    canFinalize: boolean;
    finalizeBlockedReason?: PayrollBlockedReason | null;
    canVoid: boolean;
    canAddManualLines: boolean;
    canAdjust: boolean;
  };
}

export interface PayrollIssue {
  id: string;
  severity: PayrollIssueSeverity;
  code: string;
  message: string;
  metadata: unknown;
  employee?: { displayName: string; employeeNumber: string } | null;
  assignment?: { positionName: string; employmentAssignmentId: string } | null;
}

export interface PayrollEarningLine {
  id: string;
  origin: 'CALCULATED' | 'MANUAL' | 'ADJUSTMENT';
  type: string;
  description: string;
  workDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  quantity: string | null;
  quantityUnit: 'MINUTES' | 'CALENDAR_DAYS' | null;
  rateAmount: string | null;
  amount: string;
  currency: string;
  calculationRule: string;
  reason: string | null;
  reversesLineId: string | null;
}

export interface PayrollOtherLine {
  id: string;
  category: string;
  code: string | null;
  description: string;
  amount: string;
  currency: string;
  reason: string | null;
  reversesLineId: string | null;
}

export interface PayrollEmployeeDetail {
  id: string;
  employeeId: string;
  employeeNumber: string;
  displayName: string;
  grossAmount: string | null;
  deductionAmount: string | null;
  employerContributionAmount: string | null;
  assignments: Array<
    PayrollRunAssignmentSummary & {
      timezone: string | null;
      sourceFingerprint: string | null;
      earnings: PayrollEarningLine[];
      deductions: PayrollOtherLine[];
      employerContributions: PayrollOtherLine[];
      issues: Array<{ id: string; severity: PayrollIssueSeverity; code: string; message: string }>;
    }
  >;
}

export interface PayrollFreshness {
  stale: boolean;
  calculated: boolean;
  changedAssignmentIds: string[];
}

export interface PayrollAdjustment {
  id: string;
  payGroupId: string;
  employeeId: string;
  employmentAssignmentId: string;
  currency: string;
  kind: 'EARNING' | 'DEDUCTION';
  amount: string;
  description: string;
  reason: string;
  status: PayrollAdjustmentStatus;
  sourceRunId: string | null;
  payrollRunId: string | null;
  retroactive: boolean;
  createdAt: string;
  displayName?: string;
  employeeNumber?: string;
  positionName?: string;
}

export interface RetroDifference {
  employmentAssignmentId: string;
  displayName: string | null;
  blocked: boolean;
  blockingCodes: string[];
  finalizedGross: string;
  currentGross: string;
  alreadyAdjusted: string;
  difference: string;
  /** Phase 11: benefit costs, finalized vs current (shown only). */
  benefits?: {
    finalizedDeductions: string;
    currentDeductions: string;
    finalizedContributions: string;
    currentContributions: string;
  };
  /**
   * Batch 7C (C2): the benefit cost difference (current − finalized), never resolved
   * automatically; `resolved` once a person resolved it at the current sources.
   */
  benefitDifference?: {
    employeeDeductions: string;
    employerContributions: string;
    resolved: boolean;
  };
  /** Batch 7C: e.g. BENEFIT_DIFFERENCE_UNRESOLVED. */
  warnings?: string[];
  lines: Array<{
    type: string;
    date: string | null;
    finalizedAmount: string;
    currentAmount: string;
    difference: string;
  }>;
}

export interface CalendarInput {
  payGroupId: string;
  cadence: PayrollCadence;
  timezone: string;
  anchorDate: string;
  payDateOffsetDays: number;
  processingCutoffOffsetDays: number;
  effectiveFrom: string;
}

export interface ManualLineInput {
  payrollRunAssignmentId: string;
  kind: ManualLineKind;
  amount: string;
  description: string;
  reason: string;
  code?: string;
}

export interface MyPayItem {
  id: string;
  payrollRunId: string;
  employer: string;
  currency: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  grossAmount: string;
  deductionAmount: string;
  netAmount: null;
}

export interface Payslip {
  id: string;
  employer: { name: string };
  employee: { displayName: string; employeeNumber: string };
  payGroup: string;
  period: { periodStart: string; periodEnd: string; payDate: string };
  currency: string;
  finalizedAt: string | null;
  earnings: Array<{
    id: string;
    positionName: string;
    type: string;
    description: string;
    workDate: string | null;
    periodFrom: string | null;
    periodTo: string | null;
    hours: string | null;
    rateAmount: string | null;
    amount: string;
  }>;
  deductions: Array<{ id: string; category: string; description: string; amount: string }>;
  employerContributions: Array<{
    id: string;
    category: string;
    description: string;
    amount: string;
  }>;
  totals: {
    grossAmount: string;
    deductionAmount: string;
    employerContributionAmount: string;
    paidHours: string;
    netAmount: null;
    netStatus: 'STATUTORY_NOT_CALCULATED';
    netPayExplanation: string;
  };
  yearToDate: { currency: string; grossAmount: string; deductionAmount: string };
}

/** Batch 6A: editable calendar rules (only while the calendar has no periods). */
export interface CalendarUpdateInput {
  cadence: PayrollCadence;
  timezone: string;
  anchorDate: string;
  payDateOffsetDays: number;
  processingCutoffOffsetDays: number;
  effectiveFrom: string;
  effectiveTo?: string | null;
}

/** Batch 6A: an assignment paid through a pay group (the off-cycle adjustment picker). */
export interface PayGroupMember {
  employmentAssignmentId: string;
  employeeId: string;
  employeeNumber: string;
  displayName: string;
  positionName: string;
  assignmentStatus: string;
  currencies: string[];
}

/** Batch 6A: an off-cycle adjustment, carried by the pay group's next run in its currency. */
export interface AdjustmentInput {
  payGroupId: string;
  employmentAssignmentId: string;
  currency: string;
  kind: 'EARNING' | 'DEDUCTION';
  amount: string;
  description: string;
  reason: string;
  /** A finalized run of the same pay group this adjustment corrects. */
  sourceRunId?: string;
}
