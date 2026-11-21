import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaveManagementPage } from './leave-management-page';

const mocks = vi.hoisted(() => ({
  organizations: vi.fn(),
  queue: vi.fn(),
  request: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  amend: vi.fn(),
  calendar: vi.fn(),
  balances: vi.fn(),
  ledger: vi.fn(),
  adjust: vi.fn(),
  reverse: vi.fn(),
  types: vi.fn(),
  createType: vi.fn(),
  policies: vi.fn(),
  createPolicy: vi.fn(),
  endPolicy: vi.fn(),
  holidays: vi.fn(),
  createHoliday: vi.fn(),
}));

vi.mock('../../lib/leave/api', () => ({ leaveApi: mocks }));
vi.mock('../../lib/organization/api', () => ({
  organizationApi: {
    listUnits: vi.fn().mockResolvedValue([]),
    listDepartments: vi.fn().mockResolvedValue([{ id: 'dept-1', name: 'Kitchen' }]),
    listTeams: vi.fn().mockResolvedValue([]),
  },
}));

const allActions = {
  canReadRequests: true,
  canApprove: true,
  canViewBalances: true,
  canAdjust: true,
  canReadConfiguration: true,
  canManageTypes: true,
  canManagePolicies: true,
  canReadHolidays: true,
  canManageHolidays: true,
  canManageOrganizationHolidays: true,
};
const organization = {
  id: 'org-1',
  name: 'Camp',
  timezone: 'America/Toronto',
  actions: allActions,
  holidayScopes: [],
};
const vacation = {
  id: 'type-vac',
  code: 'VAC',
  name: 'Vacation',
  classification: 'PAID',
  tracksBalance: true,
  displayUnit: 'HOURS',
};
const employee = { id: 'employee-1', employeeNumber: 'E1', displayName: 'Ada Lovelace' };

const summary = {
  id: 'request-1',
  status: 'PENDING',
  employee,
  employmentAssignmentId: 'assignment-1',
  positionName: 'Counsellor',
  leaveType: vacation,
  startDate: '2027-03-08',
  endDate: '2027-03-09',
  startLocalTime: null,
  endLocalTime: null,
  timezone: 'America/Toronto',
  requestedMinutes: 960,
  approvedMinutes: null,
  activeMinutes: null,
  cancelledDayCount: 0,
  submittedAt: '2027-03-01T12:00:00.000Z',
};

const day = (date: string, id: string) => ({
  id,
  date,
  minutes: 480,
  amountSource: 'SCHEDULE',
  windowStart: `${date}T14:00:00.000Z`,
  windowEnd: `${date}T22:00:00.000Z`,
  absenceStart: `${date}T05:00:00.000Z`,
  absenceEnd: `${date}T05:00:00.000Z`,
  scheduledShiftRevisionIds: ['rev-1'],
  holidayName: null,
  overrideReason: null,
  cancelled: false,
  cancelledByAmendmentId: null,
  locked: false,
});

const detail = (status: string, actions: Record<string, boolean>) => ({
  ...summary,
  status,
  reason: 'Family trip',
  decisionNote: null,
  decidedByUserId: null,
  decidedAt: null,
  requestedByUserId: 'user-1',
  days: [day('2027-03-08', 'day-1'), day('2027-03-09', 'day-2')],
  events: [
    {
      id: 'event-1',
      type: 'SUBMITTED',
      actorUserId: 'user-1',
      note: null,
      metadata: {},
      occurredAt: '2027-03-01T12:00:00.000Z',
    },
  ],
  amendments: [],
  ledgerEntries: [],
  balance: { currentMinutes: 2400, scheduledMinutes: 0, availableMinutes: 2400 },
  coverage: {
    leaveRequestId: 'request-1',
    coveredShifts: [
      {
        employeeId: 'employee-1',
        employmentAssignmentId: 'assignment-1',
        scheduledShiftId: 'shift-1',
        scheduledShiftRevisionId: 'rev-1',
        revisionNumber: 1,
        scheduleId: 'schedule-1',
        workLocationId: null,
        workDate: '2027-03-08',
        startsAt: '2027-03-08T14:00:00.000Z',
        endsAt: '2027-03-08T22:00:00.000Z',
        timezone: 'America/Toronto',
        scheduledMinutes: 480,
        overlapMinutes: 480,
      },
    ],
    totalOverlapMinutes: 480,
  },
  actions: { canApprove: false, canReject: false, canAmend: false, canCancel: false, ...actions },
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.organizations.mockResolvedValue({ items: [organization] });
  mocks.queue.mockResolvedValue({
    items: [{ ...summary, actions: { canApprove: true, canReject: true, canAmend: false } }],
    nextAfterId: null,
  });
  mocks.request.mockResolvedValue(detail('PENDING', { canApprove: true, canReject: true }));
  mocks.approve.mockResolvedValue({ requestId: 'request-1', status: 'APPROVED' });
  mocks.reject.mockResolvedValue({ requestId: 'request-1', status: 'REJECTED' });
  mocks.amend.mockResolvedValue({ requestId: 'request-1', status: 'APPROVED' });
  mocks.calendar.mockResolvedValue({
    range: { from: '2027-03-01', to: '2027-03-14' },
    entries: [],
    holidays: [],
  });
  mocks.balances.mockResolvedValue({
    asOf: null,
    items: [
      {
        accountId: 'account-1',
        employee,
        employmentAssignmentId: 'assignment-1',
        positionName: 'Counsellor',
        leaveType: vacation,
        asOf: '2027-03-02',
        timezoneUnresolved: false,
        balance: {
          currentMinutes: 2400,
          scheduledMinutes: 480,
          availableMinutes: 1920,
          pendingMinutes: 0,
        },
        actions: { canAdjust: true },
      },
    ],
    nextAfterId: null,
  });
  mocks.ledger.mockResolvedValue({
    account: {
      id: 'account-1',
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      leaveType: vacation,
    },
    asOf: '2027-03-02',
    balance: { currentMinutes: 2400, scheduledMinutes: 480, availableMinutes: 1920 },
    entries: [
      {
        id: 'entry-1',
        accountId: 'account-1',
        entryType: 'ADJUSTMENT',
        amountMinutes: 2400,
        effectiveDate: '2027-01-01',
        sourceType: 'MANUAL',
        policyId: null,
        leaveRequestId: null,
        leaveRequestDayId: null,
        reversesEntryId: null,
        reason: 'Opening balance',
        createdByUserId: 'user-9',
        postedAt: '2027-01-01T12:00:00.000Z',
        reversedByEntryId: null,
        actions: { canReverse: true },
      },
    ],
    actions: { canAdjust: true },
  });
  mocks.adjust.mockResolvedValue({});
  mocks.reverse.mockResolvedValue({});
  mocks.types.mockResolvedValue({
    items: [
      {
        ...vacation,
        organizationId: 'org-1',
        description: null,
        archivedAt: null,
        actions: { canEdit: true, canArchive: true },
      },
    ],
  });
  mocks.createType.mockResolvedValue({});
  mocks.policies.mockResolvedValue({ items: [] });
  mocks.createPolicy.mockResolvedValue({});
  mocks.holidays.mockResolvedValue({ items: [] });
  mocks.createHoliday.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  // The page writes the picked section into the URL; start every test without it.
  window.history.replaceState(null, '', '/');
});

describe('LeaveManagementPage', () => {
  it('is forbidden without any leave-managed organization', async () => {
    mocks.organizations.mockResolvedValueOnce({ items: [] });
    render(<LeaveManagementPage />);
    await waitFor(() =>
      expect(screen.getByText('You do not have permission to manage leave.')).toBeInTheDocument(),
    );
  });

  it('shows only the tabs the backend actions allow', async () => {
    mocks.organizations.mockResolvedValueOnce({
      items: [
        {
          ...organization,
          actions: {
            ...allActions,
            canViewBalances: false,
            canReadHolidays: false,
            canReadConfiguration: false,
          },
        },
      ],
    });
    render(<LeaveManagementPage />);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Requests' })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Balances' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Holidays' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Policies' })).not.toBeInTheDocument();
  });

  it('reviews coverage and approves with an explained day override', async () => {
    render(<LeaveManagementPage />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    expect(mocks.queue).toHaveBeenCalledWith({
      organizationId: 'org-1',
      status: 'PENDING',
      limit: 50,
    });
    fireEvent.click(screen.getByRole('button', { name: /^Review request from / }));
    await waitFor(() => expect(screen.getByText(/1 published shift\(s\)/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Shorten or cancel…' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve…' }));
    fireEvent.change(screen.getByLabelText('Hours for 2027-03-09'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
    expect(await screen.findByText('Every adjusted day needs a reason.')).toBeInTheDocument();
    expect(mocks.approve).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Reason for 2027-03-09'), {
      target: { value: 'Half day agreed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() =>
      expect(mocks.approve).toHaveBeenCalledWith('request-1', {
        dayOverrides: [{ date: '2027-03-09', minutes: 240, reason: 'Half day agreed' }],
      }),
    );
    await waitFor(() => expect(screen.getByText('Leave approved.')).toBeInTheDocument());
  });

  it('keeps a day override within 0 to 24 hours before approving', async () => {
    render(<LeaveManagementPage />);
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Review request from / }));
    await waitFor(() => expect(screen.getByText(/1 published shift\(s\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Approve…' }));

    const hours = screen.getByLabelText(/Hours for 2027-03-09/) as HTMLInputElement;
    // The API accepts 0 to 1440 minutes a day; the field used to allow up to 48 hours.
    expect(hours).toHaveAttribute('max', '24');
    expect(hours).toHaveAttribute('min', '0');
    fireEvent.change(hours, { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Reason for 2027-03-09'), {
      target: { value: 'Double shift' },
    });
    expect(hours.validity.rangeOverflow).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
    expect(mocks.approve).not.toHaveBeenCalled();

    fireEvent.change(hours, { target: { value: '24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() =>
      expect(mocks.approve).toHaveBeenCalledWith('request-1', {
        dayOverrides: [{ date: '2027-03-09', minutes: 1440, reason: 'Double shift' }],
      }),
    );
  });

  it('shortens approved leave with a required reason', async () => {
    mocks.request.mockResolvedValue(detail('APPROVED', { canAmend: true }));
    render(<LeaveManagementPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Review request from / })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Review request from / }));
    fireEvent.click(await screen.findByRole('button', { name: 'Shorten or cancel…' }));
    expect(screen.queryByRole('button', { name: 'Approve…' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Cancel from'), { target: { value: '2027-03-09' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    expect(
      await screen.findByText('A reason is required to change approved leave.'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Back early' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() =>
      expect(mocks.amend).toHaveBeenCalledWith('request-1', {
        reason: 'Back early',
        cancelFrom: '2027-03-09',
      }),
    );
  });

  it('opens a ledger, reverses an entry and posts an idempotent adjustment', async () => {
    render(<LeaveManagementPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Balances' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ledger' }));
    await waitFor(() => expect(screen.getByText('Opening balance')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Reverse' }));
    fireEvent.change(screen.getByLabelText('Reason for reversal'), {
      target: { value: 'Posted to wrong account' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reverse entry' }));
    await waitFor(() =>
      expect(mocks.reverse).toHaveBeenCalledWith('entry-1', 'Posted to wrong account'),
    );

    fireEvent.change(screen.getByLabelText('Hours (+/−)'), { target: { value: '-1.5' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Correction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post adjustment' }));
    await waitFor(() => expect(mocks.adjust).toHaveBeenCalled());
    const input = mocks.adjust.mock.calls[0]![0];
    expect(input).toMatchObject({
      employmentAssignmentId: 'assignment-1',
      leaveTypeId: 'type-vac',
      amountMinutes: -90,
      reason: 'Correction',
    });
    expect(input.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('creates leave types, policies and holidays', async () => {
    render(<LeaveManagementPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Leave types' }));
    const typeForm = (await screen.findByRole('button', { name: 'Create leave type' })).closest(
      'form',
    )!;
    fireEvent.change(within(typeForm).getByLabelText('Code'), { target: { value: 'SICK' } });
    fireEvent.change(within(typeForm).getByLabelText('Name'), { target: { value: 'Sick leave' } });
    fireEvent.click(within(typeForm).getByRole('button', { name: 'Create leave type' }));
    await waitFor(() =>
      expect(mocks.createType).toHaveBeenCalledWith({
        organizationId: 'org-1',
        code: 'SICK',
        name: 'Sick leave',
        classification: 'PAID',
        tracksBalance: true,
        displayUnit: 'HOURS',
      }),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Policies' }));
    // Batch 10F: picking a section writes it into the URL (replace), so a bookmark keeps it.
    expect(window.location.hash).toBe('#policies');
    fireEvent.click(await screen.findByRole('button', { name: 'New policy' }));
    fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText('Accrual'), { target: { value: 'PERIODIC' } });
    fireEvent.change(screen.getByLabelText('Hours per period'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Year-end carryover'), { target: { value: 'CAPPED' } });
    fireEvent.change(screen.getByLabelText('Carryover cap (hours)'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create policy' }));
    await waitFor(() => expect(mocks.createPolicy).toHaveBeenCalled());
    expect(mocks.createPolicy.mock.calls[0]![0]).toMatchObject({
      leaveTypeId: 'type-vac',
      organizationId: 'org-1',
      scopeType: 'ORGANIZATION',
      effectiveFrom: '2027-01-01',
      accrualMethod: 'PERIODIC',
      accrualFrequency: 'MONTHLY',
      accrualMinutesPerPeriod: 480,
      carryoverMode: 'CAPPED',
      carryoverMaxMinutes: 2400,
      standardWorkdays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
      employmentTypes: [],
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Holidays' }));
    const holidayForm = (await screen.findByRole('button', { name: 'Add holiday' })).closest(
      'form',
    )!;
    fireEvent.change(within(holidayForm).getByLabelText('Date'), {
      target: { value: '2027-07-01' },
    });
    fireEvent.change(within(holidayForm).getByLabelText('Name'), {
      target: { value: 'Canada Day' },
    });
    fireEvent.change(within(holidayForm).getByLabelText('Applies to'), {
      target: { value: 'DEPARTMENT' },
    });
    fireEvent.change(await within(holidayForm).findByLabelText('Department'), {
      target: { value: 'dept-1' },
    });
    fireEvent.click(within(holidayForm).getByRole('button', { name: 'Add holiday' }));
    await waitFor(() =>
      expect(mocks.createHoliday).toHaveBeenCalledWith({
        organizationId: 'org-1',
        date: '2027-07-01',
        name: 'Canada Day',
        kind: 'STATUTORY_HOLIDAY',
        departmentId: 'dept-1',
      }),
    );
  });
  it('offers a scoped holiday manager only the scopes the backend says it may use', async () => {
    mocks.organizations.mockResolvedValueOnce({
      items: [
        {
          ...organization,
          actions: { ...allActions, canManageOrganizationHolidays: false },
          holidayScopes: [{ type: 'DEPARTMENT', id: 'dept-2', name: 'Kitchen' }],
        },
      ],
    });
    render(<LeaveManagementPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Holidays' }));
    const form = (await screen.findByRole('button', { name: 'Add holiday' })).closest('form')!;
    const appliesTo = within(form).getByLabelText('Applies to');
    expect(
      within(appliesTo)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Department: Kitchen']);
    fireEvent.change(within(form).getByLabelText('Date'), { target: { value: '2027-07-02' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Deep clean' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add holiday' }));
    await waitFor(() =>
      expect(mocks.createHoliday).toHaveBeenCalledWith({
        organizationId: 'org-1',
        date: '2027-07-02',
        name: 'Deep clean',
        kind: 'STATUTORY_HOLIDAY',
        departmentId: 'dept-2',
      }),
    );
  });

  it('never offers locked days for cancellation', async () => {
    const approved = detail('APPROVED', { canAmend: true });
    approved.days = [{ ...approved.days[0]!, locked: true }, approved.days[1]!];
    mocks.request.mockResolvedValue(approved);
    render(<LeaveManagementPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Review request from / }));
    fireEvent.click(await screen.findByRole('button', { name: 'Shorten or cancel…' }));
    expect(screen.getByLabelText('Cancel from')).toHaveAttribute('min', '2027-03-09');
    fireEvent.click(screen.getByLabelText('Cancel specific days'));
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((box) => (box as HTMLInputElement).disabled)).toEqual([true, false]);
    expect(screen.getByText('(locked period)')).toBeInTheDocument();
  });
});
