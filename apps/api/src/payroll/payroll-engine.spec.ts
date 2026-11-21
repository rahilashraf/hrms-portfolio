import { describe, expect, it } from 'vitest';
import type { PayrollCompensationFact } from '../compensation/compensation-integration.contracts.js';
import type { PayrollLeaveFact } from '../leave/leave-payroll.source.js';
import type { PayrollApprovedTimeOutput } from '../time/time-integration.contracts.js';
import {
  calculate,
  canonicalJson,
  type AssignmentSources,
  type EngineInput,
} from './payroll-engine.js';

const PG = 'pay-group-1';
const fact = (
  overrides: Partial<PayrollCompensationFact> = {},
): PayrollCompensationFact => ({
  compensationRecordId: 'comp-1',
  employmentAssignmentId: 'asg-1',
  payBasis: 'HOURLY',
  rateAmount: '24.5000',
  salaryArrangement: null,
  salaryMonthlyAmount: null,
  salaryPaidMonths: null,
  salaryContractAmount: null,
  salaryPeriodStart: null,
  salaryPeriodEnd: null,
  currency: 'CAD',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  payGroupId: PG,
  ...overrides,
});
const work = (
  workDate: string,
  minutes: number,
  overrides: Partial<PayrollApprovedTimeOutput> = {},
): PayrollApprovedTimeOutput => ({
  employeeId: 'emp-1',
  employmentAssignmentId: 'asg-1',
  timePeriodId: 'tp-1',
  workDate,
  approvedWorkedMinutes: minutes,
  grossMinutes: minutes,
  paidBreakMinutes: 0,
  unpaidBreakMinutes: 0,
  policyDeductionMinutes: 0,
  finalizationStatus: 'APPROVED',
  timesheetId: 'ts-1',
  timesheetSegmentId: 'seg-1',
  timesheetVersion: 1,
  ...overrides,
});
const leave = (
  date: string,
  minutes: number,
  classification: 'PAID' | 'UNPAID',
  id = `day-${date}`,
): PayrollLeaveFact => ({
  leaveRequestId: 'req-1',
  leaveRequestDayId: id,
  leaveTypeId: 'type-1',
  leaveTypeCode: classification === 'PAID' ? 'VAC' : 'LOA',
  classification,
  employmentAssignmentId: 'asg-1',
  date,
  minutes,
  scheduledShiftRevisionIds: [],
});
const days = (
  from: string,
  to: string,
  mode: 'TIME_CLOCK' | 'SIGN_IN_ONLY' = 'TIME_CLOCK',
) => {
  const out = [];
  for (
    let d = new Date(`${from}T00:00:00Z`);
    d <= new Date(`${to}T00:00:00Z`);
    d = new Date(d.getTime() + 86_400_000)
  ) {
    out.push({ date: d.toISOString().slice(0, 10), trackingMode: mode });
  }
  return out;
};
const sources = (
  overrides: Partial<AssignmentSources> = {},
  timeOverrides: Partial<AssignmentSources['time']> = {},
): AssignmentSources => ({
  employment: {
    employmentAssignmentId: 'asg-1',
    employeeId: 'emp-1',
    employeeNumber: 'E-1',
    displayName: 'Ada Lovelace',
    employeeStatus: 'ACTIVE',
    hireDate: '2026-01-01',
    terminationDate: null,
    positionId: 'pos-1',
    positionName: 'Counsellor',
    organizationId: 'org-1',
    employmentType: 'FULL_TIME',
    assignmentStatus: 'ACTIVE',
    startDate: '2026-01-01',
    endDate: null,
  },
  compensation: [fact()],
  timesheet: {
    timesheetId: 'ts-1',
    employeeId: 'emp-1',
    timePeriodId: 'tp-1',
    status: 'APPROVED',
    version: 1,
    finalizationStatus: 'APPROVED',
    workDates: [],
    segments: [
      {
        timesheetSegmentId: 'seg-1',
        employmentAssignmentId: 'asg-1',
        status: 'APPROVED',
      },
    ],
  },
  time: {
    timezone: 'America/Toronto',
    days: days('2026-10-04', '2026-10-17'),
    closedEntries: 0,
    openEntries: 0,
    ...timeOverrides,
  },
  leave: [],
  presence: [],
  expectedWork: { shifts: 0, scheduledMinutes: 0 },
  ...overrides,
});
const input = (
  assignments: AssignmentSources[],
  overrides: Partial<EngineInput> = {},
): EngineInput => ({
  currency: 'CAD',
  payGroupId: PG,
  period: {
    periodStart: '2026-10-04',
    periodEnd: '2026-10-17',
    cadence: 'BIWEEKLY',
  },
  salaryUnpaidLeaveRule: 'UNCONFIGURED',
  salaryStandardAnnualHours: null,
  assignments,
  ...overrides,
});
const withTime = (
  outputs: PayrollApprovedTimeOutput[],
  extra: Partial<AssignmentSources> = {},
) => {
  const base = sources(extra);
  return { ...base, timesheet: { ...base.timesheet!, workDates: outputs } };
};
const one = (s: AssignmentSources, overrides: Partial<EngineInput> = {}) =>
  calculate(input([s], overrides)).assignments[0]!;
const codes = (result: ReturnType<typeof one>) =>
  result.issues.map((issue) => `${issue.severity}:${issue.code}`);
const amounts = (result: ReturnType<typeof one>) =>
  result.lines.map((line) => [line.type, line.amount]);

describe('Payroll gross engine', () => {
  describe('hourly', () => {
    it('pays approved minutes at the rate effective on each work date', () => {
      const result = one(
        withTime([work('2026-10-05', 480), work('2026-10-06', 450)]),
      );
      expect(result.blocked).toBe(false);
      expect(result.lines).toEqual([
        expect.objectContaining({
          type: 'REGULAR_HOURLY',
          workDate: '2026-10-05',
          quantity: '480',
          quantityUnit: 'MINUTES',
          rateAmount: '24.5000',
          amount: '196.00',
          description: 'Regular hourly 2026-10-05: 8.00 h x 24.5000',
          calculationRule: 'HOURLY_REGULAR',
          compensationRecordId: 'comp-1',
          timeKey: 'seg-1:2026-10-05',
        }),
        expect.objectContaining({ workDate: '2026-10-06', amount: '183.75' }),
      ]);
      expect(result.grossAmount).toBe('379.75');
    });

    it('rounds each line half-up to cents with decimal arithmetic', () => {
      // 20 minutes x 24.50 = 8.1666… → 8.17; 0.1 + 0.2 floating point never appears.
      expect(amounts(one(withTime([work('2026-10-05', 20)])))).toEqual([
        ['REGULAR_HOURLY', '8.17'],
      ]);
      const precise = one(
        withTime([work('2026-10-05', 1)], {
          compensation: [fact({ rateAmount: '0.3000' })],
        }),
      );
      expect(precise.lines[0]!.amount).toBe('0.01');
    });

    it('splits pay at a mid-period rate change', () => {
      const result = one(
        withTime([work('2026-10-08', 480), work('2026-10-12', 480)], {
          compensation: [
            fact({ effectiveTo: '2026-10-09' }),
            fact({
              compensationRecordId: 'comp-2',
              rateAmount: '26.0000',
              effectiveFrom: '2026-10-10',
            }),
          ],
        }),
      );
      expect(
        result.lines.map((line) => [
          line.workDate,
          line.rateAmount,
          line.amount,
          line.compensationRecordId,
        ]),
      ).toEqual([
        ['2026-10-08', '24.5000', '196.00', 'comp-1'],
        ['2026-10-12', '26.0000', '208.00', 'comp-2'],
      ]);
      expect(codes(result)).toContain('WARNING:MID_PERIOD_COMPENSATION_CHANGE');
    });

    it('pays paid leave from frozen leave minutes and never pays unpaid leave', () => {
      const result = one(
        withTime([work('2026-10-05', 480)], {
          leave: [
            leave('2026-10-06', 480, 'PAID'),
            leave('2026-10-07', 480, 'UNPAID'),
          ],
        }),
      );
      expect(amounts(result)).toEqual([
        ['REGULAR_HOURLY', '196.00'],
        ['PAID_LEAVE', '196.00'],
      ]);
      expect(result.lines[1]).toMatchObject({
        leaveRequestDayId: 'day-2026-10-06',
        calculationRule: 'HOURLY_PAID_LEAVE',
      });
    });

    it('blocks hourly pay on sign-in-only attendance, which has no duration', () => {
      const result = one(
        sources({}, { days: days('2026-10-04', '2026-10-17', 'SIGN_IN_ONLY') }),
      );
      expect(result.blocked).toBe(true);
      expect(codes(result)).toContain('ERROR:HOURLY_SIGN_IN_ONLY_UNSUPPORTED');
      expect(result.lines).toEqual([]);
    });

    it('requires final timesheets when time exists, and accepts a period without time', () => {
      const notFinal = sources({
        timesheet: {
          ...sources().timesheet!,
          status: 'SUBMITTED',
          finalizationStatus: null,
        },
      });
      expect(codes(one(notFinal))).toContain('ERROR:TIMESHEET_NOT_FINAL');
      expect(
        codes(one(sources({ timesheet: null }, { closedEntries: 3 }))),
      ).toContain('ERROR:MISSING_TIMESHEET');
      expect(codes(one(sources({}, { openEntries: 1 })))).toContain(
        'ERROR:TIMESHEET_NOT_FINAL',
      );
      const none = one(sources({ timesheet: null }));
      expect(none.blocked).toBe(false);
      expect(codes(none)).toEqual(['INFO:NO_TIME_RECORDED']);
      expect(none.grossAmount).toBe('0.00');
    });

    it('never pays schedules: scheduled work without approved time is a warning only', () => {
      const result = one(
        sources({ expectedWork: { shifts: 5, scheduledMinutes: 2400 } }),
      );
      expect(result.lines).toEqual([]);
      expect(codes(result)).toContain(
        'WARNING:SCHEDULED_WITHOUT_APPROVED_TIME',
      );
    });

    it('needs a resolvable timezone for hourly time', () => {
      expect(codes(one(sources({}, { timezone: null })))).toContain(
        'ERROR:UNRESOLVED_TIMEZONE',
      );
    });
  });

  describe('salary', () => {
    const salary = (overrides: Partial<PayrollCompensationFact> = {}) =>
      fact({
        payBasis: 'SALARY',
        rateAmount: '52000.0000',
        salaryArrangement: 'ANNUAL',
        ...overrides,
      });

    it('periodizes the annual salary by cadence', () => {
      expect(amounts(one(sources({ compensation: [salary()] })))).toEqual([
        ['REGULAR_SALARY', '2000.00'],
      ]);
      const monthly = one(sources({ compensation: [salary()] }), {
        period: {
          periodStart: '2026-10-01',
          periodEnd: '2026-10-31',
          cadence: 'MONTHLY',
        },
      });
      expect(monthly.lines[0]).toMatchObject({
        amount: '4333.33',
        rateAmount: '4333.3333',
        quantity: '31',
      });
      const weekly = one(sources({ compensation: [salary()] }), {
        period: {
          periodStart: '2026-10-04',
          periodEnd: '2026-10-10',
          cadence: 'WEEKLY',
        },
      });
      expect(weekly.lines[0]!.amount).toBe('1000.00');
      const semi = one(sources({ compensation: [salary()] }), {
        period: {
          periodStart: '2026-10-16',
          periodEnd: '2026-10-31',
          cadence: 'SEMIMONTHLY',
        },
      });
      expect(semi.lines[0]!.amount).toBe('2166.67');
    });

    it('pays fixed-period monthly salary only for whole monthly pay periods', () => {
      const fixed = salary({
        rateAmount: '4000.0000',
        salaryArrangement: 'FIXED_PERIOD',
        salaryMonthlyAmount: '4000.0000',
        salaryPaidMonths: 10,
        salaryContractAmount: '40000.0000',
        salaryPeriodStart: '2026-09-01',
        salaryPeriodEnd: '2027-06-30',
        effectiveFrom: '2026-09-01',
        effectiveTo: '2027-06-30',
      });
      const result = one(sources({ compensation: [fixed] }), {
        period: {
          periodStart: '2026-10-01',
          periodEnd: '2026-10-31',
          cadence: 'MONTHLY',
        },
      });
      expect(result.blocked).toBe(false);
      expect(result.lines[0]).toMatchObject({
        amount: '4000.00',
        rateAmount: '4000.0000',
        calculationRule: 'FIXED_PERIOD_SALARY_MONTHLY',
        sourceDates: expect.arrayContaining(['2026-10-01', '2026-10-31']),
      });

      const biweekly = one(sources({ compensation: [fixed] }));
      expect(biweekly.blocked).toBe(true);
      expect(codes(biweekly)).toContain(
        'ERROR:FIXED_PERIOD_SALARY_MONTHLY_UNSUPPORTED',
      );
    });

    it('spreads contract-total salary by cadence with final-period remainder', () => {
      const contract = salary({
        rateAmount: '1000.0000',
        salaryArrangement: 'CONTRACT_TOTAL',
        salaryContractAmount: '1000.0000',
        salaryPeriodStart: '2026-10-04',
        salaryPeriodEnd: '2026-10-24',
        effectiveFrom: '2026-10-04',
        effectiveTo: '2026-10-24',
      });
      const first = one(sources({ compensation: [contract] }), {
        period: {
          periodStart: '2026-10-04',
          periodEnd: '2026-10-10',
          cadence: 'WEEKLY',
        },
      });
      expect(first.lines[0]).toMatchObject({
        amount: '333.33',
        rateAmount: '333.3300',
        calculationRule: 'CONTRACT_TOTAL_PERIODIZATION',
      });
      const last = one(sources({ compensation: [contract] }), {
        period: {
          periodStart: '2026-10-18',
          periodEnd: '2026-10-24',
          cadence: 'WEEKLY',
        },
      });
      expect(last.lines[0]).toMatchObject({
        amount: '333.34',
        rateAmount: '333.3400',
      });
      expect(last.lines[0]!.description).toContain('final remainder');
    });

    it('rejects contracted salary partial periods instead of prorating silently', () => {
      const contract = salary({
        rateAmount: '1000.0000',
        salaryArrangement: 'CONTRACT_TOTAL',
        salaryContractAmount: '1000.0000',
        salaryPeriodStart: '2026-10-05',
        salaryPeriodEnd: '2026-10-17',
        effectiveFrom: '2026-10-05',
        effectiveTo: '2026-10-17',
      });
      const result = one(sources({ compensation: [contract] }));
      expect(result.blocked).toBe(true);
      expect(codes(result)).toContain(
        'ERROR:CONTRACTED_SALARY_PARTIAL_PERIOD_UNSUPPORTED',
      );
      expect(codes(result)).toContain(
        'ERROR:CONTRACT_TOTAL_PERIOD_ALIGNMENT_INVALID',
      );
    });

    it('prorates by calendar days for a mid-period hire and termination', () => {
      const hired = one(
        sources({
          compensation: [salary({ effectiveFrom: '2026-10-09' })],
          employment: { ...sources().employment, startDate: '2026-10-09' },
        }),
      );
      // 2000 x 9/14 = 1285.714… → 1285.71
      expect(hired.lines[0]).toMatchObject({
        amount: '1285.71',
        quantity: '9',
        quantityUnit: 'CALENDAR_DAYS',
        periodFrom: '2026-10-09',
        periodTo: '2026-10-17',
      });
      expect(hired.lines[0]!.description).toContain('partial period');
      expect(codes(hired)).toContain('WARNING:HIRED_DURING_PERIOD');
      const terminated = one(
        sources({
          compensation: [salary({ effectiveTo: '2026-10-07' })],
          employment: { ...sources().employment, endDate: '2026-10-07' },
        }),
      );
      expect(terminated.lines[0]).toMatchObject({
        amount: '571.43',
        quantity: '4',
      });
      expect(codes(terminated)).toContain('WARNING:TERMINATED_DURING_PERIOD');
    });

    it('splits a mid-period salary change into components', () => {
      const result = one(
        sources({
          compensation: [
            salary({ effectiveTo: '2026-10-10' }),
            salary({
              compensationRecordId: 'comp-2',
              rateAmount: '78000.0000',
              effectiveFrom: '2026-10-11',
            }),
          ],
        }),
      );
      // 2000 x 7/14 + 3000 x 7/14
      expect(amounts(result)).toEqual([
        ['REGULAR_SALARY', '1000.00'],
        ['REGULAR_SALARY', '1500.00'],
      ]);
      expect(result.grossAmount).toBe('2500.00');
    });

    it('allows sign-in-only attendance and never reduces salary for presence or paid leave', () => {
      const result = one(
        sources(
          {
            compensation: [salary()],
            timesheet: null,
            leave: [leave('2026-10-06', 480, 'PAID')],
            presence: [],
          },
          { days: days('2026-10-04', '2026-10-17', 'SIGN_IN_ONLY') },
        ),
      );
      expect(result.blocked).toBe(false);
      expect(amounts(result)).toEqual([['REGULAR_SALARY', '2000.00']]);
      expect(codes(result)).toContain('INFO:SALARY_PRESENCE_ONLY');
    });

    it('blocks unpaid salaried leave without a configured rule, and applies the configured one', () => {
      const unpaid = sources({
        compensation: [salary()],
        leave: [leave('2026-10-06', 480, 'UNPAID')],
      });
      const blocked = one(unpaid);
      expect(blocked.blocked).toBe(true);
      expect(codes(blocked)).toContain(
        'ERROR:SALARY_UNPAID_LEAVE_REQUIRES_RULE',
      );
      const reduced = one(unpaid, {
        salaryUnpaidLeaveRule: 'HOURLY_EQUIVALENT',
        salaryStandardAnnualHours: '2080.00',
      });
      // 52000 / 2080 = 25.00 per hour; 8 h → -200.00
      expect(amounts(reduced)).toEqual([
        ['REGULAR_SALARY', '2000.00'],
        ['UNPAID_LEAVE_REDUCTION', '-200.00'],
      ]);
      expect(reduced.grossAmount).toBe('1800.00');
    });
  });

  describe('validation', () => {
    it('reports compensation gaps, missing compensation, pay group and currency problems', () => {
      const gap = one(
        withTime([work('2026-10-05', 480)], {
          compensation: [fact({ effectiveFrom: '2026-10-08' })],
        }),
      );
      expect(codes(gap)).toEqual(
        expect.arrayContaining([
          'ERROR:COMPENSATION_GAP',
          'ERROR:MISSING_COMPENSATION',
        ]),
      );
      expect(gap.lines).toEqual([]);
      expect(
        codes(
          one(
            sources({
              compensation: [
                fact({ effectiveTo: '2026-10-09' }),
                fact({
                  compensationRecordId: 'c2',
                  effectiveFrom: '2026-10-10',
                  payGroupId: null,
                }),
              ],
            }),
          ),
        ),
      ).toContain('ERROR:MISSING_PAY_GROUP');
      expect(
        codes(
          one(
            sources({
              compensation: [
                fact({ effectiveTo: '2026-10-09' }),
                fact({
                  compensationRecordId: 'c2',
                  effectiveFrom: '2026-10-10',
                  payGroupId: 'other',
                }),
              ],
            }),
          ),
        ),
      ).not.toContain('ERROR:PAY_GROUP_MISMATCH');
      expect(
        codes(
          one(
            sources({
              compensation: [
                fact({ effectiveTo: '2026-10-09' }),
                fact({
                  compensationRecordId: 'c2',
                  effectiveFrom: '2026-10-10',
                  currency: 'USD',
                }),
              ],
            }),
          ),
        ),
      ).toContain('ERROR:MULTIPLE_CURRENCIES');
    });

    it('leaves assignments compensated in another currency out of the run', () => {
      const result = one(
        sources({ compensation: [fact({ currency: 'USD' })] }),
      );
      expect(result.inRun).toBe(false);
      expect(result.issues).toEqual([]);
    });
  });

  describe('pay-group ownership', () => {
    // Oct 4–10 in this pay group, Oct 11 onward in another (e.g. a monthly one).
    const moved = [
      fact({ effectiveTo: '2026-10-10' }),
      fact({
        compensationRecordId: 'comp-2',
        effectiveFrom: '2026-10-11',
        payGroupId: 'pay-group-2',
        rateAmount: '30.0000',
      }),
    ];
    const time = [
      work('2026-10-05', 480),
      work('2026-10-12', 240),
      work('2026-10-16', 60),
    ];

    it('pays only the work dates whose effective compensation is in the run pay group', () => {
      const result = one(withTime(time, { compensation: moved }));
      expect(result.blocked).toBe(false);
      expect(amounts(result)).toEqual([['REGULAR_HOURLY', '196.00']]);
      expect(result.time.map((output) => output.workDate)).toEqual([
        '2026-10-05',
      ]);
      expect(codes(result)).toContain('WARNING:PAY_GROUP_CHANGE_IN_PERIOD');
      const warning = result.issues.find(
        (issue) => issue.code === 'PAY_GROUP_CHANGE_IN_PERIOD',
      )!;
      expect(warning.metadata).toMatchObject({
        otherPayGroupIds: ['pay-group-2'],
        excludedWorkDates: ['2026-10-12', '2026-10-16'],
      });
    });

    it('lets the other pay group pay the remaining dates exactly once', () => {
      const result = one(withTime(time, { compensation: moved }), {
        payGroupId: 'pay-group-2',
      });
      expect(amounts(result)).toEqual([
        ['REGULAR_HOURLY', '120.00'],
        ['REGULAR_HOURLY', '30.00'],
      ]);
      expect(result.lines.flatMap((line) => line.sourceDates)).toEqual([
        '2026-10-12',
        '2026-10-16',
      ]);
    });

    it('assigns paid leave and salary days to the pay group that owns the date', () => {
      const salaryMoved = moved.map((item) => ({
        ...item,
        payBasis: 'SALARY' as const,
        rateAmount: '52000.0000',
        salaryArrangement: 'ANNUAL' as const,
      }));
      const mine = one(
        sources({
          compensation: salaryMoved,
          leave: [
            leave('2026-10-06', 480, 'PAID'),
            leave('2026-10-13', 480, 'PAID'),
          ],
        }),
      );
      expect(amounts(mine)).toEqual([['REGULAR_SALARY', '1000.00']]);
      expect(mine.lines[0]!.sourceDates).toHaveLength(7);
      const hourly = one(
        sources({
          compensation: moved,
          leave: [
            leave('2026-10-06', 480, 'PAID'),
            leave('2026-10-13', 480, 'PAID'),
          ],
        }),
        { payGroupId: 'pay-group-2' },
      );
      expect(amounts(hourly)).toEqual([['PAID_LEAVE', '240.00']]);
      expect(hourly.leave.map((day) => day.date)).toEqual(['2026-10-13']);
    });

    it('refuses time outside the pay period instead of paying it', () => {
      const result = one(withTime([work('2026-10-20', 60)]));
      expect(codes(result)).toContain('ERROR:TIME_SOURCE_OUTSIDE_PAY_PERIOD');
      expect(result.lines).toEqual([]);
    });
  });

  describe('benefits', () => {
    const salaried = [
      fact({
        payBasis: 'SALARY',
        rateAmount: '52000.0000',
        salaryArrangement: 'ANNUAL',
      }),
    ];
    const benefit = (overrides: Record<string, unknown> = {}) => ({
      enrollmentId: 'enr-1',
      employeeId: 'emp-1',
      employmentAssignmentId: 'asg-1',
      planId: 'plan-1',
      planCode: 'HEALTH',
      planName: 'Health',
      benefitType: 'HEALTH' as const,
      optionId: 'opt-1',
      optionCode: 'SINGLE',
      coverageLevel: 'EMPLOYEE_ONLY' as const,
      currency: 'CAD',
      employerContributionTaxable: false,
      rateId: 'rate-1',
      frequency: 'MONTHLY' as const,
      employeeAmount: '25.00',
      employerAmount: '75.00',
      from: '2026-01-01',
      to: '2026-12-31',
      ...overrides,
    });
    const withBenefits = (
      facts: ReturnType<typeof benefit>[],
      gaps: Array<{
        enrollmentId: string;
        planCode: string;
        from: string;
        to: string;
      }> = [],
      compensation = salaried,
    ) => sources({ compensation, benefits: { facts, gaps } });
    const benefitAmounts = (result: ReturnType<typeof one>) =>
      result.benefitLines.map((line) => [
        line.kind,
        line.amount,
        line.sourceDates.length,
      ]);

    it('makes rates per-period by cadence and splits employee cost from employer contribution', () => {
      expect(benefitAmounts(one(withBenefits([benefit()])))).toEqual([
        ['DEDUCTION', '11.54', 14],
        ['CONTRIBUTION', '34.62', 14],
      ]);
      expect(
        benefitAmounts(
          one(
            withBenefits([
              benefit({ frequency: 'PER_PAY_PERIOD', employeeAmount: '10.00' }),
            ]),
          ),
        )[0],
      ).toEqual(['DEDUCTION', '10.00', 14]);
      expect(
        benefitAmounts(
          one(
            withBenefits([
              benefit({ frequency: 'ANNUAL', employeeAmount: '260.00' }),
            ]),
          ),
        )[0],
      ).toEqual(['DEDUCTION', '10.00', 14]);
      // Benefits never change gross pay.
      expect(one(withBenefits([benefit()])).grossAmount).toBe('2000.00');
    });

    it('prorates partial periods and rate changes by covered calendar days', () => {
      expect(
        benefitAmounts(one(withBenefits([benefit({ from: '2026-10-11' })]))),
      ).toEqual([
        ['DEDUCTION', '5.77', 7],
        ['CONTRIBUTION', '17.31', 7],
      ]);
      const split = one(
        withBenefits([
          benefit({ to: '2026-10-10' }),
          benefit({
            rateId: 'rate-2',
            from: '2026-10-11',
            employeeAmount: '50.00',
          }),
        ]),
      );
      expect(
        split.benefitLines
          .filter((l) => l.kind === 'DEDUCTION')
          .map((l) => [l.rateId, l.amount]),
      ).toEqual([
        ['rate-1', '5.77'],
        ['rate-2', '11.54'],
      ]);
      expect(split.benefits).toHaveLength(2);
    });

    it('handles employer-paid-only and zero-cost benefits', () => {
      expect(
        benefitAmounts(
          one(withBenefits([benefit({ employeeAmount: '0.00' })])),
        ),
      ).toEqual([['CONTRIBUTION', '34.62', 14]]);
      const free = one(
        withBenefits([
          benefit({ employeeAmount: '0.00', employerAmount: '0.00' }),
        ]),
      );
      expect(free.benefitLines).toEqual([]);
      expect(free.benefits).toHaveLength(1);
    });

    it('charges only dates the run pay group owns', () => {
      const moved = [
        fact({
          payBasis: 'SALARY',
          rateAmount: '52000.0000',
          salaryArrangement: 'ANNUAL',
          effectiveTo: '2026-10-10',
        }),
        fact({
          compensationRecordId: 'comp-2',
          payBasis: 'SALARY',
          rateAmount: '52000.0000',
          salaryArrangement: 'ANNUAL',
          effectiveFrom: '2026-10-11',
          payGroupId: 'pay-group-2',
        }),
      ];
      expect(
        benefitAmounts(one(withBenefits([benefit()], [], moved)))[0],
      ).toEqual(['DEDUCTION', '5.77', 7]);
      expect(
        benefitAmounts(
          one(withBenefits([benefit()], [], moved), {
            payGroupId: 'pay-group-2',
          }),
        )[0],
      ).toEqual(['DEDUCTION', '5.77', 7]);
    });

    it('blocks instead of guessing: missing rates and foreign currencies', () => {
      const gap = one(
        withBenefits(
          [benefit({ to: '2026-10-09' })],
          [
            {
              enrollmentId: 'enr-1',
              planCode: 'HEALTH',
              from: '2026-10-10',
              to: '2026-12-31',
            },
          ],
        ),
      );
      expect(codes(gap)).toContain('ERROR:BENEFIT_RATE_MISSING');
      expect(gap.benefitLines).toEqual([]);
      expect(
        codes(one(withBenefits([benefit({ currency: 'USD' })]))),
      ).toContain('ERROR:BENEFIT_CURRENCY_MISMATCH');
      // A gap outside the period does not block.
      expect(
        codes(
          one(
            withBenefits(
              [benefit({ to: '2026-10-31' })],
              [
                {
                  enrollmentId: 'enr-1',
                  planCode: 'HEALTH',
                  from: '2026-11-01',
                  to: '2026-12-31',
                },
              ],
            ),
          ),
        ),
      ).not.toContain('ERROR:BENEFIT_RATE_MISSING');
    });

    it('fingerprints benefits only when an assignment sponsors some', () => {
      const plain = one(sources({ compensation: salaried }));
      expect(one(withBenefits([])).fingerprint).toBe(plain.fingerprint);
      const priced = one(withBenefits([benefit()]));
      expect(priced.fingerprint).not.toBe(plain.fingerprint);
      expect(
        one(withBenefits([benefit({ employeeAmount: '26.00' })])).fingerprint,
      ).not.toBe(priced.fingerprint);
    });
  });

  describe('fingerprints', () => {
    it('are deterministic and independent of fact order', () => {
      const a = withTime([work('2026-10-05', 480), work('2026-10-06', 480)], {
        leave: [
          leave('2026-10-07', 60, 'PAID', 'a'),
          leave('2026-10-08', 60, 'PAID', 'b'),
        ],
      });
      const b = { ...a, leave: [...a.leave].reverse() };
      expect(one(a).fingerprint).toBe(one(b).fingerprint);
      expect(calculate(input([a])).fingerprint).toBe(
        calculate(input([b])).fingerprint,
      );
    });

    it('change with pay-relevant facts but not with schedules or presence', () => {
      const base = withTime([work('2026-10-05', 480)]);
      const fp = one(base).fingerprint;
      expect(
        one({ ...base, expectedWork: { shifts: 9, scheduledMinutes: 999 } })
          .fingerprint,
      ).toBe(fp);
      expect(
        one({ ...base, timesheet: { ...base.timesheet!, version: 2 } })
          .fingerprint,
      ).not.toBe(fp);
      expect(
        one({ ...base, compensation: [fact({ rateAmount: '25.0000' })] })
          .fingerprint,
      ).not.toBe(fp);
      expect(
        one({ ...base, leave: [leave('2026-10-06', 480, 'PAID')] }).fingerprint,
      ).not.toBe(fp);
    });

    it('use canonical JSON with sorted keys', () => {
      expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe(
        '{"a":[{"c":null,"d":2}],"b":1}',
      );
    });
  });
});
