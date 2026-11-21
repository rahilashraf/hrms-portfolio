'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { timeApi } from '../../../lib/time/api';
import { LOCAL_TIME_SELECT_OCCURRENCE, timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatInstant, label } from '../../../lib/time/format';
import type {
  CorrectionRequestInput,
  TimeCorrection,
  TimeEntryRead,
  TimeException,
  TimeStatus,
} from '../../../lib/time/types';
import { buttonClass } from '../../ui/button';
import { EmptyState, ErrorState, LoadingState } from '../../ui/states';
import { inputClass } from '../../ui/tokens';
import { useConfirm } from '../../ui/use-confirm';
import { OccurrenceChoice, toLocalInput, useLocalTimeSubmission } from '../review/entry-dialogs';
import { actorLabel, LoadMore, resolutionLabel, usePagedList } from '../review/review-shared';
import { isReadOnly, ReadOnlyBadge } from '../time-notices';
import { assignmentName, openMyTime, Section } from './shared';

/**
 * Batch 4E-3 — Requests: correction requests of every type the API accepts from an employee
 * (never a direct change: punches stay as recorded and a manager decides), the decisions with
 * the reviewer's name and note, and the employee's exceptions with what (if anything) to do.
 * On a day the clocks go back, a repeated local time offers both occurrences (D6); the chosen
 * offset is sent, and a manager still approves.
 */

type Kind =
  | 'CHANGE_CLOCK_IN'
  | 'CHANGE_CLOCK_OUT'
  | 'ADD_MISSING_CLOCK_OUT'
  | 'ADD_BREAK'
  | 'CHANGE_BREAK_START'
  | 'CHANGE_BREAK_END'
  | 'REMOVE_BREAK'
  | 'CHANGE_ASSIGNMENT'
  | 'ADD_MISSING_TIME_ENTRY';

const KINDS: ReadonlyArray<{ kind: Kind; text: string }> = [
  { kind: 'CHANGE_CLOCK_IN', text: 'Change the clock-in time' },
  { kind: 'CHANGE_CLOCK_OUT', text: 'Change the clock-out time' },
  { kind: 'ADD_MISSING_CLOCK_OUT', text: 'Add a missing clock-out (entry still open)' },
  { kind: 'ADD_BREAK', text: 'Add a break' },
  { kind: 'CHANGE_BREAK_START', text: 'Change a break’s start' },
  { kind: 'CHANGE_BREAK_END', text: 'Change a break’s end' },
  { kind: 'REMOVE_BREAK', text: 'Remove a break' },
  { kind: 'CHANGE_ASSIGNMENT', text: 'Move the entry to another assignment' },
  { kind: 'ADD_MISSING_TIME_ENTRY', text: 'Add a missing entry' },
];

const NEEDS_ENTRY = (kind: Kind) => kind !== 'ADD_MISSING_TIME_ENTRY';
const NEEDS_BREAK = (kind: Kind) =>
  kind === 'CHANGE_BREAK_START' || kind === 'CHANGE_BREAK_END' || kind === 'REMOVE_BREAK';

export function RequestsPanel({
  status,
  entryId,
  attendanceOff = false,
}: {
  status: TimeStatus | null;
  entryId: string | null;
  /** Batch 4F (C10): every organization of the employee has Time & attendance turned off. */
  attendanceOff?: boolean;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div className="space-y-6">
      {attendanceOff ? (
        <Section title="Request a correction">
          <p className="text-sm text-slate-700">
            Time &amp; attendance is turned off for your organization, so corrections cannot be
            requested. Your requests and exceptions below are kept as history, read only.
          </p>
        </Section>
      ) : (
        <CorrectionForm
          status={status}
          initialEntryId={entryId}
          onRequested={() => setReloadKey((key) => key + 1)}
        />
      )}
      <MyCorrections reloadKey={reloadKey} />
      <MyExceptions status={status} />
    </div>
  );
}

// ─── New request ──────────────────────────────────────────────────────────

function CorrectionForm({
  status,
  initialEntryId,
  onRequested,
}: {
  status: TimeStatus | null;
  initialEntryId: string | null;
  onRequested(): void;
}) {
  const capabilities = status?.assignmentCapabilities ?? [];
  const timed = capabilities.filter(
    (item) => item.trackingMode === 'TIME_CLOCK' && item.attendanceEnabled,
  );
  const requestsOff =
    capabilities.length > 0 && capabilities.every((item) => !item.correctionRequestsEnabled);
  const [entries, setEntries] = useState<TimeEntryRead[] | null>(null);
  const [kind, setKind] = useState<Kind>('CHANGE_CLOCK_OUT');
  const [entryId, setEntryId] = useState(initialEntryId ?? '');
  const [breakId, setBreakId] = useState('');
  const [times, setTimes] = useState<Record<string, string>>({});
  const [assignmentId, setAssignmentId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const local = useLocalTimeSubmission();
  const ids = {
    kind: useId(),
    entry: useId(),
    break: useId(),
    assignment: useId(),
    reason: useId(),
    a: useId(),
    b: useId(),
  };

  useEffect(() => {
    let active = true;
    timeApi
      .selfEntries({ limit: 50 })
      .then((page) => {
        // Batch 4F (C10): entries of an organization with attendance turned off are history.
        const disabled = page.attendanceDisabledOrganizationIds ?? [];
        if (active) {
          setEntries(
            page.items.filter(
              (entry) =>
                entry.status !== 'VOIDED' &&
                !isReadOnly(disabled, entry.assignment.organization?.id),
            ),
          );
        }
      })
      .catch(() => {
        if (active) setEntries([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const entry = entries?.find((item) => item.id === entryId) ?? null;
  // An open entry only takes a missing clock-out; closed ones everything else.
  const kinds = KINDS.filter(({ kind: k }) =>
    entry
      ? entry.status === 'OPEN'
        ? k === 'ADD_MISSING_CLOCK_OUT'
        : k !== 'ADD_MISSING_CLOCK_OUT'
      : true,
  );
  const effectiveKind = kinds.some((item) => item.kind === kind) ? kind : (kinds[0]?.kind ?? kind);
  const breaks = entry?.breaks ?? [];
  const chosenBreak = breaks.find((item) => item.id === breakId) ?? null;
  const timezone =
    entry?.timezone ??
    timed.find((item) => item.employmentAssignmentId === assignmentId)?.timezone ??
    null;

  /** The local-time fields of the chosen kind: [field, label, current value]. */
  const fields: Array<[keyof CorrectionRequestInput, string, string | null]> = (() => {
    switch (effectiveKind) {
      case 'CHANGE_CLOCK_IN':
        return [['clockInAt', 'Correct clock-in', entry?.clockInAt ?? null]];
      case 'CHANGE_CLOCK_OUT':
        return [['clockOutAt', 'Correct clock-out', entry?.clockOutAt ?? null]];
      case 'ADD_MISSING_CLOCK_OUT':
        return [['clockOutAt', 'Clock-out', null]];
      case 'ADD_BREAK':
        return [
          ['breakStartAt', 'Break start', null],
          ['breakEndAt', 'Break end', null],
        ];
      case 'CHANGE_BREAK_START':
        return [['breakStartAt', 'Correct break start', chosenBreak?.startAt ?? null]];
      case 'CHANGE_BREAK_END':
        return [['breakEndAt', 'Correct break end', chosenBreak?.endAt ?? null]];
      case 'ADD_MISSING_TIME_ENTRY':
        return [
          ['startAt', 'Started', null],
          ['endAt', 'Ended', null],
        ];
      default:
        return [];
    }
  })();

  /** The value shown and sent for a field: what was typed, else the recorded value. */
  function valueOf(field: string, current: string | null): string {
    return times[field] ?? (current && timezone ? toLocalInput(current, timezone) : '');
  }

  function reset() {
    setTimes({});
    setReason('');
    setBreakId('');
    local.reset();
  }

  const blocked =
    local.ambiguous !== null &&
    !local.chosen[local.ambiguous.field]?.startsWith(
      valueOf(
        local.ambiguous.field,
        fields.find(([field]) => field === local.ambiguous?.field)?.[2] ?? null,
      ) || '\u0000',
    );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    const typed = Object.fromEntries(
      fields.map(([field, , current]) => [field, valueOf(field, current)]),
    );
    const input: CorrectionRequestInput = {
      type: effectiveKind,
      reason: reason.trim(),
      ...(NEEDS_ENTRY(effectiveKind) ? { timeEntryId: entryId } : {}),
      ...(NEEDS_BREAK(effectiveKind) ? { breakEntryId: breakId } : {}),
      ...(effectiveKind === 'CHANGE_ASSIGNMENT'
        ? { targetEmploymentAssignmentId: assignmentId }
        : {}),
      ...(effectiveKind === 'ADD_MISSING_TIME_ENTRY'
        ? { employmentAssignmentId: assignmentId }
        : {}),
      ...Object.fromEntries(
        fields.map(([field]) => [field, local.resolved(field, typed[field] ?? '')]),
      ),
    };
    try {
      await timeApi.requestCorrection(input);
      setSuccess('Correction requested. Your manager reviews it; nothing changes until then.');
      reset();
      onRequested();
    } catch (cause) {
      if (local.absorb(cause, typed)) setError(LOCAL_TIME_SELECT_OCCURRENCE);
      else setError(timeErrorMessage(cause, 'Unable to request this correction.'));
    } finally {
      setBusy(false);
    }
  }

  if (requestsOff) {
    return (
      <Section title="Request a correction">
        <p className="text-sm text-slate-700">
          Correction requests are not available for your assignments. Ask your manager to correct
          your time.
        </p>
      </Section>
    );
  }

  return (
    <Section
      title="Request a correction"
      description="Your manager reviews every request. The original punches are always kept."
    >
      {entries === null ? (
        <LoadingState label="Loading your entries…" />
      ) : (
        <form
          aria-label="Request a correction"
          onSubmit={(event) => void submit(event)}
          className="space-y-4"
          noValidate
        >
          <div className="grid gap-3 md:grid-cols-2">
            {effectiveKind !== 'ADD_MISSING_TIME_ENTRY' && (
              <div>
                <label htmlFor={ids.entry} className="block text-sm font-medium text-slate-700">
                  Attendance record
                </label>
                <select
                  id={ids.entry}
                  value={entryId}
                  required
                  onChange={(event) => {
                    setEntryId(event.target.value);
                    reset();
                  }}
                  className={inputClass}
                >
                  <option value="">Choose a record</option>
                  {entries.map((item) => (
                    <option key={item.id} value={item.id}>
                      {formatDateOnly(item.workDate)} · {assignmentName(item.assignment)}
                      {item.status === 'OPEN' ? ' · open' : ''}
                    </option>
                  ))}
                </select>
                {initialEntryId && !entries.some((item) => item.id === initialEntryId) && (
                  <p className="mt-1 text-xs text-slate-600">
                    That record is not among your 50 latest; choose it here if listed.
                  </p>
                )}
              </div>
            )}
            <div>
              <label htmlFor={ids.kind} className="block text-sm font-medium text-slate-700">
                What to correct
              </label>
              <select
                id={ids.kind}
                value={effectiveKind}
                onChange={(event) => {
                  setKind(event.target.value as Kind);
                  reset();
                }}
                className={inputClass}
              >
                {kinds.map((item) => (
                  <option key={item.kind} value={item.kind}>
                    {item.text}
                  </option>
                ))}
              </select>
            </div>
            {NEEDS_BREAK(effectiveKind) && (
              <div>
                <label htmlFor={ids.break} className="block text-sm font-medium text-slate-700">
                  Break
                </label>
                <select
                  id={ids.break}
                  value={breakId}
                  required
                  onChange={(event) => setBreakId(event.target.value)}
                  className={inputClass}
                >
                  <option value="">Choose a break</option>
                  {breaks.map((item) => (
                    <option key={item.id} value={item.id}>
                      {formatInstant(item.startAt, entry?.timezone)} –{' '}
                      {item.endAt ? formatInstant(item.endAt, entry?.timezone) : 'open'}
                    </option>
                  ))}
                </select>
                {entry && breaks.length === 0 && (
                  <p className="mt-1 text-xs text-slate-600">This record has no breaks.</p>
                )}
              </div>
            )}
            {(effectiveKind === 'CHANGE_ASSIGNMENT' ||
              effectiveKind === 'ADD_MISSING_TIME_ENTRY') && (
              <div>
                <label
                  htmlFor={ids.assignment}
                  className="block text-sm font-medium text-slate-700"
                >
                  {effectiveKind === 'CHANGE_ASSIGNMENT' ? 'Move to' : 'Assignment'}
                </label>
                <select
                  id={ids.assignment}
                  value={assignmentId}
                  required
                  onChange={(event) => {
                    setAssignmentId(event.target.value);
                    local.reset();
                  }}
                  className={inputClass}
                >
                  <option value="">Choose an assignment</option>
                  {timed
                    .filter(
                      (item) =>
                        item.employmentAssignmentId !== entry?.employmentAssignmentId ||
                        effectiveKind === 'ADD_MISSING_TIME_ENTRY',
                    )
                    .map((item) => (
                      <option key={item.employmentAssignmentId} value={item.employmentAssignmentId}>
                        {assignmentName(item)}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </div>
          {entry && (
            <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
              Recorded: {formatInstant(entry.clockInAt, entry.timezone)} –{' '}
              {entry.clockOutAt ? formatInstant(entry.clockOutAt, entry.timezone) : 'still open'} (
              {entry.timezone}) · {assignmentName(entry.assignment)}
            </p>
          )}
          {fields.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {fields.map(([field, text, current], index) => (
                <div key={field}>
                  <label
                    htmlFor={index === 0 ? ids.a : ids.b}
                    className="block text-sm font-medium text-slate-700"
                  >
                    {text}
                  </label>
                  <input
                    id={index === 0 ? ids.a : ids.b}
                    type="datetime-local"
                    required
                    value={valueOf(field, current)}
                    onChange={(event) => {
                      setTimes((value) => ({ ...value, [field]: event.target.value }));
                      setError(null);
                    }}
                    aria-describedby={`${index === 0 ? ids.a : ids.b}-zone`}
                    className={inputClass}
                  />
                  <p
                    id={`${index === 0 ? ids.a : ids.b}-zone`}
                    className="mt-1 text-xs text-slate-600"
                  >
                    {timezone
                      ? `Local time in ${timezone}.`
                      : 'Choose the record or assignment first.'}
                    {current && timezone ? ` Recorded: ${formatInstant(current, timezone)}.` : ''}
                  </p>
                  {local.ambiguous?.field === field && (
                    <div className="mt-2">
                      <OccurrenceChoice
                        occurrences={local.ambiguous.occurrences}
                        value={local.chosen[field] ?? ''}
                        onChange={(next) => local.choose(field, next)}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div>
            <label htmlFor={ids.reason} className="block text-sm font-medium text-slate-700">
              Reason
            </label>
            <textarea
              id={ids.reason}
              rows={2}
              required
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className={inputClass}
            />
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
              {error}
            </p>
          )}
          {success && (
            <p
              role="status"
              className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
            >
              {success}
            </p>
          )}
          <button
            type="submit"
            disabled={
              busy ||
              blocked ||
              reason.trim() === '' ||
              (NEEDS_ENTRY(effectiveKind) && !entryId) ||
              (NEEDS_BREAK(effectiveKind) && !breakId) ||
              ((effectiveKind === 'CHANGE_ASSIGNMENT' ||
                effectiveKind === 'ADD_MISSING_TIME_ENTRY') &&
                !assignmentId) ||
              fields.some(([field, , current]) => !valueOf(field, current))
            }
            className={buttonClass('primary')}
          >
            {busy ? 'Requesting…' : 'Request correction'}
          </button>
        </form>
      )}
    </Section>
  );
}

// ─── My requests ──────────────────────────────────────────────────────────

/** "Clock out: 17:00" from a correction's stored values, in the entry's time zone. */
function describeValues(values: unknown, timezone: string | null | undefined): string {
  if (!values || typeof values !== 'object') return '—';
  const parts: string[] = [];
  const names: Record<string, string> = {
    clockInAt: 'Clock-in',
    clockOutAt: 'Clock-out',
    breakStartAt: 'Break start',
    breakEndAt: 'Break end',
    startAt: 'Start',
    endAt: 'End',
  };
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (!names[key] || typeof value !== 'string' || value === '') continue;
    const text = /Z$|[+-]\d{2}:\d{2}$/.test(value)
      ? formatInstant(value, timezone)
      : value.replace('T', ' ');
    parts.push(`${names[key]} ${text}`);
  }
  return parts.length > 0 ? parts.join(', ') : '—';
}

function MyCorrections({ reloadKey }: { reloadKey: number }) {
  const [confirm, confirmDialog] = useConfirm();
  const [message, setMessage] = useState<string | null>(null);
  const fetchPage = useCallback(
    async (afterId?: string) => {
      const result = await timeApi.selfCorrections({ limit: 20, ...(afterId ? { afterId } : {}) });
      return {
        items: result.corrections,
        nextAfterId: result.nextAfterId ?? null,
        attendanceDisabledOrganizationIds: result.attendanceDisabledOrganizationIds,
      };
    },
    // reloadKey: reload after a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reloadKey],
  );
  const list = usePagedList(fetchPage, 'Unable to load your correction requests.');

  async function cancel(item: TimeCorrection) {
    if (
      !(await confirm({
        title: 'Cancel this request?',
        description: 'Your manager will not review it. You can request again later.',
        confirmLabel: 'Cancel request',
      }))
    )
      return;
    try {
      await timeApi.cancelCorrection(item.id);
      setMessage('Request cancelled.');
      await list.reload();
    } catch (cause) {
      setMessage(timeErrorMessage(cause, 'Unable to cancel this request.'));
    }
  }

  return (
    <Section title="My correction requests">
      {confirmDialog}
      {message && (
        <p role="status" className="mb-3 text-sm text-slate-800">
          {message}
        </p>
      )}
      {list.loading ? (
        <LoadingState label="Loading your requests…" />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={() => void list.reload()} />
      ) : list.items.length === 0 ? (
        <EmptyState title="No correction requests." />
      ) : (
        <ul className="space-y-3">
          {list.items.map((item) => {
            const readOnly = isReadOnly(
              list.disabledOrganizationIds,
              (item.assignment ?? item.targetAssignment)?.organization?.id,
            );
            return (
              <li key={item.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-slate-950">
                    {label(item.type)} · {formatDateOnly(item.workDate)}
                    {item.assignment ? ` · ${assignmentName(item.assignment)}` : ''}
                  </p>
                  <span className="flex flex-wrap items-center gap-2">
                    {readOnly && <ReadOnlyBadge />}
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-800">
                      {label(item.status)}
                    </span>
                  </span>
                </div>
                <dl className="mt-2 grid gap-1 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs uppercase text-slate-500">Recorded</dt>
                    <dd>{describeValues(item.currentValues, item.timezone)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase text-slate-500">Requested</dt>
                    <dd>{describeValues(item.requestedValues, item.timezone)}</dd>
                  </div>
                </dl>
                <p className="mt-1 text-slate-700">Your reason: {item.reason}</p>
                {item.reviewedAt && item.status !== 'CANCELLED' && (
                  <p className="mt-1 text-slate-800">
                    {label(item.status)} by {actorLabel(item.actors, item.reviewerUserId, null)} on{' '}
                    {formatInstant(item.reviewedAt, item.timezone)}
                    {item.reviewerNote ? ` · “${item.reviewerNote}”` : ''}
                  </p>
                )}
                {item.status === 'PENDING' && !readOnly && (
                  <button
                    type="button"
                    className={`${buttonClass('secondary', 'sm')} mt-2`}
                    onClick={() => void cancel(item)}
                  >
                    Cancel request{' '}
                    <span className="sr-only">
                      {label(item.type)} for {formatDateOnly(item.workDate)}
                    </span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <LoadMore list={list} noun={['request', 'requests']} />
    </Section>
  );
}

// ─── Exceptions ───────────────────────────────────────────────────────────

/** What the employee can do about an open exception (the API decides what is allowed). */
function nextStep(exception: TimeException, status: TimeStatus | null): string {
  switch (exception.type) {
    case 'MISSING_CLOCK_OUT':
      return status?.availableActions.includes('RESOLVE_MISSED_CLOCK_OUT')
        ? 'Enter your clock-out on Today, or request a correction.'
        : 'Request a missing clock-out, or ask your manager.';
    case 'NO_SHOW':
      return 'If you worked, request the missing entry. Otherwise your manager reviews it.';
    case 'LATE_ARRIVAL':
    case 'LATE_SIGN_IN':
    case 'EARLY_DEPARTURE':
      return 'Nothing to do: your manager reviews it. If the time is wrong, request a correction.';
    default:
      return 'Your manager reviews it.';
  }
}

function MyExceptions({ status }: { status: TimeStatus | null }) {
  const fetchPage = useCallback(async (afterId?: string) => {
    const result = await timeApi.selfExceptions({ limit: 20, ...(afterId ? { afterId } : {}) });
    return {
      items: result.exceptions,
      nextAfterId: result.nextAfterId ?? null,
      attendanceDisabledOrganizationIds: result.attendanceDisabledOrganizationIds,
    };
  }, []);
  const list = usePagedList(fetchPage, 'Unable to load your exceptions.');
  return (
    <Section
      title="Exceptions"
      description="Things your attendance flagged, and what (if anything) you need to do."
    >
      {list.loading ? (
        <LoadingState label="Loading your exceptions…" />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={() => void list.reload()} />
      ) : list.items.length === 0 ? (
        <EmptyState title="No exceptions." />
      ) : (
        <ul className="space-y-2">
          {list.items.map((item) => {
            const readOnly = isReadOnly(
              list.disabledOrganizationIds,
              item.assignment?.organization?.id,
            );
            return (
              <li key={item.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <p className="font-medium text-slate-950">
                  {label(item.type)} · {formatDateOnly(item.workDate)}
                  {item.assignment ? ` · ${assignmentName(item.assignment)}` : ''} ·{' '}
                  {label(item.status)}
                </p>
                {readOnly && (
                  <p className="mt-1">
                    <ReadOnlyBadge />
                  </p>
                )}
                {item.status === 'OPEN' && readOnly ? (
                  <p className="mt-1 text-slate-700">
                    Nothing can be done while attendance is turned off.
                  </p>
                ) : item.status === 'OPEN' ? (
                  <p className="mt-1 text-slate-800">
                    {nextStep(item, status)}{' '}
                    {(item.type === 'MISSING_CLOCK_OUT' || item.type === 'NO_SHOW') && (
                      <button
                        type="button"
                        className="font-semibold text-indigo-800 underline"
                        onClick={() =>
                          openMyTime(
                            item.type === 'MISSING_CLOCK_OUT' &&
                              status?.availableActions.includes('RESOLVE_MISSED_CLOCK_OUT')
                              ? 'today'
                              : 'requests',
                            item.timeEntryId ? { entry: item.timeEntryId } : {},
                          )
                        }
                      >
                        Go there
                      </button>
                    )}
                  </p>
                ) : (
                  <p className="mt-1 text-slate-700">
                    {resolutionLabel(item.status, item.resolutionMethod)}
                    {item.resolvedByUserId
                      ? ` · ${actorLabel(item.actors, item.resolvedByUserId, null)}`
                      : ''}
                    {item.resolvedAt ? ` · ${formatInstant(item.resolvedAt, item.timezone)}` : ''}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <LoadMore list={list} noun={['exception', 'exceptions']} />
    </Section>
  );
}
