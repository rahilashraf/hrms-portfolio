'use client';

import { Fragment, useCallback, useId, useState } from 'react';
import { timeApi } from '../../../lib/time/api';
import { timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatInstant, formatMinutes, label } from '../../../lib/time/format';
import type { TimeException } from '../../../lib/time/types';
import { schedulingApi } from '../../../lib/scheduling/api';
import type { ShiftRevision } from '../../../lib/scheduling/types';
import { buttonClass } from '../../ui/button';
import { EmptyState, ErrorState, LoadingState, TableScroll } from '../../ui/states';
import { inputClass } from '../../ui/tokens';
import { useConfirmWithReason } from '../../ui/use-confirm';
import {
  actorLabel,
  DateField,
  LoadMore,
  resolutionLabel,
  ReviewPanel,
  useDebounced,
  usePagedList,
  type ReviewOrganization,
  historyQuery,
} from './review-shared';

export const EXCEPTION_TYPES = [
  'MISSING_CLOCK_OUT',
  'AUTO_CLOSED_CLOCK_OUT',
  'OPEN_BREAK_AUTO_CLOSED',
  'LONG_SHIFT',
  'LATE_ARRIVAL',
  'EARLY_DEPARTURE',
  'UNSCHEDULED_WORK',
  'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
  'NO_SHOW',
  'LATE_SIGN_IN',
  'UNSCHEDULED_SIGN_IN',
  'RECORDED_AFTER_APPROVAL',
] as const;

const STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED', 'SUPERSEDED'] as const;

const text = (value: unknown) => (typeof value === 'string' ? value : null);
const number = (value: unknown) => (typeof value === 'number' ? value : null);

/**
 * R4-A.5: a published shift changed after attendance was recorded against it. Shows the shift as
 * attendance was interpreted (the original) and as it is now (or that it was cancelled), in the
 * attendance's time zone. Display only: the punches are never changed here. Missing history is
 * said plainly rather than guessed.
 */
export function ShiftChangeFacts({ exception }: { exception: TimeException }) {
  const metadata =
    exception.metadata && typeof exception.metadata === 'object'
      ? (exception.metadata as Record<string, unknown>)
      : {};
  const zone = exception.timezone ?? null;
  const [revisions, setRevisions] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'done'; items: ShiftRevision[] }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const span = (startsAt: unknown, endsAt: unknown) => {
    const start = text(startsAt);
    const end = text(endsAt);
    return start && end
      ? `${formatInstant(start, zone)} – ${formatInstant(end, zone)}`
      : 'Not recorded';
  };
  const cancelled =
    text(metadata.change) === 'CANCELLED' || text(metadata.currentStatus) === 'CANCELLED';
  const interpretedNumber = number(metadata.interpretedRevisionNumber);
  const currentNumber = number(metadata.currentRevisionNumber);
  const shiftId = text(metadata.scheduledShiftId);
  const scheduleId = exception.changedShiftScheduleId ?? null;

  async function loadRevisions() {
    if (!scheduleId || !shiftId) return;
    setRevisions({ status: 'loading' });
    try {
      const result = await schedulingApi.revisions(scheduleId, shiftId);
      setRevisions({ status: 'done', items: result.items });
    } catch (cause) {
      setRevisions({
        status: 'error',
        message: timeErrorMessage(cause, 'The shift’s revision history could not be loaded.'),
      });
    }
  }

  return (
    <section
      aria-label="Shift change"
      className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3"
    >
      <p className="text-sm font-semibold text-amber-950">
        {cancelled
          ? 'The shift was cancelled after attendance was recorded'
          : 'The shift was changed after attendance was recorded'}
      </p>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-700">
            Original shift{interpretedNumber !== null ? ` (revision ${interpretedNumber})` : ''}
          </dt>
          <dd className="font-medium text-slate-900">
            {span(metadata.interpretedStartsAt, metadata.interpretedEndsAt)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-700">
            {cancelled ? 'Now' : 'Current shift'}
            {currentNumber !== null ? ` (revision ${currentNumber})` : ''}
          </dt>
          <dd className="font-medium text-slate-900">
            {cancelled ? 'Cancelled' : span(metadata.currentStartsAt, metadata.currentEndsAt)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-700">Work date</dt>
          <dd className="font-medium text-slate-900">
            {exception.workDate ? formatDateOnly(exception.workDate) : 'Not recorded'}
            {zone ? ` · ${zone}` : ''}
          </dd>
        </div>
      </dl>
      <p className="text-xs text-slate-700">
        The recorded punches are unchanged. Re-link the entry to the current shift, or resolve the
        exception, once you have reviewed it.
      </p>
      {scheduleId && shiftId && revisions.status === 'idle' && (
        <button
          type="button"
          className={buttonClass('ghost', 'sm')}
          onClick={() => void loadRevisions()}
        >
          Show all revisions
        </button>
      )}
      <div aria-live="polite">
        {revisions.status === 'loading' && (
          <p className="text-sm text-slate-700">Loading revisions…</p>
        )}
        {revisions.status === 'error' && (
          <p className="text-sm text-rose-800">{revisions.message}</p>
        )}
        {revisions.status === 'done' && (
          <ol aria-label="Shift revisions" className="space-y-1 text-sm text-slate-800">
            {revisions.items.map((revision) => (
              <li key={revision.id}>
                Revision {revision.revisionNumber} · {label(revision.revisionType)}:{' '}
                {revision.status === 'CANCELLED'
                  ? 'cancelled'
                  : `${formatInstant(revision.startsAt, revision.timezone)} – ${formatInstant(revision.endsAt, revision.timezone)}`}
                {revision.reason ? ` — ${revision.reason}` : ''}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

/** The facts an exception records (expected and actual times, variance) in plain words. */
function ExceptionFacts({ exception }: { exception: TimeException }) {
  const metadata =
    exception.metadata && typeof exception.metadata === 'object'
      ? (exception.metadata as Record<string, unknown>)
      : {};
  const zone = exception.timezone ?? null;
  const rows: Array<[string, string]> = [];
  const instant = (key: string, title: string) => {
    if (typeof metadata[key] === 'string') rows.push([title, formatInstant(metadata[key], zone)]);
  };
  instant('expectedAt', 'Expected');
  instant('actualAt', 'Actual');
  instant('clockInAt', 'Clocked in');
  instant('startsAt', 'Shift starts');
  instant('endsAt', 'Shift ends');
  if (typeof metadata.varianceMinutes === 'number') {
    rows.push(['Difference', formatMinutes(metadata.varianceMinutes)]);
  }
  if (typeof metadata.expectedSourceType === 'string') {
    rows.push(['Expected from', label(metadata.expectedSourceType)]);
  }
  rows.push(['Effect on submission', label(exception.workflowImpact)]);
  if (exception.reason) rows.push(['Reason', exception.reason]);
  return (
    <>
      {exception.type === 'SCHEDULE_CHANGED_AFTER_ATTENDANCE' && (
        <ShiftChangeFacts exception={exception} />
      )}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt className="text-slate-600">{term}</dt>
            <dd className="font-medium text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function Resolution({
  exception,
  currentUserId,
}: {
  exception: TimeException;
  currentUserId: string | null;
}) {
  const how = resolutionLabel(exception.status, exception.resolutionMethod);
  if (!how) return null;
  return (
    <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
      <p className="font-semibold">{how}</p>
      {exception.resolutionMethod === 'MANAGER_RESOLUTION' ||
      exception.resolutionMethod === 'ADMIN_RESOLUTION' ? (
        <p className="mt-1">
          By {actorLabel(exception.actors, exception.resolvedByUserId, currentUserId)}
          {exception.resolvedAt
            ? ` on ${formatInstant(exception.resolvedAt, exception.timezone)}`
            : ''}
        </p>
      ) : (
        exception.resolvedAt && (
          <p className="mt-1">{formatInstant(exception.resolvedAt, exception.timezone)}</p>
        )
      )}
      {exception.resolutionNote && <p className="mt-1">Note: {exception.resolutionNote}</p>}
    </div>
  );
}

/**
 * Batch 4E-1 — the exception review queue. Resolve ("it was addressed") and dismiss ("no action
 * needed") need a note; neither changes punches, hours or timesheets. Closed exceptions keep
 * their history: the system's automatic closures read differently from manager decisions.
 */
export function ExceptionReview({
  organization,
  currentUserId,
  onOpenTimesheet,
  onChanged,
}: {
  organization: ReviewOrganization;
  currentUserId: string | null;
  onOpenTimesheet?(employeeId: string, workDate: string): void;
  onChanged?(message: string): void;
}) {
  const canReview = Boolean(organization.actions.canReviewExceptions);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, dialog] = useConfirmWithReason();
  const statusId = useId();
  const typeId = useId();
  const searchId = useId();

  const fetchPage = useCallback(
    (afterId?: string) =>
      timeApi.managementExceptions({
        organizationId: organization.id,
        ...historyQuery(organization),
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
        ...(search ? { search } : {}),
        limit: 25,
        ...(afterId ? { afterId } : {}),
      }),
    [organization, status, type, startDate, endDate, search],
  );
  const list = usePagedList(fetchPage, 'Unable to load attendance exceptions.');

  async function review(exception: TimeException, decision: 'resolve' | 'dismiss') {
    const note = await confirm({
      title: decision === 'resolve' ? 'Resolve this exception?' : 'Dismiss this exception?',
      description:
        decision === 'resolve'
          ? 'Mark it as addressed. Punches, hours and timesheets are not changed.'
          : 'Mark it as needing no action. Punches, hours and timesheets are not changed.',
      confirmLabel: decision === 'resolve' ? 'Resolve exception' : 'Dismiss exception',
      destructive: false,
      reason: { label: 'Note', required: true, maxLength: 1000 },
    });
    if (note === null) return;
    setBusy(exception.id);
    setActionError(null);
    try {
      if (decision === 'resolve') await timeApi.resolveException(exception.id, note);
      else await timeApi.dismissException(exception.id, note);
      await list.reload();
      onChanged?.(decision === 'resolve' ? 'Exception resolved.' : 'Exception dismissed.');
    } catch (cause) {
      setActionError(timeErrorMessage(cause, 'Unable to review this exception.'));
      await list.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <ReviewPanel
      title="Exception reporting"
      description="Attendance exceptions in this organization. Open one to see what happened and how it was closed."
    >
      {/* A short fixed list: a visible radio group rather than a dropdown. */}
      <fieldset className="mb-3">
        <legend className="text-sm font-medium text-slate-700">Status</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {[
            ['', 'All statuses'] as const,
            ...STATUSES.map((value) => [value, label(value)] as const),
          ].map(([value, text]) => (
            <label
              key={value || 'all'}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm font-medium focus-within:outline-hidden focus-within:ring-2 focus-within:ring-[var(--hrms-accent-text)] ${
                status === value
                  ? 'border-indigo-700 bg-indigo-50 text-indigo-900'
                  : 'border-slate-300 bg-white text-slate-700'
              }`}
            >
              <input
                type="radio"
                name={statusId}
                value={value}
                checked={status === value}
                onChange={() => setStatus(value)}
                className="sr-only"
              />
              {text}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor={typeId} className="block text-sm font-medium text-slate-700">
            Type
          </label>
          <select
            id={typeId}
            value={type}
            onChange={(event) => setType(event.target.value)}
            className={inputClass}
          >
            <option value="">All types</option>
            {EXCEPTION_TYPES.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </div>
        <DateField label="Detected from" value={startDate} onChange={setStartDate} />
        <DateField label="Detected to" value={endDate} onChange={setEndDate} />
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
      {actionError && (
        <p role="alert" className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {actionError}
        </p>
      )}
      <div className="mt-4">
        {list.loading ? (
          <LoadingState label="Loading exceptions…" />
        ) : list.error ? (
          <ErrorState
            title="Exceptions could not be loaded"
            message={list.error}
            onRetry={() => void list.reload()}
          />
        ) : list.items.length === 0 ? (
          <EmptyState title="No exceptions match these filters." />
        ) : (
          <TableScroll label="Attendance exceptions" bare>
            <table className="w-full min-w-[760px] text-left text-sm">
              <caption className="sr-only">Attendance exceptions</caption>
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-600">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Employee
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Work date
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Type
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Severity
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {list.items.map((exception) => {
                  const open = expanded === exception.id;
                  const detailId = `exception-detail-${exception.id}`;
                  return (
                    <Fragment key={exception.id}>
                      <tr>
                        <td className="px-3 py-3 font-medium text-slate-900">
                          {exception.employeeName ?? '—'}
                          <span className="block text-xs font-normal text-slate-600">
                            {exception.assignment?.position.name}
                          </span>
                        </td>
                        <td className="px-3 py-3">{formatDateOnly(exception.workDate)}</td>
                        <td className="px-3 py-3">{label(exception.type)}</td>
                        <td className="px-3 py-3">{label(exception.severity)}</td>
                        <td className="px-3 py-3">
                          {label(exception.status)}
                          {exception.status !== 'OPEN' && (
                            <span className="block text-xs text-slate-600">
                              {resolutionLabel(exception.status, exception.resolutionMethod)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-controls={detailId}
                            onClick={() => setExpanded(open ? null : exception.id)}
                            className={buttonClass('secondary', 'sm')}
                          >
                            {open ? 'Hide details' : 'Details'}{' '}
                            <span className="sr-only">
                              for {label(exception.type)}, {exception.employeeName}
                            </span>
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr id={detailId}>
                          <td colSpan={6} className="bg-slate-50/60 px-3 py-4">
                            <div className="space-y-3">
                              <ExceptionFacts exception={exception} />
                              <Resolution exception={exception} currentUserId={currentUserId} />
                              <div className="flex flex-wrap gap-2">
                                {canReview && exception.status === 'OPEN' && (
                                  <>
                                    <button
                                      type="button"
                                      disabled={busy === exception.id}
                                      onClick={() => void review(exception, 'resolve')}
                                      className={buttonClass('primary', 'sm')}
                                    >
                                      Resolve
                                    </button>
                                    <button
                                      type="button"
                                      disabled={busy === exception.id}
                                      onClick={() => void review(exception, 'dismiss')}
                                      className={buttonClass('secondary', 'sm')}
                                    >
                                      Dismiss
                                    </button>
                                  </>
                                )}
                                {onOpenTimesheet && exception.employeeId && exception.workDate && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onOpenTimesheet(exception.employeeId!, exception.workDate!)
                                    }
                                    className={buttonClass('ghost', 'sm')}
                                  >
                                    Open timesheet
                                  </button>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
        <LoadMore list={list} noun={['exception', 'exceptions']} />
      </div>
      {dialog}
    </ReviewPanel>
  );
}
