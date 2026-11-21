import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimeEntryRead } from '../../lib/time/types';
import { DailyTimeTable } from './timesheet-parts';

afterEach(cleanup);

const assignment = {
  id: 'assignment-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-01',
  endDate: null,
  isPrimary: true,
  position: { id: 'position-1', name: 'Counsellor', code: 'COUN' },
  jobTitle: { id: 'job-1', name: 'Counsellor', code: 'COUN' },
  organization: { id: 'org-1', name: 'Camp', code: 'CAMP' },
  placement: null,
  workLocation: null,
  manager: null,
} as unknown as TimeEntryRead['assignment'];

function entry(id: string, overrides: Partial<TimeEntryRead>): TimeEntryRead {
  return {
    id,
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
    grossMinutes: 0,
    paidBreakMinutes: 0,
    unpaidBreakMinutes: 0,
    breakMinutes: 0,
    netWorkedMinutes: 0,
    policyDeductionMinutes: 0,
    payableMinutes: 0,
    exceptions: [],
    corrections: [],
    ...overrides,
  };
}

describe('DailyTimeTable (Batch 4E-3 review fix)', () => {
  it('lists voided entries, labelled, but counts only valid entries in the day total', () => {
    const onCorrect = vi.fn();
    render(
      <DailyTimeTable
        onCorrect={onCorrect}
        entries={[
          entry('valid-morning', {
            clockInAt: '2026-10-02T12:00:00.000Z',
            clockOutAt: '2026-10-02T16:00:00.000Z',
            grossMinutes: 240,
            paidBreakMinutes: 15,
            unpaidBreakMinutes: 30,
            policyDeductionMinutes: 30,
            payableMinutes: 180,
          }),
          // Voided on the same day: every one of its minutes must stay out of the total.
          entry('voided', {
            clockInAt: '2026-10-02T16:30:00.000Z',
            clockOutAt: '2026-10-02T23:30:00.000Z',
            status: 'VOIDED',
            grossMinutes: 420,
            paidBreakMinutes: 10,
            unpaidBreakMinutes: 45,
            policyDeductionMinutes: 20,
            payableMinutes: 355,
          }),
          entry('valid-evening', {
            clockInAt: '2026-10-03T00:00:00.000Z',
            clockOutAt: '2026-10-03T02:00:00.000Z',
            grossMinutes: 120,
            payableMinutes: 120,
          }),
        ]}
      />,
    );
    const table = screen.getByRole('region', { name: 'Daily time' });
    const voided = within(table)
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('Voided · not counted'))!;
    expect(voided).toBeDefined();
    expect(voided).toHaveTextContent('7h');
    // A voided entry is not offered for correction.
    expect(within(voided).queryByRole('button')).not.toBeInTheDocument();

    const total = within(table)
      .getAllByRole('row')
      .find((row) => row.textContent?.startsWith('Day total'))!;
    const cells = within(total)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    // Gross 240 + 120, paid 15, unpaid 30, deduction 30, payable 180 + 120.
    expect(cells.slice(1, 6)).toEqual(['6h', '15m', '30m', '30m', '5h']);
  });

  it('shows a day of voided entries only with zero totals', () => {
    render(
      <DailyTimeTable
        entries={[entry('voided', { status: 'VOIDED', grossMinutes: 240, payableMinutes: 210 })]}
      />,
    );
    const total = screen
      .getAllByRole('row')
      .find((row) => row.textContent?.startsWith('Day total'))!;
    expect(
      within(total)
        .getAllByRole('cell')
        .slice(1, 6)
        .map((cell) => cell.textContent),
    ).toEqual(['0m', '0m', '0m', '0m', '0m']);
  });
});
