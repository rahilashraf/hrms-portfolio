'use client';

import { useCallback, useEffect, useState } from 'react';
import { listSessions, revokeOtherSessions, revokeSession } from '../../lib/auth/api-client';
import { authErrorMessage, rateLimitedMessage } from '../../lib/auth/error-message';
import type { AccountSession } from '../../lib/auth/types';
import { buttonClass } from '../ui/button';
import { ErrorState, LoadingState } from '../ui/states';
import { useConfirm } from '../ui/use-confirm';

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Batch 2: the signed-in user's own sessions (one per sign-in on a device), with the device
 * and address each was opened from, and signing out any other one.
 */
export function AccountSessions() {
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    try {
      setSessions((await listSessions()).items);
      setError('');
    } catch (cause) {
      setError(authErrorMessage(cause));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function signOut(session: AccountSession) {
    const ok = await confirm({
      title: 'Sign out this session?',
      description: `${session.browser} on ${session.os} will need to sign in again.`,
      confirmLabel: 'Sign out session',
      destructive: true,
    });
    if (!ok) return;
    setBusy(session.id);
    setNotice('');
    try {
      await revokeSession(session.id);
      setNotice(`${session.browser} on ${session.os} was signed out.`);
      await load();
    } catch (cause) {
      setError(rateLimitedMessage(cause) ?? authErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function signOutOthers() {
    const ok = await confirm({
      title: 'Sign out all other sessions?',
      description: 'Every other device signed in to your account will need to sign in again.',
      confirmLabel: 'Sign out other sessions',
      destructive: true,
    });
    if (!ok) return;
    setBusy('others');
    setNotice('');
    try {
      const result = await revokeOtherSessions();
      setNotice(
        result.revokedSessionCount === 1
          ? 'One other session was signed out.'
          : `${result.revokedSessionCount} other sessions were signed out.`,
      );
      await load();
    } catch (cause) {
      setError(rateLimitedMessage(cause) ?? authErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  if (error && !sessions) {
    return (
      <ErrorState
        title="Sessions could not be loaded"
        message={error}
        onRetry={() => void load()}
      />
    );
  }
  if (!sessions) return <LoadingState label="Loading your sessions…" />;
  const others = sessions.filter((session) => !session.current);
  return (
    <div className="space-y-4">
      {confirmDialog}
      {notice && (
        <p role="status" className="text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-800">
          {error}
        </p>
      )}
      <ul
        aria-label="Your sessions"
        className="divide-y divide-slate-200 rounded-xl border border-slate-200"
      >
        {sessions.map((session) => (
          <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="text-sm font-medium text-slate-900">
                {session.browser} on {session.os}
                {session.current && (
                  <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                    This device
                  </span>
                )}
              </p>
              <p className="text-xs text-slate-600">
                Last active {when.format(new Date(session.lastUsedAt))} · signed in{' '}
                {when.format(new Date(session.createdAt))}
                {session.ipAddress ? ` · from ${session.ipAddress}` : ''}
              </p>
            </div>
            {!session.current && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void signOut(session)}
                className={buttonClass('secondary', 'sm')}
                aria-label={`Sign out ${session.browser} on ${session.os}`}
              >
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void signOutOthers()}
          className={buttonClass('destructive', 'sm')}
        >
          Sign out all other sessions
        </button>
      )}
    </div>
  );
}
