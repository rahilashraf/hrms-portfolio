import type { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  ageOn,
  assertCoverageMatchesDependents,
  clipRange,
  dateInRange,
  dependentEligibleOn,
  enrollmentStatusOn,
  evaluateEligibility,
  serviceDaysOn,
  parseBenefitAmount,
  parseBenefitCode,
  parseBenefitCurrency,
  parseBenefitRange,
  rangeContains,
  rangesOverlap,
} from './benefits-domain.js';

const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('Benefits domain', () => {
  describe('parsing', () => {
    it('normalizes codes and refuses malformed ones', () => {
      expect(parseBenefitCode(' health-basic ')).toBe('HEALTH-BASIC');
      expect(code(() => parseBenefitCode('x'))).toBe('BENEFIT_CODE_INVALID');
      expect(code(() => parseBenefitCode('has space'))).toBe(
        'BENEFIT_CODE_INVALID',
      );
      expect(code(() => parseBenefitCode(42))).toBe('BENEFIT_CODE_INVALID');
    });

    it('accepts ISO currencies only', () => {
      expect(parseBenefitCurrency('cad')).toBe('CAD');
      expect(code(() => parseBenefitCurrency('XYZ'))).toBe(
        'BENEFIT_CURRENCY_INVALID',
      );
    });

    it('parses non-negative amounts with two decimals, zero included', () => {
      expect(parseBenefitAmount('0', 'employeeAmount')).toBe('0.00');
      expect(parseBenefitAmount('12.5', 'employeeAmount')).toBe('12.50');
      expect(parseBenefitAmount(7, 'employeeAmount')).toBe('7.00');
      expect(parseBenefitAmount('0012.30', 'x')).toBe('12.30');
      for (const bad of ['-1', '1.234', 'abc', '', '1e3']) {
        expect(code(() => parseBenefitAmount(bad, 'x'))).toBe(
          'BENEFIT_AMOUNT_INVALID',
        );
      }
    });

    it('validates inclusive date ranges', () => {
      expect(parseBenefitRange('2026-01-01', null)).toEqual({
        from: d('2026-01-01'),
        to: null,
      });
      expect(parseBenefitRange('2026-01-01', '2026-01-01').to).toEqual(
        d('2026-01-01'),
      );
      expect(code(() => parseBenefitRange('2026-01-02', '2026-01-01'))).toBe(
        'BENEFIT_DATE_RANGE_INVALID',
      );
    });
  });

  describe('ranges', () => {
    const jan = { from: d('2026-01-01'), to: d('2026-01-31') };
    const open = { from: d('2026-01-31'), to: null };
    it('detects overlap including shared boundary days', () => {
      expect(rangesOverlap(jan, open)).toBe(true);
      expect(rangesOverlap(jan, { from: d('2026-02-01'), to: null })).toBe(
        false,
      );
      expect(rangesOverlap({ from: d('2025-01-01'), to: null }, jan)).toBe(
        true,
      );
    });
    it('clips and contains', () => {
      expect(clipRange(open, jan)).toEqual({
        from: d('2026-01-31'),
        to: d('2026-01-31'),
      });
      expect(clipRange({ from: d('2026-03-01'), to: null }, jan)).toBeNull();
      expect(rangeContains({ from: d('2026-01-01'), to: null }, jan)).toBe(
        true,
      );
      expect(rangeContains(jan, open)).toBe(false);
      expect(dateInRange(d('2026-01-31'), jan)).toBe(true);
      expect(dateInRange(d('2026-02-01'), jan)).toBe(false);
    });
  });

  describe('dependents', () => {
    const child = (dob: string) => ({
      relationship: 'CHILD' as const,
      dateOfBirth: d(dob),
      relationshipStartDate: null,
      relationshipEndDate: null,
    });
    it('computes ages with leap-day birthdays', () => {
      expect(ageOn(d('2008-02-29'), d('2026-02-28'))).toBe(17);
      expect(ageOn(d('2008-02-29'), d('2026-03-01'))).toBe(18);
      expect(ageOn(d('2000-06-15'), d('2026-06-15'))).toBe(26);
      expect(ageOn(d('2000-06-15'), d('2026-06-14'))).toBe(25);
    });
    it('applies the child age limit inclusively', () => {
      expect(
        dependentEligibleOn(child('2000-06-15'), d('2026-06-14'), 25),
      ).toBe(true);
      expect(
        dependentEligibleOn(child('2000-06-15'), d('2026-06-15'), 25),
      ).toBe(false);
      expect(
        dependentEligibleOn(child('2000-06-15'), d('2026-06-15'), null),
      ).toBe(true);
      expect(
        dependentEligibleOn(child('2030-01-01'), d('2026-06-15'), null),
      ).toBe(false);
    });
    it('respects relationship dates', () => {
      const spouse = {
        relationship: 'SPOUSE' as const,
        dateOfBirth: null,
        relationshipStartDate: d('2026-02-01'),
        relationshipEndDate: d('2026-08-31'),
      };
      expect(dependentEligibleOn(spouse, d('2026-01-31'), null)).toBe(false);
      expect(dependentEligibleOn(spouse, d('2026-02-01'), null)).toBe(true);
      expect(dependentEligibleOn(spouse, d('2026-08-31'), null)).toBe(true);
      expect(dependentEligibleOn(spouse, d('2026-09-01'), null)).toBe(false);
    });
    it('matches covered dependents to the coverage level', () => {
      const ok = (
        level: Parameters<typeof assertCoverageMatchesDependents>[0],
        rels: Parameters<typeof assertCoverageMatchesDependents>[1],
      ) => code(() => assertCoverageMatchesDependents(level, rels));
      expect(ok('EMPLOYEE_ONLY', [])).toBe('NO_ERROR');
      expect(ok('EMPLOYEE_ONLY', ['CHILD'])).toBe(
        'BENEFIT_DEPENDENTS_MISMATCH',
      );
      expect(ok('EMPLOYEE_SPOUSE', ['SPOUSE'])).toBe('NO_ERROR');
      expect(ok('EMPLOYEE_SPOUSE', ['SPOUSE', 'CHILD'])).toBe(
        'BENEFIT_DEPENDENTS_MISMATCH',
      );
      expect(ok('EMPLOYEE_SPOUSE', [])).toBe('BENEFIT_DEPENDENTS_MISMATCH');
      expect(ok('EMPLOYEE_CHILDREN', ['CHILD', 'CHILD'])).toBe('NO_ERROR');
      expect(ok('EMPLOYEE_CHILDREN', ['CHILD', 'SPOUSE'])).toBe(
        'BENEFIT_DEPENDENTS_MISMATCH',
      );
      expect(ok('FAMILY', ['SPOUSE', 'CHILD', 'OTHER'])).toBe('NO_ERROR');
      expect(ok('FAMILY', [])).toBe('BENEFIT_DEPENDENTS_MISMATCH');
      expect(ok('FAMILY', ['SPOUSE', 'SPOUSE'])).toBe(
        'BENEFIT_DEPENDENTS_MISMATCH',
      );
      expect(ok('CUSTOM', [])).toBe('NO_ERROR');
    });
  });

  describe('enrollment status', () => {
    const record = (
      overrides: Partial<Parameters<typeof enrollmentStatusOn>[0]> = {},
    ) => ({
      electionType: 'ENROLLED' as const,
      coverageStart: d('2026-03-01'),
      coverageEnd: d('2026-03-31') as Date | null,
      supersededAt: null as Date | null,
      ...overrides,
    });
    it('derives pending, active and ended from the dates (boundaries inclusive)', () => {
      expect(enrollmentStatusOn(record(), d('2026-02-28'))).toBe('PENDING');
      expect(enrollmentStatusOn(record(), d('2026-03-01'))).toBe('ACTIVE');
      expect(enrollmentStatusOn(record(), d('2026-03-31'))).toBe('ACTIVE');
      expect(enrollmentStatusOn(record(), d('2026-04-01'))).toBe('ENDED');
      expect(
        enrollmentStatusOn(record({ coverageEnd: null }), d('2099-01-01')),
      ).toBe('ACTIVE');
    });
    it('reports waivers and superseded segments', () => {
      expect(
        enrollmentStatusOn(record({ electionType: 'WAIVED' }), d('2026-03-10')),
      ).toBe('WAIVED');
      expect(
        enrollmentStatusOn(
          record({ supersededAt: new Date() }),
          d('2026-03-10'),
        ),
      ).toBe('SUPERSEDED');
    });
  });

  describe('eligibility', () => {
    const assignment: Parameters<typeof evaluateEligibility>[0]['assignment'] =
      {
        status: 'ACTIVE',
        startDate: d('2026-01-01'),
        endDate: null as Date | null,
        employmentType: 'FULL_TIME',
        organizationId: 'org',
        unitPathIds: ['child', 'root'],
        departmentId: 'dept',
        positionId: 'pos',
        hireDate: d('2026-01-01'),
      };
    const plan = {
      organizationId: 'org',
      effectiveFrom: d('2026-01-01'),
      effectiveTo: null,
    };
    const rule = (overrides: Record<string, unknown> = {}) => ({
      id: 'r1',
      effectiveFrom: d('2026-01-01'),
      effectiveTo: null,
      organizationalUnitId: null,
      includeSubunits: true,
      departmentId: null,
      positionId: null,
      employmentTypes: [] as string[],
      minimumServiceDays: null,
      ...overrides,
    });
    const run = (
      rules: ReturnType<typeof rule>[],
      date = '2026-06-01',
      a = assignment,
    ) => evaluateEligibility({ assignment: a, plan, rules, date: d(date) });

    it('offers a plan without rules to every live assignment of its organization', () => {
      expect(run([])).toMatchObject({ eligible: true, reasons: [] });
      expect(
        run([], '2026-06-01', { ...assignment, organizationId: 'other' })
          .reasons,
      ).toEqual(['OTHER_ORGANIZATION']);
      expect(
        run([], '2026-06-01', { ...assignment, status: 'CANCELLED' }).reasons,
      ).toEqual(['ASSIGNMENT_NOT_ACTIVE']);
      expect(
        run([], '2026-06-01', { ...assignment, endDate: d('2026-05-31') })
          .reasons,
      ).toEqual(['ASSIGNMENT_NOT_ACTIVE']);
      expect(run([], '2025-12-31').reasons).toEqual(
        expect.arrayContaining(['ASSIGNMENT_NOT_ACTIVE', 'PLAN_NOT_IN_EFFECT']),
      );
    });

    it('ANDs criteria within a rule and ORs rules', () => {
      expect(
        run([rule({ departmentId: 'dept', employmentTypes: ['FULL_TIME'] })])
          .eligible,
      ).toBe(true);
      const miss = run([
        rule({ departmentId: 'dept', employmentTypes: ['PART_TIME'] }),
      ]);
      expect(miss).toMatchObject({
        eligible: false,
        reasons: ['NO_MATCHING_RULE'],
      });
      expect(miss.rules[0]!.failed).toEqual(['EMPLOYMENT_TYPE']);
      const either = run([
        rule({ id: 'a', positionId: 'other' }),
        rule({ id: 'b', organizationalUnitId: 'root' }),
      ]);
      expect(either).toMatchObject({ eligible: true, matchedRuleIds: ['b'] });
    });

    it('matches units with or without sub-units', () => {
      expect(run([rule({ organizationalUnitId: 'root' })]).eligible).toBe(true);
      expect(
        run([rule({ organizationalUnitId: 'root', includeSubunits: false })])
          .eligible,
      ).toBe(false);
      expect(
        run([rule({ organizationalUnitId: 'child', includeSubunits: false })])
          .eligible,
      ).toBe(true);
    });

    it('counts service from the hire date and respects rule dates', () => {
      expect(serviceDaysOn(d('2026-01-01'), d('2026-01-01'))).toBe(1);
      expect(serviceDaysOn(d('2026-01-01'), d('2026-03-31'))).toBe(90);
      expect(
        run([rule({ minimumServiceDays: 90 })], '2026-03-30').eligible,
      ).toBe(false);
      expect(
        run([rule({ minimumServiceDays: 90 })], '2026-03-31').eligible,
      ).toBe(true);
      const ended = rule({ effectiveTo: d('2026-03-31') });
      expect(run([ended], '2026-03-31').eligible).toBe(true);
      expect(run([ended], '2026-04-01').reasons).toEqual(['NO_RULE_IN_EFFECT']);
    });
  });
});
