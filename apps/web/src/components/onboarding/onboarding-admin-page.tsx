'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTabParam } from '../../lib/navigation/use-tab-param';
import {
  readOffboardingPrefill,
  readOnboardingPrefill,
  type OffboardingPrefill,
  type OnboardingPrefill,
} from '../../lib/onboarding/offboarding-link';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { onboardingApi } from '../../lib/onboarding/api';
import { onboardingErrorMessage } from '../../lib/onboarding/errors';
import type { OnboardingOrganization, WorkflowKind } from '../../lib/onboarding/types';
import { EmptyState, inputClass, ONBOARDING_PERMISSION_KEYS } from './onboarding-shared';
import { PageContainer } from '../ui/page-container';
import { RequirePermission } from '../ui/require-permission';
import { LoadingState } from '../ui/states';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import type { Mutate } from './admin/admin-shared';
import { DashboardTab } from './admin/dashboard-tab';
import { ImportTab } from './admin/import-tab';
import { StartTab } from './admin/start-tab';
import { TemplatesTab } from './admin/templates-tab';

type Tab = 'onboarding' | 'offboarding' | 'start' | 'templates' | 'import';
const TAB_IDS: readonly Tab[] = ['onboarding', 'offboarding', 'start', 'templates', 'import'];

/**
 * Onboarding & offboarding administration: visible with an onboarding.* / offboarding.*
 * permission (the API decides which organizations and workflows are reachable).
 */
export function OnboardingAdminPage() {
  // Batch 10E-1: checking, denied and loaded all render in the page's own (wide) width.
  return (
    <RequirePermission
      anyOf={ONBOARDING_PERMISSION_KEYS}
      width="wide"
      deniedMessage="You do not have permission to view onboarding."
    >
      <OnboardingAdmin />
    </RequirePermission>
  );
}

function OnboardingAdmin() {
  const [organizations, setOrganizations] = useState<OnboardingOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  // `#start` etc. deep-link to a section (e.g. "Start offboarding" on an employee profile).
  // Batch 10E-1: picking a tab writes its #hash (the query, e.g. a prefill, is kept).
  const [tab, setTab] = useTabParam<Tab>(TAB_IDS, 'onboarding', { writeHash: true });
  const tabIdBase = useTabIdBase('onboarding');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  // Batch 5C: "Review offboarding" links from an employee profile preselect the Start form.
  const [prefill, setPrefill] = useState<OffboardingPrefill | null>(null);
  // Batch 7A: "Start onboarding" on an employee profile preselects the onboarding form.
  const [onboardPrefill, setOnboardPrefill] = useState<OnboardingPrefill | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPrefill(readOffboardingPrefill(window.location.search));
      setOnboardPrefill(readOnboardingPrefill(window.location.search));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    const wanted = prefill?.organizationId ?? onboardPrefill?.organizationId;
    if (!wanted || !organizations.some((o) => o.id === wanted)) return;
    const timer = window.setTimeout(() => setOrganizationId(wanted), 0);
    return () => window.clearTimeout(timer);
  }, [prefill, onboardPrefill, organizations]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onboardingApi
        .organizations()
        .then((result) => {
          setOrganizations(result.items);
          setOrganizationId((current) => current || result.items[0]?.id || '');
        })
        .catch((cause) => setError(onboardingErrorMessage(cause, 'Unable to load organizations.')))
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
      setError(onboardingErrorMessage(cause, 'Unable to complete the onboarding action.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const works = Boolean(actions?.onboarding || actions?.offboarding);
  // Batch 7A: importing completes tasks across the organization, so the API requires
  // organization-level onboarding.manage / offboarding.manage (and completes only those kinds);
  // the organizations endpoint says which kinds this user may import.
  const importKinds: WorkflowKind[] = [
    ...(actions?.canImportOnboarding ? (['ONBOARDING'] as const) : []),
    ...(actions?.canImportOffboarding ? (['OFFBOARDING'] as const) : []),
  ];
  const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
    ...(actions?.onboarding ? [{ id: 'onboarding' as const, label: 'Onboarding' }] : []),
    ...(actions?.offboarding ? [{ id: 'offboarding' as const, label: 'Offboarding' }] : []),
    ...(works ? [{ id: 'start' as const, label: 'Start' }] : []),
    ...(actions?.canManageTemplates ? [{ id: 'templates' as const, label: 'Templates' }] : []),
    ...(importKinds.length > 0 ? [{ id: 'import' as const, label: 'Import' }] : []),
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? 'onboarding');
  const key = `${organizationId}-${version}`;

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Onboarding"
        title="Onboarding & offboarding"
        description="Checklists for people joining and leaving: templates, workflows started from Core HR assignments or recruitment hires, and their tasks. Offboarding never ends employment — Core HR does."
      >
        {organizations.length > 1 && (
          <label className="text-sm font-medium text-slate-800" htmlFor="onboarding-organization">
            Organization
            <select
              id="onboarding-organization"
              className={inputClass}
              value={organizationId}
              onChange={(event) => setOrganizationId(event.currentTarget.value)}
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
          <LoadingState label="Loading onboarding…" />
        ) : organizations.length === 0 || tabs.length === 0 ? (
          <EmptyState>No organizations are within your onboarding access.</EmptyState>
        ) : (
          <>
            <TabList<Tab>
              tabs={tabs}
              active={activeTab}
              onChange={setTab}
              label="Onboarding sections"
              idBase={tabIdBase}
            />
            <TabPanel idBase={tabIdBase} id={activeTab}>
              {(activeTab === 'onboarding' || activeTab === 'offboarding') && (
                <DashboardTab
                  key={`${activeTab}-${key}`}
                  organizationId={organizationId}
                  kind={activeTab === 'onboarding' ? 'ONBOARDING' : 'OFFBOARDING'}
                  onError={onError}
                />
              )}
              {activeTab === 'start' && actions && (
                <StartTab
                  key={`${organizationId}-${prefill ? 'prefill' : 'blank'}-${onboardPrefill ? 'on' : 'none'}`}
                  organizationId={organizationId}
                  actions={actions}
                  busy={busy}
                  mutate={mutate}
                  prefill={
                    prefill &&
                    (!prefill.organizationId || prefill.organizationId === organizationId)
                      ? prefill
                      : null
                  }
                  onboardPrefill={
                    onboardPrefill &&
                    (!onboardPrefill.organizationId ||
                      onboardPrefill.organizationId === organizationId)
                      ? onboardPrefill
                      : null
                  }
                />
              )}
              {activeTab === 'templates' && (
                <TemplatesTab
                  key={key}
                  organizationId={organizationId}
                  busy={busy}
                  mutate={mutate}
                  onError={onError}
                />
              )}
              {activeTab === 'import' && (
                <ImportTab
                  key={organizationId}
                  organizationId={organizationId}
                  kinds={importKinds}
                  busy={busy}
                  mutate={mutate}
                />
              )}
            </TabPanel>
          </>
        )}
      </div>
    </PageContainer>
  );
}
