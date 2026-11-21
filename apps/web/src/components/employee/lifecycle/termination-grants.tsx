'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { employeeApi } from '../../../lib/employee/api';
import { employeeLifecycleActionErrorMessage } from '../../../lib/employee/errors';
import type {
  EmployeeTermination,
  TerminationGrantChanges,
  TerminationGrantDecision,
  TerminationGrantDecisionInput,
  TerminationGrantItem,
  TerminationGrantList,
  TerminationGrantOutcome,
} from '../../../lib/employee/types';
import { buttonClass } from '../../ui/button';
import { FormDialog } from '../../ui/form-dialog';
import { ErrorState, LoadingText } from '../../ui/states';
import { badgeClass, checkboxClass, inputClass, type Tone } from '../../ui/tokens';

/**
 * Security remediation M3 — role grants and employment termination.
 *
 * When a termination applies, the grants it concerns (those in the organizations it ends, and
 * System-level grants) are revoked. A grant can be kept for at most 30 days after the last day,
 * but only as an exception: the request needs a reason and an end date, and another
 * administrator must approve it before the termination applies. An unapproved request is
 * revoked; a System-level grant always needs an explicit decision, and a pending one stops the
 * termination from applying until it is resolved.
 */

export const KEEP_MAX_DAYS = 30;
export const KEEP_REASON_MIN = 10;
export const KEEP_REASON_MAX = 500;
const DAY_MS = 86_400_000;

/**
 * The instant a keep of `days` days after the last day ends. `keepLimit` (from the API) is the end
 * of day 30 in the earliest affected time zone, so counting back stays inside the limit.
 */
export function keepUntilFor(keepLimit: string, days: number): string {
  const limit = new Date(keepLimit).getTime();
  return new Date(limit - (KEEP_MAX_DAYS - days) * DAY_MS).toISOString();
}

export type GrantChoice = {
  /** null: not decided yet (System-level grants); UNCHANGED: keep the recorded decision. */
  choice: 'REVOKE' | 'KEEP' | 'UNCHANGED' | null;
  reason: string;
  days: string;
};

export type GrantChoices = Record<string, GrantChoice>;

/** The starting choices: revoke by default; a System-level grant must be decided. */
export function initialChoices(
  grants: Pick<TerminationGrantItem, 'roleAssignmentId' | 'system'>[],
  options: { carryOver?: boolean } = {},
): GrantChoices {
  return Object.fromEntries(
    grants.map((grant) => [
      grant.roleAssignmentId,
      {
        choice: options.carryOver ? 'UNCHANGED' : grant.system ? null : 'REVOKE',
        reason: '',
        days: String(KEEP_MAX_DAYS),
      },
    ]),
  );
}

export function keepReasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length < KEEP_REASON_MIN)
    return `Give a reason of at least ${KEEP_REASON_MIN} characters (who needs the access, and why).`;
  if (length > KEEP_REASON_MAX) return `Keep the reason to ${KEEP_REASON_MAX} characters.`;
  return null;
}

export function keepDaysError(days: string): string | null {
  const value = Number(days);
  if (!/^\d+$/.test(days.trim()) || value < 1 || value > KEEP_MAX_DAYS)
    return `Enter a whole number of days from 1 to ${KEEP_MAX_DAYS}.`;
  return null;
}

/** Whether every grant has a usable choice. */
export function choicesValid(
  grants: Pick<TerminationGrantItem, 'roleAssignmentId'>[],
  choices: GrantChoices,
): boolean {
  return grants.every((grant) => {
    const entry = choices[grant.roleAssignmentId];
    if (!entry || entry.choice === null) return false;
    if (entry.choice !== 'KEEP') return true;
    return !keepReasonError(entry.reason) && !keepDaysError(entry.days);
  });
}

/**
 * The decisions to send: every System-level choice and every keep request (a revoke of an
 * ordinary grant is the default and needs no record). Unchanged choices are not sent.
 */
export function toGrantDecisions(
  grants: Pick<TerminationGrantItem, 'roleAssignmentId' | 'system'>[],
  choices: GrantChoices,
  keepLimit: string,
  options: { includeRevokes?: boolean } = {},
): TerminationGrantDecisionInput[] {
  const out: TerminationGrantDecisionInput[] = [];
  for (const grant of grants) {
    const entry = choices[grant.roleAssignmentId];
    if (!entry || entry.choice === null || entry.choice === 'UNCHANGED') continue;
    if (entry.choice === 'KEEP')
      out.push({
        roleAssignmentId: grant.roleAssignmentId,
        decision: 'KEEP',
        reason: entry.reason.trim(),
        keepUntil: keepUntilFor(keepLimit, Number(entry.days)),
      });
    else if (grant.system || options.includeRevokes)
      out.push({ roleAssignmentId: grant.roleAssignmentId, decision: 'REVOKE' });
  }
  return out;
}

const OUTCOME: Record<TerminationGrantOutcome, { label: string; tone: Tone }> = {
  REVOKE: { label: 'Revoked when the termination applies', tone: 'danger' },
  KEEP: { label: 'Kept (approved exception)', tone: 'warning' },
  KEEP_PENDING: { label: 'Keep requested: awaiting approval', tone: 'warning' },
  KEEP_INVALID: { label: 'Approval no longer valid: not kept', tone: 'danger' },
  DECISION_REQUIRED: { label: 'Decision required', tone: 'danger' },
  REVOKED: { label: 'Revoked', tone: 'neutral' },
  RETAINED: { label: 'Kept until its end date', tone: 'warning' },
  ALREADY_REVOKED: { label: 'Already revoked', tone: 'neutral' },
};

/** Final M3 change: why an approved keep was not honoured when the termination applied. */
const REVALIDATION_FAILURE: Record<
  NonNullable<TerminationGrantDecision['revalidationFailure']>,
  string
> = {
  APPROVER_NOT_AUTHORIZED:
    'Not kept: the approver could no longer grant this role when the termination applied.',
  ROLE_INELIGIBLE: 'Not kept: the role was archived before the termination applied.',
  KEEP_LIMIT_EXCEEDED: 'Not kept: the keep-until date was past the allowed limit.',
  SELF_APPROVAL: 'Not kept: the approval came from the requester or the departing employee.',
};

export function outcomeLabel(outcome: TerminationGrantOutcome): string {
  return OUTCOME[outcome]?.label ?? outcome;
}

export function formatInstant(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function scopeText(grant: Pick<TerminationGrantItem, 'organizationName' | 'scopeType'>) {
  return `${grant.organizationName ?? 'All organizations'} · ${grant.scopeType
    .toLowerCase()
    .replace(/_/g, ' ')}`;
}

function loginText(changes: { loginWillBeDisabled: boolean | null; otherAccessRemains: boolean }) {
  if (changes.loginWillBeDisabled === null) return null;
  return changes.loginWillBeDisabled
    ? 'Unless a keep is approved, no access remains afterwards, so the login will be disabled and its sessions end.'
    : changes.otherAccessRemains
      ? 'Other access remains (outside this termination), so the login stays enabled; all sessions still end.'
      : 'An approved keep remains, so the login stays enabled until it ends; all sessions still end.';
}

const REQUEST_NOTE =
  'A keep is a request, not an approval: another administrator must approve it before the termination applies. If it is not approved in time, the grant is revoked; for a System-level role, the termination waits instead.';

/**
 * The decision for one grant: revoke (the default), or request to keep it for up to 30 days
 * after the last day, with a reason. System-level grants start undecided.
 */
export function GrantDecisionField({
  grant,
  value,
  keepLimit,
  allowUnchanged = false,
  onChange,
}: {
  grant: TerminationGrantItem;
  value: GrantChoice;
  keepLimit: string;
  /** Rescheduling: keep whatever was recorded (keeps need approval again). */
  allowUnchanged?: boolean;
  onChange(value: GrantChoice): void;
}) {
  const id = useId();
  const reasonError = value.choice === 'KEEP' ? keepReasonError(value.reason) : null;
  const daysError = value.choice === 'KEEP' ? keepDaysError(value.days) : null;
  const until = !daysError ? keepUntilFor(keepLimit, Number(value.days)) : null;
  const option = (choice: GrantChoice['choice'], label: string, help?: string) => (
    <label className="flex items-start gap-2 py-1">
      <input
        type="radio"
        name={`${id}-choice`}
        checked={value.choice === choice}
        onChange={() => onChange({ ...value, choice })}
        className={`${checkboxClass} mt-0.5`}
      />
      <span>
        {label}
        {help && <span className="block text-xs text-slate-600">{help}</span>}
      </span>
    </label>
  );
  return (
    <fieldset className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <legend className="px-1 font-medium text-slate-950">
        {grant.roleName}
        {grant.system && <span className={`${badgeClass('danger')} ml-2`}>System-level</span>}
      </legend>
      <p className="break-words text-slate-600">
        {scopeText(grant)}
        {grant.expiresAt ? ` · expires ${formatInstant(grant.expiresAt)}` : ''}
      </p>
      {grant.system && value.choice === null && (
        <p className="mt-1 text-xs font-medium text-rose-800">
          Required: decide whether this System-level role is revoked or kept.
        </p>
      )}
      <div className="mt-1">
        {allowUnchanged && option('UNCHANGED', 'Keep the recorded decision')}
        {option('REVOKE', 'Revoke when the termination applies')}
        {option(
          'KEEP',
          'Request to keep it for a limited time',
          grant.system
            ? 'Another System administrator must approve; until then the termination cannot apply.'
            : 'Another administrator must approve; otherwise it is revoked.',
        )}
      </div>
      {value.choice === 'KEEP' && (
        <div className="mt-2 space-y-2 border-l-2 border-amber-300 pl-3">
          <div>
            <label htmlFor={`${id}-reason`} className="block font-medium text-slate-800">
              Reason for keeping it
            </label>
            <textarea
              id={`${id}-reason`}
              rows={2}
              required
              maxLength={KEEP_REASON_MAX}
              value={value.reason}
              aria-invalid={reasonError && value.reason ? true : undefined}
              aria-describedby={`${id}-reason-help`}
              onChange={(event) => onChange({ ...value, reason: event.target.value })}
              className={inputClass}
            />
            <p id={`${id}-reason-help`} className="mt-1 text-xs text-slate-600">
              {reasonError && value.reason
                ? reasonError
                : `Required, ${KEEP_REASON_MIN}–${KEEP_REASON_MAX} characters. Stored with the request and shown to reviewers; do not include the termination reason.`}
            </p>
          </div>
          <div>
            <label htmlFor={`${id}-days`} className="block font-medium text-slate-800">
              Keep for how many days after the last day
            </label>
            <input
              id={`${id}-days`}
              type="number"
              inputMode="numeric"
              min={1}
              max={KEEP_MAX_DAYS}
              required
              value={value.days}
              aria-invalid={daysError ? true : undefined}
              aria-describedby={`${id}-days-help`}
              onChange={(event) => onChange({ ...value, days: event.target.value })}
              className={`${inputClass} max-w-32`}
            />
            <p id={`${id}-days-help`} className="mt-1 text-xs text-slate-600">
              {daysError
                ? daysError
                : `Ends ${formatInstant(until)} at the latest (end of that day in the earliest affected time zone), or sooner if the grant already expires earlier. At most ${KEEP_MAX_DAYS} days.`}
            </p>
          </div>
        </div>
      )}
    </fieldset>
  );
}

/**
 * The "Roles and access" part of the termination dialog: a decision per grant the termination
 * concerns (from the preview). Nothing is recorded until the termination is submitted.
 */
export function TerminationGrantDecisions({
  changes,
  choices,
  rescheduling = false,
  onChange,
}: {
  changes: TerminationGrantChanges;
  choices: GrantChoices;
  rescheduling?: boolean;
  onChange(choices: GrantChoices): void;
}) {
  const headingId = useId();
  const login = loginText(changes);
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-base font-semibold text-slate-950">
        Roles and access
      </h3>
      {changes.grants.length === 0 ? (
        <p className="text-sm text-slate-700">
          No role grants in the organizations this termination ends.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-700">
            When the termination applies, these grants are revoked unless a request to keep one is
            approved.{' '}
            {rescheduling && 'Recorded decisions carry over; kept grants need approval again.'}
          </p>
          <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
            {REQUEST_NOTE}
          </p>
          {changes.decisionsRequired.length > 0 && !rescheduling && (
            <p className="text-sm text-slate-800">
              {changes.decisionsRequired.length} System-level grant
              {changes.decisionsRequired.length === 1 ? ' needs' : 's need'} an explicit decision by
              a System administrator.
            </p>
          )}
          <div className="space-y-2">
            {changes.grants.map((grant) => (
              <GrantDecisionField
                key={grant.roleAssignmentId}
                grant={grant}
                keepLimit={changes.keepLimit}
                allowUnchanged={rescheduling}
                value={
                  choices[grant.roleAssignmentId] ?? {
                    choice: grant.system ? null : 'REVOKE',
                    reason: '',
                    days: String(KEEP_MAX_DAYS),
                  }
                }
                onChange={(value) => onChange({ ...choices, [grant.roleAssignmentId]: value })}
              />
            ))}
          </div>
        </>
      )}
      {login && <p className="text-sm text-slate-800">{login}</p>}
    </section>
  );
}

/** Read-only: what the termination would do with the grants (part of the preview). */
export function TerminationGrantPreview({ changes }: { changes: TerminationGrantChanges }) {
  const login = loginText(changes);
  return (
    <div>
      <p className="font-medium">Roles and access</p>
      {changes.grants.length === 0 ? (
        <p className="text-slate-600">No role grants in the organizations this termination ends.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {changes.grants.map((grant) => (
            <li key={grant.roleAssignmentId} className="break-words">
              <span className="font-medium">{grant.roleName}</span> · {scopeText(grant)}:{' '}
              {grant.system ? 'System-level, needs a decision' : 'revoked when it applies'}
            </li>
          ))}
        </ul>
      )}
      {login && <p className="mt-1">{login}</p>}
    </div>
  );
}

type Review = {
  action: 'approve' | 'reject' | 'cancel';
  grant: TerminationGrantList['grants'][number];
};

/**
 * A scheduled termination's grants, for those who manage the employee: the decision and status
 * of each, approval of keep requests (never by the person who requested it), and changes.
 */
export function TerminationGrantsPanel({
  employeeId,
  termination,
  viewerUserId,
  onChanged,
}: {
  employeeId: string;
  termination: EmployeeTermination;
  /** The signed-in user (null when unknown: the API decides). */
  viewerUserId: string | null;
  onChanged?(): void;
}) {
  const headingId = useId();
  const [list, setList] = useState<TerminationGrantList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [editing, setEditing] = useState<TerminationGrantList['grants'][number] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setList(await employeeApi.terminationGrants(employeeId, termination.id));
    } catch (cause) {
      setError(employeeLifecycleActionErrorMessage(cause, 'Unable to load the role decisions.'));
    } finally {
      setLoading(false);
    }
  }, [employeeId, termination.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const done = (message: string, value: TerminationGrantList) => {
    setReview(null);
    setEditing(null);
    setList(value);
    setNotice(message);
    onChanged?.();
  };

  return (
    <section
      aria-labelledby={headingId}
      className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-base font-semibold text-slate-950">
          Roles and access at termination
        </h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className={buttonClass('ghost', 'sm')}
        >
          Refresh
        </button>
      </div>
      {notice && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">
          {notice}
        </p>
      )}
      {loading && !list ? (
        <LoadingText>Loading role decisions…</LoadingText>
      ) : error ? (
        <ErrorState
          title="Role decisions unavailable"
          message={error}
          onRetry={() => void load()}
        />
      ) : list ? (
        <>
          {list.blocking.length > 0 && (
            <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-rose-950">
              <strong>The termination cannot apply yet.</strong> {list.blocking.length} System-level
              grant
              {list.blocking.length === 1 ? ' needs' : 's need'} a decision or an approval by a
              System administrator.
              {list.blocking.some((b) => b.code === 'TERMINATION_KEEP_APPROVAL_INVALID') && (
                <>
                  {' '}
                  An earlier approval is no longer valid (its approver can no longer grant the role,
                  or the role changed): change the decision and have an eligible System
                  administrator approve it again.
                </>
              )}
            </p>
          )}
          {list.grants.length === 0 ? (
            <p className="text-slate-700">
              No role grants in the organizations this termination ends.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {list.grants.map((grant) => {
                const decision = grant.decision;
                const pendingKeep =
                  decision?.decision === 'KEEP' && decision.status === 'REQUESTED';
                const ownRequest =
                  pendingKeep &&
                  viewerUserId !== null &&
                  decision.requestedByUserId === viewerUserId;
                const outcome = OUTCOME[grant.outcome];
                return (
                  <li key={grant.roleAssignmentId} className="space-y-1 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-words font-medium text-slate-950">
                          {grant.roleName}
                          {grant.system && (
                            <span className={`${badgeClass('danger')} ml-2`}>System-level</span>
                          )}
                        </p>
                        <p className="break-words text-slate-600">{scopeText(grant)}</p>
                      </div>
                      <span className={badgeClass(outcome?.tone ?? 'neutral')}>
                        {outcomeLabel(grant.outcome)}
                      </span>
                    </div>
                    {decision?.decision === 'KEEP' && decision.status !== 'CANCELLED' && (
                      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-slate-700 sm:grid-cols-2">
                        <div>
                          <dt className="inline font-medium">Requested by: </dt>
                          <dd className="inline">
                            {decision.requestedByName ?? 'Unknown'} ·{' '}
                            {formatInstant(decision.requestedAt)}
                          </dd>
                        </div>
                        <div>
                          <dt className="inline font-medium">Keep until: </dt>
                          <dd className="inline">{formatInstant(decision.keepUntil)}</dd>
                        </div>
                        <div className="sm:col-span-2">
                          <dt className="inline font-medium">Reason: </dt>
                          <dd className="inline break-words">{decision.reason}</dd>
                        </div>
                        <div className="sm:col-span-2">
                          <dt className="inline font-medium">Approval: </dt>
                          <dd className="inline">
                            {decision.status === 'REQUESTED'
                              ? 'Waiting for another administrator'
                              : `${decision.status === 'APPROVED' ? 'Approved' : 'Rejected'} by ${
                                  decision.reviewedByName ?? 'Unknown'
                                } · ${formatInstant(decision.reviewedAt)}${
                                  decision.reviewNote ? ` — ${decision.reviewNote}` : ''
                                }`}
                          </dd>
                        </div>
                      </dl>
                    )}
                    {decision?.revalidationFailure && (
                      <p className="text-sm text-red-800">
                        {REVALIDATION_FAILURE[decision.revalidationFailure] ??
                          'Not kept: the approval was no longer valid when the termination applied.'}
                      </p>
                    )}
                    {ownRequest && (
                      <p className="text-xs text-slate-600">
                        You requested this exception: another administrator must approve or reject
                        it.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {pendingKeep && !ownRequest && (
                        <>
                          <button
                            type="button"
                            onClick={() => setReview({ action: 'approve', grant })}
                            className={buttonClass('secondary', 'sm')}
                          >
                            Approve keep
                          </button>
                          <button
                            type="button"
                            onClick={() => setReview({ action: 'reject', grant })}
                            className={buttonClass('secondary', 'sm')}
                          >
                            Reject keep
                          </button>
                        </>
                      )}
                      {pendingKeep && (
                        <button
                          type="button"
                          onClick={() => setReview({ action: 'cancel', grant })}
                          className={buttonClass('ghost', 'sm')}
                        >
                          Withdraw request
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditing(grant)}
                        className={buttonClass('ghost', 'sm')}
                      >
                        Change decision
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {loginText(list) && <p className="text-slate-800">{loginText(list)}</p>}
        </>
      ) : null}
      {review && review.grant.decision && (
        <ReviewKeepDialog
          employeeId={employeeId}
          terminationId={termination.id}
          review={review}
          onClose={() => setReview(null)}
          onDone={(value) =>
            done(
              review.action === 'approve'
                ? 'Keep approved. The grant is kept until its end date when the termination applies.'
                : review.action === 'reject'
                  ? 'Keep rejected. The grant is revoked when the termination applies.'
                  : 'Request withdrawn.',
              value,
            )
          }
        />
      )}
      {editing && list && (
        <ChangeDecisionDialog
          employeeId={employeeId}
          terminationId={termination.id}
          grant={editing}
          keepLimit={list.keepLimit}
          onClose={() => setEditing(null)}
          onDone={(value) => done('Decision recorded.', value)}
        />
      )}
    </section>
  );
}

function ReviewKeepDialog({
  employeeId,
  terminationId,
  review,
  onClose,
  onDone,
}: {
  employeeId: string;
  terminationId: string;
  review: Review;
  onClose(): void;
  onDone(value: TerminationGrantList): void;
}) {
  const noteId = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decision = review.grant.decision!;
  const title =
    review.action === 'approve'
      ? `Approve keeping ${review.grant.roleName}?`
      : review.action === 'reject'
        ? `Reject keeping ${review.grant.roleName}?`
        : `Withdraw the request to keep ${review.grant.roleName}?`;
  return (
    <FormDialog
      open
      title={title}
      description={
        review.action === 'approve'
          ? `When the termination applies, the grant is kept until ${formatInstant(decision.keepUntil)} (or its own earlier expiry) and then ends. Your approval is recorded in the audit log.`
          : review.action === 'reject'
            ? 'The grant is revoked when the termination applies. Your decision is recorded in the audit log.'
            : 'The request is closed and the grant is revoked when the termination applies, unless a new decision is recorded.'
      }
      submitLabel={
        review.action === 'approve'
          ? 'Approve keep'
          : review.action === 'reject'
            ? 'Reject keep'
            : 'Withdraw request'
      }
      busyLabel="Saving…"
      busy={busy}
      canSubmit
      error={error}
      tone={review.action === 'approve' ? 'primary' : 'destructive'}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          onDone(
            await employeeApi.reviewGrantKeep(
              employeeId,
              terminationId,
              decision.id,
              review.action,
              note,
            ),
          );
        } catch (cause) {
          setError(employeeLifecycleActionErrorMessage(cause, 'Unable to save this decision.'));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="space-y-1 text-sm text-slate-800">
        <p>
          Requested by {decision.requestedByName ?? 'Unknown'}: {decision.reason}
        </p>
        <p>Keep until {formatInstant(decision.keepUntil)}</p>
      </div>
      {review.action !== 'cancel' && (
        <div>
          <label htmlFor={noteId} className="block text-sm font-medium text-slate-800">
            Note <span className="font-normal text-slate-600">(optional)</span>
          </label>
          <textarea
            id={noteId}
            rows={2}
            maxLength={KEEP_REASON_MAX}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className={inputClass}
          />
        </div>
      )}
    </FormDialog>
  );
}

function ChangeDecisionDialog({
  employeeId,
  terminationId,
  grant,
  keepLimit,
  onClose,
  onDone,
}: {
  employeeId: string;
  terminationId: string;
  grant: TerminationGrantItem;
  keepLimit: string;
  onClose(): void;
  onDone(value: TerminationGrantList): void;
}) {
  const [choices, setChoices] = useState<GrantChoices>(() => ({
    [grant.roleAssignmentId]: { choice: null, reason: '', days: String(KEEP_MAX_DAYS) },
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      title={`Decide about ${grant.roleName}`}
      description={REQUEST_NOTE}
      submitLabel="Record decision"
      busyLabel="Recording…"
      busy={busy}
      canSubmit={choicesValid([grant], choices)}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          onDone(
            await employeeApi.recordGrantDecisions(
              employeeId,
              terminationId,
              toGrantDecisions([grant], choices, keepLimit, { includeRevokes: true }),
            ),
          );
        } catch (cause) {
          setError(employeeLifecycleActionErrorMessage(cause, 'Unable to record the decision.'));
        } finally {
          setBusy(false);
        }
      }}
    >
      <GrantDecisionField
        grant={grant}
        keepLimit={keepLimit}
        value={choices[grant.roleAssignmentId]!}
        onChange={(value) => setChoices({ [grant.roleAssignmentId]: value })}
      />
    </FormDialog>
  );
}
