'use client';

import { useCallback, useState } from 'react';
import { documentsApi } from '../../../lib/documents/api';
import type { DocumentType } from '../../../lib/documents/types';
import { EmptyState, PolicyStatusBadge, primaryButton, secondaryButton } from '../documents-shared';
import { Loading, type Mutate, useData } from './admin-shared';
import { PolicyEditor } from './policy-editor';
import { PolicyPanel } from './policy-panel';
import { DataTable } from '../../ui/data-table';

// Batch 10E-2: moved from documents-admin-page.tsx unchanged.
export function PoliciesTab({
  organizationId,
  version,
  canManage,
  busy,
  mutate,
  onError,
}: {
  organizationId: string;
  version: number;
  canManage: boolean;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
}) {
  const load = useCallback(
    () =>
      Promise.all([
        documentsApi.policies(organizationId),
        documentsApi.types(organizationId).catch(() => ({ items: [] as DocumentType[] })),
      ]),
    [organizationId],
  );
  // `version` reloads the list after every change while keeping the open policy.
  const { data, loaded } = useData(load, onError, version);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  if (!loaded && !data) return <Loading />;
  const policies = data?.[0].items ?? [];
  const types = data?.[1].items ?? [];
  const policy = policies.find((p) => p.id === selected) ?? null;
  return (
    <div className="space-y-4">
      {canManage && !creating && (
        <button type="button" className={primaryButton} onClick={() => setCreating(true)}>
          New policy
        </button>
      )}
      {canManage && creating && (
        <PolicyEditor
          organizationId={organizationId}
          policy={null}
          types={types}
          busy={busy}
          mutate={mutate}
          onDone={() => setCreating(false)}
        />
      )}
      {policies.length === 0 ? (
        <EmptyState>No policies yet.</EmptyState>
      ) : (
        <DataTable
          label="Policies"
          rows={policies}
          rowKey={(item) => item.id}
          columns={[
            {
              key: 'policy',
              header: 'Policy',
              rowHeader: true,
              cell: (item) => (
                <>
                  {item.title}
                  <span className="block text-xs font-normal text-slate-500">{item.code}</span>
                </>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (item) => (
                <>
                  <PolicyStatusBadge status={item.status} />
                </>
              ),
            },
            {
              key: 'current',
              header: 'Current version',
              cell: (item) => <>{item.currentVersion?.versionLabel ?? '—'}</>,
            },
            {
              key: 'acknowledgement',
              header: 'Acknowledgement',
              cell: (item) => <>{item.acknowledgementRequired ? 'Required' : 'Not required'}</>,
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              cell: (item) => (
                <>
                  <button
                    type="button"
                    className={secondaryButton}
                    aria-label={`Open ${item.title}`}
                    onClick={() => setSelected(selected === item.id ? null : item.id)}
                  >
                    {selected === item.id ? 'Close' : 'Open'}
                  </button>
                </>
              ),
            },
          ]}
        />
      )}
      {policy && (
        <PolicyPanel
          key={policy.id}
          policy={policy}
          types={types}
          version={version}
          canManage={canManage}
          busy={busy}
          mutate={mutate}
        />
      )}
    </div>
  );
}
