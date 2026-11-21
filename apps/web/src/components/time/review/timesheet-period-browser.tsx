'use client';

import { useCallback, useId, useState, type FormEvent } from 'react';
import { timeApi } from '../../../lib/time/api';
import { timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatMinutes, label } from '../../../lib/time/format';
import type { TimePeriod, Timesheet } from '../../../lib/time/types';
import { buttonClass } from '../../ui/button';
import { DataTable } from '../../ui/data-table';
import { EmptyState, ErrorState, LoadingState } from '../../ui/states';
import { inputClass } from '../../ui/tokens';
import { useConfirm } from '../../ui/use-confirm';
import { segmentName } from '../timesheet-parts';
import {
  LoadMore,
  ReviewPanel,
  TimesheetStatusBadge,
  useDebounced,
  usePagedList,
  type ReviewOrganization,
  historyQuery,
} from './review-shared';
import { ReadOnlyBadge } from '../time-notices';
import { Feedback, periodLabel } from './timesheet-review-shared';

// Batch 10C: period generation, the period list and a period's timesheets (moved from
// timesheet-review.tsx unchanged).
// ─── Periods ─────────────────────────────────────────────────────────────────

function GeneratePeriods({
  organization,
  onDone,
}: {
  organization: ReviewOrganization;
  onDone(message: string): void;
}) {
  const [startDate, setStartDate] = useState('');
  const [cadence, setCadence] = useState<'WEEKLY' | 'BIWEEKLY' | 'MONTHLY'>('WEEKLY');
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { start: useId(), cadence: useId(), count: useId() };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await timeApi.generatePeriods({
        organizationId: organization.id,
        startDate,
        cadence,
        count,
      });
      onDone(
        `${result.periods.length} period${result.periods.length === 1 ? '' : 's'} ready, starting ${formatDateOnly(result.periods[0]?.startDate)}. Existing periods with the same dates are reused.`,
      );
    } catch (cause) {
      setError(timeErrorMessage(cause, 'Unable to create these periods.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      aria-label="Create time periods"
      onSubmit={(event) => void submit(event)}
      className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-4 sm:items-end"
    >
      <div>
        <label htmlFor={ids.start} className="block text-sm font-medium text-slate-700">
          First day
        </label>
        <input
          id={ids.start}
          type="date"
          required
          value={startDate}
          onChange={(event) => setStartDate(event.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={ids.cadence} className="block text-sm font-medium text-slate-700">
          Length
        </label>
        <select
          id={ids.cadence}
          value={cadence}
          onChange={(event) => setCadence(event.target.value as typeof cadence)}
          className={inputClass}
        >
          <option value="WEEKLY">Weekly</option>
          <option value="BIWEEKLY">Every two weeks</option>
          <option value="MONTHLY">Monthly</option>
        </select>
      </div>
      <div>
        <label htmlFor={ids.count} className="block text-sm font-medium text-slate-700">
          How many
        </label>
        <input
          id={ids.count}
          type="number"
          min={1}
          max={26}
          required
          value={count}
          onChange={(event) => setCount(Math.max(1, Math.min(26, Number(event.target.value) || 1)))}
          className={inputClass}
        />
      </div>
      <button type="submit" disabled={busy || !startDate} className={buttonClass('primary')}>
        {busy ? 'Creating…' : 'Create periods'}
      </button>
      {error && (
        <p role="alert" className="text-sm text-rose-800 sm:col-span-4">
          {error}
        </p>
      )}
    </form>
  );
}

export function PeriodBrowser({
  organization,
  selected,
  onSelect,
}: {
  organization: ReviewOrganization;
  selected: string | null;
  onSelect(period: TimePeriod): void;
}) {
  const canManagePeriods = Boolean(organization.actions.canManagePeriods);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const fetchPage = useCallback(
    (afterId?: string) =>
      timeApi.periods({
        organizationId: organization.id,
        ...historyQuery(organization),
        limit: 10,
        ...(afterId ? { afterId } : {}),
      }),
    [organization],
  );
  const list = usePagedList(fetchPage, 'Unable to load time periods.');

  async function materialize(period: TimePeriod) {
    const go = await confirm({
      title: 'Create timesheets for this period?',
      description:
        'Every employee who records time in this organization during the period gets a timesheet. Existing timesheets are kept, and approved or locked ones are never changed.',
      confirmLabel: 'Create timesheets',
      destructive: false,
    });
    if (!go) return;
    setBusy(period.id);
    setError(null);
    setSuccess(null);
    try {
      const result = await timeApi.materializeTimesheets(period.id);
      setSuccess(
        `${result.created} timesheet${result.created === 1 ? '' : 's'} created; ${result.existing} already existed${result.finalized ? `; ${result.finalized} approved or locked left unchanged` : ''}.`,
      );
      await list.reload();
    } catch (cause) {
      setError(timeErrorMessage(cause, 'Unable to create timesheets.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <ReviewPanel
      title="Time periods"
      description="Browse timesheets by period. Payroll-managed periods are created by payroll."
    >
      <div className="space-y-4">
        {canManagePeriods && (
          <GeneratePeriods
            organization={organization}
            onDone={(message) => {
              setSuccess(message);
              setError(null);
              void list.reload();
            }}
          />
        )}
        <Feedback error={error} success={success} />
        {list.loading ? (
          <LoadingState label="Loading periods…" />
        ) : list.error ? (
          <ErrorState
            title="Periods could not be loaded"
            message={list.error}
            onRetry={() => void list.reload()}
          />
        ) : list.items.length === 0 ? (
          <EmptyState
            title="No time periods yet."
            description={
              canManagePeriods
                ? 'Create the first period above.'
                : 'A manager of this organization’s timesheets creates them.'
            }
          />
        ) : (
          <DataTable
            bare
            label="Time periods"
            minWidth="min-w-[640px]"
            rows={list.items}
            rowKey={(period) => period.id}
            rowClassName={(period) => (selected === period.id ? 'bg-indigo-50/60' : undefined)}
            columns={[
              {
                key: 'dates',
                header: 'Dates',
                rowHeader: true,
                className: 'text-slate-900',
                cell: (period) => (
                  <>
                    {periodLabel(period)}
                    {period.payrollManaged && (
                      <span className="ml-2 text-xs font-normal text-slate-600">
                        (payroll-managed)
                      </span>
                    )}
                    {(period.attendanceEnabled === false ||
                      list.disabledOrganizationIds.has(period.organizationId)) && (
                      <span className="ml-2 inline-block">
                        <ReadOnlyBadge />
                      </span>
                    )}
                  </>
                ),
              },
              { key: 'cadence', header: 'Cadence', cell: (period) => label(period.cadence) },
              { key: 'status', header: 'Status', cell: (period) => label(period.status) },
              { key: 'timesheets', header: 'Timesheets', cell: (period) => period.timesheetCount },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                cell: (period) => (
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      aria-pressed={selected === period.id}
                      onClick={() => onSelect(period)}
                      className={buttonClass('secondary', 'sm')}
                    >
                      Open period <span className="sr-only">for {periodLabel(period)}</span>
                    </button>
                    {canManagePeriods && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void materialize(period)}
                        className={buttonClass('ghost', 'sm')}
                      >
                        Create timesheets <span className="sr-only">for {periodLabel(period)}</span>
                      </button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
        <LoadMore list={list} noun={['period', 'periods']} />
      </div>
      {confirmDialog}
    </ReviewPanel>
  );
}

export function PeriodTimesheets({
  organization,
  period,
  onOpen,
}: {
  organization: ReviewOrganization;
  period: TimePeriod;
  onOpen(sheet: Timesheet): void;
}) {
  const [status, setStatus] = useState('');
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim());
  const ids = { status: useId(), search: useId() };
  const fetchPage = useCallback(
    (afterId?: string) =>
      timeApi.managementTimesheets({
        organizationId: organization.id,
        ...historyQuery(organization),
        timePeriodId: period.id,
        ...(status ? { status } : {}),
        ...(search ? { search } : {}),
        limit: 25,
        ...(afterId ? { afterId } : {}),
      }),
    [organization, period.id, status, search],
  );
  const list = usePagedList(fetchPage, 'Unable to load timesheets.');
  return (
    <ReviewPanel title={`Timesheets for ${periodLabel(period)}`} headingLevel={3}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={ids.status} className="block text-sm font-medium text-slate-700">
            Status
          </label>
          <select
            id={ids.status}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className={inputClass}
          >
            <option value="">All statuses</option>
            <option value="OPEN">Draft</option>
            <option value="SUBMITTED">Submitted</option>
            <option value="CHANGES_REQUESTED">Changes requested</option>
            <option value="APPROVED">Approved</option>
            <option value="LOCKED">Locked</option>
          </select>
        </div>
        <div>
          <label htmlFor={ids.search} className="block text-sm font-medium text-slate-700">
            Employee
          </label>
          <input
            id={ids.search}
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            className={inputClass}
          />
        </div>
      </div>
      <div className="mt-4">
        {list.loading ? (
          <LoadingState label="Loading timesheets…" />
        ) : list.error ? (
          <ErrorState
            title="Timesheets could not be loaded"
            message={list.error}
            onRetry={() => void list.reload()}
          />
        ) : list.items.length === 0 ? (
          <EmptyState title="No timesheets match these filters." />
        ) : (
          <DataTable
            bare
            label={`Timesheets for ${periodLabel(period)}`}
            minWidth="min-w-[640px]"
            rows={list.items}
            rowKey={(sheet) => sheet.id}
            columns={[
              {
                key: 'employee',
                header: 'Employee',
                rowHeader: true,
                className: 'text-slate-900',
                cell: (sheet) => (
                  <>
                    {sheet.employee?.name ?? '—'}
                    <span className="block text-xs font-normal text-slate-600">
                      {sheet.segments.map(segmentName).join(', ')}
                    </span>
                  </>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (sheet) => <TimesheetStatusBadge status={sheet.status} />,
              },
              {
                key: 'net',
                header: 'Net',
                cell: (sheet) =>
                  formatMinutes(
                    sheet.segments.reduce((sum, segment) => sum + segment.netWorkedMinutes, 0),
                  ),
              },
              {
                key: 'approved',
                header: 'Approved',
                cell: (sheet) =>
                  formatMinutes(
                    sheet.segments.reduce((sum, segment) => sum + segment.approvedWorkedMinutes, 0),
                  ),
              },
              {
                key: 'open',
                header: <span className="sr-only">Open</span>,
                align: 'right',
                cell: (sheet) => (
                  <button
                    type="button"
                    onClick={() => onOpen(sheet)}
                    className={buttonClass('secondary', 'sm')}
                  >
                    Review <span className="sr-only">timesheet of {sheet.employee?.name}</span>
                  </button>
                ),
              },
            ]}
          />
        )}
        <LoadMore list={list} noun={['timesheet', 'timesheets']} />
      </div>
    </ReviewPanel>
  );
}
