'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { employeeSource } from '../../lib/pickers/sources';
import { RecordCombobox } from '../ui/record-combobox';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { leaveApi } from '../../lib/leave/api';
import { leaveErrorMessage } from '../../lib/leave/errors';
import {
  formatDateOnly,
  formatLeaveAmount,
  hoursToMinutes,
  todayIso,
} from '../../lib/leave/format';
import type {
  LeaveBalanceRow,
  LeaveLedgerView,
  LeaveOrganization,
  LeaveType,
} from '../../lib/leave/types';
import {
  BalanceFigures,
  EmptyState,
  inputClass,
  LedgerTable,
  Panel,
  primaryButton,
  secondaryButton,
} from './leave-shared';
import { TableScroll } from '../ui/states';

/** Balance rows per page (the API allows 1–500). */
export const BALANCES_PAGE_SIZE = 100;

export function LeaveBalancesPanel({ organization }: { organization: LeaveOrganization }) {
  const [types, setTypes] = useState<LeaveType[]>([]);
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [asOf, setAsOf] = useState('');
  // Batch 6B: an employee filter (preselected by `?employeeId=`) and paging.
  const [employeeId, setEmployeeId] = useState(() =>
    typeof window === 'undefined'
      ? ''
      : (new URLSearchParams(window.location.search).get('employeeId') ?? ''),
  );
  const [employeeLabel, setEmployeeLabel] = useState<{ id: string; label: string } | null>(null);
  const employees = useMemo(
    () => employeeSource({ organizationId: organization.id }),
    [organization.id],
  );
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [rows, setRows] = useState<LeaveBalanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selected, setSelected] = useState<LeaveBalanceRow | null>(null);

  useEffect(() => {
    let active = true;
    leaveApi
      .types(organization.id)
      .then((result) => active && setTypes(result.items.filter((t) => t.tracksBalance)))
      .catch(() => active && setTypes([]));
    return () => {
      active = false;
    };
  }, [organization.id]);

  const fetchPage = useCallback(
    (afterId?: string) =>
      leaveApi.balances({
        organizationId: organization.id,
        ...(leaveTypeId ? { leaveTypeId } : {}),
        ...(employeeId ? { employeeId } : {}),
        ...(asOf ? { asOf } : {}),
        ...(afterId ? { afterId } : {}),
        limit: BALANCES_PAGE_SIZE,
      }),
    [organization.id, leaveTypeId, employeeId, asOf],
  );

  // Batch 6B: each (re)load starts a generation; a page answered for an older one (a filter
  // changed meanwhile) is dropped, so pages of different filters never mix.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const at = ++generation.current;
    setNext(null);
    const page = await fetchPage();
    if (generation.current !== at) return;
    setRows(page.items);
    setNext(page.nextAfterId);
  }, [fetchPage]);

  async function loadMore() {
    if (!next) return;
    const at = generation.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(next);
      if (generation.current !== at) return;
      setRows((current) => [...current, ...page.items]);
      setNext(page.nextAfterId);
    } catch (cause) {
      if (generation.current === at) setError(leaveErrorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      load()
        .then(() => active && setError(null))
        .catch((cause) => active && setError(leaveErrorMessage(cause)))
        .finally(() => active && setLoading(false));
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load]);

  return (
    <div className="space-y-6">
      <form
        aria-label="Balance filters"
        className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-5 md:grid-cols-3"
        onSubmit={(event) => event.preventDefault()}
      >
        <RecordCombobox
          label="Employee"
          source={employees}
          value={employeeId}
          selected={employeeLabel}
          placeholder="All employees"
          noResultsText="No employees match."
          onChange={(id, option) => {
            setEmployeeId(id);
            setEmployeeLabel(option ? { id: option.id, label: option.label } : null);
          }}
        />
        <label className="text-sm font-medium text-slate-700">
          Leave type
          <select
            value={leaveTypeId}
            onChange={(event) => setLeaveTypeId(event.target.value)}
            className={inputClass}
          >
            <option value="">All tracked types</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          As of (blank = each employee&apos;s today)
          <input
            type="date"
            value={asOf}
            onChange={(event) => setAsOf(event.target.value)}
            className={inputClass}
          />
        </label>
      </form>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
      <Panel title="Balances">
        {loading ? (
          <p role="status" className="text-sm text-slate-600">
            Loading balances…
          </p>
        ) : rows.length === 0 ? (
          <EmptyState>No leave balances yet.</EmptyState>
        ) : (
          <TableScroll bare label="Leave balances">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Employee
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Type
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Available
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Current
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Scheduled
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Pending
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr
                    key={row.accountId}
                    className={selected?.accountId === row.accountId ? 'bg-indigo-50' : ''}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">
                        {row.employee.displayName ?? row.employee.employeeNumber}
                      </div>
                      <div className="text-xs text-slate-500">
                        {row.positionName} ·{' '}
                        {row.asOf ? `as of ${formatDateOnly(row.asOf)}` : 'timezone not set'}
                      </div>
                    </td>
                    <td className="px-3 py-2">{row.leaveType.name}</td>
                    <td className="px-3 py-2 font-semibold">
                      {formatLeaveAmount(row.balance?.availableMinutes, row.leaveType.displayUnit)}
                    </td>
                    <td className="px-3 py-2">
                      {formatLeaveAmount(row.balance?.currentMinutes, row.leaveType.displayUnit)}
                    </td>
                    <td className="px-3 py-2">
                      {formatLeaveAmount(row.balance?.scheduledMinutes, row.leaveType.displayUnit)}
                    </td>
                    <td className="px-3 py-2">
                      {formatLeaveAmount(row.balance?.pendingMinutes, row.leaveType.displayUnit)}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className={secondaryButton}
                        onClick={() => setSelected(row)}
                      >
                        Ledger
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        {!loading && next && (
          <div className="mt-4">
            <button
              type="button"
              className={secondaryButton}
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? 'Loading…' : 'Load more balances'}
            </button>
          </div>
        )}
      </Panel>
      {selected && (
        <AccountLedger
          key={selected.accountId}
          row={selected}
          onClose={() => setSelected(null)}
          onChanged={async (message) => {
            setSuccess(message);
            await load().catch((cause) => setError(leaveErrorMessage(cause)));
          }}
        />
      )}
    </div>
  );
}

function AccountLedger({
  row,
  onClose,
  onChanged,
}: {
  row: LeaveBalanceRow;
  onClose(): void;
  onChanged(message: string): Promise<void>;
}) {
  const [ledger, setLedger] = useState<LeaveLedgerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hours, setHours] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(() => todayIso());
  const [reason, setReason] = useState('');
  const [reversing, setReversing] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  // One key per adjustment form: a double submit or retry posts the adjustment once.
  const [clientKey, setClientKey] = useState(() => crypto.randomUUID());

  const load = useCallback(async () => {
    setLedger(await leaveApi.ledger(row.accountId));
  }, [row.accountId]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      load().catch((cause) => active && setError(leaveErrorMessage(cause)));
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load]);

  async function run(key: string, action: () => Promise<unknown>, message: string) {
    if (busy) return false;
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
      await onChanged(message);
      return true;
    } catch (cause) {
      setError(leaveErrorMessage(cause, 'Unable to change this balance.'));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const unit = row.leaveType.displayUnit;
  return (
    <Panel
      title={`${row.employee.displayName ?? row.employee.employeeNumber} · ${row.leaveType.name} ledger`}
      actions={
        <button type="button" className={secondaryButton} onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="space-y-5">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {!ledger ? (
          <p role="status" className="text-sm text-slate-600">
            Loading ledger…
          </p>
        ) : (
          <>
            <BalanceFigures balance={ledger.balance} unit={unit} />
            <LedgerTable
              ledger={ledger}
              busy={busy}
              onReverse={(entryId) => setReversing(entryId)}
            />
            {reversing && (
              <form
                className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(
                    `reverse-${reversing}`,
                    () => leaveApi.reverse(reversing, reverseReason.trim()),
                    'Entry reversed.',
                  ).then((ok) => {
                    if (ok) {
                      setReversing(null);
                      setReverseReason('');
                    }
                  });
                }}
              >
                <label className="flex-1 text-sm font-medium text-slate-700">
                  Reason for reversal
                  <input
                    required
                    value={reverseReason}
                    onChange={(event) => setReverseReason(event.target.value)}
                    className={inputClass}
                  />
                </label>
                <button
                  type="submit"
                  disabled={!!busy || !reverseReason.trim()}
                  className={primaryButton}
                >
                  Reverse entry
                </button>
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => setReversing(null)}
                >
                  Cancel
                </button>
              </form>
            )}
            {ledger.actions.canAdjust && (
              <form
                className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 p-4 sm:grid-cols-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  const amountMinutes = hoursToMinutes(hours);
                  if (!amountMinutes) {
                    setError('Enter a non-zero number of hours (negative to deduct).');
                    return;
                  }
                  void run(
                    'adjust',
                    () =>
                      leaveApi.adjust({
                        employmentAssignmentId: row.employmentAssignmentId,
                        leaveTypeId: row.leaveType.id,
                        amountMinutes,
                        effectiveDate,
                        reason: reason.trim(),
                        idempotencyKey: clientKey,
                      }),
                    'Balance adjusted.',
                  ).then((ok) => {
                    if (ok) {
                      setHours('');
                      setReason('');
                      setClientKey(crypto.randomUUID());
                    }
                  });
                }}
              >
                <h3 className="text-sm font-semibold text-slate-900 sm:col-span-4">
                  Manual adjustment
                </h3>
                <label className="text-sm font-medium text-slate-700">
                  Hours (+/−)
                  <input
                    type="number"
                    step="0.25"
                    required
                    value={hours}
                    onChange={(event) => setHours(event.target.value)}
                    className={inputClass}
                  />
                </label>
                <label className="text-sm font-medium text-slate-700">
                  Effective date
                  <input
                    type="date"
                    required
                    value={effectiveDate}
                    onChange={(event) => setEffectiveDate(event.target.value)}
                    className={inputClass}
                  />
                </label>
                <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                  Reason
                  <input
                    required
                    maxLength={2000}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    className={inputClass}
                  />
                </label>
                <div className="sm:col-span-4">
                  <button
                    type="submit"
                    disabled={busy === 'adjust' || !reason.trim()}
                    className={primaryButton}
                  >
                    {busy === 'adjust' ? 'Saving…' : 'Post adjustment'}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}
