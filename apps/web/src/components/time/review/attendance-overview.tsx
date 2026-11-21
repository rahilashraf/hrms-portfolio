'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { timeApi } from '../../../lib/time/api';
import { timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatInstant, formatMinutes, label } from '../../../lib/time/format';
import type { TimeEntryRead, TimeException } from '../../../lib/time/types';
import { buttonClass } from '../../ui/button';
import { EmptyState, ErrorState, LoadingState, TableScroll } from '../../ui/states';
import { inputClass } from '../../ui/tokens';
import { RecordsTable } from '../employee-time-page';
import {
  DateField,
  LoadMore,
  ReviewPanel,
  todayIn,
  useDebounced,
  usePagedList,
  type ReviewOrganization,
  historyQuery,
} from './review-shared';

export type ReviewTab =
  'overview' | 'records' | 'exceptions' | 'corrections' | 'timesheets' | 'scheduled' | 'attendance';

interface Counts {
  clockedIn: number | null;
  exceptions: TimeException[] | null;
  exceptionsTruncated: boolean;
  pendingCorrections: number | null;
  correctionsTruncated: boolean;
  timesheetApprovals: number | null;
  timesheetsTruncated: boolean;
  /** Totals whose request failed: shown as unavailable, the others still show. */
  unavailable: Array<'current' | 'exceptions' | 'corrections' | 'timesheets'>;
}

const LATE_TYPES = new Set(['LATE_ARRIVAL', 'LATE_SIGN_IN']);

function Metric({
  title,
  value,
  truncated,
  onOpen,
  openLabel,
  unavailable = false,
}: {
  title: string;
  value: number | null;
  truncated?: boolean;
  onOpen?(): void;
  openLabel?: string;
  /** The total could not be loaded (the other totals still show). */
  unavailable?: boolean;
}) {
  const titleId = useId();
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p id={titleId} className="text-sm text-slate-600">
        {title}
      </p>
      {unavailable ? (
        <p className="mt-1 text-base font-medium text-rose-800">Unavailable</p>
      ) : (
        <p className="mt-1 text-3xl font-semibold text-slate-950">
          {value === null ? '—' : `${value}${truncated ? '+' : ''}`}
        </p>
      )}
      {onOpen && (
        // Named by its action only (the section names stay unique for the hub's own buttons);
        // the card's title describes it.
        <button
          type="button"
          onClick={onOpen}
          aria-describedby={titleId}
          className={`${buttonClass('ghost', 'sm')} -ml-3 mt-1`}
        >
          {openLabel ?? 'Open'}
        </button>
      )}
    </div>
  );
}

interface DayRow {
  key: string;
  employeeId: string;
  employeeName: string;
  workDate: string;
  entries: TimeEntryRead[];
  indicators: string[];
}

/**
 * Batch 4E-1 — the organization's attendance for a date range: who is clocked in, what was
 * recorded per employee and day (payable minutes from the same calculation as timesheets), and
 * the signals that need attention (missing clock-outs, late arrivals, no-shows). Every list comes
 * from the API filtered to the organization; counts read the first page and say so ("100+").
 */
export function AttendanceOverview({
  organization,
  onNavigate,
}: {
  organization: ReviewOrganization;
  onNavigate(tab: ReviewTab, attendanceTab?: string): void;
}) {
  const { actions } = organization;
  const today = todayIn(organization.timezone);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim());
  const [employee, setEmployee] = useState<{ id: string; name: string } | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [countsError, setCountsError] = useState<string | null>(null);
  const [countsAttempt, setCountsAttempt] = useState(0);
  const searchId = useId();

  const filters = useMemo(
    () => ({
      organizationId: organization.id,
      ...historyQuery(organization),
      ...(employee ? { employeeId: employee.id } : {}),
      ...(search ? { search } : {}),
    }),
    [organization, employee, search],
  );

  useEffect(() => {
    let active = true;
    const none = Promise.resolve({ items: [], nextAfterId: null });
    const timer = window.setTimeout(() => {
      setCountsError(null);
      // Each total stands alone: one failed request marks only that total unavailable.
      void Promise.allSettled([
        actions.canViewAttendance ? timeApi.managementCurrent({ ...filters, limit: 100 }) : none,
        actions.canViewAttendance
          ? timeApi.managementExceptions({ ...filters, startDate: from, endDate: to, limit: 100 })
          : none,
        actions.canReviewCorrections
          ? timeApi.managementCorrections({ ...filters, status: 'PENDING', limit: 100 })
          : none,
        actions.canApproveTimesheets
          ? timeApi.managementTimesheets({
              ...filters,
              status: 'SUBMITTED',
              segmentStatus: 'PENDING',
              limit: 100,
            })
          : none,
      ]).then(([currentResult, exceptionsResult, correctionsResult, timesheetsResult]) => {
        if (!active) return;
        const empty = { items: [] as unknown[], nextAfterId: null as string | null };
        const value = <T extends { items: unknown[]; nextAfterId: string | null }>(
          result: PromiseSettledResult<T>,
        ) => (result.status === 'fulfilled' ? result.value : empty);
        const current = value(currentResult);
        const exceptions = value(exceptionsResult);
        const corrections = value(correctionsResult);
        const timesheets = value(timesheetsResult);
        const unavailable = (
          [
            ['current', currentResult],
            ['exceptions', exceptionsResult],
            ['corrections', correctionsResult],
            ['timesheets', timesheetsResult],
          ] as const
        ).flatMap(([key, result]) => (result.status === 'rejected' ? [key] : []));
        const failure = [currentResult, exceptionsResult, correctionsResult, timesheetsResult].find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        setCounts({
          clockedIn:
            actions.canViewAttendance && currentResult.status === 'fulfilled'
              ? current.items.length
              : null,
          exceptions:
            actions.canViewAttendance && exceptionsResult.status === 'fulfilled'
              ? (exceptions.items as TimeException[])
              : null,
          exceptionsTruncated: exceptions.nextAfterId !== null,
          pendingCorrections:
            actions.canReviewCorrections && correctionsResult.status === 'fulfilled'
              ? corrections.items.length
              : null,
          correctionsTruncated: corrections.nextAfterId !== null,
          timesheetApprovals:
            actions.canApproveTimesheets && timesheetsResult.status === 'fulfilled'
              ? (timesheets.items as Array<{ segments: Array<{ status: string }> }>).reduce(
                  (total, sheet) =>
                    total + sheet.segments.filter((segment) => segment.status === 'PENDING').length,
                  0,
                )
              : null,
          timesheetsTruncated: timesheets.nextAfterId !== null,
          unavailable,
        });
        setCountsError(
          failure
            ? timeErrorMessage(
                failure.reason,
                unavailable.length === 4
                  ? 'Unable to load attendance totals.'
                  : 'Some attendance totals could not be loaded.',
              )
            : null,
        );
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [actions, filters, from, to, countsAttempt]);

  const missing = (key: Counts['unavailable'][number]) =>
    counts?.unavailable.includes(key) ?? false;

  const fetchEntries = useCallback(
    (afterId?: string) =>
      timeApi.managementEntries({
        ...filters,
        startDate: from,
        endDate: to,
        limit: 100,
        ...(afterId ? { afterId } : {}),
      }),
    [filters, from, to],
  );
  const entries = usePagedList(
    actions.canViewAttendance ? fetchEntries : null,
    'Unable to load attendance.',
  );
  const fetchCurrent = useCallback(
    (afterId?: string) =>
      timeApi.managementCurrent({ ...filters, limit: 50, ...(afterId ? { afterId } : {}) }),
    [filters],
  );
  const current = usePagedList(
    actions.canViewAttendance ? fetchCurrent : null,
    'Unable to load who is clocked in.',
  );

  const open = counts?.exceptions?.filter((item) => item.status === 'OPEN') ?? [];
  const ofType = (types: (type: string) => boolean) =>
    counts?.exceptions ? open.filter((item) => types(item.type)).length : null;

  const rows = useMemo<DayRow[]>(() => {
    const byKey = new Map<string, DayRow>();
    const row = (employeeId: string, employeeName: string, workDate: string) => {
      const key = `${employeeId}|${workDate}`;
      const existing = byKey.get(key) ?? {
        key,
        employeeId,
        employeeName,
        workDate,
        entries: [],
        indicators: [],
      };
      byKey.set(key, existing);
      return existing;
    };
    for (const entry of entries.items) {
      const day = row(entry.employeeId, entry.employeeName, entry.workDate);
      day.entries.push(entry);
      for (const exception of entry.exceptions) day.indicators.push(exception.type);
    }
    for (const exception of counts?.exceptions ?? []) {
      if (!exception.employeeId || !exception.workDate) continue;
      if (exception.workDate < from || exception.workDate > to) continue;
      const day = row(
        exception.employeeId,
        exception.employeeName ?? 'Employee',
        exception.workDate,
      );
      day.indicators.push(exception.type);
    }
    return [...byKey.values()].sort(
      (a, b) =>
        b.workDate.localeCompare(a.workDate) || a.employeeName.localeCompare(b.employeeName),
    );
  }, [entries.items, counts?.exceptions, from, to]);

  return (
    <div className="space-y-6">
      <ReviewPanel title="Attendance overview" description="Attendance for the dates you choose.">
        <div className="grid gap-3 sm:grid-cols-3">
          <DateField label="From" value={from} onChange={(value) => setFrom(value || today)} />
          <DateField label="To" value={to} onChange={(value) => setTo(value || today)} />
          <div>
            <label htmlFor={searchId} className="block text-sm font-medium text-slate-700">
              Employee or assignment
            </label>
            <input
              id={searchId}
              type="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              className={inputClass}
            />
          </div>
        </div>
        {employee && (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-800">
            Showing only <span className="font-semibold">{employee.name}</span>.
            <button
              type="button"
              onClick={() => setEmployee(null)}
              className={buttonClass('ghost', 'sm')}
            >
              Show everyone
            </button>
          </p>
        )}
        {countsError && (
          <div
            role="alert"
            className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900"
          >
            <span>{countsError}</span>
            <button
              type="button"
              onClick={() => setCountsAttempt((value) => value + 1)}
              className={buttonClass('secondary', 'sm')}
            >
              Retry totals
            </button>
          </div>
        )}
      </ReviewPanel>

      <section aria-label="Attendance totals" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {actions.canViewAttendance && (
          <>
            <Metric
              title="Currently clocked in"
              value={counts?.clockedIn ?? null}
              unavailable={missing('current')}
            />
            <Metric
              title="Missing clock-outs"
              value={ofType((type) => type === 'MISSING_CLOCK_OUT')}
              truncated={counts?.exceptionsTruncated}
              onOpen={() => onNavigate('exceptions')}
              openLabel="Review"
              unavailable={missing('exceptions')}
            />
            <Metric
              title="Late arrivals"
              value={ofType((type) => LATE_TYPES.has(type))}
              truncated={counts?.exceptionsTruncated}
              onOpen={() => onNavigate('exceptions')}
              openLabel="Review"
              unavailable={missing('exceptions')}
            />
            <Metric
              title="No-shows"
              value={ofType((type) => type === 'NO_SHOW')}
              truncated={counts?.exceptionsTruncated}
              onOpen={() => onNavigate('exceptions')}
              openLabel="Review"
              unavailable={missing('exceptions')}
            />
            <Metric
              title="Open exceptions"
              value={counts?.exceptions ? open.length : null}
              truncated={counts?.exceptionsTruncated}
              onOpen={() => onNavigate('exceptions')}
              openLabel="Review"
              unavailable={missing('exceptions')}
            />
          </>
        )}
        {actions.canReviewCorrections && (
          <Metric
            title="Pending corrections"
            value={counts?.pendingCorrections ?? null}
            truncated={counts?.correctionsTruncated}
            onOpen={() => onNavigate('corrections')}
            openLabel="Review"
            unavailable={missing('corrections')}
          />
        )}
        {actions.canApproveTimesheets && (
          <Metric
            title="Timesheet approvals"
            value={counts?.timesheetApprovals ?? null}
            truncated={counts?.timesheetsTruncated}
            onOpen={() => onNavigate('timesheets')}
            openLabel="Review"
            unavailable={missing('timesheets')}
          />
        )}
      </section>

      {actions.canViewAttendance ? (
        <>
          <ReviewPanel title="Currently clocked in">
            {current.loading ? (
              <LoadingState label="Loading who is clocked in…" />
            ) : current.error ? (
              <ErrorState message={current.error} onRetry={() => void current.reload()} />
            ) : (
              <RecordsTable entries={current.items} label="Currently clocked in" />
            )}
            <LoadMore list={current} noun={['person clocked in', 'people clocked in']} />
          </ReviewPanel>

          <ReviewPanel
            title="Attendance by employee and day"
            description={`${formatDateOnly(from)} to ${formatDateOnly(to)}. Payable minutes include breaks and the automatic deduction.`}
            actions={
              actions.canViewSignIns ? (
                <button
                  type="button"
                  onClick={() => onNavigate('attendance', 'sign-ins')}
                  className={buttonClass('secondary', 'sm')}
                >
                  Sign-ins
                </button>
              ) : undefined
            }
          >
            {entries.loading ? (
              <LoadingState label="Loading attendance…" />
            ) : entries.error ? (
              <ErrorState message={entries.error} onRetry={() => void entries.reload()} />
            ) : rows.length === 0 ? (
              <EmptyState title="No attendance recorded for these dates." />
            ) : (
              <TableScroll label="Attendance by employee and day" bare>
                <table className="w-full min-w-[820px] text-left text-sm">
                  <caption className="sr-only">Attendance by employee and day</caption>
                  <thead className="border-b border-slate-200 text-xs uppercase text-slate-600">
                    <tr>
                      <th scope="col" className="px-3 py-2">
                        Employee
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Work date
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Status
                      </th>
                      <th scope="col" className="px-3 py-2">
                        First in
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Last out
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Payable
                      </th>
                      <th scope="col" className="px-3 py-2">
                        Needs attention
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {rows.map((row) => {
                      const sorted = [...row.entries].sort((a, b) =>
                        a.clockInAt.localeCompare(b.clockInAt),
                      );
                      const first = sorted[0];
                      const last = sorted.at(-1);
                      const isOpen = row.entries.some((entry) => entry.status === 'OPEN');
                      const status = isOpen
                        ? 'Clocked in'
                        : row.entries.length > 0
                          ? 'Worked'
                          : row.indicators.includes('NO_SHOW')
                            ? 'No-show'
                            : 'No time recorded';
                      const indicators = [...new Set(row.indicators)];
                      return (
                        <tr key={row.key}>
                          <th
                            scope="row"
                            className="px-3 py-3 text-left font-medium text-slate-900"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setEmployee({ id: row.employeeId, name: row.employeeName })
                              }
                              className="text-left underline decoration-slate-300 underline-offset-2 hover:decoration-slate-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
                            >
                              {row.employeeName}{' '}
                              <span className="sr-only">(show only this employee)</span>
                            </button>
                          </th>
                          <td className="px-3 py-3">{formatDateOnly(row.workDate)}</td>
                          <td className="px-3 py-3">{status}</td>
                          <td className="px-3 py-3">
                            {first ? formatInstant(first.clockInAt, first.timezone) : '—'}
                          </td>
                          <td className="px-3 py-3">
                            {isOpen
                              ? '—'
                              : last?.clockOutAt
                                ? formatInstant(last.clockOutAt, last.timezone)
                                : '—'}
                          </td>
                          <td className="px-3 py-3 font-medium text-slate-900">
                            {row.entries.length === 0
                              ? '—'
                              : formatMinutes(
                                  row.entries.reduce(
                                    (sum, entry) => sum + (entry.payableMinutes ?? 0),
                                    0,
                                  ),
                                )}
                          </td>
                          <td className="px-3 py-3">
                            {indicators.length === 0 ? (
                              '—'
                            ) : (
                              <ul className="flex flex-wrap gap-1">
                                {indicators.map((type) => (
                                  <li
                                    key={type}
                                    className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900 ring-1 ring-inset ring-amber-300"
                                  >
                                    {label(type)}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            )}
            <LoadMore list={entries} noun={['entry', 'entries']} />
          </ReviewPanel>
        </>
      ) : (
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
          Attendance records are shown to people who can view attendance in this organization. Your
          review queues are in the tabs above.
        </p>
      )}
    </div>
  );
}
