'use client';

import type { FormEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { buttonClass } from '../ui/button';
import { useConfirm } from '../ui/use-confirm';
import { employeeApi } from '../../lib/employee/api';
import { ACCOUNT_SCOPE_REASON_TEXT, employeeAccountErrorMessage } from '../../lib/employee/errors';
import type {
  EmployeeAccount,
  EmployeeAccountAction,
  EmployeeAccountScopeReason,
  EmployeeAccountStatus,
} from '../../lib/employee/types';
import { AuthApiError } from '../../lib/auth/types';
import { formatInstant } from '../../lib/time/format';
import { CheckboxField, SubmitButton } from '../ui/form/form-field';
import { StatusBadge } from '../ui/status-badge';
import type { Tone } from '../ui/tokens';

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const STATUS_LABELS: Record<EmployeeAccountStatus, string> = {
  NOT_INVITED: 'Not invited',
  INVITED: 'Invited',
  INVITATION_EXPIRED: 'Invitation expired',
  ACTIVE: 'Active',
  LOCKED: 'Active (temporarily locked)',
  DISABLED: 'Disabled',
  ARCHIVED: 'Archived',
};

/** Batch 10B: the shared StatusBadge's tones, with this domain's meanings kept. */
const STATUS_TONES: Record<EmployeeAccountStatus, Tone> = {
  NOT_INVITED: 'neutral',
  INVITED: 'info',
  INVITATION_EXPIRED: 'warning',
  ACTIVE: 'success',
  LOCKED: 'warning',
  DISABLED: 'danger',
  ARCHIVED: 'neutral',
};

/** The button labels, for the list of actions the administrator's scope rules out (M1). */
const ACTION_LABELS: Record<EmployeeAccountAction, string> = {
  invite: 'Invite',
  resend: 'Resend invitation',
  cancel: 'Cancel invitation',
  disable: 'Disable login',
  enable: 'Enable login',
  sendPasswordReset: 'Send password reset link',
  requirePasswordChange: 'Require password change',
  signOut: 'Sign out everywhere',
  unlock: 'Unlock',
};

/**
 * Security remediation M1: actions the login's state allows but the administrator's scope does
 * not, grouped by reason. Only the server's safe reasons are shown (never another organization
 * or role); the buttons themselves are not rendered.
 */
export function unavailableAccountActions(
  account: EmployeeAccount,
): Array<{ reason: EmployeeAccountScopeReason; labels: string[] }> {
  const groups = new Map<EmployeeAccountScopeReason, string[]>();
  for (const action of Object.keys(ACTION_LABELS) as EmployeeAccountAction[]) {
    const capability = account.capabilities?.[action];
    if (!capability || capability.allowed || !capability.reason) continue;
    groups.set(capability.reason, [
      ...(groups.get(capability.reason) ?? []),
      ACTION_LABELS[action],
    ]);
  }
  return [...groups].map(([reason, labels]) => ({ reason, labels }));
}

export function accountStatusLabel(status: EmployeeAccountStatus): string {
  return STATUS_LABELS[status];
}

type EmailForm = 'invite' | 'resend' | null;

/**
 * The employee profile's Login Access section (employee.account.manage). Administrators invite
 * the employee to choose their own password (no temporary passwords), resend or cancel the
 * invitation, and disable or re-enable sign-in. Roles are granted separately in Access Control;
 * the attendance PIN is unaffected. The API checks the permission on the employee's positions;
 * the section hides itself where it is refused (including one's own login). Security remediation M1:
 * actions the administrator's scope rules out are listed with the server's safe reason instead of
 * offered; a refusal on stale flags shows that reason and reloads the section.
 */
export function EmployeeLoginAccessSection({ employeeId }: { employeeId: string }) {
  const [account, setAccount] = useState<EmployeeAccount | null>(null);
  const [hidden, setHidden] = useState(false);
  const [form, setForm] = useState<EmailForm>(null);
  const [disabling, setDisabling] = useState(false);
  const [requiringChange, setRequiringChange] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    try {
      setAccount(await employeeApi.account(employeeId));
    } catch (cause) {
      if (cause instanceof AuthApiError && cause.status === 403) setHidden(true);
      else setError(employeeAccountErrorMessage(cause, 'Unable to load login access.'));
    }
  }, [employeeId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function run(action: () => Promise<EmployeeAccount>, message: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      setAccount(await action());
      setForm(null);
      setDisabling(false);
      setRequiringChange(false);
      setSuccess(message);
    } catch (cause) {
      setError(employeeAccountErrorMessage(cause));
      // The server state may have moved (e.g. an undone invitation); show what is true now.
      await load();
    } finally {
      setBusy(false);
    }
  }

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    const changed = email && email !== account?.email ? email : undefined;
    if (form === 'invite') {
      void run(() => employeeApi.inviteAccount(employeeId, email || undefined), 'Invitation sent.');
    } else {
      void run(
        () => employeeApi.resendAccountInvitation(employeeId, changed),
        'Invitation sent again. Earlier links no longer work.',
      );
    }
  }

  async function cancelInvitation() {
    if (
      !(await confirm({
        title: 'Cancel the invitation?',
        description:
          'The invitation link stops working and any roles assigned to this login are revoked. You can invite the employee again later.',
        confirmLabel: 'Cancel invitation',
        cancelLabel: 'Keep invitation',
        destructive: true,
      }))
    )
      return;
    void run(() => employeeApi.cancelAccountInvitation(employeeId), 'Invitation cancelled.');
  }

  function submitDisable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    void run(
      () => employeeApi.disableAccount(employeeId, reason || undefined),
      'Login access disabled. All sessions were signed out.',
    );
  }

  async function enable() {
    if (
      !(await confirm({
        title: 'Re-enable login access?',
        description:
          'The employee can sign in again with their existing password and keeps their assigned roles.',
        confirmLabel: 'Re-enable',
        destructive: false,
      }))
    )
      return;
    void run(() => employeeApi.enableAccount(employeeId), 'Login access re-enabled.');
  }

  // ─── Batch 2: account security actions ───────────────────────────────────

  async function sendPasswordReset() {
    if (
      !(await confirm({
        title: 'Email a password reset link?',
        description:
          'The employee receives a single-use link, valid for 30 minutes, to choose a new password. Nobody else sees or sets it.',
        confirmLabel: 'Send link',
        destructive: false,
      }))
    )
      return;
    void run(
      () => employeeApi.sendAccountPasswordReset(employeeId),
      'Password reset link sent. Earlier links no longer work.',
    );
  }

  async function signOutEverywhere() {
    if (
      !(await confirm({
        title: 'Sign the employee out everywhere?',
        description: 'Every session of this login ends now; the employee can sign in again.',
        confirmLabel: 'Sign out everywhere',
        destructive: true,
      }))
    )
      return;
    void run(() => employeeApi.signOutAccount(employeeId), 'All sessions were signed out.');
  }

  async function unlock() {
    if (
      !(await confirm({
        title: 'Unlock this login?',
        description:
          'The temporary lock from repeated wrong passwords is lifted and the count starts again.',
        confirmLabel: 'Unlock',
        destructive: false,
      }))
    )
      return;
    void run(() => employeeApi.unlockAccount(employeeId), 'Login unlocked.');
  }

  if (hidden) return null;
  const actions = account?.actions;
  const unavailable = account ? unavailableAccountActions(account) : [];
  return (
    <section
      className="mt-8 rounded-xl border border-slate-200 bg-white p-5"
      aria-label="Login access"
    >
      {confirmDialog}
      <h2 className="text-lg font-semibold text-slate-950">Login access</h2>
      <p className="mt-1 text-sm text-slate-600">
        Signing in to the HRMS for self-service. Roles are assigned in Access Control; the
        attendance PIN for kiosks is separate and not affected.
      </p>
      <div className="mt-4 space-y-3 text-sm">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {account === null ? (
          !error && (
            <p role="status" className="text-slate-600">
              Loading login access…
            </p>
          )
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Status
                </dt>
                <dd className="mt-1">
                  <span data-testid="login-status">
                    <StatusBadge
                      status={account.status}
                      label={accountStatusLabel(account.status)}
                      tone={STATUS_TONES[account.status]}
                    />
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {account.status === 'NOT_INVITED' ? 'Invitation email' : 'Login email'}
                </dt>
                <dd className="mt-1 text-slate-900">{account.email ?? 'No email on file'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  {account.status === 'INVITED' ? 'Invitation expires' : 'Last sign-in'}
                </dt>
                <dd className="mt-1 text-slate-900">
                  {account.status === 'INVITED'
                    ? formatInstant(account.invitationExpiresAt, localZone())
                    : account.lastLoginAt
                      ? formatInstant(account.lastLoginAt, localZone())
                      : 'Never'}
                </dd>
              </div>
            </dl>
            {(account.status === 'ACTIVE' || account.status === 'LOCKED') && (
              <ul aria-label="Login security" className="flex flex-wrap gap-2">
                <li className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                  {account.activeSessionCount === 1
                    ? '1 active session'
                    : `${account.activeSessionCount} active sessions`}
                </li>
                {account.mustChangePassword && (
                  <li className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
                    Must choose a new password
                  </li>
                )}
                {account.lockedUntil && (
                  <li className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
                    Locked after wrong passwords until{' '}
                    {formatInstant(account.lockedUntil, localZone())}
                  </li>
                )}
              </ul>
            )}
            {account.status === 'INVITATION_EXPIRED' && (
              <p className="text-amber-800">
                The invitation link has expired or was not delivered. Resend it to give the employee
                a new link.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {actions?.invite && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('primary', 'sm')}
                  onClick={() => setForm('invite')}
                >
                  Invite
                </button>
              )}
              {actions?.resend && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('secondary', 'sm')}
                  onClick={() => setForm('resend')}
                >
                  Resend invitation
                </button>
              )}
              {actions?.cancel && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('secondary', 'sm')}
                  onClick={() => void cancelInvitation()}
                >
                  Cancel invitation
                </button>
              )}
              {actions?.disable && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('destructive', 'sm')}
                  onClick={() => setDisabling(true)}
                >
                  Disable login
                </button>
              )}
              {actions?.enable && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('primary', 'sm')}
                  onClick={() => void enable()}
                >
                  Enable login
                </button>
              )}
              {actions?.sendPasswordReset && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('secondary', 'sm')}
                  onClick={() => void sendPasswordReset()}
                >
                  Send password reset link
                </button>
              )}
              {actions?.requirePasswordChange && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('secondary', 'sm')}
                  onClick={() => setRequiringChange(true)}
                >
                  Require password change
                </button>
              )}
              {actions?.signOut && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('secondary', 'sm')}
                  onClick={() => void signOutEverywhere()}
                >
                  Sign out everywhere
                </button>
              )}
              {actions?.unlock && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('secondary', 'sm')}
                  onClick={() => void unlock()}
                >
                  Unlock
                </button>
              )}
            </div>
            {unavailable.length > 0 && (
              <div
                data-testid="login-access-unavailable"
                className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-slate-700"
              >
                <p className="font-medium text-slate-900">Not available to you</p>
                <ul
                  aria-label="Unavailable login actions"
                  className="mt-1 list-disc space-y-1 pl-5"
                >
                  {unavailable.map(({ reason, labels }) => (
                    <li key={reason}>
                      <span className="font-medium">{labels.join(', ')}</span>:{' '}
                      {ACCOUNT_SCOPE_REASON_TEXT[reason]}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {requiringChange && (
              <RequirePasswordChangeForm
                busy={busy}
                onCancel={() => setRequiringChange(false)}
                onSubmit={(signOut) =>
                  void run(
                    () => employeeApi.requireAccountPasswordChange(employeeId, signOut),
                    signOut
                      ? 'A new password is required. The employee was signed out everywhere.'
                      : 'A new password is required at the employee’s next action.',
                  )
                }
              />
            )}
            {form && (
              <form
                onSubmit={submitEmail}
                aria-label={form === 'invite' ? 'Invite employee' : 'Resend invitation'}
                className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4"
              >
                <label className="font-medium text-slate-700">
                  Email address
                  <input
                    name="email"
                    type="email"
                    required={form === 'invite' && !account.email}
                    defaultValue={account.email ?? ''}
                    maxLength={254}
                    className="mt-1 block w-72 rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <p className="basis-full text-slate-600">
                  The employee receives a single-use link, valid for 7 days, to choose their own
                  password. No role is granted by the invitation.
                </p>
                <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
                  {form === 'invite' ? 'Send invitation' : 'Send again'}
                </button>
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  className={buttonClass('secondary', 'sm')}
                >
                  Cancel
                </button>
              </form>
            )}
            {disabling && (
              <form
                onSubmit={submitDisable}
                aria-label="Disable login"
                className="flex flex-wrap items-end gap-3 rounded-lg border border-rose-200 bg-rose-50 p-4"
              >
                <p className="basis-full text-rose-900">
                  The employee is signed out everywhere and cannot sign in until re-enabled.
                  Employment records and the attendance PIN are kept.
                </p>
                <label className="font-medium text-slate-700">
                  Reason (optional)
                  <input
                    name="reason"
                    maxLength={500}
                    className="mt-1 block w-72 rounded-lg border border-slate-300 px-3 py-2"
                  />
                </label>
                <button type="submit" disabled={busy} className={buttonClass('destructive', 'sm')}>
                  Disable login
                </button>
                <button
                  type="button"
                  onClick={() => setDisabling(false)}
                  className={buttonClass('secondary', 'sm')}
                >
                  Keep access
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Batch 2 (D7): requiring a new password. Signing the employee out now is the default; without
 * it their open sessions can only change the password until they do.
 */
function RequirePasswordChangeForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit(signOut: boolean): void;
  onCancel(): void;
}) {
  const { register, handleSubmit } = useForm<{ signOut: boolean }>({
    defaultValues: { signOut: true },
  });
  return (
    <form
      onSubmit={handleSubmit((values) => onSubmit(values.signOut))}
      aria-label="Require password change"
      className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4"
    >
      <p className="text-amber-950">
        The employee must choose a new password before using anything else. They can still recover
        it by email if they have forgotten it.
      </p>
      <CheckboxField
        label="Sign the employee out everywhere now"
        hint="Otherwise their open sessions can only be used to choose the new password."
        registration={register('signOut')}
      />
      <div className="flex gap-2">
        <SubmitButton busy={busy} busyLabel="Requiring…" size="sm">
          Require password change
        </SubmitButton>
        <button type="button" onClick={onCancel} className={buttonClass('secondary', 'sm')}>
          Cancel
        </button>
      </div>
    </form>
  );
}
