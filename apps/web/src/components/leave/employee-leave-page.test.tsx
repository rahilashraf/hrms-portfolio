import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { EmployeeLeavePage } from './employee-leave-page';

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  myRequests: vi.fn(),
  previewOwn: vi.fn(),
  submitOwn: vi.fn(),
  cancelOwn: vi.fn(),
  myRequest: vi.fn(),
  myLedger: vi.fn(),
  myTeamCalendar: vi.fn(async () => ({
    range: { from: '', to: '' },
    teams: [],
    hasTeam: false,
    people: [],
  })),
  myHolidays: vi.fn(async () => ({ items: [] })),
}));

vi.mock('../../lib/leave/api', () => ({ leaveApi: mocks }));

const vacation = {
  id: 'type-vac',
  code: 'VAC',
  name: 'Vacation',
  classification: 'PAID',
  tracksBalance: true,
  displayUnit: 'HOURS',
};

const overview = {
  employeeId: 'employee-1',
  assignments: [
    {
      employmentAssignmentId: 'assignment-1',
      isPrimary: true,
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      startDate: '2026-01-01',
      endDate: null,
      position: { id: 'position-1', name: 'Counsellor', code: 'COUN' },
      organization: { id: 'org-1', name: 'Camp' },
      timezone: 'America/Toronto',
      asOf: '2027-03-02',
      leaveTypes: [
        {
          leaveType: vacation,
          eligible: true,
          policy: {
            id: 'policy-1',
            standardWorkdayMinutes: 480,
            allowPartialDay: true,
            amountSource: 'SCHEDULE_THEN_STANDARD',
            negativeBalanceLimitMinutes: 0,
            employeeMayCancelApprovedFuture: true,
          },
          accountId: 'account-1',
          balance: {
            currentMinutes: 2400,
            scheduledMinutes: 480,
            availableMinutes: 1920,
            pendingMinutes: 0,
          },
          actions: { canRequest: true },
        },
      ],
      actions: { canRequest: true },
    },
  ],
};

const day = (date: string, minutes = 480, amountSource = 'STANDARD_DAY') => ({
  date,
  minutes,
  amountSource,
  windowStart: `${date}T14:00:00.000Z`,
  windowEnd: `${date}T22:00:00.000Z`,
  absenceStart: `${date}T05:00:00.000Z`,
  absenceEnd: `${date}T05:00:00.000Z`,
  scheduledShiftRevisionIds: [],
  holidayName: amountSource === 'HOLIDAY_EXCLUDED' ? 'Founders Day' : null,
  overrideReason: null,
  cancelled: false,
});

const approvedRequest = {
  id: 'request-1',
  status: 'APPROVED',
  employee: { id: 'employee-1', employeeNumber: 'E1', displayName: 'Ada Lovelace' },
  employmentAssignmentId: 'assignment-1',
  positionName: 'Counsellor',
  leaveType: vacation,
  startDate: '2027-04-06',
  endDate: '2027-04-06',
  startLocalTime: null,
  endLocalTime: null,
  timezone: 'America/Toronto',
  requestedMinutes: 480,
  approvedMinutes: 480,
  activeMinutes: 480,
  cancelledDayCount: 0,
  submittedAt: '2027-03-01T12:00:00.000Z',
  actions: { canCancel: true },
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.me.mockResolvedValue(overview);
  mocks.myRequests.mockResolvedValue({ items: [approvedRequest], nextAfterId: null });
  mocks.previewOwn.mockResolvedValue({
    employmentAssignmentId: 'assignment-1',
    leaveType: vacation,
    timezone: 'America/Toronto',
    startDate: '2027-03-08',
    endDate: '2027-03-10',
    partial: null,
    totalMinutes: 960,
    days: [day('2027-03-08'), day('2027-03-09', 0, 'HOLIDAY_EXCLUDED'), day('2027-03-10')],
    balance: {
      currentMinutes: 2400,
      scheduledMinutes: 480,
      availableMinutes: 1920,
      pendingMinutes: 0,
      leaveYear: { start: '2027-01-01', end: '2027-12-31' },
      availableForLeaveYearMinutes: 1920,
      availableAfterMinutes: 960,
      negativeBalanceLimitMinutes: 0,
      sufficient: true,
    },
  });
  mocks.submitOwn.mockResolvedValue({ requestId: 'request-2', status: 'PENDING' });
  mocks.cancelOwn.mockResolvedValue({ requestId: 'request-1', status: 'CANCELLED' });
});

afterEach(cleanup);

describe('EmployeeLeavePage', () => {
  it('shows backend balances and the request list with backend actions', async () => {
    render(<EmployeeLeavePage />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Vacation' })).toBeInTheDocument(),
    );
    expect(screen.getByText('32h')).toBeInTheDocument(); // available 1920 minutes
    expect(screen.getByText('40h')).toBeInTheDocument(); // current
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('previews the backend sizing before submitting exactly what was previewed', async () => {
    render(<EmployeeLeavePage />);
    await waitFor(() => expect(screen.getByLabelText('Start date')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-03-08' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-03-10' } });
    expect(screen.queryByRole('button', { name: /^Submit/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() =>
      expect(screen.getByText('Founders Day', { exact: false })).toBeInTheDocument(),
    );
    expect(mocks.previewOwn).toHaveBeenCalledWith({
      employmentAssignmentId: 'assignment-1',
      leaveTypeId: 'type-vac',
      startDate: '2027-03-08',
      endDate: '2027-03-10',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit 16h' }));
    await waitFor(() =>
      expect(mocks.submitOwn).toHaveBeenCalledWith(mocks.previewOwn.mock.calls[0]![0]),
    );
    await waitFor(() => expect(screen.getByText('Leave requested.')).toBeInTheDocument());
  });

  it('invalidates the preview on edit and blocks submitting an insufficient balance', async () => {
    mocks.previewOwn.mockResolvedValueOnce({
      ...(await mocks.previewOwn()),
      balance: {
        currentMinutes: 0,
        scheduledMinutes: 0,
        availableMinutes: 0,
        pendingMinutes: 0,
        leaveYear: { start: '2027-01-01', end: '2027-12-31' },
        availableForLeaveYearMinutes: 0,
        availableAfterMinutes: -960,
        negativeBalanceLimitMinutes: 0,
        sufficient: false,
      },
    });
    mocks.previewOwn.mockClear();
    render(<EmployeeLeavePage />);
    await waitFor(() => expect(screen.getByLabelText('Start date')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-03-08' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(
        screen.getByText('This leave exceeds the balance available for its leave year.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^Submit/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-03-09' } });
    expect(screen.queryByRole('button', { name: /^Submit/ })).not.toBeInTheDocument();
  });

  it('sends a partial day only with its times and shows server errors', async () => {
    mocks.previewOwn.mockRejectedValueOnce(
      new AuthApiError(
        'conflict',
        409,
        'The leave overlaps another pending or approved leave of this assignment.',
      ),
    );
    render(<EmployeeLeavePage />);
    await waitFor(() => expect(screen.getByLabelText('Partial day')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-03-08' } });
    fireEvent.click(screen.getByLabelText('Partial day'));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '09:00' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '12:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(
        screen.getByText(
          'The leave overlaps another pending or approved leave of this assignment.',
        ),
      ).toBeInTheDocument(),
    );
    expect(mocks.previewOwn).toHaveBeenCalledWith({
      employmentAssignmentId: 'assignment-1',
      leaveTypeId: 'type-vac',
      startDate: '2027-03-08',
      endDate: '2027-03-08',
      startLocalTime: '09:00',
      endLocalTime: '12:00',
    });
  });

  it('requests the full range again after switching to a type without partial days', async () => {
    const sick = { ...vacation, id: 'type-sick', code: 'SICK', name: 'Sick' };
    const [assignment] = overview.assignments;
    mocks.me.mockResolvedValue({
      ...overview,
      assignments: [
        {
          ...assignment,
          leaveTypes: [
            ...assignment!.leaveTypes,
            {
              ...assignment!.leaveTypes[0]!,
              leaveType: sick,
              accountId: 'account-2',
              policy: { ...assignment!.leaveTypes[0]!.policy, allowPartialDay: false },
            },
          ],
        },
      ],
    });
    render(<EmployeeLeavePage />);
    await waitFor(() => expect(screen.getByLabelText('Partial day')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-03-08' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-03-10' } });
    fireEvent.click(screen.getByLabelText('Partial day'));
    expect(screen.queryByLabelText('End date')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Leave type'), { target: { value: 'type-sick' } });
    expect(screen.queryByLabelText('Partial day')).not.toBeInTheDocument();
    expect(screen.getByLabelText('End date')).toHaveValue('2027-03-10');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(mocks.previewOwn).toHaveBeenCalledWith({
        employmentAssignmentId: 'assignment-1',
        leaveTypeId: 'type-sick',
        startDate: '2027-03-08',
        endDate: '2027-03-10',
      }),
    );

    // Back on a type that allows it, the partial day starts unticked.
    fireEvent.change(screen.getByLabelText('Leave type'), { target: { value: 'type-vac' } });
    expect(screen.getByLabelText('Partial day')).not.toBeChecked();
  });

  it('cancels approved future leave after confirmation', async () => {
    render(<EmployeeLeavePage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel this leave?' });
    expect(dialog).toHaveAccessibleDescription(/returned to your balance/);
    // Keeping the leave changes nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep leave' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mocks.cancelOwn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel leave' }));
    await waitFor(() => expect(mocks.cancelOwn).toHaveBeenCalledWith('request-1'));
  });
});
