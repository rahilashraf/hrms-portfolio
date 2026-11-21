'use client';

import { buttonClass } from '../ui/button';
import type { EmployeeAssignmentView } from '../../lib/employee/types';

export function managerActionsAvailable(assignment: EmployeeAssignmentView): boolean {
  return assignment.status !== 'CANCELLED';
}

export function EmployeeManagerActions({
  assignment,
  busy,
  onSet,
  onClear,
}: {
  assignment: EmployeeAssignmentView;
  busy: boolean;
  onSet(): void;
  onClear(): void;
}) {
  if (!managerActionsAvailable(assignment)) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={onSet}
        className={buttonClass('secondary', 'sm')}
      >
        {assignment.manager ? 'Change manager' : 'Set manager'}
      </button>
      {assignment.manager && (
        <button
          type="button"
          disabled={busy}
          onClick={onClear}
          className={buttonClass('secondary', 'sm')}
        >
          Clear manager
        </button>
      )}
    </div>
  );
}
