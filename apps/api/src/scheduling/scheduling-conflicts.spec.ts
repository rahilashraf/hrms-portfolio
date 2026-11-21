import { describe, expect, it } from 'vitest';
import {
  SchedulingDomainService,
  type ShiftConflictCandidate,
  type ShiftConflictSubject,
} from './scheduling-domain.service.js';

describe('SchedulingDomainService conflict detection', () => {
  const service = new SchedulingDomainService();
  const at = (hhmm: string, day = '2026-10-06') =>
    new Date(`${day}T${hhmm}:00.000Z`);

  const subject = (
    startsAt: string,
    endsAt: string,
    overrides: Partial<ShiftConflictSubject> = {},
  ): ShiftConflictSubject => ({
    employeeId: 'employee-1',
    employmentAssignmentId: 'assignment-a',
    startsAt: at(startsAt),
    endsAt: at(endsAt),
    ...overrides,
  });

  const existing = (
    id: string,
    startsAt: string,
    endsAt: string,
    overrides: Partial<ShiftConflictCandidate> = {},
  ): ShiftConflictCandidate => ({
    id,
    scheduleId: 'schedule-1',
    employeeId: 'employee-1',
    employmentAssignmentId: 'assignment-a',
    workDate: new Date('2026-10-06T00:00:00.000Z'),
    startsAt: at(startsAt),
    endsAt: at(endsAt),
    status: 'ACTIVE',
    ...overrides,
  });

  describe('same-assignment overlap', () => {
    const base = existing('shift-1', '08:00', '13:00');

    it.each([
      ['exact overlap', '08:00', '13:00'],
      ['partial overlap at the end', '12:00', '16:00'],
      ['partial overlap at the start', '06:00', '09:00'],
      ['containing interval', '07:00', '14:00'],
      ['contained interval', '09:00', '10:00'],
      ['same start', '08:00', '09:00'],
      ['same end', '12:00', '13:00'],
    ])('%s is a non-overrideable ERROR', (_label, startsAt, endsAt) => {
      const [conflict, ...rest] = service.detectShiftConflicts(
        subject(startsAt, endsAt),
        [base],
      );
      expect(rest).toHaveLength(0);
      expect(conflict).toMatchObject({
        type: 'SAME_ASSIGNMENT_OVERLAP',
        severity: 'ERROR',
        overrideAllowed: false,
        employeeId: 'employee-1',
        employmentAssignmentId: 'assignment-a',
        conflictingShift: { id: 'shift-1' },
      });
      expect(conflict!.key).toMatch(/^[0-9a-f]{64}$/);
    });

    it.each([
      ['touching after', '13:00', '16:00'],
      ['touching before', '04:00', '08:00'],
      ['disjoint', '15:00', '18:00'],
    ])('%s does not conflict', (_label, startsAt, endsAt) => {
      expect(
        service.detectShiftConflicts(subject(startsAt, endsAt), [base]),
      ).toEqual([]);
    });

    it('does not conflict across different dates', () => {
      expect(
        service.detectShiftConflicts(
          {
            ...subject('08:00', '13:00'),
            startsAt: at('08:00', '2026-10-07'),
            endsAt: at('13:00', '2026-10-07'),
          },
          [base],
        ),
      ).toEqual([]);
    });

    it('reports the overlapping window', () => {
      const [conflict] = service.detectShiftConflicts(
        subject('12:00', '16:00'),
        [base],
      );
      expect(conflict!.overlap).toEqual({
        startsAt: at('12:00'),
        endsAt: at('13:00'),
      });
    });

    it('still conflicts when the other shift is in a different Schedule', () => {
      const [conflict] = service.detectShiftConflicts(
        subject('10:00', '11:00'),
        [existing('shift-2', '08:00', '13:00', { scheduleId: 'schedule-2' })],
      );
      expect(conflict).toMatchObject({
        type: 'SAME_ASSIGNMENT_OVERLAP',
        conflictingShift: { scheduleId: 'schedule-2' },
      });
    });

    it('excludes the shift itself on update', () => {
      expect(
        service.detectShiftConflicts(
          subject('09:00', '14:00', { id: 'shift-1' }),
          [base],
        ),
      ).toEqual([]);
    });

    it('ignores CANCELLED shifts', () => {
      expect(
        service.detectShiftConflicts(subject('09:00', '10:00'), [
          existing('shift-1', '08:00', '13:00', { status: 'CANCELLED' }),
        ]),
      ).toEqual([]);
    });

    it('detects overlap with an overnight shift', () => {
      const overnight = existing('night', '22:00', '06:00', {
        endsAt: at('06:00', '2026-10-07'),
      });
      expect(
        service.detectShiftConflicts(
          {
            ...subject('05:00', '08:00'),
            startsAt: at('05:00', '2026-10-07'),
            endsAt: at('08:00', '2026-10-07'),
          },
          [overnight],
        ),
      ).toHaveLength(1);
      expect(
        service.detectShiftConflicts(
          {
            ...subject('06:00', '08:00'),
            startsAt: at('06:00', '2026-10-07'),
            endsAt: at('08:00', '2026-10-07'),
          },
          [overnight],
        ),
      ).toEqual([]);
    });
  });

  describe('employee-wide overlap', () => {
    it('is an overrideable WARNING across assignments of the same Employee', () => {
      const [conflict] = service.detectShiftConflicts(
        subject('09:00', '13:00'),
        [
          existing('shift-b', '12:00', '16:00', {
            employmentAssignmentId: 'assignment-b',
          }),
        ],
      );
      expect(conflict).toMatchObject({
        type: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
        severity: 'WARNING',
        overrideAllowed: true,
        conflictingShift: { employmentAssignmentId: 'assignment-b' },
      });
    });

    it('does not conflict when the other assignment does not overlap', () => {
      expect(
        service.detectShiftConflicts(subject('09:00', '12:00'), [
          existing('shift-b', '12:00', '16:00', {
            employmentAssignmentId: 'assignment-b',
          }),
        ]),
      ).toEqual([]);
    });

    it('never compares shifts of different Employees', () => {
      expect(
        service.detectShiftConflicts(subject('09:00', '13:00'), [
          existing('shift-c', '09:00', '13:00', {
            employeeId: 'employee-2',
            employmentAssignmentId: 'assignment-c',
          }),
        ]),
      ).toEqual([]);
    });

    it('orders ERROR conflicts before WARNING conflicts', () => {
      const conflicts = service.detectShiftConflicts(
        subject('09:00', '13:00'),
        [
          existing('shift-b', '08:00', '10:00', {
            employmentAssignmentId: 'assignment-b',
          }),
          existing('shift-a', '12:00', '14:00'),
        ],
      );
      expect(conflicts.map((conflict) => conflict.severity)).toEqual([
        'ERROR',
        'WARNING',
      ]);
    });
  });

  describe('conflict keys', () => {
    const other = existing('shift-b', '12:00', '16:00', {
      employmentAssignmentId: 'assignment-b',
    });
    const key = (s: ShiftConflictSubject, o = other) =>
      service.detectShiftConflicts(s, [o])[0]!.key;

    it('is deterministic for the same conflict state', () => {
      expect(key(subject('09:00', '13:00'))).toBe(
        key(subject('09:00', '13:00')),
      );
    });

    it('changes when either side of the conflict changes', () => {
      const original = key(subject('09:00', '13:00'));
      expect(key(subject('09:00', '13:30'))).not.toBe(original);
      expect(
        key(subject('09:00', '13:00'), { ...other, endsAt: at('17:00') }),
      ).not.toBe(original);
      expect(
        key(subject('09:00', '13:00'), { ...other, id: 'shift-other' }),
      ).not.toBe(original);
      expect(
        key(
          subject('09:00', '13:00', { employmentAssignmentId: 'assignment-c' }),
        ),
      ).not.toBe(original);
    });

    it('is independent of the subject shift id and Schedule container', () => {
      expect(key(subject('09:00', '13:00', { id: 'shift-new' }))).toBe(
        key(subject('09:00', '13:00')),
      );
      expect(
        key(subject('09:00', '13:00'), { ...other, scheduleId: 'schedule-9' }),
      ).toBe(key(subject('09:00', '13:00')));
    });

    it('distinguishes conflict types', () => {
      const side = {
        employmentAssignmentId: 'assignment-a',
        startsAt: at('09:00'),
        endsAt: at('13:00'),
      };
      expect(
        service.conflictKey('SAME_ASSIGNMENT_OVERLAP', side, {
          ...side,
          id: 'x',
        }),
      ).not.toBe(
        service.conflictKey('EMPLOYEE_ASSIGNMENT_OVERLAP', side, {
          ...side,
          id: 'x',
        }),
      );
    });
  });
});
