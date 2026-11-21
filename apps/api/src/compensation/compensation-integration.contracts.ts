/**
 * Phase 9 — the narrow Compensation contract for future consumers (Phase 10 Payroll).
 *
 * Compensation exposes FACTS only: which compensation applied to an assignment on a date. It
 * never calculates regular, gross or net pay, overtime, salary proration, tax, deductions,
 * benefits, vacation pay or retro pay. Payroll combines these facts with Time's approved
 * worked time and Scheduling's expected work, and snapshots the exact fact it used (record id,
 * basis, amount, currency, period, pay group) when it finalizes a calculation, so finalized pay
 * never depends on later live compensation queries. A later change or correction never alters
 * an existing record: it closes the period or supersedes the record, and the id identifies what
 * applied.
 */

export type PayrollPayBasis = 'HOURLY' | 'SALARY';
export type PayrollSalaryArrangement =
  'ANNUAL' | 'FIXED_PERIOD' | 'CONTRACT_TOTAL';

export interface PayrollCompensationFact {
  compensationRecordId: string;
  employmentAssignmentId: string;
  /** HOURLY: rateAmount is per hour. SALARY: interpretation follows salaryArrangement. */
  payBasis: PayrollPayBasis;
  /** Decimal string with 4 decimals ("24.5000"); never a JavaScript number. */
  rateAmount: string;
  salaryArrangement: PayrollSalaryArrangement | null;
  salaryMonthlyAmount: string | null;
  salaryPaidMonths: number | null;
  salaryContractAmount: string | null;
  salaryPeriodStart: string | null;
  salaryPeriodEnd: string | null;
  /** ISO-4217 code; no conversion is ever applied. */
  currency: string;
  /** Inclusive YYYY-MM-DD period. */
  effectiveFrom: string;
  /**
   * Inclusive end, or null when open-ended. An open-ended record of an assignment that has an
   * end date is reported with that end date: compensation never outlives its assignment.
   */
  effectiveTo: string | null;
  payGroupId: string | null;
}

export const PAYROLL_COMPENSATION_SOURCE = Symbol(
  'PAYROLL_COMPENSATION_SOURCE',
);

export interface PayrollCompensationSource {
  /**
   * The single compensation fact of the assignment on `date` (YYYY-MM-DD), or null when there
   * is none (before or after the assignment, or a gap). Never "the latest record".
   * `client` is the caller's transaction, when it has one.
   */
  compensationEffectiveOn(
    query: { employmentAssignmentId: string; date: string },
    client?: unknown,
  ): Promise<PayrollCompensationFact | null>;

  /**
   * The assignments with at least one fact in the pay group overlapping [from, to] (inclusive):
   * the population of that pay group's payroll for the period. Cancelled assignments never.
   */
  payGroupAssignmentsBetween(
    query: { payGroupId: string; from: string; to: string },
    client?: unknown,
  ): Promise<Array<{ employmentAssignmentId: string; employeeId: string }>>;

  /** Every fact overlapping [from, to] (inclusive), in date order: one pay period's facts. */
  compensationFactsBetween(
    query: { employmentAssignmentId: string; from: string; to: string },
    client?: unknown,
  ): Promise<PayrollCompensationFact[]>;
}
