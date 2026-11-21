'use client';

import { formatDateOnly, formatMoney, label } from '../../lib/payroll/format';
import type {
  PayrollEmployeeDetail,
  PayrollRunDetail,
  PayrollRunStatus,
  Payslip,
} from '../../lib/payroll/types';
import { cell, secondaryButton, Table } from './payroll-shared';

/**
 * Batch 6A — one pay statement, printable (browser print / Save as PDF). Employees see their
 * finalized statements (My Pay); payroll administrators see any employee's statement of a run.
 * Adjustment lines and benefit deductions are shown as such; net pay is never shown because
 * statutory deductions are not calculated.
 */
export interface PayslipModel {
  employerName: string;
  employeeName: string;
  employeeNumber: string;
  payGroup: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  currency: string;
  /** Only a FINALIZED run's statement is a pay statement; anything else is a preview. */
  runStatus: PayrollRunStatus;
  earnings: Array<{
    id: string;
    description: string;
    type: string;
    adjustment: boolean;
    positionName: string;
    date: string | null;
    hours: string | null;
    amount: string;
  }>;
  deductions: Array<{ id: string; category: string; description: string; amount: string }>;
  contributions: Array<{ id: string; category: string; description: string; amount: string }>;
  totals: { gross: string; deductions: string; contributions: string; paidHours: string | null };
  yearToDateGross: string | null;
}

const lineDate = (line: {
  workDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
}) =>
  line.workDate
    ? formatDateOnly(line.workDate)
    : line.periodFrom
      ? `${formatDateOnly(line.periodFrom)} – ${formatDateOnly(line.periodTo)}`
      : null;

/** The employee's own finalized statement (My Pay). */
export function payslipFromSelf(payslip: Payslip): PayslipModel {
  return {
    employerName: payslip.employer.name,
    employeeName: payslip.employee.displayName,
    employeeNumber: payslip.employee.employeeNumber,
    payGroup: payslip.payGroup,
    ...payslip.period,
    currency: payslip.currency,
    runStatus: 'FINALIZED',
    earnings: payslip.earnings.map((line) => ({
      id: line.id,
      description: line.description,
      type: line.type,
      adjustment: line.type === 'RETRO_ADJUSTMENT',
      positionName: line.positionName,
      date: lineDate(line),
      hours: line.hours,
      amount: line.amount,
    })),
    deductions: payslip.deductions,
    contributions: payslip.employerContributions,
    totals: {
      gross: payslip.totals.grossAmount,
      deductions: payslip.totals.deductionAmount,
      contributions: payslip.totals.employerContributionAmount,
      paidHours: payslip.totals.paidHours,
    },
    yearToDateGross: payslip.yearToDate.grossAmount,
  };
}

/** An employee's statement of a run, as payroll administrators read it. */
export function payslipFromRun(
  run: PayrollRunDetail,
  employee: PayrollEmployeeDetail,
): PayslipModel {
  return {
    employerName: run.organization.name,
    employeeName: employee.displayName,
    employeeNumber: employee.employeeNumber,
    payGroup: run.payGroup.name,
    periodStart: run.period.periodStart,
    periodEnd: run.period.periodEnd,
    payDate: run.period.payDate,
    currency: run.currency,
    runStatus: run.status,
    earnings: employee.assignments.flatMap((assignment) =>
      assignment.earnings.map((line) => ({
        id: line.id,
        description: line.description,
        type: line.type,
        adjustment: line.origin === 'ADJUSTMENT',
        positionName: assignment.positionName,
        date: lineDate(line),
        hours:
          line.quantityUnit === 'MINUTES' && line.quantity
            ? (Number(line.quantity) / 60).toFixed(2)
            : null,
        amount: line.amount,
      })),
    ),
    deductions: employee.assignments.flatMap((assignment) => assignment.deductions),
    contributions: employee.assignments.flatMap((assignment) => assignment.employerContributions),
    totals: {
      gross: employee.grossAmount ?? '0.00',
      deductions: employee.deductionAmount ?? '0.00',
      contributions: employee.employerContributionAmount ?? '0.00',
      paidHours: null,
    },
    yearToDateGross: null,
  };
}

const DEDUCTION_LABELS: Record<string, string> = {
  BENEFIT: 'Benefit deduction',
  ADJUSTMENT: 'Adjustment',
  MANUAL: 'Manual deduction',
  STATUTORY: 'Statutory deduction',
};

export function PayslipDocument({ payslip, onClose }: { payslip: PayslipModel; onClose?(): void }) {
  const money = (value: string) => formatMoney(value, payslip.currency);
  const preview = payslip.runStatus !== 'FINALIZED';
  const period = `${formatDateOnly(payslip.periodStart)} – ${formatDateOnly(payslip.periodEnd)}`;
  return (
    <article
      aria-label={`Pay statement for ${payslip.employeeName}, pay date ${formatDateOnly(payslip.payDate)}`}
      className="payslip-print-root space-y-4 rounded-xl border border-slate-200 bg-white p-5 print:rounded-none print:border-0 print:p-0"
    >
      <div className="flex flex-wrap justify-end gap-2 print:hidden">
        <button type="button" className={secondaryButton} onClick={() => window.print()}>
          Print or save as PDF
        </button>
        {onClose && (
          <button type="button" className={secondaryButton} onClick={onClose}>
            Close
          </button>
        )}
      </div>
      {preview && (
        <p
          role="note"
          className="rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm font-semibold text-slate-800"
        >
          Preview — this run is {label(payslip.runStatus).toLowerCase()}, not finalized. This is not
          a pay statement.
        </p>
      )}
      <header className="flex flex-col gap-1 border-b border-slate-200 pb-3 sm:flex-row sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase text-slate-500">Pay statement</p>
          <h2 className="text-lg font-semibold text-slate-900">{payslip.employerName}</h2>
          <p className="text-sm text-slate-700">
            {payslip.employeeName} · Employee {payslip.employeeNumber}
          </p>
          <p className="text-sm text-slate-700">Pay group {payslip.payGroup}</p>
        </div>
        <dl className="text-sm text-slate-700 sm:text-right">
          <div>
            <dt className="inline">Pay date </dt>
            <dd className="inline font-semibold">{formatDateOnly(payslip.payDate)}</dd>
          </div>
          <div>
            <dt className="inline">Pay period </dt>
            <dd className="inline">{period}</dd>
          </div>
          <div>
            <dt className="inline">Currency </dt>
            <dd className="inline">{payslip.currency}</dd>
          </div>
        </dl>
      </header>

      <h3 className="text-sm font-semibold uppercase text-slate-600">Earnings</h3>
      {payslip.earnings.length === 0 ? (
        <p className="text-sm text-slate-600">No earnings.</p>
      ) : (
        <Table head={['Earning', 'Date', 'Hours', 'Amount']} label="Earnings">
          {payslip.earnings.map((line) => (
            <tr key={line.id}>
              <td className={cell}>
                {line.description}
                <span className="block text-xs text-slate-600">
                  {line.adjustment ? 'Adjustment' : label(line.type)} · {line.positionName}
                </span>
              </td>
              <td className={cell}>{line.date ?? '—'}</td>
              <td className={cell}>{line.hours ?? '—'}</td>
              <td className={`${cell} whitespace-nowrap text-right`}>{money(line.amount)}</td>
            </tr>
          ))}
        </Table>
      )}

      <h3 className="text-sm font-semibold uppercase text-slate-600">Recorded deductions</h3>
      {payslip.deductions.length === 0 ? (
        <p className="text-sm text-slate-600">No recorded deductions.</p>
      ) : (
        <Table head={['Deduction', 'Type', 'Amount']} label="Recorded deductions">
          {payslip.deductions.map((line) => (
            <tr key={line.id}>
              <td className={cell}>{line.description}</td>
              <td className={cell}>{DEDUCTION_LABELS[line.category] ?? label(line.category)}</td>
              <td className={`${cell} whitespace-nowrap text-right`}>{money(line.amount)}</td>
            </tr>
          ))}
        </Table>
      )}

      {payslip.contributions.length > 0 && (
        <>
          <h3 className="text-sm font-semibold uppercase text-slate-600">
            Employer contributions (not deducted from pay)
          </h3>
          <Table head={['Contribution', 'Amount']} label="Employer contributions">
            {payslip.contributions.map((line) => (
              <tr key={line.id}>
                <td className={cell}>{line.description}</td>
                <td className={`${cell} whitespace-nowrap text-right`}>{money(line.amount)}</td>
              </tr>
            ))}
          </Table>
        </>
      )}

      <dl className="grid grid-cols-2 gap-3 border-t border-slate-200 pt-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-slate-600">Gross pay</dt>
          <dd className="font-semibold text-slate-900">{money(payslip.totals.gross)}</dd>
        </div>
        <div>
          <dt className="text-slate-600">Recorded deductions</dt>
          <dd className="font-semibold text-slate-900">{money(payslip.totals.deductions)}</dd>
        </div>
        {payslip.totals.paidHours !== null && (
          <div>
            <dt className="text-slate-600">Paid hours</dt>
            <dd className="font-semibold text-slate-900">{payslip.totals.paidHours}</dd>
          </div>
        )}
        {payslip.yearToDateGross !== null && (
          <div>
            <dt className="text-slate-600">Gross year to date</dt>
            <dd className="font-semibold text-slate-900">{money(payslip.yearToDateGross)}</dd>
          </div>
        )}
        <div>
          <dt className="text-slate-600">Net pay</dt>
          <dd className="font-semibold text-slate-900">Not calculated</dd>
        </div>
      </dl>
      <p
        role="note"
        className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      >
        Statutory deductions (such as income tax and social insurance contributions) are not
        calculated. This statement shows gross pay and the deductions payroll records only; gross
        less recorded deductions is not net pay.
      </p>
    </article>
  );
}
