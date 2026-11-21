'use client';

import { useCallback, useState } from 'react';
import { onboardingApi } from '../../../lib/onboarding/api';
import type { Template } from '../../../lib/onboarding/types';
import {
  EmptyState,
  KIND_LABELS,
  primaryButton,
  secondaryButton,
  TemplateStatusBadge,
} from '../onboarding-shared';
import { ConfirmButton } from '../../ui/confirm-button';
import { Loading, Mutate, useData } from './admin-shared';
import { TemplateEditor } from './template-editor';
import { DataTable } from '../../ui/data-table';

// Batch 10E-1: moved from onboarding-admin-page.tsx unchanged.
export function TemplatesTab({
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
  const load = useCallback(() => onboardingApi.templates(organizationId), [organizationId]);
  const { data, loaded } = useData<{ items: Template[] }>(load, onError);
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  if (!loaded) return <Loading />;
  const templates = data?.items ?? [];
  return (
    <div className="space-y-4">
      {editing ? (
        <TemplateEditor
          organizationId={organizationId}
          template={editing === 'new' ? null : editing}
          busy={busy}
          mutate={mutate}
          onDone={() => setEditing(null)}
        />
      ) : (
        <button type="button" className={primaryButton} onClick={() => setEditing('new')}>
          New template
        </button>
      )}
      {templates.length === 0 ? (
        <EmptyState>No templates yet.</EmptyState>
      ) : (
        <DataTable
          label="Templates"
          rows={templates}
          rowKey={(template) => template.id}
          columns={[
            {
              key: 'template',
              header: 'Template',
              rowHeader: true,
              cell: (template) => (
                <>
                  {template.name}
                  <span className="block text-xs font-normal text-slate-500">
                    {template.code}
                    {template.isDefault ? ' · Default' : ''}
                  </span>
                </>
              ),
            },
            {
              key: 'kind',
              header: 'Kind',
              cell: (template) => <>{KIND_LABELS[template.kind]}</>,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (template) => (
                <>
                  <TemplateStatusBadge status={template.status} />
                </>
              ),
            },
            {
              key: 'tasks',
              header: 'Tasks',
              cell: (template) => <>{template.tasks.length}</>,
            },
            {
              key: 'workflows',
              header: 'Workflows',
              cell: (template) => <>{template.workflowCount}</>,
            },
            {
              key: 'actions',
              header: 'Actions',
              cell: (template) => (
                <>
                  <div className="flex flex-wrap gap-2">
                    {template.status !== 'ARCHIVED' && (
                      <button
                        type="button"
                        className={secondaryButton}
                        aria-label={`Edit ${template.name}`}
                        onClick={() => setEditing(template)}
                      >
                        Edit
                      </button>
                    )}
                    {template.status === 'DRAFT' && (
                      <button
                        type="button"
                        className={secondaryButton}
                        aria-label={`Activate ${template.name}`}
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            () => onboardingApi.activateTemplate(template.id),
                            'Template activated.',
                          )
                        }
                      >
                        Activate
                      </button>
                    )}
                    {template.status === 'ACTIVE' && !template.isDefault && (
                      <button
                        type="button"
                        className={secondaryButton}
                        aria-label={`Make ${template.name} the default`}
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            () => onboardingApi.setDefaultTemplate(template.id),
                            'Default template set.',
                          )
                        }
                      >
                        Set default
                      </button>
                    )}
                    {template.status !== 'ARCHIVED' && (
                      <ConfirmButton
                        className={secondaryButton}
                        aria-label={`Archive ${template.name}`}
                        disabled={busy}
                        confirm={{
                          title: 'Archive this template?',
                          description:
                            'It can no longer be used to start new workflows. Workflows already started from it continue.',
                          confirmLabel: 'Archive template',
                        }}
                        onConfirm={() =>
                          void mutate(
                            () => onboardingApi.archiveTemplate(template.id),
                            'Template archived.',
                          )
                        }
                      >
                        Archive
                      </ConfirmButton>
                    )}
                  </div>
                </>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
