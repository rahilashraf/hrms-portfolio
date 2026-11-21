'use client';

import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { attendanceApi } from '../../lib/attendance/api';
import type { SignInDetail } from '../../lib/attendance/types';
import { timeErrorMessage } from '../../lib/time/errors';
import { formatDateOnly, formatInstant, label } from '../../lib/time/format';
import type { TimeStatus } from '../../lib/time/types';

type Modes = NonNullable<TimeStatus['attendanceModes']>;

/** Whether any active assignment records presence by sign-in rather than the clock. */
export function tracksSignIns(status: TimeStatus | null): boolean {
  return (status?.attendanceModes ?? []).some((mode) => mode.trackingMode === 'SIGN_IN_ONLY');
}

/** Whether any active assignment can be captured at a kiosk (and so needs a PIN). */
export function usesKiosk(status: TimeStatus | null): boolean {
  return (status?.attendanceModes ?? []).some((mode) => mode.captureMode !== 'SELF_SERVICE');
}

/** How many active assignments may only be captured at an onsite kiosk. */
export function kioskOnlyCount(modes: Modes | undefined): number {
  return (modes ?? []).filter((mode) => mode.captureMode === 'KIOSK_ONLY').length;
}

/** Sign-in buttons for SIGN_IN_ONLY assignments this channel may sign in for now. */
export function SignInControls({
  status,
  busy,
  onSignIn,
}: {
  status: TimeStatus;
  busy: string | null;
  onSignIn(assignmentId: string): void;
}) {
  const assignments = status.signInAssignments ?? [];
  if (!status.availableActions.includes('SIGN_IN') || assignments.length === 0) return null;
  return (
    <>
      {assignments.map((assignment) => (
        <button
          key={assignment.id}
          type="button"
          disabled={busy !== null}
          onClick={() => onSignIn(assignment.id)}
          className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === `sign-in-${assignment.id}`
            ? 'Working…'
            : assignments.length === 1
              ? 'Sign In'
              : `Sign In · ${assignment.position.name}`}
        </button>
      ))}
    </>
  );
}

/** Explains why self-service buttons are missing for kiosk-only assignments. */
export function KioskOnlyNotice({ status }: { status: TimeStatus }) {
  const count = kioskOnlyCount(status.attendanceModes);
  if (count === 0) return null;
  return (
    <p
      role="note"
      className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950"
    >
      {count === 1 ? 'One of your assignments records' : `${count} of your assignments record`}{' '}
      attendance at the onsite kiosk only. Use the kiosk at your workplace with your employee number
      and attendance PIN.
    </p>
  );
}

export function SignInHistory({ signIns }: { signIns: SignInDetail[] }) {
  if (signIns.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
        No sign-ins yet.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
      {signIns.map((signIn) => (
        <li key={signIn.id} className="p-3 text-sm">
          <p className="font-medium text-slate-900">
            {signIn.positionName} · {formatDateOnly(signIn.workDate)}
          </p>
          <p className="text-slate-600">
            {formatInstant(signIn.signedInAt, signIn.timezone)} · {label(signIn.source)}
            {signIn.device && ` · ${signIn.device.name}`}
            {signIn.status === 'VOIDED' && ' · voided'}
          </p>
          {signIn.exceptions.length > 0 && (
            <p className="mt-1 text-amber-800">
              {signIn.exceptions.map((exception) => label(exception.type)).join(', ')}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The employee sets or changes their own kiosk PIN (never shown back). */
export function OwnPinPanel() {
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    attendanceApi
      .myPin()
      .then((result) => {
        if (active) setHasPin(result.hasPin);
      })
      .catch((cause) => {
        if (active) setError(timeErrorMessage(cause, 'Unable to load your attendance PIN status.'));
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPin = String(form.get('currentPin') ?? '');
    const newPin = String(form.get('newPin') ?? '');
    setError(null);
    setSuccess(null);
    if (newPin !== String(form.get('confirmPin') ?? '')) {
      setError('The new PINs do not match.');
      return;
    }
    setBusy(true);
    try {
      await attendanceApi.changeMyPin({ ...(hasPin ? { currentPin } : {}), newPin });
      setHasPin(true);
      setSuccess('Your attendance PIN was saved.');
      formElement.reset();
    } catch (cause) {
      setError(timeErrorMessage(cause, 'Unable to save your attendance PIN.'));
    } finally {
      setBusy(false);
    }
  }

  const pinInput =
    'mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono tracking-widest';
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Your attendance PIN identifies you at a kiosk together with your employee number. It is
        separate from your password; never share it.
      </p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
      {hasPin !== null && (
        <form onSubmit={submit} aria-label="Attendance PIN" className="grid gap-3 sm:grid-cols-3">
          {hasPin && (
            <label className="text-sm font-medium text-slate-700">
              Current PIN
              <input
                name="currentPin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                pattern="\d{6}"
                maxLength={6}
                required
                className={pinInput}
              />
            </label>
          )}
          <label className="text-sm font-medium text-slate-700">
            New PIN (6 digits)
            <input
              name="newPin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              pattern="\d{6}"
              maxLength={6}
              required
              className={pinInput}
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Confirm new PIN
            <input
              name="confirmPin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              pattern="\d{6}"
              maxLength={6}
              required
              className={pinInput}
            />
          </label>
          <div className="sm:col-span-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {hasPin ? 'Change PIN' : 'Set PIN'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
