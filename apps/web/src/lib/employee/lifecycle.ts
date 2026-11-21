export function localDateOnly(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isFutureDateOnly(value: string, today = localDateOnly()): boolean {
  return value > today;
}

/**
 * Batch 5C: the employment state people see. A scheduled termination is an ACTIVE employee
 * with a last day recorded (the API sets `terminationDate` when it is scheduled); the reason is
 * never part of it.
 */
export type EmployeeLifecycleState = 'ACTIVE' | 'INACTIVE' | 'TERMINATED' | 'TERMINATION_SCHEDULED';

export function employeeLifecycleState(
  status: 'ACTIVE' | 'INACTIVE' | 'TERMINATED',
  terminationDate?: string | null,
): EmployeeLifecycleState {
  if (status === 'ACTIVE' && terminationDate) return 'TERMINATION_SCHEDULED';
  return status;
}

export const EMPLOYEE_LIFECYCLE_LABELS: Record<EmployeeLifecycleState, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  TERMINATED: 'Terminated',
  TERMINATION_SCHEDULED: 'Termination scheduled',
};

export const ASSIGNMENT_STATUS_LABELS: Record<
  'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED',
  string
> = {
  PLANNED: 'Planned',
  ACTIVE: 'Active',
  ENDED: 'Ended',
  CANCELLED: 'Cancelled',
};
