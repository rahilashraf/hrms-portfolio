'use client';

import { TabList, useTabIdBase } from '../ui/tabs';
import { LoadingState } from '../ui/states';
import { PageContainer } from '../ui/page-container';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { notificationsApi } from '../../lib/notifications/api';
import { notificationsErrorMessage } from '../../lib/notifications/errors';
import type { NotificationView } from '../../lib/notifications/types';
import {
  CategoryBadge,
  dateTimeText,
  EmptyState,
  inputClass,
  isAppPath,
  MandatoryBadge,
  notifyNotificationsChanged,
  primaryButton,
  secondaryButton,
} from './notifications-shared';

type Filter = 'all' | 'unread' | 'archived';

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'archived', label: 'Archived' },
];

export const PAGE_SIZE = 20;

/**
 * The signed-in user's notification center: their own in-app notifications, newest first,
 * filtered by unread / all / archived (and by organization when they receive notifications
 * from several), with mark read, mark all read and archive. Links are relative application
 * paths only; following one marks the notification read.
 */
export function NotificationCenterPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [organizationId, setOrganizationId] = useState('');
  const [organizations, setOrganizations] = useState<Map<string, string>>(new Map());
  const [items, setItems] = useState<NotificationView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const request = useRef(0);

  const remember = useCallback((page: NotificationView[]) => {
    setOrganizations((current) => {
      let changed = false;
      const next = new Map(current);
      for (const item of page) {
        const name = item.organization?.name;
        if (name && next.get(item.organizationId) !== name) {
          next.set(item.organizationId, name);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  const fetchPage = useCallback(
    (cursor: string | null) =>
      notificationsApi.mine({
        limit: PAGE_SIZE,
        cursor,
        unreadOnly: filter === 'unread',
        archived: filter === 'archived',
        organizationId: organizationId || null,
      }),
    [filter, organizationId],
  );

  const reload = useCallback(async () => {
    const id = ++request.current;
    try {
      const page = await fetchPage(null);
      if (id !== request.current) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      remember(page.items);
      setError(null);
    } catch (cause) {
      if (id !== request.current) return;
      setError(notificationsErrorMessage(cause, 'Unable to load your notifications.'));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [fetchPage, remember]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const id = request.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor);
      if (id !== request.current) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page.nextCursor);
      remember(page.items);
    } catch (cause) {
      setError(notificationsErrorMessage(cause, 'Unable to load more notifications.'));
    } finally {
      setLoadingMore(false);
    }
  }

  const replace = (updated: NotificationView) =>
    setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));

  async function act(action: () => Promise<void>, message: string | null, failure: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      if (message) setSuccess(message);
      notifyNotificationsChanged();
    } catch (cause) {
      setError(notificationsErrorMessage(cause, failure));
    } finally {
      setBusy(false);
    }
  }

  const markRead = (item: NotificationView) =>
    act(
      async () => replace(await notificationsApi.markRead(item.id)),
      null,
      'Unable to mark the notification read.',
    );

  const archive = (item: NotificationView) =>
    act(
      async () => {
        await notificationsApi.archive(item.id);
        setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      },
      'Notification archived.',
      'Unable to archive the notification.',
    );

  const markAllRead = () =>
    act(
      async () => {
        const { updated } = await notificationsApi.markAllRead(organizationId || null);
        setSuccess(
          updated === 1 ? '1 notification marked read.' : `${updated} notifications marked read.`,
        );
        await reload();
      },
      null,
      'Unable to mark notifications read.',
    );

  /** Following a link marks the notification read without holding up the navigation. */
  const follow = (item: NotificationView) => {
    if (item.readAt) return;
    notificationsApi
      .markRead(item.id)
      .then(() => notifyNotificationsChanged())
      .catch(() => undefined);
  };

  const changeFilter = (next: Filter) => {
    setLoading(true);
    setSuccess(null);
    setFilter(next);
  };

  const showOrganization = organizations.size > 1;
  const filterIdBase = useTabIdBase('notification-filters');

  return (
    // Batch 10E-2: the shared frame (was max-w-4xl, between two shared widths).
    <PageContainer>
      <PageHeader
        eyebrow="Inbox"
        title="Notifications"
        description="Reminders and notices from your organizations. Notifications always appear here; email follows your preferences."
      >
        <div className="flex flex-wrap items-end gap-2">
          <Link className={secondaryButton} href="/notifications/preferences">
            Email preferences
          </Link>
          {filter !== 'archived' && (
            <button
              type="button"
              className={primaryButton}
              disabled={busy || loading}
              onClick={() => void markAllRead()}
            >
              Mark all read
            </button>
          )}
        </div>
      </PageHeader>
      <div className="mt-6 space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <TabList<Filter>
            tabs={FILTERS}
            active={filter}
            onChange={changeFilter}
            label="Notification filters"
            idBase={filterIdBase}
            withPanels={false}
          />
          {showOrganization && (
            <label
              className="text-sm font-medium text-slate-800"
              htmlFor="notifications-organization"
            >
              Organization
              <select
                id="notifications-organization"
                className={inputClass}
                value={organizationId}
                onChange={(event) => {
                  setLoading(true);
                  setSuccess(null);
                  setOrganizationId(event.currentTarget.value);
                }}
              >
                <option value="">All organizations</option>
                {[...organizations.entries()]
                  .sort((a, b) => a[1].localeCompare(b[1]))
                  .map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {loading ? (
          <LoadingState label="Loading notifications…" />
        ) : items.length === 0 ? (
          <EmptyState>
            {filter === 'unread'
              ? 'You have no unread notifications.'
              : filter === 'archived'
                ? 'You have no archived notifications.'
                : 'You have no notifications.'}
          </EmptyState>
        ) : (
          <ul aria-label="Notifications" className="space-y-3">
            {items.map((item) => (
              <NotificationItem
                key={item.id}
                item={item}
                busy={busy}
                showOrganization={showOrganization}
                onRead={() => void markRead(item)}
                onArchive={() => void archive(item)}
                onFollow={() => follow(item)}
              />
            ))}
          </ul>
        )}
        {!loading && nextCursor && (
          <div className="flex justify-center">
            <button
              type="button"
              className={secondaryButton}
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </PageContainer>
  );
}

function NotificationItem({
  item,
  busy,
  showOrganization,
  onRead,
  onArchive,
  onFollow,
}: {
  item: NotificationView;
  busy: boolean;
  showOrganization: boolean;
  onRead(): void;
  onArchive(): void;
  onFollow(): void;
}) {
  const unread = !item.readAt && !item.archivedAt;
  return (
    <li
      aria-label={`Notification ${item.title}`}
      data-unread={unread ? 'true' : 'false'}
      className={
        unread
          ? 'rounded-xl border border-indigo-200 border-l-4 border-l-indigo-600 bg-indigo-50/60 p-4'
          : 'rounded-xl border border-slate-200 bg-white p-4'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {unread && (
              <span className="inline-flex rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-semibold text-white">
                Unread
              </span>
            )}
            <h2 className={unread ? 'font-semibold text-slate-950' : 'font-medium text-slate-800'}>
              {item.title}
            </h2>
          </div>
          <p className="whitespace-pre-line text-sm text-slate-700">{item.body}</p>
          {/* Batch 8: slate-600 keeps AA contrast on the unread (indigo) background. */}
          <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <CategoryBadge category={item.category} />
            {item.mandatory && <MandatoryBadge />}
            {showOrganization && item.organization && <span>{item.organization.name}</span>}
            <time dateTime={item.createdAt}>{dateTimeText(item.createdAt)}</time>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAppPath(item.link) && (
            <Link
              href={item.link}
              onClick={onFollow}
              aria-label={`Open ${item.title}`}
              className="rounded-lg px-3 py-2 text-sm font-medium text-indigo-700 underline hover:bg-indigo-50"
            >
              Open
            </Link>
          )}
          {unread && (
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              aria-label={`Mark ${item.title} read`}
              onClick={onRead}
            >
              Mark read
            </button>
          )}
          {!item.archivedAt && (
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              aria-label={`Archive ${item.title}`}
              onClick={onArchive}
            >
              Archive
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
