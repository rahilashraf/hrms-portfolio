'use client';

import { useTabParam } from '../../lib/navigation/use-tab-param';
import { useCallback, useEffect, useState } from 'react';
import { Forbidden } from '../auth/forbidden';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { hasPermission } from '../../lib/authorization/can';
import { recruitmentApi } from '../../lib/recruitment/api';
import { recruitmentErrorMessage } from '../../lib/recruitment/errors';
import type {
  ApplicationStatus,
  IngestionReport,
  OpeningStatus,
  RecruitmentOrganization,
} from '../../lib/recruitment/types';
import { useAuth } from '../../providers/auth-provider';
import { EmptyState, inputClass } from './recruitment-shared';
import { PageContainer } from '../ui/page-container';
import { LoadingState } from '../ui/states';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import type { Mutate } from './admin/admin-shared';
import { CandidatesTab } from './admin/candidates-tab';
import { DashboardTab } from './admin/dashboard-tab';
import { IntakeTab, type IntakeFilter } from './admin/intake-tab';
import { OpeningsTab } from './admin/openings-tab';
import { PipelineTab } from './admin/pipeline-tab';
import { SettingsTab } from './admin/settings-tab';

export const RECRUITMENT_PERMISSION_KEYS = [
  'recruitment.read',
  'recruitment.manage',
  'recruitment.offer.approve',
  'recruitment.hire',
  'recruitment.pipeline.manage',
  'recruitment.intake.manage',
] as const;

type Tab = 'dashboard' | 'openings' | 'pipeline' | 'candidates' | 'intake' | 'settings';
const TAB_IDS: readonly Tab[] = [
  'dashboard',
  'openings',
  'pipeline',
  'candidates',
  'intake',
  'settings',
];

/**
 * Recruitment administration: visible with a recruitment.* permission, or to an explicit
 * hiring manager of an opening (the API decides which organizations are reachable).
 */
export function RecruitmentAdminPage() {
  const { authorization, authorizationLoading } = useAuth();
  // Batch 10E-1: loading, denied and loaded all render in the page's own (wide) width.
  if (authorizationLoading) {
    return (
      <PageContainer width="wide">
        <LoadingState label="Checking your access…" />
      </PageContainer>
    );
  }
  const permitted = RECRUITMENT_PERMISSION_KEYS.some((key) => hasPermission(authorization, key));
  return <RecruitmentAdmin permitted={permitted} />;
}

function RecruitmentAdmin({ permitted }: { permitted: boolean }) {
  const [organizations, setOrganizations] = useState<RecruitmentOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [openingFilter, setOpeningFilter] = useState<{
    status: OpeningStatus | '';
    search: string;
  }>({ status: '', search: '' });
  const [pipelineFilter, setPipelineFilter] = useState({
    openingId: '',
    stageId: '',
    status: '' as ApplicationStatus | '',
    search: '',
  });
  const [candidateSearch, setCandidateSearch] = useState('');
  // Batch 7A: kept here so the refresh after an action (which remounts the tab) keeps them.
  const [intakeReport, setIntakeReport] = useState<IngestionReport | null>(null);
  const [intakeFilter, setIntakeFilter] = useState<IntakeFilter>({
    status: 'PENDING_OPENING',
    sourceId: '',
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      recruitmentApi
        .organizations()
        .then((result) => {
          setOrganizations(result.items);
          setOrganizationId((current) => current || result.items[0]?.id || '');
        })
        .catch((cause) => setError(recruitmentErrorMessage(cause, 'Unable to load organizations.')))
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
      setError(recruitmentErrorMessage(cause, 'Unable to complete the recruitment action.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Workflow links such as /admin/recruitment#pipeline open that section; Batch 10E-1: picking
  // a tab writes its #hash, so the address bar always names the visible section.
  const [tab, setTab] = useTabParam<Tab>(TAB_IDS, 'dashboard', { writeHash: true });
  const tabIdBase = useTabIdBase('recruitment');

  // Hiring managers without a recruitment.* permission are let in when the API returns an
  // organization they hire for (presentation only; the API checks every request).
  if (!loading && !permitted && organizations.length === 0) {
    return (
      <PageContainer width="wide" padded={false}>
        <Forbidden message="You do not have permission to view recruitment." />
      </PageContainer>
    );
  }

  const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'openings', label: 'Openings' },
    { id: 'pipeline', label: 'Pipeline' },
    ...(actions?.canReadAllCandidates ? [{ id: 'candidates' as const, label: 'Candidates' }] : []),
    ...(actions?.canManageIntake ? [{ id: 'intake' as const, label: 'Intake' }] : []),
    ...(actions?.canManagePipeline ? [{ id: 'settings' as const, label: 'Settings' }] : []),
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'dashboard';
  const key = `${organizationId}-${version}`;

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Recruitment"
        title="Recruitment"
        description="Job openings, the hiring pipeline, candidates, interviews and offers, through to converting an accepted offer into an employee. Screening is structured and human; nothing is scored automatically."
      >
        {organizations.length > 1 && (
          <label className="text-sm font-medium text-slate-800" htmlFor="recruitment-organization">
            Organization
            <select
              id="recruitment-organization"
              className={inputClass}
              value={organizationId}
              onChange={(event) => {
                setOrganizationId(event.currentTarget.value);
                setIntakeReport(null);
                setIntakeFilter({ status: 'PENDING_OPENING', sourceId: '' });
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
          <LoadingState label="Loading recruitment…" />
        ) : organizations.length === 0 ? (
          <EmptyState>No organizations are within your recruitment access.</EmptyState>
        ) : (
          <>
            <TabList<Tab>
              tabs={tabs}
              active={activeTab}
              onChange={setTab}
              label="Recruitment sections"
              idBase={tabIdBase}
            />
            <TabPanel idBase={tabIdBase} id={activeTab}>
              {activeTab === 'dashboard' && (
                <DashboardTab key={key} organizationId={organizationId} onError={onError} />
              )}
              {activeTab === 'openings' && (
                <OpeningsTab
                  key={key}
                  organizationId={organizationId}
                  canCreate={Boolean(actions?.canCreateOpenings)}
                  filter={openingFilter}
                  onFilter={setOpeningFilter}
                  busy={busy}
                  mutate={mutate}
                  onError={onError}
                />
              )}
              {activeTab === 'pipeline' && (
                <PipelineTab
                  key={key}
                  organizationId={organizationId}
                  filter={pipelineFilter}
                  onFilter={setPipelineFilter}
                  busy={busy}
                  mutate={mutate}
                  onError={onError}
                />
              )}
              {activeTab === 'candidates' && (
                <CandidatesTab
                  key={key}
                  organizationId={organizationId}
                  canCreate={Boolean(actions?.canManageCandidates)}
                  search={candidateSearch}
                  onSearch={setCandidateSearch}
                  busy={busy}
                  mutate={mutate}
                  onError={onError}
                />
              )}
              {activeTab === 'intake' && (
                <IntakeTab
                  key={key}
                  organizationId={organizationId}
                  report={intakeReport}
                  onReport={setIntakeReport}
                  filter={intakeFilter}
                  onFilter={setIntakeFilter}
                  busy={busy}
                  mutate={mutate}
                  onError={onError}
                />
              )}
              {activeTab === 'settings' && (
                <SettingsTab
                  key={key}
                  organizationId={organizationId}
                  busy={busy}
                  mutate={mutate}
                  onError={onError}
                />
              )}
            </TabPanel>
          </>
        )}
      </div>
    </PageContainer>
  );
}
