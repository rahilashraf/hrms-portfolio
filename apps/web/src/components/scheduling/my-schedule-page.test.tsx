import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { MySchedulePage, scheduleRange } from './my-schedule-page';

const mocks = vi.hoisted(() => ({ mySchedule: vi.fn(), expectedAttendance: vi.fn() }));
vi.mock('../../lib/scheduling/api', () => ({ schedulingApi: mocks }));
vi.mock('../../lib/time/api', () => ({ timeApi: mocks }));

const TODAY = new Date(2026, 9, 8); // Thursday 8 October 2026

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.expectedAttendance.mockResolvedValue({ from: '', to: '', items: [] });
});
afterEach(cleanup);

const shift = {
  id: 'shift-1',
  schedule: { id: 's1', name: 'October' },
  assignment: {
    id: 'a1',
    isPrimary: true,
    position: { id: 'p1', name: 'Lifeguard', code: 'LG' },
    organization: { id: 'o1', name: 'Aquatics' },
  },
  workLocation: { id: 'w1', name: 'Main pool', code: 'MP', timezone: 'UTC' },
  workDate: '2026-10-06',
  startsAt: '2026-10-06T09:00:00.000Z',
  endsAt: '2026-10-06T13:30:00.000Z',
  timezone: 'UTC',
  durationMinutes: 270,
  status: 'ACTIVE',
};

describe('MySchedulePage', () => {
  it('computes a two-week inclusive range', () => {
    expect(scheduleRange(new Date(2026, 9, 5))).toEqual({ from: '2026-10-05', to: '2026-10-18' });
  });

  it('shows own published shifts from Monday of this week and pages by week', async () => {
    mocks.mySchedule.mockResolvedValue({
      employeeId: 'e1',
      range: { from: '2026-10-05', to: '2026-10-18' },
      items: [shift],
    });
    render(<MySchedulePage today={TODAY} />);

    expect(await screen.findByText('Lifeguard · Main pool · Aquatics')).toBeInTheDocument();
    expect(screen.getByText('(4h 30m)')).toBeInTheDocument();
    expect(mocks.mySchedule).toHaveBeenCalledWith('2026-10-05', '2026-10-18', false);

    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await waitFor(() =>
      expect(mocks.mySchedule).toHaveBeenLastCalledWith('2026-10-12', '2026-10-25', false),
    );
    // "This week" returns to the page's own today (not the machine's clock).
    fireEvent.click(screen.getByRole('button', { name: 'This week' }));
    await waitFor(() =>
      expect(mocks.mySchedule).toHaveBeenLastCalledWith('2026-10-05', '2026-10-18', false),
    );
  });

  it('marks holidays of the employee’s own organizations, also on days without shifts (R4-A.6)', async () => {
    mocks.mySchedule.mockResolvedValue({
      employeeId: 'e1',
      range: { from: '2026-10-05', to: '2026-10-18' },
      holidays: [
        {
          date: '2026-10-06',
          name: 'Founders Day',
          kind: 'STATUTORY_HOLIDAY',
          organizationId: 'o1',
        },
        {
          date: '2026-10-12',
          name: 'Thanksgiving',
          kind: 'STATUTORY_HOLIDAY',
          organizationId: 'o1',
        },
      ],
      items: [shift],
    });
    render(<MySchedulePage today={TODAY} />);
    const list = await screen.findByRole('region', { name: 'Holidays in these two weeks' });
    expect(list).toHaveTextContent('Holiday: Founders Day');
    expect(list).toHaveTextContent('Holiday: Thanksgiving');
    // On the day with a shift, the marker sits with the shift; one organization: no name.
    const day = screen.getByRole('region', { name: 'Oct 6, 2026' });
    expect(day).toHaveTextContent('Holiday: Founders Day');
    expect(day).not.toHaveTextContent('(Aquatics)');
    // The shift is shown as usual.
    expect(day).toHaveTextContent('Lifeguard · Main pool · Aquatics');
  });

  it('names the organization when holidays come from several', async () => {
    const second = {
      ...shift,
      id: 'shift-2',
      workDate: '2026-10-07',
      assignment: { ...shift.assignment, id: 'a2', organization: { id: 'o2', name: 'Day Camp' } },
    };
    mocks.mySchedule.mockResolvedValue({
      employeeId: 'e1',
      range: { from: '2026-10-05', to: '2026-10-18' },
      holidays: [
        {
          date: '2026-10-12',
          name: 'Thanksgiving',
          kind: 'STATUTORY_HOLIDAY',
          organizationId: 'o1',
        },
        { date: '2026-10-12', name: 'Camp closed', kind: 'CLOSURE', organizationId: 'o2' },
      ],
      items: [shift, second],
    });
    render(<MySchedulePage today={TODAY} />);
    const list = await screen.findByRole('region', { name: 'Holidays in these two weeks' });
    expect(list).toHaveTextContent('Holiday: Thanksgiving (Aquatics)');
    expect(list).toHaveTextContent('Closure: Camp closed (Day Camp)');
  });

  it('shows what attendance recorded for each shift, links to it, and lists cancelled shifts on request (Batch 4E-3)', async () => {
    mocks.mySchedule.mockResolvedValue({
      employeeId: 'e1',
      range: { from: '2026-10-05', to: '2026-10-18' },
      items: [shift],
    });
    mocks.expectedAttendance.mockResolvedValue({
      from: '2026-10-05',
      to: '2026-10-18',
      items: [
        {
          scheduledShiftId: 'shift-1',
          workDate: '2026-10-06',
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          timezone: 'UTC',
          status: 'LATE',
        },
      ],
    });
    render(<MySchedulePage today={TODAY} />);
    expect(await screen.findByText('Late')).toBeInTheDocument();
    expect(mocks.expectedAttendance).toHaveBeenCalledWith({ from: '2026-10-05', to: '2026-10-18' });
    expect(screen.getByRole('link', { name: /View attendance for/ })).toHaveAttribute(
      'href',
      '/time?tab=history&date=2026-10-06',
    );
    expect(screen.getByRole('link', { name: 'My Time' })).toHaveAttribute('href', '/time');

    mocks.mySchedule.mockResolvedValue({
      employeeId: 'e1',
      range: { from: '2026-10-05', to: '2026-10-18' },
      items: [{ ...shift, id: 'shift-2', status: 'CANCELLED' }],
    });
    fireEvent.click(screen.getByLabelText('Show cancelled shifts'));
    await waitFor(() =>
      expect(mocks.mySchedule).toHaveBeenLastCalledWith('2026-10-05', '2026-10-18', true),
    );
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });

  it('shows the schedule without attendance when Time & attendance is not available', async () => {
    mocks.mySchedule.mockResolvedValue({
      employeeId: 'e1',
      range: { from: '2026-10-05', to: '2026-10-18' },
      items: [shift],
    });
    mocks.expectedAttendance.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, {
        code: 'FEATURE_DISABLED',
        module: 'ATTENDANCE',
      }),
    );
    render(<MySchedulePage today={TODAY} />);
    expect(await screen.findByText('Lifeguard · Main pool · Aquatics')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /attendance for/ })).not.toBeInTheDocument();
  });

  it('explains an account without an employee record', async () => {
    mocks.mySchedule.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<MySchedulePage today={TODAY} />);
    expect(await screen.findByText(/not linked to an employee record/)).toBeInTheDocument();
  });

  it('explains Scheduling turned off rather than a missing employee', async () => {
    mocks.mySchedule.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, {
        code: 'FEATURE_DISABLED',
        module: 'SCHEDULING',
      }),
    );
    render(<MySchedulePage today={TODAY} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/turned off/);
  });

  it('offers nothing to record where attendance is turned off, and says it is read only', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const now = new Date();
    const todays = { ...shift, workDate: today, startsAt: `${today}T09:00:00.000Z` };
    mocks.mySchedule.mockResolvedValue({
      employeeId: 'e1',
      range: { from: today, to: today },
      items: [
        todays,
        {
          ...todays,
          id: 'shift-2',
          assignment: { ...shift.assignment, organization: { id: 'o2', name: 'Harbor' } },
        },
      ],
    });
    const expected = (id: string, organizationId: string) => ({
      scheduledShiftId: id,
      organization: { id: organizationId, name: 'x' },
      workDate: today,
      timezone: 'UTC',
      status: 'DUE',
    });
    mocks.expectedAttendance.mockResolvedValue({
      from: today,
      to: today,
      items: [expected('shift-1', 'o1'), expected('shift-2', 'o2')],
      attendanceDisabledOrganizationIds: ['o2'],
    });
    render(<MySchedulePage today={now} />);
    expect(await screen.findByText('Attendance turned off — read only')).toBeInTheDocument();
    // Only the organization with attendance on offers recording.
    expect(screen.getAllByRole('link', { name: /Record attendance/ })).toHaveLength(1);
    expect(screen.getByText('Lifeguard · Main pool · Harbor').closest('li')).not.toHaveTextContent(
      'Record attendance',
    );
  });
});
