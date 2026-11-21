/**
 * Batch 4E-2 — the attendance policy settings an administrator can configure, described for
 * the policy editor and the effective-policy view. It mirrors the API's own schema
 * (apps/api/src/time/time-policy.ts, TIME_POLICY_CONFIG_SCHEMA): the same sections, keys and
 * bounds. The API validates every write; this only labels and pre-checks. The sections' passive
 * `mode` keys are left out: nothing reads them.
 */

export type PolicyFieldKind =
  | { type: 'boolean' }
  | { type: 'enum'; options: ReadonlyArray<{ value: string; label: string }> }
  | { type: 'integer'; min: number; max: number; unit?: string }
  | { type: 'localTime' }
  | { type: 'date' };

export interface PolicyField {
  key: string;
  label: string;
  help?: string;
  kind: PolicyFieldKind;
  /** What applies when no layer sets it (the built-in default), in words. */
  defaultText: string;
}

export interface PolicySection {
  key: string;
  title: string;
  description: string;
  fields: readonly PolicyField[];
  /** Set on the organization (or system) layer only. */
  organizationOnly?: boolean;
  /** Changing it affects pay or how attendance is captured: confirmed with a warning. */
  warning?: string;
}

const yesNo: PolicyFieldKind = { type: 'boolean' };
const minutes = (min: number, max: number): PolicyFieldKind => ({
  type: 'integer',
  min,
  max,
  unit: 'minutes',
});

export const POLICY_SECTIONS: readonly PolicySection[] = [
  {
    key: 'attendance',
    title: 'Tracking and capture',
    description:
      'Whether this work is timed (clock in and out) or presence only (sign-in), and where it may be recorded.',
    warning:
      'Changing how attendance is tracked or captured affects new attendance from the effective date: sign-in-only work never becomes payable time, and kiosk-only capture refuses self-service. Recorded attendance and timesheets are not changed.',
    fields: [
      {
        key: 'trackingMode',
        label: 'Tracking',
        kind: {
          type: 'enum',
          options: [
            { value: 'TIME_CLOCK', label: 'Timed attendance (clock in and out)' },
            { value: 'SIGN_IN_ONLY', label: 'Presence only (sign-in, never payable)' },
          ],
        },
        defaultText: 'Timed attendance',
      },
      {
        key: 'captureMode',
        label: 'Capture',
        kind: {
          type: 'enum',
          options: [
            { value: 'SELF_SERVICE', label: 'Self-service' },
            { value: 'KIOSK_ONLY', label: 'Kiosk only' },
            { value: 'KIOSK_OR_SELF_SERVICE', label: 'Kiosk or self-service' },
          ],
        },
        defaultText: 'Self-service',
      },
      {
        key: 'kioskLocationRule',
        label: 'Kiosk location',
        kind: {
          type: 'enum',
          options: [
            { value: 'ANY_IN_ORGANIZATION', label: 'Any kiosk in the organization' },
            { value: 'ASSIGNMENT_WORK_LOCATION', label: "Only at the assignment's work location" },
          ],
        },
        defaultText: 'Any kiosk in the organization',
      },
      {
        key: 'signInDuplicateWindowMinutes',
        label: 'Duplicate sign-in window',
        help: 'A repeated sign-in within this time returns the first one.',
        kind: minutes(0, 240),
        defaultText: '10 minutes',
      },
      {
        key: 'signOutEnabled',
        label: 'Presence staff may sign out',
        help: 'Records when sign-in-only staff leave. Never payable time.',
        kind: yesNo,
        defaultText: 'No',
      },
    ],
  },
  {
    key: 'clock',
    title: 'Time clock',
    description: 'Clocking in and out for timed attendance.',
    warning:
      'Turning the time clock off stops new clock-ins (kiosks then have nothing to record). Recorded time is not changed.',
    fields: [
      {
        key: 'mode',
        label: 'Time clock',
        kind: {
          type: 'enum',
          options: [
            { value: 'LIVE_CLOCK', label: 'On (clock in and out)' },
            { value: 'DISABLED', label: 'Off' },
          ],
        },
        defaultText: 'Off',
      },
      {
        key: 'assignmentSwitching',
        label: 'Switch between assignments while clocked in',
        kind: yesNo,
        defaultText: 'No',
      },
    ],
  },
  {
    key: 'breaks',
    title: 'Breaks and automatic deduction',
    description:
      'How breaks are recorded, and the automatic unpaid deduction (once per employee, organization and work day; recorded unpaid breaks count toward it).',
    warning:
      'Break and deduction rules change payable minutes for unapproved time from the effective date. Approved and locked timesheets and payroll snapshots are never recalculated.',
    fields: [
      {
        key: 'mode',
        label: 'Breaks',
        kind: {
          type: 'enum',
          options: [
            { value: 'NONE', label: 'No break punches' },
            { value: 'MANUAL_PUNCH', label: 'Employees punch breaks' },
            { value: 'AUTO_DEDUCT', label: 'Automatic unpaid deduction' },
          ],
        },
        defaultText: 'No break punches',
      },
      {
        key: 'autoDeductMinutes',
        label: 'Deduction',
        kind: minutes(0, 480),
        defaultText: '0 minutes',
      },
      {
        key: 'autoDeductAfterMinutes',
        label: 'Deduct once a day reaches',
        help: 'Gross minutes worked that day. A new automatic-deduction layer without it gets 360.',
        kind: minutes(0, 1440),
        defaultText: '0 minutes',
      },
      {
        key: 'paidUnpaidClassification',
        label: 'Classify punched breaks as paid or unpaid',
        kind: yesNo,
        defaultText: 'No',
      },
      {
        key: 'defaultPayType',
        label: 'Default break pay',
        kind: {
          type: 'enum',
          options: [
            { value: 'UNPAID', label: 'Unpaid' },
            { value: 'PAID', label: 'Paid' },
          ],
        },
        defaultText: 'Unpaid',
      },
      {
        key: 'openBreakAutoCloseExceptionEnabled',
        label: 'Flag breaks closed automatically',
        kind: yesNo,
        defaultText: 'No',
      },
    ],
  },
  {
    key: 'missedPunch',
    title: 'Missed punches',
    description: 'Detecting forgotten clock-outs, and closing them at the expected end.',
    warning:
      'Missed-punch rules decide when open entries are flagged or closed from the effective date. Closed entries are not changed.',
    fields: [
      { key: 'enabled', label: 'Detect missed clock-outs', kind: yesNo, defaultText: 'No' },
      {
        key: 'maxOpenDurationMinutes',
        label: 'Longest open entry',
        kind: minutes(1, 2880),
        defaultText: 'Not set',
      },
      {
        key: 'detectionGraceMinutes',
        label: 'Grace before flagging',
        kind: minutes(0, 1440),
        defaultText: '0 minutes',
      },
      {
        key: 'allowAutoCloseFromExpectedEnd',
        label: 'Close at the expected end',
        help: 'Uses a linked shift’s end, or the expected end time below.',
        kind: yesNo,
        defaultText: 'No',
      },
      {
        key: 'expectedEndLocalTime',
        label: 'Expected end time',
        help: 'Local time. Before the expected start time means the next day (overnight).',
        kind: { type: 'localTime' },
        defaultText: 'Not set',
      },
      {
        key: 'employeeResolutionEnabled',
        label: 'Employees may enter their missed clock-out',
        kind: yesNo,
        defaultText: 'No',
      },
    ],
  },
  {
    key: 'attendanceInterpretation',
    title: 'Late arrival and early departure',
    description:
      'Expected times and graces. On daylight-saving days a skipped time moves forward and a repeated time takes its first occurrence.',
    fields: [
      { key: 'lateArrivalEnabled', label: 'Flag late arrivals', kind: yesNo, defaultText: 'No' },
      {
        key: 'lateGraceMinutes',
        label: 'Late grace',
        kind: minutes(0, 1440),
        defaultText: '0 minutes',
      },
      {
        key: 'earlyDepartureEnabled',
        label: 'Flag early departures',
        kind: yesNo,
        defaultText: 'No',
      },
      {
        key: 'earlyDepartureGraceMinutes',
        label: 'Early departure grace',
        kind: minutes(0, 1440),
        defaultText: '0 minutes',
      },
      {
        key: 'expectedStartLocalTime',
        label: 'Expected start time',
        help: 'Local time, when no published shift applies.',
        kind: { type: 'localTime' },
        defaultText: 'Not set',
      },
      {
        key: 'expectedEndLocalTime',
        label: 'Expected end time',
        kind: { type: 'localTime' },
        defaultText: 'Not set',
      },
    ],
  },
  {
    key: 'correction',
    title: 'Corrections',
    description: 'Whether employees may request corrections, and how they are approved.',
    fields: [
      {
        key: 'employeeRequestsEnabled',
        label: 'Employees may request corrections',
        kind: yesNo,
        defaultText: 'No',
      },
      {
        key: 'approvalMode',
        label: 'Approval',
        kind: {
          type: 'enum',
          options: [
            { value: 'REQUIRE_APPROVAL', label: 'A manager approves every request' },
            { value: 'AUTO_APPROVE_SAFE', label: 'Approve small changes automatically' },
            { value: 'NO_APPROVAL_REQUIRED', label: 'No approval required' },
          ],
        },
        defaultText: 'A manager approves every request',
      },
      {
        key: 'autoApprovalToleranceMinutes',
        label: 'Automatic approval up to',
        kind: minutes(0, 1440),
        defaultText: '0 minutes',
      },
    ],
  },
  {
    key: 'timesheet',
    title: 'Timesheets',
    description: 'Submission and locking.',
    fields: [
      {
        key: 'allowEarlySubmission',
        label: 'Allow submission before the period ends',
        kind: yesNo,
        defaultText: 'No',
      },
      {
        key: 'autoLockOnApproval',
        label: 'Lock timesheets when approved',
        kind: yesNo,
        defaultText: 'No',
      },
    ],
  },
  {
    key: 'noShow',
    title: 'No-shows',
    description:
      'Flag published shifts with no attendance (timed attendance only), for review. Needs the attendance automation switched on for the deployment.',
    fields: [
      { key: 'enabled', label: 'Detect no-shows', kind: yesNo, defaultText: 'No' },
      {
        key: 'graceMinutes',
        label: 'After the shift starts by',
        kind: minutes(0, 1440),
        defaultText: '30 minutes',
      },
    ],
  },
  {
    key: 'periods',
    title: 'Attendance period automation',
    description:
      'Create time periods (and their timesheets) automatically for organizations without payroll. Organization layer only; needs the attendance automation switched on for the deployment.',
    organizationOnly: true,
    fields: [
      {
        key: 'autoGenerate',
        label: 'Create periods automatically',
        kind: yesNo,
        defaultText: 'No',
      },
      {
        key: 'cadence',
        label: 'Period length',
        kind: {
          type: 'enum',
          options: [
            { value: 'WEEKLY', label: 'Weekly' },
            { value: 'BIWEEKLY', label: 'Every two weeks' },
            { value: 'MONTHLY', label: 'Monthly' },
          ],
        },
        defaultText: 'Not set',
      },
      {
        key: 'anchorDate',
        label: 'First period starts',
        kind: { type: 'date' },
        defaultText: 'Not set',
      },
      {
        key: 'leadDays',
        label: 'Create ahead by',
        kind: { type: 'integer', min: 0, max: 90, unit: 'days' },
        defaultText: '0 days',
      },
      {
        key: 'autoMaterialize',
        label: 'Create timesheets automatically',
        kind: yesNo,
        defaultText: 'No',
      },
    ],
  },
];

/** A setting's value in words. */
export function describeValue(field: PolicyField | undefined, value: unknown): string {
  if (value === undefined || value === null || value === '') return 'Not set';
  if (!field) return String(value);
  switch (field.kind.type) {
    case 'boolean':
      return value === true ? 'Yes' : 'No';
    case 'enum':
      return field.kind.options.find((option) => option.value === value)?.label ?? String(value);
    case 'integer':
      return `${String(value)}${field.kind.unit ? ` ${field.kind.unit}` : ''}`;
    default:
      return String(value);
  }
}

export function fieldOf(section: string, key: string): PolicyField | undefined {
  return POLICY_SECTIONS.find((item) => item.key === section)?.fields.find(
    (field) => field.key === key,
  );
}

/** Checks a value against the field (the API validates again; this explains early). */
export function fieldError(field: PolicyField, raw: string): string | null {
  if (raw === '') return null;
  switch (field.kind.type) {
    case 'integer': {
      const value = Number(raw);
      if (!Number.isInteger(value)) return 'Enter a whole number.';
      if (value < field.kind.min || value > field.kind.max) {
        return `Enter ${field.kind.min} to ${field.kind.max}.`;
      }
      return null;
    }
    case 'localTime':
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? null : 'Enter a time as HH:MM.';
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? null : 'Enter a date.';
    default:
      return null;
  }
}

/** Converts a form value to the API's type. */
export function fieldValue(field: PolicyField, raw: string): unknown {
  switch (field.kind.type) {
    case 'boolean':
      return raw === 'true';
    case 'integer':
      return Number(raw);
    default:
      return raw;
  }
}

/** The form's text for a stored value ('' = inherit). */
export function fieldText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}
