'use client';

import Link from 'next/link';
import { NotificationBell } from '../notifications/notification-bell';
import { Icon } from './icons';

/** Profile and session controls at the bottom of the sidebar. */
export function UserPanel({
  name,
  email,
  collapsed,
  busy,
  onSignOut,
  onSignOutAll,
}: {
  name: string;
  email: string;
  collapsed: boolean;
  busy: boolean;
  onSignOut(): void;
  onSignOutAll(): void;
}) {
  const initials = (name || email).slice(0, 1).toUpperCase() || '?';
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 border-t border-slate-200 px-2 py-3">
        <span
          title={`${name} (${email})`}
          className="inline-flex size-8 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700"
        >
          <span aria-hidden="true">{initials}</span>
          <span className="sr-only">Signed in as {email}</span>
        </span>
        <NotificationBell />
        <Link
          href="/account/security"
          aria-label="Account security"
          title="Account security"
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
        >
          <Icon name="settings" />
        </Link>
        <button
          type="button"
          disabled={busy}
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)] disabled:opacity-60"
        >
          <Icon name="logout" />
        </button>
      </div>
    );
  }
  return (
    <div className="border-t border-slate-200 p-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-700"
        >
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{name}</p>
          <p className="truncate text-xs text-slate-600">{email}</p>
          <Link
            href="/account/security"
            className="text-xs font-medium text-[var(--hrms-accent-text)] hover:underline"
          >
            Account security
          </Link>
        </div>
        <NotificationBell />
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onSignOut}
          className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)] disabled:opacity-60"
        >
          Sign out
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSignOutAll}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)] disabled:opacity-60"
        >
          Sign out all
        </button>
      </div>
    </div>
  );
}
