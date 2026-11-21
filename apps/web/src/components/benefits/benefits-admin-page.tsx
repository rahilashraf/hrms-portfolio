'use client';

import { useEffect, useState } from 'react';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { benefitsApi } from '../../lib/benefits/api';
import type { BenefitOrganization } from '../../lib/benefits/types';
import { AttentionTab } from './admin/attention';
import { PlansTab } from './admin/plans';
import { adminErrorMessage, loadErrorMessage, type Mutate } from './admin/shared';
import { EmptyState, inputClass, secondaryButton } from './benefits-shared';
import { useTabParam } from '../../lib/navigation/use-tab-param';
import { PageContainer } from '../ui/page-container';
import { RequirePermission } from '../ui/require-permission';
import { LoadingState } from '../ui/states';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import { FindEmployee } from './admin/find-employee';

export const BENEFIT_PERMISSION_KEYS = [
  'benefit.read',
  'benefit.manage',
  'benefit.plan.manage',
] as const;

type Tab = 'plans' | 'attention';
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'plans', label: 'Plans' },
  { id: 'attention', label: 'Needs attention' },
];
const TAB_IDS: readonly Tab[] = TABS.map((tab) => tab.id);

/** Benefits administration: visible only with a benefit.* permission (never implied by others). */
export function BenefitsAdminPage() {
  // Batch 10E-2: checking, denied and loaded all render in the page's own (wide) width.
  return (
    <RequirePermission
      anyOf={BENEFIT_PERMISSION_KEYS}
      width="wide"
      deniedMessage="You do not have permission to view benefits."
    >
      <BenefitsAdmin />
    </RequirePermission>
  );
}

function BenefitsAdmin() {
  const [organizations, setOrganizations] = useState<BenefitOrganization[] | null>(null);
  const [organizationsError, setOrganizationsError] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState('');
  // Batch 10E-2: /admin/benefits#attention deep-links a section; picking one writes it.
  const [tab, setTab] = useTabParam<Tab>(TAB_IDS, 'plans', { writeHash: true });
  const tabIdBase = useTabIdBase('benefits');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      benefitsApi
        .organizations()
        .then((result) => {
          if (!active) return;
          setOrganizations(result.items);
          setOrganizationsError(null);
          setOrganizationId((current) => current || result.items[0]?.id || '');
        })
        .catch((cause) => active && setOrganizationsError(loadErrorMessage(cause)));
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [attempt]);

  const organization = organizations?.find((o) => o.id === organizationId);

  const mutate: Mutate = async (action, message, options) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      setSuccess(message);
      setVersion((v) => v + 1);
      return true;
    } catch (cause) {
      const text = adminErrorMessage(cause);
      if (options?.onError) options.onError(text);
      else setError(text);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Benefits"
        title="Benefits"
        description="Benefit plans, coverage options, effective-dated rates and eligibility. Find an employee to record their elections and dependents; payroll deducts them from the sponsoring assignment."
      >
        {organizations && organizations.length > 1 && (
          <label className="text-sm font-medium text-slate-800" htmlFor="benefits-organization">
            Organization
            <select
              id="benefits-organization"
              className={inputClass}
              value={organizationId}
              onChange={(event) => {
                setError(null);
                setSuccess(null);
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
        {organizationsError ? (
          <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm">
            <p className="text-rose-900">Unable to load organizations: {organizationsError}</p>
            <button
              type="button"
              className={`${secondaryButton} mt-2`}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        ) : organizations === null ? (
          <LoadingState label="Loading benefits…" />
        ) : organizations.length === 0 ? (
          <EmptyState>
            No organizations are within your benefits access, or Benefits is turned off for them.
          </EmptyState>
        ) : (
          <>
            {organizationId && <FindEmployee organizationId={organizationId} />}
            <TabList<Tab>
              tabs={TABS}
              active={tab}
              onChange={setTab}
              label="Benefits sections"
              idBase={tabIdBase}
            />
            <TabPanel idBase={tabIdBase} id={tab}>
              {tab === 'plans' ? (
                <PlansTab
                  key={organizationId}
                  organizationId={organizationId}
                  canManagePlans={Boolean(organization?.actions.canManagePlans)}
                  busy={busy}
                  mutate={mutate}
                  version={version}
                />
              ) : (
                <AttentionTab
                  key={organizationId}
                  organizationId={organizationId}
                  canManagePlans={Boolean(organization?.actions.canManagePlans)}
                  busy={busy}
                  mutate={mutate}
                  version={version}
                />
              )}
            </TabPanel>
          </>
        )}
      </div>
    </PageContainer>
  );
}
