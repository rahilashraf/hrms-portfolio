'use client';

import { useEffect, useId, useState } from 'react';
import { schedulingApi } from '../../../lib/scheduling/api';
import type { GridShift } from '../../../lib/scheduling/types';
import { timeApi } from '../../../lib/time/api';
import { timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatInstant } from '../../../lib/time/format';
import type { TimeEntryRead } from '../../../lib/time/types';
import { FormDialog, ReasonField } from './entry-dialogs';

/**
 * Batch 4F (Q8) — link a time entry to one of its assignment's published shifts, re-link it, or
 * unlink it, with a reason (POST /time/entries/:id/scheduled-shift; time.correct, never one's own
 * time, never approved or locked time). The candidates are the assignment's ACTIVE published
 * shifts from the day before to the day after the entry's work date (GET /scheduling, which
 * needs schedule read access); without that access only unlinking is offered.
 */

const UNLINK = '__unlink__';

/** YYYY-MM-DD shifted by whole days (calendar arithmetic, no time zone). */
function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function shiftLabel(shift: GridShift): string {
  const end = new Intl.DateTimeFormat('en-US', {
    timeStyle: 'short',
    timeZone: shift.timezone || 'UTC',
  }).format(new Date(shift.endsAt));
  return `${formatInstant(shift.startsAt, shift.timezone)} – ${end} · ${shift.assignment.position.name}`;
}

export function LinkShiftDialog({
  entry,
  organizationId,
  onClose,
  onDone,
}: {
  entry: TimeEntryRead | null;
  organizationId: string;
  onClose(): void;
  onDone(message: string): void;
}) {
  // Keyed by entry: every opening starts from that entry's own link.
  return entry ? (
    <LinkShiftForm
      key={entry.id}
      entry={entry}
      organizationId={organizationId}
      onClose={onClose}
      onDone={onDone}
    />
  ) : null;
}

function LinkShiftForm({
  entry,
  organizationId,
  onClose,
  onDone,
}: {
  entry: TimeEntryRead;
  organizationId: string;
  onClose(): void;
  onDone(message: string): void;
}) {
  const linked = entry.scheduledShiftId ?? null;
  const [shifts, setShifts] = useState<GridShift[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [choice, setChoice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();

  useEffect(() => {
    let active = true;
    schedulingApi
      .grid({
        organizationId,
        from: addDays(entry.workDate, -1),
        to: addDays(entry.workDate, 1),
        employmentAssignmentId: entry.employmentAssignmentId,
        status: 'ACTIVE',
        scheduleStatus: 'PUBLISHED',
        limit: 50,
      })
      .then((result) => {
        if (!active) return;
        setShifts(result.items);
        setListError(null);
      })
      .catch(() => {
        if (!active) return;
        setShifts([]);
        setListError(
          'Published shifts could not be listed (schedule access is needed to see them).',
        );
      });
    return () => {
      active = false;
    };
  }, [organizationId, entry.workDate, entry.employmentAssignmentId]);

  async function submit() {
    setBusy(true);
    setError(null);
    const scheduledShiftId = choice === UNLINK ? null : choice;
    try {
      const result = await timeApi.linkScheduledShift(entry.id, {
        scheduledShiftId,
        reason: reason.trim(),
      });
      onDone(
        !result.changed
          ? 'Nothing changed: the entry already had this shift link.'
          : scheduledShiftId === null
            ? 'Entry unlinked from its scheduled shift.'
            : 'Shift link updated.',
      );
    } catch (cause) {
      setError(timeErrorMessage(cause, 'Unable to change the shift link.'));
    } finally {
      setBusy(false);
    }
  }

  const options: Array<{ value: string; label: string }> = [
    ...(shifts ?? []).map((shift) => ({
      value: shift.id,
      label: `${shiftLabel(shift)}${shift.id === linked ? ' (current link — re-link to its latest version)' : ''}`,
    })),
    ...(linked ? [{ value: UNLINK, label: 'Unlink: no scheduled shift' }] : []),
  ];
  const linkedListed = linked !== null && (shifts ?? []).some((shift) => shift.id === linked);

  return (
    <FormDialog
      open
      title={linked ? 'Change shift link' : 'Link shift'}
      description={
        <>
          {entry.employeeName} · {entry.assignment.position.name} · work date{' '}
          {formatDateOnly(entry.workDate)}, {formatInstant(entry.clockInAt, entry.timezone)}. The
          entry’s times are not changed; lateness and unscheduled-work signals are worked out again
          against the chosen shift.
        </>
      }
      submitLabel={choice === UNLINK ? 'Unlink shift' : 'Save shift link'}
      busy={busy}
      canSubmit={choice !== '' && reason.trim() !== ''}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      {linked && !linkedListed && shifts !== null && (
        <p className="text-sm text-slate-700">
          This entry is linked to a shift that is not listed here (cancelled, or outside these
          dates).
        </p>
      )}
      {shifts === null ? (
        <p role="status" className="text-sm text-slate-600">
          Loading published shifts…
        </p>
      ) : (
        <>
          {listError && (
            <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
              {listError}
            </p>
          )}
          {options.length === 0 ? (
            <p className="text-sm text-slate-700">
              No published shift of this assignment around {formatDateOnly(entry.workDate)} can be
              linked.
            </p>
          ) : (
            <fieldset>
              <legend className="text-sm font-medium text-slate-800">Shift</legend>
              <div className="mt-2 space-y-2">
                {options.map((option) => (
                  <label
                    key={option.value}
                    className="flex items-start gap-2 rounded-md border border-slate-200 p-2 text-sm text-slate-900"
                  >
                    <input
                      type="radio"
                      name={name}
                      value={option.value}
                      checked={choice === option.value}
                      onChange={() => {
                        setChoice(option.value);
                        setError(null);
                      }}
                      className="mt-0.5"
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </>
      )}
      <ReasonField value={reason} onChange={setReason} />
    </FormDialog>
  );
}
