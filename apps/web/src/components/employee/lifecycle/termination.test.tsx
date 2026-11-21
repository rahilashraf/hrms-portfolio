import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmployeeProfile,
  EmployeeTermination,
  EmployeeTerminationPreview,
} from '../../../lib/employee/types';
import { ApplyTerminationDialog, TerminationDialog, TerminationPreviewView } from './termination';

/**
 * Batch 5C pre-merge fixes: D1 (a later reschedule never shows the current, shortened end dates
 * or counts as if they were the proposal's) and D2 (each assignment is judged in its own time
 * zone; anything that ends immediately needs an explicit confirmation before any request).
 */

const mocks = vi.hoisted(() => ({
  terminationPreview: vi.fn(),
  terminate: vi.fn(),
  rescheduleTermination: vi.fn(),
  applyTermination: vi.fn(),
}));
vi.mock('../../../lib/employee/api', () => ({ employeeApi: mocks }));

// 20:00 UTC on Nov 4, 2026: still Nov 4 in Toronto, already Nov 5 in Kolkata.
const NOW = new Date('2026-11-04T20:00:00.000Z');

const profile: EmployeeProfile = {
  id: 'employee-1',
  employeeNumber: 'E-1',
  status: 'ACTIVE',
  hireDate: '2026-01-01',
  terminationDate: null,
  person: {
    firstName: 'Ada',
    middleName: null,
    lastName: 'Lovelace',
    preferredName: null,
    personalEmail: null,
    phone: null,
  },
  assignments: { current: [], upcoming: [], historical: [], cancelled: [] },
};

const row = (id: string, positionName: string, timezone: string, newEndDate: string) => ({
  employmentAssignmentId: id,
  positionName,
  organizationName: timezone === 'Asia/Kolkata' ? 'Mumbai Campus' : 'Toronto Campus',
  organizationId: `org-${id}`,
  timezone,
  status: 'ACTIVE' as const,
  startDate: '2026-01-01',
  endDate: null,
  action: 'END',
  newEndDate,
  effectiveFrom: newEndDate,
});

function preview(
  date: string,
  overrides: Partial<EmployeeTerminationPreview> = {},
): EmployeeTerminationPreview {
  return {
    employeeId: 'employee-1',
    terminationDate: date,
    scheduled: true,
    assignments: [
      row('toronto', 'Teacher', 'America/Toronto', date),
      row('kolkata', 'Counsellor', 'Asia/Kolkata', date),
    ],
    blockers: [],
    followUps: {
      openTimeEntries: 0,
      futurePublishedShifts: 4,
      pendingLeaveRequests: 1,
      approvedLeaveAfterTermination: 0,
      openBenefitEnrollments: 0,
      openPerformanceReviews: 0,
    },
    access: null,
    ...overrides,
  };
}

const scheduledTermination: EmployeeTermination = {
  id: 'term-1',
  employeeId: 'employee-1',
  terminationDate: '2027-06-30',
  status: 'SCHEDULED',
  reason: null,
  systemGrantsAcknowledged: false,
  recordedByUserId: 'u',
  recordedAt: '2026-11-01T12:00:00.000Z',
  appliedAt: null,
  appliedSource: null,
  cancelledAt: null,
  cancelledByUserId: null,
  supersededById: null,
  rehireAssignmentId: null,
  rehiredAt: null,
  assignments: [],
};

const result = {
  termination: scheduledTermination,
  employee: { id: 'employee-1', status: 'ACTIVE' as const, terminationDate: '2027-06-30' },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Only the clock is faked (the dialog's debounce still uses real timers).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.terminate.mockResolvedValue(result);
  mocks.rescheduleTermination.mockResolvedValue(result);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function openDialog(termination: EmployeeTermination | null = null) {
  const onDone = vi.fn();
  render(
    <TerminationDialog
      open
      profile={termination ? { ...profile, terminationDate: termination.terminationDate } : profile}
      termination={termination}
      onClose={vi.fn()}
      onDone={onDone}
    />,
  );
  return onDone;
}

const lastDay = () => screen.getByLabelText('Last day of employment');

describe('D2: mixed-time-zone confirmation', () => {
  it('Toronto/Kolkata, last day passed in Kolkata only: names the assignment, requires confirmation, sends nothing before it', async () => {
    mocks.terminationPreview.mockImplementation(async (_id: string, date: string) => preview(date));
    const onDone = openDialog();
    fireEvent.change(lastDay(), { target: { value: '2026-11-04' } });
    const section = await screen.findByRole('region', { name: 'Termination preview' });
    expect(section).toHaveTextContent(/Partly immediate: Nov 4, 2026 has already passed/);
    expect(section).not.toHaveTextContent('Nothing ends today');
    expect(
      within(section)
        .getByText(/Counsellor/)
        .closest('li'),
    ).toHaveTextContent('ends as soon as recorded');
    expect(
      within(section)
        .getByText(/Teacher/)
        .closest('li'),
    ).not.toHaveTextContent('ends as soon as recorded');
    const submit = screen.getByRole('button', { name: 'Record termination' });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(mocks.terminate).not.toHaveBeenCalled();
    const confirm = screen.getByLabelText(/I understand they end as soon as I confirm/);
    expect(confirm.closest('label')).toHaveTextContent('Counsellor (Mumbai Campus, Asia/Kolkata)');
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole('button', { name: 'Record termination' }));
    await waitFor(() =>
      expect(mocks.terminate).toHaveBeenCalledWith('employee-1', { terminationDate: '2026-11-04' }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it('a future date not yet due in either time zone is scheduled without a confirmation', async () => {
    mocks.terminationPreview.mockImplementation(async (_id: string, date: string) => preview(date));
    openDialog();
    fireEvent.change(lastDay(), { target: { value: '2026-11-20' } });
    expect(
      await screen.findByText(
        /Scheduled: the employee keeps working through Nov 20, 2026\. Nothing ends today\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/I understand/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule termination' }));
    await waitFor(() => expect(mocks.terminate).toHaveBeenCalledTimes(1));
  });

  it('a date passed everywhere is immediate and needs the confirmation', async () => {
    mocks.terminationPreview.mockImplementation(async (_id: string, date: string) =>
      preview(date, { scheduled: false }),
    );
    openDialog();
    fireEvent.change(lastDay(), { target: { value: '2026-11-01' } });
    expect(
      await screen.findByText(/Immediate: Nov 1, 2026 has already passed in every/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Terminate now' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Terminate now' }));
    expect(mocks.terminate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/I understand employment ends now/));
    fireEvent.click(screen.getByRole('button', { name: 'Terminate now' }));
    await waitFor(() => expect(mocks.terminate).toHaveBeenCalledTimes(1));
  });

  it('an unreadable time zone never yields "Nothing ends today" and asks for the confirmation', () => {
    render(
      <TerminationPreviewView
        now={NOW}
        preview={preview('2026-11-20', {
          assignments: [row('x', 'Clerk', 'Not/AZone', '2026-11-20')],
        })}
      />,
    );
    expect(screen.getByRole('region', { name: 'Termination preview' })).not.toHaveTextContent(
      'Nothing ends today',
    );
    expect(screen.getByText(/this device cannot confirm/)).toBeInTheDocument();
  });
});

describe('D1: rescheduling to a later last day', () => {
  // The scheduled termination already shortened both assignments to Jun 30; the preview for
  // Aug 31 is computed from those shortened end dates.
  const stale = (date: string) =>
    preview(date, {
      assignments: [
        row('toronto', 'Teacher', 'America/Toronto', '2027-06-30'),
        row('kolkata', 'Counsellor', 'Asia/Kolkata', '2027-06-30'),
      ],
      blockers:
        date === '2027-08-31'
          ? [
              {
                kind: 'APPROVED_TIMESHEET',
                employmentAssignmentId: 'toronto',
                periodStart: '2027-06-28',
                periodEnd: '2027-07-04',
              },
            ]
          : [],
    });

  it('Jun 30 → Aug 31: shows both last days, never the stale end dates, qualifies counts and blockers', async () => {
    mocks.terminationPreview.mockImplementation(async (_id: string, date: string) => stale(date));
    openDialog(scheduledTermination);
    fireEvent.change(lastDay(), { target: { value: '2027-08-31' } });
    const section = await screen.findByRole('region', { name: 'Termination preview' });
    await waitFor(() =>
      expect(section).toHaveTextContent('Last day moves from Jun 30, 2027 to Aug 31, 2027.'),
    );
    expect(section).not.toHaveTextContent('ends Jun 30, 2027');
    expect(within(section).getByRole('note')).toHaveTextContent(
      /restores each assignment's original end date and then applies the new last day/,
    );
    expect(section).toHaveTextContent(
      /Follow-up in other modules — counted for the current last day \(Jun 30, 2027\); they may change after rescheduling/,
    );
    // Blockers found for the old dates are advisory: the API checks again on reschedule.
    expect(within(section).getByRole('alert')).toHaveTextContent(
      'Finalized records found for the current last day',
    );
    const submit = screen.getByRole('button', { name: 'Reschedule termination' });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.rescheduleTermination).toHaveBeenCalledWith('employee-1', 'term-1', {
        terminationDate: '2027-08-31',
      }),
    );
  });

  it('an earlier last day previews normally (accurate end dates, blockers enforced)', async () => {
    mocks.terminationPreview.mockImplementation(async (_id: string, date: string) =>
      preview(date, {
        blockers: [
          {
            kind: 'FINALIZED_PAYROLL',
            employmentAssignmentId: 'toronto',
            payrollRunId: 'run-1',
            periodStart: '2027-05-01',
            periodEnd: '2027-05-31',
          },
        ],
      }),
    );
    openDialog(scheduledTermination);
    fireEvent.change(lastDay(), { target: { value: '2027-05-15' } });
    const section = await screen.findByRole('region', { name: 'Termination preview' });
    await waitFor(() => expect(section).toHaveTextContent('ends May 15, 2027'));
    expect(section).toHaveTextContent('Last day moves from Jun 30, 2027 to May 15, 2027.');
    expect(within(section).getByRole('alert')).toHaveTextContent(
      'This date is blocked by finalized records',
    );
    expect(screen.getByRole('button', { name: 'Reschedule termination' })).toBeDisabled();
    expect(mocks.rescheduleTermination).not.toHaveBeenCalled();
  });
});

describe('Batch 5E: open time entries when a termination takes effect', () => {
  it('an immediate termination warns that nobody is clocked out; a scheduled one only counts them', () => {
    const { rerender } = render(
      <TerminationPreviewView
        preview={preview('2026-11-01', {
          scheduled: false,
          followUps: { ...preview('2026-11-01').followUps, openTimeEntries: 2 },
        })}
        now={NOW}
      />,
    );
    const note = screen.getByRole('note', { name: '' });
    expect(note).toHaveTextContent('2 open time entries: the employee is still clocked in.');
    expect(note).toHaveTextContent(/does not clock anyone out/);
    rerender(
      <TerminationPreviewView
        preview={preview('2027-06-30', {
          followUps: { ...preview('2027-06-30').followUps, openTimeEntries: 2 },
        })}
        now={NOW}
      />,
    );
    expect(screen.queryByText(/still clocked in/)).not.toBeInTheDocument();
    expect(screen.getByText('2 open time entries')).toBeInTheDocument();
  });

  function openApply() {
    const onDone = vi.fn();
    render(
      <ApplyTerminationDialog
        open
        profile={profile}
        termination={{ ...scheduledTermination, terminationDate: '2026-11-01' }}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );
    return onDone;
  }

  it('Apply loads the preview for the scheduled date and warns about open entries before anything is applied', async () => {
    mocks.terminationPreview.mockResolvedValue(
      preview('2026-11-01', {
        scheduled: false,
        followUps: { ...preview('2026-11-01').followUps, openTimeEntries: 1 },
      }),
    );
    mocks.applyTermination.mockResolvedValue(result);
    const onDone = openApply();
    const dialog = screen.getByRole('dialog', { name: 'Apply the termination now?' });
    expect(within(dialog).getByText('Checking for open time entries…')).toBeInTheDocument();
    // Applying waits for the check (the result is announced in a live region).
    expect(within(dialog).getByRole('button', { name: 'Apply termination' })).toBeDisabled();
    expect(
      await within(dialog).findByText(/1 open time entry: the employee is still clocked in\./),
    ).toBeInTheDocument();
    expect(mocks.terminationPreview).toHaveBeenCalledWith('employee-1', '2026-11-01');
    expect(mocks.applyTermination).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply termination' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(result));
  });

  it('Apply says when there are none', async () => {
    mocks.terminationPreview.mockResolvedValue(preview('2026-11-01', { scheduled: false }));
    openApply();
    expect(await screen.findByText('No open time entries.')).toBeInTheDocument();
  });

  it('Apply never shows an unverified count as zero, and still allows applying', async () => {
    mocks.terminationPreview.mockRejectedValue(new Error('network'));
    mocks.applyTermination.mockResolvedValue(result);
    const onDone = openApply();
    expect(await screen.findByText(/Open time entries could not be checked/)).toBeInTheDocument();
    expect(screen.queryByText('No open time entries.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply termination' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
