import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../../lib/auth/types';
import type { TimeException } from '../../../lib/time/types';
import { expectNoAxeViolations } from '../../../test/axe';
import { ShiftChangeFacts } from './exception-review';

const mocks = vi.hoisted(() => ({ revisions: vi.fn() }));
vi.mock('../../../lib/scheduling/api', () => ({
  schedulingApi: { revisions: mocks.revisions },
}));
vi.mock('../../../lib/time/api', () => ({ timeApi: {} }));

function exception(
  metadata: Record<string, unknown>,
  overrides: Partial<TimeException> = {},
): TimeException {
  return {
    id: 'exc-1',
    type: 'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
    severity: 'REVIEW',
    workflowImpact: 'NON_BLOCKING',
    status: 'OPEN',
    timeEntryId: 'entry-1',
    employmentAssignmentId: 'asg-1',
    detectedAt: '2027-03-02T16:00:00.000Z',
    resolvedAt: null,
    reason: 'The scheduled shift was corrected after attendance was interpreted against it.',
    workDate: '2027-03-02',
    timezone: 'America/Toronto',
    changedShiftScheduleId: 'sched-1',
    metadata,
    ...overrides,
  };
}

const corrected = {
  scheduledShiftId: 'shift-1',
  interpretedRevisionNumber: 1,
  interpretedStartsAt: '2027-03-02T14:00:00.000Z',
  interpretedEndsAt: '2027-03-02T22:00:00.000Z',
  currentRevisionNumber: 2,
  currentStatus: 'ACTIVE',
  currentStartsAt: '2027-03-02T15:00:00.000Z',
  currentEndsAt: '2027-03-02T21:00:00.000Z',
  change: 'CORRECTED',
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('ShiftChangeFacts (R4-A.5)', () => {
  it('shows the original and current shift in the attendance time zone', async () => {
    const { container } = render(<ShiftChangeFacts exception={exception(corrected)} />);
    const section = screen.getByRole('region', { name: 'Shift change' });
    expect(section).toHaveTextContent('The shift was changed after attendance was recorded');
    expect(within(section).getByText('Original shift (revision 1)')).toBeInTheDocument();
    expect(within(section).getByText('Current shift (revision 2)')).toBeInTheDocument();
    // 14:00Z is 09:00 in Toronto; 15:00Z is 10:00.
    expect(section).toHaveTextContent('9:00 AM – Mar 2, 2027, 5:00 PM');
    expect(section).toHaveTextContent('10:00 AM – Mar 2, 2027, 4:00 PM');
    expect(section).toHaveTextContent('America/Toronto');
    expect(section).toHaveTextContent('The recorded punches are unchanged');
    await expectNoAxeViolations(container);
  });

  it('marks a cancelled shift as cancelled', () => {
    render(
      <ShiftChangeFacts
        exception={exception({ ...corrected, change: 'CANCELLED', currentStatus: 'CANCELLED' })}
      />,
    );
    const section = screen.getByRole('region', { name: 'Shift change' });
    expect(section).toHaveTextContent('The shift was cancelled after attendance was recorded');
    expect(within(section).getByText('Cancelled')).toBeInTheDocument();
  });

  it('says plainly when history is missing instead of guessing', () => {
    render(
      <ShiftChangeFacts
        exception={exception({ change: 'CORRECTED' }, { changedShiftScheduleId: null })}
      />,
    );
    const section = screen.getByRole('region', { name: 'Shift change' });
    expect(within(section).getAllByText('Not recorded')).toHaveLength(2);
    expect(within(section).getByText('Original shift')).toBeInTheDocument();
    // No schedule to open: no revisions button.
    expect(within(section).queryByRole('button')).not.toBeInTheDocument();
  });

  it('loads every revision on request, and explains a refusal', async () => {
    mocks.revisions.mockResolvedValueOnce({
      items: [
        {
          id: 'r1',
          revisionNumber: 1,
          revisionType: 'INITIAL',
          status: 'ACTIVE',
          startsAt: corrected.interpretedStartsAt,
          endsAt: corrected.interpretedEndsAt,
          timezone: 'America/Toronto',
          reason: null,
        },
        {
          id: 'r2',
          revisionNumber: 2,
          revisionType: 'CORRECTION',
          status: 'ACTIVE',
          startsAt: corrected.currentStartsAt,
          endsAt: corrected.currentEndsAt,
          timezone: 'America/Toronto',
          reason: 'Late opening',
        },
      ],
    });
    render(<ShiftChangeFacts exception={exception(corrected)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show all revisions' }));
    const list = await screen.findByRole('list', { name: 'Shift revisions' });
    expect(mocks.revisions).toHaveBeenCalledWith('sched-1', 'shift-1');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list).toHaveTextContent('Late opening');

    cleanup();
    mocks.revisions.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    render(<ShiftChangeFacts exception={exception(corrected)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show all revisions' }));
    expect(await screen.findByText(/permission|could not be loaded/i)).toBeInTheDocument();
  });
});
