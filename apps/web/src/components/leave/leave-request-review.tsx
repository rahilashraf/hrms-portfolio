'use client';

import { checkboxClass } from '../ui/tokens';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../organization/shared';
import { leaveApi } from '../../lib/leave/api';
import { leaveErrorMessage } from '../../lib/leave/errors';
import {
  addDaysIso,
  formatDateOnly,
  formatInstant,
  formatLeaveAmount,
  formatLeaveRange,
  dayOverrideMinutes,
  LEAVE_DAY_OVERRIDE_MAX_MINUTES,
} from '../../lib/leave/format';
import type { LeaveDayOverride, LeaveRequestDetail } from '../../lib/leave/types';
import {
  BalanceFigures,
  dangerButton,
  inputClass,
  LeaveDaysTable,
  LeaveStatusPill,
  Panel,
  primaryButton,
  balanceImpactText,
  LeaveRequestProgress,
  RequestHistory,
  secondaryButton,
} from './leave-shared';

// Batch 10B: one request's review (approve, reject, amend), moved from leave-management-page.tsx
// unchanged. Leave rules and API calls are the same; only the file changed.
type Decision = 'approve' | 'reject' | 'amend' | null;

export function RequestReview({
  requestId,
  onClose,
  onChanged,
}: {
  requestId: string;
  onClose(): void;
  onChanged(message: string): Promise<void>;
}) {
  const [detail, setDetail] = useState<LeaveRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<Decision>(null);
  const [note, setNote] = useState('');
  const [overrides, setOverrides] = useState<Record<string, { hours: string; reason: string }>>({});
  const [overrideErrors, setOverrideErrors] = useState<Record<string, string>>({});
  const [amendMode, setAmendMode] = useState<'from' | 'dates'>('from');
  const [cancelFrom, setCancelFrom] = useState('');
  const [cancelDates, setCancelDates] = useState<string[]>([]);

  const load = useCallback(async () => {
    setDetail(await leaveApi.request(requestId));
  }, [requestId]);

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

  async function run(action: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      setDecision(null);
      setNote('');
      await load();
      await onChanged(message);
    } catch (cause) {
      setError(leaveErrorMessage(cause, 'Unable to complete this leave decision.'));
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <Panel title="Request">
        {error ? (
          <ErrorBanner>{error}</ErrorBanner>
        ) : (
          <p role="status" className="text-sm text-slate-600">
            Loading request…
          </p>
        )}
      </Panel>
    );
  }

  const unit = detail.leaveType.displayUnit;
  const activeDays = detail.days.filter((day) => !day.cancelled);
  // Locked days cannot be cancelled: "cancel from" must start after the last locked one.
  const lastLocked = activeDays.filter((day) => day.locked).at(-1)?.date ?? null;
  const cancelFromMin = lastLocked ? addDaysIso(lastLocked, 1) : detail.startDate;

  function approve() {
    const dayOverrides: LeaveDayOverride[] = [];
    const invalid: Record<string, string> = {};
    for (const [date, value] of Object.entries(overrides)) {
      const parsed = dayOverrideMinutes(value.hours);
      if (parsed.error !== null) {
        invalid[date] = parsed.error;
        continue;
      }
      if (parsed.minutes === null) continue;
      dayOverrides.push({ date, minutes: parsed.minutes, reason: value.reason.trim() });
    }
    setOverrideErrors(invalid);
    if (Object.keys(invalid).length > 0) {
      setError('Check the adjusted hours: each day takes 0 to 24 hours.');
      return;
    }
    if (dayOverrides.some((o) => !o.reason)) {
      setError('Every adjusted day needs a reason.');
      return;
    }
    void run(
      () =>
        leaveApi.approve(detail!.id, {
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(dayOverrides.length ? { dayOverrides } : {}),
        }),
      'Leave approved.',
    );
  }

  function amend() {
    if (!note.trim()) {
      setError('A reason is required to change approved leave.');
      return;
    }
    const input =
      amendMode === 'from'
        ? { reason: note.trim(), cancelFrom }
        : { reason: note.trim(), cancelDates };
    void run(
      () => leaveApi.amend(detail!.id, input),
      'Leave changed; the cancelled days were returned to the balance.',
    );
  }

  return (
    <Panel
      title={`${detail.employee.displayName ?? detail.employee.employeeNumber} · ${detail.leaveType.name}`}
      actions={
        <button type="button" className={secondaryButton} onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="space-y-5">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <LeaveRequestProgress detail={detail} />
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
          <LeaveStatusPill value={detail.status} />
          <span>
            {formatLeaveRange(
              detail.startDate,
              detail.endDate,
              detail.startLocalTime,
              detail.endLocalTime,
            )}
          </span>
          <span>Requested {formatLeaveAmount(detail.requestedMinutes, unit)}</span>
          {detail.approvedMinutes !== null && (
            <span>Approved {formatLeaveAmount(detail.approvedMinutes, unit)}</span>
          )}
          <span className="text-slate-500">
            {detail.positionName} · {detail.timezone}
          </span>
        </div>
        {detail.reason && <p className="text-sm text-slate-700">Reason: {detail.reason}</p>}
        {detail.balance && (
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Balance today</h3>
            <div className="mt-2">
              <BalanceFigures balance={detail.balance} unit={unit} />
            </div>
            <p className="mt-2 text-sm text-slate-600">{balanceImpactText(detail)}</p>
          </div>
        )}
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Days</h3>
          <div className="mt-2">
            <LeaveDaysTable days={detail.days} timezone={detail.timezone} />
          </div>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Schedule coverage</h3>
          {detail.coverage.coveredShifts.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No published shifts overlap this leave.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-slate-600">
                {detail.coverage.coveredShifts.length} published shift(s),{' '}
                {formatLeaveAmount(detail.coverage.totalOverlapMinutes)} overlap. Leave never
                changes the schedule; reassign or cancel shifts in Scheduling if needed.
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                {detail.coverage.coveredShifts.map((shift) => (
                  <li key={shift.scheduledShiftId}>
                    {formatDateOnly(shift.workDate)}:{' '}
                    {formatInstant(shift.startsAt, shift.timezone)} –{' '}
                    {formatInstant(shift.endsAt, shift.timezone)} (
                    {formatLeaveAmount(shift.overlapMinutes)} on leave)
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">History</h3>
          <div className="mt-2">
            <RequestHistory detail={detail} />
          </div>
        </div>

        {detail.status === 'PENDING' && detail.leaveType.archived && (
          <p role="note" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            This leave type has been archived, so the request can no longer be approved. Reject it
            and, if needed, record the leave under an active type.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {detail.actions.canApprove && (
            <button type="button" className={primaryButton} onClick={() => setDecision('approve')}>
              Approve…
            </button>
          )}
          {detail.actions.canReject && (
            <button type="button" className={dangerButton} onClick={() => setDecision('reject')}>
              Reject…
            </button>
          )}
          {detail.actions.canAmend && (
            <button type="button" className={secondaryButton} onClick={() => setDecision('amend')}>
              Shorten or cancel…
            </button>
          )}
        </div>

        {decision && (
          <form
            className="space-y-4 rounded-lg border border-slate-200 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (decision === 'approve') approve();
              if (decision === 'reject')
                void run(
                  () => leaveApi.reject(detail.id, note.trim() || undefined),
                  'Leave rejected.',
                );
              if (decision === 'amend') amend();
            }}
          >
            {decision === 'approve' && (
              <div className="space-y-2">
                <p className="text-sm text-slate-700">
                  Amounts are re-sized from today&apos;s schedule and frozen on approval. Adjust a
                  day only with a reason.
                </p>
                {activeDays.map((day) => (
                  <div key={day.date} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <span className="text-sm text-slate-700">
                      {formatDateOnly(day.date)} ({formatLeaveAmount(day.minutes)})
                    </span>
                    <label className="text-sm text-slate-700">
                      Hours for {day.date}
                      <input
                        type="number"
                        step="0.25"
                        min={0}
                        max={LEAVE_DAY_OVERRIDE_MAX_MINUTES / 60}
                        value={overrides[day.date]?.hours ?? ''}
                        placeholder={String(day.minutes / 60)}
                        aria-invalid={overrideErrors[day.date] ? true : undefined}
                        aria-describedby={
                          overrideErrors[day.date] ? `override-error-${day.date}` : undefined
                        }
                        onChange={(event) => {
                          setOverrides({
                            ...overrides,
                            [day.date]: {
                              hours: event.target.value,
                              reason: overrides[day.date]?.reason ?? '',
                            },
                          });
                          setOverrideErrors((current) => {
                            const next = { ...current };
                            delete next[day.date];
                            return next;
                          });
                        }}
                        className={inputClass}
                      />
                      {overrideErrors[day.date] && (
                        <span
                          id={`override-error-${day.date}`}
                          className="mt-1 block text-sm text-rose-800"
                        >
                          {overrideErrors[day.date]}
                        </span>
                      )}
                    </label>
                    <label className="text-sm text-slate-700">
                      Reason for {day.date}
                      <input
                        value={overrides[day.date]?.reason ?? ''}
                        onChange={(event) =>
                          setOverrides({
                            ...overrides,
                            [day.date]: {
                              hours: overrides[day.date]?.hours ?? '',
                              reason: event.target.value,
                            },
                          })
                        }
                        className={inputClass}
                      />
                    </label>
                  </div>
                ))}
              </div>
            )}
            {decision === 'amend' && (
              <div className="space-y-3">
                <div className="flex gap-4 text-sm text-slate-700">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={amendMode === 'from'}
                      onChange={() => setAmendMode('from')}
                    />
                    End early (cancel from a date)
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={amendMode === 'dates'}
                      onChange={() => setAmendMode('dates')}
                    />
                    Cancel specific days
                  </label>
                </div>
                {amendMode === 'from' ? (
                  <label className="block text-sm font-medium text-slate-700">
                    Cancel from
                    <input
                      type="date"
                      required
                      min={cancelFromMin}
                      max={detail.endDate}
                      value={cancelFrom}
                      onChange={(event) => setCancelFrom(event.target.value)}
                      className={inputClass}
                    />
                  </label>
                ) : (
                  <fieldset className="flex flex-wrap gap-3 text-sm text-slate-700">
                    <legend className="mb-1 font-medium">Days to cancel</legend>
                    {activeDays.map((day) => (
                      <label key={day.date} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          className={checkboxClass}
                          disabled={day.locked}
                          checked={cancelDates.includes(day.date)}
                          onChange={(event) =>
                            setCancelDates(
                              event.target.checked
                                ? [...cancelDates, day.date]
                                : cancelDates.filter((d) => d !== day.date),
                            )
                          }
                        />
                        {formatDateOnly(day.date)}
                        {day.locked && (
                          <span className="text-xs text-slate-500">(locked period)</span>
                        )}
                      </label>
                    ))}
                  </fieldset>
                )}
                <p className="text-xs text-slate-500">
                  Cancelled days are reversed in the ledger; leave cannot be extended — submit a new
                  request.
                </p>
              </div>
            )}
            <label className="block text-sm font-medium text-slate-700">
              {decision === 'amend' ? 'Reason' : 'Note (optional)'}
              <textarea
                rows={2}
                maxLength={2000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                className={inputClass}
              />
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy}
                className={decision === 'reject' ? dangerButton : primaryButton}
              >
                {busy
                  ? 'Working…'
                  : decision === 'approve'
                    ? 'Confirm approval'
                    : decision === 'reject'
                      ? 'Confirm rejection'
                      : 'Confirm change'}
              </button>
              <button type="button" className={secondaryButton} onClick={() => setDecision(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </Panel>
  );
}
