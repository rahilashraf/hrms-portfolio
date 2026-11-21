import type { FeatureModule } from '../features/features-domain.js';
import type { DateMode, GroupBy, ReportFilterKey } from './reporting-domain.js';

/**
 * Phase 17 — the report catalogue. Each definition names the domain read permission(s) its
 * data needs: a report aggregates only over records placed inside scopes where the caller holds
 * report.read AND every source permission (and report.export too when exporting).
 *
 * placement says how a record is placed in the organization:
 * - POSITION: through the employment assignment's position (unit, department, team);
 * - OPENING: through the job opening's own placement (recruitment);
 * - ORGANIZATION: organization-level data (payroll): every permission is evaluated at the
 *   organization itself, as the payroll domain does; unit/department/team grants never reach it.
 * organizationPermissions are additionally required at the organization itself (e.g. benefit
 * deductions come from finalized payroll, which only an organization-level payroll.read reaches).
 */
export const REPORT_AREAS = [
  'workforce',
  'time',
  'scheduling',
  'leave',
  'compensation',
  'payroll',
  'benefits',
  'performance',
  'recruitment',
  'onboarding',
  'offboarding',
  'documents',
] as const;
export type ReportArea = (typeof REPORT_AREAS)[number];

export type ColumnType =
  | 'string'
  | 'integer'
  | 'number'
  | 'percent'
  | 'money'
  | 'date'
  | 'month'
  | 'boolean';

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export type Placement = 'POSITION' | 'OPENING' | 'ORGANIZATION';

export interface ReportDefinition {
  key: string;
  area: ReportArea;
  title: string;
  description: string;
  placement: Placement;
  sourcePermissions: readonly string[];
  organizationPermissions?: readonly string[];
  dateMode: DateMode;
  filters: readonly ReportFilterKey[];
  groupBy?: readonly GroupBy[];
  defaultGroupBy?: GroupBy;
  /** Small groups are suppressed (count null + suppressed flag). */
  sensitive: boolean;
  /** The caller's own records are left out, as the source domain never shows them through grants. */
  excludesSelf: boolean;
  columns: readonly ReportColumn[];
}

const PLACEMENT: ReportFilterKey[] = [
  'organizationalUnitId',
  'departmentId',
  'teamId',
  'positionId',
];
const PLACED: ReportFilterKey[] = [...PLACEMENT, 'employmentType'];
const RANGE: ReportFilterKey[] = ['from', 'to'];

const c = (key: string, label: string, type: ColumnType): ReportColumn => ({
  key,
  label,
  type,
});
const GROUP = [
  c('groupKey', 'Group key', 'string'),
  c('groupLabel', 'Group', 'string'),
];
const SUPPRESSED = c('suppressed', 'Suppressed', 'boolean');
const STRUCTURE_GROUPS: GroupBy[] = [
  'department',
  'team',
  'organizationalUnit',
];

export const REPORT_DEFINITIONS: readonly ReportDefinition[] = [
  // ─── Workforce ────────────────────────────────────────────────────────────
  {
    key: 'workforce.headcount_trend',
    area: 'workforce',
    title: 'Headcount trend',
    description:
      'Monthly headcount (employees with an effective assignment), hires, terminations and turnover.',
    placement: 'POSITION',
    sourcePermissions: ['employee.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('month', 'Month', 'month'),
      c('headcountStart', 'Headcount at start', 'integer'),
      c('headcountEnd', 'Headcount at end', 'integer'),
      c('hires', 'Hires', 'integer'),
      c('terminations', 'Terminations', 'integer'),
      c('turnoverRate', 'Turnover %', 'percent'),
    ],
  },
  {
    key: 'workforce.turnover',
    area: 'workforce',
    title: 'Turnover',
    description:
      'Hires, terminations and turnover rate (terminations / average headcount) over the range.',
    placement: 'POSITION',
    sourcePermissions: ['employee.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('from', 'From', 'date'),
      c('to', 'To', 'date'),
      c('headcountStart', 'Headcount at start', 'integer'),
      c('headcountEnd', 'Headcount at end', 'integer'),
      c('averageHeadcount', 'Average headcount', 'number'),
      c('hires', 'Hires', 'integer'),
      c('terminations', 'Terminations', 'integer'),
      c('turnoverRate', 'Turnover %', 'percent'),
    ],
  },
  {
    key: 'workforce.distribution',
    area: 'workforce',
    title: 'Headcount distribution',
    description:
      'Headcount on a date by organizational unit, department, team, position or employment type.',
    placement: 'POSITION',
    sourcePermissions: ['employee.read'],
    dateMode: 'AS_OF',
    filters: ['asOf', ...PLACED, 'groupBy'],
    groupBy: [
      'department',
      'team',
      'organizationalUnit',
      'position',
      'employmentType',
    ],
    sensitive: false,
    excludesSelf: false,
    columns: [
      ...GROUP,
      c('headcount', 'Employees', 'integer'),
      c('assignments', 'Assignments', 'integer'),
    ],
  },
  {
    key: 'workforce.assignment_status',
    area: 'workforce',
    title: 'Assignments by status',
    description: 'Employment assignments by their current status.',
    placement: 'POSITION',
    sourcePermissions: ['employee.read'],
    dateMode: 'NONE',
    filters: PLACED,
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('status', 'Status', 'string'),
      c('assignments', 'Assignments', 'integer'),
      c('employees', 'Employees', 'integer'),
    ],
  },

  // ─── Time & attendance ────────────────────────────────────────────────────
  {
    key: 'time.hours',
    area: 'time',
    title: 'Clocked hours',
    description:
      'Clocked time from time entries by work date: gross minutes, recorded unpaid breaks and net minutes.',
    placement: 'POSITION',
    sourcePermissions: ['time.view'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'groupBy'],
    groupBy: ['month', ...STRUCTURE_GROUPS],
    sensitive: false,
    excludesSelf: false,
    columns: [
      ...GROUP,
      c('closedEntries', 'Closed entries', 'integer'),
      c('openEntries', 'Open entries', 'integer'),
      c('employees', 'Employees', 'integer'),
      c('grossMinutes', 'Gross minutes', 'integer'),
      c('unpaidBreakMinutes', 'Unpaid break minutes', 'integer'),
      c('netMinutes', 'Net minutes', 'integer'),
      c('netHours', 'Net hours', 'number'),
    ],
  },
  {
    key: 'time.exceptions',
    area: 'time',
    title: 'Attendance exceptions',
    description:
      'Attendance exceptions detected in the range by type (late arrivals, missing clock-outs…) and status.',
    placement: 'POSITION',
    sourcePermissions: ['time.view'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('type', 'Type', 'string'),
      c('total', 'Total', 'integer'),
      c('open', 'Open', 'integer'),
      c('resolved', 'Resolved', 'integer'),
      c('dismissed', 'Dismissed', 'integer'),
      c('superseded', 'Superseded', 'integer'),
    ],
  },
  {
    key: 'time.corrections',
    area: 'time',
    title: 'Time corrections',
    description:
      'Time correction requests made in the range by type and status.',
    placement: 'POSITION',
    sourcePermissions: ['time.view'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('type', 'Type', 'string'),
      c('total', 'Total', 'integer'),
      c('pending', 'Pending', 'integer'),
      c('approved', 'Approved', 'integer'),
      c('rejected', 'Rejected', 'integer'),
      c('cancelled', 'Cancelled', 'integer'),
      c('superseded', 'Superseded', 'integer'),
    ],
  },

  {
    key: 'time.timesheet-detail',
    area: 'time',
    title: 'Timesheet detail',
    description:
      'One row per timesheet segment (employee and assignment) of the periods overlapping the range: its status, the approved minutes stored at approval, and the current calculated minutes, shown separately.',
    placement: 'POSITION',
    sourcePermissions: ['time.view'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('periodStart', 'Period start', 'date'),
      c('periodEnd', 'Period end', 'date'),
      c('employeeNumber', 'Employee number', 'string'),
      c('employeeName', 'Employee', 'string'),
      c('position', 'Position', 'string'),
      c('timesheetStatus', 'Timesheet status', 'string'),
      c('segmentStatus', 'Segment status', 'string'),
      c('approvedMinutes', 'Approved minutes (snapshot)', 'integer'),
      c('approvedHours', 'Approved hours (snapshot)', 'number'),
      c('liveNetMinutes', 'Current calculated minutes (live)', 'integer'),
      c('liveGrossMinutes', 'Current gross minutes (live)', 'integer'),
      c(
        'livePolicyDeductionMinutes',
        'Current policy deduction (live)',
        'integer',
      ),
      c('differsFromApproved', 'Live differs from approved', 'boolean'),
    ],
  },
  {
    key: 'time.sign-ins',
    area: 'time',
    title: 'Attendance sign-ins',
    description:
      'One row per presence sign-in in the range (sign-in-only attendance): when, how it was captured, the shift it confirmed and its sign-out. Presence carries no minutes.',
    placement: 'POSITION',
    sourcePermissions: ['time.view'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('workDate', 'Work date', 'date'),
      c('employeeNumber', 'Employee number', 'string'),
      c('employeeName', 'Employee', 'string'),
      c('position', 'Position', 'string'),
      c('signedInAt', 'Signed in (local)', 'string'),
      c('timezone', 'Time zone', 'string'),
      c('source', 'Source', 'string'),
      c('status', 'Status', 'string'),
      c('scheduledShiftStart', 'Shift start (local)', 'string'),
      c('signedOutAt', 'Signed out (local)', 'string'),
    ],
  },

  // ─── Scheduling ───────────────────────────────────────────────────────────
  {
    key: 'scheduling.hours',
    area: 'scheduling',
    title: 'Scheduled hours',
    description: 'Active shifts of published schedules by work date.',
    placement: 'POSITION',
    sourcePermissions: ['schedule.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'groupBy'],
    groupBy: ['month', ...STRUCTURE_GROUPS],
    sensitive: false,
    excludesSelf: false,
    columns: [
      ...GROUP,
      c('shifts', 'Shifts', 'integer'),
      c('employees', 'Employees', 'integer'),
      c('scheduledMinutes', 'Scheduled minutes', 'integer'),
      c('scheduledHours', 'Scheduled hours', 'number'),
    ],
  },
  {
    key: 'scheduling.adherence',
    area: 'scheduling',
    title: 'Schedule coverage and adherence',
    description:
      'Published shifts worked (a linked time entry) vs not worked, and linked net worked minutes vs scheduled minutes. Needs schedule.read and time.view.',
    placement: 'POSITION',
    sourcePermissions: ['schedule.read', 'time.view'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'groupBy'],
    groupBy: ['month', ...STRUCTURE_GROUPS],
    sensitive: false,
    excludesSelf: false,
    columns: [
      ...GROUP,
      c('shifts', 'Shifts', 'integer'),
      c('shiftsWorked', 'Shifts worked', 'integer'),
      c('shiftsNotWorked', 'Shifts not worked', 'integer'),
      c('coverageRate', 'Coverage %', 'percent'),
      c('scheduledMinutes', 'Scheduled minutes', 'integer'),
      c('workedMinutes', 'Worked minutes (linked)', 'integer'),
      c('adherenceRate', 'Adherence %', 'percent'),
      c('unscheduledEntries', 'Unscheduled entries', 'integer'),
    ],
  },

  // ─── Leave ────────────────────────────────────────────────────────────────
  {
    key: 'leave.usage',
    area: 'leave',
    title: 'Leave usage',
    description:
      'Approved leave taken per month and leave type (cancelled days excluded), with its paid/unpaid classification.',
    placement: 'POSITION',
    sourcePermissions: ['leave.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('month', 'Month', 'month'),
      c('leaveTypeCode', 'Leave type code', 'string'),
      c('leaveTypeName', 'Leave type', 'string'),
      c('classification', 'Classification', 'string'),
      c('days', 'Leave days', 'integer'),
      c('minutes', 'Minutes', 'integer'),
      c('hours', 'Hours', 'number'),
      c('employees', 'Employees', 'integer'),
    ],
  },
  {
    key: 'leave.balances',
    area: 'leave',
    title: 'Leave balances',
    description:
      'Ledger balances on a date (net entries effective on or before it) per balance-tracked leave type.',
    placement: 'POSITION',
    sourcePermissions: ['leave.read'],
    dateMode: 'AS_OF',
    filters: ['asOf', ...PLACED],
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('leaveTypeCode', 'Leave type code', 'string'),
      c('leaveTypeName', 'Leave type', 'string'),
      c('accounts', 'Accounts', 'integer'),
      c('totalMinutes', 'Total balance (minutes)', 'integer'),
      c('averageMinutes', 'Average balance (minutes)', 'number'),
      c('totalHours', 'Total balance (hours)', 'number'),
    ],
  },
  {
    key: 'leave.requests',
    area: 'leave',
    title: 'Leave requests',
    description:
      'Leave requests submitted in the range by leave type and status.',
    placement: 'POSITION',
    sourcePermissions: ['leave.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('leaveTypeCode', 'Leave type code', 'string'),
      c('leaveTypeName', 'Leave type', 'string'),
      c('total', 'Total', 'integer'),
      c('pending', 'Pending', 'integer'),
      c('approved', 'Approved', 'integer'),
      c('rejected', 'Rejected', 'integer'),
      c('cancelled', 'Cancelled', 'integer'),
    ],
  },

  // ─── Compensation ─────────────────────────────────────────────────────────
  {
    key: 'compensation.distribution',
    area: 'compensation',
    title: 'Pay distribution',
    description:
      'Current pay rates on a date in fixed-width buckets (hourly: 5, salary: 10,000) per pay basis and currency. Buckets under the minimum group size are suppressed.',
    placement: 'POSITION',
    sourcePermissions: ['compensation.read'],
    dateMode: 'AS_OF',
    filters: ['asOf', ...PLACED],
    sensitive: true,
    excludesSelf: false,
    columns: [
      c('payBasis', 'Pay basis', 'string'),
      c('salaryArrangement', 'Salary arrangement', 'string'),
      c('currency', 'Currency', 'string'),
      c('bucketFrom', 'From', 'money'),
      c('bucketTo', 'To (exclusive)', 'money'),
      c('employees', 'Employees', 'integer'),
      SUPPRESSED,
    ],
  },
  {
    key: 'compensation.by_group',
    area: 'compensation',
    title: 'Pay by group',
    description:
      'Average and median current pay rate on a date per group, pay basis and currency. Groups under the minimum group size are suppressed.',
    placement: 'POSITION',
    sourcePermissions: ['compensation.read'],
    dateMode: 'AS_OF',
    filters: ['asOf', ...PLACED, 'groupBy'],
    groupBy: [...STRUCTURE_GROUPS, 'employmentType'],
    sensitive: true,
    excludesSelf: false,
    columns: [
      ...GROUP,
      c('payBasis', 'Pay basis', 'string'),
      c('salaryArrangement', 'Salary arrangement', 'string'),
      c('currency', 'Currency', 'string'),
      c('employees', 'Employees', 'integer'),
      c('averageRate', 'Average rate', 'money'),
      c('medianRate', 'Median rate', 'money'),
      SUPPRESSED,
    ],
  },
  {
    key: 'compensation.changes',
    area: 'compensation',
    title: 'Compensation changes',
    description:
      'Compensation change and correction records effective in the range, per month (counts only).',
    placement: 'POSITION',
    sourcePermissions: ['compensation.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('month', 'Month', 'month'),
      c('changes', 'Changes', 'integer'),
      c('corrections', 'Corrections', 'integer'),
      c('assignments', 'Assignments affected', 'integer'),
    ],
  },

  // ─── Payroll ──────────────────────────────────────────────────────────────
  {
    key: 'payroll.period_totals',
    area: 'payroll',
    title: 'Payroll period totals',
    description:
      'Finalized payroll runs by pay date: gross, recorded deductions, employer contributions and total cost, with the change from the previous period of the same pay group. Net pay is not calculated: statutory deductions are not part of payroll yet. Narrowed results under the minimum group size are suppressed.',
    placement: 'ORGANIZATION',
    sourcePermissions: ['payroll.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: true,
    excludesSelf: false,
    columns: [
      c('payGroupCode', 'Pay group', 'string'),
      c('periodStart', 'Period start', 'date'),
      c('periodEnd', 'Period end', 'date'),
      c('payDate', 'Pay date', 'date'),
      c('currency', 'Currency', 'string'),
      c('runs', 'Runs', 'integer'),
      c('employees', 'Employees', 'integer'),
      c('gross', 'Gross', 'money'),
      c('deductions', 'Recorded deductions', 'money'),
      c('employerContributions', 'Employer contributions', 'money'),
      c(
        'grossLessRecordedDeductions',
        'Gross less recorded deductions (not net pay)',
        'money',
      ),
      c('netPay', 'Net pay', 'string'),
      c('totalCost', 'Total cost', 'money'),
      c('grossChange', 'Gross change', 'money'),
      c('totalCostChange', 'Total cost change', 'money'),
      SUPPRESSED,
    ],
  },
  {
    key: 'payroll.register',
    area: 'payroll',
    title: 'Payroll register',
    description:
      'One row per finalized payroll run and employee, by pay date: gross, recorded deductions (with the adjustment earnings and deductions they already include), employer contributions and gross less recorded deductions. Net pay is not calculated: statutory deductions are not part of payroll yet.',
    placement: 'ORGANIZATION',
    sourcePermissions: ['payroll.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    // Person-level (no small-group suppression): organization-level payroll.read only.
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('payDate', 'Pay date', 'date'),
      c('periodStart', 'Period start', 'date'),
      c('periodEnd', 'Period end', 'date'),
      c('payGroupCode', 'Pay group', 'string'),
      c('employeeNumber', 'Employee number', 'string'),
      c('employeeName', 'Employee', 'string'),
      c('currency', 'Currency', 'string'),
      c('gross', 'Gross', 'money'),
      c('deductions', 'Recorded deductions', 'money'),
      c(
        'adjustmentEarnings',
        'Adjustment earnings (included in gross)',
        'money',
      ),
      c(
        'adjustmentDeductions',
        'Adjustment deductions (included in recorded deductions)',
        'money',
      ),
      c('employerContributions', 'Employer contributions', 'money'),
      c(
        'grossLessRecordedDeductions',
        'Gross less recorded deductions (NOT net pay)',
        'money',
      ),
      c('netPay', 'Net pay', 'string'),
    ],
  },
  {
    key: 'payroll.by_group',
    area: 'payroll',
    title: 'Payroll by group',
    description:
      'Finalized payroll in the range per organizational group and currency: gross, recorded deductions, employer contributions and total cost. Net pay is not calculated: statutory deductions are not part of payroll yet. Groups under the minimum group size are suppressed.',
    placement: 'ORGANIZATION',
    sourcePermissions: ['payroll.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'groupBy'],
    groupBy: [...STRUCTURE_GROUPS, 'employmentType'],
    sensitive: true,
    excludesSelf: false,
    columns: [
      ...GROUP,
      c('currency', 'Currency', 'string'),
      c('employees', 'Employees', 'integer'),
      c('gross', 'Gross', 'money'),
      c('deductions', 'Recorded deductions', 'money'),
      c('employerContributions', 'Employer contributions', 'money'),
      c(
        'grossLessRecordedDeductions',
        'Gross less recorded deductions (not net pay)',
        'money',
      ),
      c('netPay', 'Net pay', 'string'),
      c('totalCost', 'Total cost', 'money'),
      SUPPRESSED,
    ],
  },

  // ─── Benefits ─────────────────────────────────────────────────────────────
  {
    key: 'benefits.enrollment',
    area: 'benefits',
    title: 'Benefit enrollment',
    description:
      'Current elections on a date per plan, and participation (enrolled employees / employees with an effective assignment in scope). Plans elected by fewer than the minimum group size are suppressed.',
    placement: 'POSITION',
    sourcePermissions: ['benefit.read'],
    dateMode: 'AS_OF',
    filters: ['asOf', ...PLACED],
    sensitive: false,
    excludesSelf: false,
    columns: [
      c('planCode', 'Plan code', 'string'),
      c('planName', 'Plan', 'string'),
      c('benefitType', 'Benefit type', 'string'),
      c('enrolledEmployees', 'Enrolled', 'integer'),
      c('waivedEmployees', 'Waived', 'integer'),
      c('headcount', 'Headcount', 'integer'),
      c('participationRate', 'Participation %', 'percent'),
      // Batch 7C (B16): small groups are suppressed.
      SUPPRESSED,
    ],
  },
  {
    key: 'benefits.contributions',
    area: 'benefits',
    title: 'Benefit costs',
    description:
      'Employee deductions and employer contributions for benefits in finalized payroll paid in the range, per plan. Needs benefit.read and an organization-level payroll.read. Plans under the minimum group size are suppressed.',
    placement: 'POSITION',
    sourcePermissions: ['benefit.read'],
    organizationPermissions: ['payroll.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: true,
    excludesSelf: false,
    columns: [
      c('planCode', 'Plan code', 'string'),
      c('planName', 'Plan', 'string'),
      c('currency', 'Currency', 'string'),
      c('employees', 'Employees', 'integer'),
      c('employeeDeductions', 'Employee deductions', 'money'),
      c('employerContributions', 'Employer contributions', 'money'),
      c('totalCost', 'Total', 'money'),
      SUPPRESSED,
    ],
  },

  // ─── Performance ──────────────────────────────────────────────────────────
  {
    key: 'performance.cycle_completion',
    area: 'performance',
    title: 'Review completion',
    description:
      'Per cycle overlapping the range: reviews, finalized (completed) reviews, completion rate, submitted parts and overdue parts.',
    placement: 'POSITION',
    sourcePermissions: ['performance.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'cycleId'],
    sensitive: false,
    excludesSelf: true,
    columns: [
      c('cycleCode', 'Cycle code', 'string'),
      c('cycleName', 'Cycle', 'string'),
      c('cycleStatus', 'Cycle status', 'string'),
      c('reviews', 'Reviews', 'integer'),
      c('completed', 'Completed', 'integer'),
      c('completionRate', 'Completion %', 'percent'),
      c('selfSubmitted', 'Self reviews submitted', 'integer'),
      c('reviewerSubmitted', 'Reviewer parts submitted', 'integer'),
      c('acknowledged', 'Acknowledged', 'integer'),
      c('overdueSelf', 'Overdue self reviews', 'integer'),
      c('overdueReviewer', 'Overdue reviewer parts', 'integer'),
    ],
  },
  {
    key: 'performance.rating_distribution',
    area: 'performance',
    title: 'Rating distribution',
    description:
      'Overall ratings of finalized reviews per cycle. Ratings held by fewer than the minimum group size are suppressed.',
    placement: 'POSITION',
    sourcePermissions: ['performance.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'cycleId'],
    sensitive: true,
    excludesSelf: true,
    columns: [
      c('cycleCode', 'Cycle code', 'string'),
      c('cycleName', 'Cycle', 'string'),
      c('ratingValue', 'Rating value', 'integer'),
      c('ratingLabel', 'Rating', 'string'),
      c('reviews', 'Reviews', 'integer'),
      SUPPRESSED,
    ],
  },
  {
    key: 'performance.goals',
    area: 'performance',
    title: 'Goal completion',
    description:
      'Goals due in the range (or starting in it when undated) by status, with overdue goals and completion rate.',
    placement: 'POSITION',
    sourcePermissions: ['performance.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'groupBy'],
    groupBy: STRUCTURE_GROUPS,
    sensitive: false,
    excludesSelf: true,
    columns: [
      ...GROUP,
      c('goals', 'Goals', 'integer'),
      c('notStarted', 'Not started', 'integer'),
      c('inProgress', 'In progress', 'integer'),
      c('completed', 'Completed', 'integer'),
      c('cancelled', 'Cancelled', 'integer'),
      c('overdue', 'Overdue', 'integer'),
      c('completionRate', 'Completion %', 'percent'),
    ],
  },
  {
    key: 'performance.evidence',
    area: 'performance',
    title: 'Evidence and assessments',
    description:
      'Active evidence completed in the range by kind and provider, with pass rates of scored assessments. Groups under the minimum group size are suppressed.',
    placement: 'POSITION',
    sourcePermissions: ['performance.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED],
    sensitive: true,
    excludesSelf: true,
    columns: [
      c('kind', 'Kind', 'string'),
      c('provider', 'Provider', 'string'),
      c('records', 'Records', 'integer'),
      c('employees', 'Employees', 'integer'),
      c('passed', 'Passed', 'integer'),
      c('failed', 'Failed', 'integer'),
      c('passRate', 'Pass %', 'percent'),
      SUPPRESSED,
    ],
  },

  // ─── Recruitment ──────────────────────────────────────────────────────────
  {
    key: 'recruitment.openings',
    area: 'recruitment',
    title: 'Openings and fill status',
    description:
      'Openings in scope with their fill status and the applications received in the range by status.',
    placement: 'OPENING',
    sourcePermissions: ['recruitment.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'openingId'],
    sensitive: false,
    excludesSelf: true,
    columns: [
      c('openingCode', 'Opening code', 'string'),
      c('openingTitle', 'Opening', 'string'),
      c('status', 'Status', 'string'),
      c('openingCount', 'Openings', 'integer'),
      c('hiredCount', 'Filled', 'integer'),
      c('remaining', 'Remaining', 'integer'),
      c('applications', 'Applications', 'integer'),
      c('active', 'Active', 'integer'),
      c('offered', 'Offered', 'integer'),
      c('hired', 'Hired', 'integer'),
      c('rejected', 'Rejected', 'integer'),
      c('withdrawn', 'Withdrawn', 'integer'),
    ],
  },
  {
    key: 'recruitment.sources',
    area: 'recruitment',
    title: 'Applicant sources',
    description: 'Applications received in the range by source, with hires.',
    placement: 'OPENING',
    sourcePermissions: ['recruitment.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'openingId'],
    sensitive: false,
    excludesSelf: true,
    columns: [
      c('source', 'Source', 'string'),
      c('applications', 'Applications', 'integer'),
      c('hired', 'Hired', 'integer'),
      c('hireRate', 'Hire %', 'percent'),
    ],
  },
  {
    key: 'recruitment.stages',
    area: 'recruitment',
    title: 'Pipeline stages',
    description:
      'Per stage: active applications now in it, entries in the range, and the average days spent in it (stays that ended in the range, from stage transitions).',
    placement: 'OPENING',
    sourcePermissions: ['recruitment.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'openingId'],
    sensitive: false,
    excludesSelf: true,
    columns: [
      c('stageCode', 'Stage code', 'string'),
      c('stageName', 'Stage', 'string'),
      c('stageKind', 'Kind', 'string'),
      c('currentApplications', 'Active now', 'integer'),
      c('entered', 'Entered in range', 'integer'),
      c('completedStays', 'Completed stays', 'integer'),
      c('averageDaysInStage', 'Average days in stage', 'number'),
    ],
  },
  {
    key: 'recruitment.offers',
    area: 'recruitment',
    title: 'Offer outcomes',
    description: 'Offers created in the range by status.',
    placement: 'OPENING',
    sourcePermissions: ['recruitment.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'openingId'],
    sensitive: false,
    excludesSelf: true,
    columns: [
      c('status', 'Status', 'string'),
      c('offers', 'Offers', 'integer'),
      c('share', 'Share %', 'percent'),
    ],
  },

  // ─── Onboarding / offboarding ─────────────────────────────────────────────
  {
    key: 'onboarding.workflows',
    area: 'onboarding',
    title: 'Onboarding progress',
    description:
      'Onboarding workflows started in the range: active, completed, cancelled, completion rate, overdue open tasks and median days to completion.',
    placement: 'POSITION',
    sourcePermissions: ['onboarding.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'groupBy'],
    groupBy: ['month', ...STRUCTURE_GROUPS],
    sensitive: false,
    excludesSelf: true,
    columns: [
      ...GROUP,
      c('workflows', 'Workflows', 'integer'),
      c('active', 'Active', 'integer'),
      c('completed', 'Completed', 'integer'),
      c('cancelled', 'Cancelled', 'integer'),
      c('completionRate', 'Completion %', 'percent'),
      c('overdueTasks', 'Overdue tasks', 'integer'),
      c('medianDaysToComplete', 'Median days to complete', 'number'),
    ],
  },
  {
    key: 'offboarding.workflows',
    area: 'offboarding',
    title: 'Offboarding progress',
    description:
      'Offboarding workflows started in the range (never reasons): active, completed, cancelled, completion rate, overdue open tasks and median days to completion. Needs offboarding.read.',
    placement: 'POSITION',
    sourcePermissions: ['offboarding.read'],
    dateMode: 'RANGE',
    filters: [...RANGE, ...PLACED, 'groupBy'],
    groupBy: ['month', ...STRUCTURE_GROUPS],
    sensitive: false,
    excludesSelf: true,
    columns: [
      ...GROUP,
      c('workflows', 'Workflows', 'integer'),
      c('active', 'Active', 'integer'),
      c('completed', 'Completed', 'integer'),
      c('cancelled', 'Cancelled', 'integer'),
      c('completionRate', 'Completion %', 'percent'),
      c('overdueTasks', 'Overdue tasks', 'integer'),
      c('medianDaysToComplete', 'Median days to complete', 'number'),
    ],
  },

  // ─── Documents ────────────────────────────────────────────────────────────
  {
    key: 'documents.requirements',
    area: 'documents',
    title: 'Required documents',
    description:
      'Per required document type: employees it applies to, satisfied, missing and expired. Only types and documents within the confidentiality the caller may read are counted.',
    placement: 'POSITION',
    sourcePermissions: ['document.read'],
    dateMode: 'NONE',
    filters: PLACED,
    sensitive: false,
    excludesSelf: true,
    columns: [
      c('typeCode', 'Type code', 'string'),
      c('typeName', 'Document type', 'string'),
      c('employees', 'Employees required', 'integer'),
      c('satisfied', 'Satisfied', 'integer'),
      c('missing', 'Missing', 'integer'),
      c('expired', 'Expired', 'integer'),
      c('completionRate', 'Completion %', 'percent'),
    ],
  },
  {
    key: 'documents.expiry',
    area: 'documents',
    title: 'Document expiry',
    description:
      'Active documents with an expiry date per type and confidentiality: expired, expiring within 30 days and valid. Confidential (HR-only) and restricted documents are counted only with document.confidential.read / document.restricted.read.',
    placement: 'POSITION',
    sourcePermissions: ['document.read'],
    dateMode: 'NONE',
    filters: PLACED,
    sensitive: false,
    excludesSelf: true,
    columns: [
      c('typeCode', 'Type code', 'string'),
      c('typeName', 'Document type', 'string'),
      c('confidentiality', 'Confidentiality', 'string'),
      c('documents', 'Documents', 'integer'),
      c('expired', 'Expired', 'integer'),
      c('expiringSoon', 'Expiring soon', 'integer'),
      c('valid', 'Valid', 'integer'),
    ],
  },
  {
    key: 'documents.acknowledgements',
    area: 'documents',
    title: 'Policy acknowledgements',
    description:
      'Per published policy version: audience in scope (current assignments matching the policy audience), acknowledged and pending.',
    placement: 'POSITION',
    sourcePermissions: ['document.read'],
    dateMode: 'NONE',
    filters: PLACED,
    sensitive: false,
    excludesSelf: true,
    columns: [
      c('policyCode', 'Policy code', 'string'),
      c('policyTitle', 'Policy', 'string'),
      c('versionNumber', 'Version', 'integer'),
      c('versionLabel', 'Version label', 'string'),
      c('current', 'Current version', 'boolean'),
      c('audience', 'Audience', 'integer'),
      c('acknowledged', 'Acknowledged', 'integer'),
      c('pending', 'Pending', 'integer'),
      c('completionRate', 'Completion %', 'percent'),
    ],
  },
];

export const REPORTS_BY_KEY = new Map(
  REPORT_DEFINITIONS.map((definition) => [definition.key, definition]),
);

/** Every permission a definition needs at a record's placement (export adds report.export). */
export function requiredPermissions(
  definition: ReportDefinition,
  forExport = false,
) {
  return [
    'report.read',
    ...(forExport ? ['report.export'] : []),
    ...definition.sourcePermissions,
  ];
}

/**
 * Phase 18 — the modules a report reads from (derived from its source permissions): a report
 * is omitted from the catalog, and refused, while any of them is disabled for the
 * organization. Workforce reports read Core HR only (never disableable).
 */
const PERMISSION_MODULES: ReadonlyArray<[string, FeatureModule]> = [
  ['time.', 'ATTENDANCE'],
  ['schedule.', 'SCHEDULING'],
  ['leave.', 'LEAVE'],
  ['compensation.', 'COMPENSATION'],
  ['payroll.', 'PAYROLL'],
  ['benefit.', 'BENEFITS'],
  ['performance.', 'PERFORMANCE'],
  ['recruitment.', 'RECRUITMENT'],
  ['onboarding.', 'ONBOARDING'],
  ['offboarding.', 'ONBOARDING'],
  ['document.', 'DOCUMENTS'],
];

export function reportModules(
  definition: Pick<ReportDefinition, 'sourcePermissions'>,
): FeatureModule[] {
  return [
    ...new Set(
      definition.sourcePermissions.flatMap((permission) =>
        PERMISSION_MODULES.filter(([prefix]) =>
          permission.startsWith(prefix),
        ).map(([, module]) => module),
      ),
    ),
  ];
}
