'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { notificationsApi } from '../../lib/notifications/api';
import { notificationsErrorMessage } from '../../lib/notifications/errors';
import type {
  NotificationCategory,
  NotificationsOrganization,
  OrganizationNotificationSettings,
  TemplateEntry,
  TemplatePreview,
  TemplateView,
} from '../../lib/notifications/types';
import {
  CATEGORY_LABELS,
  CategoryBadge,
  checkbox,
  EmptyState,
  Field,
  inputClass,
  LockedBadge,
  MANDATORY_EXPLANATION,
  MandatoryBadge,
  NOTIFICATION_ADMIN_KEYS,
  primaryButton,
  secondaryButton,
  Section,
} from './notifications-shared';
import { LoadingState, LoadingText } from '../ui/states';
import { useTabParam } from '../../lib/navigation/use-tab-param';
import { PageContainer } from '../ui/page-container';
import { RequirePermission } from '../ui/require-permission';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import { ConfirmButton } from '../ui/confirm-button';
import { DeliveryLogTab } from './notification-delivery-log';

type Tab = 'templates' | 'settings' | 'deliveries';
const TAB_IDS: readonly Tab[] = ['templates', 'settings', 'deliveries'];
type Mutate = (action: () => Promise<unknown>, message: string) => Promise<boolean>;

export const PREVIEW_DELAY_MS = 300;
const SUBJECT_MAX = 200;
const BODY_MAX = 2000;

/**
 * Notifications administration: organization template overrides (system defaults are
 * read-only), organization email settings and (Batch 8) the read-only delivery log. Visible
 * with notification.template.manage, notification.settings.manage or
 * notification.delivery.read; each organization's `actions` decide the tabs it offers.
 */
export function NotificationsAdminPage() {
  // Batch 10E-2: checking, denied and loaded all render in the page's own (wide) width.
  return (
    <RequirePermission
      anyOf={NOTIFICATION_ADMIN_KEYS}
      width="wide"
      deniedMessage="You do not have permission to manage notifications."
    >
      <NotificationsAdmin />
    </RequirePermission>
  );
}

/** Loads data for a tab; reloaded whenever `load` changes (or the tab remounts). */
function useData<T>(load: () => Promise<T>, onError: (message: string) => void) {
  const [state, setState] = useState<{ data: T | null; loaded: boolean }>({
    data: null,
    loaded: false,
  });
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      load()
        .then((data) => {
          if (active) setState({ data, loaded: true });
        })
        .catch((cause) => {
          if (!active) return;
          onError(notificationsErrorMessage(cause));
          setState({ data: null, loaded: true });
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, onError]);
  return state;
}

const Loading = LoadingText;

function NotificationsAdmin() {
  const [organizations, setOrganizations] = useState<NotificationsOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  // Batch 10E-2: /admin/notifications#deliveries deep-links a section; picking one writes it.
  const [tab, setTab] = useTabParam<Tab>(TAB_IDS, 'templates', { writeHash: true });
  const tabIdBase = useTabIdBase('notifications-admin');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      notificationsApi
        .organizations()
        .then((result) => {
          setOrganizations(result.items);
          setOrganizationId((current) => current || result.items[0]?.id || '');
        })
        .catch((cause) =>
          setError(notificationsErrorMessage(cause, 'Unable to load organizations.')),
        )
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const onError = useCallback((message: string) => setError(message), []);
  const organization = organizations.find((o) => o.id === organizationId);
  const actions = organization?.actions;

  const mutate: Mutate = async (action, message) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      setSuccess(message);
      setVersion((v) => v + 1);
      return true;
    } catch (cause) {
      setError(notificationsErrorMessage(cause, 'Unable to complete the notifications action.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<{ id: Tab; label: string }> = [];
  if (actions?.canManageTemplates) tabs.push({ id: 'templates', label: 'Templates' });
  if (actions?.canManageSettings) tabs.push({ id: 'settings', label: 'Email settings' });
  if (actions?.canReadDeliveries) tabs.push({ id: 'deliveries', label: 'Delivery log' });
  const active: Tab | undefined = tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id;
  const key = `${organizationId}-${version}`;

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Notifications"
        title="Notifications administration"
        description="Customize the wording of notifications for an organization, decide which categories are emailed and review what was delivered. System default templates are maintained by the platform and cannot be edited."
      >
        {organizations.length > 1 && (
          <label
            className="text-sm font-medium text-slate-800"
            htmlFor="notifications-admin-organization"
          >
            Organization
            <select
              id="notifications-admin-organization"
              className={inputClass}
              value={organizationId}
              onChange={(event) => {
                setSuccess(null);
                setError(null);
                setOrganizationId(event.currentTarget.value);
              }}
            >
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </PageHeader>
      <div className="mt-6 space-y-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {loading ? (
          <LoadingState label="Loading notifications administration…" />
        ) : organizations.length === 0 || !active ? (
          <EmptyState>
            No organizations are within your notifications administration access.
          </EmptyState>
        ) : (
          <>
            {tabs.length > 1 ? (
              <>
                <TabList<Tab>
                  tabs={tabs}
                  active={active}
                  onChange={setTab}
                  label="Notifications sections"
                  idBase={tabIdBase}
                />
                <TabPanel idBase={tabIdBase} id={active}>
                  <div className="space-y-4">
                    {active === 'templates' && (
                      <TemplatesTab
                        key={key}
                        organizationId={organizationId}
                        busy={busy}
                        mutate={mutate}
                        onError={onError}
                      />
                    )}
                    {active === 'settings' && (
                      <SettingsTab
                        key={key}
                        organizationId={organizationId}
                        busy={busy}
                        mutate={mutate}
                        onError={onError}
                      />
                    )}
                    {active === 'deliveries' && (
                      <DeliveryLogTab key={organizationId} organizationId={organizationId} />
                    )}
                  </div>
                </TabPanel>
              </>
            ) : (
              <>
                {active === 'templates' && (
                  <TemplatesTab
                    key={key}
                    organizationId={organizationId}
                    busy={busy}
                    mutate={mutate}
                    onError={onError}
                  />
                )}
                {active === 'settings' && (
                  <SettingsTab
                    key={key}
                    organizationId={organizationId}
                    busy={busy}
                    mutate={mutate}
                    onError={onError}
                  />
                )}
                {active === 'deliveries' && (
                  <DeliveryLogTab key={organizationId} organizationId={organizationId} />
                )}
              </>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}

// ─── Templates ──────────────────────────────────────────────────────────────

function TemplatesTab({
  organizationId,
  busy,
  mutate,
  onError,
}: {
  organizationId: string;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
}) {
  const load = useCallback(() => notificationsApi.templates(organizationId), [organizationId]);
  const { data, loaded } = useData(load, onError);
  const [editing, setEditing] = useState<string | null>(null);
  if (!loaded) return <Loading />;
  const items = data?.items ?? [];
  if (items.length === 0) return <EmptyState>No notification types are available.</EmptyState>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Each notification type has a system default. A custom template replaces it for this
        organization; archive the custom template to return to the default. Templates are plain
        text: use only the listed {'{{variables}}'} and no links.
      </p>
      {items.map((entry) => (
        <TemplateCard
          key={entry.key}
          entry={entry}
          organizationId={organizationId}
          editing={editing === entry.key}
          onEdit={() => setEditing(entry.key)}
          onCancel={() => setEditing(null)}
          busy={busy}
          mutate={mutate}
        />
      ))}
    </div>
  );
}

function TemplateText({ template, label }: { template: TemplateView; label: string }) {
  return (
    <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <dl className="space-y-1 text-sm">
        <div>
          <dt className="sr-only">Subject</dt>
          <dd className="font-medium text-slate-900">{template.subjectTemplate}</dd>
        </div>
        <div>
          <dt className="sr-only">Body</dt>
          <dd className="whitespace-pre-line text-slate-700">{template.bodyTemplate}</dd>
        </div>
      </dl>
    </div>
  );
}

function VariableList({ entry }: { entry: TemplateEntry }) {
  return (
    <div className="text-sm text-slate-700">
      <span className="font-medium">Allowed variables: </span>
      {entry.allowedVariables.length === 0 ? (
        <span>none</span>
      ) : (
        <ul
          aria-label={`Allowed variables for ${entry.key}`}
          className="inline-flex flex-wrap gap-1.5"
        >
          {entry.allowedVariables.map((name) => (
            <li key={name}>
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-800">{`{{${name}}}`}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TemplateCard({
  entry,
  organizationId,
  editing,
  onEdit,
  onCancel,
  busy,
  mutate,
}: {
  entry: TemplateEntry;
  organizationId: string;
  editing: boolean;
  onEdit(): void;
  onCancel(): void;
  busy: boolean;
  mutate: Mutate;
}) {
  const override = entry.override;
  return (
    <Section
      title={entry.key}
      actions={
        !editing && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              aria-label={`${override ? 'Edit custom template' : 'Customize'} ${entry.key}`}
              onClick={onEdit}
            >
              {override ? 'Edit custom template' : 'Customize'}
            </button>
            {override && (
              <ConfirmButton
                className={secondaryButton}
                disabled={busy}
                aria-label={`Archive custom template ${entry.key}`}
                confirm={{
                  title: `Archive the custom template for ${entry.key}?`,
                  description: 'Notifications of this kind use the system default text again.',
                  confirmLabel: 'Archive custom template',
                }}
                onConfirm={() =>
                  void mutate(
                    () => notificationsApi.archiveTemplate(override.id),
                    `Custom template for ${entry.key} archived; the system default applies again.`,
                  )
                }
              >
                Archive custom template
              </ConfirmButton>
            )}
          </div>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <CategoryBadge category={entry.category} />
        {entry.mandatory && <MandatoryBadge />}
        {override ? (
          <span className="text-xs text-slate-600">
            Custom template · version {override.version}
          </span>
        ) : (
          <span className="text-xs text-slate-600">Using the system default</span>
        )}
      </div>
      <VariableList entry={entry} />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TemplateText template={entry.system} label="System default (read-only)" />
        {override && <TemplateText template={override} label="Custom template" />}
      </div>
      {editing && (
        <TemplateEditor
          entry={entry}
          organizationId={organizationId}
          busy={busy}
          mutate={mutate}
          onDone={onCancel}
        />
      )}
    </Section>
  );
}

function TemplateEditor({
  entry,
  organizationId,
  busy,
  mutate,
  onDone,
}: {
  entry: TemplateEntry;
  organizationId: string;
  busy: boolean;
  mutate: Mutate;
  onDone(): void;
}) {
  const base = entry.override ?? entry.system;
  const [subject, setSubject] = useState(base.subjectTemplate);
  const [body, setBody] = useState(base.bodyTemplate);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      if (!subject.trim() || !body.trim()) {
        setPreview(null);
        setPreviewError('Enter a subject and a body to see a preview.');
        return;
      }
      notificationsApi
        .preview({ organizationId, key: entry.key, subjectTemplate: subject, bodyTemplate: body })
        .then((result) => {
          if (!active) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((cause) => {
          if (!active) return;
          setPreview(null);
          setPreviewError(notificationsErrorMessage(cause, 'Unable to preview the template.'));
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId, entry.key, subject, body]);

  const override = entry.override;

  async function save() {
    const saved = await mutate(
      () =>
        override
          ? notificationsApi.updateTemplate(override.id, {
              subjectTemplate: subject.trim(),
              bodyTemplate: body.trim(),
            })
          : notificationsApi.createTemplate({
              organizationId,
              key: entry.key,
              subjectTemplate: subject.trim(),
              bodyTemplate: body.trim(),
            }),
      override
        ? `Custom template for ${entry.key} saved.`
        : `Custom template for ${entry.key} created.`,
    );
    if (saved) onDone();
  }

  return (
    <form
      aria-label={`Edit template ${entry.key}`}
      className="space-y-3 rounded-lg border border-indigo-200 bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-sm text-slate-600">
        {override
          ? 'Editing the organization’s custom template.'
          : 'Creating a custom template for this organization, starting from the system default.'}
      </p>
      <Field label="Subject">
        <input
          className={inputClass}
          value={subject}
          maxLength={SUBJECT_MAX}
          required
          onChange={(event) => setSubject(event.currentTarget.value)}
        />
      </Field>
      <Field label="Body">
        <textarea
          className={inputClass}
          rows={4}
          value={body}
          maxLength={BODY_MAX}
          required
          onChange={(event) => setBody(event.currentTarget.value)}
        />
      </Field>
      <VariableList entry={entry} />
      <section
        aria-label={`Preview ${entry.key}`}
        aria-live="polite"
        className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3"
      >
        <p className="text-xs font-semibold uppercase text-slate-500">Preview with sample values</p>
        {previewError ? (
          <p className="text-sm text-rose-800">{previewError}</p>
        ) : preview ? (
          <>
            <p className="text-sm font-medium text-slate-900">{preview.subject}</p>
            <p className="whitespace-pre-line text-sm text-slate-700">{preview.body}</p>
          </>
        ) : (
          <p className="text-sm text-slate-600">Rendering preview…</p>
        )}
      </section>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>
          {override ? 'Save custom template' : 'Create custom template'}
        </button>
        <button type="button" className={secondaryButton} disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

function SettingsTab({
  organizationId,
  busy,
  mutate,
  onError,
}: {
  organizationId: string;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
}) {
  const load = useCallback(() => notificationsApi.settings(organizationId), [organizationId]);
  const { data, loaded } = useData(load, onError);
  if (!loaded) return <Loading />;
  if (!data) return <EmptyState>The email settings could not be loaded.</EmptyState>;
  return <SettingsForm settings={data} busy={busy} mutate={mutate} />;
}

function SettingsForm({
  settings,
  busy,
  mutate,
}: {
  settings: OrganizationNotificationSettings;
  busy: boolean;
  mutate: Mutate;
}) {
  const [emailEnabled, setEmailEnabled] = useState(settings.emailEnabled);
  const [suppress, setSuppress] = useState(settings.suppressMandatoryEmail);
  const [categories, setCategories] = useState<Partial<Record<NotificationCategory, boolean>>>(
    Object.fromEntries(settings.categories.map((c) => [c.category, c.emailEnabled])),
  );
  const configurable = settings.categories.filter((c) => c.configurable && !c.mandatory);

  function save() {
    void mutate(
      () =>
        notificationsApi.updateSettings({
          organizationId: settings.organizationId,
          emailEnabled,
          suppressMandatoryEmail: emailEnabled ? false : suppress,
          categories: configurable.map((c) => ({
            category: c.category,
            emailEnabled: categories[c.category] ?? c.emailEnabled,
          })),
        }),
      'Notification email settings saved.',
    );
  }

  return (
    <form
      aria-label="Organization email settings"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Section title="Organization email">
        <p className="text-sm text-slate-600">
          In-app notifications are always delivered. These settings decide which notifications are
          also emailed to people in this organization.
        </p>
        <label className="flex items-center gap-3 text-sm font-medium text-slate-800">
          <input
            type="checkbox"
            className={checkbox}
            checked={emailEnabled}
            disabled={busy}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setEmailEnabled(checked);
              if (checked) setSuppress(false);
            }}
          />
          Send notification email for this organization
        </label>
        {!emailEnabled && (
          <div
            role="note"
            className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            <p>
              Email is turned off for this organization. Optional notifications are not emailed;
              mandatory notices (security and required HR notices) are still emailed unless you also
              suppress them.
            </p>
            <label className="flex items-center gap-3 font-medium">
              <input
                type="checkbox"
                className={checkbox}
                checked={suppress}
                disabled={busy}
                onChange={(event) => setSuppress(event.currentTarget.checked)}
              />
              Also suppress mandatory email
            </label>
            {suppress && (
              <p
                role="alert"
                className="rounded-lg border border-rose-300 bg-rose-50 p-2 text-rose-900"
              >
                Warning: people will not receive security or required HR notices by email. They will
                only see them in the app.
              </p>
            )}
          </div>
        )}
      </Section>
      <Section title="Email by category">
        <p className="text-sm text-slate-600">{MANDATORY_EXPLANATION}</p>
        {!emailEnabled && (
          <p className="text-sm text-slate-600">
            Category settings take effect when organization email is turned on.
          </p>
        )}
        <ul className="divide-y divide-slate-100">
          {settings.categories.map((c) => {
            const locked = c.mandatory || !c.configurable;
            const id = `org-email-${c.category}`;
            return (
              <li
                key={c.category}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <label htmlFor={id} className="flex items-center gap-3 text-sm text-slate-800">
                  <input
                    id={id}
                    type="checkbox"
                    className={checkbox}
                    checked={
                      locked
                        ? emailEnabled || !suppress
                        : (categories[c.category] ?? c.emailEnabled)
                    }
                    disabled={locked || busy}
                    aria-describedby={locked ? `${id}-locked` : undefined}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setCategories((current) => ({ ...current, [c.category]: checked }));
                    }}
                  />
                  {`Email for ${CATEGORY_LABELS[c.category]}`}
                </label>
                {locked && (
                  <span
                    id={`${id}-locked`}
                    className="flex items-center gap-2 text-xs text-slate-600"
                  >
                    <LockedBadge />
                    Mandatory — only the organization email switch above can stop it
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </Section>
      <button type="submit" className={primaryButton} disabled={busy}>
        Save email settings
      </button>
    </form>
  );
}
