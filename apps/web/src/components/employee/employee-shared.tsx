import { enumLabel } from '../../lib/ui/labels';
import type { ReactNode } from 'react';
import { formatDateOnly } from '../../lib/employee/date';
import {
  ASSIGNMENT_STATUS_LABELS,
  EMPLOYEE_LIFECYCLE_LABELS,
  employeeLifecycleState,
} from '../../lib/employee/lifecycle';
import type { Tone } from '../ui/tokens';
import { StatusBadge } from '../ui/status-badge';
import type {
  EmployeePersonSummary,
  EmploymentAssignmentStatus,
  EmploymentType,
  EmployeeStatus,
} from '../../lib/employee/types';

export function displayName(person: EmployeePersonSummary): string {
  return (
    person.preferredName ||
    [person.firstName, person.lastName].filter(Boolean).join(' ') ||
    person.firstName ||
    person.lastName ||
    'Unnamed employee'
  );
}

export function humanize(value: string): string {
  return value ? enumLabel(value) : '';
}

/**
 * Batch 5C: one badge for every place an employee's status is shown (directory, profile, My
 * Profile). With `terminationDate`, an ACTIVE employee shows "Termination scheduled" and the
 * last day (inclusive). Color is never the only signal: the label always says the state.
 */
export function EmployeeStatusBadge({
  status,
  terminationDate,
}: {
  status: EmployeeStatus;
  terminationDate?: string | null;
}) {
  const state = employeeLifecycleState(status, terminationDate);
  // Batch 10B: the shared StatusBadge; the lifecycle keeps its own tones (a terminated employee
  // is "danger", a scheduled termination "warning").
  const tone: Tone =
    state === 'ACTIVE'
      ? 'success'
      : state === 'TERMINATED'
        ? 'danger'
        : state === 'TERMINATION_SCHEDULED'
          ? 'warning'
          : 'neutral';
  const label =
    state === 'TERMINATION_SCHEDULED' && terminationDate
      ? `${EMPLOYEE_LIFECYCLE_LABELS[state]} · last day ${formatDateOnly(terminationDate)}`
      : EMPLOYEE_LIFECYCLE_LABELS[state];
  return <StatusBadge status={state} label={label} tone={tone} />;
}

export function AssignmentStatusBadge({ status }: { status: EmploymentAssignmentStatus }) {
  // Batch 10B: the shared StatusBadge (a planned assignment is "info", as before).
  const tone: Tone = status === 'ACTIVE' ? 'success' : status === 'PLANNED' ? 'info' : 'neutral';
  return (
    <StatusBadge
      status={status}
      label={ASSIGNMENT_STATUS_LABELS[status] ?? humanize(status)}
      tone={tone}
    />
  );
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

export function employmentTypeLabel(type: EmploymentType): string {
  return humanize(type);
}
