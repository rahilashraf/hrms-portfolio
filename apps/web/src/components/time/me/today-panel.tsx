'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { attendanceApi } from '../../../lib/attendance/api';
import { todayIn } from '../../../lib/scheduling/time';
import { timeApi } from '../../../lib/time/api';
import { timeErrorCode, timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatInstant, label } from '../../../lib/time/format';
import type {
  AssignmentCapability,
  ClockInShiftOption,
  ExpectedAttendanceItem,
  SignInOption,
  TimeActionWarning,
  TimeStatus,
} from '../../../lib/time/types';
import type { EmployeeAssignmentView } from '../../../lib/employee/types';
import { ErrorBanner, FeedbackMessage } from '../../organization/shared';
import { InlineMessage } from '../../ui/inline-message';
import { attendanceWarningText } from '../../../lib/time/warnings';
import { buttonClass } from '../../ui/button';
import { checkboxClass, inputClass } from '../../ui/tokens';
import { isReadOnly, ReadOnlyBadge, TruncatedRecordsNotice } from '../time-notices';
import {
  KioskOnlyNotice,
  OwnPinPanel,
  usesKiosk as usesKioskModes,
} from '../attendance-self-service';
import {
  assignmentName,
  ExpectedBadge,
  interactionKey,
  openMyTime,
  Section,
  shiftDate,
  timeIn,
} from './shared';

/**
 * Batch 4E-3 — Today: what the employee can record now, per assignment, exactly as the API
 * offers it (status actions; KIOSK_ONLY work is never captured here), the presence occurrences
 * open for confirmation, optional sign-out where enabled, and today's scheduled shifts.
 */
export function TodayPanel({
  status,
  onChanged,
}: {
  status: TimeStatus;
  /** Reload the status after an action (the API's answer is the truth). */
  onChanged(): Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Batch 4F (D2): the API asked for an explicit occurrence (several open, one signed in).
  const [choiceRequired, setChoiceRequired] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  async function act(key: string, action: () => Promise<ActResult>) {
    if (busy) return;
    setBusy(key);
    setError(null);
    setSuccess(null);
    setWarnings([]);
    setChoiceRequired(false);
    try {
      const result = await action();
      await onChanged();
      if (typeof result === 'string') {
        setSuccess(result);
      } else {
        setSuccess(result.message);
        // R4-A.3: recorded, but flagged (e.g. work with no published shift).
        setWarnings((result.warnings ?? []).map(attendanceWarningText));
      }
    } catch (cause) {
      const code = timeErrorCode(cause);
      if (code === 'ATTENDANCE_OCCURRENCE_CHOICE_REQUIRED') {
        // The refreshed status lists every open occurrence, each with its own button.
        await onChanged().catch(() => undefined);
        setChoiceRequired(true);
        setError(timeErrorMessage(cause));
      } else if (code === 'SCHEDULED_SHIFT_SELECTION_REQUIRED') {
        await onChanged().catch(() => undefined);
        setError(
          'Several scheduled shifts are open right now. Choose the shift you are starting, then try again.',
        );
      } else {
        if (code === 'SCHEDULED_SHIFT_NOT_ELIGIBLE') await onChanged().catch(() => undefined);
        setError(timeErrorMessage(cause, 'Unable to complete this time action.'));
      }
    } finally {
      setBusy(null);
    }
  }

  const capabilities = status.assignmentCapabilities ?? [];
  // An API without capabilities (older than Batch 4E-3): the attendance modes explain kiosk work.
  const legacy = status.assignmentCapabilities === undefined;
  const usesKiosk = legacy
    ? usesKioskModes(status)
    : capabilities.some(
        (item) => item.captureMode === 'KIOSK_ONLY' || item.captureMode === 'KIOSK_OR_SELF_SERVICE',
      );

  return (
    <div className="space-y-6">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
      {warnings.length > 0 && (
        <InlineMessage tone="warning">
          {warnings.length === 1 ? (
            warnings[0]
          ) : (
            <ul className="list-disc pl-5">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </InlineMessage>
      )}
      {legacy && <KioskOnlyNotice status={status} />}
      <ClockSection status={status} busy={busy} act={act} />
      <PresenceSection status={status} busy={busy} act={act} choiceRequired={choiceRequired} />
      <TodaysShifts />
      {capabilities.length > 0 && (
        <Section
          title="Your assignments"
          description="How attendance is recorded for each of your assignments."
        >
          <ul className="grid gap-3 md:grid-cols-2">
            {capabilities.map((item) => (
              <CapabilityCard key={item.employmentAssignmentId} item={item} />
            ))}
          </ul>
        </Section>
      )}
      {usesKiosk && (
        <Section title="Kiosk PIN">
          <OwnPinPanel />
        </Section>
      )}
    </div>
  );
}

type ActResult = string | { message: string; warnings?: TimeActionWarning[] };
type Act = (key: string, action: () => Promise<ActResult>) => Promise<void>;

function CapabilityCard({ item }: { item: AssignmentCapability }) {
  const recorded =
    item.unavailableReason === 'ATTENDANCE_DISABLED' ||
    item.unavailableReason === 'NO_TIMEZONE' ||
    item.unavailableReason === 'CLOCK_DISABLED'
      ? null
      : item.trackingMode === 'SIGN_IN_ONLY'
        ? `Presence: you sign in${item.signOutEnabled ? ' and out' : ''}; never payable hours.`
        : 'Timed: you clock in and out.';
  const where =
    item.captureMode === 'KIOSK_ONLY'
      ? 'At the onsite kiosk only.'
      : item.captureMode === 'KIOSK_OR_SELF_SERVICE'
        ? 'Here or at the onsite kiosk.'
        : item.captureMode === 'SELF_SERVICE'
          ? 'Here.'
          : null;
  return (
    <li className="rounded-lg border border-slate-200 p-3 text-sm">
      <p className="font-semibold text-slate-950">{assignmentName(item)}</p>
      {item.timezone && <p className="text-xs text-slate-600">Times in {item.timezone}</p>}
      {recorded && <p className="mt-1 text-slate-800">{recorded}</p>}
      {recorded && where && <p className="text-slate-700">{where}</p>}
      {item.explanation && (
        <p
          className={`mt-2 rounded-md px-2 py-1 ${
            item.unavailableReason === 'KIOSK_ONLY'
              ? 'bg-sky-50 text-sky-950'
              : 'bg-slate-50 text-slate-800'
          }`}
        >
          {item.explanation}
        </p>
      )}
    </li>
  );
}

// ─── Timed attendance ─────────────────────────────────────────────────────

function ClockSection({
  status,
  busy,
  act,
}: {
  status: TimeStatus;
  busy: string | null;
  act: Act;
}) {
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('');
  const [selectedShiftId, setSelectedShiftId] = useState('');
  const [switchAssignmentId, setSwitchAssignmentId] = useState('');
  const [switchShiftId, setSwitchShiftId] = useState('');
  const [resolutionAt, setResolutionAt] = useState('');
  const resolutionId = useId();
  const timed = (status.assignmentCapabilities ?? []).some(
    (item) => item.trackingMode === 'TIME_CLOCK' && item.unavailableReason === null,
  );
  const actions = status.availableActions;
  const hasClockAction = actions.some((action) =>
    ['CLOCK_IN', 'CLOCK_OUT', 'START_BREAK', 'END_BREAK', 'SWITCH_ASSIGNMENT'].includes(action),
  );
  const missing = status.activeExceptions.find(
    (item) =>
      item.type === 'MISSING_CLOCK_OUT' &&
      item.status === 'OPEN' &&
      item.workflowImpact === 'SUBMISSION_BLOCKING' &&
      item.timeEntryId === status.currentTimeEntry?.id,
  );
  if (!timed && !hasClockAction && status.state === 'OFF_CLOCK') return null;
  const zone = status.currentTimeEntry?.timezone;
  return (
    <Section title="Time clock">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-2xl font-semibold text-slate-900">{label(status.state)}</p>
          <p className="mt-1 text-sm text-slate-600">
            {status.currentAssignment
              ? assignmentName(status.currentAssignment)
              : 'Not clocked in.'}
          </p>
          {(status.currentCoverage?.length ?? 0) > 1 && (
            <p className="mt-1 text-sm text-slate-600">
              Also covering{' '}
              {status
                .currentCoverage!.filter((covered) => !covered.isPayrollOwner)
                .map((covered) => covered.assignment.position.name)
                .join(', ')}{' '}
              (time counted once)
            </p>
          )}
          {status.clockedInAt && (
            <p className="mt-1 text-sm text-slate-600">
              Clocked in {formatInstant(status.clockedInAt, zone)}
              {zone ? ` (${zone})` : ''}
            </p>
          )}
          {status.breakStartedAt && (
            <p className="mt-1 text-sm text-slate-600">
              Break started {formatInstant(status.breakStartedAt, zone)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 md:justify-end">
          {actions.includes('CLOCK_IN') && (
            <ClockInControl
              status={status}
              selectedAssignmentId={selectedAssignmentId}
              selectedShiftId={selectedShiftId}
              busy={busy === 'clock-in'}
              onSelect={(value) => {
                setSelectedAssignmentId(value);
                setSelectedShiftId('');
              }}
              onSelectShift={setSelectedShiftId}
              onClockIn={(assignmentId, scheduledShiftId, covering) =>
                void act('clock-in', async () => {
                  const result = await timeApi.clockIn(assignmentId, scheduledShiftId, covering);
                  return {
                    message:
                      covering.length > 0
                        ? `Clocked in, covering ${covering.length + 1} assignments (time counted once).`
                        : 'Clocked in.',
                    warnings: result.warnings,
                  };
                })
              }
            />
          )}
          {actions.includes('CLOCK_OUT') && (
            <ActionButton
              busy={busy === 'clock-out'}
              onClick={() =>
                void act('clock-out', async () => {
                  await timeApi.clockOut();
                  return 'Clocked out.';
                })
              }
            >
              Clock Out
            </ActionButton>
          )}
          {actions.includes('START_BREAK') && (
            <ActionButton
              busy={busy === 'break-start'}
              onClick={() =>
                void act('break-start', async () => {
                  await timeApi.startBreak();
                  return 'Break started.';
                })
              }
            >
              Start Break
            </ActionButton>
          )}
          {actions.includes('END_BREAK') && (
            <ActionButton
              busy={busy === 'break-end'}
              onClick={() =>
                void act('break-end', async () => {
                  await timeApi.endBreak();
                  return 'Break ended.';
                })
              }
            >
              End Break
            </ActionButton>
          )}
        </div>
      </div>
      {actions.includes('SWITCH_ASSIGNMENT') && status.eligibleAssignments.length > 0 && (
        <form
          className="mt-5 flex flex-col gap-3 rounded-lg border border-slate-200 p-4 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            const target = switchAssignmentId || status.eligibleAssignments[0]?.id;
            if (!target) return;
            const shift = chosenShift(status, target, switchShiftId);
            if (shift === null) return;
            void act('switch', async () => {
              const result = await timeApi.switchAssignment(target, shift);
              return { message: 'Assignment switched.', warnings: result.warnings };
            });
          }}
        >
          <label className="text-sm font-medium text-slate-700">
            Switch assignment
            <select
              value={switchAssignmentId}
              onChange={(event) => {
                setSwitchAssignmentId(event.target.value);
                setSwitchShiftId('');
              }}
              className={inputClass}
            >
              {status.eligibleAssignments.map((assignment) => (
                <option key={assignment.id} value={assignment.id}>
                  {assignmentName(assignment)}
                </option>
              ))}
            </select>
          </label>
          <ShiftSelect
            shifts={shiftsFor(status, switchAssignmentId || status.eligibleAssignments[0]?.id)}
            value={switchShiftId}
            onChange={setSwitchShiftId}
          />
          <button
            type="submit"
            disabled={
              busy === 'switch' ||
              chosenShift(
                status,
                switchAssignmentId || status.eligibleAssignments[0]?.id,
                switchShiftId,
              ) === null
            }
            className={buttonClass('secondary')}
          >
            Switch
          </button>
        </form>
      )}
      {actions.includes('RESOLVE_MISSED_CLOCK_OUT') && missing && (
        <form
          aria-label="Enter your missed clock-out"
          className="mt-5 flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (!resolutionAt) return;
            void act('resolve', async () => {
              await timeApi.resolveMissedClockOut(missing.id, resolutionAt);
              return 'Missed clock-out recorded.';
            });
          }}
        >
          <div>
            <label htmlFor={resolutionId} className="block text-sm font-medium text-amber-950">
              Missed clock-out time
            </label>
            <input
              id={resolutionId}
              value={resolutionAt}
              onChange={(event) => setResolutionAt(event.target.value)}
              type="datetime-local"
              required
              aria-describedby={`${resolutionId}-zone`}
              className={inputClass}
            />
            <p id={`${resolutionId}-zone`} className="mt-1 text-xs text-amber-900">
              You did not clock out. Local time{zone ? ` in ${zone}` : ''}.
            </p>
          </div>
          <button
            type="submit"
            disabled={!resolutionAt || busy === 'resolve'}
            className={buttonClass('primary')}
          >
            Record clock-out
          </button>
        </form>
      )}
    </Section>
  );
}

/** The published shifts open now for one assignment. */
function shiftsFor(status: TimeStatus, assignmentId: string | undefined): ClockInShiftOption[] {
  if (!assignmentId) return [];
  return (status.scheduledShiftOptions ?? []).filter(
    (shift) => shift.employmentAssignmentId === assignmentId,
  );
}

/**
 * The shift to send for an assignment: undefined when the time clock decides on its own (no
 * shift or only one), the chosen id when several are open, and null while none is chosen yet.
 */
function chosenShift(
  status: TimeStatus,
  assignmentId: string | undefined,
  selectedShiftId: string,
): string | undefined | null {
  const shifts = shiftsFor(status, assignmentId);
  if (shifts.length < 2) return undefined;
  return shifts.some((shift) => shift.scheduledShiftId === selectedShiftId)
    ? selectedShiftId
    : null;
}

function shiftLabel(shift: ClockInShiftOption): string {
  return `${timeIn(shift.startsAt, shift.timezone)}–${timeIn(shift.endsAt, shift.timezone)} · ${formatDateOnly(shift.workDate)}`;
}

/** Shown only when the assignment has several shifts open: the time clock never guesses. */
function ShiftSelect({
  shifts,
  value,
  onChange,
}: {
  shifts: ClockInShiftOption[];
  value: string;
  onChange(value: string): void;
}) {
  if (shifts.length < 2) return null;
  return (
    <label className="text-sm font-medium text-slate-700">
      Scheduled shift
      <select
        value={value}
        required
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      >
        <option value="">Select shift</option>
        {shifts.map((shift) => (
          <option key={shift.scheduledShiftId} value={shift.scheduledShiftId}>
            {shiftLabel(shift)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * R4-A.3: other eligible assignments one clock-in may also cover. Only the server's own eligible
 * list is used, limited to the payroll assignment's organization (one time entry never spans
 * organizations); the server re-checks every one.
 */
export function coverableWith(
  status: TimeStatus,
  ownerId: string | undefined,
): EmployeeAssignmentView[] {
  const owner = status.eligibleAssignments.find((assignment) => assignment.id === ownerId);
  if (!owner) return [];
  return status.eligibleAssignments.filter(
    (assignment) =>
      assignment.id !== owner.id && assignment.organization.id === owner.organization.id,
  );
}

function ClockInControl({
  status,
  selectedAssignmentId,
  selectedShiftId,
  busy,
  onSelect,
  onSelectShift,
  onClockIn,
}: {
  status: TimeStatus;
  selectedAssignmentId: string;
  selectedShiftId: string;
  busy: boolean;
  onSelect(value: string): void;
  onSelectShift(value: string): void;
  onClockIn(id: string, scheduledShiftId: string | undefined, covering: string[]): void;
}) {
  const [covering, setCovering] = useState<string[]>([]);
  const coverId = useId();
  const single = status.eligibleAssignments.length === 1;
  // The time clock's own suggestion (its only open shift's assignment) is chosen by default.
  const suggested = status.eligibleAssignments.some(
    (assignment) => assignment.id === status.preselectedEmploymentAssignmentId,
  )
    ? (status.preselectedEmploymentAssignmentId ?? '')
    : '';
  const assignmentId = single
    ? status.eligibleAssignments[0]!.id
    : selectedAssignmentId || suggested;
  const shift = chosenShift(status, assignmentId, selectedShiftId);
  const coverable = coverableWith(status, assignmentId);
  const chosenCover = covering.filter((id) => coverable.some((a) => a.id === id));
  const suggestedShift =
    shift === undefined
      ? shiftsFor(status, assignmentId).find(
          (option) => option.scheduledShiftId === status.preselectedScheduledShiftId,
        )
      : undefined;
  const otherOrganizations = status.eligibleAssignments.some(
    (assignment) =>
      assignmentId &&
      assignment.organization.id !==
        status.eligibleAssignments.find((a) => a.id === assignmentId)?.organization.id,
  );
  if (single && shift === undefined) {
    return (
      <ActionButton busy={busy} onClick={() => onClockIn(assignmentId, undefined, [])}>
        Clock In
      </ActionButton>
    );
  }
  return (
    <form
      aria-label="Clock in"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (assignmentId && shift !== null)
          onClockIn(assignmentId, shift ?? undefined, chosenCover);
      }}
    >
      {!single && (
        <label className="text-sm font-medium text-slate-700">
          Assignment
          <select
            value={assignmentId}
            onChange={(event) => {
              setCovering([]);
              onSelect(event.target.value);
            }}
            className={inputClass}
          >
            <option value="">Select assignment</option>
            {status.eligibleAssignments.map((assignment) => (
              <option key={assignment.id} value={assignment.id}>
                {assignmentName(assignment)}
              </option>
            ))}
          </select>
        </label>
      )}
      <ShiftSelect
        shifts={shiftsFor(status, assignmentId)}
        value={selectedShiftId}
        onChange={onSelectShift}
      />
      {suggestedShift && (
        <p className="w-full text-sm text-slate-600">
          Your scheduled shift: {shiftLabel(suggestedShift)}
        </p>
      )}
      {coverable.length > 0 && (
        <fieldset className="w-full rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium text-slate-700">
            Also covering (optional)
          </legend>
          <p id={`${coverId}-hint`} className="text-xs text-slate-600">
            One clock-in can cover several of your assignments in the same organization. The time is
            counted once, under the assignment above.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {coverable.map((assignment) => (
              <label key={assignment.id} className="flex items-center gap-2 text-sm text-slate-800">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  checked={chosenCover.includes(assignment.id)}
                  aria-describedby={`${coverId}-hint`}
                  onChange={(event) =>
                    setCovering((current) =>
                      event.target.checked
                        ? [...current, assignment.id]
                        : current.filter((id) => id !== assignment.id),
                    )
                  }
                />
                {assignmentName(assignment)}
              </label>
            ))}
          </div>
          {otherOrganizations && (
            <p className="mt-2 text-xs text-slate-600">
              Assignments in another organization need their own clock-in.
            </p>
          )}
        </fieldset>
      )}
      <button
        type="submit"
        disabled={!assignmentId || shift === null || busy}
        className={buttonClass('primary')}
      >
        {chosenCover.length > 0 ? `Clock In (${chosenCover.length + 1} assignments)` : 'Clock In'}
      </button>
    </form>
  );
}

function ActionButton({
  busy,
  onClick,
  children,
}: {
  busy: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" disabled={busy} onClick={onClick} className={buttonClass('primary')}>
      {busy ? 'Working…' : children}
    </button>
  );
}

// ─── Presence (sign-in only) ──────────────────────────────────────────────

function PresenceSection({
  status,
  busy,
  act,
  choiceRequired = false,
}: {
  status: TimeStatus;
  busy: string | null;
  act: Act;
  /** Batch 4F (D2): the employee must pick the occurrence explicitly. */
  choiceRequired?: boolean;
}) {
  const choiceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Move focus to the open occurrences, so the choice is where the employee is.
    if (!choiceRequired || busy !== null) return;
    choiceRef.current
      ?.querySelector<HTMLElement>('[data-occurrence-choice] button:not([disabled])')
      ?.focus();
  }, [choiceRequired, busy]);
  const signInAssignments = status.availableActions.includes('SIGN_IN')
    ? (status.signInAssignments ?? [])
    : [];
  const signOutAssignments = status.availableActions.includes('SIGN_OUT')
    ? (status.signOutAssignments ?? [])
    : [];
  const options = status.signInOptions ?? [];
  if (signInAssignments.length === 0 && signOutAssignments.length === 0) return null;

  async function signIn(assignmentId: string, option?: SignInOption) {
    const result = await attendanceApi.signIn(
      assignmentId,
      interactionKey(),
      option?.scheduledShiftId,
    );
    const what = option
      ? `${timeIn(option.startsAt, option.timezone)}–${timeIn(option.endsAt, option.timezone)}`
      : '';
    if (result.outcome === 'ALREADY_SIGNED_IN') {
      return `You were already signed in${what ? ` for ${what}` : ''}. Nothing new was recorded.`;
    }
    return `Signed in${what ? ` for ${what}` : ''} at ${formatInstant(
      result.signIn.signedInAt,
      result.signIn.timezone,
    )}.`;
  }

  return (
    <Section
      title="Presence"
      description="Confirm you are present. Presence is recorded as a sign-in, never as payable hours."
    >
      <div ref={choiceRef} className="space-y-4">
        {signInAssignments.map((assignment) => {
          const own = options.filter((option) => option.employmentAssignmentId === assignment.id);
          return (
            <div key={assignment.id} className="rounded-lg border border-slate-200 p-3">
              <p className="font-medium text-slate-950">{assignmentName(assignment)}</p>
              {own.length === 0 ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <p className="text-sm text-slate-700">No scheduled session is open right now.</p>
                  <button
                    type="button"
                    disabled={busy !== null}
                    className={buttonClass('primary', 'sm')}
                    onClick={() =>
                      void act(`sign-in-${assignment.id}`, () => signIn(assignment.id))
                    }
                  >
                    Sign in <span className="sr-only">for {assignmentName(assignment)}</span>
                  </button>
                </div>
              ) : (
                <>
                  {choiceRequired && own.some((option) => !option.signIn) && (
                    <p className="mt-2 text-sm font-semibold text-amber-950">
                      Choose the shift to sign in for:
                    </p>
                  )}
                  <ul
                    data-occurrence-choice={own.some((option) => !option.signIn) || undefined}
                    className={`mt-2 space-y-2 ${
                      choiceRequired ? 'rounded-md ring-2 ring-amber-400 ring-offset-2' : ''
                    }`}
                    aria-label={`Sessions open now for ${assignment.position.name}`}
                  >
                    {own.map((option) => {
                      const range = `${timeIn(option.startsAt, option.timezone)}–${timeIn(option.endsAt, option.timezone)}`;
                      return (
                        <li
                          key={option.scheduledShiftId}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 px-3 py-2 text-sm"
                        >
                          <span>
                            <span className="font-medium text-slate-900">{range}</span>{' '}
                            <span className="text-slate-600">
                              ({formatDateOnly(option.workDate)}, {option.timezone})
                            </span>
                          </span>
                          {option.signIn ? (
                            <span className="text-emerald-800">
                              Signed in at{' '}
                              {formatInstant(option.signIn.signedInAt, option.timezone)}
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={busy !== null}
                              className={buttonClass('primary', 'sm')}
                              onClick={() =>
                                void act(`sign-in-${option.scheduledShiftId}`, () =>
                                  signIn(assignment.id, option),
                                )
                              }
                            >
                              {busy === `sign-in-${option.scheduledShiftId}`
                                ? 'Working…'
                                : 'Sign in'}{' '}
                              <span className="sr-only">for {range}</span>
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          );
        })}
        {signOutAssignments.map((assignment) => (
          <div
            key={`out-${assignment.id}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm"
          >
            <span>
              Signed in for <span className="font-medium">{assignmentName(assignment)}</span>.
            </span>
            <button
              type="button"
              disabled={busy !== null}
              className={buttonClass('secondary', 'sm')}
              onClick={() =>
                void act(`sign-out-${assignment.id}`, async () => {
                  const result = await attendanceApi.signOut(assignment.id, interactionKey());
                  return result.outcome === 'ALREADY_SIGNED_OUT'
                    ? 'You were already signed out.'
                    : 'Signed out.';
                })
              }
            >
              Sign out <span className="sr-only">of {assignmentName(assignment)}</span>
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ─── Today's scheduled shifts ─────────────────────────────────────────────

function TodaysShifts() {
  const [items, setItems] = useState<ExpectedAttendanceItem[] | null>(null);
  const [truncation, setTruncation] = useState<{ truncated?: boolean; limit?: number }>({});
  const [disabledIds, setDisabledIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // The day before and after too: each shift is shown on its own time zone's today.
    const today = todayIn(null);
    try {
      const result = await timeApi.expectedAttendance({
        from: shiftDate(today, -1),
        to: shiftDate(today, 1),
      });
      setItems(result.items.filter((item) => item.workDate === todayIn(item.timezone)));
      setTruncation({ truncated: result.truncated, limit: result.limit });
      setDisabledIds(result.attendanceDisabledOrganizationIds ?? []);
      setError(null);
    } catch (cause) {
      setItems([]);
      setError(timeErrorMessage(cause, 'Unable to load today’s shifts.'));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const sorted = useMemo(
    () => [...(items ?? [])].sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    [items],
  );
  if (items === null) {
    return (
      <Section title="Today’s shifts">
        <p role="status" className="text-sm text-slate-600">
          Loading today’s shifts…
        </p>
      </Section>
    );
  }
  if (error) {
    return (
      <Section title="Today’s shifts">
        <p className="text-sm text-slate-700">{error}</p>
      </Section>
    );
  }
  if (sorted.length === 0 && !truncation.truncated) return null;
  return (
    <Section
      title="Today’s shifts"
      description="Your published shifts today and what was recorded."
    >
      <TruncatedRecordsNotice
        truncated={truncation.truncated}
        limit={truncation.limit}
        className="mb-3"
      />
      <ul className="divide-y divide-slate-100">
        {sorted.map((item) => (
          <li
            key={item.scheduledShiftId}
            className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
          >
            <span>
              <span className="font-medium text-slate-900">
                {timeIn(item.startsAt, item.timezone)}–{timeIn(item.endsAt, item.timezone)}
              </span>{' '}
              <span className="text-slate-700">{assignmentName(item)}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {isReadOnly(disabledIds, item.organization.id) && <ReadOnlyBadge />}
              <ExpectedBadge status={item.status} />
              <button
                type="button"
                className={buttonClass('ghost', 'sm')}
                onClick={() => openMyTime('history', { date: item.workDate })}
              >
                View record{' '}
                <span className="sr-only">
                  for {timeIn(item.startsAt, item.timezone)}, {assignmentName(item)}
                </span>
              </button>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
