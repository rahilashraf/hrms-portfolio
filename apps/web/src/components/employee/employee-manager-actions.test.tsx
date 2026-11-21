import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EmployeeAssignmentView } from '../../lib/employee/types';
import { EmployeeManagerActions, managerActionsAvailable } from './employee-manager-actions';

const assignment = (
  status: EmployeeAssignmentView['status'],
  manager: EmployeeAssignmentView['manager'] = null,
): EmployeeAssignmentView => ({
  id: status.toLowerCase(),
  employmentType: 'FULL_TIME',
  status,
  startDate: status === 'PLANNED' ? '9999-01-01' : '2026-01-01',
  endDate: status === 'ENDED' ? '2026-06-30' : null,
  isPrimary: status === 'ACTIVE',
  position: { id: 'position-1', name: 'Platform Engineer', code: 'PE-1' },
  jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  placement: null,
  workLocation: null,
  manager,
});

const manager = {
  assignmentId: 'manager-1',
  employeeId: 'employee-2',
  employeeNumber: 'EMP-000002',
  displayName: 'Grace Hopper',
  positionName: 'Engineering Manager',
};

describe('EmployeeManagerActions', () => {
  it('allows manager correction for planned, active, and ended assignments only', () => {
    expect(managerActionsAvailable(assignment('PLANNED'))).toBe(true);
    expect(managerActionsAvailable(assignment('ACTIVE'))).toBe(true);
    expect(managerActionsAvailable(assignment('ENDED'))).toBe(true);
    expect(managerActionsAvailable(assignment('CANCELLED'))).toBe(false);
  });

  it('renders set, change, and clear manager actions', () => {
    const onSet = vi.fn();
    const onClear = vi.fn();
    const { rerender } = render(
      <EmployeeManagerActions
        assignment={assignment('ACTIVE')}
        busy={false}
        onSet={onSet}
        onClear={onClear}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Set manager' }));
    expect(onSet).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Clear manager' })).not.toBeInTheDocument();

    rerender(
      <EmployeeManagerActions
        assignment={assignment('ENDED', manager)}
        busy={false}
        onSet={onSet}
        onClear={onClear}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change manager' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear manager' }));
    expect(onSet).toHaveBeenCalledTimes(2);
    expect(onClear).toHaveBeenCalledTimes(1);

    rerender(
      <EmployeeManagerActions
        assignment={assignment('CANCELLED', manager)}
        busy={false}
        onSet={onSet}
        onClear={onClear}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Change manager' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear manager' })).not.toBeInTheDocument();
  });
});
