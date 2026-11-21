import { formatAmount } from '../compensation/format';
import type { PayrollRunStatus } from './types';

export { formatAmount };
export { formatDateOnly, label } from '../time/format';

/** "CAD 1,234.50", or an em dash when there is no amount. */
export function formatMoney(value: string | null | undefined, currency: string): string {
  return value === null || value === undefined ? '—' : `${currency} ${formatAmount(value)}`;
}

export const RUN_STATUS_STYLES: Record<PayrollRunStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  CALCULATED: 'bg-sky-50 text-sky-800',
  APPROVED: 'bg-indigo-50 text-indigo-800',
  FINALIZED: 'bg-emerald-50 text-emerald-800',
  VOIDED: 'bg-rose-50 text-rose-800',
};

/** Money as typed: a non-negative decimal with at most two places. */
export function isValidAmount(value: string): boolean {
  const trimmed = value.trim();
  return /^\d{1,12}(\.\d{1,2})?$/.test(trimmed) && /[1-9]/.test(trimmed);
}
