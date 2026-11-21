'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { documentsApi } from '../../lib/documents/api';
import { documentsErrorMessage } from '../../lib/documents/errors';
import type { DocumentsOrganization, UploadCapability } from '../../lib/documents/types';
import {
  DOCUMENT_PERMISSION_KEYS,
  EmptyState,
  inputClass,
  UploadCapabilityContext,
} from './documents-shared';
import { RequirePermission } from '../ui/require-permission';
import { useTabParam } from '../../lib/navigation/use-tab-param';
import { PageContainer } from '../ui/page-container';
import { LoadingState } from '../ui/states';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import type { Mutate } from './admin/admin-shared';
import { ExpiringTab, MissingTab } from './admin/dashboards';
import { PoliciesTab } from './admin/policies-tab';
import { RequirementsTab } from './admin/requirements-tab';
import { TypesTab } from './admin/types-tab';

type Tab = 'types' | 'requirements' | 'policies' | 'expiring' | 'missing';
const TAB_IDS: readonly Tab[] = ['types', 'requirements', 'policies', 'expiring', 'missing'];

/**
 * Documents & employee records administration: visible with any document.* permission (the API
 * decides which organizations, types, policies and records are reachable).
 */
export function DocumentsAdminPage() {
  // Batch 10A: a loading state in the page's own width while access is checked (no "Access
  // denied" flash, no width jump). The API decides what is reachable.
  return (
    <RequirePermission
      anyOf={DOCUMENT_PERMISSION_KEYS}
      width="wide"
      deniedMessage="You do not have permission to view documents."
    >
      <DocumentsAdmin />
    </RequirePermission>
  );
}

function DocumentsAdmin() {
  const [organizations, setOrganizations] = useState<DocumentsOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  // Batch 10E-2: /admin/documents#policies deep-links a section; picking one writes it.
  const [tab, setTab] = useTabParam<Tab>(TAB_IDS, 'types', { writeHash: true });
  const tabIdBase = useTabIdBase('documents-admin');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [uploads, setUploads] = useState<UploadCapability | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      documentsApi
        .organizations()
        .then((result) => {
          setOrganizations(result.items);
          setUploads(result.uploads ?? null);
          setOrganizationId((current) => current || result.items[0]?.id || '');
        })
        .catch((cause) => setError(documentsErrorMessage(cause, 'Unable to load organizations.')))
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
      const result = await action();
      setSuccess(typeof message === 'function' ? message(result) : message);
      setVersion((v) => v + 1);
      return true;
    } catch (cause) {
      setError(documentsErrorMessage(cause, 'Unable to complete the documents action.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: 'types', label: 'Document types' },
    { id: 'requirements', label: 'Requirements' },
    { id: 'policies', label: 'Policies' },
    { id: 'expiring', label: 'Expiring' },
    { id: 'missing', label: 'Missing' },
  ];
  const key = `${organizationId}-${version}`;

  return (
    <UploadCapabilityContext.Provider value={uploads}>
      <PageContainer width="wide">
        <PageHeader
          eyebrow="Documents"
          title="Documents & employee records"
          description="Document types and required documents, organization policies with versioned acknowledgements, and dashboards of expiring and missing records. Documents are uploaded files (PDF, PNG, JPEG) or references to where they are kept."
        >
          {organizations.length > 1 && (
            <label className="text-sm font-medium text-slate-800" htmlFor="documents-organization">
              Organization
              <select
                id="documents-organization"
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
            <LoadingState label="Loading documents…" />
          ) : organizations.length === 0 || !actions ? (
            <EmptyState>No organizations are within your documents access.</EmptyState>
          ) : (
            <>
              <TabList<Tab>
                tabs={tabs}
                active={tab}
                onChange={setTab}
                label="Documents sections"
                idBase={tabIdBase}
              />
              <TabPanel idBase={tabIdBase} id={tab}>
                {tab === 'types' && (
                  <TypesTab
                    key={key}
                    organizationId={organizationId}
                    canManage={actions.canManageTypes}
                    busy={busy}
                    mutate={mutate}
                    onError={onError}
                  />
                )}
                {tab === 'requirements' && (
                  <RequirementsTab
                    key={key}
                    organizationId={organizationId}
                    canManage={actions.canManageTypes}
                    busy={busy}
                    mutate={mutate}
                    onError={onError}
                  />
                )}
                {tab === 'policies' && (
                  <PoliciesTab
                    key={organizationId}
                    version={version}
                    organizationId={organizationId}
                    canManage={actions.canManagePolicies}
                    busy={busy}
                    mutate={mutate}
                    onError={onError}
                  />
                )}
                {tab === 'expiring' && (
                  <ExpiringTab key={key} organizationId={organizationId} onError={onError} />
                )}
                {tab === 'missing' && (
                  <MissingTab key={key} organizationId={organizationId} onError={onError} />
                )}
              </TabPanel>
            </>
          )}
        </div>
      </PageContainer>
    </UploadCapabilityContext.Provider>
  );
}
