'use client';

import type { ReactNode } from 'react';
import { RUN_STATUS_STYLES, label } from '../../lib/payroll/format';
import type { PayrollIssueSeverity, PayrollRunStatus } from '../../lib/payroll/types';
import { StatusBadge } from '../ui/status-badge';
import type { Tone } from '../ui/tokens';

export {
  EmptyState,
  inputClass,
  primaryButton,
  secondaryButton,
} from '../compensation/compensation-shared';

/**
 * A payroll run's state. Batch 10D: kept with its own palette — calculated (sky) and approved
 * (indigo) are distinct steps that the shared five tones would merge; the words always say which.
 */
export function RunStatusBadge({ status }: { status: PayrollRunStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${RUN_STATUS_STYLES[status]}`}
    >
      {label(status)}
    </span>
  );
}

/** Batch 10D: the shared StatusBadge (error = danger, warning = warning, info = neutral). */
const SEVERITY_TONES: Record<PayrollIssueSeverity, Tone> = {
  ERROR: 'danger',
  WARNING: 'warning',
  INFO: 'neutral',
};

export function SeverityBadge({ severity }: { severity: PayrollIssueSeverity }) {
  return <StatusBadge status={severity} label={label(severity)} tone={SEVERITY_TONES[severity]} />;
}

/** Gross pay only: statutory deductions are not calculated, so no net pay is shown. */
export function StatutoryNotice() {
  return (
    <p
      role="note"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      Statutory deductions (income tax, CPP/CPP2, EI) are not calculated. Payroll results are gross
      pay and manual deductions only. Net pay is not shown.
    </p>
  );
}

/**
 * Security remediation M2: shown wherever payroll runs are worked on when the organization has
 * turned dual control off (a System administrator's recorded decision).
 */
export function DualControlNotice({ dualControl }: { dualControl: boolean | undefined }) {
  if (dualControl !== false) return null;
  return (
    <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900">
      Dual control is disabled for this organization.
    </p>
  );
}

/**
 * Batch 10F: kept only for the printable payslip (`payslip-document.tsx`), an approved exception —
 * its tables are print layout, not interactive data tables. Use `DataTable` everywhere else.
 * A payroll table. With a `label` its scroll container is a named region keyboard users can
 * focus and scroll (Batch 6A: needed where a table can be wider than a phone screen).
 */
export function Table({
  head,
  children,
  label: regionLabel,
}: {
  head: string[];
  children: ReactNode;
  label?: string;
}) {
  return (
    <div
      className="overflow-x-auto rounded-xl border border-slate-200 bg-white"
      role={regionLabel ? 'region' : undefined}
      aria-label={regionLabel}
      tabIndex={regionLabel ? 0 : undefined}
    >
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
          <tr>
            {head.map((cell) => (
              <th key={cell} scope="col" className="px-4 py-2">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

/** Cell padding for the payslip's `Table` rows (Batch 10F: payslip only). */
export const cell = 'px-4 py-2 text-slate-800';
