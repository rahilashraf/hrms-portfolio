/**
 * Phase 10 Batch 9 — the boundary for statutory payroll (income tax, CPP/CPP2, EI and their
 * employer contributions). Phase 10 defines the contract only: NO Canadian (or any other)
 * statutory calculation exists. Until an engine implements this contract, every run keeps
 * statutoryStatus NOT_CALCULATED, carries no statutory deduction or contribution lines, and
 * reports gross pay only — never a "net pay" that would look legally complete.
 *
 * A future engine receives the run's taxable/pensionable/insurable earnings per employee with
 * year-to-date values and the employee's statutory profile (TD1 claims, exemptions — not
 * modelled yet), and returns STATUTORY deduction and employer contribution lines plus the new
 * year-to-date figures.
 */
export const STATUTORY_PAYROLL_CALCULATOR = Symbol(
  'STATUTORY_PAYROLL_CALCULATOR',
);

export interface StatutoryEmployeeInput {
  employeeId: string;
  /** e.g. 'CA-ON' (country-province); jurisdiction resolution is future work. */
  jurisdiction: string | null;
  /** Decimal strings, 2 decimals. */
  taxableEarnings: string;
  pensionableEarnings: string;
  insurableEarnings: string;
  yearToDate: {
    taxableEarnings: string;
    pensionableEarnings: string;
    insurableEarnings: string;
  };
  /** Future: TD1 claim codes, CPP/EI exemptions. Never stored in Phase 10. */
  statutoryProfile: null;
}

export interface StatutoryPayrollInput {
  payrollRunId: string;
  currency: string;
  /** YYYY-MM-DD. */
  payDate: string;
  payPeriodsPerYear: number;
  employees: StatutoryEmployeeInput[];
}

export interface StatutoryLine {
  employeeId: string;
  /** e.g. 'CPP', 'CPP2', 'EI', 'FEDERAL_TAX', 'PROVINCIAL_TAX'. */
  code: string;
  description: string;
  amount: string;
}

export type StatutoryPayrollResult =
  | {
      status: 'NOT_CALCULATED';
      /** Why no statutory figures exist (shown to payroll administrators). */
      reason: string;
    }
  | {
      status: 'CALCULATED';
      engine: string;
      engineVersion: string;
      deductions: StatutoryLine[];
      employerContributions: StatutoryLine[];
    };

export interface StatutoryPayrollCalculator {
  calculate(input: StatutoryPayrollInput): Promise<StatutoryPayrollResult>;
}

/**
 * The only calculator Phase 10 ships: it calculates nothing and says so. Replacing it is the
 * single integration point of a future statutory engine.
 */
export class NoStatutoryPayrollCalculator implements StatutoryPayrollCalculator {
  calculate(): Promise<StatutoryPayrollResult> {
    return Promise.resolve({
      status: 'NOT_CALCULATED',
      reason:
        'No statutory payroll engine is configured: income tax, CPP/CPP2 and EI are not calculated. Payroll results are gross pay only.',
    });
  }
}
