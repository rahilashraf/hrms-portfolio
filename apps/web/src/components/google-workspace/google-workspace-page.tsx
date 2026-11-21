'use client';

import { PageContainer } from '../ui/page-container';
import { useCallback, useEffect, useState } from 'react';
import { Forbidden } from '../auth/forbidden';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { hasPermission } from '../../lib/authorization/can';
import { googleWorkspaceApi } from '../../lib/google-workspace/api';
import {
  CAPABILITY_LABELS,
  CAPABILITY_SHORT_LABELS,
  GOOGLE_CAPABILITIES,
  GOOGLE_WORKSPACE_PERMISSION_KEYS,
  parseCallbackResult,
  type CallbackResult,
} from '../../lib/google-workspace/domain';
import {
  callbackErrorMessage,
  googleWorkspaceErrorMessage,
} from '../../lib/google-workspace/errors';
import { navigateToGoogleAuthorization } from '../../lib/google-workspace/navigation';
import type {
  GoogleCapability,
  GoogleCapabilityInfo,
  GoogleOrganization,
  GoogleWorkspaceStatus,
  HealthCheckResult,
} from '../../lib/google-workspace/types';
import { useAuth } from '../../providers/auth-provider';
import { BindingsSection, SyncRunsSection } from './google-workspace-bindings';
import {
  checkbox,
  ConnectionStatusBadge,
  dangerButton,
  dateTimeText,
  EmptyState,
  ErrorCodeText,
  Field,
  inputClass,
  Loading,
  primaryButton,
  secondaryButton,
  Section,
  useData,
  type Mutate,
} from './google-workspace-shared';
import { useConfirm } from '../ui/use-confirm';

/**
 * Google Workspace integration administration (/settings/integrations/google): the connection
 * of an organization (OAuth by default, an optional service account with domain-wide
 * delegation), form bindings and synchronization history. Visible with
 * integration.google.read or integration.google.manage; each organization's `canManage`
 * decides whether anything can be changed. Also the OAuth callback's landing page.
 */
export function GoogleWorkspacePage() {
  const { authorization, authorizationLoading } = useAuth();
  if (authorizationLoading) {
    return (
      <PageContainer width="wide">
        <Loading />
      </PageContainer>
    );
  }
  const permitted = GOOGLE_WORKSPACE_PERMISSION_KEYS.some((key) =>
    hasPermission(authorization, key),
  );
  if (!permitted) {
    return (
      <PageContainer width="wide" padded={false}>
        <Forbidden message="You do not have permission to view the Google Workspace integration." />
      </PageContainer>
    );
  }
  return <GoogleWorkspaceAdmin />;
}

const HEALTH_MESSAGES: Record<HealthCheckResult['result'], string> = {
  ACTIVE: 'Health check passed: Google accepted the connection.',
  ERROR: 'Health check failed: Google refused the credentials. Reconnect Google Workspace.',
  CREDENTIALS_UNAVAILABLE:
    'Health check failed: the stored credentials cannot be decrypted. Reconnect Google Workspace.',
  UNKNOWN: 'Health check inconclusive: Google could not be reached. Try again later.',
};

function GoogleWorkspaceAdmin() {
  const [organizations, setOrganizations] = useState<GoogleOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [callback, setCallback] = useState<CallbackResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      // The OAuth callback redirect lands here with ?result=…; read it once, then drop it.
      const result = parseCallbackResult(window.location.search);
      if (window.location.search) {
        window.history.replaceState(window.history.state, '', window.location.pathname);
      }
      setCallback(result);
      googleWorkspaceApi
        .organizations()
        .then(({ items }) => {
          setOrganizations(items);
          const preferred =
            result?.kind === 'connected' && items.some((o) => o.id === result.organizationId)
              ? result.organizationId
              : null;
          setOrganizationId((current) => preferred || current || items[0]?.id || '');
        })
        .catch((cause) =>
          setError(googleWorkspaceErrorMessage(cause, 'Unable to load organizations.')),
        )
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const onError = useCallback((message: string) => setError(message), []);
  const organization = organizations.find((o) => o.id === organizationId);

  const mutate: Mutate = async (action, message) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    setCallback(null);
    try {
      const result = await action();
      setSuccess(typeof message === 'function' ? message(result) : message);
      setVersion((v) => v + 1);
      return true;
    } catch (cause) {
      setError(
        googleWorkspaceErrorMessage(cause, 'Unable to complete the Google Workspace action.'),
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startOAuth = async (capabilities: GoogleCapability[]) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    setCallback(null);
    try {
      const started = await googleWorkspaceApi.startOAuth(organizationId, capabilities);
      if (navigateToGoogleAuthorization(started.authorizationUrl)) return;
      setError('The authorization link did not point to Google. Nothing was opened.');
    } catch (cause) {
      setError(googleWorkspaceErrorMessage(cause, 'Unable to start the Google connection.'));
    }
    setBusy(false);
  };

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Settings · Integrations"
        title="Google Workspace"
        description="Connect an organization’s Google Workspace, bind Google Forms to performance evidence, recruitment intake or onboarding tasks, and review synchronizations. Credentials are never shown."
      >
        {organizations.length > 1 && (
          <label className="text-sm font-medium text-slate-800" htmlFor="google-organization">
            Organization
            <select
              id="google-organization"
              className={inputClass}
              value={organizationId}
              onChange={(event) => {
                setSuccess(null);
                setError(null);
                setCallback(null);
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
        {callback && <CallbackBanner result={callback} onDismiss={() => setCallback(null)} />}
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {loading ? (
          <Loading>Loading Google Workspace…</Loading>
        ) : !organization ? (
          <EmptyState>
            No organizations are within your Google Workspace integration access.
          </EmptyState>
        ) : (
          <OrganizationIntegration
            key={organization.id}
            organization={organization}
            version={version}
            busy={busy}
            mutate={mutate}
            onError={onError}
            onStartOAuth={startOAuth}
          />
        )}
      </div>
    </PageContainer>
  );
}

function CallbackBanner({ result, onDismiss }: { result: CallbackResult; onDismiss(): void }) {
  const ok = result.kind === 'connected';
  return (
    <div
      role={ok ? 'status' : 'alert'}
      aria-label="Google connection result"
      className={
        ok
          ? 'flex items-start justify-between gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900'
          : 'flex items-start justify-between gap-3 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900'
      }
    >
      <p>
        {ok
          ? 'Google Workspace connected. Check the granted capabilities below.'
          : `Google Workspace was not connected. ${callbackErrorMessage(result.kind === 'error' ? result.code : null)}`}
      </p>
      <button type="button" className="text-xs font-medium underline" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

function OrganizationIntegration({
  organization,
  version,
  busy,
  mutate,
  onError,
  onStartOAuth,
}: {
  organization: GoogleOrganization;
  version: number;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
  onStartOAuth(capabilities: GoogleCapability[]): Promise<void>;
}) {
  const organizationId = organization.id;
  const load = useCallback(
    () => googleWorkspaceApi.status(organizationId),
    // `version` reloads after every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [organizationId, version],
  );
  const { data: status, loaded } = useData(load, onError);
  const [runFilter, setRunFilter] = useState<string | null>(null);
  if (!loaded) return <Loading>Loading the connection…</Loading>;
  if (!status) return <EmptyState>The Google Workspace status could not be loaded.</EmptyState>;
  const canManage = status.canManage && organization.actions.canManage;
  return (
    <div className="space-y-4">
      {!canManage && (
        <p
          role="note"
          className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"
        >
          You have read-only access to this organization’s Google Workspace integration.
        </p>
      )}
      {canManage && <ConfigurationNotice status={status} />}
      <ConnectionCard status={status} canManage={canManage} busy={busy} mutate={mutate} />
      {canManage && (
        <ConnectOptions status={status} busy={busy} mutate={mutate} onStartOAuth={onStartOAuth} />
      )}
      <BindingsSection
        organizationId={organizationId}
        version={version}
        canManage={canManage}
        connected={status.connection?.status === 'ACTIVE'}
        busy={busy}
        mutate={mutate}
        onError={onError}
        onShowRuns={setRunFilter}
      />
      <SyncRunsSection
        organizationId={organizationId}
        version={version}
        bindingId={runFilter}
        onBindingChange={setRunFilter}
        onError={onError}
      />
    </div>
  );
}

function ConfigurationNotice({ status }: { status: GoogleWorkspaceStatus }) {
  if (status.oauthConfigured && status.encryptionConfigured) return null;
  return (
    <div
      role="note"
      aria-label="Configuration missing"
      className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      <p className="font-medium">This deployment is not fully configured for Google Workspace.</p>
      <ul className="list-disc pl-5">
        {!status.oauthConfigured && (
          <li>
            Google sign-in (the OAuth client) is not configured, so Connect with Google is
            unavailable.
          </li>
        )}
        {!status.encryptionConfigured && (
          <li>
            Credential encryption is not configured, so no Google credentials can be stored (neither
            OAuth nor a service account).
          </li>
        )}
      </ul>
      <p>
        Ask the platform operator to complete the deployment settings. No secrets are shown here.
      </p>
    </div>
  );
}

function ConnectionCard({
  status,
  canManage,
  busy,
  mutate,
}: {
  status: GoogleWorkspaceStatus;
  canManage: boolean;
  busy: boolean;
  mutate: Mutate;
}) {
  const connection = status.connection;
  const [confirm, confirmDialog] = useConfirm();
  return (
    <Section
      title="Connection"
      actions={
        connection &&
        canManage && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              onClick={() =>
                void mutate(
                  () => googleWorkspaceApi.healthCheck(status.organizationId),
                  (result: HealthCheckResult) => HEALTH_MESSAGES[result.result],
                )
              }
            >
              Check health
            </button>
            <button
              type="button"
              className={dangerButton}
              disabled={busy}
              onClick={async () => {
                if (
                  !(await confirm({
                    title: 'Disconnect Google Workspace?',
                    description:
                      'Scheduled synchronizations stop and the stored credentials are deleted. Bindings are kept.',
                    confirmLabel: 'Disconnect',
                  }))
                )
                  return;
                void mutate(
                  () => googleWorkspaceApi.disconnect(status.organizationId),
                  (result: { revoked: boolean }) =>
                    result.revoked || connection.mode !== 'SERVICE_ACCOUNT'
                      ? 'Google Workspace disconnected.'
                      : 'Google Workspace disconnected. Delete the service-account key in Google Cloud to revoke it there.',
                );
              }}
            >
              Disconnect
            </button>
          </div>
        )
      }
    >
      {confirmDialog}
      <div className="flex flex-wrap items-center gap-2">
        <ConnectionStatusBadge status={connection?.status ?? null} />
        {connection && (
          <span className="text-xs text-slate-600">
            {connection.mode === 'OAUTH'
              ? 'Connected with Google (OAuth)'
              : 'Service account (domain-wide delegation)'}
          </span>
        )}
      </div>
      {connection ? (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Detail term="Workspace domain">{connection.workspaceDomain ?? '—'}</Detail>
          <Detail term={connection.mode === 'OAUTH' ? 'Google account' : 'Acts as user'}>
            {connection.accountEmail ?? '—'}
          </Detail>
          {connection.serviceAccountEmail && (
            <Detail term="Service account">{connection.serviceAccountEmail}</Detail>
          )}
          <Detail term="Connected since">{dateTimeText(connection.connectedAt)}</Detail>
          <Detail term="Granted capabilities">
            {connection.capabilities.length === 0 ? (
              'None'
            ) : (
              <ul aria-label="Granted capabilities" className="inline-flex flex-wrap gap-1.5">
                {connection.capabilities.map((capability) => (
                  <li
                    key={capability}
                    className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-800"
                  >
                    {CAPABILITY_SHORT_LABELS[capability] ?? capability}
                  </li>
                ))}
              </ul>
            )}
          </Detail>
          <Detail term="Last health check">
            {connection.lastHealthCheckAt
              ? `${dateTimeText(connection.lastHealthCheckAt)} · ${connection.lastHealthOk ? 'OK' : 'Failed'}`
              : 'Never'}
          </Detail>
          <Detail term="Last error">
            <ErrorCodeText code={connection.lastErrorCode} />
          </Detail>
        </dl>
      ) : (
        <p className="text-sm text-slate-600">
          This organization is not connected to Google Workspace.
          {!canManage && ' An integration administrator can connect it.'}
        </p>
      )}
      {status.previousConnections.length > 0 && (
        <div className="text-sm text-slate-700">
          <p className="text-xs font-semibold uppercase text-slate-500">Previous connections</p>
          <ul className="mt-1 space-y-1">
            {status.previousConnections.map((previous) => (
              <li key={previous.id}>
                {previous.workspaceDomain ?? 'Unknown domain'} ·{' '}
                {previous.mode === 'OAUTH' ? 'OAuth' : 'Service account'} · disconnected{' '}
                {dateTimeText(previous.disconnectedAt)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-slate-500">{term}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
}

function ConnectOptions({
  status,
  busy,
  mutate,
  onStartOAuth,
}: {
  status: GoogleWorkspaceStatus;
  busy: boolean;
  mutate: Mutate;
  onStartOAuth(capabilities: GoogleCapability[]): Promise<void>;
}) {
  const connection = status.connection;
  const oauth = !connection || connection.mode === 'OAUTH';
  const serviceAccount = !connection || connection.mode === 'SERVICE_ACCOUNT';
  return (
    <>
      {oauth &&
        (connection ? (
          <details className="rounded-xl border border-slate-200 bg-white p-4">
            <summary className="cursor-pointer text-sm font-semibold text-slate-900">
              Reconnect with Google or change capabilities
            </summary>
            <div className="mt-3">
              <OAuthConnect status={status} busy={busy} onStart={onStartOAuth} />
            </div>
          </details>
        ) : (
          <Section title="Connect with Google">
            <OAuthConnect status={status} busy={busy} onStart={onStartOAuth} />
          </Section>
        ))}
      {serviceAccount && (
        <details
          className="rounded-xl border border-slate-200 bg-white p-4"
          aria-label="Advanced: service account"
        >
          <summary className="cursor-pointer text-sm font-semibold text-slate-900">
            {connection
              ? 'Advanced: replace the service-account key (domain-wide delegation)'
              : 'Advanced: service account (domain-wide delegation)'}
          </summary>
          <div className="mt-3">
            <ServiceAccountForm status={status} busy={busy} mutate={mutate} />
          </div>
        </details>
      )}
    </>
  );
}

function CapabilityChoices({
  idPrefix,
  capabilities,
  selected,
  onChange,
  disabled,
}: {
  idPrefix: string;
  capabilities: GoogleCapabilityInfo[];
  selected: GoogleCapability[];
  onChange(next: GoogleCapability[]): void;
  disabled: boolean;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-800">Capabilities</legend>
      {capabilities.map((info) => {
        const id = `${idPrefix}-${info.capability}`;
        const checked = selected.includes(info.capability);
        return (
          <div key={info.capability} className="rounded-lg border border-slate-200 p-2">
            <label htmlFor={id} className="flex items-center gap-3 text-sm text-slate-800">
              <input
                id={id}
                type="checkbox"
                className={checkbox}
                checked={checked}
                disabled={disabled}
                aria-describedby={`${id}-scopes`}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  onChange(
                    GOOGLE_CAPABILITIES.filter((c) =>
                      c === info.capability ? on : selected.includes(c),
                    ),
                  );
                }}
              />
              {CAPABILITY_LABELS[info.capability] ?? info.capability}
            </label>
            <ul
              id={`${id}-scopes`}
              aria-label={`Scopes for ${CAPABILITY_SHORT_LABELS[info.capability] ?? info.capability}`}
              className="mt-1 flex flex-wrap gap-1 pl-7"
            >
              {info.scopes.map((scope) => (
                <li key={scope}>
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                    {scope}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </fieldset>
  );
}

function OAuthConnect({
  status,
  busy,
  onStart,
}: {
  status: GoogleWorkspaceStatus;
  busy: boolean;
  onStart(capabilities: GoogleCapability[]): Promise<void>;
}) {
  const [selected, setSelected] = useState<GoogleCapability[]>(
    status.connection?.capabilities.length ? status.connection.capabilities : ['FORMS'],
  );
  const available = status.strategies.OAUTH.available;
  const reason = !status.oauthConfigured
    ? 'Unavailable: Google sign-in (OAuth) is not configured for this deployment.'
    : !status.encryptionConfigured
      ? 'Unavailable: credential encryption is not configured for this deployment.'
      : null;
  return (
    <form
      aria-label="Connect with Google"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!available || selected.length === 0) return;
        void onStart(selected);
      }}
    >
      <p className="text-sm text-slate-600">
        Recommended. You are sent to Google to sign in with a Google Workspace account and approve
        only the permissions of the capabilities you select. No domain-wide delegation is needed.
      </p>
      <CapabilityChoices
        idPrefix="oauth-capability"
        capabilities={status.capabilities}
        selected={selected}
        onChange={setSelected}
        disabled={busy || !available}
      />
      {reason && (
        <p id="oauth-unavailable" className="text-sm text-amber-900">
          {reason}
        </p>
      )}
      {available && selected.length === 0 && (
        <p className="text-sm text-slate-600">Select at least one capability.</p>
      )}
      <button
        type="submit"
        className={primaryButton}
        disabled={busy || !available || selected.length === 0}
        aria-describedby={reason ? 'oauth-unavailable' : undefined}
      >
        {status.connection ? 'Reconnect with Google' : 'Connect with Google'}
      </button>
    </form>
  );
}

function ServiceAccountForm({
  status,
  busy,
  mutate,
}: {
  status: GoogleWorkspaceStatus;
  busy: boolean;
  mutate: Mutate;
}) {
  const [keyJson, setKeyJson] = useState('');
  const [impersonatedUser, setImpersonatedUser] = useState(
    status.connection?.mode === 'SERVICE_ACCOUNT' ? (status.connection.accountEmail ?? '') : '',
  );
  const [selected, setSelected] = useState<GoogleCapability[]>(
    status.connection?.capabilities.length ? status.connection.capabilities : ['FORMS'],
  );
  const available = status.strategies.SERVICE_ACCOUNT.available;
  return (
    <form
      aria-label="Connect a service account"
      className="space-y-3"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (!available || selected.length === 0 || !keyJson.trim()) return;
        const input = {
          organizationId: status.organizationId,
          keyJson,
          impersonatedUser: impersonatedUser.trim(),
          capabilities: selected,
        };
        // The key never stays in the page, whatever the outcome.
        setKeyJson('');
        void mutate(
          () => googleWorkspaceApi.connectServiceAccount(input),
          'Service account connected.',
        );
      }}
    >
      <div
        role="note"
        className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      >
        Optional and advanced. A service account works only after a Google Workspace super-admin
        configures domain-wide delegation for its client ID with exactly the scopes of the selected
        capabilities. Prefer Connect with Google unless your organization requires a service
        account. The key is sent once, stored encrypted and never shown again.
      </div>
      {!available && (
        <p className="text-sm text-amber-900">
          Unavailable: credential encryption is not configured for this deployment.
        </p>
      )}
      <Field label="Service-account key (JSON)">
        <textarea
          className={`${inputClass} font-mono text-xs`}
          rows={5}
          value={keyJson}
          spellCheck={false}
          autoComplete="off"
          disabled={busy || !available}
          required
          maxLength={20_000}
          onChange={(event) => setKeyJson(event.currentTarget.value)}
        />
      </Field>
      <Field label="Workspace user to act as">
        <input
          type="email"
          className={inputClass}
          value={impersonatedUser}
          autoComplete="off"
          disabled={busy || !available}
          required
          maxLength={320}
          onChange={(event) => setImpersonatedUser(event.currentTarget.value)}
        />
      </Field>
      <CapabilityChoices
        idPrefix="sa-capability"
        capabilities={status.capabilities}
        selected={selected}
        onChange={setSelected}
        disabled={busy || !available}
      />
      <button
        type="submit"
        className={secondaryButton}
        disabled={busy || !available || selected.length === 0}
      >
        {status.connection ? 'Replace service-account key' : 'Connect service account'}
      </button>
    </form>
  );
}
