import { describe, expect, it } from 'vitest';
import {
  approvedAbsenceOverlapsExpectedWork,
  type PayrollApprovedTimeOutput,
} from './time-integration.contracts.js';

describe('time integration contracts', () => {
  it('matches approved absences to expected work by interval and optional assignment', () => {
    const expected = {
      employmentAssignmentId: 'assignment-1',
      expectedStart: '2026-10-03T13:00:00.000Z',
      expectedEnd: '2026-10-03T21:00:00.000Z',
      sourceType: 'SCHEDULE' as const,
      sourceId: 'shift-1',
    };

    expect(
      approvedAbsenceOverlapsExpectedWork(expected, {
        employeeId: 'employee-1',
        employmentAssignmentId: 'assignment-1',
        start: '2026-10-03T15:00:00.000Z',
        end: '2026-10-03T17:00:00.000Z',
        classification: 'PAID',
        sourceId: 'leave-1',
      }),
    ).toBe(true);
    expect(
      approvedAbsenceOverlapsExpectedWork(expected, {
        employeeId: 'employee-1',
        employmentAssignmentId: 'assignment-2',
        start: '2026-10-03T15:00:00.000Z',
        end: '2026-10-03T17:00:00.000Z',
        sourceId: 'leave-2',
      }),
    ).toBe(false);
    expect(
      approvedAbsenceOverlapsExpectedWork(expected, {
        employeeId: 'employee-1',
        start: '2026-10-03T21:00:00.000Z',
        end: '2026-10-03T22:00:00.000Z',
        sourceId: 'leave-3',
      }),
    ).toBe(false);
  });

  it('keeps payroll-approved time output assignment-aware and money-free', () => {
    const output: PayrollApprovedTimeOutput = {
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      timePeriodId: 'period-1',
      workDate: '2026-10-03',
      approvedWorkedMinutes: 420,
      grossMinutes: 480,
      paidBreakMinutes: 15,
      unpaidBreakMinutes: 30,
      policyDeductionMinutes: 30,
      finalizationStatus: 'LOCKED',
      timesheetId: 'timesheet-1',
      timesheetSegmentId: 'segment-1',
      timesheetVersion: 2,
    };

    expect(output).toMatchObject({
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      workDate: '2026-10-03',
      finalizationStatus: 'LOCKED',
    });
    expect(Object.keys(output)).not.toEqual(
      expect.arrayContaining(['wage', 'rate', 'tax', 'amount']),
    );
  });
});
