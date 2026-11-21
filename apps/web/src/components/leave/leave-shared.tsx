'use client';

import type { ReactNode } from 'react';
import { lifecycleSteps, Stepper } from '../ui/stepper';
import { formatDateOnly, formatInstant, formatLeaveAmount, label } from '../../lib/leave/format';
import type {
  LeaveDay,
  LeaveDisplayUnit,
  LeaveLedgerView,
  LeaveRequestDetail,
} from '../../lib/leave/types';
import { dangerButton, inputClass, primaryButton, secondaryButton } from '../ui/tokens';
import { EmptyState, TableScroll } from '../ui/states';
import { StatusBadge } from '../ui/status-badge';

// Batch 3A: the shared tokens, re-exported so existing imports keep working.
export { dangerButton, inputClass, primaryButton, secondaryButton };

export function Panel({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

// Batch 3A: the shared EmptyState (its text-only form renders exactly as this module's did).
export { EmptyState };

/** Batch 10B: the shared StatusBadge (Pending, Approved, Rejected, Cancelled — words always shown). */
export function LeaveStatusPill({ value }: { value: string }) {
  return <StatusBadge status={value} label={label(value)} />;
}

export function BalanceFigures({
  balance,
  unit,
}: {
  balance: {
    currentMinutes: number;
    scheduledMinutes: number;
    availableMinutes: number;
    pendingMinutes?: number;
  };
  unit?: LeaveDisplayUnit;
}) {
  const figures: Array<[string, number]> = [
    ['Available', balance.availableMinutes],
    ['Current', balance.currentMinutes],
    ['Scheduled', balance.scheduledMinutes],
  ];
  if (balance.pendingMinutes !== undefined) figures.push(['Pending', balance.pendingMinutes]);
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {figures.map(([name, minutes]) => (
        <div key={name}>
          <dt className="text-xs uppercase text-slate-500">{name}</dt>
          <dd
            className={
              name === 'Available'
                ? 'text-lg font-semibold text-slate-950'
                : 'text-sm text-slate-800'
            }
          >
            {formatLeaveAmount(minutes, unit)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The frozen (or previewed) per-day sizing, with why each day counts what it counts. */
export function LeaveDaysTable({ days, timezone }: { days: LeaveDay[]; timezone: string }) {
  if (days.length === 0) return <EmptyState>No days.</EmptyState>;
  return (
    // Batch 6B: wider than a phone, so a named region keyboard users can focus and scroll.
    <TableScroll bare label="Leave days">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
          <tr>
            <th scope="col" className="px-3 py-2">
              Date
            </th>
            <th scope="col" className="px-3 py-2">
              Amount
            </th>
            <th scope="col" className="px-3 py-2">
              Basis
            </th>
            <th scope="col" className="px-3 py-2">
              Window
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {days.map((day) => (
            <tr key={day.date} className={day.cancelled ? 'text-slate-500 line-through' : ''}>
              <td className="px-3 py-2">{formatDateOnly(day.date)}</td>
              <td className="px-3 py-2">{formatLeaveAmount(day.minutes)}</td>
              <td className="px-3 py-2">
                {label(day.amountSource)}
                {day.holidayName && <span className="text-slate-500"> · {day.holidayName}</span>}
                {day.overrideReason && (
                  <span className="text-slate-500"> · {day.overrideReason}</span>
                )}
              </td>
              <td className="px-3 py-2 text-slate-600">
                {day.minutes > 0
                  ? `${formatInstant(day.windowStart, timezone)} – ${formatInstant(day.windowEnd, timezone)}`
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function LedgerTable({
  ledger,
  busy,
  onReverse,
}: {
  ledger: LeaveLedgerView;
  busy?: string | null;
  onReverse?: (entryId: string) => void;
}) {
  if (ledger.entries.length === 0) return <EmptyState>No ledger entries yet.</EmptyState>;
  return (
    <TableScroll bare label="Leave ledger">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
          <tr>
            <th scope="col" className="px-3 py-2">
              Effective
            </th>
            <th scope="col" className="px-3 py-2">
              Type
            </th>
            <th scope="col" className="px-3 py-2">
              Amount
            </th>
            <th scope="col" className="px-3 py-2">
              Reason
            </th>
            {onReverse && (
              <th scope="col" className="px-3 py-2">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {ledger.entries.map((entry) => (
            <tr key={entry.id}>
              <td className="px-3 py-2">{formatDateOnly(entry.effectiveDate)}</td>
              <td className="px-3 py-2">
                {label(entry.entryType)}
                {entry.reversedByEntryId && (
                  <span className="ml-1 text-xs text-slate-500">(reversed)</span>
                )}
              </td>
              <td
                className={`px-3 py-2 ${entry.amountMinutes < 0 ? 'text-rose-800' : 'text-emerald-800'}`}
              >
                {entry.amountMinutes > 0 ? '+' : ''}
                {formatLeaveAmount(entry.amountMinutes)}
              </td>
              <td className="px-3 py-2 text-slate-600">{entry.reason ?? '—'}</td>
              {onReverse && (
                <td className="px-3 py-2">
                  {entry.actions.canReverse && (
                    <button
                      type="button"
                      disabled={busy === `reverse-${entry.id}`}
                      onClick={() => onReverse(entry.id)}
                      className={secondaryButton}
                    >
                      Reverse
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

export function RequestHistory({ detail }: { detail: LeaveRequestDetail }) {
  return (
    <ol className="space-y-2 text-sm">
      {detail.events.map((event) => (
        <li key={event.id} className="flex flex-wrap gap-2">
          <span className="font-medium text-slate-900">{label(event.type)}</span>
          <span className="text-slate-500">{formatInstant(event.occurredAt, detail.timezone)}</span>
          {event.note && <span className="text-slate-700">— {event.note}</span>}
        </li>
      ))}
      {detail.amendments.map((amendment) => (
        <li key={amendment.id} className="flex flex-wrap gap-2">
          <span className="font-medium text-slate-900">{label(amendment.type)}</span>
          <span className="text-slate-500">
            {formatInstant(amendment.createdAt, detail.timezone)}
          </span>
          <span className="text-slate-700">
            — {amendment.reason} ({formatLeaveAmount(amendment.cancelledMinutes)} returned)
          </span>
        </li>
      ))}
    </ol>
  );
}

// ─── Request progress (Phase 20) ─────────────────────────────────────────────

/** The real LeaveRequestStatus path; REJECTED and CANCELLED are terminal and off it. */
const REQUEST_LIFECYCLE = [
  { key: 'PENDING', label: 'Submitted' },
  { key: 'APPROVED', label: 'Approved' },
] as const;

/** How a request affects the balance, from its own amounts and status (nothing estimated). */
export function balanceImpactText(
  detail: Pick<
    LeaveRequestDetail,
    'status' | 'requestedMinutes' | 'approvedMinutes' | 'activeMinutes' | 'leaveType'
  >,
): string {
  const unit = detail.leaveType.displayUnit;
  switch (detail.status) {
    case 'PENDING':
      return `This request would use ${formatLeaveAmount(detail.requestedMinutes, unit)} once approved.`;
    case 'APPROVED':
      return `This request uses ${formatLeaveAmount(detail.activeMinutes ?? detail.approvedMinutes ?? detail.requestedMinutes, unit)} of the balance.`;
    case 'REJECTED':
      return 'This request was rejected and does not use any balance.';
    case 'CANCELLED':
      return detail.activeMinutes
        ? `Cancelled; ${formatLeaveAmount(detail.activeMinutes, unit)} already taken still counts.`
        : 'This request was cancelled and does not use any balance.';
  }
}

/** Submitted → decision, plus who decided and when (from the request's own record). */
export function LeaveRequestProgress({ detail }: { detail: LeaveRequestDetail }) {
  const steps =
    detail.status === 'PENDING' || detail.status === 'APPROVED'
      ? lifecycleSteps(REQUEST_LIFECYCLE, detail.status, { completeAtEnd: true })
      : lifecycleSteps<string>(REQUEST_LIFECYCLE, detail.status, {
          reached: detail.approvedMinutes !== null ? 'APPROVED' : 'PENDING',
        });
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <Stepper label="Request progress" steps={steps} />
      <p className="text-xs text-slate-600">
        Submitted {formatInstant(detail.submittedAt, detail.timezone)}
        {detail.decidedAt
          ? ` · ${label(detail.status === 'CANCELLED' && detail.approvedMinutes !== null ? 'APPROVED' : detail.status)} ${formatInstant(detail.decidedAt, detail.timezone)}`
          : ' · Awaiting a decision'}
      </p>
    </div>
  );
}
