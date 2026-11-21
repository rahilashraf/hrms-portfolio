'use client';

import type { FormEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { attendanceApi } from '../../lib/attendance/api';
import type { PinStatus } from '../../lib/attendance/types';
import { AuthApiError } from '../../lib/auth/types';
import { timeErrorMessage } from '../../lib/time/errors';
import { formatInstant } from '../../lib/time/format';
import { useConfirm } from '../ui/use-confirm';

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Phase 9.5 — the employee profile's attendance PIN section (time.credential.manage). The PIN is
 * never readable: issuing or resetting shows a new random PIN once, to hand to the employee.
 * Rendered only for holders of the permission; the API checks it on the employee's positions
 * and the section hides itself when it is not held there (403) or the employee is not visible
 * to the user at all (404).
 */
export function EmployeeAttendancePinSection({ employeeId }: { employeeId: string }) {
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    try {
      setStatus(await attendanceApi.pinStatus(employeeId));
    } catch (cause) {
      // 403: the permission does not reach the employee; 404 (Batch 4F, D4): the employee is
      // outside everything the user can see. Either way the section is simply not available.
      if (cause instanceof AuthApiError && (cause.status === 403 || cause.status === 404)) {
        setHidden(true);
      } else setError(timeErrorMessage(cause, 'Unable to load the attendance PIN.'));
    }
  }, [employeeId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(timeErrorMessage(cause, 'Unable to update the attendance PIN.'));
    } finally {
      setBusy(false);
    }
  }

  async function issue() {
    if (
      status?.hasPin &&
      !(await confirm({
        title: 'Reset the PIN?',
        description: 'The current PIN stops working immediately.',
        confirmLabel: 'Reset PIN',
      }))
    )
      return;
    void run(async () => {
      const result = await attendanceApi.issuePin(employeeId);
      setIssued(result.pin);
      setSuccess(result.reset ? 'PIN reset.' : 'PIN issued.');
    });
  }

  function revoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    void run(async () => {
      await attendanceApi.revokePin(employeeId, reason);
      setIssued(null);
      setRevoking(false);
      setSuccess('PIN revoked.');
    });
  }

  if (hidden) return null;
  return (
    <section
      className="mt-8 rounded-xl border border-slate-200 bg-white p-5"
      aria-label="Attendance PIN"
    >
      {confirmDialog}
      <h2 className="text-lg font-semibold text-slate-950">Attendance PIN</h2>
      <div className="mt-4 space-y-3 text-sm">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {status === null ? (
          !error && (
            <p role="status" className="text-slate-600">
              Loading attendance PIN…
            </p>
          )
        ) : (
          <>
            <p className="text-slate-700">
              {status.hasPin
                ? `PIN set ${formatInstant(status.issuedAt, localZone())}; last used ${status.lastUsedAt ? formatInstant(status.lastUsedAt, localZone()) : 'never'}.`
                : 'No attendance PIN. The employee cannot use a kiosk until one is issued or they set their own.'}
              {status.locked && ' Temporarily locked after too many wrong attempts.'}
            </p>
            {issued && (
              <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-indigo-950">
                <p className="font-semibold">New PIN — shown once</p>
                <p className="mt-1 font-mono text-2xl tracking-widest" data-testid="issued-pin">
                  {issued}
                </p>
                <p className="mt-1">
                  Give it to the employee privately. They can change it from their Time page.
                </p>
                <button
                  type="button"
                  className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700"
                  onClick={() => setIssued(null)}
                >
                  Done
                </button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void issue()}
                className="rounded-lg bg-indigo-700 px-4 py-2 font-semibold text-white disabled:opacity-60"
              >
                {status.hasPin ? 'Reset PIN' : 'Issue PIN'}
              </button>
              {status.hasPin && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setRevoking(true)}
                  className="rounded-lg border border-rose-300 px-4 py-2 font-medium text-rose-800 disabled:opacity-60"
                >
                  Revoke PIN
                </button>
              )}
            </div>
            {revoking && (
              <form
                onSubmit={revoke}
                aria-label="Revoke PIN"
                className="flex flex-wrap items-end gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4"
              >
                <label className="font-medium text-slate-700">
                  Reason
                  <input
                    name="reason"
                    required
                    className="mt-1 block w-72 rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-lg border border-rose-300 bg-white px-4 py-2 font-medium text-rose-800 disabled:opacity-60"
                >
                  Revoke PIN
                </button>
                <button
                  type="button"
                  onClick={() => setRevoking(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700"
                >
                  Cancel
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </section>
  );
}
