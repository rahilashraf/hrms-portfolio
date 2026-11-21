'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { buttonClass } from '../ui/button';
import { ErrorState, LoadingText } from '../ui/states';
import { useConfirm } from '../ui/use-confirm';
import { schedulingApi } from '../../lib/scheduling/api';
import { schedulingErrorMessage } from '../../lib/scheduling/errors';
import type { GridShift, ShiftRevision } from '../../lib/scheduling/types';
import { formatDay, formatDuration, formatTime } from '../../lib/scheduling/time';
import {
  Feedback,
  RequiredReason,
  ScheduleStatusBadge,
  ShiftStatusBadge,
} from './scheduling-shared';

const REVISION_LABELS: Record<ShiftRevision['revisionType'], string> = {
  PUBLISHED_BASELINE: 'Published',
  CORRECTED: 'Corrected',
  CANCELLED: 'Cancelled',
};

/**
 * One shift: its details, the actions the API allows on it (draft edit/delete, published
 * correct/cancel), the published revision history and a link to its audit records.
 */
export function ShiftDetail({
  shift,
  organizationId,
  canReadAudit,
  onEdit,
  onCorrect,
  onChanged,
  onClose,
}: {
  shift: GridShift;
  organizationId: string;
  canReadAudit: boolean;
  onEdit(shift: GridShift): void;
  onCorrect(shift: GridShift): void;
  onChanged(message: string): void;
  onClose(): void;
}) {
  const [revisions, setRevisions] = useState<ShiftRevision[] | null>(null);
  const [revisionsError, setRevisionsError] = useState<string | null>(null);
  const [revisionsAttempt, setRevisionsAttempt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const published = shift.schedule.status === 'PUBLISHED';

  useEffect(() => {
    if (!published) return;
    let active = true;
    const timer = window.setTimeout(() => {
      schedulingApi
        .revisions(shift.scheduleId, shift.id)
        .then((result) => {
          if (!active) return;
          setRevisionsError(null);
          setRevisions(result.items);
        })
        .catch((cause) => {
          if (active) {
            setRevisionsError(
              schedulingErrorMessage(cause, 'The revision history could not be loaded.'),
            );
          }
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [published, shift.scheduleId, shift.id, shift.currentRevision?.id, revisionsAttempt]);

  function retryRevisions() {
    setRevisionsError(null);
    setRevisions(null);
    setRevisionsAttempt((attempt) => attempt + 1);
  }

  async function remove() {
    if (
      !(await confirm({
        title: 'Delete this draft shift?',
        description:
          'The shift is removed from the draft schedule. Published shifts cannot be deleted.',
        confirmLabel: 'Delete shift',
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await schedulingApi.deleteShift(shift.scheduleId, shift.id);
      onChanged('Draft shift deleted.');
    } catch (cause) {
      setError(schedulingErrorMessage(cause, 'The shift could not be deleted.'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim()) {
      setError('A reason is required to cancel a published shift.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await schedulingApi.cancelShift(shift.scheduleId, shift.id, reason.trim());
      onChanged('Published shift cancelled; the cancellation is in its revision history.');
    } catch (cause) {
      setError(schedulingErrorMessage(cause, 'The shift could not be cancelled.'));
    } finally {
      setBusy(false);
    }
  }

  const time = `${formatTime(shift.startsAt, shift.timezone)}–${formatTime(shift.endsAt, shift.timezone)}`;
  const auditHref = `/admin/audit?organizationId=${encodeURIComponent(organizationId)}&entityType=ScheduledShift&entityId=${encodeURIComponent(shift.id)}`;
  return (
    <section
      aria-label="Shift details"
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      {confirmDialog}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-950">
            {shift.employee.displayName ?? shift.employee.employeeNumber}
            <span className="ml-2 text-sm font-normal text-slate-500">
              #{shift.employee.employeeNumber}
            </span>
          </h3>
          <p className="text-sm text-slate-700">
            {formatDay(shift.workDate, 'long')} · {time} ({formatDuration(shift.durationMinutes)}) ·{' '}
            {shift.timezone}
          </p>
        </div>
        <button type="button" onClick={onClose} className={buttonClass('ghost', 'sm')}>
          Close
        </button>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase text-slate-500">Assignment</dt>
          <dd>
            {shift.assignment.position.name} · {shift.assignment.organization.name}
            {shift.assignment.isPrimary && ' (primary)'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase text-slate-500">Work location</dt>
          <dd>{shift.workLocation?.name ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase text-slate-500">Schedule</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {shift.schedule.name} <ScheduleStatusBadge status={shift.schedule.status} />
            <ShiftStatusBadge status={shift.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase text-slate-500">Source</dt>
          <dd>{shift.sourceType === 'PATTERN' ? 'Recurring pattern' : 'Manual'}</dd>
        </div>
      </dl>
      <Feedback error={error} success={null} />
      <div className="flex flex-wrap gap-2">
        {shift.actions.canEditDraft && (
          <button
            type="button"
            className={buttonClass('secondary', 'sm')}
            onClick={() => onEdit(shift)}
          >
            Edit
          </button>
        )}
        {shift.actions.canDeleteDraft && (
          <button
            type="button"
            disabled={busy}
            className={buttonClass('destructive', 'sm')}
            onClick={() => void remove()}
          >
            Delete
          </button>
        )}
        {shift.actions.canCorrect && (
          <button
            type="button"
            className={buttonClass('secondary', 'sm')}
            onClick={() => onCorrect(shift)}
          >
            Correct
          </button>
        )}
        {shift.actions.canCancel && !cancelling && (
          <button
            type="button"
            className={buttonClass('destructive', 'sm')}
            onClick={() => setCancelling(true)}
          >
            Cancel shift
          </button>
        )}
        {canReadAudit && (
          <Link href={auditHref} className={buttonClass('ghost', 'sm')}>
            Audit records
          </Link>
        )}
      </div>
      {!published && shift.sourceType === 'PATTERN' && (
        <p className="text-xs text-slate-500">
          Generated by a recurring pattern: change the pattern and regenerate, or publish and
          correct.
        </p>
      )}
      {cancelling && (
        <form
          onSubmit={cancel}
          aria-label="Cancel published shift"
          className="space-y-2 rounded-lg border border-rose-200 bg-rose-50 p-3"
        >
          <p className="text-sm text-rose-900">
            Cancelling is final: the shift stays in the schedule as cancelled, with this reason in
            its history.
          </p>
          <RequiredReason value={reason} onChange={setReason} />
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={buttonClass('destructive', 'sm')}>
              Cancel shift
            </button>
            <button
              type="button"
              className={buttonClass('ghost', 'sm')}
              onClick={() => setCancelling(false)}
            >
              Keep shift
            </button>
          </div>
        </form>
      )}
      {published && (
        <div>
          <h4 className="text-sm font-semibold text-slate-900">Revision history</h4>
          {revisionsError ? (
            <div className="mt-2">
              <ErrorState
                title="Revision history unavailable"
                message={revisionsError}
                onRetry={retryRevisions}
              />
            </div>
          ) : revisions === null ? (
            <LoadingText>Loading revisions…</LoadingText>
          ) : revisions.length === 0 ? (
            <p className="text-sm text-slate-600">No revisions recorded.</p>
          ) : (
            <ol className="mt-2 space-y-2 border-l-2 border-slate-200 pl-3 text-sm">
              {revisions.map((revision) => (
                <li key={revision.id}>
                  <p className="font-medium text-slate-900">
                    #{revision.revisionNumber} {REVISION_LABELS[revision.revisionType]} ·{' '}
                    {new Date(revision.changedAt).toLocaleString()}
                  </p>
                  <p className="text-slate-700">
                    {revision.workDate} {formatTime(revision.startsAt, revision.timezone)}–
                    {formatTime(revision.endsAt, revision.timezone)}
                    {revision.status === 'CANCELLED' && ' · cancelled'}
                  </p>
                  {revision.reason && <p className="text-slate-600">Reason: {revision.reason}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
