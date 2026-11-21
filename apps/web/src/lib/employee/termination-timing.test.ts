import { describe, expect, it } from 'vitest';
import { isLaterReschedule, localDateIn, terminationTiming } from './termination-timing';

// 20:00 UTC on Nov 4, 2026: 15:00 on Nov 4 in Toronto, 01:30 on Nov 5 in Kolkata.
const NOW = new Date('2026-11-04T20:00:00.000Z');
const assignment = (id: string, timezone: string, action = 'END') => ({
  employmentAssignmentId: id,
  positionName: `Position ${id}`,
  organizationId: 'org',
  organizationName: 'Org',
  timezone,
  status: 'ACTIVE' as const,
  startDate: '2026-01-01',
  endDate: null,
  action,
  newEndDate: null,
  effectiveFrom: '2026-11-05',
});
const both = [assignment('toronto', 'America/Toronto'), assignment('kolkata', 'Asia/Kolkata')];

describe('terminationTiming (Batch 5C D2)', () => {
  it('reads each assignment in its own time zone', () => {
    expect(localDateIn('America/Toronto', NOW)).toBe('2026-11-04');
    expect(localDateIn('Asia/Kolkata', NOW)).toBe('2026-11-05');
    expect(localDateIn('Not/AZone', NOW)).toBeNull();
  });

  it('is partly immediate when the last day has passed in Kolkata but not in Toronto', () => {
    const timing = terminationTiming(
      { terminationDate: '2026-11-04', scheduled: true, assignments: both },
      NOW,
    );
    expect(timing.kind).toBe('PARTIAL');
    expect(timing.requiresConfirmation).toBe(true);
    expect(timing.immediate.map((a) => a.employmentAssignmentId)).toEqual(['kolkata']);
    expect(timing.later.map((a) => a.employmentAssignmentId)).toEqual(['toronto']);
  });

  it('keeps the last day inclusive: today in a time zone is not yet due there', () => {
    const timing = terminationTiming(
      {
        terminationDate: '2026-11-04',
        scheduled: true,
        assignments: [assignment('toronto', 'America/Toronto')],
      },
      NOW,
    );
    expect(timing).toMatchObject({ kind: 'SCHEDULED', requiresConfirmation: false });
  });

  it('schedules a future date not yet due in either time zone, without a confirmation', () => {
    expect(
      terminationTiming({ terminationDate: '2026-11-10', scheduled: true, assignments: both }, NOW),
    ).toMatchObject({ kind: 'SCHEDULED', requiresConfirmation: false, immediate: [] });
  });

  it('is immediate when the date has passed in every time zone', () => {
    expect(
      terminationTiming(
        { terminationDate: '2026-11-01', scheduled: false, assignments: both },
        NOW,
      ),
    ).toMatchObject({ kind: 'IMMEDIATE', requiresConfirmation: true, uncertain: false });
  });

  it('is conservative when a time zone cannot be read or the clocks disagree', () => {
    const unknown = terminationTiming(
      {
        terminationDate: '2026-11-10',
        scheduled: true,
        assignments: [assignment('x', 'Not/AZone'), assignment('toronto', 'America/Toronto')],
      },
      NOW,
    );
    expect(unknown).toMatchObject({ kind: 'PARTIAL', requiresConfirmation: true, uncertain: true });
    // The API says nothing is still to come, this device says otherwise: confirm anyway.
    const disagree = terminationTiming(
      { terminationDate: '2026-11-10', scheduled: false, assignments: both },
      NOW,
    );
    expect(disagree).toMatchObject({
      kind: 'IMMEDIATE',
      requiresConfirmation: true,
      uncertain: true,
    });
    // Without assignments, the API's own flag decides.
    expect(
      terminationTiming({ terminationDate: '2026-11-01', scheduled: false, assignments: [] }, NOW),
    ).toMatchObject({ kind: 'IMMEDIATE', requiresConfirmation: true });
    expect(
      terminationTiming({ terminationDate: '2026-11-10', scheduled: true, assignments: [] }, NOW),
    ).toMatchObject({ kind: 'SCHEDULED', requiresConfirmation: false });
  });
});

describe('isLaterReschedule (Batch 5C D1)', () => {
  it('flags only a later last day', () => {
    expect(isLaterReschedule('2027-06-30', '2027-08-31')).toBe(true);
    expect(isLaterReschedule('2027-06-30', '2027-06-30')).toBe(false);
    expect(isLaterReschedule('2027-06-30', '2027-05-31')).toBe(false);
    expect(isLaterReschedule(null, '2027-08-31')).toBe(false);
  });
});
