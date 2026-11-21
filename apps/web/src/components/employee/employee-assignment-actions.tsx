'use client';

import { buttonClass } from '../ui/button';
import type { EmployeeAssignmentView } from '../../lib/employee/types';
import { isFutureDateOnly, localDateOnly } from '../../lib/employee/lifecycle';

export type AssignmentActionKind = 'add' | 'correct' | 'end' | 'cancel' | 'activate';

export interface AssignmentActionAvailability {
  correct: boolean;
  end: boolean;
  cancel: boolean;
  primary: boolean;
  /** PLANNED → ACTIVE: started, not expired, employee active. The API re-checks it all. */
  activate: boolean;
}

export function assignmentActionAvailability(
  assignment: EmployeeAssignmentView,
  today = localDateOnly(),
  employeeActive = true,
): AssignmentActionAvailability {
  if (assignment.status === 'CANCELLED') {
    return { correct: false, end: false, cancel: false, primary: false, activate: false };
  }
  if (assignment.status === 'ENDED') {
    return { correct: true, end: false, cancel: false, primary: false, activate: false };
  }
  if (assignment.status === 'PLANNED' && isFutureDateOnly(assignment.startDate, today)) {
    return { correct: true, end: false, cancel: true, primary: true, activate: false };
  }
  const activate =
    assignment.status === 'PLANNED' &&
    employeeActive &&
    (assignment.endDate === null || assignment.endDate >= today);
  return { correct: true, end: true, cancel: false, primary: true, activate };
}

export function AssignmentActions({
  assignment,
  busy,
  onCorrect,
  onEnd,
  onCancel,
  onPrimary,
  onActivate,
  onTransfer,
  onImpact,
  employeeActive = true,
}: {
  assignment: EmployeeAssignmentView;
  busy: boolean;
  onCorrect(): void;
  onEnd(): void;
  onCancel(): void;
  onPrimary(): void;
  onActivate?(): void;
  /** Batch 5C: atomic transfer to another position (current assignments). */
  onTransfer?(): void;
  /** Batch 5C: read-only impact preview of ending this assignment. */
  onImpact?(): void;
  employeeActive?: boolean;
}) {
  const availability = assignmentActionAvailability(assignment, undefined, employeeActive);
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      {availability.activate && onActivate && (
        <button
          type="button"
          disabled={busy}
          onClick={onActivate}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Activate assignment
        </button>
      )}
      {availability.correct && (
        <button
          type="button"
          disabled={busy}
          onClick={onCorrect}
          className={buttonClass('secondary', 'sm')}
        >
          Correct assignment
        </button>
      )}
      {availability.end && (
        <button
          type="button"
          disabled={busy}
          onClick={onEnd}
          className={buttonClass('secondary', 'sm')}
        >
          End assignment
        </button>
      )}
      {onTransfer && (
        <button
          type="button"
          disabled={busy}
          onClick={onTransfer}
          className={buttonClass('secondary', 'sm')}
        >
          Transfer
        </button>
      )}
      {onImpact && (
        <button
          type="button"
          disabled={busy}
          onClick={onImpact}
          className={buttonClass('secondary', 'sm')}
        >
          Preview impact
        </button>
      )}
      {availability.cancel && (
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className={buttonClass('danger', 'sm')}
        >
          Cancel assignment
        </button>
      )}
      {availability.primary && (
        <button
          type="button"
          disabled={busy}
          onClick={onPrimary}
          className="rounded-md border border-indigo-300 px-3 py-1.5 text-sm font-medium text-indigo-800 hover:bg-indigo-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Updating...' : assignment.isPrimary ? 'Unset primary' : 'Set primary'}
        </button>
      )}
    </div>
  );
}
