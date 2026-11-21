import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { LeaveManagementPage } from './leave-management-page';
import { TeamCalendarAndHolidays } from './leave-team-calendar';

const mocks = vi.hoisted(() => ({
  organizations: vi.fn(),
  queue: vi.fn(),
  request: vi.fn(),
  types: vi.fn(),
  updateType: vi.fn(),
  policies: vi.fn(),
  balances: vi.fn(),
  previewForEmployee: vi.fn(),
  recordForEmployee: vi.fn(),
  resolvePolicy: vi.fn(),
  myTeamCalendar: vi.fn(),
  myHolidays: vi.fn(),
}));

vi.mock('../../lib/leave/api', () => ({ leaveApi: mocks }));
vi.mock('../../lib/organization/api', () => ({
  organizationApi: {
    listUnits: vi.fn().mockResolvedValue([]),
    listDepartments: vi.fn().mockResolvedValue([]),
    listTeams: vi.fn().mockResolvedValue([]),
  },
}));
// The employee/assignment picker is covered by its own tests; here it is a plain field.
vi.mock('../ui/assignment-id-picker', () => ({
  AssignmentIdPicker: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange(value: string): void;
  }) => (
    <label>
      {label}
      <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  ),
}));

const actions = {
  canReadRequests: true,
  canApprove: true,
  canViewBalances: true,
  canAdjust: false,
  canReadConfiguration: true,
  canManageTypes: true,
  canManagePolicies: false,
  canReadHolidays: false,
  canManageHolidays: false,
  canManageOrganizationHolidays: false,
};
const organization = {
  id: 'org-1',
  name: 'Camp',
  timezone: 'America/Toronto',
  actions,
  holidayScopes: [],
};
const vacation = {
  id: 'type-vac',
  organizationId: 'org-1',
  code: 'VAC',
  name: 'Vacation',
  description: 'Paid time away',
  classification: 'PAID',
  tracksBalance: true,
  displayUnit: 'HOURS',
  archivedAt: null,
  actions: { canEdit: true, canArchive: false },
};
const queued = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: 'PENDING',
  employee: { id: 'employee-1', employeeNumber: 'E1', displayName: `Person ${id}` },
  employmentAssignmentId: 'assignment-1',
  positionName: 'Counsellor',
  leaveType: vacation,
  startDate: '2027-03-08',
  endDate: '2027-03-08',
  startLocalTime: null,
  endLocalTime: null,
  timezone: 'America/Toronto',
  requestedMinutes: 480,
  approvedMinutes: null,
  activeMinutes: null,
  cancelledDayCount: 0,
  submittedAt: '2027-03-01T12:00:00.000Z',
  actions: { canApprove: true, canReject: true, canAmend: false },
  ...overrides,
});
const previewDay = (date: string, holidayName: string | null = null) => ({
  date,
  minutes: holidayName ? 0 : 480,
  amountSource: holidayName ? 'HOLIDAY' : 'STANDARD',
  windowStart: `${date}T13:00:00.000Z`,
  windowEnd: `${date}T21:00:00.000Z`,
  absenceStart: `${date}T05:00:00.000Z`,
  absenceEnd: `${date}T05:00:00.000Z`,
  scheduledShiftRevisionIds: [],
  holidayName,
  overrideReason: null,
  cancelled: false,
});

function setLocation(search: string, hash = '') {
  window.history.replaceState(null, '', `/admin/leave${search}${hash}`);
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  setLocation('');
  mocks.organizations.mockResolvedValue({ items: [organization] });
  mocks.queue.mockResolvedValue({ items: [queued('r1')], nextAfterId: null });
  mocks.types.mockResolvedValue({ items: [vacation] });
  mocks.policies.mockResolvedValue({ items: [] });
  mocks.balances.mockResolvedValue({ items: [], nextAfterId: null, asOf: null });
});
afterEach(() => {
  cleanup();
  setLocation('');
});

describe('Batch 6B — leave operations', () => {
  it('records leave for an employee after a preview that marks holidays', async () => {
    mocks.previewForEmployee.mockResolvedValue({
      employmentAssignmentId: 'assignment-9',
      leaveType: vacation,
      timezone: 'America/Toronto',
      startDate: '2027-03-08',
      endDate: '2027-03-09',
      partial: null,
      totalMinutes: 480,
      days: [previewDay('2027-03-08'), previewDay('2027-03-09', 'Founders day')],
      balance: {
        currentMinutes: 2400,
        scheduledMinutes: 0,
        availableMinutes: 2400,
        pendingMinutes: 0,
        leaveYear: { start: '2027-01-01', end: '2027-12-31' },
        availableForLeaveYearMinutes: 2400,
        availableAfterMinutes: 1920,
        negativeBalanceLimitMinutes: 0,
        sufficient: true,
      },
    });
    mocks.recordForEmployee.mockResolvedValue({ requestId: 'r9', status: 'APPROVED' });
    render(<LeaveManagementPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record leave for an employee' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record leave for an employee' });
    const submit = within(dialog).getByRole('button', { name: 'Preview' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Employee'), {
      target: { value: 'assignment-9' },
    });
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Leave type')).toHaveValue('type-vac'),
    );
    fireEvent.change(within(dialog).getByLabelText('First day'), {
      target: { value: '2027-03-08' },
    });
    fireEvent.change(within(dialog).getByLabelText('Last day'), {
      target: { value: '2027-03-09' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.previewForEmployee).toHaveBeenCalledWith({
        employmentAssignmentId: 'assignment-9',
        leaveTypeId: 'type-vac',
        startDate: '2027-03-08',
        endDate: '2027-03-09',
      }),
    );
    const preview = await within(dialog).findByRole('region', { name: 'Leave preview' });
    expect(preview).toHaveTextContent('Founders day');
    expect(preview).toHaveTextContent(/Balance after this leave/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record and approve' }));
    await waitFor(() =>
      expect(mocks.recordForEmployee).toHaveBeenCalledWith({
        employmentAssignmentId: 'assignment-9',
        leaveTypeId: 'type-vac',
        startDate: '2027-03-08',
        endDate: '2027-03-09',
        approve: true,
      }),
    );
    expect(await screen.findByText('Leave recorded and approved.')).toBeInTheDocument();
    // Changing any field discards the preview: what is recorded is what was previewed.
  });

  it('explains a refused self-recording (D5) inside the dialog', async () => {
    mocks.previewForEmployee.mockResolvedValue({
      employmentAssignmentId: 'mine',
      leaveType: vacation,
      timezone: 'America/Toronto',
      startDate: '2027-03-08',
      endDate: '2027-03-08',
      partial: null,
      totalMinutes: 480,
      days: [previewDay('2027-03-08')],
      balance: null,
    });
    mocks.recordForEmployee.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, { code: 'LEAVE_SELF_APPROVAL' }),
    );
    render(<LeaveManagementPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record leave for an employee' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Employee'), { target: { value: 'mine' } });
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Leave type')).toHaveValue('type-vac'),
    );
    fireEvent.change(within(dialog).getByLabelText('First day'), {
      target: { value: '2027-03-08' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Record and approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You cannot record, approve or decide your own leave.',
    );
    // Editing the dates discards the preview.
    fireEvent.change(within(dialog).getByLabelText('First day'), {
      target: { value: '2027-03-09' },
    });
    expect(within(dialog).queryByRole('region', { name: 'Leave preview' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Preview' })).toBeEnabled();
  });

  it('filters the queue by employee (preselected from the URL) and type, and pages with Load more', async () => {
    setLocation('?employeeId=employee-7', '#requests');
    mocks.queue
      .mockResolvedValueOnce({ items: [queued('r1')], nextAfterId: 'r1' })
      .mockResolvedValueOnce({ items: [queued('r2')], nextAfterId: null });
    render(<LeaveManagementPage />);
    expect(await screen.findByText('Person r1')).toBeInTheDocument();
    expect(mocks.queue).toHaveBeenLastCalledWith({
      organizationId: 'org-1',
      status: 'PENDING',
      employeeId: 'employee-7',
      limit: 50,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load more requests' }));
    expect(await screen.findByText('Person r2')).toBeInTheDocument();
    expect(screen.getByText('Person r1')).toBeInTheDocument();
    expect(mocks.queue).toHaveBeenLastCalledWith(
      expect.objectContaining({ employeeId: 'employee-7', afterId: 'r1' }),
    );
    expect(screen.queryByRole('button', { name: 'Load more requests' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Leave type'), { target: { value: 'type-vac' } });
    await waitFor(() =>
      expect(mocks.queue).toHaveBeenLastCalledWith(
        expect.objectContaining({ employeeId: 'employee-7', leaveTypeId: 'type-vac' }),
      ),
    );
  });

  it('preselects the employee on balances from the URL and pages', async () => {
    setLocation('?employeeId=employee-7', '#balances');
    render(<LeaveManagementPage />);
    expect(await screen.findByRole('tab', { name: 'Balances', selected: true })).toBeVisible();
    await waitFor(() =>
      expect(mocks.balances).toHaveBeenLastCalledWith({
        organizationId: 'org-1',
        employeeId: 'employee-7',
        limit: 100,
      }),
    );
  });

  it('explains why a pending request of an archived type cannot be approved (L1)', async () => {
    const archived = { ...vacation, archived: true };
    mocks.queue.mockResolvedValue({
      items: [
        queued('r1', {
          leaveType: archived,
          actions: { canApprove: false, canReject: true, canAmend: false },
        }),
      ],
      nextAfterId: null,
    });
    mocks.request.mockResolvedValue({
      ...queued('r1', { leaveType: archived }),
      reason: null,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      requestedByUserId: 'u',
      days: [],
      events: [],
      amendments: [],
      ledgerEntries: [],
      balance: null,
      coverage: { leaveRequestId: 'r1', coveredShifts: [], totalOverlapMinutes: 0 },
      actions: { canApprove: false, canReject: true, canAmend: false, canCancel: false },
    });
    render(<LeaveManagementPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Review request from / }));
    expect(await screen.findByText(/This leave type has been archived/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve…' })).toBeNull();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeInTheDocument();
  });

  it('uses accessible tabs and edits every editable leave type field', async () => {
    mocks.updateType.mockResolvedValue(vacation);
    render(<LeaveManagementPage />);
    const tablist = await screen.findByRole('tablist', { name: 'Leave sections' });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Requests', 'Calendar', 'Balances', 'Leave types', 'Policies']);
    fireEvent.click(screen.getByRole('tab', { name: 'Leave types' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Vacation' }));
    const form = screen.getByRole('form', { name: 'Edit leave type VAC' });
    expect(form).toHaveTextContent(/stay fixed/);
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Annual leave' } });
    fireEvent.change(within(form).getByLabelText('Display unit'), { target: { value: 'DAYS' } });
    fireEvent.change(within(form).getByLabelText('Description'), {
      target: { value: 'Yearly vacation' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.updateType).toHaveBeenCalledWith('type-vac', {
        name: 'Annual leave',
        description: 'Yearly vacation',
        displayUnit: 'DAYS',
      }),
    );
  });

  it('answers "which policy applies?" and names an assignment-scoped policy (L7)', async () => {
    const policy = {
      id: 'policy-1',
      leaveTypeId: 'type-vac',
      organizationId: 'org-1',
      scopeType: 'EMPLOYMENT_ASSIGNMENT',
      organizationalUnitId: null,
      departmentId: null,
      teamId: null,
      employmentAssignmentId: 'assignment-9',
      name: 'Grace special',
      effectiveFrom: '2027-01-01',
      effectiveTo: null,
      eligible: true,
      employmentTypes: [],
      waitingPeriodDays: 0,
      leaveYearStartMonth: 1,
      leaveYearStartDay: 1,
      amountSource: 'SCHEDULE_THEN_STANDARD',
      standardWorkdayMinutes: 480,
      standardWorkdays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
      excludeHolidays: true,
      allowPartialDay: false,
      accrualMethod: 'NONE',
      annualGrantMinutes: null,
      accrualFrequency: null,
      accrualMinutesPerPeriod: null,
      accrualAnchorDate: null,
      prorateFirstYear: false,
      maxBalanceMinutes: null,
      negativeBalanceLimitMinutes: 0,
      carryoverMode: 'NONE',
      carryoverMaxMinutes: null,
      carryoverExpiryDays: null,
      employeeMayCancelApprovedFuture: true,
      actions: { canEdit: false, canDelete: false, canEnd: false },
      leaveType: vacation,
      assignment: { employeeName: 'Grace Hopper', employeeNumber: 'E9', positionName: 'Director' },
    };
    mocks.policies.mockResolvedValue({ items: [policy] });
    mocks.resolvePolicy.mockResolvedValue({ date: '2027-03-08', policy, eligible: true });
    render(<LeaveManagementPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Policies' }));
    expect(await screen.findByText('Employee: Grace Hopper (E9) · Director')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Assignment assignment-9');
    const form = screen.getByRole('form', { name: 'Which policy applies' });
    fireEvent.change(within(form).getByLabelText('Employee'), {
      target: { value: 'assignment-9' },
    });
    await waitFor(() => expect(within(form).getByLabelText('Leave type')).toHaveValue('type-vac'));
    fireEvent.change(within(form).getByLabelText('Date'), { target: { value: '2027-03-08' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Check' }));
    await waitFor(() =>
      expect(mocks.resolvePolicy).toHaveBeenCalledWith({
        employmentAssignmentId: 'assignment-9',
        leaveTypeId: 'type-vac',
        date: '2027-03-08',
      }),
    );
    const result = await screen.findByRole('status');
    expect(result).toHaveTextContent('Grace special');
    expect(result).toHaveTextContent('Eligible');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Batch 6B — races (independent review findings)', () => {
  it('discards a preview answered after an edit, so nothing un-previewed is recorded', async () => {
    const late = deferred<unknown>();
    mocks.previewForEmployee.mockReturnValueOnce(late.promise);
    render(<LeaveManagementPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record leave for an employee' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Employee'), { target: { value: 'asg' } });
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Leave type')).toHaveValue('type-vac'),
    );
    fireEvent.change(within(dialog).getByLabelText('First day'), {
      target: { value: '2027-03-08' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview' }));
    // Edited while the preview is being calculated.
    fireEvent.change(within(dialog).getByLabelText('Last day'), {
      target: { value: '2027-03-12' },
    });
    late.resolve({
      employmentAssignmentId: 'asg',
      leaveType: vacation,
      timezone: 'America/Toronto',
      startDate: '2027-03-08',
      endDate: '2027-03-08',
      partial: null,
      totalMinutes: 480,
      days: [previewDay('2027-03-08')],
      balance: null,
    });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Preview' })).toBeEnabled(),
    );
    expect(within(dialog).queryByRole('region', { name: 'Leave preview' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Record/ })).toBeNull();
    expect(mocks.recordForEmployee).not.toHaveBeenCalled();
  });

  it('never appends a page loaded for an earlier filter', async () => {
    const stale = deferred<unknown>();
    mocks.queue
      .mockResolvedValueOnce({ items: [queued('r1')], nextAfterId: 'r1' })
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue({ items: [queued('t1')], nextAfterId: null });
    render(<LeaveManagementPage />);
    expect(await screen.findByText('Person r1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more requests' }));
    // The filter changes while the next page is loading.
    fireEvent.change(screen.getByLabelText('Leave type'), { target: { value: 'type-vac' } });
    expect(await screen.findByText('Person t1')).toBeInTheDocument();
    stale.resolve({ items: [queued('r2')], nextAfterId: 'r2' });
    await new Promise((done) => setTimeout(done, 20));
    expect(screen.queryByText('Person r2')).toBeNull();
    expect(screen.queryByText('Person r1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more requests' })).toBeNull();
  });
});

describe('Batch 6B — team calendar and holidays (employee)', () => {
  it('lists teammates as "Absent" only, with holidays, day by day', async () => {
    mocks.myTeamCalendar.mockResolvedValue({
      range: { from: '2027-03-01', to: '2027-03-28' },
      teams: ['Kitchen team'],
      hasTeam: true,
      people: [
        { displayName: 'You', self: true, absences: [{ date: '2027-03-09', label: 'Absent' }] },
        {
          displayName: 'Ada Lovelace',
          self: false,
          absences: [
            { date: '2027-03-03', label: 'Absent' },
            { date: '2027-03-09', label: 'Absent' },
          ],
        },
      ],
    });
    mocks.myHolidays.mockResolvedValue({
      items: [
        {
          date: '2027-03-03',
          name: 'Founders day',
          kind: 'STATUTORY_HOLIDAY',
          organizationName: 'Camp',
        },
      ],
    });
    render(<TeamCalendarAndHolidays today="2027-03-01" />);
    const list = await screen.findByRole('list', { name: 'Absences and holidays by day' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('03/03/2027');
    expect(items[0]).toHaveTextContent('Founders day');
    expect(items[0]).toHaveTextContent('Ada Lovelace — Absent');
    expect(items[1]).toHaveTextContent('You — Absent');
    expect(screen.getByText(/Kitchen team/)).toBeInTheDocument();
    expect(mocks.myTeamCalendar).toHaveBeenCalledWith('2027-03-01', '2027-03-28');
    fireEvent.click(screen.getByRole('button', { name: 'Next 4 weeks' }));
    await waitFor(() =>
      expect(mocks.myTeamCalendar).toHaveBeenLastCalledWith('2027-03-29', '2027-04-25'),
    );
  });

  it('says when there is no team, and when the calendar is not available', async () => {
    mocks.myTeamCalendar.mockResolvedValue({
      range: { from: '2027-03-01', to: '2027-03-28' },
      teams: [],
      hasTeam: false,
      people: [],
    });
    mocks.myHolidays.mockResolvedValue({ items: [] });
    render(<TeamCalendarAndHolidays today="2027-03-01" />);
    expect(await screen.findByText(/You are not in a team/)).toBeInTheDocument();
    expect(screen.getByText(/Nobody in your team is away/)).toBeInTheDocument();
    cleanup();

    mocks.myTeamCalendar.mockRejectedValue(new AuthApiError('forbidden', 403));
    mocks.myHolidays.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<TeamCalendarAndHolidays today="2027-03-01" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /leave requests are not enabled for you/,
    );
  });
});
