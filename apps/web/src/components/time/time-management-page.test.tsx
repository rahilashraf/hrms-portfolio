import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeManagementPage } from './time-management-page';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  managementCurrent: vi.fn(),
  managementEntries: vi.fn(),
  managementExceptions: vi.fn(),
  managementCorrections: vi.fn(),
  managementTimesheets: vi.fn(),
  approveCorrection: vi.fn(),
  reopenTimesheet: vi.fn(),
  periods: vi.fn(),
  organizations: vi.fn(),
  devices: vi.fn(),
}));

vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../lib/time/api', () => ({ timeApi: mocks }));
vi.mock('../../lib/attendance/api', () => ({ attendanceApi: mocks }));

const REVIEW = {
  canViewAttendance: true,
  canCorrectTime: false,
  canReviewExceptions: true,
  canReviewCorrections: true,
  canApproveTimesheets: false,
  canManageTimesheets: false,
  canManagePeriods: false,
};

function organization(id: string, name: string, actions: Record<string, boolean> = REVIEW) {
  return {
    id,
    name,
    code: id.toUpperCase(),
    timezone: 'America/Toronto',
    workLocations: [],
    physicalSites: [],
    actions: {
      canViewSignIns: false,
      canCorrectSignIns: false,
      canManageDevices: false,
      canManagePolicies: false,
      canManagePins: false,
      ...actions,
    },
  };
}

const empty = { items: [], nextAfterId: null };

beforeEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/admin/time');
  window.localStorage.clear();
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    identity: { id: 'manager-user' },
    authorization: {
      permissions: [
        { key: 'time.view', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
        { key: 'time.approve', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
      ],
    },
  });
  mocks.organizations.mockResolvedValue({ items: [organization('org-1', 'Camp')] });
  mocks.managementCurrent.mockResolvedValue(empty);
  mocks.managementEntries.mockResolvedValue(empty);
  mocks.managementExceptions.mockResolvedValue(empty);
  mocks.managementCorrections.mockResolvedValue({
    items: [
      {
        id: 'correction-1',
        employeeId: 'employee-1',
        employeeName: 'Ada Lovelace',
        requestorUserId: 'user-1',
        reviewerUserId: null,
        timeEntryId: 'entry-1',
        breakEntryId: null,
        employmentAssignmentId: 'assignment-1',
        targetEmploymentAssignmentId: null,
        type: 'CHANGE_CLOCK_OUT',
        status: 'PENDING',
        reason: 'Forgot cleanup',
        reviewerNote: null,
        requestedValues: { clockOutAt: '2026-10-03T21:00:00.000Z' },
        currentValues: { clockOutAt: '2026-10-03T20:00:00.000Z' },
        requestedAt: '2026-10-03T12:00:00.000Z',
        reviewedAt: null,
        cancelledAt: null,
        adjustmentId: null,
        timezone: 'America/Toronto',
        actors: { 'user-1': 'Ada Lovelace' },
      },
    ],
    nextAfterId: null,
  });
  mocks.managementTimesheets.mockResolvedValue(empty);
  mocks.periods.mockResolvedValue(empty);
  mocks.approveCorrection.mockResolvedValue({});
});

afterEach(cleanup);

describe('TimeManagementPage', () => {
  it('gates access with time permissions', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: { permissions: [] },
    });
    render(<TimeManagementPage />);
    expect(
      screen.getByText('You do not have permission to view time operations.'),
    ).toBeInTheDocument();
  });

  it('loads the chosen organization’s queues and approves a pending correction', async () => {
    render(<TimeManagementPage />);
    await waitFor(() => expect(screen.getByText('Pending corrections')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Corrections' }));
    // Batch 10F: picking a section writes it into the URL (replace), so a bookmark keeps it.
    expect(window.location.hash).toBe('#corrections');
    await waitFor(() => expect(screen.getByText('Forgot cleanup')).toBeInTheDocument());
    // Requested next to recorded, with who asked.
    const card = screen.getByRole('group', { name: /Change Clock Out for Ada Lovelace/i });
    expect(within(card).getByRole('row', { name: /Clock out/ })).toHaveTextContent(
      /4:00 PM.*5:00 PM/,
    );
    expect(within(card).getByText(/by Ada Lovelace/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Approve / }));
    await waitFor(() => expect(mocks.approveCorrection).toHaveBeenCalledWith('correction-1'));
    expect(await screen.findByText('Correction approved.')).toBeInTheDocument();
    // Every queue is filtered to the organization by the API, never in the browser.
    for (const call of mocks.managementCorrections.mock.calls) {
      expect(call[0]).toMatchObject({ organizationId: 'org-1' });
    }
  });

  it('shows simultaneous assignment coverage without inflating worked time', async () => {
    const view = (id: string, name: string) => ({
      id,
      status: 'ACTIVE',
      position: { id: `position-${id}`, name },
      organization: { id: 'org-1', name: 'Camp' },
    });
    mocks.managementEntries.mockResolvedValue({
      items: [
        {
          id: 'entry-1',
          employeeId: 'employee-1',
          employeeNumber: 'E-1',
          employeeName: 'Ada Lovelace',
          employmentAssignmentId: 'teacher',
          assignment: view('teacher', 'HBLA Teacher'),
          coverage: [
            {
              employmentAssignmentId: 'teacher',
              assignment: view('teacher', 'HBLA Teacher'),
              isPayrollOwner: true,
            },
            {
              employmentAssignmentId: 'tutoring',
              assignment: view('tutoring', 'Tutoring Teacher'),
              isPayrollOwner: false,
            },
          ],
          workDate: '2026-10-05',
          clockInAt: '2026-10-05T13:00:00.000Z',
          clockOutAt: '2026-10-05T19:00:00.000Z',
          timezone: 'America/Toronto',
          status: 'CLOSED',
          source: 'KIOSK',
          grossMinutes: 360,
          paidBreakMinutes: 0,
          unpaidBreakMinutes: 0,
          breakMinutes: 0,
          netWorkedMinutes: 360,
          policyDeductionMinutes: 30,
          payableMinutes: 330,
          exceptions: [],
          corrections: [],
        },
      ],
      nextAfterId: null,
    });
    render(<TimeManagementPage />);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Records' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Records' }));

    const region = await screen.findByRole('region', { name: 'Attendance records' });
    expect(within(region).getByText('Also covers: Tutoring Teacher')).toBeInTheDocument();
    expect(within(region).getByText('Paid')).toBeInTheDocument();
    // One row, six hours: never twelve. The automatic deduction and payable minutes are shown.
    expect(within(region).getAllByRole('row')).toHaveLength(2);
    expect(within(region).getByText('6h')).toBeInTheDocument();
    expect(within(region).queryByText('12h')).not.toBeInTheDocument();
    expect(within(region).getByText('30m')).toBeInTheDocument();
    expect(within(region).getByText('5h 30m')).toBeInTheDocument();
    // The table's scroll area is a named, focusable region (keyboard scrolling).
    expect(region).toHaveAttribute('tabindex', '0');
    expect(mocks.managementEntries).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
    );
  });

  it('switches organizations, remembers the choice and reloads every list for it', async () => {
    mocks.organizations.mockResolvedValue({
      items: [organization('org-1', 'Camp'), organization('org-2', 'School')],
    });
    render(<TimeManagementPage />);
    const picker = await screen.findByLabelText('Organization');
    await waitFor(() =>
      expect(mocks.managementCorrections).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1' }),
      ),
    );
    fireEvent.change(picker, { target: { value: 'org-2' } });
    await waitFor(() =>
      expect(mocks.managementCorrections).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationId: 'org-2' }),
      ),
    );
    expect(window.localStorage.getItem('hrms.timeReview.organizationId')).toBe('org-2');
  });

  it('offers only organizations with review capabilities, and explains when there are none', async () => {
    mocks.organizations.mockResolvedValue({
      items: [
        organization('org-1', 'Kiosks only', {
          canViewAttendance: false,
          canCorrectTime: false,
          canReviewExceptions: false,
          canReviewCorrections: false,
          canApproveTimesheets: false,
          canManageTimesheets: false,
          canManagePeriods: false,
          canManageDevices: true,
        }),
      ],
    });
    render(<TimeManagementPage />);
    expect(await screen.findByText('No organizations to review')).toBeInTheDocument();
    expect(mocks.managementCorrections).not.toHaveBeenCalled();
  });

  it('gives device administrators the attendance tab without Time operations', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'time.device.manage', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
        ],
      },
    });
    mocks.organizations.mockResolvedValue({
      items: [
        organization('org-1', 'Camp', {
          canManageDevices: true,
        }),
      ],
    });
    mocks.devices.mockResolvedValue({ items: [] });
    render(<TimeManagementPage />);

    expect(await screen.findByText('No kiosks registered.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Overview' })).not.toBeInTheDocument();
    expect(mocks.managementCurrent).not.toHaveBeenCalled();
  });

  it('opens kiosk management from the nested attendance deep link', async () => {
    window.history.replaceState(null, '', '/admin/time?attendanceTab=kiosks#attendance');
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'time.view', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
          { key: 'time.device.manage', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
        ],
      },
    });
    mocks.organizations.mockResolvedValue({
      items: [organization('org-1', 'Camp', { canViewSignIns: true, canManageDevices: true })],
    });
    mocks.devices.mockResolvedValue({ items: [] });
    render(<TimeManagementPage />);

    expect(await screen.findByText('No kiosks registered.')).toBeInTheDocument();
    // Batch 10C: the sections are tabs.
    expect(screen.getByRole('tab', { name: 'Attendance' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Kiosks' })).toHaveAttribute('aria-selected', 'true');
  });

  it('reopens an approved timesheet from its deep link with a reason and the version seen', async () => {
    window.history.replaceState(
      null,
      '',
      '/admin/time?timesheetPeriod=period-1&timesheetEmployee=employee-1#timesheets',
    );
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      identity: { id: 'manager-user' },
      authorization: {
        permissions: [
          { key: 'time.timesheet.manage', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
        ],
      },
    });
    mocks.organizations.mockResolvedValue({
      items: [
        organization('org-1', 'Camp', {
          canViewAttendance: false,
          canCorrectTime: false,
          canReviewExceptions: false,
          canReviewCorrections: false,
          canApproveTimesheets: false,
          canManageTimesheets: true,
          canManagePeriods: true,
        }),
      ],
    });
    mocks.managementTimesheets.mockResolvedValue({
      items: [
        {
          id: 'sheet-1',
          employeeId: 'employee-1',
          timePeriodId: 'period-1',
          status: 'APPROVED',
          version: 4,
          approvedByUserId: 'approver-user',
          approvedAt: '2026-09-16T15:00:00.000Z',
          period: { id: 'period-1', startDate: '2026-09-01', endDate: '2026-09-14' },
          employee: { id: 'employee-1', employeeNumber: 'E-1', name: 'Ada Lovelace' },
          totals: {
            payrollWorkDates: [
              {
                workDate: '2026-09-02',
                employmentAssignmentId: 'assignment-1',
                grossMinutes: 480,
                paidBreakMinutes: 15,
                unpaidBreakMinutes: 30,
                policyDeductionMinutes: 0,
                approvedWorkedMinutes: 450,
              },
            ],
          },
          segments: [
            {
              id: 'segment-1',
              employmentAssignmentId: 'assignment-1',
              status: 'APPROVED',
              reviewedByUserId: 'approver-user',
              reviewedAt: '2026-09-16T15:00:00.000Z',
              reviewerNote: null,
              grossMinutes: 480,
              paidBreakMinutes: 15,
              unpaidBreakMinutes: 30,
              policyDeductionMinutes: 0,
              netWorkedMinutes: 450,
              approvedWorkedMinutes: 450,
              calculatedAt: null,
              assignment: { id: 'assignment-1', position: { id: 'p', name: 'Counsellor' } },
            },
          ],
          events: [
            {
              id: 'event-1',
              segmentId: null,
              actorUserId: 'approver-user',
              type: 'APPROVED',
              note: null,
              metadata: null,
              occurredAt: '2026-09-16T15:00:00.000Z',
            },
          ],
          actors: { 'approver-user': 'Maya Manager' },
        },
      ],
      nextAfterId: null,
    });
    mocks.reopenTimesheet.mockResolvedValue({});
    render(<TimeManagementPage />);

    expect(
      await screen.findByRole('heading', { name: /Ada Lovelace · 09\/01\/2026/ }),
    ).toBeInTheDocument();
    expect(mocks.managementTimesheets).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        timePeriodId: 'period-1',
        employeeId: 'employee-1',
      }),
    );
    // Approved: the stored daily snapshot, never live entries.
    expect(screen.getByRole('region', { name: 'Approved daily time' })).toHaveTextContent('7h 30m');
    expect(mocks.managementEntries).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Maya Manager/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reopen this timesheet?' });
    const confirm = within(dialog).getByRole('button', { name: 'Reopen timesheet' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason for reopening'), {
      target: { value: 'Missed sign-in' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.reopenTimesheet).toHaveBeenCalledWith('sheet-1', 'Missed sign-in', 4),
    );
    expect(await screen.findByText('Timesheet reopened.')).toBeInTheDocument();
  });
});
