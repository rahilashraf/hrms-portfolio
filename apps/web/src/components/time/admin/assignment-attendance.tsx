'use client';

import { useCallback, useId, useState } from 'react';
import { attendanceApi } from '../../../lib/attendance/api';
import { describeValue, fieldOf } from '../../../lib/attendance/policy-schema';
import { formatDateOnly, label } from '../../../lib/time/format';
import { buttonClass } from '../../ui/button';
import { DataTable } from '../../ui/data-table';
import { EmptyState, ErrorState, LoadingState } from '../../ui/states';
import { inputClass } from '../../ui/tokens';
import { LoadMore, useDebounced, usePagedList } from '../review/review-shared';

/**
 * Batch 4E-2 (B4) — how each employment assignment the administrator may see captures
 * attendance, across all of their organizations: an employee working for several organizations
 * appears once per readable assignment, each with its own tracking and capture modes and the
 * policies behind them. Assignments outside the administrator's permissions never appear.
 */
export function AssignmentAttendancePanel({
  onInspect,
}: {
  onInspect(assignmentId: string, date: string): void;
}) {
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim());
  const [date, setDate] = useState('');
  const ids = { search: useId(), date: useId() };
  const fetchPage = useCallback(
    (afterId?: string) =>
      attendanceApi.assignmentAttendance({
        ...(search ? { search } : {}),
        ...(date ? { date } : {}),
        limit: 25,
        ...(afterId ? { afterId } : {}),
      }),
    [search, date],
  );
  const list = usePagedList(search ? fetchPage : null, 'Unable to load assignments.');

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <h2 className="text-base font-semibold text-slate-950">Assignment attendance</h2>
      <p className="text-sm text-slate-600">
        Find an employee to see how each of their assignments records attendance, in every
        organization you can see. One person may be timed in one organization and presence-only in
        another.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label htmlFor={ids.search} className="block text-sm font-medium text-slate-700">
            Employee name, number or position
          </label>
          <input
            id={ids.search}
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={ids.date} className="block text-sm font-medium text-slate-700">
            On
          </label>
          <input
            id={ids.date}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            aria-describedby={`${ids.date}-hint`}
            className={inputClass}
          />
          <p id={`${ids.date}-hint`} className="mt-1 text-xs text-slate-600">
            Blank is today in each assignment&apos;s time zone.
          </p>
        </div>
      </div>
      {!search ? (
        <EmptyState title="Search for an employee to see their assignments." />
      ) : list.loading ? (
        <LoadingState label="Loading assignments…" />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={() => void list.reload()} />
      ) : list.items.length === 0 ? (
        <EmptyState title="No assignments you can see match this search." />
      ) : (
        <DataTable
          bare
          label="Assignment attendance"
          caption="How each assignment records attendance"
          minWidth="min-w-[880px]"
          rows={list.items}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'employee',
              header: 'Employee',
              rowHeader: true,
              className: 'text-slate-900',
              cell: (row) => (
                <>
                  {row.employee.name}
                  <span className="block text-xs font-normal text-slate-600">
                    {row.employee.employeeNumber}
                  </span>
                </>
              ),
            },
            {
              key: 'organization',
              header: 'Organization and position',
              cell: (row) => (
                <>
                  {row.assignment.organization.name}
                  <span className="block text-xs text-slate-600">
                    {row.assignment.position.name} · {label(row.assignment.status)}
                    {row.assignment.isPrimary ? ' · primary' : ''}
                  </span>
                </>
              ),
            },
            {
              key: 'tracking',
              header: 'Tracking',
              cell: (row) => (
                <>
                  {row.attendance.trackingMode === 'SIGN_IN_ONLY'
                    ? 'Presence only (not payable)'
                    : 'Timed attendance'}
                  {row.attendance.trackingMode === 'SIGN_IN_ONLY' && (
                    <span className="block text-xs text-slate-600">
                      Sign-out {row.attendance.signOutEnabled ? 'allowed' : 'not used'}
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 'capture',
              header: 'Capture',
              cell: (row) =>
                describeValue(fieldOf('attendance', 'captureMode'), row.attendance.captureMode),
            },
            {
              key: 'clock',
              header: 'Clock and breaks',
              cell: (row) => (
                <>
                  Clock {row.clock.mode === 'LIVE_CLOCK' ? 'on' : 'off'}
                  <span className="block text-xs text-slate-600">
                    {describeValue(fieldOf('breaks', 'mode'), row.breaks.mode)}
                    {row.breaks.mode === 'AUTO_DEDUCT' && row.breaks.autoDeductMinutes !== null
                      ? ` · ${row.breaks.autoDeductMinutes} min after ${row.breaks.autoDeductAfterMinutes ?? 0} min`
                      : ''}
                  </span>
                </>
              ),
            },
            {
              key: 'policies',
              header: 'Policies',
              className: 'text-xs text-slate-700',
              cell: (row) => (
                <>
                  {row.chain.length === 0
                    ? 'Defaults only'
                    : row.chain.map((layer) => layer.scopeName).join(' → ')}
                  <span className="block text-slate-500">on {formatDateOnly(row.date)}</span>
                </>
              ),
            },
            {
              key: 'inspect',
              header: <span className="sr-only">Inspect</span>,
              align: 'right',
              cell: (row) => (
                <button
                  type="button"
                  onClick={() => onInspect(row.id, row.date)}
                  className={buttonClass('secondary', 'sm')}
                >
                  Inspect{' '}
                  <span className="sr-only">
                    the effective policy of {row.employee.name}, {row.assignment.position.name}
                  </span>
                </button>
              ),
            },
          ]}
        />
      )}
      <LoadMore list={list} noun={['assignment', 'assignments']} />
    </section>
  );
}
