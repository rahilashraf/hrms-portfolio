'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { timeApi } from '../../../lib/time/api';
import { timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatMinutes } from '../../../lib/time/format';
import type { ScheduledVsActualRow } from '../../../lib/time/types';
import { buttonClass } from '../../ui/button';
import { DataTable } from '../../ui/data-table';
import { EmptyState, ErrorState, LoadingState } from '../../ui/states';
import { DateField, ReviewPanel, todayIn, type ReviewOrganization } from './review-shared';

/**
 * Batch 4F (Q8) — scheduled vs actual, compact and read only: per work date and assignment, the
 * published shifts' minutes against the actual minutes of closed entries, from the API
 * (GET /time/manage/scheduled-vs-actual). Actual minutes use the timesheets' calculation; open
 * entries are counted, never estimated. Nothing is calculated here beyond formatting.
 */

export const MAX_RANGE_DAYS = 31;
const PAGE_SIZE = 100;

/** YYYY-MM-DD shifted by whole days (calendar arithmetic, no time zone). */
function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Monday and Sunday of the week of a date. */
export function weekOf(isoDate: string): { from: string; to: string } {
  const day = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
  const from = addDays(isoDate, -((day + 6) % 7));
  return { from, to: addDays(from, 6) };
}

/** Why a range cannot be requested, or null. */
export function rangeProblem(from: string, to: string): string | null {
  if (!from || !to) return 'Choose a start and an end date.';
  if (to < from) return 'The end date must be on or after the start date.';
  const days =
    (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
      86_400_000 +
    1;
  if (days > MAX_RANGE_DAYS) {
    return `Choose at most ${MAX_RANGE_DAYS} days (this range has ${days}).`;
  }
  return null;
}

/** A signed difference: "+1h 30m", "-45m", "0m". */
function signed(minutes: number): string {
  return minutes > 0 ? `+${formatMinutes(minutes)}` : formatMinutes(minutes);
}

export function ScheduledVsActual({ organization }: { organization: ReviewOrganization }) {
  const initial = weekOf(todayIn(organization.timezone));
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [rows, setRows] = useState<ScheduledVsActualRow[]>([]);
  const [nextAfterKey, setNextAfterKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const problem = rangeProblem(from, to);

  const load = useCallback(async () => {
    const current = ++generation.current;
    if (problem) {
      setRows([]);
      setNextAfterKey(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await timeApi.scheduledVsActual({
        organizationId: organization.id,
        from,
        to,
        limit: PAGE_SIZE,
      });
      if (current !== generation.current) return;
      setRows(result.rows);
      setNextAfterKey(result.nextAfterKey);
    } catch (cause) {
      if (current !== generation.current) return;
      setRows([]);
      setNextAfterKey(null);
      setError(timeErrorMessage(cause, 'Unable to load scheduled vs actual time.'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [organization.id, from, to, problem]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function loadMore() {
    if (!nextAfterKey || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const result = await timeApi.scheduledVsActual({
        organizationId: organization.id,
        from,
        to,
        limit: PAGE_SIZE,
        afterKey: nextAfterKey,
      });
      if (current !== generation.current) return;
      setRows((existing) => [...existing, ...result.rows]);
      setNextAfterKey(result.nextAfterKey);
    } catch (cause) {
      if (current === generation.current) {
        setError(timeErrorMessage(cause, 'Unable to load more rows.'));
      }
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  }

  return (
    <ReviewPanel
      title="Scheduled vs actual"
      description="Published shifts against recorded time, per work date and assignment. Actual minutes use the same calculation as timesheets; open entries are counted but not estimated."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <DateField label="From" value={from} onChange={setFrom} required />
        <DateField label="To" value={to} onChange={setTo} required />
        <div className="flex items-end">
          <button
            type="button"
            className={buttonClass('ghost', 'sm')}
            onClick={() => {
              setFrom(initial.from);
              setTo(initial.to);
            }}
          >
            This week
          </button>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-600">At most {MAX_RANGE_DAYS} days at a time.</p>
      <div className="mt-4">
        {problem ? (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
            {problem}
          </p>
        ) : loading ? (
          <LoadingState label="Loading scheduled vs actual time…" />
        ) : error && rows.length === 0 ? (
          <ErrorState
            title="Scheduled vs actual could not be loaded"
            message={error}
            onRetry={() => void load()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing scheduled or recorded in these dates"
            description="Only assignments whose time and schedules you can read are shown."
          />
        ) : (
          <>
            {error && (
              <p
                role="alert"
                className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900"
              >
                {error}
              </p>
            )}
            <DataTable
              bare
              label="Scheduled vs actual"
              caption="Scheduled vs actual time per work date and assignment"
              minWidth="min-w-[760px]"
              rows={rows}
              rowKey={(row) => `${row.workDate}|${row.employmentAssignmentId}`}
              columns={[
                {
                  key: 'workDate',
                  header: 'Work date',
                  rowHeader: true,
                  className: 'text-slate-900',
                  cell: (row) => formatDateOnly(row.workDate),
                },
                {
                  key: 'employee',
                  header: 'Employee',
                  cell: (row) => (
                    <>
                      {row.employeeName ?? row.employeeNumber ?? 'Unknown employee'}
                      {row.employeeName && row.employeeNumber && (
                        <span className="block text-xs text-slate-600">{row.employeeNumber}</span>
                      )}
                    </>
                  ),
                },
                { key: 'position', header: 'Position', cell: (row) => row.positionName ?? '—' },
                {
                  key: 'scheduled',
                  header: 'Scheduled',
                  cell: (row) => (
                    <>
                      {formatMinutes(row.scheduledMinutes)}
                      <span className="block text-xs text-slate-600">
                        {row.scheduledShiftCount === 1
                          ? '1 shift'
                          : `${row.scheduledShiftCount} shifts`}
                      </span>
                    </>
                  ),
                },
                {
                  key: 'actual',
                  header: 'Actual',
                  cell: (row) => (
                    <>
                      {formatMinutes(row.actualMinutes)}
                      {row.unscheduledActualMinutes > 0 && (
                        <span className="block text-xs text-slate-600">
                          {formatMinutes(row.unscheduledActualMinutes)} unscheduled
                        </span>
                      )}
                    </>
                  ),
                },
                {
                  key: 'variance',
                  header: 'Variance',
                  className: 'font-medium text-slate-900',
                  cell: (row) => signed(row.varianceMinutes),
                },
                {
                  key: 'open',
                  header: 'Open entries',
                  cell: (row) =>
                    row.openEntryCount === 0 ? (
                      '—'
                    ) : (
                      <>
                        {row.openEntryCount}
                        <span className="block text-xs text-amber-900">not included</span>
                      </>
                    ),
                },
              ]}
            />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="text-sm text-slate-600" aria-live="polite">
                Showing {rows.length} {rows.length === 1 ? 'row' : 'rows'}
                {nextAfterKey ? '; more are available.' : '.'}
              </p>
              {nextAfterKey && (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className={buttonClass('secondary', 'sm')}
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </ReviewPanel>
  );
}
