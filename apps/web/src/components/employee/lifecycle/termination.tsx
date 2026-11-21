'use client';

import { checkboxClass } from '../../ui/tokens';

import { useEffect, useId, useState } from 'react';
import { employeeApi } from '../../../lib/employee/api';
import { formatDateOnly } from '../../../lib/employee/date';
import { employeeLifecycleActionErrorMessage } from '../../../lib/employee/errors';
import { localDateOnly } from '../../../lib/employee/lifecycle';
import {
  isLaterReschedule,
  terminationTiming,
  type TerminationTiming,
} from '../../../lib/employee/termination-timing';
import type {
  EmployeeProfile,
  EmployeeTermination,
  EmployeeTerminationPreview,
  EmployeeTerminationResult,
} from '../../../lib/employee/types';
import { FormDialog } from '../../ui/form-dialog';
import { ErrorState, LoadingText } from '../../ui/states';
import { badgeClass, inputClass, type Tone } from '../../ui/tokens';
import { buttonClass } from '../../ui/button';
import { BlockerList, OffboardingLink } from './assignment-impact-preview';
import {
  choicesValid,
  initialChoices,
  TerminationGrantDecisions,
  TerminationGrantPreview,
  toGrantDecisions,
  type GrantChoices,
} from './termination-grants';

/**
 * Batch 5C — employee termination (Batch 5A contracts).
 *
 * The date is the last day of employment and is inclusive. A date still to come is scheduled:
 * the employee keeps working through it, and each assignment ends once that day has passed in
 * its own time zone. A date already past everywhere applies at once. The reason is restricted:
 * the API returns it only to those who may manage the employee, and this UI shows it only when
 * the API returned it.
 *
 * M3: when the termination applies, the role grants it concerns are revoked unless a request to
 * keep one (reason, at most 30 days) is approved by another administrator. System-level grants
 * need an explicit decision; "Roles and access" collects them with the termination.
 */

const REASON_NOTE =
  'Restricted: visible only to people who manage this employee. Never shown in directories, reports or audit details.';

export function TerminationDialog({
  open,
  profile,
  termination,
  onClose,
  onDone,
}: {
  open: boolean;
  profile: EmployeeProfile;
  /** Set to reschedule this scheduled termination instead of recording a new one. */
  termination?: EmployeeTermination | null;
  onClose(): void;
  onDone(result: EmployeeTerminationResult): void;
}) {
  const rescheduling = Boolean(termination);
  const dateId = useId();
  const reasonId = useId();
  const [date, setDate] = useState(termination?.terminationDate ?? '');
  const [reason, setReason] = useState(termination?.reason ?? '');
  const [grantChoices, setGrantChoices] = useState<GrantChoices>({});
  const [confirmNow, setConfirmNow] = useState(false);
  const [preview, setPreview] = useState<EmployeeTerminationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateError = !date
    ? null
    : date < profile.hireDate
      ? `The last day cannot be before the hire date (${formatDateOnly(profile.hireDate)}).`
      : null;
  const ready = Boolean(date) && !dateError && preview?.terminationDate === date;
  const grantChanges = ready ? (preview?.grantChanges ?? null) : null;
  // D2: per assignment, in its own time zone (conservative when it cannot be determined).
  const timing = ready && preview ? terminationTiming(preview) : null;
  const needsConfirmation = Boolean(timing?.requiresConfirmation);
  // D1: a later last day previews against the current (shortened) end dates; its blockers are
  // advisory (the API checks again on reschedule) and never presented as authoritative.
  const laterReschedule = rescheduling && isLaterReschedule(termination?.terminationDate, date);
  const blocked = ready && preview ? preview.blockers.length > 0 && !laterReschedule : false;
  const canSubmit =
    ready &&
    !blocked &&
    (!grantChanges || choicesValid(grantChanges.grants, grantChoices)) &&
    (!needsConfirmation || confirmNow);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const grantDecisions = grantChanges
        ? toGrantDecisions(grantChanges.grants, grantChoices, grantChanges.keepLimit)
        : [];
      const input = {
        terminationDate: date,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(grantDecisions.length > 0 ? { grantDecisions } : {}),
      };
      const result = termination
        ? await employeeApi.rescheduleTermination(profile.id, termination.id, input)
        : await employeeApi.terminate(profile.id, input);
      onDone(result);
    } catch (cause) {
      setError(employeeLifecycleActionErrorMessage(cause, 'Unable to record the termination.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open={open}
      title={rescheduling ? 'Reschedule termination' : 'Terminate employee'}
      description={
        <>
          The last day of employment is <strong>inclusive</strong>: the employee works through that
          day. Each assignment ends once the day has passed in its own time zone; assignments
          starting later are cancelled. History is kept. When it applies, the role grants in the
          organizations it ends are revoked unless an approved exception keeps one.
        </>
      }
      submitLabel={
        rescheduling
          ? 'Reschedule termination'
          : timing?.kind === 'IMMEDIATE'
            ? 'Terminate now'
            : timing?.kind === 'PARTIAL'
              ? 'Record termination'
              : 'Schedule termination'
      }
      busyLabel={rescheduling ? 'Rescheduling…' : 'Recording…'}
      busy={busy}
      canSubmit={canSubmit}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
      tone="destructive"
      size="lg"
    >
      <div>
        <label htmlFor={dateId} className="block text-sm font-medium text-slate-800">
          Last day of employment
        </label>
        <input
          id={dateId}
          type="date"
          required
          min={profile.hireDate}
          value={date}
          aria-invalid={dateError ? true : undefined}
          aria-describedby={`${dateId}-help${dateError ? ` ${dateId}-error` : ''}`}
          onChange={(event) => {
            setDate(event.target.value);
            setConfirmNow(false);
          }}
          className={inputClass}
        />
        <p id={`${dateId}-help`} className="mt-1 text-xs text-slate-600">
          Inclusive. Today is {formatDateOnly(localDateOnly())} on this device; each assignment uses
          its own time zone.
        </p>
        {dateError && (
          <p id={`${dateId}-error`} className="mt-1 text-sm text-rose-800">
            {dateError}
          </p>
        )}
      </div>
      <div>
        <label htmlFor={reasonId} className="block text-sm font-medium text-slate-800">
          Reason <span className="font-normal text-slate-600">(optional)</span>
        </label>
        <textarea
          id={reasonId}
          rows={2}
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby={`${reasonId}-note`}
          className={inputClass}
        />
        <p id={`${reasonId}-note`} className="mt-1 text-xs text-slate-600">
          {REASON_NOTE}
        </p>
      </div>
      {date && !dateError && (
        <TerminationPreviewPanel
          employeeId={profile.id}
          date={date}
          currentLastDay={rescheduling ? (termination?.terminationDate ?? null) : null}
          onLoaded={(value) => {
            setPreview(value);
            setGrantChoices(
              initialChoices(value?.grantChanges?.grants ?? [], { carryOver: rescheduling }),
            );
            setConfirmNow(false);
          }}
        />
      )}
      {grantChanges && (
        <TerminationGrantDecisions
          changes={grantChanges}
          choices={grantChoices}
          rescheduling={rescheduling}
          onChange={setGrantChoices}
        />
      )}
      {timing && needsConfirmation && !blocked && (
        <label className="flex items-start gap-2 rounded-lg bg-rose-50 p-3 text-sm text-rose-950">
          <input
            type="checkbox"
            checked={confirmNow}
            onChange={(event) => setConfirmNow(event.target.checked)}
            className={`${checkboxClass} mt-0.5`}
          />
          <span>{confirmationText(timing, date)}</span>
        </label>
      )}
    </FormDialog>
  );
}

function assignmentNames(timing: TerminationTiming['immediate']): string {
  return timing.map((a) => `${a.positionName} (${a.organizationName}, ${a.timezone})`).join('; ');
}

/** What the person confirms when anything ends as soon as the termination is recorded. */
export function confirmationText(timing: TerminationTiming, date: string): string {
  const last = formatDateOnly(date);
  if (timing.kind === 'PARTIAL')
    return `${last} has already passed where these assignments are: ${assignmentNames(timing.immediate)}. I understand they end as soon as I confirm; the others keep running through ${last}.`;
  if (timing.uncertain)
    return `This device cannot confirm that ${last} is still to come in every affected time zone. I understand employment may end as soon as I confirm and sign-in sessions may end immediately.`;
  return `${last} has already passed in every affected time zone. I understand employment ends now and sign-in sessions end immediately.`;
}

/** GET …/termination-preview for a date: effects, blockers, follow-ups and access (read-only). */
export function TerminationPreviewPanel({
  employeeId,
  date,
  currentLastDay = null,
  onLoaded,
}: {
  employeeId: string;
  date: string;
  /** Rescheduling: the scheduled termination's current last day. */
  currentLastDay?: string | null;
  onLoaded(preview: EmployeeTerminationPreview | null): void;
}) {
  const [state, setState] = useState<{
    key: string;
    preview: EmployeeTerminationPreview | null;
    error: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${date}:${attempt}`;

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let active = true;
    const timer = window.setTimeout(() => {
      employeeApi
        .terminationPreview(employeeId, date)
        .then((preview) => {
          if (!active) return;
          setState({ key, preview, error: null });
          onLoaded(preview);
        })
        .catch((cause) => {
          if (!active) return;
          setState({
            key,
            preview: null,
            error: employeeLifecycleActionErrorMessage(
              cause,
              'Unable to preview this termination.',
            ),
          });
          onLoaded(null);
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
    // onLoaded only reports the result; a new callback identity must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, date, key]);

  if (!state || state.key !== key) return <LoadingText>Previewing this termination…</LoadingText>;
  if (state.error || !state.preview)
    return (
      <ErrorState
        title="Preview unavailable"
        message={state.error ?? 'Unable to preview this termination.'}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  return <TerminationPreviewView preview={state.preview} currentLastDay={currentLastDay} />;
}

export function TerminationPreviewView({
  preview,
  currentLastDay = null,
  now,
}: {
  preview: EmployeeTerminationPreview;
  /** Rescheduling: the scheduled termination's current last day. */
  currentLastDay?: string | null;
  /** The clock (tests); defaults to now. */
  now?: Date;
}) {
  const timing = terminationTiming(preview, now);
  const laterReschedule = isLaterReschedule(currentLastDay, preview.terminationDate);
  const last = formatDateOnly(preview.terminationDate);
  const endsNow = new Set(timing.immediate.map((a) => a.employmentAssignmentId));
  const followUps: Array<[number | null, string, string]> = [
    [preview.followUps.openTimeEntries, 'open time entry', 'open time entries'],
    [
      preview.followUps.futurePublishedShifts,
      'published shift after the last day',
      'published shifts after the last day',
    ],
    [preview.followUps.pendingLeaveRequests, 'pending leave request', 'pending leave requests'],
    [
      preview.followUps.approvedLeaveAfterTermination,
      'approved leave request after the last day',
      'approved leave requests after the last day',
    ],
    [
      preview.followUps.openBenefitEnrollments,
      'open benefit enrollment',
      'open benefit enrollments',
    ],
    [
      preview.followUps.openPerformanceReviews,
      'open performance review',
      'open performance reviews',
    ],
  ];
  const outstanding = followUps.filter(([count]) => (count ?? 0) > 0);
  return (
    <section
      aria-label="Termination preview"
      className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800"
    >
      {currentLastDay && currentLastDay !== preview.terminationDate && (
        <p>
          Last day moves from <strong>{formatDateOnly(currentLastDay)}</strong> to{' '}
          <strong>{last}</strong>.
        </p>
      )}
      <p className="font-medium text-slate-950">
        {timing.kind === 'SCHEDULED'
          ? `Scheduled: the employee keeps working through ${last}. Nothing ends today.`
          : timing.kind === 'PARTIAL'
            ? `Partly immediate: ${last} has already passed in some time zones. ${timing.immediate.length} assignment${timing.immediate.length === 1 ? ' ends' : 's end'} as soon as this is recorded; the others keep running through ${last}.`
            : timing.uncertain
              ? `Ends now: this device cannot confirm that ${last} is still to come in every affected time zone, so treat employment as ending as soon as this is recorded.`
              : `Immediate: ${last} has already passed in every affected time zone, so employment ends now.`}
      </p>
      {timing.kind !== 'SCHEDULED' && (
        <OpenTimeEntriesWarning count={preview.followUps.openTimeEntries} />
      )}
      {preview.blockers.length > 0 &&
        (laterReschedule ? (
          <BlockerList
            blockers={preview.blockers}
            title="Finalized records found for the current last day"
            description="These were checked against the current, shortened end dates. The API checks again against the recalculated dates when you reschedule, and refuses it if finalized records still conflict."
          />
        ) : (
          <BlockerList blockers={preview.blockers} />
        ))}
      <div>
        <p className="font-medium">Assignments</p>
        {laterReschedule && (
          <p role="note" className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-amber-950">
            Rescheduling restores each assignment&apos;s original end date and then applies the new
            last day, so the end dates are recalculated by the API. They cannot be previewed yet: an
            assignment ends on {last} at the latest, or earlier if it was already due to end.
          </p>
        )}
        {preview.assignments.length === 0 ? (
          <p className="text-slate-600">No assignments are affected.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {preview.assignments.map((assignment) => (
              <li key={assignment.employmentAssignmentId} className="break-words">
                <span className="font-medium">{assignment.positionName}</span> ·{' '}
                {assignment.organizationName}
                {laterReschedule
                  ? ''
                  : `: ${
                      assignment.action === 'CANCEL'
                        ? 'cancelled (it has not started)'
                        : `ends ${formatDateOnly(assignment.newEndDate)}`
                    }`}{' '}
                <span className="text-slate-600">({assignment.timezone})</span>
                {endsNow.has(assignment.employmentAssignmentId) && (
                  <span className="ml-1 font-medium text-rose-800">— ends as soon as recorded</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="font-medium">
          {laterReschedule
            ? `Follow-up in other modules — counted for the current last day (${formatDateOnly(currentLastDay)}); they may change after rescheduling`
            : 'Follow-up in other modules (nothing is changed automatically)'}
        </p>
        {outstanding.length === 0 ? (
          <p className="text-slate-600">None found.</p>
        ) : (
          <ul className="mt-1 list-disc pl-5">
            {outstanding.map(([count, one, many]) => (
              <li key={many}>
                {count} {count === 1 ? one : many}
              </li>
            ))}
          </ul>
        )}
      </div>
      <AccessSummaryText
        access={preview.access}
        scheduled={timing.kind !== 'IMMEDIATE'}
        m3={Boolean(preview.grantChanges)}
      />
      {preview.grantChanges && <TerminationGrantPreview changes={preview.grantChanges} />}
    </section>
  );
}

function AccessSummaryText({
  access,
  scheduled,
  m3,
}: {
  access: EmployeeTerminationPreview['access'];
  scheduled: boolean;
  /** M3: the grant changes are described separately. */
  m3: boolean;
}) {
  if (!access) return <p>The employee has no login.</p>;
  const visible = access.grants.length;
  return (
    <div>
      <p className="font-medium">Sign-in access</p>
      <p>
        {access.activeSessions > 0
          ? `${access.activeSessions} active session${access.activeSessions === 1 ? '' : 's'} ${scheduled ? 'will end once employment ends' : 'end now'}.`
          : 'No active sessions.'}
        {!m3 && (
          <>
            {' '}
            Role grants stay in place ({visible} you can see
            {access.hiddenGrants > 0 ? `, ${access.hiddenGrants} outside your access` : ''}); review
            them in the access review afterwards.
          </>
        )}
      </p>
    </div>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  SCHEDULED: 'warning',
  APPLIED: 'danger',
  CANCELLED: 'neutral',
  SUPERSEDED: 'neutral',
};
const STATUS_LABEL: Record<string, string> = {
  SCHEDULED: 'Scheduled',
  APPLIED: 'Applied',
  CANCELLED: 'Cancelled',
  SUPERSEDED: 'Rescheduled',
};

/**
 * The banner every reader of a profile sees while a termination is scheduled (never the reason).
 * Those who may manage the employee also get reschedule, cancel and — once the last day has
 * passed on this device — apply.
 */
export function ScheduledTerminationBanner({
  profile,
  termination,
  canManage,
  canStartOffboarding,
  onReschedule,
  onCancel,
  onApply,
}: {
  profile: EmployeeProfile;
  termination: EmployeeTermination | null;
  canManage: boolean;
  canStartOffboarding: boolean;
  onReschedule(): void;
  onCancel(): void;
  onApply(): void;
}) {
  const lastDay = profile.terminationDate!;
  const passed = lastDay < localDateOnly();
  // Preselect the primary current assignment when there is one (the form still asks).
  const offboardingAssignment =
    profile.assignments.current.find((assignment) => assignment.isPrimary) ??
    profile.assignments.current[0] ??
    null;
  return (
    <section
      role="status"
      aria-label="Scheduled termination"
      className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950"
    >
      <p className="font-semibold">Termination scheduled: last day {formatDateOnly(lastDay)}</p>
      <p className="mt-1 text-sm">
        {passed
          ? 'The last day has passed on this device. Each assignment ends once it has passed in its own time zone; the termination is applied by an administrator (automatic application is off unless your organization enabled it).'
          : 'The employee keeps working through the last day (inclusive). Each assignment ends once that day has passed in its own time zone. New assignments are refused until then.'}
      </p>
      {(canManage || canStartOffboarding) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {canManage && termination && (
            <>
              <button
                type="button"
                onClick={onReschedule}
                className={buttonClass('secondary', 'sm')}
              >
                Reschedule
              </button>
              <button type="button" onClick={onCancel} className={buttonClass('secondary', 'sm')}>
                Cancel termination
              </button>
              {passed && (
                <button type="button" onClick={onApply} className={buttonClass('danger', 'sm')}>
                  Apply termination
                </button>
              )}
            </>
          )}
          {canStartOffboarding && (
            <OffboardingLink
              employeeId={profile.id}
              organizationId={offboardingAssignment?.organization.id ?? null}
              employmentAssignmentId={offboardingAssignment?.id ?? null}
              plannedEndDate={lastDay}
              label="Review offboarding"
            />
          )}
        </div>
      )}
    </section>
  );
}

/** The append-only termination history; reasons appear only when the API returned them. */
export function TerminationHistory({
  items,
  loading,
  error,
  onRetry,
}: {
  items: EmployeeTermination[];
  loading: boolean;
  error: string | null;
  onRetry(): void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} className="text-lg font-semibold text-slate-900">
        Termination history
      </h3>
      {loading ? (
        <LoadingText>Loading termination history…</LoadingText>
      ) : error ? (
        <ErrorState title="Termination history unavailable" message={error} onRetry={onRetry} />
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-600">No terminations recorded.</p>
      ) : (
        <ol className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-950">
                  Last day {formatDateOnly(item.terminationDate)}
                </span>
                <span className={badgeClass(STATUS_TONE[item.status] ?? 'neutral')}>
                  {STATUS_LABEL[item.status] ?? item.status}
                </span>
              </div>
              <p className="mt-1 text-slate-600">
                Recorded {formatInstant(item.recordedAt)}
                {item.appliedAt ? ` · applied ${formatInstant(item.appliedAt)}` : ''}
                {item.cancelledAt ? ` · cancelled ${formatInstant(item.cancelledAt)}` : ''}
                {item.rehiredAt ? ` · rehired ${formatInstant(item.rehiredAt)}` : ''}
              </p>
              {'reason' in item && item.reason && (
                <p className="mt-1 break-words text-slate-800">
                  <span className="font-medium">Reason (restricted):</span> {item.reason}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function formatInstant(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Cancel a scheduled termination: assignments get their original end dates back. */
export function CancelTerminationDialog({
  open,
  profile,
  termination,
  onClose,
  onDone,
}: {
  open: boolean;
  profile: EmployeeProfile;
  termination: EmployeeTermination;
  onClose(): void;
  onDone(): void;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open={open}
      title="Cancel the scheduled termination?"
      description={`The termination with last day ${formatDateOnly(termination.terminationDate)} is cancelled and each assignment gets its original end date back. The record stays in the history.`}
      submitLabel="Cancel termination"
      busyLabel="Cancelling…"
      cancelLabel="Keep termination"
      busy={busy}
      canSubmit
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await employeeApi.cancelTermination(
            profile.id,
            termination.id,
            reason.trim() ? { reason: reason.trim() } : {},
          );
          onDone();
        } catch (cause) {
          setError(employeeLifecycleActionErrorMessage(cause, 'Unable to cancel the termination.'));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <label htmlFor={reasonId} className="block text-sm font-medium text-slate-800">
          Reason <span className="font-normal text-slate-600">(optional)</span>
        </label>
        <textarea
          id={reasonId}
          rows={2}
          maxLength={1000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={inputClass}
        />
      </div>
    </FormDialog>
  );
}

/**
 * Batch 5E (R3): someone still clocked in when the termination takes effect. Termination never
 * clocks anyone out or awards hours; the entry stays open until a manager closes it with an
 * audited correction (the real clock-out time). Nothing is shown for a count of zero.
 */
export function OpenTimeEntriesWarning({ count }: { count: number }) {
  if (count <= 0) return null;
  const one = count === 1;
  return (
    <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
      <strong>
        {count} open time {one ? 'entry' : 'entries'}: the employee is still clocked in.
      </strong>{' '}
      Terminating does not clock anyone out. {one ? 'It stays' : 'They stay'} open, the timesheet
      cannot be submitted and hourly payroll for the period stays blocked until a manager with
      time-correction access closes {one ? 'it' : 'each one'} with a correction (the real clock-out
      time; audited).
    </p>
  );
}

type OpenEntriesCheck =
  { state: 'loading' } | { state: 'ready'; count: number } | { state: 'unverified' };

/** Apply a due scheduled termination now (the API refuses it while not due anywhere). */
export function ApplyTerminationDialog({
  open,
  profile,
  termination,
  onClose,
  onDone,
}: {
  open: boolean;
  profile: EmployeeProfile;
  termination: EmployeeTermination;
  onClose(): void;
  onDone(result: EmployeeTerminationResult): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Batch 5E: who is still clocked in, from the existing termination preview (the same
  // employee-wide authority as applying). A failed check is said to be unverified, never zero.
  const [openEntries, setOpenEntries] = useState<OpenEntriesCheck>({ state: 'loading' });
  useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setOpenEntries({ state: 'loading' });
      employeeApi
        .terminationPreview(profile.id, termination.terminationDate)
        .then((preview) => {
          if (active) setOpenEntries({ state: 'ready', count: preview.followUps.openTimeEntries });
        })
        .catch(() => {
          if (active) setOpenEntries({ state: 'unverified' });
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, profile.id, termination.terminationDate]);
  return (
    <FormDialog
      open={open}
      title="Apply the termination now?"
      description={`The last day, ${formatDateOnly(termination.terminationDate)}, has passed on this device. Applying ends each assignment whose last day has passed in its own time zone, ends sign-in sessions and marks the employee terminated once every assignment has ended. Then the role grants in the organizations it ends are revoked, except approved keeps; it cannot apply while a System-level role still needs a decision or an approval.`}
      submitLabel="Apply termination"
      busyLabel="Applying…"
      busy={busy}
      // Wait for the open-entry check (a failed check still allows applying).
      canSubmit={openEntries.state !== 'loading'}
      error={error}
      tone="destructive"
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          onDone(await employeeApi.applyTermination(profile.id, termination.id));
        } catch (cause) {
          setError(employeeLifecycleActionErrorMessage(cause, 'Unable to apply the termination.'));
        } finally {
          setBusy(false);
        }
      }}
    >
      {/* One live region: the result of the check is announced when it replaces "Checking…". */}
      <div aria-live="polite" aria-atomic="true">
        {openEntries.state === 'loading' ? (
          <p className="text-sm text-slate-600">Checking for open time entries…</p>
        ) : openEntries.state === 'unverified' ? (
          <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
            Open time entries could not be checked, so this employee may still be clocked in.
            Terminating does not clock anyone out; check the time records before or after applying.
          </p>
        ) : openEntries.count > 0 ? (
          <OpenTimeEntriesWarning count={openEntries.count} />
        ) : (
          <p className="text-sm text-slate-700">No open time entries.</p>
        )}
      </div>
      <p className="text-sm text-slate-700">Nothing else changes in other modules.</p>
    </FormDialog>
  );
}
