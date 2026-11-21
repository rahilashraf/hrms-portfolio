'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { compensationApi } from '../../lib/compensation/api';
import { compensationErrorMessage } from '../../lib/compensation/errors';
import {
  formatDateOnly,
  formatRecordRate,
  formatPeriod,
  label,
  payBasisLabel,
  salaryArrangementLabel,
} from '../../lib/compensation/format';
import type {
  CompensationAssignmentView,
  CompensationRecord,
  CompensationTimelineRecord,
} from '../../lib/compensation/types';
import { badgeClass, inputClass, primaryButton, secondaryButton } from '../ui/tokens';
import { EmptyState } from '../ui/states';
import { DataTable } from '../ui/data-table';

// Batch 3A: the shared tokens, re-exported so existing imports keep working.
export { inputClass, primaryButton, secondaryButton };

// Batch 3A: the shared EmptyState (its text-only form renders exactly as this module's did).
export { EmptyState };

export function assignmentTitle(view: CompensationAssignmentView): string {
  const { assignment } = view;
  return `${assignment.position.name} · ${assignment.organization.name}`;
}

/** The record in effect today (in the assignment's timezone) or why there is none. */
export function CurrentCompensation({ view }: { view: CompensationAssignmentView }) {
  if (!view.asOf) {
    return (
      <p className="text-sm text-slate-600">
        Today’s compensation cannot be shown because this assignment has no timezone. See the
        history below.
      </p>
    );
  }
  if (!view.current) {
    return (
      <p className="text-sm text-slate-600">
        No compensation is in effect on {formatDateOnly(view.asOf)}.
      </p>
    );
  }
  return <RecordDetails record={view.current} />;
}

/** Rate, pay basis, effective period and pay group of one record. */
function RecordDetails({ record }: { record: CompensationRecord }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div>
        <dt className="text-xs uppercase text-slate-500">Rate</dt>
        <dd className="text-lg font-semibold text-slate-950">{formatRecordRate(record)}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase text-slate-500">Pay basis</dt>
        <dd className="text-sm text-slate-800">
          {payBasisLabel(record.payBasis)}
          {record.payBasis === 'SALARY' && (
            <span className="text-slate-500">
              {' '}
              ({salaryArrangementLabel(record.salaryArrangement).toLowerCase()})
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-xs uppercase text-slate-500">Effective</dt>
        <dd className="text-sm text-slate-800">
          {formatPeriod(record.effectiveFrom, record.effectiveTo)}
        </dd>
      </div>
      <div>
        <dt className="text-xs uppercase text-slate-500">Pay group</dt>
        <dd className="text-sm text-slate-800">{record.payGroup?.name ?? '—'}</dd>
      </div>
    </dl>
  );
}

/**
 * The effective-dated history (oldest first). Gaps are shown as they are: missing data is never
 * filled in. Records replaced by corrections are listed separately and never editable.
 */
export function CompensationHistory({
  view,
  busy,
  onCorrect,
  onEnd,
}: {
  view: CompensationAssignmentView;
  busy?: boolean;
  onCorrect?: (record: CompensationTimelineRecord) => void;
  onEnd?: (record: CompensationTimelineRecord) => void;
}) {
  const showActions =
    (onCorrect || onEnd) && view.timeline.some((r) => r.actions.canCorrect || r.actions.canEnd);
  return (
    <div className="space-y-3">
      {view.timeline.length === 0 ? (
        <EmptyState>No compensation recorded for this assignment.</EmptyState>
      ) : (
        // Batch 10B: the shared DataTable (a named, keyboard-scrollable region; the period
        // names each row; the record in effect is highlighted and labelled "Current").
        <DataTable
          bare
          label={`Compensation history for ${assignmentTitle(view)}`}
          minWidth="min-w-[640px]"
          rows={view.timeline}
          rowKey={(record) => record.id}
          rowClassName={(record) => (view.current?.id === record.id ? 'bg-sky-50' : undefined)}
          columns={[
            {
              key: 'period',
              header: 'Period',
              rowHeader: true,
              cell: (record) => (
                <>
                  {formatPeriod(record.effectiveFrom, record.effectiveTo)}
                  {view.current?.id === record.id && (
                    <span className={`ml-2 ${badgeClass('info')}`}>Current</span>
                  )}
                </>
              ),
            },
            { key: 'rate', header: 'Rate', cell: (record) => formatRecordRate(record) },
            {
              key: 'payGroup',
              header: 'Pay group',
              cell: (record) => record.payGroup?.name ?? '—',
            },
            { key: 'type', header: 'Type', cell: (record) => label(record.recordType) },
            {
              key: 'reason',
              header: 'Reason',
              className: 'text-slate-600',
              cell: (record) => record.reason ?? '—',
            },
            ...(showActions
              ? [
                  {
                    key: 'actions',
                    header: 'Actions',
                    cell: (record: CompensationTimelineRecord) => (
                      <div className="flex gap-2">
                        {onCorrect && record.actions.canCorrect && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onCorrect(record)}
                            className={secondaryButton}
                            aria-label={`Correct record effective ${formatDateOnly(record.effectiveFrom)}`}
                          >
                            Correct
                          </button>
                        )}
                        {onEnd && record.actions.canEnd && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => onEnd(record)}
                            className={secondaryButton}
                            aria-label={`End record effective ${formatDateOnly(record.effectiveFrom)}`}
                          >
                            End
                          </button>
                        )}
                      </div>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {view.superseded.length > 0 && <SupersededRecords records={view.superseded} />}
    </div>
  );
}

function SupersededRecords({ records }: { records: CompensationRecord[] }) {
  return (
    <details className="rounded-lg border border-slate-200 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-slate-700">
        Corrected records ({records.length})
      </summary>
      <ul className="mt-2 space-y-1 text-slate-600">
        {records.map((record) => (
          <li key={record.id}>
            <span className="line-through">
              {formatPeriod(record.effectiveFrom, record.effectiveTo)} · {formatRecordRate(record)}
            </span>{' '}
            <span className="text-xs">(replaced by a correction)</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** How a record stands relative to the assignment's today (dates compared as YYYY-MM-DD text). */
export function recordStanding(
  record: Pick<CompensationRecord, 'effectiveFrom' | 'effectiveTo'>,
  today: string | null,
): 'current' | 'past' | 'future' | null {
  if (!today) return null;
  if (record.effectiveFrom > today) return 'future';
  if (record.effectiveTo && record.effectiveTo < today) return 'past';
  return 'current';
}

const STANDING: Record<
  'current' | 'past' | 'future',
  { text: string; tone: 'info' | 'neutral' | 'warning' }
> = {
  current: { text: 'Current', tone: 'info' },
  past: { text: 'Historical (ended)', tone: 'neutral' },
  future: { text: 'Future-effective', tone: 'warning' },
};

/**
 * Batch R3.4 — the compensation in effect on a chosen date (GET …/compensation/as-of). Dates are
 * date-only text (YYYY-MM-DD) end to end, so no timezone can shift them; "today" is the
 * assignment-local date the API reports. The API applies the same permission as the rest of
 * this view (compensation.read in scope, or one's own).
 */
const IDLE = { status: 'idle' } as const;

export function CompensationOnDate({ view }: { view: CompensationAssignmentView }) {
  const today = view.asOf;
  const [date, setDate] = useState(today ?? '');
  // Each result remembers the view it answered: once the view is reloaded (after a change or
  // correction, or for another assignment) an earlier result is no longer shown.
  const [answer, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading'; date: string; forView: CompensationAssignmentView }
    | {
        status: 'done';
        date: string;
        record: CompensationRecord | null;
        forView: CompensationAssignmentView;
      }
    | { status: 'error'; date: string; message: string; forView: CompensationAssignmentView }
  >({ status: 'idle' });
  const state = answer.status !== 'idle' && answer.forView === view ? answer : IDLE;
  const [problem, setProblem] = useState<string | null>(null);
  const request = useRef(0);
  const inputId = useId();
  const assignmentId = view.assignment.id;

  // R4-A (Checkpoint C): no effect invalidates lookups. A mount/view effect could run after a
  // click that happened before it (React flushes it before the click's update) and discard
  // that click's answer. Each result already names the view it answered and only the current
  // view's is shown; the counter drops answers overtaken by a newer lookup.

  async function lookUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!DATE_ONLY.test(date)) {
      setProblem('Choose a date.');
      return;
    }
    setProblem(null);
    const id = ++request.current;
    const forView = view;
    setState({ status: 'loading', date, forView });
    try {
      const result = await compensationApi.asOf(assignmentId, date);
      if (id === request.current)
        setState({ status: 'done', date, record: result.record, forView });
    } catch (cause) {
      if (id === request.current)
        setState({
          status: 'error',
          date,
          message: compensationErrorMessage(cause, 'Unable to look up compensation for that date.'),
          forView,
        });
    }
  }

  const relation =
    state.status === 'done' && today
      ? state.date < today
        ? 'a past date'
        : state.date > today
          ? 'a future date'
          : 'today'
      : null;

  return (
    <section
      aria-label={`Compensation on a date for ${assignmentTitle(view)}`}
      className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
    >
      <form onSubmit={(event) => void lookUp(event)} className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={inputId} className="block text-sm font-medium text-slate-800">
            Compensation on date
          </label>
          <input
            id={inputId}
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.currentTarget.value)}
            aria-describedby={problem ? `${inputId}-problem` : undefined}
            aria-invalid={problem ? true : undefined}
            className={`${inputClass} mt-1`}
          />
        </div>
        <button type="submit" className={secondaryButton} disabled={state.status === 'loading'}>
          Show
        </button>
        {problem && (
          <p id={`${inputId}-problem`} role="alert" className="w-full text-sm text-rose-800">
            {problem}
          </p>
        )}
      </form>
      {/* R4-A.7: one polite region for progress and results; a failure is its own alert
          outside it, so nothing is announced twice. */}
      {state.status === 'error' && (
        <p role="alert" className="text-sm text-rose-800">
          {state.message}
        </p>
      )}
      <div aria-live="polite" className="space-y-2">
        {state.status === 'loading' && (
          <p className="text-sm text-slate-600">Looking up {formatDateOnly(state.date)}…</p>
        )}
        {state.status === 'done' && (
          <>
            <p className="text-sm text-slate-700">
              On <span className="font-medium">{formatDateOnly(state.date)}</span>
              {relation && <span className="text-slate-500"> ({relation})</span>}:
              {state.record &&
                (() => {
                  const standing = recordStanding(state.record, today);
                  return standing ? (
                    <span className={`ml-2 ${badgeClass(STANDING[standing].tone)}`}>
                      {STANDING[standing].text}
                    </span>
                  ) : null;
                })()}
            </p>
            {state.record ? (
              <RecordDetails record={state.record} />
            ) : (
              <p className="text-sm text-slate-600">
                No compensation{' '}
                {relation === 'a future date' ? 'is scheduled for' : 'was in effect on'} that date.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
