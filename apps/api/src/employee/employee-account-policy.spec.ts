import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_ACTION_CLASS,
  ACCOUNT_ACTIONS,
  PROTECTIVE_WINDOW_DAYS,
  REPEATED_REFUSAL_THRESHOLD,
  assignmentBusinessDate,
  assignmentQualifies,
  classifyRefusalRisk,
  protectiveWindowLastDay,
  refusalAlertDedupeKey,
} from './employee-account-policy.js';

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

/**
 * Security remediation M1: the pure rules of cross-organization account administration —
 * action classes, the 90-day protective window on the assignment's business date, and the
 * deterministic high-risk classification of refused attempts.
 */
describe('M1 account administration policy', () => {
  it('classifies every account action, with requirePasswordChange restorative', () => {
    expect(ACCOUNT_ACTION_CLASS).toEqual({
      invite: 'RESTORATIVE',
      resend: 'RESTORATIVE',
      cancel: 'PROTECTIVE',
      disable: 'PROTECTIVE',
      enable: 'RESTORATIVE',
      requirePasswordChange: 'RESTORATIVE',
      sendPasswordReset: 'RESTORATIVE',
      signOut: 'PROTECTIVE',
      unlock: 'RESTORATIVE',
    });
    expect(Object.keys(ACCOUNT_ACTION_CLASS).sort()).toEqual(
      [...ACCOUNT_ACTIONS].sort(),
    );
  });

  it('ends the protective window 90 days after the inclusive end date', () => {
    expect(PROTECTIVE_WINDOW_DAYS).toBe(90);
    expect(protectiveWindowLastDay(day('2026-01-31'))).toEqual(
      day('2026-05-01'),
    );
    // Across a leap day and a year end.
    expect(protectiveWindowLastDay(day('2027-12-15'))).toEqual(
      day('2028-03-14'),
    );
  });

  describe('assignment eligibility', () => {
    const ended = { status: 'ENDED' as const, endDate: day('2026-01-31') };

    it('lets ACTIVE and PLANNED assignments authorize every class', () => {
      for (const status of ['ACTIVE', 'PLANNED'] as const) {
        for (const cls of ['PROTECTIVE', 'RESTORATIVE'] as const) {
          expect(
            assignmentQualifies(
              cls,
              { status, endDate: null },
              day('2030-01-01'),
            ),
          ).toBe(true);
        }
      }
    });

    it('never lets an ENDED or CANCELLED assignment authorize a restorative action', () => {
      expect(assignmentQualifies('RESTORATIVE', ended, day('2026-02-01'))).toBe(
        false,
      );
      expect(
        assignmentQualifies(
          'RESTORATIVE',
          { status: 'CANCELLED', endDate: null },
          day('2026-02-01'),
        ),
      ).toBe(false);
    });

    it('lets an ENDED assignment authorize protective actions through the 90th day only', () => {
      expect(assignmentQualifies('PROTECTIVE', ended, day('2026-01-31'))).toBe(
        true,
      );
      expect(assignmentQualifies('PROTECTIVE', ended, day('2026-05-01'))).toBe(
        true,
      );
      expect(assignmentQualifies('PROTECTIVE', ended, day('2026-05-02'))).toBe(
        false,
      );
      expect(
        assignmentQualifies(
          'PROTECTIVE',
          { status: 'CANCELLED', endDate: day('2026-01-31') },
          day('2026-02-01'),
        ),
      ).toBe(false);
      // An ENDED row without an end date cannot place the window: it never qualifies.
      expect(
        assignmentQualifies(
          'PROTECTIVE',
          { status: 'ENDED', endDate: null },
          day('2026-02-01'),
        ),
      ).toBe(false);
    });
  });

  describe('business date of the window (assignment time zone)', () => {
    // The last protective day of an assignment ended on 2026-01-31 is 2026-05-01.
    const ended = { status: 'ENDED' as const, endDate: day('2026-01-31') };
    const toronto = {
      workLocation: { timezone: 'America/Toronto' },
      organization: { timezone: 'Asia/Kolkata' },
    };
    const kolkata = {
      workLocation: null,
      organization: { timezone: 'Asia/Kolkata' },
    };
    const unresolved = { workLocation: null, organization: { timezone: null } };

    it('uses the work location, then the organization, then UTC', () => {
      const instant = new Date('2026-05-02T03:30:00.000Z');
      expect(assignmentBusinessDate(toronto, instant)).toEqual(
        day('2026-05-01'),
      );
      expect(assignmentBusinessDate(kolkata, instant)).toEqual(
        day('2026-05-02'),
      );
      expect(assignmentBusinessDate(unresolved, instant)).toEqual(
        day('2026-05-02'),
      );
    });

    it('decides the 90-day boundary on that business date', () => {
      // 23:30 on 2026-05-01 in Toronto (EDT), 09:00 on 2026-05-02 in Kolkata.
      const instant = new Date('2026-05-02T03:30:00.000Z');
      expect(
        assignmentQualifies(
          'PROTECTIVE',
          ended,
          assignmentBusinessDate(toronto, instant),
        ),
      ).toBe(true);
      expect(
        assignmentQualifies(
          'PROTECTIVE',
          ended,
          assignmentBusinessDate(kolkata, instant),
        ),
      ).toBe(false);
      // 00:30 on 2026-05-02 in Kolkata is still 2026-05-01 in Toronto (14:00 EDT).
      const kolkataMidnight = new Date('2026-05-01T19:00:00.000Z');
      expect(assignmentBusinessDate(kolkata, kolkataMidnight)).toEqual(
        day('2026-05-02'),
      );
      expect(
        assignmentQualifies(
          'PROTECTIVE',
          ended,
          assignmentBusinessDate(toronto, kolkataMidnight),
        ),
      ).toBe(true);
    });
  });

  describe('high-risk classification of refused attempts', () => {
    const base = {
      actionClass: 'PROTECTIVE' as const,
      targetSystemPrivileged: false,
      crossOrganization: false,
      priorRestorativeRefusals: 0,
    };

    it('is deterministic and ranks SYSTEM-privileged targets first', () => {
      expect(classifyRefusalRisk(base)).toBeNull();
      expect(
        classifyRefusalRisk({
          ...base,
          targetSystemPrivileged: true,
          crossOrganization: true,
        }),
      ).toBe('SYSTEM_PRIVILEGED_TARGET');
      expect(classifyRefusalRisk({ ...base, crossOrganization: true })).toBe(
        'CROSS_ORGANIZATION',
      );
    });

    it('treats only repeated restorative refusals as repeated', () => {
      expect(REPEATED_REFUSAL_THRESHOLD).toBe(3);
      const prior = REPEATED_REFUSAL_THRESHOLD - 1;
      expect(
        classifyRefusalRisk({
          ...base,
          actionClass: 'RESTORATIVE',
          priorRestorativeRefusals: prior - 1,
        }),
      ).toBeNull();
      expect(
        classifyRefusalRisk({
          ...base,
          actionClass: 'RESTORATIVE',
          priorRestorativeRefusals: prior,
        }),
      ).toBe('REPEATED_REFUSALS');
      expect(
        classifyRefusalRisk({ ...base, priorRestorativeRefusals: 10 }),
      ).toBeNull();
    });

    it('deduplicates alerts per actor and subject per hour, and repeats per actor per day', () => {
      const at = new Date('2026-05-02T03:30:00.000Z');
      const later = new Date('2026-05-02T03:59:59.000Z');
      const nextHour = new Date('2026-05-02T04:00:00.000Z');
      const key = (
        risk: Parameters<typeof refusalAlertDedupeKey>[0],
        when: Date,
        subject = 's1',
      ) => refusalAlertDedupeKey(risk, 'actor-1', subject, when);
      expect(key('CROSS_ORGANIZATION', at)).toBe(
        key('CROSS_ORGANIZATION', later),
      );
      expect(key('CROSS_ORGANIZATION', at)).not.toBe(
        key('CROSS_ORGANIZATION', nextHour),
      );
      expect(key('CROSS_ORGANIZATION', at)).not.toBe(
        key('CROSS_ORGANIZATION', at, 's2'),
      );
      // Repeated refusals: one alert per actor per UTC day, whatever the target.
      expect(key('REPEATED_REFUSALS', at)).toBe(
        key('REPEATED_REFUSALS', nextHour, 's2'),
      );
      for (const value of [
        key('SYSTEM_PRIVILEGED_TARGET', at),
        key('REPEATED_REFUSALS', at),
      ])
        expect(value).toMatch(/^[A-Za-z0-9:._-]{1,200}$/);
    });
  });
});
