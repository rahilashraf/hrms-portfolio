import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { EmployeeTimePage } from './employee-time-page';
import { expectNoAxeViolations } from '../../test/axe';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  selfEntries: vi.fn(),
  selfExceptions: vi.fn(),
  selfCorrections: vi.fn(),
  selfTimesheets: vi.fn(),
  selfTimesheet: vi.fn(),
  expectedAttendance: vi.fn(),
  clockIn: vi.fn(),
  clockOut: vi.fn(),
  switchAssignment: vi.fn(),
  resolveMissedClockOut: vi.fn(),
  requestCorrection: vi.fn(),
  cancelCorrection: vi.fn(),
  submitTimesheet: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  mySignIns: vi.fn(),
  myPin: vi.fn(),
  changeMyPin: vi.fn(),
}));

vi.mock('../../lib/time/api', () => ({ timeApi: mocks }));
vi.mock('../../lib/attendance/api', () => ({ attendanceApi: mocks }));

const assignment = {
  id: 'assignment-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-10-01',
  endDate: null,
  isPrimary: true,
  position: { id: 'position-1', name: 'Counsellor', code: 'COUN' },
  jobTitle: { id: 'job-1', name: 'Counsellor', code: 'COUN' },
  organization: { id: 'org-1', name: 'Camp', code: 'CAMP' },
  placement: null,
  workLocation: { id: 'loc-1', name: 'Main', code: 'MAIN' },
  manager: null,
};
const kitchen = {
  ...assignment,
  id: 'assignment-2',
  position: { ...assignment.position, name: 'Kitchen' },
  organization: { id: 'org-2', name: 'School', code: 'SCH' },
};

const capability = (overrides: Record<string, unknown> = {}) => ({
  employmentAssignmentId: 'assignment-1',
  position: { id: 'position-1', name: 'Counsellor' },
  organization: { id: 'org-1', name: 'Camp' },
  timezone: 'America/Toronto',
  attendanceEnabled: true,
  clockEnabled: true,
  canCapture: true,
  trackingMode: 'TIME_CLOCK',
  captureMode: 'SELF_SERVICE',
  selfServiceCapture: true,
  kioskLocationRule: 'ANY_IN_ORGANIZATION',
  signOutEnabled: false,
  breakMode: 'MANUAL_PUNCH',
  assignmentSwitching: false,
  correctionRequestsEnabled: true,
  missedPunchSelfResolutionEnabled: true,
  allowEarlySubmission: false,
  unavailableReason: null,
  explanation: null,
  ...overrides,
});

function offClockStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: 'OFF_CLOCK',
    serverTime: '2026-10-03T12:00:00.000Z',
    currentTimeEntry: null,
    currentAssignment: null,
    currentBreakEntry: null,
    breakStartedAt: null,
    clockedInAt: null,
    eligibleAssignments: [assignment, kitchen],
    activeExceptions: [],
    availableActions: ['CLOCK_IN'],
    assignmentCapabilities: [
      capability(),
      capability({
        employmentAssignmentId: 'assignment-2',
        position: { id: 'position-1', name: 'Kitchen' },
        organization: { id: 'org-2', name: 'School' },
      }),
    ],
    ...overrides,
  };
}

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: 'entry-1',
  employeeId: 'employee-1',
  employeeNumber: 'E-1',
  employeeName: 'Ada Lovelace',
  employmentAssignmentId: 'assignment-1',
  assignment,
  workDate: '2026-10-02',
  clockInAt: '2026-10-02T13:00:00.000Z',
  clockOutAt: '2026-10-02T17:00:00.000Z',
  timezone: 'America/Toronto',
  status: 'CLOSED',
  source: 'LIVE_CLOCK',
  grossMinutes: 240,
  paidBreakMinutes: 0,
  unpaidBreakMinutes: 0,
  breakMinutes: 0,
  netWorkedMinutes: 240,
  policyDeductionMinutes: 30,
  payableMinutes: 210,
  breaks: [],
  exceptions: [],
  corrections: [],
  ...overrides,
});

/** The current query parameters, order-independent. */
function query() {
  return Object.fromEntries(new URLSearchParams(window.location.search));
}

function goTo(search: string) {
  window.history.replaceState(null, '', `/time${search}`);
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  goTo('');
  mocks.status.mockResolvedValue(offClockStatus());
  mocks.selfEntries.mockResolvedValue({ items: [], nextAfterId: null });
  mocks.selfExceptions.mockResolvedValue({ exceptions: [], nextAfterId: null });
  mocks.selfCorrections.mockResolvedValue({ corrections: [], nextAfterId: null });
  mocks.selfTimesheets.mockResolvedValue({ timesheets: [] });
  mocks.expectedAttendance.mockResolvedValue({ from: '', to: '', items: [] });
  mocks.mySignIns.mockResolvedValue({ items: [] });
  mocks.myPin.mockResolvedValue({ hasPin: false });
  mocks.clockIn.mockResolvedValue({});
});

afterEach(cleanup);

describe('My Time: Today', () => {
  it('requires an assignment choice, named with its organization, when several can clock in', async () => {
    render(<EmployeeTimePage />);
    expect(await screen.findByText('Off Clock')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Today' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Clock In' })).toBeDisabled();
    const picker = screen.getByLabelText('Assignment');
    expect(picker).toHaveTextContent('Counsellor · Camp');
    expect(picker).toHaveTextContent('Kitchen · School');

    fireEvent.change(picker, { target: { value: 'assignment-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clock In' }));
    await waitFor(() => expect(mocks.clockIn).toHaveBeenCalledWith('assignment-2', undefined, []));
    expect(await screen.findByText('Clocked in.')).toBeInTheDocument();
  });

  const shift = (id: string, start: string, end: string) => ({
    scheduledShiftId: id,
    employmentAssignmentId: 'assignment-1',
    workDate: '2027-03-02',
    startsAt: start,
    endsAt: end,
    timezone: 'America/Toronto',
  });
  const twoShifts = [
    shift('shift-morning', '2027-03-02T13:00:00.000Z', '2027-03-02T14:30:00.000Z'),
    shift('shift-late', '2027-03-02T14:45:00.000Z', '2027-03-02T17:00:00.000Z'),
  ];

  // ─── R4-A.3: several assignments, one clock-in ────────────────────────────────
  const lifeguard = {
    ...assignment,
    id: 'assignment-3',
    isPrimary: false,
    position: { ...assignment.position, id: 'position-3', name: 'Lifeguard' },
  };

  it('covers several assignments of one organization with one clock-in, never another organization', async () => {
    mocks.status.mockResolvedValue(
      offClockStatus({ eligibleAssignments: [assignment, kitchen, lifeguard] }),
    );
    mocks.clockIn.mockResolvedValue(offClockStatus({ state: 'CLOCKED_IN' }));
    render(<EmployeeTimePage />);
    fireEvent.change(await screen.findByLabelText('Assignment'), {
      target: { value: 'assignment-1' },
    });
    const covering = screen.getByRole('group', { name: 'Also covering (optional)' });
    // Only Camp's other assignment is offered; School's Kitchen needs its own clock-in.
    expect(within(covering).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(covering).getByRole('checkbox', { name: /Lifeguard/ })).toBeInTheDocument();
    expect(within(covering).queryByRole('checkbox', { name: /Kitchen/ })).not.toBeInTheDocument();
    expect(covering).toHaveTextContent(
      'Assignments in another organization need their own clock-in.',
    );
    expect(covering).toHaveTextContent('The time is counted once');

    fireEvent.click(within(covering).getByRole('checkbox', { name: /Lifeguard/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clock In (2 assignments)' }));
    await waitFor(() =>
      expect(mocks.clockIn).toHaveBeenCalledWith('assignment-1', undefined, ['assignment-3']),
    );
    expect(mocks.clockIn).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Clocked in, covering 2 assignments (time counted once).'),
    ).toBeInTheDocument();
  });

  it('drops covered assignments when the payroll assignment changes', async () => {
    mocks.status.mockResolvedValue(
      offClockStatus({ eligibleAssignments: [assignment, kitchen, lifeguard] }),
    );
    render(<EmployeeTimePage />);
    const picker = await screen.findByLabelText('Assignment');
    fireEvent.change(picker, { target: { value: 'assignment-1' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Lifeguard/ }));
    fireEvent.change(picker, { target: { value: 'assignment-2' } });
    // Kitchen (School) has nothing else to cover in its organization.
    expect(
      screen.queryByRole('group', { name: 'Also covering (optional)' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clock In' }));
    await waitFor(() => expect(mocks.clockIn).toHaveBeenCalledWith('assignment-2', undefined, []));
  });

  it('starts from the time clock’s own suggestion and shows its scheduled shift', async () => {
    mocks.status.mockResolvedValue(
      offClockStatus({
        eligibleAssignments: [assignment, kitchen],
        scheduledShiftOptions: [
          {
            scheduledShiftId: 'shift-k',
            employmentAssignmentId: 'assignment-2',
            workDate: '2027-03-02',
            startsAt: '2027-03-02T14:00:00.000Z',
            endsAt: '2027-03-02T22:00:00.000Z',
            timezone: 'America/Toronto',
          },
        ],
        preselectedScheduledShiftId: 'shift-k',
        preselectedEmploymentAssignmentId: 'assignment-2',
      }),
    );
    render(<EmployeeTimePage />);
    expect(await screen.findByLabelText('Assignment')).toHaveValue('assignment-2');
    expect(screen.getByText(/Your scheduled shift: 09:00–17:00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clock In' }));
    // The time clock links its only open shift itself.
    await waitFor(() => expect(mocks.clockIn).toHaveBeenCalledWith('assignment-2', undefined, []));
  });

  it('shows a clock-in warning while confirming the clock-in', async () => {
    mocks.status.mockResolvedValue(offClockStatus({ eligibleAssignments: [assignment] }));
    mocks.clockIn.mockResolvedValue({
      ...offClockStatus({ state: 'CLOCKED_IN' }),
      warnings: [
        {
          code: 'UNSCHEDULED_WORK',
          message: 'No published scheduled shift matched this clock-in.',
          attendanceExceptionId: 'exc-1',
        },
      ],
    });
    const { container } = render(<EmployeeTimePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clock In' }));
    expect(await screen.findByText('Clocked in.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'No published shift matched this clock-in. It was recorded and flagged for review.',
      ),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('asks which shift when one assignment has several open, and sends the choice', async () => {
    mocks.status.mockResolvedValue(
      offClockStatus({ eligibleAssignments: [assignment], scheduledShiftOptions: twoShifts }),
    );
    render(<EmployeeTimePage />);
    const clockIn = await screen.findByRole('button', { name: 'Clock In' });
    expect(clockIn).toBeDisabled();
    const picker = screen.getByLabelText('Scheduled shift');
    expect(picker).toHaveTextContent('08:00–09:30');
    fireEvent.change(picker, { target: { value: 'shift-late' } });
    fireEvent.click(clockIn);
    await waitFor(() =>
      expect(mocks.clockIn).toHaveBeenCalledWith('assignment-1', 'shift-late', []),
    );
  });

  it('shows the shift choice instead of a dead end when the server asks for one', async () => {
    const single = offClockStatus({ eligibleAssignments: [assignment] });
    mocks.status
      .mockResolvedValueOnce(single)
      .mockResolvedValue({ ...single, scheduledShiftOptions: twoShifts });
    mocks.clockIn.mockRejectedValueOnce(
      new AuthApiError('conflict', 409, undefined, { code: 'SCHEDULED_SHIFT_SELECTION_REQUIRED' }),
    );
    render(<EmployeeTimePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clock In' }));
    expect(await screen.findByText(/Choose the shift you are starting/)).toBeInTheDocument();
    expect(screen.getByLabelText('Scheduled shift')).toBeInTheDocument();
  });

  it('never offers actions the API did not, and explains each assignment that cannot record here', async () => {
    mocks.status.mockResolvedValue(
      offClockStatus({
        eligibleAssignments: [],
        availableActions: [],
        assignmentCapabilities: [
          capability({
            captureMode: 'KIOSK_ONLY',
            selfServiceCapture: false,
            unavailableReason: 'KIOSK_ONLY',
            explanation:
              'Attendance for this assignment is recorded at the onsite kiosk only, with your employee number and attendance PIN.',
          }),
          capability({
            employmentAssignmentId: 'assignment-2',
            position: { id: 'p2', name: 'Kitchen' },
            organization: { id: 'org-2', name: 'School' },
            clockEnabled: false,
            unavailableReason: 'CLOCK_DISABLED',
            explanation: 'Attendance is not recorded for this assignment.',
          }),
        ],
      }),
    );
    render(<EmployeeTimePage />);
    const assignments = await screen.findByRole('heading', { name: 'Your assignments' });
    const section = assignments.closest('section')!;
    expect(section).toHaveTextContent('Counsellor · Camp');
    expect(section).toHaveTextContent('recorded at the onsite kiosk only');
    expect(section).toHaveTextContent('Kitchen · School');
    expect(section).toHaveTextContent('Attendance is not recorded for this assignment.');
    expect(screen.queryByRole('button', { name: /Clock|Sign in/ })).not.toBeInTheDocument();
    // Kiosk work: the employee can set their PIN here.
    expect(await screen.findByRole('heading', { name: 'Kiosk PIN' })).toBeInTheDocument();
    expect(mocks.myPin).toHaveBeenCalled();
  });

  it('offers a missed clock-out entry only when the API does', async () => {
    const open = {
      id: 'entry-open',
      employmentAssignmentId: 'assignment-1',
      clockedInAt: '2026-10-02T13:00:00.000Z',
      timezone: 'America/Toronto',
      workDate: '2026-10-02',
    };
    const missing = {
      id: 'exception-1',
      type: 'MISSING_CLOCK_OUT',
      severity: 'ACTION_REQUIRED',
      workflowImpact: 'SUBMISSION_BLOCKING',
      status: 'OPEN',
      timeEntryId: 'entry-open',
      employmentAssignmentId: 'assignment-1',
      detectedAt: '2026-10-03T05:00:00.000Z',
      resolvedAt: null,
      reason: null,
    };
    const base = offClockStatus({
      state: 'CLOCKED_IN',
      currentTimeEntry: open,
      currentAssignment: assignment,
      clockedInAt: open.clockedInAt,
      eligibleAssignments: [],
      activeExceptions: [missing],
    });
    mocks.status.mockResolvedValue({ ...base, availableActions: ['CLOCK_OUT'] });
    render(<EmployeeTimePage />);
    expect(await screen.findByRole('button', { name: 'Clock Out' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Missed clock-out time')).not.toBeInTheDocument();

    cleanup();
    mocks.status.mockResolvedValue({
      ...base,
      availableActions: ['CLOCK_OUT', 'RESOLVE_MISSED_CLOCK_OUT'],
    });
    mocks.resolveMissedClockOut.mockResolvedValue({});
    render(<EmployeeTimePage />);
    fireEvent.change(await screen.findByLabelText('Missed clock-out time'), {
      target: { value: '2026-10-02T17:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record clock-out' }));
    await waitFor(() =>
      expect(mocks.resolveMissedClockOut).toHaveBeenCalledWith('exception-1', '2026-10-02T17:00'),
    );
  });

  it('confirms presence for the chosen open session, reports a repeat honestly, and signs out where enabled', async () => {
    const option = (id: string, start: string, end: string, signIn: unknown = null) => ({
      scheduledShiftId: id,
      employmentAssignmentId: 'assignment-1',
      workDate: '2027-03-02',
      startsAt: start,
      endsAt: end,
      timezone: 'America/Toronto',
      clockInOpensAt: start,
      clockInClosesAt: end,
      signIn,
    });
    mocks.status.mockResolvedValue(
      offClockStatus({
        eligibleAssignments: [],
        availableActions: ['SIGN_IN', 'SIGN_OUT'],
        signInAssignments: [assignment],
        signOutAssignments: [assignment],
        signInOptions: [
          option('session-a', '2027-03-02T18:00:00.000Z', '2027-03-02T18:30:00.000Z', {
            id: 'sign-in-a',
            signedInAt: '2027-03-02T18:01:00.000Z',
          }),
          option('session-b', '2027-03-02T18:45:00.000Z', '2027-03-02T19:15:00.000Z'),
        ],
        assignmentCapabilities: [
          capability({ trackingMode: 'SIGN_IN_ONLY', signOutEnabled: true }),
        ],
      }),
    );
    mocks.signIn.mockResolvedValueOnce({
      outcome: 'SIGNED_IN',
      signIn: { signedInAt: '2027-03-02T18:46:00.000Z', timezone: 'America/Toronto' },
      exceptions: [],
    });
    render(<EmployeeTimePage />);
    const sessions = await screen.findByRole('list', { name: 'Sessions open now for Counsellor' });
    expect(within(sessions).getByText(/Signed in at/)).toBeInTheDocument();
    expect(within(sessions).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Clock/ })).not.toBeInTheDocument();

    fireEvent.click(within(sessions).getByRole('button', { name: 'Sign in for 13:45–14:15' }));
    await waitFor(() =>
      expect(mocks.signIn).toHaveBeenCalledWith('assignment-1', expect.any(String), 'session-b'),
    );
    expect(await screen.findByText(/Signed in for 13:45–14:15/)).toBeInTheDocument();

    mocks.signIn.mockResolvedValueOnce({
      outcome: 'ALREADY_SIGNED_IN',
      signIn: { signedInAt: '2027-03-02T18:46:00.000Z', timezone: 'America/Toronto' },
      exceptions: [],
    });
    fireEvent.click(within(sessions).getByRole('button', { name: 'Sign in for 13:45–14:15' }));
    expect(
      await screen.findByText(/already signed in.*Nothing new was recorded/),
    ).toBeInTheDocument();

    mocks.signOut.mockResolvedValue({ outcome: 'SIGNED_OUT', signOut: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out of Counsellor · Camp' }));
    await waitFor(() =>
      expect(mocks.signOut).toHaveBeenCalledWith('assignment-1', expect.any(String)),
    );
  });

  it('lists today’s scheduled shifts with what attendance recorded', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    mocks.expectedAttendance.mockResolvedValue({
      from: today,
      to: today,
      items: [
        {
          scheduledShiftId: 'shift-1',
          employmentAssignmentId: 'assignment-1',
          position: { id: 'p1', name: 'Counsellor' },
          organization: { id: 'org-1', name: 'Camp' },
          workDate: today,
          startsAt: `${today}T13:00:00.000Z`,
          endsAt: `${today}T17:00:00.000Z`,
          timezone: 'America/Toronto',
          status: 'LATE',
        },
      ],
    });
    render(<EmployeeTimePage />);
    const heading = await screen.findByRole('heading', { name: 'Today’s shifts' });
    const section = heading.closest('section')!;
    expect(await within(section).findByText('Late')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: /View record/ }));
    expect(query()).toEqual({ date: today, tab: 'history' });
  });
});

describe('My Time: History', () => {
  it('pages entries with deductions, payable minutes and labels, in a keyboard-focusable region', async () => {
    goTo('?tab=history');
    mocks.selfEntries
      .mockResolvedValueOnce({
        items: [
          entry(),
          entry({
            id: 'entry-2',
            workDate: '2026-10-01',
            status: 'VOIDED',
            payableMinutes: null,
            policyDeductionMinutes: null,
          }),
          entry({
            id: 'entry-3',
            workDate: '2026-09-30',
            corrections: [
              {
                id: 'c-1',
                type: 'CHANGE_CLOCK_OUT',
                status: 'APPROVED',
                requestedAt: '',
                reviewedAt: '',
                adjustmentId: 'a',
              },
            ],
          }),
        ],
        nextAfterId: 'entry-3',
      })
      .mockResolvedValueOnce({
        items: [entry({ id: 'entry-4', workDate: '2026-09-29' })],
        nextAfterId: null,
      });
    render(<EmployeeTimePage />);
    const region = await screen.findByRole('region', { name: 'Attendance history' });
    expect(region).toHaveAttribute('tabindex', '0');
    const first = within(region).getByRole('row', { name: /10\/02\/2026/ });
    expect(first).toHaveTextContent('Counsellor · Camp');
    expect(first).toHaveTextContent('30m');
    expect(first).toHaveTextContent('3h 30m');
    expect(within(region).getByRole('row', { name: /10\/01\/2026/ })).toHaveTextContent('Voided');
    expect(within(region).getByRole('row', { name: /09\/30\/2026/ })).toHaveTextContent(
      'Corrected',
    );
    expect(
      within(region).queryByRole('button', { name: /Request a correction for 10\/01\/2026/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Load more/ }));
    expect(await within(region).findByRole('row', { name: /09\/29\/2026/ })).toBeInTheDocument();
    expect(mocks.selfEntries).toHaveBeenLastCalledWith({ limit: 25, afterId: 'entry-3' });

    // A record opens the request form for it.
    fireEvent.click(
      within(region).getByRole('button', { name: /Request a correction for 10\/02\/2026/ }),
    );
    expect(query()).toEqual({ entry: 'entry-1', tab: 'requests' });
  });

  it('filters by organization and a deep-linked date, only within the employee’s own records', async () => {
    goTo('?tab=history&date=2026-10-02');
    render(<EmployeeTimePage />);
    await waitFor(() =>
      expect(mocks.selfEntries).toHaveBeenCalledWith({
        startDate: '2026-10-02',
        endDate: '2026-10-02',
        limit: 25,
      }),
    );
    fireEvent.change(await screen.findByLabelText('Organization'), { target: { value: 'org-2' } });
    await waitFor(() =>
      expect(mocks.selfEntries).toHaveBeenLastCalledWith({
        organizationId: 'org-2',
        startDate: '2026-10-02',
        endDate: '2026-10-02',
        limit: 25,
      }),
    );
  });
});

describe('My Time: Timesheets', () => {
  const sheet = (overrides: Record<string, unknown> = {}) => ({
    id: 'sheet-1',
    employeeId: 'employee-1',
    timePeriodId: 'period-1',
    status: 'CHANGES_REQUESTED',
    submittedByUserId: 'user-self',
    submittedAt: '2026-10-08T12:00:00.000Z',
    approvedByUserId: null,
    approvedAt: null,
    lockedByUserId: null,
    lockedAt: null,
    reopenedByUserId: null,
    reopenedAt: null,
    reviewerNote: 'Please confirm Tuesday',
    version: 1,
    totals: { netWorkedMinutes: 210 },
    period: {
      id: 'period-1',
      organizationId: 'org-1',
      startDate: '2026-10-01',
      endDate: '2026-10-07',
      status: 'CLOSED',
      cadence: 'WEEKLY',
      openedAt: null,
      closedAt: null,
      lockedAt: null,
    },
    segments: [
      {
        id: 'segment-1',
        employmentAssignmentId: 'assignment-1',
        status: 'CHANGES_REQUESTED',
        reviewedByUserId: 'user-manager',
        reviewedAt: '2026-10-08T13:00:00.000Z',
        reviewerNote: 'Please confirm Tuesday',
        grossMinutes: 240,
        paidBreakMinutes: 0,
        unpaidBreakMinutes: 0,
        policyDeductionMinutes: 30,
        netWorkedMinutes: 210,
        approvedWorkedMinutes: 0,
        calculatedAt: null,
        assignment,
      },
    ],
    events: [
      {
        id: 'event-1',
        segmentId: null,
        actorUserId: 'user-self',
        type: 'SUBMITTED',
        note: null,
        metadata: {},
        occurredAt: '2026-10-08T12:00:00.000Z',
      },
      {
        id: 'event-2',
        segmentId: 'segment-1',
        actorUserId: 'user-manager',
        type: 'CHANGES_REQUESTED',
        note: 'Please confirm Tuesday',
        metadata: {},
        occurredAt: '2026-10-08T13:00:00.000Z',
      },
    ],
    actors: { 'user-self': 'Ada Lovelace', 'user-manager': 'Maya Patel' },
    ...overrides,
  });

  it('lists timesheets and opens one by deep link', async () => {
    goTo('?tab=timesheets');
    mocks.selfTimesheets.mockResolvedValue({ timesheets: [sheet()] });
    mocks.selfTimesheet.mockResolvedValue(sheet());
    render(<EmployeeTimePage />);
    const open = await screen.findByRole('button', {
      name: 'Open the timesheet for 10/01/2026 – 10/07/2026',
    });
    expect(screen.getByText(/Camp · payable 3h 30m/)).toBeInTheDocument();
    fireEvent.click(open);
    expect(query()).toEqual({ tab: 'timesheets', timesheet: 'sheet-1' });
  });

  it('shows only the notes of segments currently returned, not an earlier round’s (4F)', async () => {
    goTo('?tab=timesheets&timesheet=sheet-1');
    const returned = sheet().segments[0]!;
    mocks.selfTimesheet.mockResolvedValue(
      sheet({
        segments: [
          // Returned in an earlier round, resubmitted: pending again, note kept in history.
          { ...returned, id: 'segment-0', status: 'PENDING', reviewerNote: 'Earlier round' },
          returned,
        ],
      }),
    );
    mocks.selfEntries.mockResolvedValue({ items: [entry()], nextAfterId: null });
    render(<EmployeeTimePage />);
    expect(await screen.findByText('Your manager asked for changes.')).toBeInTheDocument();
    expect(screen.getByText('“Please confirm Tuesday”')).toBeInTheDocument();
    expect(screen.queryByText('“Earlier round”')).not.toBeInTheDocument();
  });

  it('shows the reviewer’s note, daily time and named history, and submits only the totals reviewed', async () => {
    goTo('?tab=timesheets&timesheet=sheet-1');
    mocks.selfTimesheet.mockResolvedValue(sheet());
    mocks.selfEntries.mockResolvedValue({ items: [entry()], nextAfterId: null });
    mocks.submitTimesheet
      .mockRejectedValueOnce(
        new AuthApiError('conflict', 409, 'changed', { code: 'TIMESHEET_TOTALS_CHANGED' }),
      )
      .mockResolvedValueOnce({});
    render(<EmployeeTimePage />);
    expect(await screen.findByText('Your manager asked for changes.')).toBeInTheDocument();
    expect(screen.getByText('“Please confirm Tuesday”')).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Daily time' })).toHaveTextContent('3h 30m');
    expect(mocks.selfEntries).toHaveBeenCalledWith({
      organizationId: 'org-1',
      startDate: '2026-10-01',
      endDate: '2026-10-07',
      limit: 100,
    });
    const history = screen.getByRole('heading', { name: 'History' }).closest('section')!;
    expect(history).toHaveTextContent('Maya Patel');
    expect(history).toHaveTextContent('Note: Please confirm Tuesday');
    // No manager actions here.
    expect(screen.queryByRole('button', { name: /Approve|Lock|Reopen/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review and resubmit' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Submit this timesheet?' });
    expect(dialog).toHaveTextContent('3h 30m');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit timesheet' }));
    await waitFor(() =>
      expect(mocks.submitTimesheet).toHaveBeenCalledWith('sheet-1', {
        expectedNetWorkedMinutes: 210,
        expectedVersion: 1,
      }),
    );
    // Stale: reloaded, explained, nothing submitted.
    expect(await screen.findByText(/changed since you reviewed it/)).toBeInTheDocument();
    expect(mocks.selfTimesheet).toHaveBeenCalledTimes(2);
  });

  it('shows an approved timesheet as its stored snapshot, without a submit action', async () => {
    goTo('?tab=timesheets&timesheet=sheet-1');
    mocks.selfTimesheet.mockResolvedValue(
      sheet({
        status: 'APPROVED',
        reviewerNote: null,
        totals: {
          netWorkedMinutes: 210,
          payrollWorkDates: [
            {
              workDate: '2026-10-02',
              employmentAssignmentId: 'assignment-1',
              grossMinutes: 240,
              paidBreakMinutes: 0,
              unpaidBreakMinutes: 0,
              policyDeductionMinutes: 30,
              approvedWorkedMinutes: 210,
            },
          ],
        },
      }),
    );
    render(<EmployeeTimePage />);
    expect(await screen.findByRole('region', { name: 'Approved daily time' })).toHaveTextContent(
      '3h 30m',
    );
    expect(screen.getByText(/stored, approved numbers/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
    expect(mocks.selfEntries).not.toHaveBeenCalled();
  });
});

describe('My Time: Requests', () => {
  it('requests a clock-out change from the record’s current value and lets the employee pick a repeated time’s occurrence', async () => {
    goTo('?tab=requests&entry=entry-1');
    mocks.selfEntries.mockResolvedValue({
      items: [
        entry({ clockInAt: '2026-10-31T22:00:00.000Z', clockOutAt: '2026-11-01T04:00:00.000Z' }),
      ],
      nextAfterId: null,
    });
    mocks.requestCorrection
      .mockRejectedValueOnce(
        new AuthApiError('conflict', 409, 'Ambiguous local time', {
          code: 'TIME_LOCAL_TIME_AMBIGUOUS',
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
    render(<EmployeeTimePage />);
    const form = await screen.findByRole('form', { name: 'Request a correction' });
    // Deep-linked: the record is chosen and its recorded clock-out prefilled (local time).
    expect(within(form).getByLabelText('Attendance record')).toHaveValue('entry-1');
    expect(within(form).getByLabelText('What to correct')).toHaveValue('CHANGE_CLOCK_OUT');
    const clockOut = within(form).getByLabelText('Correct clock-out');
    expect(clockOut).toHaveValue('2026-11-01T00:00');
    expect(within(form).getByText(/Local time in America\/Toronto/)).toBeInTheDocument();
    // Every self-service type is offered for a closed record (never coverage changes).
    const kinds = within(form).getByLabelText('What to correct');
    expect(kinds).toHaveTextContent('Change the clock-in time');
    expect(kinds).toHaveTextContent('Add a break');
    expect(kinds).toHaveTextContent('Move the entry to another assignment');
    expect(kinds).not.toHaveTextContent('Add a missing clock-out');

    fireEvent.change(clockOut, { target: { value: '2026-11-01T01:30' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Left late' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Request correction' }));
    expect(
      await within(form).findByText(
        'This time occurs twice because the clocks moved back. Select the correct occurrence below.',
      ),
    ).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Request correction' })).toBeDisabled();
    fireEvent.click(within(form).getByLabelText('Second occurrence (UTC-05:00)'));
    fireEvent.click(within(form).getByRole('button', { name: 'Request correction' }));
    await waitFor(() =>
      expect(mocks.requestCorrection).toHaveBeenLastCalledWith({
        type: 'CHANGE_CLOCK_OUT',
        reason: 'Left late',
        timeEntryId: 'entry-1',
        clockOutAt: '2026-11-01T01:30-05:00',
      }),
    );
    expect(await within(form).findByText(/Correction requested/)).toBeInTheDocument();
  });

  it('requests a missing entry for an assignment', async () => {
    goTo('?tab=requests');
    mocks.requestCorrection.mockResolvedValue({});
    render(<EmployeeTimePage />);
    const form = await screen.findByRole('form', { name: 'Request a correction' });
    fireEvent.change(within(form).getByLabelText('What to correct'), {
      target: { value: 'ADD_MISSING_TIME_ENTRY' },
    });
    expect(within(form).queryByLabelText('Attendance record')).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Assignment'), {
      target: { value: 'assignment-2' },
    });
    fireEvent.change(within(form).getByLabelText('Started'), {
      target: { value: '2026-10-02T09:00' },
    });
    fireEvent.change(within(form).getByLabelText('Ended'), {
      target: { value: '2026-10-02T12:00' },
    });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Forgot' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Request correction' }));
    await waitFor(() =>
      expect(mocks.requestCorrection).toHaveBeenCalledWith({
        type: 'ADD_MISSING_TIME_ENTRY',
        reason: 'Forgot',
        employmentAssignmentId: 'assignment-2',
        startAt: '2026-10-02T09:00',
        endAt: '2026-10-02T12:00',
      }),
    );
  });

  it('explains when correction requests are not available', async () => {
    goTo('?tab=requests');
    mocks.status.mockResolvedValue(
      offClockStatus({
        assignmentCapabilities: [capability({ correctionRequestsEnabled: false })],
      }),
    );
    render(<EmployeeTimePage />);
    expect(
      await screen.findByText(/Correction requests are not available for your assignments/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Request a correction' })).not.toBeInTheDocument();
  });

  it('shows decisions with the reviewer’s name and note, cancels a pending request, and says what to do about exceptions', async () => {
    goTo('?tab=requests');
    mocks.selfCorrections.mockResolvedValue({
      corrections: [
        {
          id: 'c-1',
          employeeId: 'employee-1',
          requestorUserId: 'user-self',
          reviewerUserId: 'user-manager',
          timeEntryId: 'entry-1',
          breakEntryId: null,
          employmentAssignmentId: null,
          targetEmploymentAssignmentId: null,
          type: 'CHANGE_CLOCK_OUT',
          status: 'APPROVED',
          reason: 'Stayed later',
          reviewerNote: 'Confirmed',
          requestedValues: { clockOutAt: '2026-10-02T14:00' },
          currentValues: { clockOutAt: '2026-10-02T17:00:00.000Z' },
          requestedAt: '2026-10-03T12:00:00.000Z',
          reviewedAt: '2026-10-04T12:00:00.000Z',
          cancelledAt: null,
          adjustmentId: 'a-1',
          workDate: '2026-10-02',
          timezone: 'America/Toronto',
          assignment,
          actors: { 'user-self': 'Ada Lovelace', 'user-manager': 'Maya Patel' },
        },
        {
          id: 'c-2',
          employeeId: 'employee-1',
          requestorUserId: 'user-self',
          reviewerUserId: null,
          timeEntryId: 'entry-2',
          breakEntryId: null,
          employmentAssignmentId: null,
          targetEmploymentAssignmentId: null,
          type: 'CHANGE_CLOCK_IN',
          status: 'PENDING',
          reason: 'Arrived earlier',
          reviewerNote: null,
          requestedValues: { clockInAt: '2026-10-03T08:30' },
          currentValues: { clockInAt: '2026-10-03T13:00:00.000Z' },
          requestedAt: '2026-10-03T12:00:00.000Z',
          reviewedAt: null,
          cancelledAt: null,
          adjustmentId: null,
          workDate: '2026-10-03',
          timezone: 'America/Toronto',
          assignment,
          actors: {},
        },
      ],
      nextAfterId: null,
    });
    mocks.selfExceptions.mockResolvedValue({
      exceptions: [
        {
          id: 'x-1',
          type: 'LONG_SHIFT',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
          status: 'RESOLVED',
          timeEntryId: 'entry-1',
          employmentAssignmentId: 'assignment-1',
          detectedAt: '2026-10-03T00:00:00.000Z',
          resolvedAt: '2026-10-04T12:00:00.000Z',
          reason: null,
          workDate: '2026-10-02',
          timezone: 'America/Toronto',
          assignment,
          resolutionMethod: 'MANAGER_RESOLUTION',
          resolvedByUserId: 'user-manager',
          actors: { 'user-manager': 'Maya Patel' },
        },
        {
          id: 'x-2',
          type: 'NO_SHOW',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
          status: 'OPEN',
          timeEntryId: null,
          employmentAssignmentId: 'assignment-1',
          detectedAt: '2026-10-05T00:00:00.000Z',
          resolvedAt: null,
          reason: null,
          workDate: '2026-10-04',
          timezone: 'America/Toronto',
          assignment,
        },
      ],
      nextAfterId: null,
    });
    mocks.cancelCorrection.mockResolvedValue({});
    render(<EmployeeTimePage />);
    const requests = (
      await screen.findByRole('heading', { name: 'My correction requests' })
    ).closest('section')!;
    expect(await within(requests).findByText(/Approved by Maya Patel/)).toHaveTextContent(
      '“Confirmed”',
    );
    expect(requests).toHaveTextContent('Clock-out 2026-10-02 14:00');
    fireEvent.click(within(requests).getByRole('button', { name: /Cancel request/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel this request?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(mocks.cancelCorrection).toHaveBeenCalledWith('c-2'));

    const exceptions = screen.getByRole('heading', { name: 'Exceptions' }).closest('section')!;
    expect(await within(exceptions).findByText(/Maya Patel/)).toBeInTheDocument();
    expect(exceptions).toHaveTextContent('If you worked, request the missing entry');
  });
});

describe('My Time: Batch 4F', () => {
  const turnedOff = new AuthApiError('forbidden', 403, undefined, {
    code: 'FEATURE_DISABLED',
    module: 'ATTENDANCE',
  });

  it('explains calmly when attendance is turned off, and keeps the history readable', async () => {
    mocks.status.mockRejectedValue(turnedOff);
    render(<EmployeeTimePage />);
    expect(
      await screen.findByText('Time & attendance is turned off for your organization.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry|try again/i })).not.toBeInTheDocument();
  });

  it('marks records of an organization with attendance off read only and offers no action', async () => {
    goTo('?tab=history');
    mocks.selfEntries.mockResolvedValue({
      items: [entry(), entry({ id: 'entry-k', workDate: '2026-10-01', assignment: kitchen })],
      nextAfterId: null,
      attendanceDisabledOrganizationIds: ['org-2'],
    });
    render(<EmployeeTimePage />);
    const region = await screen.findByRole('region', { name: 'Attendance history' });
    const off = within(region).getByRole('row', { name: /10\/01\/2026/ });
    expect(off).toHaveTextContent('Attendance turned off — read only');
    expect(within(off).queryByRole('button')).not.toBeInTheDocument();
    const on = within(region).getByRole('row', { name: /10\/02\/2026/ });
    expect(on).not.toHaveTextContent('read only');
    expect(within(on).getByRole('button', { name: /Request a correction/ })).toBeInTheDocument();
  });

  it('never offers cancel on a request of an organization with attendance off', async () => {
    goTo('?tab=requests');
    mocks.selfCorrections.mockResolvedValue({
      corrections: [
        {
          id: 'correction-1',
          type: 'CHANGE_CLOCK_OUT',
          status: 'PENDING',
          reason: 'Forgot',
          workDate: '2026-10-01',
          assignment: kitchen,
          requestedValues: {},
          currentValues: {},
          timezone: 'America/Toronto',
        },
      ],
      nextAfterId: null,
      attendanceDisabledOrganizationIds: ['org-2'],
    });
    render(<EmployeeTimePage />);
    const heading = await screen.findByRole('heading', { name: 'My correction requests' });
    const section = heading.closest('section')!;
    expect(
      await within(section).findByText('Attendance turned off — read only'),
    ).toBeInTheDocument();
    expect(
      within(section).queryByRole('button', { name: /Cancel request/ }),
    ).not.toBeInTheDocument();
  });

  it('makes the occurrence choice explicit when the API requires it', async () => {
    const option = (id: string, start: string, end: string, signIn: unknown = null) => ({
      scheduledShiftId: id,
      employmentAssignmentId: 'assignment-1',
      workDate: '2027-03-02',
      startsAt: start,
      endsAt: end,
      timezone: 'America/Toronto',
      clockInOpensAt: start,
      clockInClosesAt: end,
      signIn,
    });
    const presence = (signInOptions: unknown[]) =>
      offClockStatus({
        eligibleAssignments: [],
        availableActions: ['SIGN_IN'],
        signInAssignments: [assignment],
        signInOptions,
        assignmentCapabilities: [capability({ trackingMode: 'SIGN_IN_ONLY' })],
      });
    mocks.status.mockResolvedValueOnce(presence([])).mockResolvedValue(
      presence([
        option('session-a', '2027-03-02T18:00:00.000Z', '2027-03-02T18:30:00.000Z', {
          id: 'sign-in-a',
          signedInAt: '2027-03-02T18:01:00.000Z',
        }),
        option('session-b', '2027-03-02T18:45:00.000Z', '2027-03-02T19:15:00.000Z'),
      ]),
    );
    mocks.signIn.mockRejectedValueOnce(
      new AuthApiError('conflict', 409, 'x', { code: 'ATTENDANCE_OCCURRENCE_CHOICE_REQUIRED' }),
    );
    render(<EmployeeTimePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in for Counsellor · Camp' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Several shifts are open now and one is already signed in. Choose the shift to sign in for.',
    );
    const sessions = await screen.findByRole('list', { name: 'Sessions open now for Counsellor' });
    const choice = within(sessions).getByRole('button', { name: 'Sign in for 13:45–14:15' });
    await waitFor(() => expect(choice).toHaveFocus());
    expect(screen.getByText('Choose the shift to sign in for:')).toBeInTheDocument();
  });

  it('marks sign-ins of an organization in attendanceDisabledOrganizationIds read only', async () => {
    goTo('?tab=history');
    mocks.status.mockResolvedValue(
      offClockStatus({
        assignmentCapabilities: [
          capability({ trackingMode: 'SIGN_IN_ONLY' }),
          capability({
            employmentAssignmentId: 'assignment-2',
            position: { id: 'position-1', name: 'Kitchen' },
            organization: { id: 'org-2', name: 'School' },
            trackingMode: 'SIGN_IN_ONLY',
          }),
        ],
      }),
    );
    const signIn = (id: string, assignmentId: string, positionName: string) => ({
      id,
      employmentAssignmentId: assignmentId,
      positionName,
      workDate: '2026-10-02',
      signedInAt: '2026-10-02T13:00:00.000Z',
      timezone: 'America/Toronto',
      source: 'KIOSK',
      status: 'ACTIVE',
      device: null,
      signOut: null,
      scheduledShiftId: null,
      replacesSignInId: null,
      voidReason: null,
      exceptions: [],
    });
    mocks.mySignIns.mockResolvedValue({
      items: [
        signIn('s-1', 'assignment-1', 'Counsellor'),
        signIn('s-2', 'assignment-2', 'Kitchen'),
      ],
      attendanceDisabledOrganizationIds: ['org-2'],
    });
    render(<EmployeeTimePage />);
    const heading = await screen.findByRole('heading', { name: 'Presence sign-ins' });
    const section = heading.closest('section')!;
    const kitchen = await within(section).findByText(/Kitchen · /);
    expect(kitchen.closest('li')).toHaveTextContent('Attendance turned off — read only');
    expect(
      within(section)
        .getByText(/Counsellor · /)
        .closest('li'),
    ).not.toHaveTextContent('read only');
  });
});
