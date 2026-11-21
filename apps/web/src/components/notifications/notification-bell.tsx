'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { notificationsApi } from '../../lib/notifications/api';
import { NOTIFICATIONS_CHANGED_EVENT } from './notifications-shared';

export const UNREAD_POLL_MS = 60_000;

/** "Notifications" or "Notifications, 3 unread". */
export function bellLabel(unread: number) {
  return unread > 0 ? `Notifications, ${unread} unread` : 'Notifications';
}

/**
 * Batch 10A — one unread count for every bell on the page. The shell renders a bell in the
 * sidebar (desktop) and one in the mobile header; only one is ever displayed, and both share this
 * store, so the count is requested once however many bells are mounted. The count is polled
 * (every `pollMs` while the page is visible, on focus and after inbox changes); any failure keeps
 * the last known count silently — the bell never shows an error. The first bell's `pollMs` sets
 * the interval (bells mounted later share it, whatever `pollMs` they pass); the store stops (and
 * forgets the count) when the last bell unmounts.
 */
const unreadStore = {
  unread: 0,
  listeners: new Set<(unread: number) => void>(),
  stop: null as (() => void) | null,
};

function startPolling(pollMs: number): () => void {
  let active = true;
  let inFlight = false;
  const refresh = () => {
    if (inFlight) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    inFlight = true;
    Promise.resolve()
      .then(() => notificationsApi.unreadCount())
      .then((result) => {
        if (active && typeof result?.unread === 'number' && result.unread >= 0) {
          unreadStore.unread = result.unread;
          for (const listener of unreadStore.listeners) listener(result.unread);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = window.setTimeout(refresh, 0);
  const interval = window.setInterval(refresh, pollMs);
  window.addEventListener('focus', refresh);
  window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => {
    active = false;
    window.clearTimeout(timer);
    window.clearInterval(interval);
    window.removeEventListener('focus', refresh);
    window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    document.removeEventListener('visibilitychange', refresh);
  };
}

function subscribeUnread(listener: (unread: number) => void, pollMs: number): () => void {
  unreadStore.listeners.add(listener);
  listener(unreadStore.unread);
  unreadStore.stop ??= startPolling(pollMs);
  return () => {
    unreadStore.listeners.delete(listener);
    if (unreadStore.listeners.size === 0) {
      unreadStore.stop?.();
      unreadStore.stop = null;
      unreadStore.unread = 0;
    }
  };
}

/** The shared unread count (see the store above). */
export function useUnreadNotificationCount(pollMs = UNREAD_POLL_MS): number {
  const [unread, setUnread] = useState(unreadStore.unread);
  useEffect(() => subscribeUnread(setUnread, pollMs), [pollMs]);
  return unread;
}

/** The link to the notification center with the unread count. */
export function NotificationBell({ pollMs = UNREAD_POLL_MS }: { pollMs?: number }) {
  const unread = useUnreadNotificationCount(pollMs);

  return (
    <Link
      href="/notifications"
      aria-label={bellLabel(unread)}
      title={bellLabel(unread)}
      className="relative inline-flex items-center rounded-lg px-3 py-2 text-slate-700 hover:bg-slate-100"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5"
      >
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {unread > 0 && (
        <span
          aria-hidden="true"
          data-testid="notification-badge"
          className="absolute -right-0.5 -top-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1.5 text-xs font-semibold leading-5 text-white"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
