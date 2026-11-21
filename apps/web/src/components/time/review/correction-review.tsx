'use client';

import { useCallback, useId, useState } from 'react';
import { timeApi } from '../../../lib/time/api';
import { timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatInstant, label } from '../../../lib/time/format';
import type { TimeCorrection } from '../../../lib/time/types';
import { buttonClass } from '../../ui/button';
import { EmptyState, ErrorState, LoadingState } from '../../ui/states';
import { inputClass } from '../../ui/tokens';
import { useConfirmWithReason } from '../../ui/use-confirm';
import {
  actorLabel,
  DateField,
  LoadMore,
  ReviewPanel,
  useDebounced,
  usePagedList,
  type ReviewOrganization,
  historyQuery,
} from './review-shared';

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'SUPERSEDED'] as const;

const FIELD_LABELS: Record<string, string> = {
  clockInAt: 'Clock in',
  clockOutAt: 'Clock out',
  breakStartAt: 'Break start',
  breakEndAt: 'Break end',
  startAt: 'Start',
  endAt: 'End',
  employmentAssignmentId: 'Assignment',
  targetEmploymentAssignmentId: 'New assignment',
};

function display(value: unknown, timezone: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return formatInstant(value, timezone);
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** What the employee asked for next to what is recorded now. */
export function CorrectionValues({ correction }: { correction: TimeCorrection }) {
  const current =
    correction.currentValues && typeof correction.currentValues === 'object'
      ? (correction.currentValues as Record<string, unknown>)
      : {};
  const requested =
    correction.requestedValues && typeof correction.requestedValues === 'object'
      ? (correction.requestedValues as Record<string, unknown>)
      : {};
  const fields = [...new Set([...Object.keys(current), ...Object.keys(requested)])].filter(
    (field) => field in FIELD_LABELS,
  );
  if (fields.length === 0) return null;
  const assignmentName = (id: unknown) =>
    id === correction.targetEmploymentAssignmentId
      ? correction.targetAssignment?.position.name
      : id === correction.employmentAssignmentId
        ? correction.assignment?.position.name
        : undefined;
  return (
    <table className="mt-2 w-full max-w-xl text-left text-sm">
      <caption className="sr-only">Requested change</caption>
      <thead className="text-xs uppercase text-slate-600">
        <tr>
          <th scope="col" className="py-1 pr-3">
            Field
          </th>
          <th scope="col" className="py-1 pr-3">
            Recorded
          </th>
          <th scope="col" className="py-1">
            Requested
          </th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => {
          const isAssignment = field.toLowerCase().includes('assignment');
          const show = (value: unknown) =>
            isAssignment
              ? (assignmentName(value) ?? display(value, null))
              : display(value, correction.timezone);
          return (
            <tr key={field}>
              <th scope="row" className="py-1 pr-3 font-medium text-slate-700">
                {FIELD_LABELS[field]}
              </th>
              <td className="py-1 pr-3 text-slate-700">{show(current[field])}</td>
              <td className="py-1 font-semibold text-slate-950">{show(requested[field])}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ReviewerNote({
  value,
  onChange,
  correctionId,
}: {
  value: string;
  onChange(value: string): void;
  correctionId: string;
}) {
  const id = useId();
  return (
    <div className="min-w-[14rem] flex-1">
      <label htmlFor={id} className="block text-xs font-medium text-slate-700">
        Reviewer note (optional)
      </label>
      <input
        id={id}
        data-correction={correctionId}
        maxLength={1000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      />
    </div>
  );
}

/**
 * Batch 4E-1 — correction review. Approving applies the change as an adjustment (original
 * punches are kept) and records the reviewer and note; rejecting keeps the time as it was.
 */
export function CorrectionReview({
  organization,
  currentUserId,
  onChanged,
}: {
  organization: ReviewOrganization;
  currentUserId: string | null;
  onChanged?(message: string): void;
}) {
  const canReview = Boolean(organization.actions.canReviewCorrections);
  const [status, setStatus] = useState<string>('PENDING');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirm, dialog] = useConfirmWithReason();
  const statusId = useId();
  const searchId = useId();

  const fetchPage = useCallback(
    (afterId?: string) =>
      timeApi.managementCorrections({
        organizationId: organization.id,
        ...historyQuery(organization),
        ...(status ? { status } : {}),
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
        ...(search ? { search } : {}),
        limit: 25,
        ...(afterId ? { afterId } : {}),
      }),
    [organization, status, startDate, endDate, search],
  );
  const list = usePagedList(fetchPage, 'Unable to load corrections.');

  async function decide(correction: TimeCorrection, decision: 'approve' | 'reject') {
    let note = notes[correction.id]?.trim() ?? '';
    if (decision === 'reject') {
      const given = await confirm({
        title: 'Reject this correction?',
        description:
          'The time record stays as it was, and the employee sees the correction as rejected. A new correction can be requested later.',
        confirmLabel: 'Reject correction',
        reason: { label: 'Reviewer note', defaultValue: note, maxLength: 1000 },
      });
      if (given === null) return;
      note = given;
    }
    setBusy(correction.id);
    setActionError(null);
    setSuccess(null);
    try {
      if (decision === 'approve') {
        await (note
          ? timeApi.approveCorrection(correction.id, note)
          : timeApi.approveCorrection(correction.id));
      } else {
        await (note
          ? timeApi.rejectCorrection(correction.id, note)
          : timeApi.rejectCorrection(correction.id));
      }
      const message = decision === 'approve' ? 'Correction approved.' : 'Correction rejected.';
      setSuccess(message);
      onChanged?.(message);
      await list.reload();
    } catch (cause) {
      setActionError(timeErrorMessage(cause, 'Unable to review this correction.'));
      await list.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <ReviewPanel
      title="Correction queue"
      description="Requested changes to recorded time, with what is recorded now. Approved corrections keep the original punches."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor={statusId} className="block text-sm font-medium text-slate-700">
            Status
          </label>
          <select
            id={statusId}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className={inputClass}
          >
            <option value="">All statuses</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        </div>
        <DateField label="Requested from" value={startDate} onChange={setStartDate} />
        <DateField label="Requested to" value={endDate} onChange={setEndDate} />
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
      {success && (
        <p
          role="status"
          className="mt-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          {success}
        </p>
      )}
      <div className="mt-4 space-y-3">
        {list.loading ? (
          <LoadingState label="Loading corrections…" />
        ) : list.error ? (
          <ErrorState
            title="Corrections could not be loaded"
            message={list.error}
            onRetry={() => void list.reload()}
          />
        ) : list.items.length === 0 ? (
          <EmptyState title="No corrections match these filters." />
        ) : (
          <ul className="space-y-3">
            {list.items.map((correction) => (
              <li key={correction.id}>
                <div
                  role="group"
                  aria-label={`${label(correction.type)} for ${correction.employeeName ?? 'employee'}`}
                  className="rounded-lg border border-slate-200 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-slate-950">
                        {correction.employeeName ?? correction.employeeId} ·{' '}
                        {label(correction.type)}
                      </p>
                      <p className="text-sm text-slate-600">
                        {correction.assignment?.position.name ??
                          correction.targetAssignment?.position.name}
                        {correction.workDate
                          ? ` · work date ${formatDateOnly(correction.workDate)}`
                          : ''}
                        {' · '}requested{' '}
                        {formatInstant(correction.requestedAt, correction.timezone)} by{' '}
                        {actorLabel(correction.actors, correction.requestorUserId, currentUserId)}
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-800">
                      {label(correction.status)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-800">
                    Reason: <span>{correction.reason}</span>
                  </p>
                  <CorrectionValues correction={correction} />
                  {correction.reviewedAt && (
                    <p className="mt-2 text-sm text-slate-700">
                      Reviewed by{' '}
                      {actorLabel(correction.actors, correction.reviewerUserId, currentUserId)} on{' '}
                      {formatInstant(correction.reviewedAt, correction.timezone)}
                      {correction.reviewerNote ? ` · Note: ${correction.reviewerNote}` : ''}
                    </p>
                  )}
                  {canReview && correction.status === 'PENDING' && (
                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      <ReviewerNote
                        correctionId={correction.id}
                        value={notes[correction.id] ?? ''}
                        onChange={(value) =>
                          setNotes((current) => ({ ...current, [correction.id]: value }))
                        }
                      />
                      <button
                        type="button"
                        disabled={busy === correction.id}
                        onClick={() => void decide(correction, 'approve')}
                        className={buttonClass('primary', 'sm')}
                      >
                        Approve{' '}
                        <span className="sr-only">
                          {label(correction.type)} for {correction.employeeName ?? 'employee'}
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={busy === correction.id}
                        onClick={() => void decide(correction, 'reject')}
                        className={buttonClass('danger', 'sm')}
                      >
                        Reject{' '}
                        <span className="sr-only">
                          {label(correction.type)} for {correction.employeeName ?? 'employee'}
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <LoadMore list={list} noun={['correction', 'corrections']} />
      </div>
      {dialog}
    </ReviewPanel>
  );
}
