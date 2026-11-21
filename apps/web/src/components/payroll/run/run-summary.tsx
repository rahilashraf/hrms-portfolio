'use client';

import { formatMoney, label } from '../../../lib/payroll/format';
import type { PayrollRunActor, PayrollRunDetail } from '../../../lib/payroll/types';

/** M2: an attributed actor; a step done before attribution existed reads "Not recorded". */
function actor(person: PayrollRunActor | null | undefined, at: string | null): string {
  if (person) return person.name ?? 'Unnamed user';
  return at ? 'Not recorded' : '—';
}

// Batch 10D: moved from payroll-run-page.tsx unchanged.
export function Summary({ run }: { run: PayrollRunDetail }) {
  const money = (value: string | null) => formatMoney(value, run.currency);
  const rows: Array<[string, string]> = [
    ['Gross pay', money(run.totals.grossAmount)],
    ['Deductions', money(run.totals.deductionAmount)],
    ['Employer contributions', money(run.totals.employerContributionAmount)],
    ['Net pay', 'Not calculated (statutory deductions are not calculated)'],
    ['Employees', String(run.employees.length)],
    [
      'Validation',
      `${run.issueCounts.ERROR} error(s), ${run.issueCounts.WARNING} warning(s), ${run.issueCounts.INFO} note(s)`,
    ],
    ['Calculated', run.calculatedAt ? new Date(run.calculatedAt).toLocaleString() : '—'],
    // Security remediation M2: who prepared and who approved the run.
    ['Calculated by', actor(run.calculatedBy, run.calculatedAt)],
    ['Calculation version', run.calculationVersion ?? '—'],
    ['Approved', run.approvedAt ? new Date(run.approvedAt).toLocaleString() : '—'],
    ['Approved by', actor(run.approvedBy, run.approvedAt)],
    ['Finalized', run.finalizedAt ? new Date(run.finalizedAt).toLocaleString() : '—'],
    ['Finalized by', actor(run.finalizedBy, run.finalizedAt)],
    ['Statutory status', label(run.statutoryStatus)],
  ];
  if (run.dualControl !== undefined)
    rows.push([
      'Dual control',
      run.dualControl
        ? 'On: preparation and approval need two people'
        : 'Off for this organization',
    ]);
  if (run.voidReason) rows.push(['Void reason', run.voidReason]);
  return (
    <dl className="grid gap-3 rounded-xl border border-slate-200 bg-white p-5 text-sm sm:grid-cols-2">
      {rows.map(([name, value]) => (
        <div key={name}>
          <dt className="text-slate-500">{name}</dt>
          <dd className="font-medium text-slate-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
