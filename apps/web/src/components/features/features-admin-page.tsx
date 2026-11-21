'use client';

import { checkboxClass } from '../ui/tokens';

import { DataTable } from '../ui/data-table';
import { PageContainer } from '../ui/page-container';
import { enumLabel } from '../../lib/ui/labels';
import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Forbidden } from '../auth/forbidden';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { EmptyState, inputClass, primaryButton, secondaryButton } from '../payroll/payroll-shared';
import { dateTimeText, Section } from '../recruitment/recruitment-shared';
import { hasPermission } from '../../lib/authorization/can';
import { featuresApi } from '../../lib/features/api';
import {
  featuresErrorMessage,
  isFeatureVersionConflict,
  moduleLabel,
  moduleList,
} from '../../lib/features/errors';
import {
  integerRangeText,
  isRetentionSetting,
  parseIntegerSetting,
  RETENTION_HELP,
  settingSectionLabel,
} from '../../lib/features/settings';
import { FEATURE_PERMISSION_KEYS } from '../../lib/features/types';
import type {
  FeatureChange,
  FeaturesOrganization,
  FeaturesOverview,
  GoogleWorkspaceSummary,
  Linked,
  LinkedUnavailableReason,
  ModuleState,
  NotificationsSummary,
  SettingSection,
  SettingState,
  SettingValue,
  TimeAttendanceSummary,
} from '../../lib/features/types';
import { useAuth } from '../../providers/auth-provider';
import { LoadingText } from '../ui/states';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { FormDialog } from '../ui/form-dialog';

export const HISTORY_PAGE_SIZE = 20;

export const DISABLE_CONSEQUENCES =
  'Data is kept. Users lose access until it is re-enabled, and scheduled jobs skip this organization.';

type Mutate = (action: () => Promise<unknown>, message: string) => Promise<boolean>;

const badge = 'inline-flex rounded-full px-2.5 py-1 text-xs font-medium';
/** Batch 10F: the shared 24 px checkbox (module and setting switches). */
const switchClass = checkboxClass;

/**
 * Settings & features (/admin/settings): per-organization module switches (with their
 * dependencies), typed organization settings, links to the existing time & attendance,
 * notification and Google Workspace administration, and the change history. Visible with
 * feature.read or feature.manage; the overview's `canManage` decides whether anything can change.
 */
export function FeaturesAdminPage() {
  const { authorization, authorizationLoading } = useAuth();
  if (authorizationLoading) {
    return (
      <PageContainer width="wide">
        <Loading />
      </PageContainer>
    );
  }
  if (!FEATURE_PERMISSION_KEYS.some((key) => hasPermission(authorization, key))) {
    return (
      <PageContainer width="wide" padded={false}>
        <Forbidden message="You do not have permission to manage features." />
      </PageContainer>
    );
  }
  return <FeaturesAdmin />;
}

const Loading = LoadingText;

function FeaturesAdmin() {
  const [organizations, setOrganizations] = useState<FeaturesOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [loadingOrganizations, setLoadingOrganizations] = useState(true);
  const [overview, setOverview] = useState<FeaturesOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped after every change (or conflict) to reload the overview and the history. */
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      featuresApi
        .organizations()
        .then((result) => {
          setOrganizations(result.items);
          setOrganizationId((current) => current || result.items[0]?.id || '');
        })
        .catch((cause) => setError(featuresErrorMessage(cause, 'Unable to load organizations.')))
        .finally(() => setLoadingOrganizations(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      featuresApi
        .overview(organizationId)
        .then((result) => {
          if (active) setOverview(result);
        })
        .catch((cause) => {
          if (!active) return;
          setOverview(null);
          setError(featuresErrorMessage(cause));
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId, revision]);

  const mutate: Mutate = async (action, message) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      setSuccess(message);
      setRevision((value) => value + 1);
      return true;
    } catch (cause) {
      setError(featuresErrorMessage(cause, 'Unable to save the change.'));
      // A conflict means the loaded state is stale: reload what is current.
      if (isFeatureVersionConflict(cause) || (cause as { status?: number })?.status === 409) {
        setRevision((value) => value + 1);
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const current = overview && overview.organization.id === organizationId ? overview : null;
  const canManage = current?.canManage ?? false;

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Administration"
        title="Settings & features"
        description="Turn optional modules on or off for an organization and tune its behaviour. Core HR is always on. Turning a module off keeps its data; it only removes access until it is turned back on."
      >
        {organizations.length > 1 && (
          <label className="text-sm font-medium text-slate-800" htmlFor="features-organization">
            Organization
            <select
              id="features-organization"
              className={inputClass}
              value={organizationId}
              onChange={(event) => {
                setError(null);
                setSuccess(null);
                setOrganizationId(event.currentTarget.value);
              }}
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </PageHeader>
      <div className="mt-6 space-y-6">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {loadingOrganizations ? (
          <Loading>Loading features…</Loading>
        ) : organizations.length === 0 ? (
          <EmptyState>No organizations are within your settings administration access.</EmptyState>
        ) : !current ? (
          error ? null : (
            <Loading>Loading features…</Loading>
          )
        ) : (
          <>
            {!canManage && (
              <p
                role="note"
                className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"
              >
                You can view the settings of {current.organization.name} but not change them.
              </p>
            )}
            <CoreSection core={current.core} />
            <ModulesSection overview={current} canManage={canManage} busy={busy} mutate={mutate} />
            <SettingsSection
              overview={current}
              canManage={canManage}
              canRelax={current.canRelaxGuardedSettings === true}
              busy={busy}
              mutate={mutate}
            />
            <LinkedSection linked={current.linked} />
            <HistorySection
              key={`${organizationId}-${revision}`}
              organizationId={organizationId}
              overview={current}
            />
          </>
        )}
      </div>
    </PageContainer>
  );
}

// ─── Core ───────────────────────────────────────────────────────────────────

function CoreSection({ core }: { core: string[] }) {
  return (
    <Section title="Core HR (always on)">
      <p className="text-sm text-slate-600">
        These areas are the foundation of the HRMS and cannot be turned off.
      </p>
      <ul aria-label="Core HR areas" className="flex flex-wrap gap-2">
        {core.map((area) => (
          <li key={area} className={`${badge} bg-slate-100 text-slate-800`}>
            {area}
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ─── Modules ────────────────────────────────────────────────────────────────

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className={`${badge} bg-emerald-50 text-emerald-800`}>On</span>
  ) : (
    <span className={`${badge} bg-slate-200 text-slate-700`}>Off</span>
  );
}

/** Why the switch of a module cannot be used right now (null when it can). */
export function moduleLockReason(module: ModuleState, modules: ModuleState[]): string | null {
  if (!module.enabled && module.blockedBy.length > 0) {
    return `Turn on ${moduleList(module.blockedBy)} first: ${module.name} requires ${
      module.blockedBy.length > 1 ? 'them' : 'it'
    }.`;
  }
  if (module.enabled) {
    const enabledDependents = module.dependents.filter(
      (dependent) => modules.find((m) => m.module === dependent)?.enabled ?? true,
    );
    if (enabledDependents.length > 0) {
      return `Turn off ${moduleList(enabledDependents)} first: ${
        enabledDependents.length > 1 ? 'they depend' : 'it depends'
      } on ${module.name}.`;
    }
  }
  return null;
}

function ModulesSection({
  overview,
  canManage,
  busy,
  mutate,
}: {
  overview: FeaturesOverview;
  canManage: boolean;
  busy: boolean;
  mutate: Mutate;
}) {
  const [confirming, setConfirming] = useState<ModuleState | null>(null);
  const organizationId = overview.organization.id;

  const change = (module: ModuleState, enabled: boolean) =>
    mutate(
      () =>
        featuresApi.setModule(module.module, {
          organizationId,
          enabled,
          expectedVersion: module.version,
        }),
      `${module.name} turned ${enabled ? 'on' : 'off'}.`,
    );

  return (
    <Section title="Modules">
      <ul className="divide-y divide-slate-100">
        {overview.modules.map((module) => {
          const lock = moduleLockReason(module, overview.modules);
          const hintId = `module-${module.module}-hint`;
          return (
            <li
              key={module.module}
              aria-label={`Module ${module.name}`}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium text-slate-900">{module.name}</h3>
                  <EnabledBadge enabled={module.enabled} />
                  {module.isDefault && (
                    <span className={`${badge} bg-slate-100 text-slate-600`}>Default</span>
                  )}
                </div>
                <p className="text-sm text-slate-600">{module.description}</p>
                {module.requires.length > 0 && (
                  <p className="text-xs text-slate-600">Requires: {moduleList(module.requires)}</p>
                )}
                {module.dependents.length > 0 && (
                  <p className="text-xs text-slate-600">
                    Required by: {moduleList(module.dependents)}
                  </p>
                )}
                {canManage && lock && (
                  <p id={hintId} className="text-xs text-amber-800">
                    {lock}
                  </p>
                )}
              </div>
              <label className="inline-flex shrink-0 items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  role="switch"
                  className={switchClass}
                  aria-label={`${module.name} enabled`}
                  aria-describedby={canManage && lock ? hintId : undefined}
                  checked={module.enabled}
                  disabled={!canManage || busy || lock !== null}
                  onChange={(event) => {
                    if (event.currentTarget.checked) void change(module, true);
                    else setConfirming(module);
                  }}
                />
                {module.enabled ? 'Enabled' : 'Disabled'}
              </label>
            </li>
          );
        })}
      </ul>
      {confirming && (
        <ConfirmDialog
          open
          title={`Turn off ${confirming.name}?`}
          description={
            <>
              <p>{DISABLE_CONSEQUENCES}</p>
              <p className="mt-2">You can turn {confirming.name} back on at any time.</p>
            </>
          }
          confirmLabel={`Turn off ${confirming.name}`}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const target = confirming;
            setConfirming(null);
            void change(target, false);
          }}
        />
      )}
    </Section>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

export function settingValueText(setting: Pick<SettingState, 'type'>, value: SettingValue | null) {
  if (value === null) return 'Default';
  if (setting.type.kind === 'boolean' || typeof value === 'boolean') return value ? 'On' : 'Off';
  if (setting.type.kind === 'enum' && typeof value === 'string') return enumLabel(value);
  return String(value);
}

function SettingsSection({
  overview,
  canManage,
  canRelax,
  busy,
  mutate,
}: {
  overview: FeaturesOverview;
  canManage: boolean;
  /** M2: may relax a guarded setting (a SYSTEM administrator). */
  canRelax: boolean;
  busy: boolean;
  mutate: Mutate;
}) {
  const sections: SettingSection[] = [];
  for (const setting of overview.settings) {
    if (!sections.includes(setting.section)) sections.push(setting.section);
  }
  return (
    <Section title="Settings">
      {sections.length === 0 ? (
        <EmptyState>There are no configurable settings.</EmptyState>
      ) : (
        <div className="space-y-5">
          {sections.map((section) => {
            const owner = overview.modules.find((m) => m.module === section);
            return (
              <div
                key={section}
                role="group"
                aria-label={`${settingSectionLabel(section)} settings`}
                className="space-y-2"
              >
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  {settingSectionLabel(section)}
                </h3>
                {owner && !owner.enabled && (
                  <p className="text-xs text-amber-800">
                    {owner.name} is turned off: these settings take effect when it is turned on
                    again.
                  </p>
                )}
                <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {overview.settings
                    .filter((setting) => setting.section === section)
                    .map((setting) => (
                      <SettingRow
                        key={`${setting.key}-${setting.version}`}
                        setting={setting}
                        organizationId={overview.organization.id}
                        canManage={canManage}
                        canRelax={canRelax}
                        busy={busy}
                        mutate={mutate}
                      />
                    ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/**
 * Security remediation M2 — the wording of guarded settings (relaxing one needs a SYSTEM
 * administrator, a reason and a confirmation; the server enforces all three).
 */
const GUARDED_TEXT: Record<
  string,
  { title: string; consequence: string; acknowledgement: string; submit: string }
> = {
  'payroll.dualControl': {
    title: 'Turn off payroll dual control?',
    consequence:
      'One person will be able to prepare and approve payroll in this organization. The change, your reason and your name are recorded in the audit trail, and every payroll run will show that dual control is off.',
    acknowledgement: 'I understand one person will be able to prepare and approve payroll.',
    submit: 'Turn off dual control',
  },
};

function SettingRow({
  setting,
  organizationId,
  canManage,
  canRelax,
  busy,
  mutate,
}: {
  setting: SettingState;
  organizationId: string;
  canManage: boolean;
  canRelax: boolean;
  busy: boolean;
  mutate: Mutate;
}) {
  const [draft, setDraft] = useState(String(setting.value));
  const [relaxing, setRelaxing] = useState(false);
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const disabled = !canManage || busy;
  // M2: turning a guarded control off is for a SYSTEM administrator, with a reason.
  const guardedOn = setting.guarded === true && setting.value === true;
  const guardedText = GUARDED_TEXT[setting.key] ?? {
    title: `Turn off ${setting.name}?`,
    consequence: 'This relaxes a security control. The change and your reason are audited.',
    acknowledgement: 'I understand the consequence of turning this off.',
    submit: 'Turn off',
  };
  const save = (value: SettingValue) =>
    mutate(
      () =>
        featuresApi.setSetting(setting.key, {
          organizationId,
          value,
          expectedVersion: setting.version,
        }),
      `${setting.name} saved.`,
    );
  const reset = () =>
    mutate(
      () =>
        featuresApi.resetSetting(setting.key, { organizationId, expectedVersion: setting.version }),
      `${setting.name} reset to its default.`,
    );

  let control: ReactNode;
  const type = setting.type;
  if (type.kind === 'boolean') {
    control = (
      <label className="inline-flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          role="switch"
          className={switchClass}
          aria-label={setting.name}
          checked={setting.value === true}
          disabled={disabled || (guardedOn && !canRelax)}
          onChange={(event) => {
            if (guardedOn && !event.currentTarget.checked) {
              setReason('');
              setAcknowledged(false);
              setRelaxing(true);
              return;
            }
            void save(event.currentTarget.checked);
          }}
        />
        {setting.value === true ? 'On' : 'Off'}
      </label>
    );
  } else {
    let parsed: SettingValue | null = draft;
    let problem: string | null = null;
    if (type.kind === 'integer') {
      const result = parseIntegerSetting(type, draft);
      parsed = result.value;
      problem = result.problem;
    }
    const changed = parsed !== null && parsed !== setting.value;
    control = (
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed !== null && changed) void save(parsed);
        }}
      >
        {type.kind === 'integer' ? (
          <div>
            <input
              type="number"
              className="block w-28 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              aria-label={setting.name}
              min={type.min}
              max={type.max}
              step={1}
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
            <p className="mt-1 text-xs text-slate-500">{integerRangeText(type)}</p>
            {isRetentionSetting(setting.key) && (
              <p className="mt-1 text-xs text-slate-500">{RETENTION_HELP}</p>
            )}
            {problem && canManage && (
              <p role="alert" className="mt-1 text-xs text-rose-800">
                {problem}
              </p>
            )}
          </div>
        ) : (
          <select
            className="block rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            aria-label={setting.name}
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.currentTarget.value)}
          >
            {type.values.map((value) => (
              <option key={value} value={value}>
                {enumLabel(value)}
              </option>
            ))}
          </select>
        )}
        {canManage && (
          <button
            type="submit"
            className={primaryButton}
            disabled={disabled || !changed}
            aria-label={`Save ${setting.name}`}
          >
            Save
          </button>
        )}
      </form>
    );
  }

  return (
    <li
      aria-label={`Setting ${setting.name}`}
      className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="font-medium text-slate-900">{setting.name}</h4>
          {setting.isDefault ? (
            <span className={`${badge} bg-slate-100 text-slate-600`}>Default</span>
          ) : (
            <span className={`${badge} bg-indigo-50 text-indigo-800`}>Customized</span>
          )}
        </div>
        <p className="text-sm text-slate-600">{setting.description}</p>
        {guardedOn && !canRelax && canManage && (
          <p className="text-xs text-slate-600">Only a System administrator can turn this off.</p>
        )}
        <p className="text-xs text-slate-500">
          Default: {settingValueText(setting, setting.default)}
          {setting.updatedAt && ` · Last changed ${dateTimeText(setting.updatedAt)}`}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-start gap-2">
        {control}
        {canManage && (
          <button
            type="button"
            className={secondaryButton}
            disabled={disabled || setting.isDefault}
            aria-label={`Reset ${setting.name} to default`}
            onClick={() => void reset()}
          >
            Reset to default
          </button>
        )}
      </div>
      {setting.guarded && (
        <FormDialog
          open={relaxing}
          title={guardedText.title}
          description={guardedText.consequence}
          submitLabel={guardedText.submit}
          busy={busy}
          canSubmit={reason.trim().length >= 10 && acknowledged}
          error={null}
          tone="destructive"
          onClose={() => setRelaxing(false)}
          onSubmit={() =>
            void mutate(
              () =>
                featuresApi.setSetting(setting.key, {
                  organizationId,
                  value: false,
                  expectedVersion: setting.version,
                  reason: reason.trim(),
                  confirm: true,
                }),
              `${setting.name} turned off.`,
            ).then((saved) => {
              // A refusal keeps the dialog (and the typed reason) open; the page shows why.
              if (saved) setRelaxing(false);
            })
          }
        >
          <label className="block text-sm font-medium text-slate-700">
            Reason
            <textarea
              className={`${inputClass} mt-1 min-h-20`}
              value={reason}
              required
              aria-required="true"
              maxLength={500}
              aria-describedby={`${setting.key}-reason-help`}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </label>
          <p id={`${setting.key}-reason-help`} className="text-xs text-slate-500">
            10 to 500 characters. Recorded in the audit trail.
          </p>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={acknowledged}
              required
              onChange={(event) => setAcknowledged(event.currentTarget.checked)}
            />
            {guardedText.acknowledgement}
          </label>
        </FormDialog>
      )}
    </li>
  );
}

// ─── Linked sections ────────────────────────────────────────────────────────

const UNAVAILABLE_TEXT: Record<LinkedUnavailableReason, string> = {
  FORBIDDEN: 'You do not have permission to view this section.',
  FEATURE_DISABLED: 'This module is turned off for the organization.',
  UNAVAILABLE: 'This section is not available right now.',
};

function LinkedCard<T>({
  title,
  href,
  linkLabel,
  section,
  children,
}: {
  title: string;
  href: string;
  linkLabel: string;
  section: Linked<T>;
  children(summary: T): ReactNode;
}) {
  return (
    <article
      aria-label={title}
      className="flex flex-col justify-between gap-3 rounded-lg border border-slate-200 p-4"
    >
      <div className="space-y-2">
        <h3 className="font-medium text-slate-900">{title}</h3>
        {section.available ? (
          <dl className="space-y-1 text-sm text-slate-700">{children(section as T)}</dl>
        ) : (
          <p className="text-sm text-slate-600">{UNAVAILABLE_TEXT[section.reason]}</p>
        )}
      </div>
      {section.available && (
        <Link href={href} className="text-sm font-medium text-indigo-700 hover:underline">
          {linkLabel}
        </Link>
      )}
    </article>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="text-slate-500">{term}:</dt>
      <dd>{children}</dd>
    </div>
  );
}

const onOff = (value: boolean | null | undefined) =>
  value === null || value === undefined ? 'Not set' : value ? 'On' : 'Off';
const words = (value: string | null | undefined) => (value ? enumLabel(value) : 'Not set');

function LinkedSection({ linked }: { linked: FeaturesOverview['linked'] }) {
  return (
    <Section title="Related settings">
      <p className="text-sm text-slate-600">
        These are managed on their own pages; a summary of the current configuration is shown here.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <LinkedCard<TimeAttendanceSummary>
          title="Time & attendance policy"
          href="/admin/time"
          linkLabel="Manage attendance policies"
          section={linked.timeAttendance}
        >
          {(summary) => (
            <>
              <Row term="Policy layers in effect">
                {summary.currentLayers} of {summary.activeLayers} active
              </Row>
              {summary.organizationLayer ? (
                <>
                  <Row term="Organization policy from">
                    {summary.organizationLayer.effectiveFrom}
                  </Row>
                  <Row term="Clock mode">{words(summary.organizationLayer.clockMode)}</Row>
                  <Row term="Breaks">{words(summary.organizationLayer.breaksMode)}</Row>
                  <Row term="Missed clock-out handling">
                    {onOff(summary.organizationLayer.missedPunchEnabled)}
                  </Row>
                </>
              ) : (
                <Row term="Organization policy">None (defaults apply)</Row>
              )}
            </>
          )}
        </LinkedCard>
        <LinkedCard<NotificationsSummary>
          title="Notifications"
          href="/admin/notifications"
          linkLabel="Manage notifications"
          section={linked.notifications}
        >
          {(summary) => (
            <>
              <Row term="Organization email">{onOff(summary.emailEnabled)}</Row>
              <Row term="Mandatory email suppressed">
                {summary.suppressMandatoryEmail ? 'Yes' : 'No'}
              </Row>
              <Row term="Email off for">
                {summary.categoriesEmailDisabled.length
                  ? summary.categoriesEmailDisabled.map(words).join(', ')
                  : 'No categories'}
              </Row>
            </>
          )}
        </LinkedCard>
        <LinkedCard<GoogleWorkspaceSummary>
          title="Google Workspace"
          href="/settings/integrations/google"
          linkLabel="Manage Google Workspace"
          section={linked.googleWorkspace}
        >
          {(summary) => (
            <>
              <Row term="Connection">{words(summary.status)}</Row>
              {summary.mode && <Row term="Mode">{words(summary.mode)}</Row>}
              <Row term="Capabilities">
                {summary.capabilities.length ? summary.capabilities.map(words).join(', ') : 'None'}
              </Row>
              {summary.lastHealthCheckAt && (
                <Row term="Last health check">
                  {summary.lastHealthOk ? 'Healthy' : 'Failed'} ·{' '}
                  {dateTimeText(summary.lastHealthCheckAt)}
                </Row>
              )}
            </>
          )}
        </LinkedCard>
      </div>
    </Section>
  );
}

// ─── History ────────────────────────────────────────────────────────────────

function HistorySection({
  organizationId,
  overview,
}: {
  organizationId: string;
  overview: FeaturesOverview;
}) {
  const { identity } = useAuth();
  const [items, setItems] = useState<FeatureChange[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before: string | null) => {
      try {
        const page = await featuresApi.history(organizationId, {
          limit: HISTORY_PAGE_SIZE,
          before,
        });
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...page.items.filter((item) => !seen.has(item.id))];
        });
        setNextBefore(page.nextBefore);
        setError(null);
      } catch (cause) {
        setError(featuresErrorMessage(cause, 'Unable to load the change history.'));
      }
    },
    [organizationId],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(null).finally(() => setLoaded(true));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const subjectName = (change: FeatureChange) =>
    change.kind === 'MODULE'
      ? moduleLabel(change.subject)
      : (overview.settings.find((s) => s.key === change.subject)?.name ?? change.subject);
  const valueText = (change: FeatureChange, value: SettingValue | null) => {
    if (change.kind === 'MODULE') return value === null ? 'Default (on)' : value ? 'On' : 'Off';
    const setting = overview.settings.find((s) => s.key === change.subject);
    return setting ? settingValueText(setting, value) : value === null ? 'Default' : String(value);
  };

  return (
    <Section title="Change history">
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {!loaded ? (
        <Loading>Loading change history…</Loading>
      ) : items.length === 0 ? (
        error ? null : (
          <EmptyState>
            No changes have been made: every module and setting has its default.
          </EmptyState>
        )
      ) : (
        <>
          <DataTable
            label="Configuration changes"
            rows={items}
            rowKey={(change) => change.id}
            columns={[
              {
                key: 'when',
                header: 'When',
                cell: (change) => <>{dateTimeText(change.changedAt)}</>,
              },
              {
                key: 'change',
                header: 'Change',
                cell: (change) => (
                  <>
                    <span className="text-xs text-slate-500">
                      {change.kind === 'MODULE' ? 'Module' : 'Setting'}
                    </span>{' '}
                    {subjectName(change)}
                  </>
                ),
              },
              {
                key: 'from',
                header: 'From',
                cell: (change) => <>{valueText(change, change.oldValue)}</>,
              },
              {
                key: 'to',
                header: 'To',
                cell: (change) => <>{valueText(change, change.newValue)}</>,
              },
              {
                key: 'version',
                header: 'Version',
                cell: (change) => <>{change.version}</>,
              },
              {
                key: 'by',
                header: 'By',
                cell: (change) => (
                  <>
                    {!change.actorUserId
                      ? 'System'
                      : change.actorUserId === identity?.id
                        ? 'You'
                        : `User ${change.actorUserId.slice(0, 8)}`}
                  </>
                ),
              },
            ]}
          />
          {nextBefore && (
            <button
              type="button"
              className={secondaryButton}
              disabled={loadingMore}
              onClick={() => {
                setLoadingMore(true);
                void load(nextBefore).finally(() => setLoadingMore(false));
              }}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}
    </Section>
  );
}
