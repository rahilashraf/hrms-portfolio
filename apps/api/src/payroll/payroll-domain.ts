import { BadRequestException, ConflictException } from '@nestjs/common';
import { isIsoCurrency } from '../common/currency.js';
import {
  daysBetweenInclusive,
  domainError,
  formatDate,
  localDateOf,
} from '../common/domain-support.js';
import { isIanaTimezone } from '../common/timezone.js';
import type {
  PayrollCalendarCadence,
  PayrollRunStatus,
} from '../generated/prisma/client.js';

/**
 * Phase 10 Batch 1 — pure Payroll domain rules for the structure that exists so far (calendars,
 * periods, runs, validation issues). No calculation lives here yet. Each rule mirrors, and fails
 * before, the matching database constraint of the phase10_payroll_foundation migration.
 *
 * Dates are date-only values (UTC-midnight Dates) like every other effective-dated domain here;
 * ranges are inclusive.
 */

/** Every supported cadence yields a period of at most a calendar month. */
export const MAX_PAYROLL_PERIOD_DAYS = 31;
/** Pay date = period end + offset; negative pays before the period ends. */
export const PAY_DATE_OFFSET_RANGE = { min: -31, max: 60 } as const;
/** Processing cutoff = this many days before the pay date. */
export const CUTOFF_OFFSET_RANGE = { min: 0, max: 60 } as const;
/** Finalized runs are never rewritten (changes become adjustments); voided runs stay as history. */
export const TERMINAL_PAYROLL_RUN_STATUSES: readonly PayrollRunStatus[] = [
  'FINALIZED',
  'VOIDED',
];
/** Stable, machine-readable validation issue codes (e.g. MISSING_COMPENSATION). */
const VALIDATION_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

function invalid(code: string, message: string): never {
  throw new BadRequestException(domainError(400, code, message));
}

/** ISO-4217 code of a run; one currency per run, never converted. */
export function parsePayrollCurrency(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!isIsoCurrency(code)) {
    invalid(
      'PAYROLL_CURRENCY_INVALID',
      'currency must be an ISO-4217 code such as "CAD" or "USD".',
    );
  }
  return code;
}

/** An explicit IANA timezone: payroll never assumes UTC or a server zone. */
export function parsePayrollTimezone(value: unknown): string {
  const timezone = typeof value === 'string' ? value.trim() : '';
  if (!isIanaTimezone(timezone)) {
    invalid(
      'PAYROLL_TIMEZONE_INVALID',
      'timezone must be an explicit IANA time zone such as "America/Toronto".',
    );
  }
  return timezone;
}

/** A calendar's effective range: effectiveTo (inclusive) is open-ended or not before the start. */
export function assertCalendarEffectiveRange(
  effectiveFrom: Date,
  effectiveTo: Date | null,
) {
  if (effectiveTo && effectiveTo < effectiveFrom) {
    invalid(
      'PAYROLL_CALENDAR_EFFECTIVE_RANGE_INVALID',
      'effectiveTo must not be before effectiveFrom.',
    );
  }
}

/** The structural rules of a calendar (period generation itself comes in a later batch). */
export function assertCalendarRules(rules: {
  cadence: PayrollCalendarCadence;
  anchorDate: Date;
  payDateOffsetDays: number;
  processingCutoffOffsetDays: number;
}) {
  const day = rules.anchorDate.getUTCDate();
  if (rules.cadence === 'SEMIMONTHLY' && day !== 1 && day !== 16) {
    invalid(
      'PAYROLL_CALENDAR_ANCHOR_INVALID',
      'A semi-monthly calendar is anchored on the 1st or the 16th.',
    );
  }
  if (rules.cadence === 'MONTHLY' && day > 28) {
    invalid(
      'PAYROLL_CALENDAR_ANCHOR_INVALID',
      'A monthly calendar is anchored on day 1 to 28, which every month has.',
    );
  }
  const within = (value: number, range: { min: number; max: number }) =>
    Number.isInteger(value) && value >= range.min && value <= range.max;
  if (!within(rules.payDateOffsetDays, PAY_DATE_OFFSET_RANGE)) {
    invalid(
      'PAYROLL_CALENDAR_OFFSET_INVALID',
      `payDateOffsetDays must be a whole number from ${PAY_DATE_OFFSET_RANGE.min} to ${PAY_DATE_OFFSET_RANGE.max}.`,
    );
  }
  if (!within(rules.processingCutoffOffsetDays, CUTOFF_OFFSET_RANGE)) {
    invalid(
      'PAYROLL_CALENDAR_OFFSET_INVALID',
      `processingCutoffOffsetDays must be a whole number from ${CUTOFF_OFFSET_RANGE.min} to ${CUTOFF_OFFSET_RANGE.max}.`,
    );
  }
}

/**
 * A period's own dates: it ends on or after it starts, spans at most a calendar month, is paid
 * on or after its first day, and its processing cutoff falls on or before the pay date in the
 * period's timezone.
 */
export function assertPayrollPeriodDates(period: {
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  processingCutoffAt: Date;
  timezone: string;
}) {
  if (period.periodEnd < period.periodStart) {
    invalid(
      'PAYROLL_PERIOD_DATES_INVALID',
      'periodEnd must not be before periodStart.',
    );
  }
  if (
    daysBetweenInclusive(period.periodStart, period.periodEnd) >
    MAX_PAYROLL_PERIOD_DAYS
  ) {
    invalid(
      'PAYROLL_PERIOD_DATES_INVALID',
      `A payroll period spans at most ${MAX_PAYROLL_PERIOD_DAYS} days.`,
    );
  }
  if (period.payDate < period.periodStart) {
    invalid(
      'PAYROLL_PERIOD_PAY_DATE_INVALID',
      'payDate must not be before the period starts.',
    );
  }
  const cutoffDate = localDateOf(
    period.processingCutoffAt,
    parsePayrollTimezone(period.timezone),
  );
  if (cutoffDate > period.payDate) {
    invalid(
      'PAYROLL_PERIOD_CUTOFF_INVALID',
      `The processing cutoff (${formatDate(cutoffDate)} local) must not be after the pay date (${formatDate(period.payDate)}).`,
    );
  }
}

export function isTerminalPayrollRunStatus(status: PayrollRunStatus): boolean {
  return TERMINAL_PAYROLL_RUN_STATUSES.includes(status);
}

/** Refuses any change to a finalized or voided run (the database refuses it too). */
export function assertPayrollRunMutable(run: { status: PayrollRunStatus }) {
  if (isTerminalPayrollRunStatus(run.status)) {
    throw new ConflictException(
      domainError(
        409,
        'PAYROLL_RUN_FINAL',
        run.status === 'FINALIZED'
          ? 'A finalized payroll run is never changed; later changes become adjustments.'
          : 'A voided payroll run cannot be changed.',
      ),
    );
  }
}

export function isPayrollValidationCode(code: string): boolean {
  return VALIDATION_CODE.test(code);
}

/** Largest money amount a manual line or adjustment may carry (Decimal(19,2) headroom). */
export const MAX_PAYROLL_AMOUNT = 1_000_000_000;

/**
 * A money amount entered by a person: a decimal string or number with at most two decimals,
 * never zero, positive unless `allowNegative`. Returned as a fixed 2-decimal string.
 */
export function parsePayrollAmount(
  value: unknown,
  options: { allowNegative?: boolean } = {},
): string {
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  const pattern = options.allowNegative
    ? /^-?\d+(\.\d{1,2})?$/
    : /^\d+(\.\d{1,2})?$/;
  const numeric = Number(text);
  if (
    !pattern.test(text) ||
    numeric === 0 ||
    Math.abs(numeric) >= MAX_PAYROLL_AMOUNT
  ) {
    invalid(
      'PAYROLL_AMOUNT_INVALID',
      options.allowNegative
        ? 'amount must be a non-zero amount with at most two decimals.'
        : 'amount must be a positive amount with at most two decimals.',
    );
  }
  return numeric.toFixed(2);
}

/** A required, trimmed free-text field (reason, description) of at most `max` characters. */
export function requirePayrollText(
  value: unknown,
  field: string,
  max = 500,
): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) {
    invalid(
      'PAYROLL_TEXT_INVALID',
      `${field} is required and must be at most ${max} characters.`,
    );
  }
  return text;
}
