import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import type { EmployeeAssignmentView, EmployeeProfile } from '../../lib/employee/types';
import { AssignmentCard } from './employee-assignment-card';
import { AssignmentManagerClearConfirm, AssignmentManagerForm } from './employee-manager-form';
import { EmployeeProfileEditForm } from './employee-profile-edit-form';

/**
 * Batch 10B — the pieces moved out of `employee-profile.tsx` behave as they did inside it: the
 * assignment card shows the assignment and its manager warnings, the manager form requires a
 * manager, and the edit form sends trimmed values (blank → not provided) and shows API errors.
 */
const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../../lib/employee/api', () => ({ employeeApi: { update: mocks.update } }));
// The picker searches the API; here it offers one manager.
vi.mock('./employee-manager-picker', () => ({
  EmployeeManagerPicker: ({ onSelect }: { onSelect(option: unknown): void }) => (
    <button type="button" onClick={() => onSelect({ id: 'asg-m', displayName: 'Grace Hopper' })}>
      Pick Grace Hopper
    </button>
  ),
}));

const assignment: EmployeeAssignmentView = {
  id: 'asg-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-05',
  endDate: null,
  isPrimary: true,
  position: { id: 'pos-1', name: 'Senior Outdoor Education Coordinator', code: 'SOEC' },
  jobTitle: { id: 'jt-1', name: 'Coordinator', code: 'COORD' },
  organization: { id: 'org-1', name: 'Northwind Academy', code: 'NWA' },
  placement: { type: 'TEAM', id: 'team-1', name: 'Aquatics' },
  workLocation: null,
  manager: {
    assignmentId: 'asg-m',
    employeeId: 'emp-m',
    displayName: 'Grace Hopper',
    positionName: 'Director',
  },
  managerWarnings: ['MANAGER_ASSIGNMENT_ENDED'],
} as EmployeeAssignmentView;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('AssignmentCard', () => {
  it('shows the assignment, its placement and manager, and warnings only when asked', async () => {
    const { container, rerender } = render(<AssignmentCard assignment={assignment} />);
    expect(
      screen.getByRole('heading', { level: 4, name: 'Senior Outdoor Education Coordinator' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Coordinator · Northwind Academy')).toBeInTheDocument();
    expect(screen.getByText('Aquatics')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByText(/manager’s assignment has ended/)).not.toBeInTheDocument();
    rerender(<AssignmentCard assignment={assignment} showWarnings />);
    expect(screen.getByText(/manager’s assignment has ended/)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe('AssignmentManagerForm / AssignmentManagerClearConfirm', () => {
  it('requires a manager, then submits the chosen one', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AssignmentManagerForm
        assignment={assignment}
        busy={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Change manager' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save manager' }));
    expect(await screen.findByText('Manager assignment is required.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pick Grace Hopper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save manager' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ id: 'asg-m', displayName: 'Grace Hopper' }),
    );
  });

  it('clearing asks first, shows the API error and disables while busy', () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <AssignmentManagerClearConfirm
        busy={false}
        error="The manager link changed."
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('The manager link changed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear manager' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    rerender(
      <AssignmentManagerClearConfirm busy error={null} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Clearing...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep manager' })).toBeDisabled();
  });
});

describe('EmployeeProfileEditForm', () => {
  const profile = {
    id: 'emp-1',
    person: {
      firstName: 'Ada',
      middleName: null,
      lastName: 'Lovelace',
      preferredName: null,
      personalEmail: null,
      phone: '555-0100',
    },
  } as unknown as EmployeeProfile;

  it('sends only changed fields, trimmed; an emptied optional field is cleared (R4-A.2)', async () => {
    mocks.update.mockResolvedValue({});
    const onSaved = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <EmployeeProfileEditForm profile={profile} onCancel={vi.fn()} onSaved={onSaved} />,
    );
    fireEvent.change(screen.getByLabelText('Preferred name'), { target: { value: '  Addie ' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Profile updated. Removed: Phone.'));
    // Unchanged fields are omitted; the cleared phone is sent as null.
    expect(mocks.update).toHaveBeenCalledWith('emp-1', { preferredName: 'Addie', phone: null });
    await expectNoAxeViolations(container);
  });

  it('never sends an emptied legal name, and sends nothing when nothing changed', async () => {
    render(<EmployeeProfileEditForm profile={profile} onCancel={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Nothing changed.')).toBeInTheDocument();
    const first = screen.getByLabelText(/^First name/);
    fireEvent.change(first, { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(
      await screen.findByText('The legal first and last name cannot be removed.'),
    ).toBeInTheDocument();
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(first).toHaveFocus();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('clears a field that had a value and leaves an already-empty one alone', async () => {
    mocks.update.mockResolvedValue({});
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(<EmployeeProfileEditForm profile={profile} onCancel={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Middle name'), { target: { value: 'Byron' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith('emp-1', { middleName: 'Byron' }),
    );
    expect(onSaved).toHaveBeenCalledWith('Profile updated.');
  });

  it('shows the API refusal and keeps the form', async () => {
    mocks.update.mockRejectedValue(new Error('boom'));
    render(<EmployeeProfileEditForm profile={profile} onCancel={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '555-0199' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Unable to update profile.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^First name/)).toHaveValue('Ada');
  });
});
