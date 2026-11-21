import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFLICT_POLICY,
  DEFAULT_SCHEDULE_POLICY,
  resolveSchedulePolicy,
  SCHEDULE_POLICY_FIELDS,
  type SchedulePolicyRow,
} from './schedule-policy.js';
import { SchedulingDomainService } from './scheduling-domain.service.js';

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

function row(
  id: string,
  scopeType: SchedulePolicyRow['scopeType'],
  from: string,
  to: string | null,
  settings: Partial<SchedulePolicyRow> = {},
): SchedulePolicyRow {
  return {
    id,
    scopeType,
    effectiveFrom: date(from),
    effectiveTo: to ? date(to) : null,
    ...(Object.fromEntries(
      SCHEDULE_POLICY_FIELDS.map((field) => [field, null]),
    ) as Record<(typeof SCHEDULE_POLICY_FIELDS)[number], null>),
    ...settings,
  };
}

describe('schedule policy resolution', () => {
  it('falls back to built-in defaults that preserve earlier behaviour', () => {
    const resolved = resolveSchedulePolicy([[], [], []], date('2027-03-01'));
    expect(resolved).toMatchObject(DEFAULT_SCHEDULE_POLICY);
    expect(resolved.generationHorizonDays).toBe(90);
    expect(resolved.unscheduledWorkMode).toBe('ALLOW_UNSCHEDULED');
    expect(Object.values(resolved.sources).every((s) => s === 'DEFAULT')).toBe(
      true,
    );
  });

  it('takes each field from the most specific effective scope that sets it', () => {
    const team = [
      row('team', 'TEAM', '2027-01-01', null, { minimumRestMinutes: 480 }),
    ];
    const department = [
      row('dept', 'DEPARTMENT', '2027-01-01', null, {
        minimumRestMinutes: 600,
        requireWorkLocation: true,
      }),
    ];
    const unitLeaf = [
      row('leaf', 'ORGANIZATIONAL_UNIT', '2027-01-01', null, {
        clockInEarlyMinutes: 15,
      }),
    ];
    const unitRoot = [
      row('root', 'ORGANIZATIONAL_UNIT', '2027-01-01', null, {
        clockInEarlyMinutes: 45,
        clockInLateMinutes: 30,
      }),
    ];
    const organization = [
      row('org', 'ORGANIZATION', '2027-01-01', null, {
        generationHorizonDays: 30,
        requireWorkLocation: false,
        minimumRestMinutes: 720,
      }),
    ];
    const resolved = resolveSchedulePolicy(
      [team, department, unitLeaf, unitRoot, organization],
      date('2027-03-01'),
    );
    expect(resolved).toMatchObject({
      minimumRestMinutes: 480,
      requireWorkLocation: true,
      clockInEarlyMinutes: 15,
      clockInLateMinutes: 30,
      generationHorizonDays: 30,
      autoCreateSchedules: true,
    });
    expect(resolved.sources).toMatchObject({
      minimumRestMinutes: { policyId: 'team', scopeType: 'TEAM' },
      requireWorkLocation: { policyId: 'dept', scopeType: 'DEPARTMENT' },
      clockInEarlyMinutes: { policyId: 'leaf' },
      clockInLateMinutes: { policyId: 'root' },
      generationHorizonDays: { policyId: 'org', scopeType: 'ORGANIZATION' },
      autoCreateSchedules: 'DEFAULT',
    });
  });

  it('uses only policies effective on the date, with inclusive bounds', () => {
    const organization = [
      row('jan', 'ORGANIZATION', '2027-01-01', '2027-01-31', {
        generationHorizonDays: 10,
      }),
      row('feb', 'ORGANIZATION', '2027-02-01', null, {
        generationHorizonDays: 20,
      }),
    ];
    const team = [
      row('t', 'TEAM', '2027-02-10', '2027-02-12', {
        generationHorizonDays: 5,
      }),
    ];
    const at = (d: string) =>
      resolveSchedulePolicy([team, organization], date(d))
        .generationHorizonDays;
    expect(at('2026-12-31')).toBe(90);
    expect(at('2027-01-31')).toBe(10);
    expect(at('2027-02-01')).toBe(20);
    expect(at('2027-02-10')).toBe(5);
    expect(at('2027-02-12')).toBe(5);
    expect(at('2027-02-13')).toBe(20);
  });
});

describe('policy-driven conflicts', () => {
  const domain = new SchedulingDomainService();
  const at = (iso: string) => new Date(iso);
  const subject = {
    employeeId: 'e1',
    employmentAssignmentId: 'a1',
    startsAt: at('2027-03-01T14:00:00Z'),
    endsAt: at('2027-03-01T22:00:00Z'),
  };
  const shift = (
    id: string,
    assignment: string,
    start: string,
    end: string,
  ) => ({
    id,
    scheduleId: 's',
    employeeId: 'e1',
    employmentAssignmentId: assignment,
    workDate: at('2027-03-01T00:00:00Z'),
    startsAt: at(start),
    endsAt: at(end),
    status: 'ACTIVE' as const,
  });

  it('keeps overlap keys and the default behaviour of Batch 3', () => {
    const other = shift(
      'x',
      'a2',
      '2027-03-01T20:00:00Z',
      '2027-03-02T02:00:00Z',
    );
    const [conflict] = domain.detectShiftConflicts(subject, [other]);
    expect(conflict).toMatchObject({
      type: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
      severity: 'WARNING',
      overrideAllowed: true,
    });
    expect(conflict!.key).toBe(
      domain.conflictKey('EMPLOYEE_ASSIGNMENT_OVERLAP', subject, other),
    );
    expect(
      domain.detectShiftConflicts(subject, [other], DEFAULT_CONFLICT_POLICY),
    ).toEqual([conflict]);
  });

  it('applies the policy overlap severity but never relaxes same-assignment overlap', () => {
    const conflicts = domain.detectShiftConflicts(
      subject,
      [
        shift('same', 'a1', '2027-03-01T21:00:00Z', '2027-03-01T23:00:00Z'),
        shift('cross', 'a2', '2027-03-01T15:00:00Z', '2027-03-01T16:00:00Z'),
      ],
      { ...DEFAULT_CONFLICT_POLICY, overlapConflictSeverity: 'ERROR' },
    );
    expect(
      conflicts.map((c) => [c.type, c.severity, c.overrideAllowed]),
    ).toEqual([
      ['EMPLOYEE_ASSIGNMENT_OVERLAP', 'ERROR', false],
      ['SAME_ASSIGNMENT_OVERLAP', 'ERROR', false],
    ]);
  });

  it('flags a gap shorter than the minimum rest, on any assignment, but not touching at 0', () => {
    const policy = { ...DEFAULT_CONFLICT_POLICY, minimumRestMinutes: 600 };
    const after = shift(
      'after',
      'a2',
      '2027-03-02T06:00:00Z',
      '2027-03-02T10:00:00Z',
    );
    const before = shift(
      'before',
      'a1',
      '2027-03-01T02:00:00Z',
      '2027-03-01T06:00:00Z',
    );
    const far = shift(
      'far',
      'a1',
      '2027-03-02T08:00:00Z',
      '2027-03-02T12:00:00Z',
    );
    const conflicts = domain.detectShiftConflicts(
      subject,
      [after, before, far],
      policy,
    );
    expect(
      conflicts.map((c) => [c.type, c.conflictingShift?.id, c.severity]),
    ).toEqual([
      ['MINIMUM_REST_VIOLATION', 'before', 'WARNING'],
      ['MINIMUM_REST_VIOLATION', 'after', 'WARNING'],
    ]);
    expect(conflicts[1]!.overlap).toEqual({
      startsAt: subject.endsAt,
      endsAt: after.startsAt,
    });
    // The threshold is part of the fingerprint: a policy change makes approvals stale.
    const looser = domain.detectShiftConflicts(subject, [after], {
      ...policy,
      minimumRestMinutes: 540,
    });
    expect(looser[0]!.key).not.toBe(conflicts[1]!.key);
    expect(
      domain.detectShiftConflicts(subject, [after], {
        ...policy,
        minimumRestMinutes: 0,
      }),
    ).toEqual([]);
  });

  it('flags a shift longer than the maximum duration without a conflicting shift', () => {
    const [conflict] = domain.detectShiftConflicts(subject, [], {
      ...DEFAULT_CONFLICT_POLICY,
      maximumShiftDurationMinutes: 420,
    });
    expect(conflict).toMatchObject({
      type: 'MAXIMUM_SHIFT_DURATION_EXCEEDED',
      severity: 'WARNING',
      overrideAllowed: true,
      conflictingShift: null,
    });
    expect(
      domain.detectShiftConflicts(subject, [], {
        ...DEFAULT_CONFLICT_POLICY,
        maximumShiftDurationMinutes: 480,
      }),
    ).toEqual([]);
  });

  it('turns every warning into a blocking error when overrides are not allowed', () => {
    const conflicts = domain.detectShiftConflicts(
      subject,
      [shift('cross', 'a2', '2027-03-01T15:00:00Z', '2027-03-01T16:00:00Z')],
      {
        ...DEFAULT_CONFLICT_POLICY,
        maximumShiftDurationMinutes: 60,
        allowManagerConflictOverride: false,
      },
    );
    expect(
      conflicts.every((c) => c.severity === 'ERROR' && !c.overrideAllowed),
    ).toBe(true);
    expect(conflicts).toHaveLength(2);
  });
});
