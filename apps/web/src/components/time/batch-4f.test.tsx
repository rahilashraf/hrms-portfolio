import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type { TimeEntryRead } from '../../lib/time/types';
import { LinkShiftDialog } from './review/link-shift-dialog';
import { rangeProblem, ScheduledVsActual, weekOf } from './review/scheduled-vs-actual';
import { TimeManagementPage } from './time-management-page';
import { truncatedRecordsText } from './time-notices';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  managementCurrent: vi.fn(),
  managementEntries: vi.fn(),
  managementExceptions: vi.fn(),
  managementCorrections: vi.fn(),
  managementTimesheets: vi.fn(),
  periods: vi.fn(),
  organizations: vi.fn(),
  scheduledVsActual: vi.fn(),
  linkScheduledShift: vi.fn(),
  grid: vi.fn(),
}));

vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../lib/time/api', () => ({ timeApi: mocks }));
vi.mock('../../lib/attendance/api', () => ({ attendanceApi: mocks }));
vi.mock('../../lib/scheduling/api', () => ({ schedulingApi: { grid: mocks.grid } }));

const REVIEW = {
  canViewSignIns: false,
  canCorrectSignIns: false,
  canManageDevices: false,
  canManagePolicies: false,
  canManagePins: false,
  canViewAttendance: true,
  canCorrectTime: true,
  canReviewExceptions: true,
  canReviewCorrections: true,
  canApproveTimesheets: false,
  canManageTimesheets: false,
  canManagePeriods: false,
};

function organization(id: string, name: string, attendanceEnabled = true) {
  const actions: typeof REVIEW = attendanceEnabled
    ? REVIEW
    : {
        ...(Object.fromEntries(Object.keys(REVIEW).map((key) => [key, false])) as typeof REVIEW),
        canViewAttendance: true,
      };
  return {
    id,
    name,
    code: id.toUpperCase(),
    timezone: 'America/Toronto',
    workLocations: [],
    physicalSites: [],
    attendanceEnabled,
    actions,
  };
}

const empty = { items: [], nextAfterId: null };

function entry(overrides: Partial<TimeEntryRead> = {}): TimeEntryRead {
  return {
    id: 'entry-1',
    employeeId: 'employee-1',
    employeeNumber: 'E-1',
    employeeName: 'Ada Lovelace',
    employmentAssignmentId: 'assignment-1',
    assignment: {
      id: 'assignment-1',
      position: { id: 'position-1', name: 'Coordinator' },
      organization: { id: 'org-1', name: 'Northwind', code: 'NW' },
    } as TimeEntryRead['assignment'],
    workDate: '2026-10-05',
    clockInAt: '2026-10-05T13:00:00.000Z',
    clockOutAt: '2026-10-05T19:00:00.000Z',
    timezone: 'America/Toronto',
    status: 'CLOSED',
    source: 'LIVE_CLOCK',
    grossMinutes: 360,
    paidBreakMinutes: 0,
    unpaidBreakMinutes: 0,
    breakMinutes: 0,
    netWorkedMinutes: 360,
    scheduledShiftId: null,
    exceptions: [],
    corrections: [],
    ...overrides,
  };
}

function gridShift(id: string, startsAt: string, endsAt: string) {
  return {
    id,
    scheduleId: 'schedule-1',
    employmentAssignmentId: 'assignment-1',
    assignment: { position: { name: 'Coordinator' } },
    workDate: '2026-10-05',
    startsAt,
    endsAt,
    timezone: 'America/Toronto',
    status: 'ACTIVE',
  };
}

function row(workDate: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    workDate,
    employeeId: `employee-${name}`,
    employmentAssignmentId: `assignment-${name}`,
    employeeNumber: `E-${name}`,
    employeeName: name,
    positionName: 'Coordinator',
    scheduledShiftCount: 1,
    scheduledMinutes: 480,
    scheduledShiftIds: ['shift-1'],
    closedEntryCount: 1,
    openEntryCount: 0,
    grossMinutes: 450,
    actualMinutes: 450,
    linkedActualMinutes: 450,
    unscheduledActualMinutes: 0,
    varianceMinutes: -30,
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/admin/time');
  window.localStorage.clear();
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    identity: { id: 'manager-user' },
    authorization: {
      permissions: [{ key: 'time.view', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] }],
    },
  });
  for (const list of [
    mocks.managementCurrent,
    mocks.managementEntries,
    mocks.managementExceptions,
    mocks.managementCorrections,
    mocks.managementTimesheets,
    mocks.periods,
  ]) {
    list.mockResolvedValue(empty);
  }
});

afterEach(cleanup);

describe('truncation (Batch 4F, Q3)', () => {
  it('never implies a capped list is complete', () => {
    expect(truncatedRecordsText(1000)).toBe(
      'Showing the first 1,000 records. Narrow the date range to see the rest.',
    );
  });
});

describe('historical organizations (Batch 4F, C10)', () => {
  it('opts in, labels the organization read only and sends the flag with every list', async () => {
    mocks.organizations.mockImplementation(
      async (options: { includeDisabledOrganizations?: boolean } = {}) => ({
        items: options.includeDisabledOrganizations
          ? [organization('org-1', 'Northwind'), organization('org-2', 'Harbor', false)]
          : [organization('org-1', 'Northwind')],
      }),
    );
    render(<TimeManagementPage />);
    const toggle = await screen.findByRole('checkbox', {
      name: 'Include organizations with attendance turned off (read only)',
    });
    expect(mocks.organizations).toHaveBeenLastCalledWith({});
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mocks.organizations).toHaveBeenLastCalledWith({ includeDisabledOrganizations: true }),
    );
    const picker = await screen.findByRole('combobox', { name: 'Organization' });
    expect(
      within(picker).getByRole('option', { name: 'Harbor (turned off — read only)' }),
    ).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'org-2' } });
    expect(
      await screen.findByText(/Time & attendance is turned off for Harbor/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Records' }));
    await waitFor(() =>
      expect(mocks.managementEntries).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationId: 'org-2', includeDisabledOrganizations: true }),
      ),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Exceptions' }));
    await waitFor(() =>
      expect(mocks.managementExceptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationId: 'org-2', includeDisabledOrganizations: true }),
      ),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Timesheets' }));
    await waitFor(() =>
      expect(mocks.periods).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationId: 'org-2', includeDisabledOrganizations: true }),
      ),
    );
    // The live overview is not offered for history.
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(await screen.findByText('No live overview')).toBeInTheDocument();
    expect(mocks.managementCurrent).not.toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-2' }),
    );
  });
});

describe('ScheduledVsActual (Batch 4F, Q8)', () => {
  it('validates the range before asking the API', () => {
    expect(weekOf('2026-10-08')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(rangeProblem('2026-10-05', '2026-11-04')).toBeNull();
    expect(rangeProblem('2026-10-05', '2026-11-05')).toBe(
      'Choose at most 31 days (this range has 32).',
    );
    expect(rangeProblem('2026-10-06', '2026-10-05')).toBe(
      'The end date must be on or after the start date.',
    );
  });

  it('lists rows, formats minutes and follows nextAfterKey', async () => {
    mocks.scheduledVsActual
      .mockResolvedValueOnce({
        range: { from: '2026-10-05', to: '2026-10-11' },
        rows: [row('2026-10-05', 'Ada', { openEntryCount: 1 })],
        nextAfterKey: '2026-10-05|assignment-Ada',
      })
      .mockResolvedValueOnce({
        range: { from: '2026-10-05', to: '2026-10-11' },
        rows: [row('2026-10-06', 'Grace', { actualMinutes: 510, varianceMinutes: 30 })],
        nextAfterKey: null,
      });
    render(<ScheduledVsActual organization={organization('org-1', 'Northwind')} />);
    const region = await screen.findByRole('region', { name: 'Scheduled vs actual' });
    expect(within(region).getByText('8h')).toBeInTheDocument();
    expect(within(region).getByText('-30m')).toBeInTheDocument();
    expect(within(region).getByText('not included')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await within(region).findByText('Grace')).toBeInTheDocument();
    expect(within(region).getByText('+30m')).toBeInTheDocument();
    expect(mocks.scheduledVsActual).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: 'org-1', afterKey: '2026-10-05|assignment-Ada' }),
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    mocks.scheduledVsActual
      .mockRejectedValueOnce(new AuthApiError('service-unavailable', 503))
      .mockResolvedValueOnce({ range: { from: '', to: '' }, rows: [], nextAfterKey: null });
    render(<ScheduledVsActual organization={organization('org-1', 'Northwind')} />);
    fireEvent.click(await screen.findByRole('button', { name: /retry|try again/i }));
    expect(
      await screen.findByText('Nothing scheduled or recorded in these dates'),
    ).toBeInTheDocument();
  });
});

describe('LinkShiftDialog (Batch 4F, Q8)', () => {
  it('requires a choice and a reason, then sends the chosen shift', async () => {
    mocks.grid.mockResolvedValue({
      items: [gridShift('shift-1', '2026-10-05T13:00:00.000Z', '2026-10-05T21:00:00.000Z')],
      nextAfterId: null,
    });
    mocks.linkScheduledShift.mockResolvedValue({
      timeEntryId: 'entry-1',
      scheduledShiftId: 'shift-1',
      changed: true,
    });
    const onDone = vi.fn();
    render(
      <LinkShiftDialog entry={entry()} organizationId="org-1" onClose={vi.fn()} onDone={onDone} />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Link shift' });
    expect(mocks.grid).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        employmentAssignmentId: 'assignment-1',
        from: '2026-10-04',
        to: '2026-10-06',
        status: 'ACTIVE',
        scheduleStatus: 'PUBLISHED',
      }),
    );
    const save = within(dialog).getByRole('button', { name: 'Save shift link' });
    expect(save).toBeDisabled();
    fireEvent.click(await within(dialog).findByRole('radio', { name: /Coordinator/ }));
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Covered the morning shift' },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(mocks.linkScheduledShift).toHaveBeenCalledWith('entry-1', {
        scheduledShiftId: 'shift-1',
        reason: 'Covered the morning shift',
      }),
    );
    expect(onDone).toHaveBeenCalledWith('Shift link updated.');
  });

  it('unlinks with null and shows API errors', async () => {
    mocks.grid.mockRejectedValue(new AuthApiError('forbidden', 403));
    mocks.linkScheduledShift.mockRejectedValue(
      new AuthApiError('conflict', 409, 'finalized', { code: 'TIME_ENTRY_FINALIZED' }),
    );
    render(
      <LinkShiftDialog
        entry={entry({ scheduledShiftId: 'shift-9' })}
        organizationId="org-1"
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Change shift link' });
    expect(await within(dialog).findByText(/schedule access is needed/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Unlink: no scheduled shift' }));
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Wrong shift' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink shift' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That time is in an approved or locked timesheet.',
    );
    expect(mocks.linkScheduledShift).toHaveBeenCalledWith('entry-1', {
      scheduledShiftId: null,
      reason: 'Wrong shift',
    });
  });
});
