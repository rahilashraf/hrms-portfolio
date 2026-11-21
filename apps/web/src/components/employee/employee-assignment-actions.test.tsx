import { describe, expect, it } from 'vitest';
import { assignmentActionAvailability } from './employee-assignment-actions';
import type { EmployeeAssignmentView } from '../../lib/employee/types';

const assignment: EmployeeAssignmentView = {
  id: 'assignment-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-10-02',
  endDate: null,
  isPrimary: false,
  position: { id: 'position-1', name: 'Platform Engineer', code: 'PE-1' },
  jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  placement: null,
  workLocation: null,
  manager: null,
};

describe('assignmentActionAvailability', () => {
  it('implements the approved lifecycle matrix', () => {
    expect(
      assignmentActionAvailability(
        { ...assignment, status: 'PLANNED', startDate: '2026-10-03' },
        '2026-10-02',
      ),
    ).toEqual({
      correct: true,
      end: false,
      cancel: true,
      primary: true,
      activate: false,
    });
    expect(
      assignmentActionAvailability(
        { ...assignment, status: 'PLANNED', startDate: '2026-10-02' },
        '2026-10-02',
      ),
    ).toEqual({
      correct: true,
      end: true,
      cancel: false,
      primary: true,
      activate: true,
    });
    expect(assignmentActionAvailability({ ...assignment, status: 'ACTIVE' }, '2026-10-02')).toEqual(
      {
        correct: true,
        end: true,
        cancel: false,
        primary: true,
        activate: false,
      },
    );
    expect(assignmentActionAvailability({ ...assignment, status: 'ENDED' }, '2026-10-02')).toEqual({
      correct: true,
      end: false,
      cancel: false,
      primary: false,
      activate: false,
    });
    expect(
      assignmentActionAvailability({ ...assignment, status: 'CANCELLED' }, '2026-10-02'),
    ).toEqual({
      correct: false,
      end: false,
      cancel: false,
      primary: false,
      activate: false,
    });
  });

  it('offers activation only for started, unexpired planned assignments of active employees', () => {
    const planned = { ...assignment, status: 'PLANNED' as const, startDate: '2026-09-01' };
    expect(assignmentActionAvailability(planned, '2026-10-07').activate).toBe(true);
    expect(
      assignmentActionAvailability({ ...planned, endDate: '2026-10-07' }, '2026-10-07').activate,
    ).toBe(true);
    expect(
      assignmentActionAvailability({ ...planned, endDate: '2026-10-06' }, '2026-10-07').activate,
    ).toBe(false);
    expect(
      assignmentActionAvailability({ ...planned, startDate: '2026-10-08' }, '2026-10-07').activate,
    ).toBe(false);
    expect(assignmentActionAvailability(planned, '2026-10-07', false).activate).toBe(false);
  });
});
