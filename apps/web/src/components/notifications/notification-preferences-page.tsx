'use client';

import { PageContainer } from '../ui/page-container';
import { useEffect, useState, type FormEvent } from 'react';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { notificationsApi } from '../../lib/notifications/api';
import { notificationsErrorMessage } from '../../lib/notifications/errors';
import type { CategoryEmailSetting } from '../../lib/notifications/types';
import {
  CATEGORY_LABELS,
  checkbox,
  LockedBadge,
  MANDATORY_EXPLANATION,
  primaryButton,
  Section,
} from './notifications-shared';

/**
 * The signed-in user's email preferences per notification category. In-app notifications are
 * always on; mandatory categories (security, required HR notices) are shown locked.
 */
export function NotificationPreferencesPage() {
  const [items, setItems] = useState<CategoryEmailSetting[]>([]);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const apply = (next: CategoryEmailSetting[]) => {
    setItems(next);
    setDraft(Object.fromEntries(next.map((item) => [item.category, item.emailEnabled])));
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      notificationsApi
        .preferences()
        .then((result) => apply(result.items))
        .catch((cause) =>
          setError(
            notificationsErrorMessage(cause, 'Unable to load your notification preferences.'),
          ),
        )
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const configurable = items.filter((item) => item.configurable && !item.mandatory);
  const changed = configurable.some((item) => draft[item.category] !== item.emailEnabled);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await notificationsApi.updatePreferences(
        configurable.map((item) => ({
          category: item.category,
          emailEnabled: draft[item.category] ?? item.emailEnabled,
        })),
      );
      apply(result.items);
      setSuccess('Email preferences saved.');
    } catch (cause) {
      setError(notificationsErrorMessage(cause, 'Unable to save your notification preferences.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer width="narrow">
      <PageHeader
        eyebrow="Notifications"
        title="Notification preferences"
        description="Choose which notifications you also receive by email."
      />
      <div className="mt-6 space-y-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        <p
          role="note"
          className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900"
        >
          In-app notifications are always on: everything appears in your notification center. Your
          organization may also turn email off for a category or altogether.
        </p>
        {loading ? (
          <p role="status" className="text-sm text-slate-600">
            Loading preferences…
          </p>
        ) : (
          items.length > 0 && (
            <form aria-label="Email preferences" onSubmit={(event) => void save(event)}>
              <Section title="Email by category">
                <p className="text-sm text-slate-600">{MANDATORY_EXPLANATION}</p>
                <ul className="divide-y divide-slate-100">
                  {items.map((item) => {
                    const locked = item.mandatory || !item.configurable;
                    const id = `email-${item.category}`;
                    return (
                      <li
                        key={item.category}
                        className="flex flex-wrap items-center justify-between gap-3 py-3"
                      >
                        <label
                          htmlFor={id}
                          className="flex items-center gap-3 text-sm text-slate-800"
                        >
                          <input
                            id={id}
                            type="checkbox"
                            className={checkbox}
                            checked={locked ? true : (draft[item.category] ?? item.emailEnabled)}
                            disabled={locked || busy}
                            aria-describedby={locked ? `${id}-locked` : undefined}
                            onChange={(event) => {
                              const checked = event.currentTarget.checked;
                              setDraft((current) => ({ ...current, [item.category]: checked }));
                            }}
                          />
                          {`Email for ${CATEGORY_LABELS[item.category]}`}
                        </label>
                        {locked && (
                          <span
                            id={`${id}-locked`}
                            className="flex items-center gap-2 text-xs text-slate-600"
                          >
                            <LockedBadge />
                            Mandatory — always emailed
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div>
                  <button type="submit" className={primaryButton} disabled={busy || !changed}>
                    Save preferences
                  </button>
                </div>
              </Section>
            </form>
          )
        )}
      </div>
    </PageContainer>
  );
}
