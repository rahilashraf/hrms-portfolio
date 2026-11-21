'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { leaveApi } from '../../lib/leave/api';
import { leaveErrorMessage } from '../../lib/leave/errors';
import { formatLeaveAmount, formatLeaveRange, label } from '../../lib/leave/format';
import type {
  LeaveOrganization,
  LeaveRequestStatus,
  LeaveType,
  QueuedLeaveRequest,
} from '../../lib/leave/types';
import { RecordLeaveDialog } from './leave-admin-sections';
import { employeeSource } from '../../lib/pickers/sources';
import { RecordCombobox } from '../ui/record-combobox';
import {
  EmptyState,
  inputClass,
  LeaveStatusPill,
  Panel,
  primaryButton,
  secondaryButton,
} from './leave-shared';
import { TableScroll } from '../ui/states';
import { RequestReview } from './leave-request-review';

// Batch 10B: the leave request queue (moved from leave-management-page.tsx unchanged).
// ─── Requests queue and review ────────────────────────────────────────────────

/** Batch 6B: `?employeeId=` (e.g. from an employee profile) preselects the employee filter. */
export function employeeFromLocation(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('employeeId') ?? '';
}

/** Batch 6B: the organization's leave types, for filters (archived included: old requests). */
export function useLeaveTypeOptions(organizationId: string) {
  const [types, setTypes] = useState<LeaveType[]>([]);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      leaveApi
        .types(organizationId, true)
        .then((result) => active && setTypes(result.items))
        .catch(() => active && setTypes([]));
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId]);
  return types;
}

/** Leave requests per page in the queue (the API allows 1–200). */
export const QUEUE_PAGE_SIZE = 50;

export function RequestsPanel({ organization }: { organization: LeaveOrganization }) {
  const [status, setStatus] = useState<LeaveRequestStatus | ''>('PENDING');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [employeeId, setEmployeeId] = useState(employeeFromLocation);
  const [employeeLabel, setEmployeeLabel] = useState<{ id: string; label: string } | null>(null);
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const types = useLeaveTypeOptions(organization.id);
  const employees = useMemo(
    () => employeeSource({ organizationId: organization.id }),
    [organization.id],
  );
  const [items, setItems] = useState<QueuedLeaveRequest[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const fetchPage = useCallback(
    (afterId?: string) =>
      leaveApi.queue({
        organizationId: organization.id,
        ...(status ? { status } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(employeeId ? { employeeId } : {}),
        ...(leaveTypeId ? { leaveTypeId } : {}),
        ...(afterId ? { afterId } : {}),
        limit: QUEUE_PAGE_SIZE,
      }),
    [organization.id, status, from, to, employeeId, leaveTypeId],
  );

  // Batch 6B: each (re)load starts a generation; a page answered for an older one (a filter
  // changed meanwhile) is dropped, so pages of different filters never mix.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const at = ++generation.current;
    setNext(null);
    const page = await fetchPage();
    if (generation.current !== at) return;
    setItems(page.items);
    setNext(page.nextAfterId);
  }, [fetchPage]);

  async function loadMore() {
    if (!next) return;
    const at = generation.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(next);
      if (generation.current !== at) return;
      setItems((current) => [...current, ...page.items]);
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
      {organization.actions.canApprove && (
        <div className="flex justify-end">
          <button type="button" className={primaryButton} onClick={() => setRecording(true)}>
            Record leave for an employee
          </button>
        </div>
      )}
      {recording && (
        <RecordLeaveDialog
          organization={organization}
          initialEmployeeId={employeeId || undefined}
          onClose={() => setRecording(false)}
          onRecorded={(message) => {
            setRecording(false);
            setSuccess(message);
            void load().catch((cause) => setError(leaveErrorMessage(cause)));
          }}
        />
      )}
      <form
        aria-label="Leave request filters"
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
            <option value="">All types</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
                {type.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as LeaveRequestStatus | '')}
            className={inputClass}
          >
            <option value="">All</option>
            {(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const).map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          From
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          To
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className={inputClass}
          />
        </label>
      </form>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
      <Panel title="Leave requests">
        {loading ? (
          <p role="status" className="text-sm text-slate-600">
            Loading requests…
          </p>
        ) : items.length === 0 ? (
          <EmptyState>No leave requests match.</EmptyState>
        ) : (
          <TableScroll bare label="Leave requests">
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
                    Dates
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Amount
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) => (
                  <tr key={item.id} className={selected === item.id ? 'bg-indigo-50' : ''}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">
                        {item.employee.displayName ?? item.employee.employeeNumber}
                      </div>
                      <div className="text-xs text-slate-500">{item.positionName}</div>
                    </td>
                    <td className="px-3 py-2">{item.leaveType.name}</td>
                    <td className="px-3 py-2">
                      {formatLeaveRange(
                        item.startDate,
                        item.endDate,
                        item.startLocalTime,
                        item.endLocalTime,
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {formatLeaveAmount(
                        item.activeMinutes ?? item.requestedMinutes,
                        item.leaveType.displayUnit,
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <LeaveStatusPill value={item.status} />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className={secondaryButton}
                        aria-label={`Review request from ${item.employee.displayName ?? item.employee.employeeNumber}`}
                        onClick={() => setSelected(item.id)}
                      >
                        Review
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
              {loadingMore ? 'Loading…' : 'Load more requests'}
            </button>
          </div>
        )}
      </Panel>
      {selected && (
        <RequestReview
          key={selected}
          requestId={selected}
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
