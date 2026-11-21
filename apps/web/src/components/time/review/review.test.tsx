import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../../lib/auth/types';
import type { TimeEntryRead, Timesheet } from '../../../lib/time/types';
import { AddEntryDialog, CorrectEntryDialog } from './entry-dialogs';
import { expectNoAxeViolations } from '../../../test/axe';
import { ExceptionReview } from './exception-review';
import type { ReviewOrganization } from './review-shared';
import { TimesheetDetail, TimesheetReview } from './timesheet-review';

const mocks = vi.hoisted(() => ({
  managementTimesheets: vi.fn(),
  managementEntries: vi.fn(),
  managementExceptions: vi.fn(),
  approveSegmentAsSeen: vi.fn(),
  requestTimesheetChanges: vi.fn(),
  lockTimesheet: vi.fn(),
  submitTimesheetOnBehalf: vi.fn(),
  reopenTimesheet: vi.fn(),
  periods: vi.fn(),
  generatePeriods: vi.fn(),
  materializeTimesheets: vi.fn(),
  resolveException: vi.fn(),
  dismissException: vi.fn(),
  correctEntry: vi.fn(),
  addEntry: vi.fn(),
}));

vi.mock('../../../lib/time/api', () => ({ timeApi: mocks }));

const empty = { items: [], nextAfterId: null };

function organization(actions: Partial<ReviewOrganization['actions']> = {}): ReviewOrganization {
  return {
    id: 'org-1',
    name: 'Camp',
    code: 'CAMP',
    timezone: 'America/Toronto',
    workLocations: [],
    physicalSites: [],
    actions: {
      canViewSignIns: false,
      canCorrectSignIns: false,
      canManageDevices: false,
      canManagePolicies: false,
      canManagePins: false,
      canViewAttendance: true,
      canCorrectTime: false,
      canReviewExceptions: true,
      canReviewCorrections: true,
      canApproveTimesheets: true,
      canManageTimesheets: false,
      canManagePeriods: false,
      ...actions,
    },
  };
}

function sheet(overrides: Partial<Timesheet> = {}): Timesheet {
  return {
    id: 'sheet-1',
    employeeId: 'employee-1',
    timePeriodId: 'period-1',
    status: 'SUBMITTED',
    submittedByUserId: 'employee-user',
    submittedAt: '2026-10-12T14:00:00.000Z',
    approvedByUserId: null,
    approvedAt: null,
    lockedByUserId: null,
    lockedAt: null,
    reopenedByUserId: null,
    reopenedAt: null,
    reviewerNote: null,
    version: 3,
    totals: null,
    period: {
      id: 'period-1',
      organizationId: 'org-1',
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      status: 'CLOSED',
      cadence: 'WEEKLY',
      openedAt: null,
      closedAt: null,
      lockedAt: null,
    },
    employee: { id: 'employee-1', employeeNumber: 'E-1', name: 'Ada Lovelace' },
    actors: { 'employee-user': 'Ada Lovelace' },
    segments: [
      {
        id: 'segment-1',
        employmentAssignmentId: 'assignment-1',
        status: 'PENDING',
        reviewedByUserId: null,
        reviewedAt: null,
        reviewerNote: null,
        grossMinutes: 540,
        paidBreakMinutes: 15,
        unpaidBreakMinutes: 0,
        policyDeductionMinutes: 30,
        netWorkedMinutes: 510,
        approvedWorkedMinutes: 0,
        calculatedAt: null,
        assignment: {
          id: 'assignment-1',
          position: { id: 'position-1', name: 'Counsellor' },
        } as never,
      },
    ],
    events: [],
    ...overrides,
  };
}

function entry(overrides: Partial<TimeEntryRead> = {}): TimeEntryRead {
  return {
    id: 'entry-1',
    employeeId: 'employee-1',
    employeeNumber: 'E-1',
    employeeName: 'Ada Lovelace',
    employmentAssignmentId: 'assignment-1',
    assignment: { id: 'assignment-1', position: { id: 'position-1', name: 'Counsellor' } } as never,
    workDate: '2026-10-06',
    clockInAt: '2026-10-06T13:00:00.000Z',
    clockOutAt: '2026-10-06T22:00:00.000Z',
    timezone: 'America/Toronto',
    status: 'CLOSED',
    source: 'LIVE_CLOCK',
    grossMinutes: 540,
    paidBreakMinutes: 15,
    unpaidBreakMinutes: 0,
    breakMinutes: 15,
    netWorkedMinutes: 540,
    policyDeductionMinutes: 30,
    payableMinutes: 510,
    exceptions: [],
    corrections: [],
    ...overrides,
  };
}

const conflict = (code: string, extra: Record<string, unknown> = {}) =>
  new AuthApiError('conflict', 409, 'Conflict', { code, ...extra });

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.managementTimesheets.mockResolvedValue({ items: [sheet()], nextAfterId: null });
  mocks.managementEntries.mockResolvedValue(empty);
  mocks.managementExceptions.mockResolvedValue(empty);
  mocks.periods.mockResolvedValue(empty);
});

afterEach(cleanup);

describe('Timesheet approval queue', () => {
  it('approves exactly what the reviewer saw: the minutes and the timesheet version', async () => {
    mocks.approveSegmentAsSeen.mockResolvedValue({});
    render(
      <TimesheetReview
        organization={organization()}
        currentUserId="manager-user"
        selection={null}
        onSelect={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'Timesheet approval queue' }),
    ).toBeInTheDocument();
    expect(mocks.managementTimesheets).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        status: 'SUBMITTED',
        segmentStatus: 'PENDING',
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Approve / }));
    await waitFor(() =>
      expect(mocks.approveSegmentAsSeen).toHaveBeenCalledWith('segment-1', {
        netWorkedMinutes: 510,
        version: 3,
      }),
    );
    expect(await screen.findByText('Timesheet segment approved.')).toBeInTheDocument();
  });

  it('reloads and explains when the timesheet changed since it was opened', async () => {
    mocks.approveSegmentAsSeen.mockRejectedValue(conflict('TIMESHEET_SEGMENT_CHANGED'));
    render(
      <TimesheetReview
        organization={organization()}
        currentUserId="manager-user"
        selection={null}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Approve / }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This timesheet changed since you opened it.',
    );
    // The first load, then a reload after the conflict.
    await waitFor(() => expect(mocks.managementTimesheets).toHaveBeenCalledTimes(2));
  });

  it('returns a timesheet for changes only with a note', async () => {
    mocks.requestTimesheetChanges.mockResolvedValue({});
    render(
      <TimesheetReview
        organization={organization()}
        currentUserId="manager-user"
        selection={null}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Request changes / }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Return for changes?' });
    const confirm = within(dialog).getByRole('button', { name: 'Request changes' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('What needs to change'), {
      target: { value: 'Tuesday is missing a break' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.requestTimesheetChanges).toHaveBeenCalledWith(
        'segment-1',
        'Tuesday is missing a break',
      ),
    );
  });

  it('hides approval controls without the capability', async () => {
    render(
      <TimesheetReview
        organization={organization({ canApproveTimesheets: false })}
        currentUserId="manager-user"
        selection={null}
        onSelect={vi.fn()}
      />,
    );
    expect(await screen.findByRole('heading', { name: 'Time periods' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Timesheet approval queue' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
  });
});

describe('Periods', () => {
  it('explains an overlapping period and reports created timesheets', async () => {
    mocks.periods.mockResolvedValue({
      items: [
        {
          id: 'period-1',
          organizationId: 'org-1',
          startDate: '2026-10-05',
          endDate: '2026-10-11',
          status: 'OPEN',
          cadence: 'WEEKLY',
          openedAt: null,
          closedAt: null,
          lockedAt: null,
          payrollManaged: false,
          timesheetCount: 0,
        },
      ],
      nextAfterId: null,
    });
    mocks.generatePeriods.mockRejectedValue(conflict('TIME_PERIOD_OVERLAP'));
    mocks.materializeTimesheets.mockResolvedValue({
      created: 3,
      existing: 1,
      finalized: 1,
      timesheetIds: [],
    });
    render(
      <TimesheetReview
        organization={organization({ canApproveTimesheets: false, canManagePeriods: true })}
        currentUserId="manager-user"
        selection={null}
        onSelect={vi.fn()}
      />,
    );
    const form = await screen.findByRole('form', { name: 'Create time periods' });
    fireEvent.change(within(form).getByLabelText('First day'), { target: { value: '2026-10-07' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create periods' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'These dates overlap an existing period',
    );
    expect(mocks.generatePeriods).toHaveBeenCalledWith({
      organizationId: 'org-1',
      startDate: '2026-10-07',
      cadence: 'WEEKLY',
      count: 1,
    });

    fireEvent.click(await screen.findByRole('button', { name: /Create timesheets for/ }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Create timesheets',
      }),
    );
    expect(
      await screen.findByText(
        '3 timesheets created; 1 already existed; 1 approved or locked left unchanged.',
      ),
    ).toBeInTheDocument();
  });

  it('pages periods with the API cursor', async () => {
    const period = (id: string) => ({
      id,
      organizationId: 'org-1',
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      status: 'OPEN',
      cadence: 'WEEKLY',
      openedAt: null,
      closedAt: null,
      lockedAt: null,
      payrollManaged: false,
      timesheetCount: 0,
    });
    mocks.periods
      .mockResolvedValueOnce({ items: [period('p-1')], nextAfterId: 'p-1' })
      .mockResolvedValueOnce({ items: [period('p-2')], nextAfterId: null });
    render(
      <TimesheetReview
        organization={organization({ canApproveTimesheets: false })}
        currentUserId="manager-user"
        selection={null}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() =>
      expect(mocks.periods).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationId: 'org-1', afterId: 'p-1' }),
      ),
    );
    expect(await screen.findByText('Showing 2 periods.')).toBeInTheDocument();
  });
});

describe('Timesheet detail', () => {
  it('shows daily time with breaks, the automatic deduction and payable minutes, matching the totals', async () => {
    mocks.managementEntries.mockResolvedValue({
      items: [
        entry(),
        entry({
          id: 'entry-2',
          workDate: '2026-10-07',
          clockInAt: '2026-10-07T13:00:00.000Z',
          clockOutAt: '2026-10-07T14:00:00.000Z',
          grossMinutes: 60,
          paidBreakMinutes: 0,
          netWorkedMinutes: 60,
          policyDeductionMinutes: 0,
          payableMinutes: 60,
        }),
      ],
      nextAfterId: null,
    });
    render(
      <TimesheetDetail
        organization={organization({ canCorrectTime: true })}
        periodId="period-1"
        employeeId="employee-1"
        currentUserId="manager-user"
        onBack={vi.fn()}
      />,
    );
    const daily = await screen.findByRole('region', { name: 'Daily time' });
    expect(mocks.managementEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        employeeId: 'employee-1',
        startDate: '2026-10-05',
        endDate: '2026-10-11',
      }),
    );
    const firstDay = within(daily).getAllByRole('rowgroup')[1]!;
    // Payable on the entry and on the day total.
    expect(within(firstDay).getAllByText('8h 30m')).toHaveLength(2);
    expect(within(firstDay).getAllByText('30m').length).toBeGreaterThan(0); // auto deduction
    expect(within(daily).getAllByText('Day total')).toHaveLength(2);
    expect(within(daily).getAllByRole('button', { name: /Correct the/ })).toHaveLength(2);
    // Submitted by the employee: their name, not an id.
    expect(screen.getByText(/Ada Lovelace · /, { selector: 'dd' })).toBeInTheDocument();
  });

  it('shows a decision only while it stands: not on a segment pending again after resubmission (4F)', async () => {
    const stale = {
      reviewedByUserId: 'manager-user',
      reviewedAt: '2026-10-12T15:00:00.000Z',
      reviewerNote: 'Add the delivery break',
    };
    const base = sheet().segments[0]!;
    mocks.managementTimesheets.mockResolvedValue({
      items: [
        sheet({
          actors: { 'employee-user': 'Ada Lovelace', 'manager-user': 'Grace Hopper' },
          segments: [
            // Resubmitted: pending again, with the earlier request's fields still stored.
            { ...base, ...stale, status: 'PENDING' },
            {
              ...base,
              ...stale,
              id: 'segment-2',
              employmentAssignmentId: 'assignment-2',
              status: 'CHANGES_REQUESTED',
              reviewerNote: 'Fix the Tuesday clock-out',
              assignment: {
                id: 'assignment-2',
                position: { id: 'position-2', name: 'Lifeguard' },
              } as never,
            },
          ],
        }),
      ],
      nextAfterId: null,
    });
    render(
      <TimesheetDetail
        organization={organization()}
        periodId="period-1"
        employeeId="employee-1"
        currentUserId="manager-user"
        onBack={vi.fn()}
      />,
    );
    const pending = await screen.findByRole('row', { name: /Counsellor/ });
    expect(pending).not.toHaveTextContent('Add the delivery break');
    expect(pending).not.toHaveTextContent('Grace Hopper');
    const returned = screen.getByRole('row', { name: /Lifeguard/ });
    expect(returned).toHaveTextContent('Note: Fix the Tuesday clock-out');
  });

  it('explains why approvers without attendance access see totals only (decision D4)', async () => {
    render(
      <TimesheetDetail
        organization={organization({ canViewAttendance: false, canReviewExceptions: false })}
        periodId="period-1"
        employeeId="employee-1"
        currentUserId="manager-user"
        onBack={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/Daily entries are shown to people who can view attendance records/),
    ).toBeInTheDocument();
    expect(mocks.managementEntries).not.toHaveBeenCalled();
    expect(mocks.managementExceptions).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve Counsellor' })).toBeInTheDocument();
  });

  it('locks an approved timesheet with its version, and reloads on a stale version', async () => {
    mocks.managementTimesheets.mockResolvedValue({
      items: [sheet({ status: 'APPROVED', version: 7 })],
      nextAfterId: null,
    });
    mocks.lockTimesheet.mockRejectedValue(conflict('TIMESHEET_VERSION_CONFLICT'));
    render(
      <TimesheetDetail
        organization={organization({ canManageTimesheets: true })}
        periodId="period-1"
        employeeId="employee-1"
        currentUserId="manager-user"
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Lock' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Lock timesheet',
      }),
    );
    await waitFor(() => expect(mocks.lockTimesheet).toHaveBeenCalledWith('sheet-1', 7));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else updated this timesheet since you opened it.',
    );
    expect(mocks.managementTimesheets.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Approved: no submit on behalf, no approval buttons, the snapshot instead of live entries.
    expect(screen.queryByRole('button', { name: 'Submit on behalf' })).not.toBeInTheDocument();
    expect(mocks.managementEntries).not.toHaveBeenCalled();
  });

  it('submits on behalf only with a reason', async () => {
    mocks.managementTimesheets.mockResolvedValue({
      items: [sheet({ status: 'OPEN' })],
      nextAfterId: null,
    });
    mocks.submitTimesheetOnBehalf.mockResolvedValue({});
    render(
      <TimesheetDetail
        organization={organization({ canManageTimesheets: true })}
        periodId="period-1"
        employeeId="employee-1"
        currentUserId="manager-user"
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Submit on behalf' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'On leave' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit timesheet' }));
    await waitFor(() =>
      expect(mocks.submitTimesheetOnBehalf).toHaveBeenCalledWith('sheet-1', 'On leave'),
    );
    // Draft (not submitted): nothing to approve yet.
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
  });
});

describe('Exception review', () => {
  const exception = (overrides: Record<string, unknown> = {}) => ({
    id: 'exception-1',
    type: 'LATE_ARRIVAL',
    severity: 'REVIEW',
    workflowImpact: 'NON_BLOCKING',
    status: 'OPEN',
    timeEntryId: 'entry-1',
    employmentAssignmentId: 'assignment-1',
    detectedAt: '2026-10-06T14:00:00.000Z',
    resolvedAt: null,
    reason: null,
    metadata: { expectedAt: '2026-10-06T13:00:00.000Z', varianceMinutes: 20 },
    employeeId: 'employee-1',
    employeeName: 'Ada Lovelace',
    workDate: '2026-10-06',
    timezone: 'America/Toronto',
    resolutionMethod: null,
    resolvedByUserId: null,
    resolutionNote: null,
    actors: {},
    ...overrides,
  });

  it('resolves with a required note and links to the timesheet', async () => {
    mocks.managementExceptions.mockResolvedValue({ items: [exception()], nextAfterId: null });
    mocks.resolveException.mockResolvedValue({});
    const onOpenTimesheet = vi.fn();
    render(
      <ExceptionReview
        organization={organization()}
        currentUserId="manager-user"
        onOpenTimesheet={onOpenTimesheet}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Details/ }));
    expect(screen.getByText('20m')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Resolve this exception?' });
    const confirm = within(dialog).getByRole('button', { name: 'Resolve exception' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'Bus delay' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mocks.resolveException).toHaveBeenCalledWith('exception-1', 'Bus delay'),
    );
    // The row stays open after the decision.
    fireEvent.click(await screen.findByRole('button', { name: 'Open timesheet' }));
    expect(onOpenTimesheet).toHaveBeenCalledWith('employee-1', '2026-10-06');
  });

  it('tells automatic closures apart from manager decisions, and names the manager', async () => {
    mocks.managementExceptions.mockResolvedValue({
      items: [
        exception({
          id: 'system',
          status: 'RESOLVED',
          resolutionMethod: 'SYSTEM_AUTO_RESOLUTION',
          resolvedAt: '2026-10-06T22:00:00.000Z',
        }),
        exception({
          id: 'manager',
          type: 'NO_SHOW',
          status: 'DISMISSED',
          resolutionMethod: 'MANAGER_RESOLUTION',
          resolvedByUserId: 'other-manager',
          resolutionNote: 'Swapped shifts',
          resolvedAt: '2026-10-07T13:00:00.000Z',
          actors: { 'other-manager': 'Maya Manager' },
        }),
        exception({ id: 'superseded', status: 'SUPERSEDED' }),
      ],
      nextAfterId: null,
    });
    render(<ExceptionReview organization={organization()} currentUserId="manager-user" />);
    expect(await screen.findByText('Closed automatically by the system')).toBeInTheDocument();
    expect(screen.getByText('Manager decision')).toBeInTheDocument();
    expect(screen.getByText('Superseded automatically by the system')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Details for No.?show/i }));
    expect(screen.getByText(/By Maya Manager/)).toBeInTheDocument();
    expect(screen.getByText('Note: Swapped shifts')).toBeInTheDocument();
    // Closed: no decisions offered.
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });

  it('offers no decisions without the capability, and filters by type on the server', async () => {
    mocks.managementExceptions.mockResolvedValue({ items: [exception()], nextAfterId: null });
    render(
      <ExceptionReview
        organization={organization({ canReviewExceptions: false })}
        currentUserId="manager-user"
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Details/ }));
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'NO_SHOW' } });
    await waitFor(() =>
      expect(mocks.managementExceptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationId: 'org-1', type: 'NO_SHOW' }),
      ),
    );
  });
});

describe('Direct correction on a daylight-saving day', () => {
  it('asks which repeated time is meant and sends it with that offset', async () => {
    mocks.correctEntry
      .mockRejectedValueOnce(
        conflict('TIME_LOCAL_TIME_AMBIGUOUS', {
          occurrences: [
            {
              instant: '2026-11-01T05:30:00.000Z',
              offset: '-04:00',
              value: '2026-11-01T01:30-04:00',
            },
            {
              instant: '2026-11-01T06:30:00.000Z',
              offset: '-05:00',
              value: '2026-11-01T01:30-05:00',
            },
          ],
        }),
      )
      .mockResolvedValueOnce({});
    const onDone = vi.fn();
    render(
      <CorrectEntryDialog
        entry={entry({
          workDate: '2026-10-31',
          clockInAt: '2026-10-31T22:00:00.000Z',
          clockOutAt: '2026-11-01T04:00:00.000Z',
        })}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Correct time entry' });
    fireEvent.change(within(dialog).getByLabelText('New clock-out'), {
      target: { value: '2026-11-01T01:30' },
    });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Left late' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save correction' }));

    const choice = await within(dialog).findByRole('group', { name: /happens twice/ });
    // The dialog's own instruction (it offers the occurrences), with both valid times listed.
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'This time occurs twice because the clocks moved back. Select the correct occurrence below.',
    );
    expect(within(choice).getAllByRole('radio')).toHaveLength(2);
    expect(within(choice).getByLabelText('First occurrence (UTC-04:00)')).toBeInTheDocument();
    // A choice is required before saving again.
    expect(within(dialog).getByRole('button', { name: 'Save correction' })).toBeDisabled();
    fireEvent.click(within(choice).getByLabelText('Second occurrence (UTC-05:00)'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(mocks.correctEntry).toHaveBeenLastCalledWith('entry-1', {
        type: 'CHANGE_CLOCK_OUT',
        reason: 'Left late',
        clockOutAt: '2026-11-01T01:30-05:00',
      }),
    );
    expect(onDone).toHaveBeenCalledWith('Time entry corrected.');
  });

  // ─── R4-A.4: coverage corrections ─────────────────────────────────────────────
  const covered = (id: string, name: string, isPayrollOwner = false) => ({
    employmentAssignmentId: id,
    isPayrollOwner,
    assignment: { id, position: { id: `p-${id}`, name } } as never,
  });
  const options = [
    { id: 'assignment-1', name: 'Counsellor' },
    { id: 'assignment-2', name: 'Lifeguard' },
    { id: 'assignment-3', name: 'Kitchen' },
  ];

  it('changes which assignments an entry covers, previewing before and after, with a reason', async () => {
    mocks.correctEntry.mockResolvedValueOnce({});
    const onDone = vi.fn();
    const { container } = render(
      <CorrectEntryDialog
        entry={entry({
          coverage: [
            covered('assignment-1', 'Counsellor', true),
            covered('assignment-2', 'Lifeguard'),
          ],
        })}
        coverageOptions={options}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Correct time entry' });
    fireEvent.change(within(dialog).getByLabelText('What to correct'), {
      target: { value: 'CHANGE_COVERAGE' },
    });
    const group = within(dialog).getByRole('group', { name: 'Also covers' });
    // The payroll owner is never offered; the current coverage is pre-selected.
    expect(within(group).queryByRole('checkbox', { name: 'Counsellor' })).not.toBeInTheDocument();
    expect(within(group).getByRole('checkbox', { name: 'Lifeguard' })).toBeChecked();
    expect(group).toHaveTextContent('Paid under Counsellor');
    const save = within(dialog).getByRole('button', { name: 'Save correction' });
    expect(save).toBeDisabled(); // nothing changed, no reason

    fireEvent.click(within(group).getByRole('checkbox', { name: 'Lifeguard' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Kitchen' }));
    const preview = within(dialog).getByLabelText('Coverage change');
    expect(preview).toHaveTextContent('Now coversLifeguard');
    expect(preview).toHaveTextContent('After savingKitchen');
    expect(save).toBeDisabled(); // still no reason
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Worked the kitchen, not the pool' },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(mocks.correctEntry).toHaveBeenCalledWith('entry-1', {
        type: 'CHANGE_COVERAGE',
        reason: 'Worked the kitchen, not the pool',
        additionalEmploymentAssignmentIds: ['assignment-3'],
      }),
    );
    expect(onDone).toHaveBeenCalledWith(
      'Coverage corrected. The recorded time is unchanged and still counted once.',
    );
    await expectNoAxeViolations(container);
  });

  it('keeps the dialog open with the API refusal (e.g. own time or locked time)', async () => {
    mocks.correctEntry.mockRejectedValueOnce(
      new AuthApiError('forbidden', 403, 'You cannot correct your own time.', {
        code: 'TIME_SELF_TARGET_FORBIDDEN',
      }),
    );
    render(
      <CorrectEntryDialog
        entry={entry()}
        coverageOptions={options}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Correct time entry' });
    fireEvent.change(within(dialog).getByLabelText('What to correct'), {
      target: { value: 'CHANGE_COVERAGE' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Kitchen' }));
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Covered' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save correction' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Correct time entry' })).toBeInTheDocument();
  });

  it('offers no coverage correction when the employee has no other assignment', () => {
    render(
      <CorrectEntryDialog
        entry={entry()}
        coverageOptions={[{ id: 'assignment-1', name: 'Counsellor' }]}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(
      within(screen.getByLabelText('What to correct')).queryByRole('option', {
        name: 'Assignments covered',
      }),
    ).not.toBeInTheDocument();
  });

  it('asks which repeated start time a manual entry means and sends that offset', async () => {
    mocks.addEntry
      .mockRejectedValueOnce(
        conflict('TIME_LOCAL_TIME_AMBIGUOUS', {
          occurrences: [
            {
              instant: '2026-11-01T05:30:00.000Z',
              offset: '-04:00',
              value: '2026-11-01T01:30-04:00',
            },
            {
              instant: '2026-11-01T06:30:00.000Z',
              offset: '-05:00',
              value: '2026-11-01T01:30-05:00',
            },
          ],
        }),
      )
      .mockResolvedValueOnce({});
    const onDone = vi.fn();
    render(
      <AddEntryDialog
        target={{
          employeeId: 'employee-1',
          employeeName: 'Ada Lovelace',
          timezone: 'America/Toronto',
          assignments: [{ id: 'assignment-1', name: 'Counsellor' }],
          defaultDate: '2026-11-01',
        }}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Add missing time entry' });
    fireEvent.change(within(dialog).getByLabelText('Start'), {
      target: { value: '2026-11-01T01:30' },
    });
    fireEvent.change(within(dialog).getByLabelText('End'), {
      target: { value: '2026-11-01T06:00' },
    });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Paper sheet' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add entry' }));

    const choice = await within(dialog).findByRole('group', { name: /happens twice/ });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Select the correct occurrence below.',
    );
    expect(within(choice).getAllByRole('radio')).toHaveLength(2);
    expect(within(dialog).getByRole('button', { name: 'Add entry' })).toBeDisabled();
    fireEvent.click(within(choice).getByLabelText('First occurrence (UTC-04:00)'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add entry' }));
    await waitFor(() =>
      expect(mocks.addEntry).toHaveBeenLastCalledWith('employee-1', {
        employmentAssignmentId: 'assignment-1',
        startAt: '2026-11-01T01:30-04:00',
        endAt: '2026-11-01T06:00',
        reason: 'Paper sheet',
      }),
    );
    expect(onDone).toHaveBeenCalledWith('Missing time entry added.');
  });

  it('explains a time skipped by the clocks going forward', async () => {
    mocks.correctEntry.mockRejectedValueOnce(
      new AuthApiError('validation', 400, 'Nonexistent', { code: 'TIME_LOCAL_TIME_NONEXISTENT' }),
    );
    render(<CorrectEntryDialog entry={entry()} onClose={vi.fn()} onDone={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Correct time entry' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Fix' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save correction' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That time does not exist on this day',
    );
  });
});
