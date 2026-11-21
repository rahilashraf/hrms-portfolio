import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { EmployeeAttendancePinSection } from './employee-attendance-pin-section';

const mocks = vi.hoisted(() => ({ pinStatus: vi.fn(), issuePin: vi.fn(), revokePin: vi.fn() }));

vi.mock('../../lib/attendance/api', () => ({ attendanceApi: mocks }));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('EmployeeAttendancePinSection', () => {
  it('issues a PIN and shows it once', async () => {
    mocks.pinStatus
      .mockResolvedValueOnce({
        employeeId: 'employee-1',
        hasPin: false,
        issuedAt: null,
        lastUsedAt: null,
        locked: false,
      })
      .mockResolvedValue({
        employeeId: 'employee-1',
        hasPin: true,
        issuedAt: '2026-10-05T12:00:00.000Z',
        lastUsedAt: null,
        locked: false,
      });
    mocks.issuePin.mockResolvedValue({ employeeId: 'employee-1', pin: '582914', reset: false });
    render(<EmployeeAttendancePinSection employeeId="employee-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Issue PIN' }));

    expect(await screen.findByTestId('issued-pin')).toHaveTextContent('582914');
    expect(mocks.issuePin).toHaveBeenCalledWith('employee-1');
    expect(screen.getByRole('button', { name: 'Reset PIN' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('issued-pin')).not.toBeInTheDocument();
  });

  it('confirms a PIN reset with the shared ConfirmDialog (no window.confirm)', async () => {
    const native = vi.spyOn(window, 'confirm');
    mocks.pinStatus.mockResolvedValue({
      employeeId: 'employee-1',
      hasPin: true,
      issuedAt: '2026-10-05T12:00:00.000Z',
      lastUsedAt: null,
      locked: false,
    });
    mocks.issuePin.mockResolvedValue({ employeeId: 'employee-1', pin: '771100', reset: true });
    render(<EmployeeAttendancePinSection employeeId="employee-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reset PIN' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset the PIN?' });
    expect(dialog).toHaveTextContent('The current PIN stops working immediately.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.issuePin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reset PIN' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reset PIN' }),
    );
    expect(await screen.findByTestId('issued-pin')).toHaveTextContent('771100');
    expect(native).not.toHaveBeenCalled();
  });

  it('revokes a PIN with a reason', async () => {
    mocks.pinStatus.mockResolvedValue({
      employeeId: 'employee-1',
      hasPin: true,
      issuedAt: '2026-10-05T12:00:00.000Z',
      lastUsedAt: null,
      locked: true,
    });
    mocks.revokePin.mockResolvedValue({ hasPin: false });
    render(<EmployeeAttendancePinSection employeeId="employee-1" />);

    expect(await screen.findByText(/Temporarily locked/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke PIN' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Shared PIN' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke PIN' })[1]!);

    await waitFor(() => expect(mocks.revokePin).toHaveBeenCalledWith('employee-1', 'Shared PIN'));
  });

  it('hides itself where the permission does not reach the employee', async () => {
    mocks.pinStatus.mockRejectedValue(new AuthApiError('forbidden', 403));
    const { container } = render(<EmployeeAttendancePinSection employeeId="employee-1" />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('hides itself, like a 403, when the employee is not visible to the user at all (404)', async () => {
    mocks.pinStatus.mockRejectedValue(new AuthApiError('unexpected', 404));
    const { container } = render(<EmployeeAttendancePinSection employeeId="employee-1" />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(container).not.toHaveTextContent(/not found/i);
  });
});
