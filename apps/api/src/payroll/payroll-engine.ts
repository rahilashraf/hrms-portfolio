import { createHash } from 'node:crypto';
import type {
  PayrollBenefitFact,
  PayrollBenefitFacts,
} from '../benefits/benefits-payroll.source.js';
import type { PayrollCompensationFact } from '../compensation/compensation-integration.contracts.js';
import {
  addDays,
  daysBetweenInclusive,
  formatDate,
  parseDateOnly,
} from '../common/domain-support.js';
import type { PayrollEmploymentFact } from '../employee/employee-payroll.source.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  PayrollCalendarCadence,
  PayrollEarningType,
  PayrollSalaryUnpaidLeaveRule,
  PayrollValidationSeverity,
} from '../generated/prisma/client.js';
import type { PayrollLeaveFact } from '../leave/leave-payroll.source.js';
import type {
  AttendancePresenceFact,
  PayrollAssignmentTimeFact,
  PayrollTimesheetFact,
} from '../time/time-integration.contracts.js';
import {
  isPeriodStart,
  nextPeriodStart,
  PERIODS_PER_YEAR,
} from './payroll-calendar.js';

/**
 * Phase 10 Batches 4–7 — the pure gross-payroll engine. Given every source fact of a run's
 * population (collected by PayrollSourceService), it validates, calculates explainable gross
 * earning lines, lists the snapshots to store, and fingerprints the sources. No I/O, no clock:
 * the same facts always produce the same result.
 *
 * Money uses decimal arithmetic only (never a JavaScript number) and is rounded half-up to
 * cents per line. Pay comes only from approved/locked time (Time's frozen PayrollApprovedTime
 * outputs), approved leave days and effective-dated compensation: never from schedules (context
 * only) or presence sign-ins (no duration). When a fact is missing or ambiguous the engine
 * reports a blocking ERROR instead of guessing, and calculates nothing for that assignment.
 */

export const PAYROLL_CALCULATION_VERSION = 'PAYROLL_GROSS_V1';

export const RULES = {
  HOURLY: { rule: 'HOURLY_REGULAR', version: 1 },
  PAID_LEAVE: { rule: 'HOURLY_PAID_LEAVE', version: 1 },
  SALARY: { rule: 'SALARY_PERIODIZATION', version: 1 },
  FIXED_PERIOD_SALARY: { rule: 'FIXED_PERIOD_SALARY_MONTHLY', version: 1 },
  CONTRACT_TOTAL_SALARY: { rule: 'CONTRACT_TOTAL_PERIODIZATION', version: 1 },
  UNPAID_LEAVE: { rule: 'SALARY_UNPAID_LEAVE_HOURLY_EQUIVALENT', version: 1 },
  BENEFIT: { rule: 'BENEFIT_PERIODIZATION', version: 1 },
} as const;

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

export function money(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function rate4(value: Decimal): Decimal {
  return value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface ExpectedWorkContext {
  shifts: number;
  scheduledMinutes: number;
}

export interface AssignmentSources {
  employment: PayrollEmploymentFact;
  compensation: PayrollCompensationFact[];
  timesheet: PayrollTimesheetFact | null;
  time: PayrollAssignmentTimeFact;
  leave: PayrollLeaveFact[];
  presence: AttendancePresenceFact[];
  /** Scheduling context (review only; never pay). */
  expectedWork: ExpectedWorkContext;
  /** Benefit elections this assignment sponsors (Phase 11); absent when none. */
  benefits?: PayrollBenefitFacts;
}

export interface EngineInput {
  currency: string;
  payGroupId: string;
  period: {
    periodStart: string;
    periodEnd: string;
    cadence: PayrollCalendarCadence;
  };
  salaryUnpaidLeaveRule: PayrollSalaryUnpaidLeaveRule;
  salaryStandardAnnualHours: string | null;
  assignments: AssignmentSources[];
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

export interface EngineIssue {
  severity: PayrollValidationSeverity;
  code: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/** Source keys a line points at; the service turns them into stored snapshot ids. */
export interface LineDraft {
  type: PayrollEarningType;
  description: string;
  workDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  quantity: string | null;
  quantityUnit: 'MINUTES' | 'CALENDAR_DAYS' | null;
  rateAmount: string | null;
  amount: string;
  calculationRule: string;
  calculationRuleVersion: number;
  compensationRecordId: string | null;
  timeKey: string | null;
  leaveRequestDayId: string | null;
  /**
   * The assignment dates whose source this line pays (a work date, a leave day, or each
   * salaried day). Payroll claims them so no other run pays the same source again.
   */
  sourceDates: string[];
}

/** A benefit deduction (employee cost) or employer contribution for one rated fact. */
export interface BenefitLineDraft {
  kind: 'DEDUCTION' | 'CONTRIBUTION';
  enrollmentId: string;
  rateId: string;
  /** Index of the fact in `AssignmentResult.benefits` (its snapshot). */
  factIndex: number;
  planCode: string;
  description: string;
  amount: string;
  calculationRule: string;
  calculationRuleVersion: number;
  /** The owned covered dates paid for (claimed per election and date). */
  sourceDates: string[];
}

export interface AssignmentResult {
  employmentAssignmentId: string;
  employeeId: string;
  /** False when none of the assignment's pay-group facts is in the run currency. */
  inRun: boolean;
  blocked: boolean;
  issues: EngineIssue[];
  lines: LineDraft[];
  /**
   * The compensation facts (of every pay group: they explain which pay group owns each date),
   * and the time dates and leave days this pay group owns, and presence (to snapshot).
   */
  compensation: PayrollCompensationFact[];
  time: Array<PayrollTimesheetFact['workDates'][number] & { key: string }>;
  leave: PayrollLeaveFact[];
  presence: AttendancePresenceFact[];
  /** Benefit facts with covered dates this pay group owns in the period (to snapshot). */
  benefits: PayrollBenefitFact[];
  benefitLines: BenefitLineDraft[];
  grossAmount: string;
  fingerprint: string;
}

export interface EngineResult {
  assignments: AssignmentResult[];
  fingerprint: string;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

const iso = (value: string) => parseDateOnly(value, 'date');

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let day = iso(from); day <= iso(to); day = addDays(day, 1)) {
    dates.push(formatDate(day));
  }
  return dates;
}

function covers(fact: PayrollCompensationFact, date: string) {
  return (
    fact.effectiveFrom <= date &&
    (!fact.effectiveTo || fact.effectiveTo >= date)
  );
}

function salaryArrangement(fact: PayrollCompensationFact) {
  return fact.payBasis === 'SALARY'
    ? (fact.salaryArrangement ?? 'ANNUAL')
    : null;
}

function isCalendarMonth(start: string, end: string) {
  const from = iso(start);
  const to = iso(end);
  const monthEnd = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0),
  );
  return (
    from.getUTCDate() === 1 &&
    to.getTime() === monthEnd.getTime() &&
    from.getUTCFullYear() === to.getUTCFullYear() &&
    from.getUTCMonth() === to.getUTCMonth()
  );
}

function periodCountAndFinal(
  fact: PayrollCompensationFact,
  input: EngineInput,
): { count: number; final: boolean } | null {
  if (!fact.salaryPeriodStart || !fact.salaryPeriodEnd) return null;
  const rules = {
    cadence: input.period.cadence,
    anchorDate: iso(input.period.periodStart),
  };
  const start = iso(fact.salaryPeriodStart);
  const end = iso(fact.salaryPeriodEnd);
  if (!isPeriodStart(rules, start) || !isPeriodStart(rules, addDays(end, 1))) {
    return null;
  }
  let count = 0;
  let final = false;
  for (
    let cursor = start;
    cursor <= end;
    cursor = nextPeriodStart(rules, cursor)
  ) {
    const next = nextPeriodStart(rules, cursor);
    const periodEnd = addDays(next, -1);
    if (periodEnd > end) return null;
    count += 1;
    if (
      formatDate(cursor) === input.period.periodStart &&
      formatDate(periodEnd) === input.period.periodEnd
    ) {
      final = formatDate(periodEnd) === fact.salaryPeriodEnd;
    }
  }
  return count > 0 ? { count, final } : null;
}

const hours = (minutes: number) => (minutes / 60).toFixed(2);

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** JSON with object keys sorted at every level: a stable text for fingerprints. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The normalized source facts of one assignment that determine its pay and validation.
 * Scheduling and presence are excluded: they never change pay, so they never make a run stale.
 */
export function assignmentFingerprint(
  input: EngineInput,
  sources: AssignmentSources,
): string {
  const id = sources.employment.employmentAssignmentId;
  return sha256({
    employment: sources.employment,
    compensation: [...sources.compensation].sort((a, b) =>
      a.compensationRecordId.localeCompare(b.compensationRecordId),
    ),
    timesheet: sources.timesheet && {
      timesheetId: sources.timesheet.timesheetId,
      status: sources.timesheet.status,
      version: sources.timesheet.version,
      segments: sources.timesheet.segments.filter(
        (segment) => segment.employmentAssignmentId === id,
      ),
      workDates: sources.timesheet.workDates
        .filter((output) => output.employmentAssignmentId === id)
        .sort((a, b) => a.workDate.localeCompare(b.workDate)),
    },
    time: sources.time,
    leave: [...sources.leave].sort((a, b) =>
      a.leaveRequestDayId.localeCompare(b.leaveRequestDayId),
    ),
    rule: {
      salaryUnpaidLeaveRule: input.salaryUnpaidLeaveRule,
      salaryStandardAnnualHours: input.salaryStandardAnnualHours,
    },
    // Only when the assignment sponsors benefits, so runs without benefits keep their
    // fingerprints (no false staleness when Benefits is introduced).
    ...(sources.benefits &&
    (sources.benefits.facts.length > 0 || sources.benefits.gaps.length > 0)
      ? {
          benefits: {
            facts: [...sources.benefits.facts].sort((a, b) =>
              `${a.enrollmentId}${a.from}`.localeCompare(
                `${b.enrollmentId}${b.from}`,
              ),
            ),
            gaps: [...sources.benefits.gaps].sort((a, b) =>
              `${a.enrollmentId}${a.from}`.localeCompare(
                `${b.enrollmentId}${b.from}`,
              ),
            ),
          },
        }
      : {}),
  });
}

export function runFingerprint(
  input: Pick<
    EngineInput,
    | 'currency'
    | 'payGroupId'
    | 'period'
    | 'salaryUnpaidLeaveRule'
    | 'salaryStandardAnnualHours'
  >,
  assignments: Array<{
    employmentAssignmentId: string;
    fingerprint: string;
    inRun: boolean;
  }>,
  extra: Record<string, unknown> = {},
): string {
  return sha256({
    version: PAYROLL_CALCULATION_VERSION,
    currency: input.currency,
    payGroupId: input.payGroupId,
    period: input.period,
    rule: {
      salaryUnpaidLeaveRule: input.salaryUnpaidLeaveRule,
      salaryStandardAnnualHours: input.salaryStandardAnnualHours,
    },
    assignments: assignments
      .filter((assignment) => assignment.inRun)
      .map((assignment) => [
        assignment.employmentAssignmentId,
        assignment.fingerprint,
      ])
      .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ...extra,
  });
}

export function calculate(input: EngineInput): EngineResult {
  const assignments = input.assignments.map((sources) =>
    calculateAssignment(input, sources),
  );
  return { assignments, fingerprint: runFingerprint(input, assignments) };
}

function calculateAssignment(
  input: EngineInput,
  sources: AssignmentSources,
): AssignmentResult {
  const { employment } = sources;
  const id = employment.employmentAssignmentId;
  const { periodStart, periodEnd } = input.period;
  const issues: EngineIssue[] = [];
  const error = (
    code: string,
    message: string,
    metadata?: Record<string, unknown>,
  ) => issues.push({ severity: 'ERROR', code, message, metadata });
  const warning = (
    code: string,
    message: string,
    metadata?: Record<string, unknown>,
  ) => issues.push({ severity: 'WARNING', code, message, metadata });
  const info = (
    code: string,
    message: string,
    metadata?: Record<string, unknown>,
  ) => issues.push({ severity: 'INFO', code, message, metadata });

  // The days this assignment can be paid for in the period.
  const eligibleFrom =
    employment.startDate > periodStart ? employment.startDate : periodStart;
  const eligibleTo =
    employment.endDate && employment.endDate < periodEnd
      ? employment.endDate
      : periodEnd;
  const eligible =
    eligibleFrom <= eligibleTo ? datesBetween(eligibleFrom, eligibleTo) : [];
  const relevant = sources.compensation.filter((fact) =>
    eligible.some((date) => covers(fact, date)),
  );
  const ours = relevant.filter((fact) => fact.payGroupId === input.payGroupId);
  const inRun = ours.some((fact) => fact.currency === input.currency);
  // Only this assignment's approved outputs; a timesheet holds every assignment of the employee.
  const workDates = (sources.timesheet?.workDates ?? []).filter(
    (output) => output.employmentAssignmentId === id,
  );
  const fingerprint = assignmentFingerprint(input, sources);
  const base = {
    employmentAssignmentId: id,
    employeeId: employment.employeeId,
    inRun,
    compensation: relevant,
    time: [] as AssignmentResult['time'],
    leave: [] as PayrollLeaveFact[],
    presence: sources.presence,
    benefits: [] as PayrollBenefitFact[],
    benefitLines: [] as BenefitLineDraft[],
    fingerprint,
  };
  if (!inRun) {
    return {
      ...base,
      blocked: true,
      issues: [],
      lines: [],
      grossAmount: '0.00',
    };
  }

  // ─── Validation ────────────────────────────────────────────────────────────
  const factOn = new Map<string, PayrollCompensationFact>();
  const gaps: string[] = [];
  const overlaps: string[] = [];
  for (const date of eligible) {
    const facts = relevant.filter((fact) => covers(fact, date));
    if (facts.length === 0) gaps.push(date);
    else if (facts.length > 1) overlaps.push(date);
    else factOn.set(date, facts[0]!);
  }
  const range = (dates: string[]) => ({
    count: dates.length,
    first: dates[0],
    last: dates[dates.length - 1],
  });
  if (overlaps.length > 0) {
    error(
      'COMPENSATION_OVERLAP',
      'More than one compensation record applies on some dates.',
      range(overlaps),
    );
  }
  if (gaps.length > 0) {
    error(
      'COMPENSATION_GAP',
      `No compensation applies on ${gaps.length} day(s) the assignment is active in this period.`,
      range(gaps),
    );
  }
  if (relevant.some((fact) => fact.payGroupId === null)) {
    error(
      'MISSING_PAY_GROUP',
      'A compensation record of the period has no pay group.',
    );
  }
  // Pay-group ownership is decided per date by the compensation effective on it: a date whose
  // compensation is in another pay group is that pay group's to pay, never this run's.
  const owns = (date: string) => {
    const owner = factOn.get(date);
    return (
      owner !== undefined &&
      owner.payGroupId === input.payGroupId &&
      owner.currency === input.currency
    );
  };
  const otherGroupOn = (date: string) => {
    const owner = factOn.get(date);
    return owner !== undefined && owner.payGroupId !== input.payGroupId;
  };
  const inPeriod = (date: string) => date >= periodStart && date <= periodEnd;
  const periodDays = daysBetweenInclusive(iso(periodStart), iso(periodEnd));
  const outside = workDates.filter((output) => !inPeriod(output.workDate));
  if (outside.length > 0) {
    error(
      'TIME_SOURCE_OUTSIDE_PAY_PERIOD',
      'Approved time of the timesheet falls outside the pay period.',
      range(outside.map((output) => output.workDate).sort()),
    );
  }
  const ownedTime = workDates.filter(
    (output) => inPeriod(output.workDate) && owns(output.workDate),
  );
  const time = ownedTime.map((output) => ({
    ...output,
    key: `${output.timesheetSegmentId}:${output.workDate}`,
  }));
  const ownedLeave = sources.leave.filter((day) => owns(day.date));
  const otherGroupDates = eligible.filter(otherGroupOn);
  if (otherGroupDates.length > 0) {
    warning(
      'PAY_GROUP_CHANGE_IN_PERIOD',
      'Part of the period is compensated in another pay group: those dates are paid only by that pay group.',
      {
        ...range(otherGroupDates),
        otherPayGroupIds: [
          ...new Set(
            otherGroupDates.map((date) => String(factOn.get(date)!.payGroupId)),
          ),
        ].sort((a, b) => a.localeCompare(b)),
        excludedWorkDates: workDates
          .filter(
            (output) =>
              output.approvedWorkedMinutes > 0 &&
              inPeriod(output.workDate) &&
              otherGroupOn(output.workDate),
          )
          .map((output) => output.workDate),
        excludedLeaveDays: sources.leave
          .filter((day) => otherGroupOn(day.date))
          .map((day) => day.date),
      },
    );
  }
  if (new Set(ours.map((fact) => fact.currency)).size > 1) {
    error(
      'MULTIPLE_CURRENCIES',
      'The period is compensated in more than one currency.',
      {
        currencies: [...new Set(ours.map((fact) => fact.currency))].sort(),
      },
    );
  }
  if (
    relevant.some(
      (fact) => fact.payBasis !== 'HOURLY' && fact.payBasis !== 'SALARY',
    )
  ) {
    error(
      'UNSUPPORTED_PAY_BASIS',
      'A compensation record uses a pay basis payroll cannot calculate.',
    );
  }
  const modeOn = new Map(
    sources.time.days.map((day) => [day.date, day.trackingMode]),
  );
  const hourlyDates = eligible.filter(
    (date) => owns(date) && factOn.get(date)?.payBasis === 'HOURLY',
  );
  const salaryDates = eligible.filter(
    (date) => owns(date) && factOn.get(date)?.payBasis === 'SALARY',
  );
  const signInOnlyHourly = hourlyDates.filter(
    (date) => modeOn.get(date) === 'SIGN_IN_ONLY',
  );
  if (signInOnlyHourly.length > 0) {
    error(
      'HOURLY_SIGN_IN_ONLY_UNSUPPORTED',
      'The assignment is paid hourly but records attendance by sign-in only, which has no duration.',
      range(signInOnlyHourly),
    );
  }
  if (hourlyDates.length > 0) {
    if (!sources.time.timezone) {
      error(
        'UNRESOLVED_TIMEZONE',
        'The assignment has no attendance timezone; its time cannot be dated.',
      );
    }
    const segment = sources.timesheet?.segments.find(
      (item) => item.employmentAssignmentId === id,
    );
    if (sources.time.openEntries > 0) {
      error(
        'TIMESHEET_NOT_FINAL',
        'The assignment still has open (not clocked-out) time in the period.',
        {
          openEntries: sources.time.openEntries,
        },
      );
    } else if (!sources.timesheet) {
      if (sources.time.closedEntries > 0) {
        error(
          'MISSING_TIMESHEET',
          'Time was recorded in the period but there is no timesheet for it.',
          {
            closedEntries: sources.time.closedEntries,
          },
        );
      } else {
        info('NO_TIME_RECORDED', 'No time was recorded in the period.');
      }
    } else if (!sources.timesheet.finalizationStatus) {
      if (segment || sources.time.closedEntries > 0) {
        error(
          'TIMESHEET_NOT_FINAL',
          'The timesheet of the period is not approved or locked.',
          {
            timesheetId: sources.timesheet.timesheetId,
            status: sources.timesheet.status,
          },
        );
      } else {
        info('NO_TIME_RECORDED', 'No time was recorded in the period.');
      }
    } else if (ownedTime.length === 0) {
      info('NO_TIME_RECORDED', 'No approved time in the period.');
    }
    const approvedMinutes = ownedTime.reduce(
      (total, output) => total + output.approvedWorkedMinutes,
      0,
    );
    if (approvedMinutes === 0 && sources.expectedWork.scheduledMinutes > 0) {
      warning(
        'SCHEDULED_WITHOUT_APPROVED_TIME',
        'Work was scheduled in the period but no time was approved (schedules are never paid).',
        sources.expectedWork as unknown as Record<string, unknown>,
      );
    }
  }
  const unpaidTimeDates = workDates
    .filter(
      (output) =>
        output.approvedWorkedMinutes > 0 &&
        inPeriod(output.workDate) &&
        !factOn.has(output.workDate),
    )
    .map((output) => output.workDate);
  const unpaidLeaveDates = sources.leave
    .filter(
      (day) =>
        day.classification === 'PAID' &&
        day.minutes > 0 &&
        !factOn.has(day.date),
    )
    .map((day) => day.date);
  if (unpaidTimeDates.length + unpaidLeaveDates.length > 0) {
    error(
      'MISSING_COMPENSATION',
      'Approved time or paid leave falls on dates without compensation.',
      range([...unpaidTimeDates, ...unpaidLeaveDates].sort()),
    );
  }
  const salaryUnpaidLeave = ownedLeave.filter(
    (day) =>
      day.classification === 'UNPAID' &&
      day.minutes > 0 &&
      factOn.get(day.date)?.payBasis === 'SALARY',
  );
  const contractedSalaryUnpaidLeave = salaryUnpaidLeave.filter((day) => {
    const fact = factOn.get(day.date);
    return fact && salaryArrangement(fact) !== 'ANNUAL';
  });
  if (contractedSalaryUnpaidLeave.length > 0) {
    error(
      'CONTRACTED_SALARY_UNPAID_LEAVE_UNSUPPORTED',
      'Unpaid leave reductions for fixed-period or contract-total salary are not configured; adjust the contract or add a manual payroll adjustment.',
      range(contractedSalaryUnpaidLeave.map((day) => day.date)),
    );
  }
  if (
    salaryUnpaidLeave.length > 0 &&
    input.salaryUnpaidLeaveRule === 'UNCONFIGURED'
  ) {
    error(
      'SALARY_UNPAID_LEAVE_REQUIRES_RULE',
      'Unpaid leave was taken on salaried days, but the payroll calendar has no rule for reducing a salary.',
      range(salaryUnpaidLeave.map((day) => day.date)),
    );
  }
  if (employment.startDate > periodStart && employment.startDate <= periodEnd) {
    warning('HIRED_DURING_PERIOD', 'The assignment starts during the period.', {
      startDate: employment.startDate,
    });
  }
  if (
    employment.endDate &&
    employment.endDate >= periodStart &&
    employment.endDate < periodEnd
  ) {
    warning(
      'TERMINATED_DURING_PERIOD',
      'The assignment ends during the period.',
      { endDate: employment.endDate },
    );
  }
  if (relevant.length > 1) {
    warning(
      'MID_PERIOD_COMPENSATION_CHANGE',
      'Compensation changes during the period.',
      {
        compensationRecordIds: relevant.map(
          (fact) => fact.compensationRecordId,
        ),
      },
    );
  }
  const signInOnlySalary = salaryDates.filter(
    (date) => modeOn.get(date) === 'SIGN_IN_ONLY',
  );
  if (signInOnlySalary.length > 0) {
    info(
      'SALARY_PRESENCE_ONLY',
      'Salaried days with sign-in-only attendance: presence is shown for review and never changes salary.',
      {
        signIns: sources.presence.length,
      },
    );
  }
  for (const fact of ours.filter(
    (item) => item.payBasis === 'SALARY' && item.currency === input.currency,
  )) {
    const arrangement = salaryArrangement(fact);
    const dates = salaryDates.filter((date) => factOn.get(date) === fact);
    if (dates.length === 0 || arrangement === 'ANNUAL') continue;
    if (
      !fact.salaryContractAmount ||
      !fact.salaryPeriodStart ||
      !fact.salaryPeriodEnd
    ) {
      error(
        'CONTRACTED_SALARY_METADATA_MISSING',
        'A contracted salary record is missing its amount or paid period.',
        { compensationRecordId: fact.compensationRecordId },
      );
      continue;
    }
    if (dates.length !== periodDays) {
      error(
        'CONTRACTED_SALARY_PARTIAL_PERIOD_UNSUPPORTED',
        'Contracted salary currently requires the pay group to own the full pay period.',
        {
          compensationRecordId: fact.compensationRecordId,
          ...range(dates),
        },
      );
    }
    if (arrangement === 'FIXED_PERIOD') {
      if (
        input.period.cadence !== 'MONTHLY' ||
        !isCalendarMonth(periodStart, periodEnd) ||
        !fact.salaryMonthlyAmount ||
        !fact.salaryPaidMonths
      ) {
        error(
          'FIXED_PERIOD_SALARY_MONTHLY_UNSUPPORTED',
          'Fixed-period monthly salary requires a monthly pay period that is one whole calendar month.',
          { compensationRecordId: fact.compensationRecordId },
        );
      }
    }
    if (arrangement === 'CONTRACT_TOTAL' && !periodCountAndFinal(fact, input)) {
      error(
        'CONTRACT_TOTAL_PERIOD_ALIGNMENT_INVALID',
        'Contract-total salary requires the contract dates to align to whole pay periods of the pay group cadence.',
        { compensationRecordId: fact.compensationRecordId },
      );
    }
  }
  // Benefits: the elections this assignment sponsors cost what their rate says on the dates
  // this pay group owns (the same ownership as pay). Never guessed: no rate, or a rate in
  // another currency, blocks the assignment.
  const benefitFacts = sources.benefits?.facts ?? [];
  const ownedIn = (from: string, to: string) => {
    const start = from > periodStart ? from : periodStart;
    const end = to < periodEnd ? to : periodEnd;
    return start <= end ? datesBetween(start, end).filter(owns) : [];
  };
  const usedBenefits = benefitFacts
    .map((fact) => ({ fact, dates: ownedIn(fact.from, fact.to) }))
    .filter((item) => item.dates.length > 0);
  const foreignCurrency = usedBenefits.filter(
    (item) => item.fact.currency !== input.currency,
  );
  if (foreignCurrency.length > 0) {
    error(
      'BENEFIT_CURRENCY_MISMATCH',
      'A benefit is priced in another currency than the run; it cannot be deducted here.',
      {
        planCodes: [
          ...new Set(foreignCurrency.map((item) => item.fact.planCode)),
        ].sort(),
        currencies: [
          ...new Set(foreignCurrency.map((item) => item.fact.currency)),
        ].sort(),
      },
    );
  }
  const unrated = (sources.benefits?.gaps ?? []).filter(
    (gap) => ownedIn(gap.from, gap.to).length > 0,
  );
  if (unrated.length > 0) {
    error(
      'BENEFIT_RATE_MISSING',
      'A benefit election has covered dates without a rate; add the rate in Benefits.',
      {
        planCodes: [...new Set(unrated.map((gap) => gap.planCode))].sort(),
        first: unrated[0]!.from,
      },
    );
  }
  const blocked = issues.some((issue) => issue.severity === 'ERROR');
  const owned = {
    ...base,
    time,
    leave: ownedLeave,
    benefits: usedBenefits.map((item) => item.fact),
  };
  if (blocked)
    return { ...owned, blocked, issues, lines: [], grossAmount: '0.00' };

  // ─── Calculation ───────────────────────────────────────────────────────────
  const lines: LineDraft[] = [];
  for (const output of time) {
    const fact = factOn.get(output.workDate);
    if (
      !fact ||
      fact.payBasis !== 'HOURLY' ||
      output.approvedWorkedMinutes <= 0
    )
      continue;
    const amount = money(
      new Decimal(fact.rateAmount).mul(output.approvedWorkedMinutes).div(60),
    );
    lines.push({
      type: 'REGULAR_HOURLY',
      description: `Regular hourly ${output.workDate}: ${hours(output.approvedWorkedMinutes)} h x ${fact.rateAmount}`,
      workDate: output.workDate,
      periodFrom: null,
      periodTo: null,
      quantity: String(output.approvedWorkedMinutes),
      quantityUnit: 'MINUTES',
      rateAmount: fact.rateAmount,
      amount: amount.toFixed(2),
      calculationRule: RULES.HOURLY.rule,
      calculationRuleVersion: RULES.HOURLY.version,
      compensationRecordId: fact.compensationRecordId,
      timeKey: output.key,
      leaveRequestDayId: null,
      sourceDates: [output.workDate],
    });
  }
  for (const day of ownedLeave) {
    const fact = factOn.get(day.date);
    if (!fact || day.minutes <= 0) continue;
    if (fact.payBasis === 'HOURLY' && day.classification === 'PAID') {
      const amount = money(
        new Decimal(fact.rateAmount).mul(day.minutes).div(60),
      );
      lines.push({
        type: 'PAID_LEAVE',
        description: `Paid leave (${day.leaveTypeCode}) ${day.date}: ${hours(day.minutes)} h x ${fact.rateAmount}`,
        workDate: day.date,
        periodFrom: null,
        periodTo: null,
        quantity: String(day.minutes),
        quantityUnit: 'MINUTES',
        rateAmount: fact.rateAmount,
        amount: amount.toFixed(2),
        calculationRule: RULES.PAID_LEAVE.rule,
        calculationRuleVersion: RULES.PAID_LEAVE.version,
        compensationRecordId: fact.compensationRecordId,
        timeKey: null,
        leaveRequestDayId: day.leaveRequestDayId,
        sourceDates: [day.date],
      });
    }
    if (
      fact.payBasis === 'SALARY' &&
      day.classification === 'UNPAID' &&
      input.salaryUnpaidLeaveRule === 'HOURLY_EQUIVALENT' &&
      input.salaryStandardAnnualHours
    ) {
      const hourly = new Decimal(fact.rateAmount).div(
        input.salaryStandardAnnualHours,
      );
      const amount = money(hourly.mul(day.minutes).div(60)).neg();
      lines.push({
        type: 'UNPAID_LEAVE_REDUCTION',
        description: `Unpaid leave (${day.leaveTypeCode}) ${day.date}: ${hours(day.minutes)} h x ${rate4(hourly).toFixed(4)} (salary / ${input.salaryStandardAnnualHours} h)`,
        workDate: day.date,
        periodFrom: null,
        periodTo: null,
        quantity: String(day.minutes),
        quantityUnit: 'MINUTES',
        rateAmount: rate4(hourly).toFixed(4),
        amount: amount.toFixed(2),
        calculationRule: RULES.UNPAID_LEAVE.rule,
        calculationRuleVersion: RULES.UNPAID_LEAVE.version,
        compensationRecordId: fact.compensationRecordId,
        timeKey: null,
        leaveRequestDayId: day.leaveRequestDayId,
        sourceDates: [day.date],
      });
    }
  }
  for (const fact of ours) {
    if (fact.payBasis !== 'SALARY' || fact.currency !== input.currency)
      continue;
    const days = salaryDates.filter((date) => factOn.get(date) === fact);
    if (days.length === 0) continue;
    const arrangement = salaryArrangement(fact);
    const contractPeriods =
      arrangement === 'CONTRACT_TOTAL'
        ? periodCountAndFinal(fact, input)
        : null;
    const periodSalary =
      arrangement === 'FIXED_PERIOD'
        ? new Decimal(fact.salaryMonthlyAmount ?? fact.rateAmount)
        : arrangement === 'CONTRACT_TOTAL' && contractPeriods
          ? contractPeriods.final
            ? money(
                new Decimal(fact.salaryContractAmount!)
                  .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
                  .sub(
                    money(
                      new Decimal(fact.salaryContractAmount!).div(
                        contractPeriods.count,
                      ),
                    ).mul(contractPeriods.count - 1),
                  ),
              )
            : money(
                new Decimal(fact.salaryContractAmount!).div(
                  contractPeriods.count,
                ),
              )
          : new Decimal(fact.rateAmount).div(
              PERIODS_PER_YEAR[input.period.cadence],
            );
    const amount = money(periodSalary.mul(days.length).div(periodDays));
    const from = days[0]!;
    const to = days[days.length - 1]!;
    const fullPeriod = days.length === periodDays;
    const description =
      arrangement === 'FIXED_PERIOD'
        ? `Fixed-period salary ${from} to ${to}: ${fact.salaryMonthlyAmount ?? fact.rateAmount} monthly`
        : arrangement === 'CONTRACT_TOTAL' && contractPeriods
          ? `Contract salary ${from} to ${to}: ${fact.salaryContractAmount} / ${contractPeriods.count} pay periods${contractPeriods.final ? ' (final remainder)' : ''}`
          : fullPeriod
            ? `Salary ${from} to ${to}: ${fact.rateAmount} / ${PERIODS_PER_YEAR[input.period.cadence]}`
            : `Salary ${from} to ${to} (partial period): ${fact.rateAmount} / ${PERIODS_PER_YEAR[input.period.cadence]} x ${days.length}/${periodDays} days`;
    lines.push({
      type: 'REGULAR_SALARY',
      description,
      workDate: null,
      periodFrom: from,
      periodTo: to,
      quantity: String(days.length),
      quantityUnit: 'CALENDAR_DAYS',
      rateAmount: rate4(periodSalary).toFixed(4),
      amount: amount.toFixed(2),
      calculationRule:
        arrangement === 'FIXED_PERIOD'
          ? RULES.FIXED_PERIOD_SALARY.rule
          : arrangement === 'CONTRACT_TOTAL'
            ? RULES.CONTRACT_TOTAL_SALARY.rule
            : RULES.SALARY.rule,
      calculationRuleVersion:
        arrangement === 'FIXED_PERIOD'
          ? RULES.FIXED_PERIOD_SALARY.version
          : arrangement === 'CONTRACT_TOTAL'
            ? RULES.CONTRACT_TOTAL_SALARY.version
            : RULES.SALARY.version,
      compensationRecordId: fact.compensationRecordId,
      timeKey: null,
      leaveRequestDayId: null,
      sourceDates: days,
    });
  }
  lines.sort((a, b) =>
    `${a.workDate ?? a.periodFrom}${a.type}`.localeCompare(
      `${b.workDate ?? b.periodFrom}${b.type}`,
    ),
  );
  // Benefit costs per period: the rate made per-period by the cadence (monthly × 12 / periods
  // per year, annual / periods per year), then prorated by the owned covered calendar days
  // (the approved V1 rule, as for salary). Rounded half-up per line.
  const benefitLines: BenefitLineDraft[] = [];
  const periodsPerYear = PERIODS_PER_YEAR[input.period.cadence];
  usedBenefits.forEach(({ fact, dates }, factIndex) => {
    const perPeriod = (amount: string) => {
      const value = new Decimal(amount);
      return fact.frequency === 'PER_PAY_PERIOD'
        ? value
        : fact.frequency === 'MONTHLY'
          ? value.mul(12).div(periodsPerYear)
          : value.div(periodsPerYear);
    };
    const partial = dates.length < periodDays;
    for (const [kind, rated] of [
      ['DEDUCTION', fact.employeeAmount],
      ['CONTRIBUTION', fact.employerAmount],
    ] as const) {
      const amount = money(perPeriod(rated).mul(dates.length).div(periodDays));
      if (amount.lte(0)) continue;
      benefitLines.push({
        kind,
        enrollmentId: fact.enrollmentId,
        rateId: fact.rateId,
        factIndex,
        planCode: fact.planCode,
        description: `${fact.planName} (${fact.optionCode}) ${kind === 'DEDUCTION' ? 'employee cost' : 'employer contribution'}: ${rated} ${fact.frequency.toLowerCase().replaceAll('_', ' ')}${partial ? ` x ${dates.length}/${periodDays} days` : ''}`,
        amount: amount.toFixed(2),
        calculationRule: RULES.BENEFIT.rule,
        calculationRuleVersion: RULES.BENEFIT.version,
        sourceDates: dates,
      });
    }
  });
  const gross = lines.reduce(
    (total, line) => total.add(line.amount),
    new Decimal(0),
  );
  return {
    ...owned,
    blocked,
    issues,
    lines,
    benefitLines,
    grossAmount: money(gross).toFixed(2),
  };
}
