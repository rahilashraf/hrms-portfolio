import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KioskApiError } from '../../lib/kiosk/api';
import { expectNoAxeViolations } from '../../test/axe';
import { KIOSK_IDLE_MS, KIOSK_IDLE_WARNING_MS, KIOSK_RESULT_MS, KioskApp } from './kiosk-app';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  enroll: vi.fn(),
  identify: vi.fn(),
  act: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../../lib/kiosk/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/kiosk/api')>()),
  kioskApi: mocks,
}));

const session = {
  device: { id: 'device-1', name: 'Front desk' },
  location: { name: 'Toronto', timezone: 'America/Toronto' },
  organization: { name: 'Camp' },
  interactionSeconds: 90,
};

const identification = {
  token: 'token-1',
  expiresInSeconds: 90,
  employee: { firstName: 'Ada' },
  state: 'OFF_CLOCK' as const,
  actions: [
    {
      action: 'SIGN_IN' as const,
      employmentAssignmentId: 'assignment-1',
      label: 'Sign in · Counsellor',
    },
  ],
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.session.mockResolvedValue(session);
  mocks.cancel.mockResolvedValue({ cancelled: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function enterCredentials(pin = '135790') {
  fireEvent.click(await screen.findByRole('button', { name: 'Tap to start' }));
  fireEvent.change(screen.getByLabelText('Employee number'), { target: { value: 'e-100' } });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  for (const digit of pin) fireEvent.click(screen.getByRole('button', { name: digit }));
}

describe('KioskApp', () => {
  it('asks an unenrolled device for its enrollment code', async () => {
    mocks.session.mockRejectedValue(new KioskApiError(401, 'KIOSK_DEVICE_UNAUTHENTICATED', 'No'));
    mocks.enroll.mockResolvedValue(session);
    render(<KioskApp />);

    fireEvent.change(await screen.findByLabelText('Enrollment code'), {
      target: { value: 'abcd-efgh' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enroll kiosk' }));

    await screen.findByRole('button', { name: 'Tap to start' });
    expect(mocks.enroll).toHaveBeenCalledWith('ABCD-EFGH');
    expect(screen.getByText('Camp · Toronto')).toBeInTheDocument();
  });

  it('identifies once on the sixth digit, offers only the server actions and records one', async () => {
    mocks.identify.mockResolvedValue(identification);
    mocks.act.mockResolvedValue({
      action: 'SIGN_IN',
      outcome: 'SIGNED_IN',
      occurredAt: '2026-10-05T13:02:00.000Z',
    });
    render(<KioskApp />);

    await enterCredentials();

    await screen.findByRole('heading', { name: 'Hello, Ada' });
    expect(mocks.identify).toHaveBeenCalledTimes(1);
    expect(mocks.identify).toHaveBeenCalledWith('E-100', '135790');
    expect(screen.queryByRole('button', { name: /clock/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in · Counsellor' }));

    await screen.findByRole('heading', { name: 'Signed in' });
    expect(mocks.act).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'token-1',
        action: 'SIGN_IN',
        employmentAssignmentId: 'assignment-1',
      }),
    );
    expect(mocks.act.mock.calls[0]?.[0].idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
    expect(screen.getByRole('status')).toHaveTextContent('Sign in · Counsellor — 9:02 AM');
  });

  it('keeps a single eligible assignment a one-tap clock-in', async () => {
    mocks.identify.mockResolvedValue({
      ...identification,
      actions: [
        { action: 'CLOCK_IN', employmentAssignmentId: 'teacher', label: 'Clock in — Teacher' },
      ],
    });
    mocks.act.mockResolvedValue({
      action: 'CLOCK_IN',
      outcome: 'RECORDED',
      occurredAt: '2026-10-05T13:00:00.000Z',
    });
    render(<KioskApp />);
    await enterCredentials();
    fireEvent.click(await screen.findByRole('button', { name: 'Clock in — Teacher' }));
    await screen.findByRole('heading', { name: 'Clocked in' });
    expect(mocks.act).toHaveBeenCalledWith(
      expect.not.objectContaining({ additionalEmploymentAssignmentIds: expect.anything() }),
    );
    expect(mocks.act.mock.calls[0]?.[0]).toMatchObject({
      action: 'CLOCK_IN',
      employmentAssignmentId: 'teacher',
    });
  });

  it('shows a flagged clock-in with generic wording only (R4-A.3)', async () => {
    mocks.identify.mockResolvedValue({
      ...identification,
      actions: [
        { action: 'CLOCK_IN', employmentAssignmentId: 'teacher', label: 'Clock in — Teacher' },
      ],
    });
    mocks.act.mockResolvedValue({
      action: 'CLOCK_IN',
      outcome: 'RECORDED',
      occurredAt: '2026-10-05T13:00:00.000Z',
      warnings: [{ code: 'UNSCHEDULED_WORK' }],
    });
    render(<KioskApp />);
    await enterCredentials();
    fireEvent.click(await screen.findByRole('button', { name: 'Clock in — Teacher' }));
    await screen.findByRole('heading', { name: 'Clocked in' });
    const flagged = screen.getByRole('list', { name: 'Flagged for review' });
    expect(flagged).toHaveTextContent(
      'No published shift matched this clock-in. It was recorded and flagged for review.',
    );
  });

  it('shows no flag list when the time clock flagged nothing', async () => {
    mocks.identify.mockResolvedValue({
      ...identification,
      actions: [
        { action: 'CLOCK_IN', employmentAssignmentId: 'teacher', label: 'Clock in — Teacher' },
      ],
    });
    mocks.act.mockResolvedValue({
      action: 'CLOCK_IN',
      outcome: 'RECORDED',
      occurredAt: '2026-10-05T13:00:00.000Z',
    });
    render(<KioskApp />);
    await enterCredentials();
    fireEvent.click(await screen.findByRole('button', { name: 'Clock in — Teacher' }));
    await screen.findByRole('heading', { name: 'Clocked in' });
    expect(screen.queryByRole('list', { name: 'Flagged for review' })).not.toBeInTheDocument();
  });

  it('offers one clock-in per open shift and sends the chosen shift', async () => {
    mocks.identify.mockResolvedValue({
      ...identification,
      actions: [
        {
          action: 'CLOCK_IN',
          employmentAssignmentId: 'teacher',
          scheduledShiftId: 'shift-morning',
          label: 'Clock in — Teacher · 08:00–09:30',
        },
        {
          action: 'CLOCK_IN',
          employmentAssignmentId: 'teacher',
          scheduledShiftId: 'shift-late',
          label: 'Clock in — Teacher · 09:45–12:00',
        },
      ],
    });
    mocks.act.mockResolvedValue({
      action: 'CLOCK_IN',
      outcome: 'RECORDED',
      occurredAt: '2026-10-05T13:00:00.000Z',
    });
    render(<KioskApp />);
    await enterCredentials();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Clock in — Teacher · 09:45–12:00' }),
    );
    await screen.findByRole('heading', { name: 'Clocked in' });
    expect(mocks.act.mock.calls[0]?.[0]).toMatchObject({
      action: 'CLOCK_IN',
      employmentAssignmentId: 'teacher',
      scheduledShiftId: 'shift-late',
    });
  });

  it('clocks in once for several assignments with one payroll assignment', async () => {
    mocks.identify.mockResolvedValue({
      ...identification,
      actions: [
        { action: 'CLOCK_IN', employmentAssignmentId: 'teacher', label: 'Clock in — Teacher' },
        { action: 'CLOCK_IN', employmentAssignmentId: 'tutoring', label: 'Clock in — Tutoring' },
        {
          action: 'CLOCK_IN',
          employmentAssignmentId: null,
          coverableAssignments: [
            { employmentAssignmentId: 'teacher', name: 'Teacher' },
            { employmentAssignmentId: 'tutoring', name: 'Tutoring' },
          ],
          label: 'Clock in — several assignments',
        },
      ],
    });
    mocks.act.mockResolvedValue({
      action: 'CLOCK_IN',
      outcome: 'RECORDED',
      occurredAt: '2026-10-05T13:00:00.000Z',
    });
    render(<KioskApp />);
    await enterCredentials();
    // The one-tap options stay available next to the several-assignments option.
    expect(await screen.findByRole('button', { name: 'Clock in — Teacher' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clock in — several assignments' }));

    expect(screen.getByRole('button', { name: 'Choose at least two assignments' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Teacher' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tutoring' }));
    // Two assignments alone are not enough: nothing is paid by default.
    expect(screen.getByRole('radio', { name: 'Teacher' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Tutoring' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Choose the paid assignment' })).toBeDisabled();
    // An explicit payroll choice enables clocking in.
    fireEvent.click(screen.getByRole('radio', { name: 'Tutoring' }));
    expect(screen.getByRole('button', { name: 'Clock in' })).toBeEnabled();
    // Unchecking the paid assignment clears the choice; re-adding it does not restore it.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tutoring' }));
    expect(screen.getByRole('button', { name: 'Choose at least two assignments' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tutoring' }));
    expect(screen.getByRole('radio', { name: 'Tutoring' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Choose the paid assignment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Tutoring' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clock in' }));

    await screen.findByRole('heading', { name: 'Clocked in' });
    expect(mocks.act).toHaveBeenCalledTimes(1);
    expect(mocks.act.mock.calls[0]?.[0]).toMatchObject({
      token: 'token-1',
      action: 'CLOCK_IN',
      employmentAssignmentId: 'tutoring',
      additionalEmploymentAssignmentIds: ['teacher'],
    });
    expect(mocks.act.mock.calls[0]?.[0]).not.toHaveProperty('scheduledShiftId');
    expect(screen.getByRole('status')).toHaveTextContent('Clock in — Teacher + Tutoring');
  });

  it('asks which shift starts when the paid assignment of a multi-assignment clock-in has several open', async () => {
    mocks.identify.mockResolvedValue({
      ...identification,
      actions: [
        {
          action: 'CLOCK_IN',
          employmentAssignmentId: null,
          coverableAssignments: [
            {
              employmentAssignmentId: 'teacher',
              name: 'Teacher',
              shifts: [
                { scheduledShiftId: 'shift-early', label: '08:00–09:30' },
                { scheduledShiftId: 'shift-late', label: '09:45–12:00' },
              ],
            },
            { employmentAssignmentId: 'tutoring', name: 'Tutoring' },
          ],
          label: 'Clock in — several assignments',
        },
      ],
    });
    mocks.act.mockResolvedValue({
      action: 'CLOCK_IN',
      outcome: 'RECORDED',
      occurredAt: '2026-10-05T13:00:00.000Z',
    });
    render(<KioskApp />);
    await enterCredentials();
    fireEvent.click(await screen.findByRole('button', { name: 'Clock in — several assignments' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Teacher' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tutoring' }));

    // Paid as Tutoring (one or no open shift): no shift question.
    fireEvent.click(screen.getByRole('radio', { name: 'Tutoring' }));
    expect(screen.queryByRole('radio', { name: '08:00–09:30' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clock in' })).toBeEnabled();

    // Paid as Teacher: its shift must be chosen, never guessed.
    fireEvent.click(screen.getByRole('radio', { name: 'Teacher' }));
    expect(
      screen.getByRole('group', { name: 'Which Teacher shift are you starting?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Choose the shift you are starting' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: '09:45–12:00' }));
    // Changing the paid assignment clears the shift choice.
    fireEvent.click(screen.getByRole('radio', { name: 'Tutoring' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Teacher' }));
    expect(screen.getByRole('radio', { name: '09:45–12:00' })).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Choose the shift you are starting' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: '09:45–12:00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clock in' }));

    await screen.findByRole('heading', { name: 'Clocked in' });
    expect(mocks.act).toHaveBeenCalledTimes(1);
    expect(mocks.act.mock.calls[0]?.[0]).toMatchObject({
      action: 'CLOCK_IN',
      employmentAssignmentId: 'teacher',
      additionalEmploymentAssignmentIds: ['tutoring'],
      scheduledShiftId: 'shift-late',
    });
  });

  it('returns from the coverage screen to welcome after inactivity, cancelling the interaction', async () => {
    vi.useFakeTimers();
    const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
    mocks.identify.mockResolvedValue({
      ...identification,
      actions: [
        { action: 'CLOCK_IN', employmentAssignmentId: 'teacher', label: 'Clock in — Teacher' },
        { action: 'CLOCK_IN', employmentAssignmentId: 'tutoring', label: 'Clock in — Tutoring' },
        {
          action: 'CLOCK_IN',
          employmentAssignmentId: null,
          coverableAssignments: [
            { employmentAssignmentId: 'teacher', name: 'Teacher' },
            { employmentAssignmentId: 'tutoring', name: 'Tutoring' },
          ],
          label: 'Clock in — several assignments',
        },
      ],
    });
    render(<KioskApp />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Tap to start' }));
    fireEvent.change(screen.getByLabelText('Employee number'), { target: { value: 'e-100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    for (const digit of '135790') fireEvent.click(screen.getByRole('button', { name: digit }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Clock in — several assignments' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Teacher' }));
    expect(
      screen.getByRole('heading', { name: 'Clock in — several assignments' }),
    ).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(KIOSK_IDLE_MS - 1));
    expect(
      screen.getByRole('heading', { name: 'Clock in — several assignments' }),
    ).toBeInTheDocument();
    expect(mocks.cancel).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole('button', { name: 'Tap to start' })).toBeInTheDocument();
    expect(mocks.cancel).toHaveBeenCalledWith('token-1');
    expect(mocks.act).not.toHaveBeenCalled();
  });

  it('offers a sign-out when the server allows it and reports a repeated one as already recorded', async () => {
    mocks.identify.mockResolvedValue({
      ...identification,
      actions: [
        {
          action: 'SIGN_OUT' as const,
          employmentAssignmentId: 'assignment-1',
          label: 'Sign out — Counsellor',
        },
      ],
    });
    mocks.act.mockResolvedValueOnce({
      action: 'SIGN_OUT',
      outcome: 'SIGNED_OUT',
      occurredAt: '2026-10-05T21:30:00.000Z',
    });
    render(<KioskApp />);
    await enterCredentials();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out — Counsellor' }));
    await screen.findByRole('heading', { name: 'Signed out' });
    expect(mocks.act).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SIGN_OUT', employmentAssignmentId: 'assignment-1' }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Sign out — Counsellor — 5:30 PM');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    mocks.act.mockResolvedValueOnce({
      action: 'SIGN_OUT',
      outcome: 'ALREADY_SIGNED_OUT',
      occurredAt: '2026-10-05T21:30:00.000Z',
    });
    await enterCredentials();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out — Counsellor' }));
    await screen.findByRole('heading', { name: 'Already signed out' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your sign-out at 5:30 PM is already recorded.',
    );
  });

  it('clears the result screen by itself', async () => {
    vi.useFakeTimers();
    const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
    mocks.identify.mockResolvedValue(identification);
    mocks.act.mockResolvedValue({
      action: 'SIGN_IN',
      outcome: 'ALREADY_SIGNED_IN',
      occurredAt: '2026-10-05T13:02:00.000Z',
    });
    render(<KioskApp />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Tap to start' }));
    fireEvent.change(screen.getByLabelText('Employee number'), { target: { value: 'e-100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    for (const digit of '135790') fireEvent.click(screen.getByRole('button', { name: digit }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in · Counsellor' }));
    await flush();
    expect(screen.getByRole('heading', { name: 'Already signed in' })).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(KIOSK_RESULT_MS - 1));
    expect(screen.getByRole('heading', { name: 'Already signed in' })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole('button', { name: 'Tap to start' })).toBeInTheDocument();
    // The token was consumed by the action; nothing left to cancel.
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it('answers a failed identification generically and returns to the number screen', async () => {
    mocks.identify.mockRejectedValue(
      new KioskApiError(
        401,
        'KIOSK_IDENTIFICATION_FAILED',
        'Employee number or PIN not recognized.',
      ),
    );
    render(<KioskApp />);

    await enterCredentials();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Employee number or PIN not recognized.',
    );
    expect(screen.getByLabelText('Employee number')).toBeInTheDocument();
  });

  it('cancels the interaction when the employee walks away from the actions', async () => {
    mocks.identify.mockResolvedValue(identification);
    render(<KioskApp />);
    await enterCredentials();
    await screen.findByRole('heading', { name: 'Hello, Ada' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('token-1'));
    expect(screen.getByRole('button', { name: 'Tap to start' })).toBeInTheDocument();
  });

  it('explains why there is nothing to record, with a reference for the manager', async () => {
    mocks.identify.mockResolvedValue({
      ...identification,
      actions: [],
      notice: {
        code: 'CLOCK_DISABLED',
        message: 'Clocking in is not turned on for your position yet.',
      },
    });
    render(<KioskApp />);
    await enterCredentials();
    await screen.findByRole('heading', { name: 'Hello, Ada' });
    expect(
      screen.getByText('Clocking in is not turned on for your position yet.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Reference: CLOCK_DISABLED')).toBeInTheDocument();
    expect(screen.queryByText(/There is nothing to record/)).not.toBeInTheDocument();
  });

  it('shows a missed clock-out notice alongside the available actions', async () => {
    mocks.identify.mockResolvedValue({
      ...identification,
      notice: { code: 'MISSED_CLOCK_OUT', message: 'An earlier shift is missing its clock-out.' },
    });
    render(<KioskApp />);
    await enterCredentials();
    await screen.findByRole('heading', { name: 'Hello, Ada' });
    expect(screen.getByText('An earlier shift is missing its clock-out.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in · Counsellor' })).toBeInTheDocument();
  });

  it('shows a disabled kiosk as unavailable', async () => {
    mocks.identify.mockRejectedValue(new KioskApiError(403, 'KIOSK_DEVICE_INACTIVE', 'Disabled'));
    render(<KioskApp />);

    await enterCredentials();

    expect(await screen.findByRole('heading', { name: 'Kiosk unavailable' })).toBeInTheDocument();
  });

  it('takes the PIN from a physical keyboard and says how many digits are entered', async () => {
    mocks.identify.mockResolvedValue(identification);
    const { container } = render(<KioskApp />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tap to start' }));
    fireEvent.change(screen.getByLabelText('Employee number'), { target: { value: 'e-100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    const field = screen.getByLabelText('Attendance PIN');
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('inputmode', 'numeric');
    expect(screen.getByText('0 of 6 digits entered')).toBeInTheDocument();
    await expectNoAxeViolations(container);

    // Only digits are kept; Backspace (a shorter value) removes one; the keypad adds to it.
    fireEvent.change(field, { target: { value: '13a5' } });
    expect(field).toHaveValue('135');
    expect(screen.getByText('3 of 6 digits entered')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: '13' } });
    expect(screen.getByText('2 of 6 digits entered')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '5' }));
    expect(field).toHaveValue('135');
    expect(mocks.identify).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: '135790' } });
    await screen.findByRole('heading', { name: 'Hello, Ada' });
    expect(mocks.identify).toHaveBeenCalledTimes(1);
    expect(mocks.identify).toHaveBeenCalledWith('E-100', '135790');
  });

  it('moves focus to the heading of each new screen', async () => {
    mocks.identify.mockResolvedValue(identification);
    render(<KioskApp />);
    // Batch 10F: the heading renders before the effect that focuses it; wait for the focus itself
    // (the intermittent full-suite failure was this race, not missing focus).
    const attendance = await screen.findByRole('heading', { name: 'Attendance' });
    await waitFor(() => expect(attendance).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Tap to start' }));
    // A screen with a primary field focuses the field instead.
    expect(screen.getByLabelText('Employee number')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('Employee number'), { target: { value: 'e-100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    for (const digit of '135790') fireEvent.click(screen.getByRole('button', { name: digit }));
    const hello = await screen.findByRole('heading', { name: 'Hello, Ada' });
    await waitFor(() => expect(hello).toHaveFocus());
  });

  it('warns before the idle reset, continues on request and still resets when ignored', async () => {
    vi.useFakeTimers();
    const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
    render(<KioskApp />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Tap to start' }));
    const number = screen.getByLabelText('Employee number');

    await act(() => vi.advanceTimersByTimeAsync(KIOSK_IDLE_MS - KIOSK_IDLE_WARNING_MS - 1));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1));
    const warning = screen.getByRole('alertdialog', { name: 'Still there?' });
    expect(warning).toHaveTextContent('Resetting in 10 seconds');
    const resume = screen.getByRole('button', { name: 'Continue' });
    expect(resume).toHaveFocus();
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(warning).toHaveTextContent('Resetting in 7 seconds');

    // Continue starts the full wait again and returns focus to the field.
    fireEvent.click(resume);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(number).toHaveFocus();
    await act(() => vi.advanceTimersByTimeAsync(KIOSK_IDLE_MS - KIOSK_IDLE_WARNING_MS - 1));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    // Typing counts as activity too.
    fireEvent.keyDown(number, { key: '1' });
    await act(() => vi.advanceTimersByTimeAsync(KIOSK_IDLE_MS - KIOSK_IDLE_WARNING_MS - 1));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Employee number' })).toBeInTheDocument();

    // Ignored, the warning gives way to the reset.
    await act(() => vi.advanceTimersByTimeAsync(KIOSK_IDLE_WARNING_MS + 1));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tap to start' })).toBeInTheDocument();
  });
});
