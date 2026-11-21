import { describe, expect, it } from 'vitest';
import type { LeavePolicy } from '../generated/prisma/client.js';
import { trimExpectedWorkForAbsences } from '../time/time-integration.contracts.js';
import {
  planEntitlements,
  type PlanEntry,
  type PlannedPosting,
} from './leave-entitlement.js';
import { leaveYearBalanceCheck, summarizeBalance } from './leave-ledger.js';
import {
  employmentTypeSetsConflict,
  leavePolicySettingProblems,
  leaveYearStartOf,
  resolveLeavePolicy,
} from './leave-policy.js';
import { applyDayOverrides, sizeLeaveDays } from './leave-sizing.js';

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);

function policy(overrides: Partial<LeavePolicy> = {}): LeavePolicy {
  return {
    id: 'p-org',
    leaveTypeId: 't',
    organizationId: 'org',
    scopeType: 'ORGANIZATION',
    organizationalUnitId: null,
    departmentId: null,
    teamId: null,
    employmentAssignmentId: null,
    employmentTypes: [],
    name: null,
    effectiveFrom: d('2020-01-01'),
    effectiveTo: null,
    eligible: true,
    waitingPeriodDays: 0,
    leaveYearStartMonth: 1,
    leaveYearStartDay: 1,
    amountSource: 'SCHEDULE_THEN_STANDARD',
    standardWorkdayMinutes: 480,
    standardWorkdays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
    excludeHolidays: true,
    allowPartialDay: true,
    accrualMethod: 'NONE',
    annualGrantMinutes: null,
    accrualFrequency: null,
    accrualMinutesPerPeriod: null,
    accrualAnchorDate: null,
    prorateFirstYear: false,
    maxBalanceMinutes: null,
    negativeBalanceLimitMinutes: 0,
    carryoverMode: 'UNLIMITED',
    carryoverMaxMinutes: null,
    carryoverExpiryDays: null,
    employeeMayCancelApprovedFuture: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const subject = {
  employmentAssignmentId: 'a-1',
  employmentType: 'PART_TIME' as const,
  target: {
    type: 'TEAM' as const,
    organizationId: 'org',
    unitPathIds: ['u-leaf', 'u-root'],
    departmentId: 'dept',
    teamId: 'team',
  },
};

describe('leave policy resolution', () => {
  it('prefers assignment → team → department → unit leaf→root → organization', () => {
    const all = [
      policy({ id: 'org' }),
      policy({
        id: 'root',
        scopeType: 'ORGANIZATIONAL_UNIT',
        organizationalUnitId: 'u-root',
      }),
      policy({
        id: 'leaf',
        scopeType: 'ORGANIZATIONAL_UNIT',
        organizationalUnitId: 'u-leaf',
      }),
      policy({ id: 'dept', scopeType: 'DEPARTMENT', departmentId: 'dept' }),
      policy({ id: 'team', scopeType: 'TEAM', teamId: 'team' }),
      policy({
        id: 'assignment',
        scopeType: 'EMPLOYMENT_ASSIGNMENT',
        employmentAssignmentId: 'a-1',
      }),
    ];
    const order: string[] = [];
    let remaining = [...all];
    while (remaining.length) {
      const winner = resolveLeavePolicy(remaining, subject, d('2027-01-01'))!;
      order.push(winner.id);
      remaining = remaining.filter((p) => p.id !== winner.id);
    }
    expect(order).toEqual([
      'assignment',
      'team',
      'dept',
      'leaf',
      'root',
      'org',
    ]);
  });

  it('prefers an employment-type match within a level and ignores other types', () => {
    const all = [
      policy({ id: 'all' }),
      policy({ id: 'pt', employmentTypes: ['PART_TIME'] }),
      policy({ id: 'ft', employmentTypes: ['FULL_TIME'] }),
    ];
    expect(resolveLeavePolicy(all, subject, d('2027-01-01'))!.id).toBe('pt');
    expect(
      resolveLeavePolicy(
        all,
        { ...subject, employmentType: 'CASUAL' },
        d('2027-01-01'),
      )!.id,
    ).toBe('all');
    expect(
      resolveLeavePolicy(
        [policy({ employmentTypes: ['FULL_TIME'] })],
        subject,
        d('2027-01-01'),
      ),
    ).toBeNull();
  });

  it('respects inclusive effective dates', () => {
    const p = policy({
      effectiveFrom: d('2027-01-01'),
      effectiveTo: d('2027-12-31'),
    });
    expect(resolveLeavePolicy([p], subject, d('2026-12-31'))).toBeNull();
    expect(resolveLeavePolicy([p], subject, d('2027-01-01'))).toBe(p);
    expect(resolveLeavePolicy([p], subject, d('2027-12-31'))).toBe(p);
    expect(resolveLeavePolicy([p], subject, d('2028-01-01'))).toBeNull();
  });

  it('defines ambiguity by employment-type sets', () => {
    expect(employmentTypeSetsConflict([], [])).toBe(true);
    expect(employmentTypeSetsConflict([], ['FULL_TIME'])).toBe(false);
    expect(employmentTypeSetsConflict(['CASUAL'], ['CASUAL', 'CONTRACT'])).toBe(
      true,
    );
    expect(employmentTypeSetsConflict(['CASUAL'], ['FULL_TIME'])).toBe(false);
  });

  it('computes configurable leave years', () => {
    const school = { leaveYearStartMonth: 9, leaveYearStartDay: 1 };
    expect(leaveYearStartOf(d('2027-08-31'), school)).toEqual(d('2026-09-01'));
    expect(leaveYearStartOf(d('2027-09-01'), school)).toEqual(d('2027-09-01'));
    expect(
      leaveYearStartOf(d('2027-03-01'), {
        leaveYearStartMonth: 1,
        leaveYearStartDay: 1,
      }),
    ).toEqual(d('2027-01-01'));
  });

  it('reports inconsistent settings', () => {
    expect(
      leavePolicySettingProblems(policy({ accrualMethod: 'PERIODIC' })),
    ).toHaveLength(1);
    expect(
      leavePolicySettingProblems(
        policy({
          accrualMethod: 'PERIODIC',
          accrualFrequency: 'BIWEEKLY',
          accrualMinutesPerPeriod: 60,
        }),
      ),
    ).toEqual([
      'accrualAnchorDate is required for, and only for, BIWEEKLY accrual.',
    ]);
    expect(
      leavePolicySettingProblems(
        policy({ carryoverMode: 'NONE', carryoverExpiryDays: 30 }),
      ),
    ).toEqual(['carryoverExpiryDays requires carryover.']);
  });
});

describe('leave sizing', () => {
  const base = {
    timezone: 'America/Toronto',
    partial: null,
    policyFor: () => policy(),
    holidays: new Map<string, string>(),
    scheduleDates: new Set<string>(),
    expectedWork: [],
  };

  it('is deterministic and never trusts client minutes', () => {
    const first = sizeLeaveDays({
      ...base,
      dates: [d('2027-03-01'), d('2027-03-06')],
    });
    const second = sizeLeaveDays({
      ...base,
      dates: [d('2027-03-01'), d('2027-03-06')],
    });
    expect(first).toEqual(second);
    expect(first.map((day) => day.minutes)).toEqual([480, 0]);
  });

  it('counts only overlapping shift minutes on a partial scheduled day', () => {
    const [day] = sizeLeaveDays({
      ...base,
      dates: [d('2027-03-02')],
      partial: { startLocalTime: '16:00', endLocalTime: '18:00' },
      scheduleDates: new Set(['2027-03-02']),
      expectedWork: [
        {
          employeeId: 'e',
          employmentAssignmentId: 'a-1',
          scheduledShiftId: 's',
          scheduledShiftRevisionId: 'r',
          revisionNumber: 1,
          scheduleId: 'sc',
          workLocationId: null,
          workDate: '2027-03-02',
          startsAt: '2027-03-02T14:00:00.000Z',
          endsAt: '2027-03-02T22:00:00.000Z',
          timezone: 'America/Toronto',
          scheduledMinutes: 480,
        },
      ],
    });
    expect(day).toMatchObject({
      minutes: 60,
      amountSource: 'SCHEDULE',
      scheduledShiftRevisionIds: ['r'],
    });
  });

  it('lets a published schedule decide a holiday; the standard day excludes it', () => {
    const shift = {
      employeeId: 'e',
      employmentAssignmentId: 'a-1',
      scheduledShiftId: 's',
      scheduledShiftRevisionId: 'r',
      revisionNumber: 1,
      scheduleId: 'sc',
      workLocationId: null,
      workDate: '2027-03-02',
      startsAt: '2027-03-02T14:00:00.000Z',
      endsAt: '2027-03-02T20:00:00.000Z',
      timezone: 'America/Toronto',
      scheduledMinutes: 360,
    };
    const holidays = new Map([
      ['2027-03-02', 'Founders Day'],
      ['2027-03-03', 'Founders Day 2'],
    ]);
    const days = sizeLeaveDays({
      ...base,
      holidays,
      dates: [d('2027-03-02'), d('2027-03-03')],
      scheduleDates: new Set(['2027-03-02']),
      expectedWork: [shift],
    });
    expect(
      days.map((day) => [day.minutes, day.amountSource, day.holidayName]),
    ).toEqual([
      [360, 'SCHEDULE', 'Founders Day'],
      [0, 'HOLIDAY_EXCLUDED', 'Founders Day 2'],
    ]);
  });

  it('applies overrides with reasons', () => {
    const days = applyDayOverrides(
      sizeLeaveDays({ ...base, dates: [d('2027-03-01')] }),
      [{ date: '2027-03-01', minutes: 120, reason: ' agreed ' }],
    );
    expect(days[0]).toMatchObject({
      minutes: 120,
      amountSource: 'MANUAL_OVERRIDE',
      overrideReason: 'agreed',
    });
  });
});

describe('balance semantics', () => {
  it('separates current, scheduled and available', () => {
    const entries = [
      {
        amountMinutes: 2400,
        effectiveDate: d('2027-01-01'),
        leaveRequestDayId: null,
      },
      {
        amountMinutes: -480,
        effectiveDate: d('2027-02-01'),
        leaveRequestDayId: 'past',
      },
      {
        amountMinutes: -480,
        effectiveDate: d('2027-04-01'),
        leaveRequestDayId: 'future',
      },
      {
        amountMinutes: -480,
        effectiveDate: d('2027-04-02'),
        leaveRequestDayId: 'future2',
      },
      {
        amountMinutes: 480,
        effectiveDate: d('2027-04-02'),
        leaveRequestDayId: 'future2',
      },
    ];
    expect(summarizeBalance(entries, d('2027-03-01'))).toEqual({
      currentMinutes: 1920,
      scheduledMinutes: 480,
      availableMinutes: 1440,
    });
  });
});

describe('entitlement planning', () => {
  const run = (
    overrides: Partial<Parameters<typeof planEntitlements>[0]> & {
      policy: LeavePolicy;
    },
  ) =>
    // Most cases plan no reversals; tests of reversals inspect entryType explicitly.
    planEntitlements({
      accountId: 'acc',
      asOf: d('2027-12-31'),
      scanFrom: d('2027-01-01'),
      assignmentStart: d('2020-01-01'),
      assignmentEnd: null,
      policyAt: () => overrides.policy,
      entries: [],
      existingKeys: new Set(),
      ...overrides,
    }) as PlannedPosting[];

  it('grants once per leave year, prorated from eligibility when configured', () => {
    const grant = policy({
      accrualMethod: 'ANNUAL_GRANT',
      annualGrantMinutes: 7300,
      prorateFirstYear: true,
    });
    const postings = run({
      policy: grant,
      assignmentStart: d('2027-07-02'),
      scanFrom: d('2027-07-02'),
    });
    // 2027-07-02..2027-12-31 is 183 of 365 days: 7300 * 183 / 365 = 3660.
    expect(postings).toEqual([
      expect.objectContaining({
        entryType: 'GRANT',
        amountMinutes: 3660,
        effectiveDate: d('2027-07-02'),
        idempotencyKey: 'grant:acc:2027-01-01:2027-12-31',
      }),
    ]);
    const full = run({
      policy: { ...grant, prorateFirstYear: false },
      assignmentStart: d('2027-07-02'),
      scanFrom: d('2027-07-02'),
    });
    expect(full[0]!.amountMinutes).toBe(7300);
    // Already posted: nothing again.
    expect(
      run({
        policy: grant,
        existingKeys: new Set(['grant:acc:2027-01-01:2027-12-31']),
      }),
    ).toEqual([]);
  });

  it('caps grants at maxBalanceMinutes on the current balance, never counting future leave', () => {
    const grant = policy({
      accrualMethod: 'ANNUAL_GRANT',
      annualGrantMinutes: 2400,
      maxBalanceMinutes: 3000,
    });
    const at = (balance: number, extra: PlanEntry[] = []) =>
      run({
        policy: grant,
        entries: [
          ...(balance
            ? [
                {
                  amountMinutes: balance,
                  effectiveDate: d('2026-06-01'),
                  leaveRequestDayId: null,
                  idempotencyKey: 'adjustment:b',
                },
              ]
            : []),
          ...extra,
        ],
        asOf: d('2027-01-10'),
      }).map((p) => [p.entryType, p.amountMinutes, p.idempotencyKey]);
    // Below the cap: the whole grant.
    expect(at(0)).toEqual([['GRANT', 2400, 'grant:acc:2027-01-01:2027-12-31']]);
    // Partly capped: only up to the cap.
    expect(at(1000)).toEqual([
      ['GRANT', 2000, 'grant:acc:2027-01-01:2027-12-31'],
    ]);
    // Already at (or above) the cap: nothing.
    expect(at(3000)).toEqual([]);
    expect(at(3500)).toEqual([]);
    // Approved leave dated after the grant date does not make room for more entitlement.
    expect(
      at(3000, [
        {
          amountMinutes: -2000,
          effectiveDate: d('2027-06-01'),
          leaveRequestDayId: 'future',
          idempotencyKey: 'usage:future',
        },
      ]),
    ).toEqual([]);
    // Leave taken before the grant date does.
    expect(
      at(3000, [
        {
          amountMinutes: -480,
          effectiveDate: d('2026-12-15'),
          leaveRequestDayId: 'taken',
          idempotencyKey: 'usage:taken',
        },
      ]),
    ).toEqual([['GRANT', 480, 'grant:acc:2027-01-01:2027-12-31']]);
    // Retry: a posted (capped) grant is not posted again.
    const posted: PlanEntry[] = [
      {
        amountMinutes: 1000,
        effectiveDate: d('2026-06-01'),
        leaveRequestDayId: null,
        idempotencyKey: 'adjustment:b',
      },
      {
        id: 'g',
        amountMinutes: 2000,
        effectiveDate: d('2027-01-01'),
        leaveRequestDayId: null,
        idempotencyKey: 'grant:acc:2027-01-01:2027-12-31',
      },
    ];
    expect(
      run({
        policy: grant,
        entries: posted,
        existingKeys: new Set(posted.map((e) => e.idempotencyKey!)),
        asOf: d('2027-01-10'),
      }),
    ).toEqual([]);
  });

  it('grants once per entitlement period across policy versions and leave-year moves', () => {
    const v = (id: string, overrides: Partial<LeavePolicy>) =>
      policy({
        id,
        accrualMethod: 'ANNUAL_GRANT',
        annualGrantMinutes: 2400,
        ...overrides,
      });
    const grants = (
      versions: Array<{ until: Date | null; policy: LeavePolicy }>,
      options: {
        scanFrom?: Date;
        asOf: Date;
        assignmentStart?: Date;
        entries?: PlanEntry[];
      },
    ) =>
      run({
        policy: versions[0]!.policy,
        policyAt: (date) =>
          versions.find((x) => x.until === null || date <= x.until)!.policy,
        scanFrom: options.scanFrom ?? d('2027-01-01'),
        asOf: options.asOf,
        ...(options.assignmentStart
          ? { assignmentStart: options.assignmentStart }
          : {}),
        ...(options.entries
          ? {
              entries: options.entries,
              existingKeys: new Set(
                options.entries.map((e) => e.idempotencyKey!),
              ),
            }
          : {}),
      })
        .filter((p) => p.entryType === 'GRANT')
        .map((p) => [
          p.effectiveDate.toISOString().slice(0, 10),
          p.amountMinutes,
          p.idempotencyKey,
        ]);

    // A new policy version with the same leave year neither grants again nor re-decides.
    const sameYear = [
      {
        until: d('2027-06-30'),
        policy: v('v1', { effectiveTo: d('2027-06-30') }),
      },
      {
        until: null,
        policy: v('v2', {
          effectiveFrom: d('2027-07-01'),
          annualGrantMinutes: 1200,
        }),
      },
    ];
    expect(grants(sameYear, { asOf: d('2028-01-02') })).toEqual([
      ['2027-01-01', 2400, 'grant:acc:2027-01-01:2027-12-31'],
      ['2028-01-01', 1200, 'grant:acc:2028-01-01:2028-12-31'],
    ]);

    // The leave year moves from January to April mid-2027: the April 2027 year is the same
    // entitlement year as the January one (most of its days), so the next grant is April 2028.
    const moved = [
      {
        until: d('2027-06-30'),
        policy: v('v1', { effectiveTo: d('2027-06-30') }),
      },
      {
        until: null,
        policy: v('v2', {
          effectiveFrom: d('2027-07-01'),
          leaveYearStartMonth: 4,
        }),
      },
    ];
    const movedPlan = grants(moved, { asOf: d('2028-04-02') });
    expect(movedPlan).toEqual([
      ['2027-01-01', 2400, 'grant:acc:2027-01-01:2027-12-31'],
      ['2028-04-01', 2400, 'grant:acc:2028-04-01:2029-03-31'],
    ]);
    // Retry with what was posted: nothing more.
    const posted: PlanEntry[] = movedPlan.map(([date, amount, key], i) => ({
      id: `g${i}`,
      amountMinutes: amount as number,
      effectiveDate: d(date as string),
      leaveRequestDayId: null,
      idempotencyKey: key as string,
    }));
    expect(grants(moved, { asOf: d('2028-04-02'), entries: posted })).toEqual(
      [],
    );

    // And back from April to January: the 2027 calendar year mostly overlaps the April 2027
    // grant (no second grant), the 2028 calendar year mostly does not (granted on 1 January).
    const back = [
      {
        until: d('2027-09-30'),
        policy: v('v1', {
          leaveYearStartMonth: 4,
          effectiveTo: d('2027-09-30'),
        }),
      },
      { until: null, policy: v('v2', { effectiveFrom: d('2027-10-01') }) },
    ];
    expect(
      grants(back, { scanFrom: d('2027-04-01'), asOf: d('2028-01-02') }),
    ).toEqual([
      ['2027-04-01', 2400, 'grant:acc:2027-04-01:2028-03-31'],
      ['2028-01-01', 2400, 'grant:acc:2028-01-01:2028-12-31'],
    ]);

    // An assignment starting just before the year boundary gets its (prorated) first year and
    // the next year in full.
    const prorated = [
      { until: null, policy: v('v1', { prorateFirstYear: true }) },
    ];
    expect(
      grants(prorated, {
        scanFrom: d('2027-12-20'),
        assignmentStart: d('2027-12-20'),
        asOf: d('2028-01-02'),
      }),
    ).toEqual([
      [
        '2027-12-20',
        Math.round((2400 * 12) / 365),
        'grant:acc:2027-01-01:2027-12-31',
      ],
      ['2028-01-01', 2400, 'grant:acc:2028-01-01:2028-12-31'],
    ]);
  });

  it('accrues per completed period, prorating partial periods and capping the balance', () => {
    const monthly = policy({
      accrualMethod: 'PERIODIC',
      accrualFrequency: 'MONTHLY',
      accrualMinutesPerPeriod: 600,
    });
    const year = run({ policy: monthly, asOf: d('2027-04-01') });
    expect(year.map((p) => [p.idempotencyKey, p.amountMinutes])).toEqual([
      ['accrual:acc:p-org:2027-01-01', 600],
      ['accrual:acc:p-org:2027-02-01', 600],
      ['accrual:acc:p-org:2027-03-01', 600],
    ]);
    const capped = run({
      policy: { ...monthly, maxBalanceMinutes: 1000 },
      asOf: d('2027-04-01'),
    });
    expect(capped.map((p) => p.amountMinutes)).toEqual([600, 400]);
    const prorated = run({
      policy: { ...monthly, prorateFirstYear: true },
      assignmentStart: d('2027-01-16'),
      scanFrom: d('2027-01-16'),
      asOf: d('2027-02-01'),
    });
    expect(prorated).toEqual([
      expect.objectContaining({ amountMinutes: Math.round((600 * 16) / 31) }),
    ]);
    // An ended assignment accrues nothing after it ends.
    expect(
      run({
        policy: monthly,
        assignmentEnd: d('2027-01-31'),
        asOf: d('2027-06-01'),
      }),
    ).toHaveLength(1);
    const semi = run({
      policy: { ...monthly, accrualFrequency: 'SEMI_MONTHLY' },
      asOf: d('2027-02-01'),
    });
    expect(semi.map((p) => p.idempotencyKey)).toEqual([
      'accrual:acc:p-org:2027-01-01',
      'accrual:acc:p-org:2027-01-16',
    ]);
    const biweekly = run({
      policy: {
        ...monthly,
        accrualFrequency: 'BIWEEKLY',
        accrualAnchorDate: d('2026-12-28'),
      },
      asOf: d('2027-01-26'),
    });
    expect(biweekly.map((p) => p.idempotencyKey)).toEqual([
      'accrual:acc:p-org:2026-12-28',
      'accrual:acc:p-org:2027-01-11',
    ]);
  });

  it('splits a period at a policy change, prorating both sides, and at assignment end when prorating', () => {
    const first = policy({
      id: 'p-a',
      accrualMethod: 'PERIODIC',
      accrualFrequency: 'MONTHLY',
      accrualMinutesPerPeriod: 480,
      effectiveTo: d('2027-07-15'),
    });
    const second = policy({
      id: 'p-b',
      accrualMethod: 'PERIODIC',
      accrualFrequency: 'MONTHLY',
      accrualMinutesPerPeriod: 960,
      effectiveFrom: d('2027-07-16'),
    });
    const postings = run({
      policy: first,
      policyAt: (date) => (date <= d('2027-07-15') ? first : second),
      scanFrom: d('2027-07-01'),
      asOf: d('2027-08-01'),
    });
    expect(
      postings.map((p) => [
        p.idempotencyKey,
        p.amountMinutes,
        p.effectiveDate.toISOString().slice(0, 10),
      ]),
    ).toEqual([
      ['accrual:acc:p-a:2027-07-01', Math.round((480 * 15) / 31), '2027-07-15'],
      ['accrual:acc:p-b:2027-07-16', Math.round((960 * 16) / 31), '2027-07-31'],
    ]);
    // Without a successor, the ended policy still pays its part of the month.
    const alone = run({
      policy: first,
      policyAt: (date) => (date <= d('2027-07-15') ? first : null),
      scanFrom: d('2027-07-01'),
      asOf: d('2027-08-01'),
    });
    expect(alone.map((p) => p.amountMinutes)).toEqual([
      Math.round((480 * 15) / 31),
    ]);
    // An assignment ending mid-month: prorated only when the policy prorates partial periods.
    const monthly = policy({
      accrualMethod: 'PERIODIC',
      accrualFrequency: 'MONTHLY',
      accrualMinutesPerPeriod: 480,
    });
    expect(
      run({
        policy: monthly,
        assignmentEnd: d('2027-03-15'),
        scanFrom: d('2027-03-01'),
        asOf: d('2027-05-01'),
      }),
    ).toEqual([]);
    expect(
      run({
        policy: { ...monthly, prorateFirstYear: true },
        assignmentEnd: d('2027-03-15'),
        scanFrom: d('2027-03-01'),
        asOf: d('2027-05-01'),
      }).map((p) => p.amountMinutes),
    ).toEqual([Math.round((480 * 15) / 31)]);
  });

  it('trues up a year-end decision in its own direction when the closed year changes later', () => {
    const none = policy({ carryoverMode: 'NONE' });
    const entries: PlanEntry[] = [
      {
        amountMinutes: 600,
        effectiveDate: d('2026-01-01'),
        leaveRequestDayId: null,
        idempotencyKey: 'adjustment:x',
      },
      {
        amountMinutes: -600,
        effectiveDate: d('2027-01-01'),
        leaveRequestDayId: null,
        idempotencyKey: 'yearend:acc:2027-01-01',
      },
      // A December day cancelled after year end restores 480 minutes in the closed year.
      {
        amountMinutes: 480,
        effectiveDate: d('2026-12-20'),
        leaveRequestDayId: 'day',
        idempotencyKey: 'reversal:u',
      },
    ];
    const keys = new Set(entries.map((e) => e.idempotencyKey!));
    const postings = run({
      policy: none,
      entries,
      existingKeys: keys,
      scanFrom: d('2026-12-01'),
      asOf: d('2027-01-10'),
    });
    expect(postings).toEqual([
      expect.objectContaining({
        entryType: 'CARRYOVER_FORFEIT',
        amountMinutes: -480,
        idempotencyKey: 'yearend:acc:2027-01-01#1',
      }),
    ]);
    // Settled: nothing more on a rerun with the true-up posted.
    const after = [
      ...entries,
      {
        amountMinutes: -480,
        effectiveDate: d('2027-01-01'),
        leaveRequestDayId: null,
        idempotencyKey: 'yearend:acc:2027-01-01#1',
      },
    ];
    expect(
      run({
        policy: none,
        entries: after,
        existingKeys: new Set(after.map((e) => e.idempotencyKey!)),
        scanFrom: d('2026-12-01'),
        asOf: d('2027-01-10'),
      }),
    ).toEqual([]);
    // A later decrease (leave recorded after the fact in the closed year) is settled too:
    // the standing forfeits are reversed and the new amount (here none) is posted.
    const withIds: PlanEntry[] = after.map((e) =>
      e.idempotencyKey === 'yearend:acc:2027-01-01'
        ? { ...e, id: 'f1', entryType: 'CARRYOVER_FORFEIT' }
        : e.idempotencyKey === 'yearend:acc:2027-01-01#1'
          ? { ...e, id: 'f2', entryType: 'CARRYOVER_FORFEIT' }
          : e,
    );
    const lower: PlanEntry[] = [
      ...withIds,
      {
        amountMinutes: -2000,
        effectiveDate: d('2026-12-31'),
        leaveRequestDayId: 'late',
        idempotencyKey: 'usage:late',
      },
    ];
    const settled = run({
      policy: none,
      entries: lower,
      existingKeys: new Set(lower.map((e) => e.idempotencyKey!)),
      scanFrom: d('2026-12-01'),
      asOf: d('2027-01-10'),
    }) as unknown[];
    expect(settled).toEqual([
      expect.objectContaining({
        entryType: 'REVERSAL',
        reversesEntryId: 'f1',
        amountMinutes: 600,
        sourceType: 'YEAR_END',
      }),
      expect.objectContaining({
        entryType: 'REVERSAL',
        reversesEntryId: 'f2',
        amountMinutes: 480,
        sourceType: 'YEAR_END',
      }),
    ]);
    // A family reversed by hand is the administrator's and is left alone.
    const manual: PlanEntry[] = [
      ...lower,
      {
        id: 'r1',
        amountMinutes: 600,
        effectiveDate: d('2027-01-01'),
        leaveRequestDayId: null,
        idempotencyKey: 'reversal:f1',
        reversesEntryId: 'f1',
        sourceType: 'MANUAL',
        entryType: 'REVERSAL',
      },
    ];
    expect(
      run({
        policy: none,
        entries: manual,
        existingKeys: new Set(manual.map((e) => e.idempotencyKey!)),
        scanFrom: d('2026-12-01'),
        asOf: d('2027-01-10'),
      }),
    ).toEqual([]);
  });

  it('meets a carryover expiry longer than the grant/accrual lookback', () => {
    const capped = policy({
      carryoverMode: 'CAPPED',
      carryoverMaxMinutes: 960,
      carryoverExpiryDays: 450,
    });
    const entries: PlanEntry[] = [
      {
        amountMinutes: 2400,
        effectiveDate: d('2025-06-01'),
        leaveRequestDayId: null,
      },
    ];
    const plan = (yearEndScanFrom?: Date) =>
      run({
        policy: capped,
        entries,
        scanFrom: d('2027-02-15'),
        yearEndScanFrom,
        asOf: d('2027-03-28'),
      }).map((p) => [p.entryType, p.amountMinutes]);
    // Year start 2026-01-01 expires 2027-03-27; only the extended year-end scan reaches it.
    expect(plan()).toEqual([]);
    expect(plan(d('2025-12-01'))).toEqual([
      ['CARRYOVER_FORFEIT', -1440],
      ['EXPIRY', -960],
    ]);
  });

  it('forfeits above the carryover cap and expires unused carried minutes first-in-first-out', () => {
    const capped = policy({
      carryoverMode: 'CAPPED',
      carryoverMaxMinutes: 960,
      carryoverExpiryDays: 90,
    });
    const entries: PlanEntry[] = [
      {
        amountMinutes: 2400,
        effectiveDate: d('2026-01-01'),
        leaveRequestDayId: null,
      },
      // 240 minutes of leave taken within the carryover window consume carried minutes first.
      {
        amountMinutes: -240,
        effectiveDate: d('2027-02-01'),
        leaveRequestDayId: 'day',
      },
    ];
    const postings = run({
      policy: capped,
      entries,
      scanFrom: d('2026-12-01'),
      asOf: d('2027-06-01'),
    });
    expect(
      postings.map((p) => [
        p.entryType,
        p.amountMinutes,
        p.effectiveDate.toISOString().slice(0, 10),
      ]),
    ).toEqual([
      ['CARRYOVER_FORFEIT', -1440, '2027-01-01'],
      ['EXPIRY', -720, '2027-04-01'],
    ]);
    const none = run({
      policy: policy({ carryoverMode: 'NONE' }),
      entries,
      scanFrom: d('2026-12-01'),
      asOf: d('2027-01-01'),
    });
    expect(none).toEqual([
      expect.objectContaining({
        entryType: 'CARRYOVER_FORFEIT',
        amountMinutes: -2400,
      }),
    ]);
    // A negative balance carries forward; nothing is forfeited.
    expect(
      run({
        policy: capped,
        entries: [
          {
            amountMinutes: -100,
            effectiveDate: d('2026-06-01'),
            leaveRequestDayId: 'x',
          },
        ],
        scanFrom: d('2026-12-01'),
        asOf: d('2027-01-01'),
      }),
    ).toEqual([]);
  });
});

describe('leave-year balance checks', () => {
  const grant2026 = {
    amountMinutes: 2400,
    effectiveDate: d('2026-01-01'),
    leaveRequestDayId: null,
    idempotencyKey: 'grant:acc:2026-01-01:2026-12-31',
    entryType: 'GRANT',
  };
  const usage = (date: string, minutes: number) => ({
    amountMinutes: -minutes,
    effectiveDate: d(date),
    leaveRequestDayId: `day-${date}`,
    idempotencyKey: `usage:${date}`,
    entryType: 'USAGE',
  });
  const check = (
    p: Partial<LeavePolicy>,
    request: [string, number],
    entries: PlanEntry[] = [grant2026],
  ) =>
    leaveYearBalanceCheck({
      accountId: 'acc',
      entries,
      candidate: [
        {
          amountMinutes: -request[1],
          effectiveDate: d(request[0]),
          leaveRequestDayId: 'candidate',
        },
      ],
      today: d('2026-10-05'),
      policyAt: () => policy(p),
    });

  it('checks this year against this year and next year against what carries into it', () => {
    // Current year: the posted 2026 balance.
    expect(check({ carryoverMode: 'NONE' }, ['2026-11-02', 480])).toMatchObject(
      {
        leaveYear: { start: d('2026-01-01'), end: d('2026-12-31') },
        availableMinutes: 2400,
        availableAfterMinutes: 1920,
        sufficient: true,
      },
    );
    // Next year: only what the year end lets through, never the forfeited 2026 balance.
    expect(
      check({ carryoverMode: 'UNLIMITED' }, ['2027-03-08', 480]),
    ).toMatchObject({ availableMinutes: 2400, sufficient: true });
    expect(
      check({ carryoverMode: 'CAPPED', carryoverMaxMinutes: 960 }, [
        '2027-03-08',
        480,
      ]),
    ).toMatchObject({ availableMinutes: 960, sufficient: true });
    expect(check({ carryoverMode: 'NONE' }, ['2027-03-08', 480])).toMatchObject(
      {
        leaveYear: { start: d('2027-01-01'), end: d('2027-12-31') },
        availableMinutes: 0,
        sufficient: false,
      },
    );
    // ...unless the policy allows booking ahead into a negative balance, in that year.
    expect(
      check({ carryoverMode: 'NONE', negativeBalanceLimitMinutes: 480 }, [
        '2027-03-08',
        480,
      ]),
    ).toMatchObject({
      availableAfterMinutes: -480,
      sufficient: true,
    });
    // Once next year's grant is posted, it covers next year's leave.
    expect(
      check(
        { carryoverMode: 'NONE' },
        ['2027-03-08', 480],
        [
          grant2026,
          {
            amountMinutes: 2400,
            effectiveDate: d('2027-01-01'),
            leaveRequestDayId: null,
            idempotencyKey: 'grant:acc:2027-01-01:2027-12-31',
            entryType: 'GRANT',
          },
        ],
      ),
    ).toMatchObject({ availableMinutes: 2400, sufficient: true });
  });

  it('charges approved leave to its own year and protects committed future years', () => {
    // Approved December leave reduces what carries into next year.
    expect(
      check(
        { carryoverMode: 'UNLIMITED' },
        ['2027-03-08', 960],
        [grant2026, usage('2026-12-14', 1920)],
      ),
    ).toMatchObject({
      availableMinutes: 480,
      sufficient: false,
    });
    // With unlimited carryover, this year's leave would leave an approved next-year booking
    // short, so it is refused; with no carryover the years are independent.
    const committed = [grant2026, usage('2027-03-08', 2400)];
    expect(
      check({ carryoverMode: 'UNLIMITED' }, ['2026-11-02', 480], committed),
    ).toMatchObject({
      availableMinutes: 2400,
      sufficient: false,
    });
    expect(
      check(
        { carryoverMode: 'NONE', negativeBalanceLimitMinutes: 2400 },
        ['2026-11-02', 480],
        committed,
      ),
    ).toMatchObject({
      sufficient: true,
    });
  });

  it('lets carried minutes cover leave only before they expire', () => {
    const capped = {
      carryoverMode: 'CAPPED' as const,
      carryoverMaxMinutes: 960,
      carryoverExpiryDays: 90,
    };
    // 960 carry into 2027 and expire on 2027-04-01 unless used first.
    expect(check(capped, ['2027-02-01', 480])).toMatchObject({
      availableMinutes: 0,
      availableAfterMinutes: 0,
      sufficient: true,
    });
    expect(check(capped, ['2027-06-01', 480])).toMatchObject({
      availableAfterMinutes: -480,
      sufficient: false,
    });
  });
});

describe('Time absence trimming', () => {
  const expected = {
    employmentAssignmentId: 'a-1',
    expectedStart: '2027-03-02T14:00:00.000Z',
    expectedEnd: '2027-03-02T22:00:00.000Z',
    sourceType: 'SCHEDULE' as const,
  };
  const absence = (
    start: string,
    end: string,
    assignment: string | null = 'a-1',
  ) => ({
    employeeId: 'e',
    employmentAssignmentId: assignment,
    start,
    end,
    sourceId: 'x',
  });

  it('moves only the covered bound and keeps the rest of the expectation', () => {
    expect(
      trimExpectedWorkForAbsences(expected, [
        absence('2027-03-02T14:00:00Z', '2027-03-02T16:00:00Z'),
      ]),
    ).toEqual({
      expectedStart: '2027-03-02T16:00:00.000Z',
      expectedEnd: '2027-03-02T22:00:00.000Z',
    });
    expect(
      trimExpectedWorkForAbsences(expected, [
        absence('2027-03-02T20:00:00Z', '2027-03-02T23:00:00Z'),
      ]),
    ).toEqual({
      expectedStart: '2027-03-02T14:00:00.000Z',
      expectedEnd: '2027-03-02T20:00:00.000Z',
    });
    // A mid-day absence changes neither bound.
    expect(
      trimExpectedWorkForAbsences(expected, [
        absence('2027-03-02T17:00:00Z', '2027-03-02T18:00:00Z'),
      ]),
    ).toEqual({
      expectedStart: expected.expectedStart,
      expectedEnd: expected.expectedEnd,
    });
  });

  it('removes a fully covered expectation and ignores other assignments', () => {
    expect(
      trimExpectedWorkForAbsences(expected, [
        absence('2027-03-02T05:00:00Z', '2027-03-03T05:00:00Z'),
      ]),
    ).toBeNull();
    expect(
      trimExpectedWorkForAbsences(expected, [
        absence('2027-03-02T05:00:00Z', '2027-03-03T05:00:00Z', 'a-2'),
      ]),
    ).toEqual({
      expectedStart: expected.expectedStart,
      expectedEnd: expected.expectedEnd,
    });
    // Adjacent absences chain.
    expect(
      trimExpectedWorkForAbsences(expected, [
        absence('2027-03-02T16:00:00Z', '2027-03-02T18:00:00Z'),
        absence('2027-03-02T14:00:00Z', '2027-03-02T16:00:00Z'),
      ]),
    ).toEqual({
      expectedStart: '2027-03-02T18:00:00.000Z',
      expectedEnd: expected.expectedEnd,
    });
  });
});
