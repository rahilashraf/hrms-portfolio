'use client';

import { useTabParam } from '../../lib/navigation/use-tab-param';
import { useEffect, useState } from 'react';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { performanceApi } from '../../lib/performance/api';
import { performanceErrorMessage } from '../../lib/performance/errors';
import type { PerformanceOrganization } from '../../lib/performance/types';
import { EmptyState, inputClass } from './performance-shared';
import { PageContainer } from '../ui/page-container';
import { RequirePermission } from '../ui/require-permission';
import { LoadingState } from '../ui/states';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import { AttentionTab } from './admin/attention';
import { CompetenciesTab, ScalesTab } from './admin/config';
import { CyclesTab } from './admin/cycles';
import { EvidenceRecordsTab } from './admin/evidence-records';
import { EvidenceSourcesTab } from './admin/evidence-sources';
import { IntakeTab } from './admin/intake';
import { adminErrorMessage, type Mutate } from './admin/shared';
import { TemplatesTab } from './admin/templates';

export const PERFORMANCE_PERMISSION_KEYS = [
  'performance.read',
  'performance.manage',
  'performance.template.manage',
  'performance.cycle.manage',
  'performance.evidence.manage',
] as const;

type Tab =
  | 'cycles'
  | 'templates'
  | 'competencies'
  | 'scales'
  | 'evidence'
  | 'records'
  | 'intake'
  | 'attention';
const TAB_IDS: readonly Tab[] = [
  'cycles',
  'templates',
  'competencies',
  'scales',
  'evidence',
  'records',
  'intake',
  'attention',
];

/** Performance administration: visible only with a performance.* permission. */
export function PerformanceAdminPage() {
  // Batch 10E-2: checking, denied and loaded all render in the page's own (wide) width.
  return (
    <RequirePermission
      anyOf={PERFORMANCE_PERMISSION_KEYS}
      width="wide"
      deniedMessage="You do not have permission to view performance management."
    >
      <PerformanceAdmin />
    </RequirePermission>
  );
}

function PerformanceAdmin() {
  const [organizations, setOrganizations] = useState<PerformanceOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  // Deep links such as /admin/performance#cycles open that section; Batch 10E-2: picking a tab
  // writes its #hash, so the address bar always names the visible section.
  const [tab, setTab] = useTabParam<Tab>(TAB_IDS, 'cycles', { writeHash: true });
  const tabIdBase = useTabIdBase('performance');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      performanceApi
        .organizations()
        .then((result) => {
          setOrganizations(result.items);
          setOrganizationId((current) => current || result.items[0]?.id || '');
        })
        .catch((cause) => setError(performanceErrorMessage(cause, 'Unable to load organizations.')))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const organization = organizations.find((o) => o.id === organizationId);
  const actions = organization?.actions;

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

  const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: 'cycles', label: 'Review cycles' },
    { id: 'templates', label: 'Templates' },
    { id: 'competencies', label: 'Competencies' },
    { id: 'scales', label: 'Rating scales' },
    ...(actions?.canManageEvidence
      ? [
          { id: 'evidence' as const, label: 'Evidence sources' },
          { id: 'records' as const, label: 'Evidence records' },
          { id: 'intake' as const, label: 'Unmatched results' },
        ]
      : []),
    { id: 'attention', label: 'Needs attention' },
  ];

  // A deep link to a section the viewer cannot see opens the cycles.
  const activeTab: Tab = tabs.some((t) => t.id === tab) ? tab : 'cycles';

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Performance"
        title="Performance management"
        description="Review cycles, templates, competencies and rating scales, and assessment evidence such as Google Forms quiz results. Evidence supports reviews; it never decides a rating."
      >
        {organizations.length > 1 && (
          <label className="text-sm font-medium text-slate-800" htmlFor="performance-organization">
            Organization
            <select
              id="performance-organization"
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
          <LoadingState label="Loading performance management…" />
        ) : organizations.length === 0 ? (
          <EmptyState>No organizations are within your performance access.</EmptyState>
        ) : (
          <>
            <TabList<Tab>
              tabs={tabs}
              active={activeTab}
              onChange={setTab}
              label="Performance sections"
              idBase={tabIdBase}
            />
            <TabPanel idBase={tabIdBase} id={activeTab}>
              <AdminSection
                key={organizationId}
                tab={activeTab}
                organizationId={organizationId}
                actions={actions}
                busy={busy}
                mutate={mutate}
                version={version}
              />
            </TabPanel>
          </>
        )}
      </div>
    </PageContainer>
  );
}

/** The active section: each loads its own data (a failing one never blanks the page). */
function AdminSection({
  tab,
  actions,
  ...section
}: {
  tab: Tab;
  actions: PerformanceOrganization['actions'] | undefined;
  organizationId: string;
  busy: boolean;
  mutate: Mutate;
  version: number;
}) {
  switch (tab) {
    case 'cycles':
      return <CyclesTab {...section} canManage={Boolean(actions?.canManageCycles)} />;
    case 'templates':
      return <TemplatesTab {...section} canManage={Boolean(actions?.canManageTemplates)} />;
    case 'competencies':
      return <CompetenciesTab {...section} canManage={Boolean(actions?.canManageTemplates)} />;
    case 'scales':
      return <ScalesTab {...section} canManage={Boolean(actions?.canManageTemplates)} />;
    case 'evidence':
      return <EvidenceSourcesTab {...section} />;
    case 'records':
      return <EvidenceRecordsTab {...section} />;
    case 'intake':
      return <IntakeTab {...section} />;
    case 'attention':
      return <AttentionTab organizationId={section.organizationId} version={section.version} />;
  }
}
