import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type { EmployeeManagerAssignmentOption } from '../../lib/employee/types';
import { EmployeeManagerPicker } from './employee-manager-picker';

const mocks = vi.hoisted(() => ({
  listManagerAssignmentOptions: vi.fn(),
}));

vi.mock('../../lib/employee/api', () => ({
  employeeApi: {
    listManagerAssignmentOptions: mocks.listManagerAssignmentOptions,
  },
}));

const managerOption: EmployeeManagerAssignmentOption = {
  assignmentId: 'manager-assignment-1',
  employeeId: 'employee-2',
  employeeNumber: 'EMP-000002',
  displayName: 'Grace Hopper',
  position: { id: 'position-1', name: 'Engineering Manager', code: 'EM-1' },
  jobTitle: { id: 'job-1', name: 'Manager', code: 'MGR' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  startDate: '2026-01-01',
  endDate: null,
  status: 'ACTIVE',
};

describe('EmployeeManagerPicker', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.listManagerAssignmentOptions.mockResolvedValue({
      items: [managerOption],
      nextAfterId: null,
    });
  });

  afterEach(cleanup);

  it('loads eligible manager assignments for the subordinate assignment and selects an option', async () => {
    const onSelect = vi.fn();
    render(
      <EmployeeManagerPicker
        subordinateAssignmentId="assignment-1"
        selected={null}
        onSelect={onSelect}
      />,
    );

    await waitFor(() =>
      expect(mocks.listManagerAssignmentOptions).toHaveBeenCalledWith({
        subordinateAssignmentId: 'assignment-1',
        limit: 10,
      }),
    );
    expect(await screen.findByRole('button', { name: /Grace Hopper/ })).toBeInTheDocument();
    expect(screen.getByText('Engineering Manager · Manager · Acme')).toBeInTheDocument();
    expect(screen.queryByText('manager-assignment-1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Grace Hopper/ }));
    expect(onSelect).toHaveBeenCalledWith(managerOption);
  });

  it('searches, appends cursor pages, and shows the selected state', async () => {
    const nextOption = {
      ...managerOption,
      assignmentId: 'manager-assignment-2',
      employeeId: 'employee-3',
      employeeNumber: 'EMP-000003',
      displayName: 'Katherine Johnson',
    };
    mocks.listManagerAssignmentOptions
      .mockResolvedValueOnce({ items: [managerOption], nextAfterId: 'manager-assignment-1' })
      .mockResolvedValueOnce({ items: [managerOption], nextAfterId: 'manager-assignment-1' })
      .mockResolvedValueOnce({ items: [nextOption], nextAfterId: null });

    render(
      <EmployeeManagerPicker
        subordinateAssignmentId="assignment-1"
        selected={managerOption}
        onSelect={vi.fn()}
      />,
    );
    expect(await screen.findByText('Selected')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search manager assignments'), {
      target: { value: 'Grace' },
    });
    await waitFor(() =>
      expect(mocks.listManagerAssignmentOptions).toHaveBeenCalledWith({
        subordinateAssignmentId: 'assignment-1',
        search: 'Grace',
        limit: 10,
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Load more managers' }));
    await waitFor(() =>
      expect(mocks.listManagerAssignmentOptions).toHaveBeenLastCalledWith({
        subordinateAssignmentId: 'assignment-1',
        search: 'Grace',
        limit: 10,
        afterId: 'manager-assignment-1',
      }),
    );
    expect(await screen.findByText('Katherine Johnson')).toBeInTheDocument();
  });

  it('renders empty and error states safely', async () => {
    mocks.listManagerAssignmentOptions.mockResolvedValueOnce({ items: [], nextAfterId: null });
    const empty = render(
      <EmployeeManagerPicker
        subordinateAssignmentId="assignment-1"
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    expect(await screen.findByText('No eligible manager assignments found.')).toBeInTheDocument();
    empty.unmount();

    mocks.listManagerAssignmentOptions.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    render(
      <EmployeeManagerPicker
        subordinateAssignmentId="assignment-1"
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to manage this assignment.',
    );
  });
});
