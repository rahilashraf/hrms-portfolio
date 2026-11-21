'use client';

import { useCallback, useEffect, useState } from 'react';
import { notificationsApi } from '../../lib/notifications/api';
import { notificationsErrorMessage } from '../../lib/notifications/errors';
import type {
  AttemptOutcome,
  DeliveryDetail,
  DeliveryQuery,
  DeliveryStatus,
  DeliveryView,
  NotificationCategory,
  NotificationChannel,
  SuppressionReason,
} from '../../lib/notifications/types';
import { ErrorState, LoadingText, TableScroll } from '../ui/states';
import { ViewDialog } from '../ui/view-dialog';
import {
  CATEGORY_LABELS,
  dateTimeText,
  EmptyState,
  Field,
  inputClass,
  primaryButton,
  secondaryButton,
  typeLabel,
} from './notifications-shared';

export const STATUS_LABELS: Record<DeliveryStatus, string> = {
  PENDING: 'Pending',
  SENDING: 'Sending',
  SENT: 'Sent',
  FAILED: 'Failed',
  SUPPRESSED: 'Suppressed',
};

const STATUS_STYLES: Record<DeliveryStatus, string> = {
  PENDING: 'bg-sky-50 text-sky-800',
  SENDING: 'bg-indigo-50 text-indigo-800',
  SENT: 'bg-emerald-50 text-emerald-800',
  FAILED: 'bg-rose-50 text-rose-800',
  SUPPRESSED: 'bg-slate-100 text-slate-700',
};

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  IN_APP: 'In app',
  EMAIL: 'Email',
};

export const SUPPRESSION_LABELS: Record<SuppressionReason, string> = {
  USER_PREFERENCE: "The recipient's email preference",
  ORGANIZATION_CATEGORY_DISABLED: 'Email is off for this category',
  ORGANIZATION_EMAIL_DISABLED: "The organization's email is off",
  RECIPIENT_INACTIVE: 'The recipient account is inactive',
  EMAIL_PROVIDER_NOT_CONFIGURED: 'No email provider is configured',
  DELIVERY_EXPIRED: 'Expired before it could be sent',
};

export const OUTCOME_LABELS: Record<AttemptOutcome, string> = {
  SUCCEEDED: 'Delivered to the provider',
  RETRYABLE: 'Failed, retried later',
  PERMANENT: 'Failed permanently',
  UNCERTAIN: 'Outcome unknown (may have been delivered; not retried)',
  ABANDONED: 'Abandoned before sending (retried)',
  IN_PROGRESS: 'In progress',
};

const CATEGORIES = Object.keys(CATEGORY_LABELS) as NotificationCategory[];
const STATUSES = Object.keys(STATUS_LABELS) as DeliveryStatus[];
const PAGE_SIZE = 25;

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/** What the status means for this delivery, in words (reason, retry or error code). */
function statusDetail(delivery: DeliveryView) {
  if (delivery.status === 'SUPPRESSED' && delivery.suppressedReason)
    return SUPPRESSION_LABELS[delivery.suppressedReason];
  if (delivery.status === 'PENDING' && delivery.attemptCount > 0)
    return `Retry ${delivery.attemptCount + 1} at ${dateTimeText(delivery.nextAttemptAt)}`;
  if (delivery.status === 'FAILED' && delivery.lastErrorCode === 'DELIVERY_OUTCOME_UNCERTAIN')
    return 'Outcome unknown; not retried';
  if (delivery.lastErrorCode) return `Error ${delivery.lastErrorCode}`;
  return null;
}

type Filters = Required<
  Pick<DeliveryQuery, 'type' | 'category' | 'channel' | 'status' | 'from' | 'to' | 'recipient'>
>;

const NO_FILTERS: Filters = {
  type: '',
  category: '',
  channel: '',
  status: '',
  from: '',
  to: '',
  recipient: '',
};

/**
 * Batch 8 (N5) — the read-only delivery log of an organization: what was delivered to whom, on
 * which channel, with what outcome and attempt history. Never the message, the address or its
 * variables (the API never returns them). Filters apply on submit; pages load by cursor.
 */
export function DeliveryLogTab({ organizationId }: { organizationId: string }) {
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [items, setItems] = useState<DeliveryView[]>([]);
  const [types, setTypes] = useState<Array<{ key: string; category: NotificationCategory }>>([]);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'more'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DeliveryView | null>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(
    (cursor: string | null) =>
      notificationsApi.deliveries({ organizationId, ...filters, cursor, limit: PAGE_SIZE }),
    [organizationId, filters],
  );

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setState('loading');
      load(null)
        .then((page) => {
          if (!active) return;
          setItems(page.items);
          setTypes(page.types);
          setTimezone(page.timezone);
          setNextCursor(page.nextCursor);
          setState('ready');
        })
        .catch((cause) => {
          if (!active) return;
          setError(notificationsErrorMessage(cause, 'Unable to load the delivery log.'));
          setState('error');
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, reload]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setState('more');
    try {
      const page = await load(nextCursor);
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      setState('ready');
    } catch (cause) {
      setError(notificationsErrorMessage(cause, 'Unable to load more deliveries.'));
      setState('error');
    }
  };

  const set = (field: keyof Filters) => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));
  const filtered = Object.values(filters).some(Boolean);
  const rangeInvalid = Boolean(draft.from && draft.to && draft.from > draft.to);

  return (
    <section aria-labelledby="delivery-log-heading" className="space-y-4">
      <div>
        <h2 id="delivery-log-heading" className="text-base font-semibold text-slate-900">
          Delivery log
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Every in-app and email delivery of this organization&apos;s notifications, newest first.
          Message text and email addresses are never shown.
          {timezone ? ` Dates are in ${timezone}.` : ''}
        </p>
      </div>
      <form
        aria-label="Delivery log filters"
        className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (rangeInvalid) return;
          setFilters(draft);
          setReload((value) => value + 1);
        }}
      >
        <Field label="Event">
          <select
            className={inputClass}
            value={draft.type}
            onChange={(event) => set('type')(event.currentTarget.value)}
          >
            <option value="">All events</option>
            {[...types]
              .sort((a, b) => typeLabel(a.key).localeCompare(typeLabel(b.key)))
              .map((type) => (
                <option key={type.key} value={type.key}>
                  {typeLabel(type.key)}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Category">
          <select
            className={inputClass}
            value={draft.category}
            onChange={(event) => set('category')(event.currentTarget.value)}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Channel">
          <select
            className={inputClass}
            value={draft.channel}
            onChange={(event) => set('channel')(event.currentTarget.value)}
          >
            <option value="">All channels</option>
            {(Object.keys(CHANNEL_LABELS) as NotificationChannel[]).map((channel) => (
              <option key={channel} value={channel}>
                {CHANNEL_LABELS[channel]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            className={inputClass}
            value={draft.status}
            onChange={(event) => set('status')(event.currentTarget.value)}
          >
            <option value="">All statuses</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input
            type="date"
            className={inputClass}
            value={draft.from}
            onChange={(event) => set('from')(event.currentTarget.value)}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            className={inputClass}
            value={draft.to}
            aria-invalid={rangeInvalid || undefined}
            aria-describedby={rangeInvalid ? 'delivery-log-range-error' : undefined}
            onChange={(event) => set('to')(event.currentTarget.value)}
          />
        </Field>
        <Field label="Recipient name">
          <input
            type="search"
            className={inputClass}
            value={draft.recipient}
            maxLength={100}
            autoComplete="off"
            onChange={(event) => set('recipient')(event.currentTarget.value)}
          />
        </Field>
        <div className="flex flex-wrap items-end gap-2">
          <button type="submit" className={primaryButton} disabled={rangeInvalid}>
            Apply filters
          </button>
          {(filtered || Object.values(draft).some(Boolean)) && (
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                setDraft(NO_FILTERS);
                setFilters(NO_FILTERS);
                setReload((value) => value + 1);
              }}
            >
              Clear
            </button>
          )}
        </div>
        {rangeInvalid && (
          <p
            id="delivery-log-range-error"
            role="alert"
            className="text-sm text-rose-800 sm:col-span-2 lg:col-span-4"
          >
            The start date must not be after the end date.
          </p>
        )}
      </form>

      {state === 'loading' ? (
        <LoadingText>Loading deliveries…</LoadingText>
      ) : state === 'error' && items.length === 0 ? (
        <ErrorState
          title="The delivery log could not be loaded"
          message={error ?? 'Unable to load the delivery log.'}
          action={{ label: 'Try again', onClick: () => setReload((value) => value + 1) }}
        />
      ) : items.length === 0 ? (
        <EmptyState>
          {filtered
            ? 'No deliveries match these filters.'
            : 'No deliveries have been recorded yet.'}
        </EmptyState>
      ) : (
        <>
          <TableScroll label="Notification deliveries">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <caption className="sr-only">
                Notification deliveries, newest first. Select a delivery to see its attempts.
              </caption>
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-2">
                    Recorded
                  </th>
                  <th scope="col" className="px-4 py-2">
                    Event
                  </th>
                  <th scope="col" className="px-4 py-2">
                    Recipient
                  </th>
                  <th scope="col" className="px-4 py-2">
                    Channel
                  </th>
                  <th scope="col" className="px-4 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((delivery) => {
                  const detail = statusDetail(delivery);
                  return (
                    <tr key={delivery.id}>
                      <td className="whitespace-nowrap px-4 py-2 text-slate-800">
                        {dateTimeText(delivery.createdAt)}
                      </td>
                      <td className="px-4 py-2 text-slate-800">
                        <span className="block font-medium">{typeLabel(delivery.type)}</span>
                        <span className="block text-xs text-slate-500">
                          {CATEGORY_LABELS[delivery.category]}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-slate-800">{delivery.recipientName}</td>
                      <td className="px-4 py-2 text-slate-800">
                        {CHANNEL_LABELS[delivery.channel]}
                      </td>
                      <td className="px-4 py-2 text-slate-800">
                        <DeliveryStatusBadge status={delivery.status} />
                        {detail && (
                          <span className="mt-1 block text-xs text-slate-600">{detail}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {delivery.channel === 'EMAIL' && (
                          <button
                            type="button"
                            className={secondaryButton}
                            aria-label={`Attempts for ${typeLabel(delivery.type)} to ${delivery.recipientName}`}
                            onClick={() => setSelected(delivery)}
                          >
                            Attempts
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
          {state === 'error' && error && (
            <p role="alert" className="text-sm text-rose-800">
              {error}
            </p>
          )}
          {nextCursor && (
            <button
              type="button"
              className={secondaryButton}
              disabled={state === 'more'}
              onClick={() => void loadMore()}
            >
              {state === 'more' ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
      <AttemptsDialog delivery={selected} onClose={() => setSelected(null)} />
    </section>
  );
}

function AttemptsDialog({ delivery, onClose }: { delivery: DeliveryView | null; onClose(): void }) {
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!delivery) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setDetail(null);
      setError(null);
      notificationsApi
        .delivery(delivery.id)
        .then((result) => active && setDetail(result))
        .catch(
          (cause) =>
            active && setError(notificationsErrorMessage(cause, 'Unable to load the attempts.')),
        );
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [delivery]);
  return (
    <ViewDialog
      open={delivery !== null}
      title="Delivery attempts"
      size="lg"
      description={
        delivery
          ? `${typeLabel(delivery.type)} to ${delivery.recipientName} by email, recorded ${dateTimeText(delivery.createdAt)}.`
          : undefined
      }
      onClose={onClose}
    >
      {error ? (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </p>
      ) : !detail ? (
        <LoadingText>Loading attempts…</LoadingText>
      ) : (
        <>
          <p className="text-sm text-slate-700">
            Status: <DeliveryStatusBadge status={detail.status} />
            {statusDetail(detail) ? ` — ${statusDetail(detail)}` : ''}
          </p>
          {detail.attempts.length === 0 ? (
            <EmptyState>
              {detail.status === 'SUPPRESSED'
                ? 'No send was attempted: the email was suppressed.'
                : 'No attempt yet.'}
            </EmptyState>
          ) : (
            <TableScroll label="Delivery attempts" bare>
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <caption className="sr-only">Attempts of this email delivery, in order</caption>
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                  <tr>
                    <th scope="col" className="px-3 py-2">
                      #
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Outcome
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Provider
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Started
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Finished
                    </th>
                    <th scope="col" className="px-3 py-2">
                      Error
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.attempts.map((attempt) => (
                    <tr key={attempt.attemptNumber}>
                      <td className="px-3 py-2">{attempt.attemptNumber}</td>
                      <td className="px-3 py-2">{OUTCOME_LABELS[attempt.outcome]}</td>
                      <td className="px-3 py-2">{attempt.provider}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {dateTimeText(attempt.startedAt)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {dateTimeText(attempt.finishedAt)}
                      </td>
                      <td className="px-3 py-2">{attempt.errorCode ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
          <p className="text-xs text-slate-500">
            An attempt marked delivered means the email provider accepted the message. Abandoned and
            unknown outcomes may still have been delivered.
          </p>
        </>
      )}
    </ViewDialog>
  );
}
