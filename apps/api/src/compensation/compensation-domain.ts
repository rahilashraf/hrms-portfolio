import { BadRequestException, ConflictException } from '@nestjs/common';
import { isIsoCurrency } from '../common/currency.js';
import { isIanaTimezone } from '../common/timezone.js';
import {
  addDays,
  domainError,
  formatDate,
  parseDateOnly,
} from '../common/domain-support.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  CompensationPayBasis,
  CompensationSalaryArrangement,
} from '../generated/prisma/client.js';

/**
 * Phase 9 — pure Compensation domain rules. Compensation records facts (basis, rate, currency,
 * effective period, pay group); it never calculates pay.
 *
 * Effective ranges are inclusive, date-only (UTC-midnight Dates), like every other effective-dated
 * domain here; effectiveTo null means "until changed or the assignment ends". The timeline of an
 * assignment is its records not superseded by a correction: it never overlaps, may have gaps
 * (a gap is missing data, never guessed), and stays inside the assignment.
 */

export const PAY_BASES = ['HOURLY', 'SALARY'] as const;
export const SALARY_ARRANGEMENTS = [
  'ANNUAL',
  'FIXED_PERIOD',
  'CONTRACT_TOTAL',
] as const;

/** Decimal(19,4): at most 15 integer digits and 4 decimals, strictly positive. */
const RATE_PATTERN = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/;

/**
 * Parses a rate given as a decimal string (never a JavaScript number, so no binary floating
 * point ever touches money) into a Prisma Decimal; returns its canonical 4-decimal string too.
 */
export function parseRateAmount(value: unknown, label = 'rateAmount') {
  if (typeof value !== 'string' || !RATE_PATTERN.test(value.trim())) {
    throw new BadRequestException(
      domainError(
        400,
        'COMPENSATION_RATE_INVALID',
        `${label} must be a positive decimal string with at most 15 integer digits and 4 decimals (e.g. "24.50").`,
      ),
    );
  }
  const decimal = new Prisma.Decimal(value.trim());
  if (decimal.lte(0)) {
    throw new BadRequestException(
      domainError(
        400,
        'COMPENSATION_RATE_INVALID',
        `${label} must be greater than zero.`,
      ),
    );
  }
  return { decimal, canonical: decimal.toFixed(4) };
}

/** Canonical decimal string of a stored amount ("24.5000"). */
export function formatRateAmount(value: Prisma.Decimal | string): string {
  return new Prisma.Decimal(value).toFixed(4);
}

/** ISO-4217 code: three uppercase letters known to the runtime's currency list. */
export function parseCurrency(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!isIsoCurrency(code)) {
    throw new BadRequestException(
      domainError(
        400,
        'COMPENSATION_CURRENCY_INVALID',
        'currency must be an ISO-4217 code such as "CAD" or "USD".',
      ),
    );
  }
  return code;
}

export function parsePayBasis(value: unknown): CompensationPayBasis {
  if (!(PAY_BASES as readonly unknown[]).includes(value)) {
    throw new BadRequestException(
      domainError(
        400,
        'COMPENSATION_PAY_BASIS_INVALID',
        'payBasis must be HOURLY or SALARY.',
      ),
    );
  }
  return value as CompensationPayBasis;
}

export interface ParsedSalaryArrangement {
  salaryArrangement: CompensationSalaryArrangement | null;
  salaryMonthlyAmount: Prisma.Decimal | null;
  salaryPaidMonths: number | null;
  salaryContractAmount: Prisma.Decimal | null;
  salaryPeriodStart: Date | null;
  salaryPeriodEnd: Date | null;
}

const SALARY_FIELDS = [
  'salaryArrangement',
  'salaryMonthlyAmount',
  'salaryPaidMonths',
  'salaryContractAmount',
  'salaryPeriodStart',
  'salaryPeriodEnd',
] as const;

function hasSalaryField(input: Record<string, unknown>) {
  return SALARY_FIELDS.some(
    (field) => input[field] !== undefined && input[field] !== null,
  );
}

function failSalary(message: string): never {
  throw new BadRequestException(
    domainError(400, 'COMPENSATION_SALARY_ARRANGEMENT_INVALID', message),
  );
}

function parseSalaryArrangementName(
  value: unknown,
): CompensationSalaryArrangement {
  if (!(SALARY_ARRANGEMENTS as readonly unknown[]).includes(value)) {
    failSalary(
      'salaryArrangement must be ANNUAL, FIXED_PERIOD or CONTRACT_TOTAL.',
    );
  }
  return value as CompensationSalaryArrangement;
}

function parseRequiredDate(value: unknown, label: string): Date {
  if (typeof value !== 'string') {
    failSalary(`${label} must use YYYY-MM-DD format.`);
  }
  return parseDateOnly(value, label);
}

function utcDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day));
}

function endOfMonth(date: Date) {
  return utcDate(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
}

function calendarMonthsInclusive(start: Date, end: Date): number {
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    start.getUTCMonth() +
    1
  );
}

export function parseSalaryArrangement(
  payBasis: CompensationPayBasis,
  input: Record<string, unknown>,
): ParsedSalaryArrangement {
  const empty: ParsedSalaryArrangement = {
    salaryArrangement: null,
    salaryMonthlyAmount: null,
    salaryPaidMonths: null,
    salaryContractAmount: null,
    salaryPeriodStart: null,
    salaryPeriodEnd: null,
  };
  if (payBasis === 'HOURLY') {
    if (hasSalaryField(input)) {
      failSalary(
        'Hourly compensation cannot include salary arrangement fields.',
      );
    }
    return empty;
  }

  const arrangement =
    input.salaryArrangement === undefined || input.salaryArrangement === null
      ? 'ANNUAL'
      : parseSalaryArrangementName(input.salaryArrangement);
  if (arrangement === 'ANNUAL') {
    if (
      input.salaryMonthlyAmount !== undefined ||
      input.salaryPaidMonths !== undefined ||
      input.salaryContractAmount !== undefined ||
      input.salaryPeriodStart !== undefined ||
      input.salaryPeriodEnd !== undefined
    ) {
      failSalary('Annual salary cannot include contracted salary fields.');
    }
    return { ...empty, salaryArrangement: 'ANNUAL' };
  }

  const salaryPeriodStart = parseRequiredDate(
    input.salaryPeriodStart,
    'salaryPeriodStart',
  );
  const salaryPeriodEnd = parseRequiredDate(
    input.salaryPeriodEnd,
    'salaryPeriodEnd',
  );
  if (salaryPeriodEnd < salaryPeriodStart) {
    failSalary('salaryPeriodEnd must be on or after salaryPeriodStart.');
  }

  if (arrangement === 'FIXED_PERIOD') {
    const salaryMonthlyAmount = parseRateAmount(
      input.salaryMonthlyAmount,
      'salaryMonthlyAmount',
    ).decimal;
    const salaryContractAmount = parseRateAmount(
      input.salaryContractAmount,
      'salaryContractAmount',
    ).decimal;
    const salaryPaidMonths = input.salaryPaidMonths;
    if (
      typeof salaryPaidMonths !== 'number' ||
      !Number.isInteger(salaryPaidMonths) ||
      salaryPaidMonths < 1 ||
      salaryPaidMonths > 120
    ) {
      failSalary('salaryPaidMonths must be an integer between 1 and 120.');
    }
    if (
      salaryPeriodStart.getUTCDate() !== 1 ||
      salaryPeriodEnd.getTime() !== endOfMonth(salaryPeriodEnd).getTime()
    ) {
      failSalary(
        'Fixed-period salary currently requires whole calendar months.',
      );
    }
    const months = calendarMonthsInclusive(salaryPeriodStart, salaryPeriodEnd);
    if (months !== salaryPaidMonths) {
      failSalary(
        'salaryPaidMonths must match the whole calendar months in the paid period.',
      );
    }
    if (
      !salaryMonthlyAmount
        .mul(salaryPaidMonths)
        .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
        .equals(salaryContractAmount)
    ) {
      failSalary(
        'salaryContractAmount must equal monthly amount times paid months.',
      );
    }
    return {
      salaryArrangement: arrangement,
      salaryMonthlyAmount,
      salaryPaidMonths,
      salaryContractAmount,
      salaryPeriodStart,
      salaryPeriodEnd,
    };
  }

  if (
    input.salaryMonthlyAmount !== undefined ||
    input.salaryPaidMonths !== undefined
  ) {
    failSalary(
      'Contract-total salary cannot include monthly amount or paid months.',
    );
  }
  return {
    ...empty,
    salaryArrangement: arrangement,
    salaryContractAmount: parseRateAmount(
      input.salaryContractAmount,
      'salaryContractAmount',
    ).decimal,
    salaryPeriodStart,
    salaryPeriodEnd,
  };
}

export function assertSalaryArrangementPeriod(
  values: ParsedSalaryArrangement,
  period: { effectiveFrom: Date; effectiveTo: Date | null },
) {
  if (
    values.salaryArrangement === null ||
    values.salaryArrangement === 'ANNUAL'
  )
    return;
  if (
    !values.salaryPeriodStart ||
    !values.salaryPeriodEnd ||
    values.salaryPeriodStart.getTime() !== period.effectiveFrom.getTime() ||
    !period.effectiveTo ||
    values.salaryPeriodEnd.getTime() !== period.effectiveTo.getTime()
  ) {
    failSalary(
      'Contracted salary periods must use the same effectiveFrom and effectiveTo as their paid period.',
    );
  }
}

/** The assignment's local timezone: its work location's, then its organization's; never UTC. */
export function compensationTimezone(position: {
  workLocation: { timezone: string | null } | null;
  organization: { timezone: string | null };
}): string | null {
  for (const candidate of [
    position.workLocation?.timezone,
    position.organization.timezone,
  ]) {
    if (candidate && isIanaTimezone(candidate)) return candidate.trim();
  }
  return null;
}

export interface TimelineRecord {
  id: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export const END_OF_TIME = new Date('9999-12-31T00:00:00.000Z');

export function periodsOverlap(
  a: { effectiveFrom: Date; effectiveTo: Date | null },
  b: { effectiveFrom: Date; effectiveTo: Date | null },
) {
  return (
    a.effectiveFrom <= (b.effectiveTo ?? END_OF_TIME) &&
    b.effectiveFrom <= (a.effectiveTo ?? END_OF_TIME)
  );
}

/**
 * The one record of a timeline effective on `date`, or null (a gap, or outside the timeline).
 * Never "the latest record": more than one match is a broken invariant and throws.
 */
export function recordEffectiveOn<T extends TimelineRecord>(
  timeline: readonly T[],
  date: Date,
): T | null {
  const matches = timeline.filter(
    (record) =>
      record.effectiveFrom <= date &&
      date <= (record.effectiveTo ?? END_OF_TIME),
  );
  if (matches.length > 1) {
    throw new Error(
      `Compensation timeline overlaps on ${formatDate(date)}: ${matches.map((m) => m.id).join(', ')}`,
    );
  }
  return matches[0] ?? null;
}

export interface AssignmentBounds {
  id: string;
  status: 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
  startDate: Date;
  endDate: Date | null;
}

/**
 * Lifecycle and boundary rules of a compensation period on its assignment:
 *  - a CANCELLED assignment never has compensation;
 *  - the period starts on or after the assignment start, and, when the assignment has an end
 *    (an ENDED assignment always does), starts and ends on or before it — so nothing becomes
 *    effective after an assignment has ended. An open-ended period simply ends with it.
 * PLANNED assignments may hold future compensation; ACTIVE ones current and future (and, as
 * legitimate retroactive changes, past dates inside the assignment); ENDED ones keep history.
 */
export function assertWithinAssignment(
  assignment: AssignmentBounds,
  period: { effectiveFrom: Date; effectiveTo: Date | null },
) {
  if (assignment.status === 'CANCELLED') {
    throw new ConflictException(
      domainError(
        409,
        'COMPENSATION_ASSIGNMENT_CANCELLED',
        'A cancelled assignment has no compensation.',
      ),
    );
  }
  if (period.effectiveTo && period.effectiveTo < period.effectiveFrom) {
    throw new BadRequestException(
      domainError(
        400,
        'COMPENSATION_PERIOD_INVALID',
        'effectiveTo must be on or after effectiveFrom.',
      ),
    );
  }
  const before = period.effectiveFrom < assignment.startDate;
  const after =
    assignment.endDate !== null &&
    (period.effectiveFrom > assignment.endDate ||
      (period.effectiveTo !== null && period.effectiveTo > assignment.endDate));
  if (before || after) {
    throw new BadRequestException(
      domainError(
        400,
        'COMPENSATION_OUTSIDE_ASSIGNMENT',
        'Compensation must stay within the assignment’s dates.',
        {
          assignmentStartDate: formatDate(assignment.startDate),
          assignmentEndDate:
            assignment.endDate && formatDate(assignment.endDate),
        },
      ),
    );
  }
}

export function assertNoOverlap(
  timeline: readonly TimelineRecord[],
  period: { effectiveFrom: Date; effectiveTo: Date | null },
  excludeId?: string,
) {
  const clashes = timeline.filter(
    (record) => record.id !== excludeId && periodsOverlap(record, period),
  );
  if (clashes.length > 0) {
    throw new ConflictException(
      domainError(
        409,
        'COMPENSATION_OVERLAP',
        'Compensation periods of an assignment cannot overlap.',
        {
          conflictingRecordIds: clashes.map((c) => c.id),
        },
      ),
    );
  }
}

/**
 * A compensation change effective `date`: the record in effect that day is closed the day
 * before, and the new period runs to where that record would have ended (so later scheduled
 * changes stay in place). There must be compensation in effect that day (otherwise it is an
 * initial period for a gap), and it must have started earlier (a change on a record's own start
 * date would replace it — that is a correction).
 *
 * A contracted salary (FIXED_PERIOD, CONTRACT_TOTAL) passes its paid period's end as
 * `contractedEnd`: the new period is then exactly `date`..`contractedEnd`, whatever the closed
 * record's end was. A later scheduled record starting inside that period is never shortened or
 * replaced: the change is refused instead.
 */
export function planChange<T extends TimelineRecord>(
  timeline: readonly T[],
  date: Date,
  contractedEnd: Date | null = null,
) {
  const covering = recordEffectiveOn(timeline, date);
  if (!covering) {
    throw new ConflictException(
      domainError(
        409,
        'COMPENSATION_NOT_IN_EFFECT',
        `No compensation is in effect on ${formatDate(date)}; record an initial period for that date instead.`,
      ),
    );
  }
  if (covering.effectiveFrom.getTime() === date.getTime()) {
    throw new ConflictException(
      domainError(
        409,
        'COMPENSATION_CHANGE_ON_START',
        'A change cannot start on the same date as the record in effect; correct that record instead.',
        { recordId: covering.id },
      ),
    );
  }
  if (contractedEnd !== null) {
    const scheduled = timeline.filter(
      (record) =>
        record.id !== covering.id &&
        record.effectiveFrom > date &&
        record.effectiveFrom <= contractedEnd,
    );
    if (scheduled.length > 0) {
      throw new ConflictException(
        domainError(
          409,
          'COMPENSATION_CHANGE_OVERLAPS_SCHEDULED',
          `The contracted period ${formatDate(date)} – ${formatDate(contractedEnd)} overlaps compensation already scheduled from ${formatDate(scheduled[0]!.effectiveFrom)}; correct or end that record first.`,
          { conflictingRecordIds: scheduled.map((record) => record.id) },
        ),
      );
    }
  }
  return {
    previous: covering,
    previousNewEnd: addDays(date, -1),
    period: {
      effectiveFrom: date,
      effectiveTo: contractedEnd ?? covering.effectiveTo,
    },
  };
}

/**
 * Which records an assignment change (new dates or status) would leave outside the assignment.
 * Used to refuse such a change: compensation is never modified silently.
 */
export function recordsOutsideAssignment<T extends TimelineRecord>(
  timeline: readonly T[],
  next: {
    status: AssignmentBounds['status'];
    startDate: Date;
    endDate: Date | null;
  },
): T[] {
  return timeline.filter(
    (record) =>
      next.status === 'CANCELLED' ||
      record.effectiveFrom < next.startDate ||
      (next.endDate !== null &&
        (record.effectiveFrom > next.endDate ||
          (record.effectiveTo !== null && record.effectiveTo > next.endDate))),
  );
}
