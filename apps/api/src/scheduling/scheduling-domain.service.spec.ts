import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { isIanaTimezone } from '../common/timezone.js';
import {
  SchedulingDomainService,
  type ScheduleScopeShape,
} from './scheduling-domain.service.js';

describe('SchedulingDomainService', () => {
  const service = new SchedulingDomainService();

  /** Parse a YYYY-MM-DD string to a UTC midnight Date — the DATE-only column representation. */
  function date(s: string): Date {
    return new Date(`${s}T00:00:00.000Z`);
  }

  /** Calendar date of an instant in an IANA timezone. */
  function localDate(instant: Date, timezone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  }

  /** Parse a UTC ISO-8601 instant. */
  function utc(s: string): Date {
    return new Date(s);
  }

  // ─── Schedule period validity ───────────────────────────────────────────────

  describe('assertSchedulePeriod', () => {
    it('accepts a valid STANDARD schedule period spanning multiple days', () => {
      expect(() =>
        service.assertSchedulePeriod(date('2026-10-05'), date('2026-10-11')),
      ).not.toThrow();
    });

    it('accepts a valid AD_HOC schedule period (here tested as single-day start < end)', () => {
      expect(() =>
        service.assertSchedulePeriod(date('2026-10-15'), date('2026-10-20')),
      ).not.toThrow();
    });

    it('accepts a single-day period where periodStart equals periodEnd', () => {
      expect(() =>
        service.assertSchedulePeriod(date('2026-11-01'), date('2026-11-01')),
      ).not.toThrow();
    });

    it('rejects an inverted period where periodStart is after periodEnd', () => {
      expect(() =>
        service.assertSchedulePeriod(date('2026-10-11'), date('2026-10-05')),
      ).toThrow(BadRequestException);
    });
  });

  // ─── Shift interval validity ────────────────────────────────────────────────

  describe('assertShiftInterval', () => {
    it('accepts a valid daytime shift', () => {
      // 10:00–18:00 UTC — normal daytime
      expect(() =>
        service.assertShiftInterval(
          utc('2026-10-10T14:00:00.000Z'),
          utc('2026-10-10T22:00:00.000Z'),
        ),
      ).not.toThrow();
    });

    it('accepts a valid overnight shift spanning midnight', () => {
      // 22:00 Oct 10 America/Toronto (02:00 Oct 11 UTC) → 06:00 Oct 11 America/Toronto (10:00 Oct 11 UTC)
      expect(() =>
        service.assertShiftInterval(
          utc('2026-10-11T02:00:00.000Z'),
          utc('2026-10-11T10:00:00.000Z'),
        ),
      ).not.toThrow();
    });

    it('rejects a zero-duration shift where startsAt equals endsAt', () => {
      const t = utc('2026-10-10T14:00:00.000Z');
      expect(() => service.assertShiftInterval(t, t)).toThrow(
        BadRequestException,
      );
    });

    it('rejects an inverted shift where endsAt is before startsAt', () => {
      expect(() =>
        service.assertShiftInterval(
          utc('2026-10-10T22:00:00.000Z'),
          utc('2026-10-10T14:00:00.000Z'),
        ),
      ).toThrow(BadRequestException);
    });
  });

  // ─── Schedule membership (workDate within period) ───────────────────────────

  describe('assertWorkDateInSchedule', () => {
    const periodStart = date('2026-10-05');
    const periodEnd = date('2026-10-11');

    it('accepts workDate on the periodStart boundary (inclusive)', () => {
      expect(() =>
        service.assertWorkDateInSchedule(
          date('2026-10-05'),
          periodStart,
          periodEnd,
        ),
      ).not.toThrow();
    });

    it('accepts workDate on the periodEnd boundary (inclusive)', () => {
      expect(() =>
        service.assertWorkDateInSchedule(
          date('2026-10-11'),
          periodStart,
          periodEnd,
        ),
      ).not.toThrow();
    });

    it('rejects workDate one day before the period', () => {
      expect(() =>
        service.assertWorkDateInSchedule(
          date('2026-10-04'),
          periodStart,
          periodEnd,
        ),
      ).toThrow(BadRequestException);
    });

    it('rejects workDate one day after the period', () => {
      expect(() =>
        service.assertWorkDateInSchedule(
          date('2026-10-12'),
          periodStart,
          periodEnd,
        ),
      ).toThrow(BadRequestException);
    });

    it('accepts an overnight shift workDate at period end even when endsAt falls the next day', () => {
      // Schedule Oct 5–11.  Shift workDate Oct 11 (within period).
      // Shift startsAt 22:00 Oct 11 America/Toronto → endsAt 06:00 Oct 12 America/Toronto.
      // endsAt is Oct 12 = outside the period, but workDate governs membership.
      const workDate = date('2026-10-11'); // valid: within Oct 5–11
      const startsAt = utc('2026-10-12T02:00:00.000Z'); // 22:00 Oct 11 Toronto
      const endsAt = utc('2026-10-12T10:00:00.000Z'); // 06:00 Oct 12 Toronto

      // workDate check passes
      expect(() =>
        service.assertWorkDateInSchedule(workDate, periodStart, periodEnd),
      ).not.toThrow();

      // interval check passes independently (endsAt > startsAt)
      expect(() => service.assertShiftInterval(startsAt, endsAt)).not.toThrow();
    });
  });

  // ─── EmploymentAssignment lifecycle ─────────────────────────────────────────

  describe('assertAssignmentEffective', () => {
    const workDate = date('2026-10-10');

    it('accepts a valid ACTIVE assignment effective on workDate', () => {
      expect(() =>
        service.assertAssignmentEffective(
          { status: 'ACTIVE', startDate: date('2026-10-01'), endDate: null },
          workDate,
        ),
      ).not.toThrow();
    });

    it('accepts a PLANNED assignment whose startDate precedes workDate', () => {
      // PLANNED is not excluded by the Phase 5 lifecycle rule — scheduling future shifts is valid
      expect(() =>
        service.assertAssignmentEffective(
          { status: 'PLANNED', startDate: date('2026-10-01'), endDate: null },
          workDate,
        ),
      ).not.toThrow();
    });

    it('accepts an ENDED assignment when workDate is within its date range', () => {
      expect(() =>
        service.assertAssignmentEffective(
          {
            status: 'ENDED',
            startDate: date('2026-10-01'),
            endDate: date('2026-10-15'),
          },
          workDate,
        ),
      ).not.toThrow();
    });

    it('rejects an assignment not yet effective — startDate is after workDate', () => {
      expect(() =>
        service.assertAssignmentEffective(
          { status: 'PLANNED', startDate: date('2026-10-20'), endDate: null },
          workDate,
        ),
      ).toThrow(BadRequestException);
    });

    it('rejects an ENDED assignment whose endDate is before workDate', () => {
      expect(() =>
        service.assertAssignmentEffective(
          {
            status: 'ENDED',
            startDate: date('2026-10-01'),
            endDate: date('2026-10-05'),
          },
          workDate,
        ),
      ).toThrow(BadRequestException);
    });

    it('rejects a CANCELLED assignment regardless of its date range', () => {
      expect(() =>
        service.assertAssignmentEffective(
          { status: 'CANCELLED', startDate: date('2026-10-01'), endDate: null },
          workDate,
        ),
      ).toThrow(BadRequestException);
    });

    it('rejects a CANCELLED assignment even when dates would otherwise be valid', () => {
      expect(() =>
        service.assertAssignmentEffective(
          {
            status: 'CANCELLED',
            startDate: date('2026-10-01'),
            endDate: date('2026-10-31'),
          },
          workDate,
        ),
      ).toThrow(BadRequestException);
    });
  });

  // ─── Organization boundary ──────────────────────────────────────────────────

  describe('assertOrganizationBoundary', () => {
    it('accepts when assignment and schedule share the same organization', () => {
      expect(() =>
        service.assertOrganizationBoundary('org-abc', 'org-abc'),
      ).not.toThrow();
    });

    it('rejects when the assignment belongs to a different organization', () => {
      expect(() =>
        service.assertOrganizationBoundary('org-abc', 'org-xyz'),
      ).toThrow(BadRequestException);
    });
  });

  // ─── WorkLocation ───────────────────────────────────────────────────────────

  describe('WorkLocation', () => {
    it('accepts a shift with no WorkLocation when an explicit timezone is provided', () => {
      expect(() =>
        service.resolveShiftTimezone(null, 'America/Toronto'),
      ).not.toThrow();
      expect(service.resolveShiftTimezone(null, 'America/Toronto')).toBe(
        'America/Toronto',
      );
    });

    it('accepts a shift with no WorkLocation when undefined is passed', () => {
      expect(service.resolveShiftTimezone(undefined, 'UTC')).toBe('UTC');
    });

    it('obtains the timezone from WorkLocation when available', () => {
      expect(service.resolveShiftTimezone('Europe/London', null)).toBe(
        'Europe/London',
      );
    });

    it('WorkLocation timezone takes precedence over the explicit fallback', () => {
      expect(
        service.resolveShiftTimezone('Pacific/Auckland', 'America/Toronto'),
      ).toBe('Pacific/Auckland');
    });

    it('rejects a cross-organization WorkLocation', () => {
      expect(() =>
        service.assertWorkLocationOrganization('org-1', 'org-2'),
      ).toThrow(BadRequestException);
    });

    it('accepts a WorkLocation belonging to the same organization', () => {
      expect(() =>
        service.assertWorkLocationOrganization('org-1', 'org-1'),
      ).not.toThrow();
    });
  });

  // ─── Timezone resolution ────────────────────────────────────────────────────

  describe('resolveShiftTimezone', () => {
    it('accepts a valid IANA timezone identifier', () => {
      expect(service.resolveShiftTimezone('America/Vancouver', null)).toBe(
        'America/Vancouver',
      );
    });

    it('accepts UTC as a valid timezone', () => {
      expect(service.resolveShiftTimezone('UTC', null)).toBe('UTC');
    });

    it('rejects a legacy abbreviation that is not an IANA timezone', () => {
      expect(() => service.resolveShiftTimezone('EST', null)).toThrow(
        BadRequestException,
      );
    });

    it('rejects an empty string timezone', () => {
      expect(() => service.resolveShiftTimezone('', null)).toThrow(
        BadRequestException,
      );
    });

    it('rejects an unrecognized timezone string', () => {
      expect(() =>
        service.resolveShiftTimezone(null, 'NotATimezone/Fake'),
      ).toThrow(BadRequestException);
    });

    it('throws when neither WorkLocation timezone nor explicit timezone is provided', () => {
      expect(() => service.resolveShiftTimezone(null, null)).toThrow(
        BadRequestException,
      );
      expect(() => service.resolveShiftTimezone(undefined, undefined)).toThrow(
        BadRequestException,
      );
    });

    it('uses the shared common timezone validator — same rules as Phase 6', () => {
      // Verify the same validation surface is shared with Phase 6
      expect(isIanaTimezone('America/Toronto')).toBe(true);
      expect(isIanaTimezone('EST')).toBe(false);
      expect(isIanaTimezone('')).toBe(false);

      // resolveShiftTimezone must honour the same rules
      expect(service.resolveShiftTimezone('America/Toronto', null)).toBe(
        'America/Toronto',
      );
      expect(() => service.resolveShiftTimezone('EST', null)).toThrow(
        BadRequestException,
      );
    });

    it('does not fall back to the server timezone — missing timezone always throws', () => {
      // No implicit default: the domain service must never silently use the process/machine timezone.
      expect(() => service.resolveShiftTimezone(null, null)).toThrow(
        BadRequestException,
      );
      expect(() => service.resolveShiftTimezone(undefined, undefined)).toThrow(
        BadRequestException,
      );
      expect(() => service.resolveShiftTimezone('', '')).toThrow(
        BadRequestException,
      );
    });

    it('shows timezone-dependent date resolution differs by IANA zone — confirms no server-tz leakage', () => {
      // A UTC instant that is Oct 2 in Toronto but Oct 3 in UTC / London
      const instant = utc('2026-10-03T02:00:00.000Z');

      const torontoDate = localDate(
        instant,
        service.resolveShiftTimezone('America/Toronto', null),
      );
      const londonDate = localDate(
        instant,
        service.resolveShiftTimezone('Europe/London', null),
      );

      expect(torontoDate).toBe('2026-10-02');
      expect(londonDate).toBe('2026-10-03');
      // The results differ, proving timezone resolution is IANA-driven, not server-driven.
      expect(torontoDate).not.toBe(londonDate);
    });
  });

  // ─── Schedule scope ─────────────────────────────────────────────────────────

  describe('assertScheduleScopeShape', () => {
    const base = { organizationId: 'org-1' };

    it('accepts ORGANIZATION scope with no narrower target', () => {
      expect(() =>
        service.assertScheduleScopeShape({
          ...base,
          scopeType: 'ORGANIZATION',
        }),
      ).not.toThrow();
      expect(() =>
        service.assertScheduleScopeShape({
          ...base,
          scopeType: 'ORGANIZATION',
          organizationalUnitId: null,
          departmentId: null,
          teamId: null,
        }),
      ).not.toThrow();
    });

    it('accepts ORGANIZATIONAL_UNIT scope with only organizationalUnitId', () => {
      expect(() =>
        service.assertScheduleScopeShape({
          ...base,
          scopeType: 'ORGANIZATIONAL_UNIT',
          organizationalUnitId: 'unit-1',
        }),
      ).not.toThrow();
    });

    it('accepts DEPARTMENT scope with only departmentId', () => {
      expect(() =>
        service.assertScheduleScopeShape({
          ...base,
          scopeType: 'DEPARTMENT',
          departmentId: 'dept-1',
        }),
      ).not.toThrow();
    });

    it('accepts TEAM scope with only teamId', () => {
      expect(() =>
        service.assertScheduleScopeShape({
          ...base,
          scopeType: 'TEAM',
          teamId: 'team-1',
        }),
      ).not.toThrow();
    });

    it.each<[string, ScheduleScopeShape]>([
      [
        'ORGANIZATION with organizationalUnitId',
        { ...base, scopeType: 'ORGANIZATION', organizationalUnitId: 'unit-1' },
      ],
      [
        'ORGANIZATION with departmentId',
        { ...base, scopeType: 'ORGANIZATION', departmentId: 'dept-1' },
      ],
      [
        'ORGANIZATION with teamId',
        { ...base, scopeType: 'ORGANIZATION', teamId: 'team-1' },
      ],
      [
        'ORGANIZATIONAL_UNIT without organizationalUnitId',
        { ...base, scopeType: 'ORGANIZATIONAL_UNIT' },
      ],
      [
        'ORGANIZATIONAL_UNIT with departmentId',
        {
          ...base,
          scopeType: 'ORGANIZATIONAL_UNIT',
          organizationalUnitId: 'unit-1',
          departmentId: 'dept-1',
        },
      ],
      ['DEPARTMENT without departmentId', { ...base, scopeType: 'DEPARTMENT' }],
      [
        'DEPARTMENT with only organizationalUnitId',
        { ...base, scopeType: 'DEPARTMENT', organizationalUnitId: 'unit-1' },
      ],
      [
        'DEPARTMENT with teamId',
        {
          ...base,
          scopeType: 'DEPARTMENT',
          departmentId: 'dept-1',
          teamId: 'team-1',
        },
      ],
      ['TEAM without teamId', { ...base, scopeType: 'TEAM' }],
      [
        'TEAM with departmentId',
        {
          ...base,
          scopeType: 'TEAM',
          departmentId: 'dept-1',
          teamId: 'team-1',
        },
      ],
      [
        'TEAM with organizationalUnitId',
        {
          ...base,
          scopeType: 'TEAM',
          organizationalUnitId: 'unit-1',
          teamId: 'team-1',
        },
      ],
    ])('rejects %s', (_label, scope) => {
      expect(() => service.assertScheduleScopeShape(scope)).toThrow(
        BadRequestException,
      );
    });

    it('rejects a missing organizationId for every scope type', () => {
      expect(() =>
        service.assertScheduleScopeShape({
          scopeType: 'ORGANIZATION',
          organizationId: '',
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects an unsupported scopeType', () => {
      for (const scopeType of ['SYSTEM', 'EMPLOYMENT_ASSIGNMENT', 'PROGRAM']) {
        expect(() =>
          service.assertScheduleScopeShape({
            ...base,
            scopeType: scopeType as ScheduleScopeShape['scopeType'],
          }),
        ).toThrow(BadRequestException);
      }
    });
  });

  describe('assertScopeTargetOrganization', () => {
    it('accepts a unit, department, or team in the Schedule organization', () => {
      expect(() =>
        service.assertScopeTargetOrganization('org-1', 'org-1'),
      ).not.toThrow();
    });

    it('rejects a cross-organization scope target', () => {
      expect(() =>
        service.assertScopeTargetOrganization('org-1', 'org-2'),
      ).toThrow(BadRequestException);
    });
  });

  // ─── Batch 2 input parsing ──────────────────────────────────────────────────

  describe('parseDateOnly', () => {
    it('parses YYYY-MM-DD to UTC midnight', () => {
      expect(
        service.parseDateOnly('2026-10-05', 'workDate').toISOString(),
      ).toBe('2026-10-05T00:00:00.000Z');
    });

    it('rejects timestamps, loose formats, and impossible dates', () => {
      for (const value of [
        '2026-10-05T00:00:00Z',
        '2026-10-5',
        '10/05/2026',
        '2026-02-30',
        '2026-13-01',
      ]) {
        expect(() => service.parseDateOnly(value, 'workDate')).toThrow(
          BadRequestException,
        );
      }
    });
  });

  describe('parseInstant', () => {
    it('accepts UTC and explicit-offset instants', () => {
      expect(
        service
          .parseInstant('2026-10-06T09:00:00-04:00', 'startsAt')
          .toISOString(),
      ).toBe('2026-10-06T13:00:00.000Z');
      expect(
        service.parseInstant('2026-10-06T13:00Z', 'startsAt').toISOString(),
      ).toBe('2026-10-06T13:00:00.000Z');
      expect(
        service
          .parseInstant('2026-10-06T13:00:00.250+00:00', 'startsAt')
          .toISOString(),
      ).toBe('2026-10-06T13:00:00.250Z');
    });

    it('rejects floating local times and invalid values', () => {
      for (const value of [
        '2026-10-06T09:00:00',
        '2026-10-06',
        '2026-10-06 09:00:00Z',
        '2026-02-30T09:00:00Z',
        '2026-10-06T25:00:00Z',
        'not-a-date',
      ]) {
        expect(() => service.parseInstant(value, 'startsAt')).toThrow(
          BadRequestException,
        );
      }
    });
  });

  describe('assertWorkDateMatchesShiftStart', () => {
    it('accepts the local start date, including overnight shifts', () => {
      expect(() =>
        service.assertWorkDateMatchesShiftStart(
          date('2026-10-11'),
          utc('2026-10-12T02:00:00.000Z'), // 22:00 on Oct 11 in Toronto
          'America/Toronto',
        ),
      ).not.toThrow();
    });

    it('rejects a workDate that differs from the local start date', () => {
      expect(() =>
        service.assertWorkDateMatchesShiftStart(
          date('2026-10-12'),
          utc('2026-10-12T02:00:00.000Z'),
          'America/Toronto',
        ),
      ).toThrow(BadRequestException);
      expect(() =>
        service.assertWorkDateMatchesShiftStart(
          date('2026-10-11'),
          utc('2026-10-12T02:00:00.000Z'),
          'UTC',
        ),
      ).toThrow(BadRequestException);
    });
  });
});
