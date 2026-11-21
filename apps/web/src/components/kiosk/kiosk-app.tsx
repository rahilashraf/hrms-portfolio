'use client';

import type { FormEvent } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  kioskApi,
  KioskApiError,
  type KioskActionResult,
  type KioskIdentification,
  type KioskOption,
  type KioskSession,
} from '../../lib/kiosk/api';
import { attendanceWarningText } from '../../lib/time/warnings';

/** How long a finished interaction stays on screen before the kiosk clears itself. */
export const KIOSK_RESULT_MS = 5_000;
/** Inactivity after which any screen returns to welcome (and the interaction is discarded). */
export const KIOSK_IDLE_MS = 30_000;
/** How long before the idle reset a "Still there?" warning offers to continue. */
export const KIOSK_IDLE_WARNING_MS = 10_000;

/** Screens that wait for the employee (and reset after inactivity, with a warning first). */
const IDLE_SCREENS: ReadonlyArray<Screen['name']> = ['number', 'pin', 'actions', 'cover'];
/** Result screens: shown briefly, then cleared. */
const RESULT_SCREENS: ReadonlyArray<Screen['name']> = ['done', 'failed'];

type Screen =
  | { name: 'loading' }
  | { name: 'enroll'; error: string | null }
  | { name: 'inactive' }
  | { name: 'offline' }
  | { name: 'welcome' }
  | { name: 'number'; error: string | null }
  | { name: 'pin'; employeeNumber: string }
  | { name: 'actions'; identification: KioskIdentification }
  | { name: 'cover'; identification: KioskIdentification; option: KioskOption }
  | { name: 'done'; result: KioskActionResult; label: string }
  | { name: 'failed'; message: string };

const OUTCOME_TEXT: Record<KioskActionResult['action'], string> = {
  CLOCK_IN: 'Clocked in',
  CLOCK_OUT: 'Clocked out',
  START_BREAK: 'Break started',
  END_BREAK: 'Break ended',
  SWITCH_ASSIGNMENT: 'Assignment switched',
  SIGN_IN: 'Signed in',
  SIGN_OUT: 'Signed out',
};

function timeIn(value: string, timezone: string | null | undefined) {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone ?? undefined,
  }).format(new Date(value));
}

function interactionKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Phase 9.5 — the onsite attendance kiosk. Runs only on an enrolled device (the device cookie);
 * no user session, navigation or HR data. An employee identifies with their employee number and
 * attendance PIN, sees only their first name and the actions available now, acts once, and the
 * screen clears itself. Nothing is stored in the browser.
 */
export function KioskApp() {
  const [session, setSession] = useState<KioskSession | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });
  const [busy, setBusy] = useState(false);
  /** The "Still there?" warning: the screen it was raised on and the seconds left. */
  const [idleWarning, setIdleWarning] = useState<{ on: Screen; secondsLeft: number } | null>(null);
  const timers = useRef<number[]>([]);
  const tokenRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    const token = tokenRef.current;
    tokenRef.current = null;
    if (token) void kioskApi.cancel(token).catch(() => undefined);
    setBusy(false);
    setScreen({ name: 'welcome' });
  }, []);

  const handleDeviceError = useCallback((error: unknown) => {
    if (error instanceof KioskApiError) {
      if (error.code === 'KIOSK_DEVICE_UNAUTHENTICATED') {
        setSession(null);
        setScreen({ name: 'enroll', error: null });
        return true;
      }
      if (error.code === 'KIOSK_DEVICE_INACTIVE') {
        setScreen({ name: 'inactive' });
        return true;
      }
      if (error.code === 'KIOSK_OFFLINE') {
        setScreen({ name: 'offline' });
        return true;
      }
    }
    return false;
  }, []);

  const loadSession = useCallback(async () => {
    try {
      setSession(await kioskApi.session());
      setScreen({ name: 'welcome' });
    } catch (error) {
      if (!handleDeviceError(error)) setScreen({ name: 'offline' });
    }
  }, [handleDeviceError]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSession(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSession]);

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) {
      window.clearTimeout(timer);
      window.clearInterval(timer);
    }
    timers.current = [];
  }, []);

  // Idle and result timers: every screen past welcome clears itself. A waiting screen warns
  // first ("Still there?") and any activity starts the wait again; ignored, it still resets.
  const armTimers = useCallback(
    (current: Screen) => {
      clearTimers();
      if (RESULT_SCREENS.includes(current.name)) {
        timers.current.push(window.setTimeout(reset, KIOSK_RESULT_MS));
        return;
      }
      if (!IDLE_SCREENS.includes(current.name)) return;
      timers.current.push(
        window.setTimeout(() => {
          setIdleWarning({ on: current, secondsLeft: Math.ceil(KIOSK_IDLE_WARNING_MS / 1000) });
          timers.current.push(
            window.setInterval(
              () =>
                setIdleWarning((warning) =>
                  warning && warning.secondsLeft > 1
                    ? { ...warning, secondsLeft: warning.secondsLeft - 1 }
                    : warning,
                ),
              1000,
            ),
          );
        }, KIOSK_IDLE_MS - KIOSK_IDLE_WARNING_MS),
        window.setTimeout(reset, KIOSK_IDLE_MS),
      );
    },
    [clearTimers, reset],
  );

  // A new screen starts its own wait (a warning raised on another screen no longer shows).
  useEffect(() => {
    armTimers(screen);
    return clearTimers;
  }, [screen, armTimers, clearTimers]);

  // Typing, tapping or changing a field on a waiting screen counts as activity.
  const stillHere = () => {
    if (!IDLE_SCREENS.includes(screen.name)) return;
    setIdleWarning(null);
    armTimers(screen);
  };

  async function enroll(code: string) {
    setBusy(true);
    try {
      setSession(await kioskApi.enroll(code));
      setScreen({ name: 'welcome' });
    } catch (error) {
      if (error instanceof KioskApiError && error.status === 429) {
        setScreen({
          name: 'enroll',
          error: 'Too many attempts. Wait a few minutes and try again.',
        });
      } else if (error instanceof KioskApiError && error.code === 'KIOSK_OFFLINE') {
        setScreen({ name: 'enroll', error: 'The kiosk is offline. Check the connection.' });
      } else {
        setScreen({ name: 'enroll', error: 'That enrollment code is invalid or has expired.' });
      }
    } finally {
      setBusy(false);
    }
  }

  async function identify(employeeNumber: string, pin: string) {
    setBusy(true);
    try {
      const identification = await kioskApi.identify(employeeNumber, pin);
      tokenRef.current = identification.token;
      setScreen({ name: 'actions', identification });
    } catch (error) {
      if (handleDeviceError(error)) return;
      const message =
        error instanceof KioskApiError && error.status === 429
          ? 'Too many attempts. Please wait and try again, or ask a supervisor.'
          : 'Employee number or PIN not recognized.';
      setScreen({ name: 'number', error: message });
    } finally {
      setBusy(false);
    }
  }

  async function act(
    option: KioskOption,
    coverage?: {
      payrollAssignmentId: string;
      additional: string[];
      scheduledShiftId?: string;
      label: string;
    },
  ) {
    const token = tokenRef.current;
    if (!token || busy) return;
    setBusy(true);
    tokenRef.current = null;
    try {
      const assignmentId = coverage?.payrollAssignmentId ?? option.employmentAssignmentId;
      const scheduledShiftId = coverage ? coverage.scheduledShiftId : option.scheduledShiftId;
      const result = await kioskApi.act({
        token,
        action: option.action,
        ...(assignmentId ? { employmentAssignmentId: assignmentId } : {}),
        ...(coverage ? { additionalEmploymentAssignmentIds: coverage.additional } : {}),
        ...(scheduledShiftId ? { scheduledShiftId } : {}),
        idempotencyKey: interactionKey(),
      });
      setScreen({ name: 'done', result, label: coverage?.label ?? option.label });
    } catch (error) {
      if (handleDeviceError(error)) return;
      setScreen({
        name: 'failed',
        message:
          error instanceof KioskApiError && error.status !== 401 && error.status !== 0
            ? error.message
            : 'Please start again.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-4 py-10 text-white sm:px-6"
      onKeyDownCapture={stillHere}
      onPointerDownCapture={stillHere}
      onInputCapture={stillHere}
    >
      <div className="w-full max-w-xl">
        {screen.name === 'loading' && (
          <p role="status" className="text-center text-lg text-slate-300">
            Starting kiosk…
          </p>
        )}
        {screen.name === 'offline' && (
          <Panel title="Kiosk offline">
            <p className="text-slate-300">
              Attendance is not being recorded. Check the connection, or tell your supervisor so it
              can be recorded for you.
            </p>
            <button type="button" onClick={() => void loadSession()} className={primary}>
              Try again
            </button>
          </Panel>
        )}
        {screen.name === 'inactive' && (
          <Panel title="Kiosk unavailable">
            <p className="text-slate-300">
              This kiosk has been disabled. Please use another kiosk or contact your supervisor.
            </p>
            <button type="button" onClick={() => void loadSession()} className={primary}>
              Check again
            </button>
          </Panel>
        )}
        {screen.name === 'enroll' && (
          <EnrollScreen busy={busy} error={screen.error} onSubmit={enroll} />
        )}
        {screen.name === 'welcome' && session && (
          <Panel title="Attendance">
            <p className="text-slate-300">
              {session.organization.name} · {session.location.name}
            </p>
            <Clock timezone={session.location.timezone} />
            <button
              type="button"
              onClick={() => setScreen({ name: 'number', error: null })}
              className={`${primary} w-full py-5 text-2xl`}
            >
              Tap to start
            </button>
            <p className="text-xs text-slate-400">{session.device.name}</p>
          </Panel>
        )}
        {screen.name === 'number' && (
          <NumberScreen
            error={screen.error}
            onCancel={reset}
            onSubmit={(employeeNumber) => setScreen({ name: 'pin', employeeNumber })}
          />
        )}
        {screen.name === 'pin' && (
          <PinScreen
            busy={busy}
            onCancel={reset}
            onSubmit={(pin) => void identify(screen.employeeNumber, pin)}
          />
        )}
        {screen.name === 'actions' && (
          <Panel
            title={
              screen.identification.employee.firstName
                ? `Hello, ${screen.identification.employee.firstName}`
                : 'Hello'
            }
          >
            {screen.identification.notice && (
              <div
                role="status"
                className="rounded-xl border border-amber-400/60 bg-amber-950/40 p-4 text-amber-100"
              >
                <p>{screen.identification.notice.message}</p>
                <p className="mt-1 text-xs text-amber-300/80">
                  Reference: {screen.identification.notice.code}
                </p>
              </div>
            )}
            {screen.identification.actions.length === 0 ? (
              !screen.identification.notice && (
                <p className="text-slate-300">
                  There is nothing to record at this kiosk right now. If you expected to clock in or
                  sign in, please contact your supervisor.
                </p>
              )
            ) : (
              <div className="grid gap-3">
                {screen.identification.actions.map((option) => (
                  <button
                    key={`${option.action}-${option.employmentAssignmentId ?? (option.coverableAssignments ? 'several' : 'current')}-${option.scheduledShiftId ?? ''}`}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      option.coverableAssignments
                        ? setScreen({
                            name: 'cover',
                            identification: screen.identification,
                            option,
                          })
                        : void act(option)
                    }
                    className={
                      option.coverableAssignments
                        ? `${secondary} w-full py-4 text-xl`
                        : `${primary} w-full py-4 text-xl`
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            <button type="button" onClick={reset} className={secondary}>
              Cancel
            </button>
          </Panel>
        )}
        {screen.name === 'cover' && (
          <CoverageScreen
            option={screen.option}
            busy={busy}
            onBack={() => setScreen({ name: 'actions', identification: screen.identification })}
            onSubmit={(coverage) => void act(screen.option, coverage)}
          />
        )}
        {screen.name === 'done' && (
          <Panel
            title={
              screen.result.outcome === 'ALREADY_SIGNED_IN'
                ? 'Already signed in'
                : screen.result.outcome === 'ALREADY_SIGNED_OUT'
                  ? 'Already signed out'
                  : OUTCOME_TEXT[screen.result.action]
            }
          >
            <p role="status" className="text-2xl text-emerald-300">
              {screen.result.outcome === 'ALREADY_SIGNED_IN'
                ? `Your sign-in at ${timeIn(screen.result.occurredAt, screen.result.timezone ?? session?.location.timezone)} is already recorded.`
                : screen.result.outcome === 'ALREADY_SIGNED_OUT'
                  ? `Your sign-out at ${timeIn(screen.result.occurredAt, screen.result.timezone ?? session?.location.timezone)} is already recorded.`
                  : `${screen.label} — ${timeIn(screen.result.occurredAt, screen.result.timezone ?? session?.location.timezone)}`}
            </p>
            {(screen.result.warnings ?? []).length > 0 && (
              // R4-A.3: generic wording from the code alone; the record is reviewed by a manager.
              <ul aria-label="Flagged for review" className="space-y-1 text-lg text-amber-200">
                {screen.result.warnings!.map((warning) => (
                  <li key={warning.code}>{attendanceWarningText({ code: warning.code })}</li>
                ))}
              </ul>
            )}
            <button type="button" onClick={reset} className={secondary}>
              Done
            </button>
          </Panel>
        )}
        {screen.name === 'failed' && (
          <Panel title="Not recorded">
            <p role="alert" className="text-xl text-rose-300">
              {screen.message}
            </p>
            <button type="button" onClick={reset} className={secondary}>
              Start again
            </button>
          </Panel>
        )}
        {idleWarning?.on === screen && (
          <IdleWarning secondsLeft={idleWarning.secondsLeft} onContinue={stillHere} />
        )}
      </div>
    </main>
  );
}

/** Shown before an idle reset: the employee can keep going; ignored, the kiosk still resets. */
function IdleWarning({ secondsLeft, onContinue }: { secondsLeft: number; onContinue(): void }) {
  const button = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();
  useEffect(() => {
    // Back to where the employee was (e.g. the PIN field) once they continue.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    button.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      className="mt-6 space-y-4 rounded-3xl border border-amber-400/60 bg-amber-950/60 p-5 text-center sm:p-6"
    >
      <h2 id={titleId} className="text-2xl font-semibold text-amber-100">
        Still there?
      </h2>
      <p id={textId} className="text-amber-100">
        Resetting in {secondsLeft} {secondsLeft === 1 ? 'second' : 'seconds'}.
      </p>
      <button ref={button} type="button" onClick={onContinue} className={`${primary} w-full`}>
        Continue
      </button>
    </div>
  );
}

// Batch 10C: a visible focus ring on the kiosk's dark surface (keyboards and switch devices),
// and at least a 48 px tall touch target.
const kioskFocus =
  'focus-visible:outline-hidden focus-visible:ring-4 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900';
const primary = `min-h-12 rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white hover:bg-indigo-500 disabled:opacity-60 ${kioskFocus}`;
const secondary = `min-h-12 rounded-xl border border-slate-600 px-5 py-3 font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-60 ${kioskFocus}`;

/**
 * One physical clock-in covering several assignments: the employee ticks every assignment they
 * are working at once and picks the one that is paid for the time (counted once, never per
 * assignment). The server re-checks every assignment.
 */
function CoverageScreen({
  option,
  busy,
  onBack,
  onSubmit,
}: {
  option: KioskOption;
  busy: boolean;
  onBack(): void;
  onSubmit(coverage: {
    payrollAssignmentId: string;
    additional: string[];
    scheduledShiftId?: string;
    label: string;
  }): void;
}) {
  const assignments = option.coverableAssignments ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  // The paid (payroll) assignment is always an explicit choice: it decides who pays the whole
  // interval, so it is never defaulted and is cleared when it stops being covered.
  const [payrollAssignmentId, setPayrollAssignmentId] = useState<string | null>(null);
  // Only the paid assignment's shift is linked. When it has several open, the employee says which
  // one they are starting (the time clock never guesses); the choice resets with the assignment.
  const [scheduledShiftId, setScheduledShiftId] = useState<string | null>(null);
  const payrollShifts =
    assignments.find((assignment) => assignment.employmentAssignmentId === payrollAssignmentId)
      ?.shifts ?? [];
  const shiftChosen =
    payrollShifts.length === 0 ||
    payrollShifts.some((shift) => shift.scheduledShiftId === scheduledShiftId);
  const nameOf = (id: string) =>
    assignments.find((assignment) => assignment.employmentAssignmentId === id)?.name ??
    'Assignment';
  const ready =
    selected.length >= 2 &&
    payrollAssignmentId !== null &&
    selected.includes(payrollAssignmentId) &&
    shiftChosen;

  function choosePayroll(id: string | null) {
    setPayrollAssignmentId(id);
    setScheduledShiftId(null);
  }

  function toggle(id: string) {
    if (selected.includes(id)) {
      setSelected(selected.filter((value) => value !== id));
      if (payrollAssignmentId === id) choosePayroll(null);
    } else {
      setSelected([...selected, id]);
    }
  }

  return (
    <Panel title="Clock in — several assignments">
      <fieldset className="space-y-3 text-left">
        <legend className="mb-2 text-slate-300">Which assignments are you working now?</legend>
        {assignments.map((assignment) => (
          <label
            key={assignment.employmentAssignmentId}
            className="flex items-center gap-3 rounded-xl border border-slate-700 px-4 py-3 text-xl"
          >
            <input
              type="checkbox"
              className="h-6 w-6"
              checked={selected.includes(assignment.employmentAssignmentId)}
              onChange={() => toggle(assignment.employmentAssignmentId)}
            />
            {assignment.name}
          </label>
        ))}
      </fieldset>
      {selected.length >= 2 && (
        <fieldset className="space-y-3 text-left">
          <legend className="mb-2 text-slate-300">Paid as (your time is counted once)</legend>
          {selected.map((id) => (
            <label
              key={id}
              className="flex items-center gap-3 rounded-xl border border-slate-700 px-4 py-3 text-xl"
            >
              <input
                type="radio"
                name="payroll-assignment"
                className="h-6 w-6"
                checked={payrollAssignmentId === id}
                onChange={() => choosePayroll(id)}
              />
              {nameOf(id)}
            </label>
          ))}
        </fieldset>
      )}
      {payrollAssignmentId !== null && payrollShifts.length > 0 && (
        <fieldset className="space-y-3 text-left">
          <legend className="mb-2 text-slate-300">
            Which {nameOf(payrollAssignmentId)} shift are you starting?
          </legend>
          {payrollShifts.map((shift) => (
            <label
              key={shift.scheduledShiftId}
              className="flex items-center gap-3 rounded-xl border border-slate-700 px-4 py-3 text-xl"
            >
              <input
                type="radio"
                name="payroll-shift"
                className="h-6 w-6"
                checked={scheduledShiftId === shift.scheduledShiftId}
                onChange={() => setScheduledShiftId(shift.scheduledShiftId)}
              />
              {shift.label}
            </label>
          ))}
        </fieldset>
      )}
      <button
        type="button"
        disabled={busy || !ready}
        onClick={() =>
          ready &&
          payrollAssignmentId &&
          onSubmit({
            payrollAssignmentId,
            additional: selected.filter((id) => id !== payrollAssignmentId),
            ...(scheduledShiftId && payrollShifts.length > 0 ? { scheduledShiftId } : {}),
            label: `Clock in — ${selected.map(nameOf).join(' + ')}`,
          })
        }
        className={`${primary} w-full py-4 text-xl`}
      >
        {ready
          ? 'Clock in'
          : selected.length < 2
            ? 'Choose at least two assignments'
            : !shiftChosen
              ? 'Choose the shift you are starting'
              : 'Choose the paid assignment'}
      </button>
      <button type="button" onClick={onBack} className={secondary}>
        Back
      </button>
    </Panel>
  );
}

function Panel({
  title,
  focusHeading = true,
  children,
}: {
  title: string;
  /** False on screens whose primary field takes focus instead. */
  focusHeading?: boolean;
  children: React.ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Each screen announces itself, and focus never falls back to the page body.
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [focusHeading]);
  return (
    <section className="space-y-6 rounded-3xl border border-slate-800 bg-slate-900 p-5 text-center shadow-xl sm:p-8">
      <h1 ref={heading} tabIndex={-1} className="text-3xl font-semibold focus:outline-none">
        {title}
      </h1>
      {children}
    </section>
  );
}

function Clock({ timezone }: { timezone: string | null }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="text-5xl font-light tabular-nums">
      <span className="sr-only">Current time: </span>
      {new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone ?? undefined,
      }).format(now)}
    </p>
  );
}

function EnrollScreen({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit(code: string): void;
}) {
  const [code, setCode] = useState('');
  return (
    <Panel title="Set up this kiosk">
      <p className="text-slate-300">
        Enter the enrollment code shown to the administrator who registered this device.
      </p>
      <form
        className="space-y-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (code.trim()) onSubmit(code.trim());
        }}
      >
        <label
          className="block text-left text-sm font-medium text-slate-300"
          htmlFor="enrollment-code"
        >
          Enrollment code
          <input
            id="enrollment-code"
            value={code}
            onChange={(event) => setCode(event.currentTarget.value.toUpperCase())}
            autoComplete="off"
            spellCheck={false}
            className="mt-1 block w-full rounded-xl border border-slate-600 bg-slate-950 px-4 py-3 text-center font-mono text-2xl tracking-widest focus:outline-hidden focus:ring-4 focus:ring-sky-300"
          />
        </label>
        {error && (
          <p role="alert" className="text-rose-300">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !code.trim()} className={`${primary} w-full`}>
          Enroll kiosk
        </button>
      </form>
    </Panel>
  );
}

function NumberScreen({
  error,
  onCancel,
  onSubmit,
}: {
  error: string | null;
  onCancel(): void;
  onSubmit(employeeNumber: string): void;
}) {
  const [value, setValue] = useState('');
  return (
    <Panel title="Employee number" focusHeading={false}>
      <form
        className="space-y-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <label className="sr-only" htmlFor="employee-number">
          Employee number
        </label>
        <input
          id="employee-number"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value.toUpperCase())}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus
          className="block w-full rounded-xl border border-slate-600 bg-slate-950 px-4 py-4 text-center font-mono text-3xl tracking-wider focus:outline-hidden focus:ring-4 focus:ring-sky-300"
        />
        {error && (
          <p role="alert" className="text-rose-300">
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <button type="button" onClick={onCancel} className={`${secondary} flex-1`}>
            Cancel
          </button>
          <button type="submit" disabled={!value.trim()} className={`${primary} flex-1`}>
            Next
          </button>
        </div>
      </form>
    </Panel>
  );
}

function PinScreen({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel(): void;
  onSubmit(pin: string): void;
}) {
  const [pin, setPin] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const submitted = useRef(false);
  // The PIN field takes focus so a physical keyboard or keypad works straight away.
  useEffect(() => {
    input.current?.focus();
  }, []);
  // Submitted exactly once, on the sixth digit (never from an effect that could run again).
  const update = (next: string) => {
    if (busy || submitted.current) return;
    const digits = next.replace(/\D/g, '').slice(0, 6);
    setPin(digits);
    if (digits.length === 6) {
      submitted.current = true;
      onSubmit(digits);
    }
  };
  const press = (digit: string) => {
    if (pin.length < 6) update(pin + digit);
  };
  // On-screen keys leave focus in the PIN field (a keyboard user can still Tab to them).
  const keepFieldFocus = (event: React.MouseEvent) => event.preventDefault();
  return (
    <Panel title="Attendance PIN" focusHeading={false}>
      <form
        className="space-y-6"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (pin.length === 6 && !busy && !submitted.current) {
            submitted.current = true;
            onSubmit(pin);
          }
        }}
      >
        <input
          ref={input}
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={6}
          aria-label="Attendance PIN"
          value={pin}
          disabled={busy}
          onChange={(event) => update(event.currentTarget.value)}
          className="peer sr-only"
        />
        {/* The dots are visual only (and show the field's focus); the polite text below says
            how far the PIN is. */}
        <p
          aria-hidden="true"
          className="rounded-xl py-2 font-mono text-3xl tracking-[0.3em] peer-focus:outline-hidden peer-focus:ring-2 peer-focus:ring-indigo-400 sm:text-4xl sm:tracking-[0.5em]"
        >
          {'●'.repeat(pin.length).padEnd(6, '○')}
        </p>
        <p aria-live="polite" className="sr-only">
          {pin.length} of 6 digits entered
        </p>
        <div className="mx-auto grid max-w-xs grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button
              key={digit}
              type="button"
              disabled={busy}
              onMouseDown={keepFieldFocus}
              onClick={() => press(digit)}
              className={`${secondary} py-4 text-2xl`}
            >
              {digit}
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            onMouseDown={keepFieldFocus}
            onClick={() => setPin('')}
            className={`${secondary} py-4 text-base`}
          >
            Clear
          </button>
          <button
            type="button"
            disabled={busy}
            onMouseDown={keepFieldFocus}
            onClick={() => press('0')}
            className={`${secondary} py-4 text-2xl`}
          >
            0
          </button>
          <button
            type="button"
            disabled={busy}
            onMouseDown={keepFieldFocus}
            onClick={() => setPin((current) => current.slice(0, -1))}
            className={`${secondary} py-4 text-base`}
            aria-label="Delete digit"
          >
            ⌫
          </button>
        </div>
      </form>
      {busy && (
        <p role="status" className="text-slate-300">
          Checking…
        </p>
      )}
      {/* Not while checking: the identification would land after the screen was cleared. */}
      <button type="button" disabled={busy} onClick={onCancel} className={secondary}>
        Cancel
      </button>
    </Panel>
  );
}
