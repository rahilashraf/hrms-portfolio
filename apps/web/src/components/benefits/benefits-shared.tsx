'use client';

import { StatusBadge } from '../ui/status-badge';
import type { Tone } from '../ui/tokens';
import { formatDateOnly, formatMoney, label } from '../../lib/payroll/format';
import type { ElectionCost, ElectionStatus } from '../../lib/benefits/types';

export { EmptyState, inputClass, primaryButton, secondaryButton } from '../payroll/payroll-shared';
export { formatDateOnly, formatMoney, label };

/**
 * Batch 10E-2: election statuses use `StatusBadge` with explicit tones that keep each status
 * distinct (as the earlier colours did): a pending election is upcoming coverage (info), not a
 * warning; a superseded one was replaced by a correction (danger).
 */
const STATUS_TONES: Record<ElectionStatus, Tone> = {
  PENDING: 'info',
  ACTIVE: 'success',
  ENDED: 'neutral',
  WAIVED: 'warning',
  SUPERSEDED: 'danger',
};

export function ElectionStatusBadge({ status }: { status: ElectionStatus }) {
  return <StatusBadge status={status} label={label(status)} tone={STATUS_TONES[status]} />;
}

export const FLAG_LABELS: Record<string, string> = {
  SPONSOR_ASSIGNMENT_ENDED: 'Coverage outlives the sponsoring assignment',
  ELIGIBILITY_LOST: 'No longer eligible',
  DEPENDENT_INELIGIBLE: 'A covered dependent is no longer eligible',
  RATE_MISSING: 'No rate for the coverage',
  SPONSOR_NOT_ON_PAYROLL: 'Sponsoring assignment is not on payroll',
};

export function FlagList({ flags }: { flags: readonly string[] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-amber-800">
      {flags.map((flag) => (
        <li key={flag}>⚠ {FLAG_LABELS[flag] ?? label(flag)}</li>
      ))}
    </ul>
  );
}

/** "CAD 25.00 monthly (employer CAD 75.00)", hiding the employer part when not shown. */
export function costText(cost: ElectionCost | null) {
  if (!cost) return '—';
  const frequency = label(cost.frequency).toLowerCase();
  const employee = `${formatMoney(cost.employeeAmount, cost.currency)} ${frequency}`;
  return cost.employerAmount === null
    ? employee
    : `${employee} (employer ${formatMoney(cost.employerAmount, cost.currency)})`;
}

export function coveragePeriod(start: string, end: string | null) {
  return `${formatDateOnly(start)} – ${end ? formatDateOnly(end) : 'ongoing'}`;
}
