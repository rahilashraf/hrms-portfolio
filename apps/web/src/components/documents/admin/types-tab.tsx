'use client';

import { useCallback, useState } from 'react';
import { documentsApi } from '../../../lib/documents/api';
import type { Confidentiality, DocumentCategory, DocumentType } from '../../../lib/documents/types';
import {
  ArchivedBadge,
  CATEGORIES,
  CONFIDENTIALITY_LABELS,
  CONFIDENTIALITY_LEVELS,
  EmptyState,
  Field,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
} from '../documents-shared';
import { ConfirmButton } from '../../ui/confirm-button';
import { Loading, type Mutate, checkbox, useData, yes } from './admin-shared';
import { DataTable } from '../../ui/data-table';

// Batch 10E-2: document types and the type editor (moved from documents-admin-page.tsx
// unchanged).
export function TypesTab({
  organizationId,
  canManage,
  busy,
  mutate,
  onError,
}: {
  organizationId: string;
  canManage: boolean;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
}) {
  const [includeArchived, setIncludeArchived] = useState(false);
  const load = useCallback(
    () => documentsApi.types(organizationId, includeArchived),
    [organizationId, includeArchived],
  );
  const { data, loaded } = useData<{ items: DocumentType[] }>(load, onError);
  const [editing, setEditing] = useState<DocumentType | 'new' | null>(null);
  const types = data?.items ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {canManage && !editing && (
          <button type="button" className={primaryButton} onClick={() => setEditing('new')}>
            New document type
          </button>
        )}
        {canManage && (
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() =>
              void mutate(
                () => documentsApi.initializeTypes(organizationId),
                (result) =>
                  (result as { created?: boolean } | undefined)?.created
                    ? 'Default document types created.'
                    : 'The organization already has document types; nothing was added.',
              )
            }
          >
            Initialize default types
          </button>
        )}
        <label className="inline-flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.currentTarget.checked)}
            className={checkbox}
          />
          Show archived types
        </label>
      </div>
      {editing && (
        <TypeEditor
          organizationId={organizationId}
          type={editing === 'new' ? null : editing}
          busy={busy}
          mutate={mutate}
          onDone={() => setEditing(null)}
        />
      )}
      {!loaded ? (
        <Loading />
      ) : types.length === 0 ? (
        <EmptyState>
          No document types yet.
          {canManage ? ' Initialize the defaults or create one.' : ''}
        </EmptyState>
      ) : (
        <DataTable
          label="Document types"
          minWidth="min-w-[880px]"
          rows={types}
          rowKey={(type) => type.id}
          columns={[
            {
              key: 'type',
              header: 'Type',
              rowHeader: true,
              cell: (type) => (
                <>
                  {type.name} {type.archivedAt && <ArchivedBadge />}
                  <span className="block text-xs font-normal text-slate-500">{type.code}</span>
                </>
              ),
            },
            {
              key: 'category',
              header: 'Category',
              cell: (type) => <>{label(type.category)}</>,
            },
            {
              key: 'confidentiality',
              header: 'Default confidentiality',
              cell: (type) => <>{CONFIDENTIALITY_LABELS[type.defaultConfidentiality]}</>,
            },
            {
              key: 'expiry',
              header: 'Expiry tracked',
              cell: (type) => <>{yes(type.expiryTracked)}</>,
            },
            {
              key: 'employeeProvided',
              header: 'Employee provided',
              cell: (type) => <>{yes(type.employeeProvided)}</>,
            },
            {
              key: 'actions',
              header: 'Actions',
              cell: (type) => (
                <>
                  {canManage && !type.archivedAt && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={secondaryButton}
                        aria-label={`Edit ${type.name}`}
                        onClick={() => setEditing(type)}
                      >
                        Edit
                      </button>
                      <ConfirmButton
                        className={secondaryButton}
                        aria-label={`Archive ${type.name}`}
                        disabled={busy}
                        confirm={{
                          title: 'Archive this document type?',
                          description:
                            'It can no longer be used for new documents. Existing documents keep it.',
                          confirmLabel: 'Archive type',
                        }}
                        onConfirm={() =>
                          void mutate(
                            () => documentsApi.archiveType(type.id),
                            'Document type archived.',
                          )
                        }
                      >
                        Archive
                      </ConfirmButton>
                    </div>
                  )}
                  {canManage && type.archivedAt && (
                    <ConfirmButton
                      className={secondaryButton}
                      aria-label={`Reactivate ${type.name}`}
                      disabled={busy}
                      confirm={{
                        title: 'Reactivate this document type?',
                        description:
                          'It can be used again for new documents, requirements and policies. Its settings and existing documents are unchanged.',
                        confirmLabel: 'Reactivate type',
                      }}
                      onConfirm={() =>
                        void mutate(
                          () => documentsApi.reactivateType(type.id),
                          'Document type reactivated.',
                        )
                      }
                    >
                      Reactivate
                    </ConfirmButton>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

function TypeEditor({
  organizationId,
  type,
  busy,
  mutate,
  onDone,
}: {
  organizationId: string;
  type: DocumentType | null;
  busy: boolean;
  mutate: Mutate;
  onDone(): void;
}) {
  const [form, setForm] = useState({
    code: type?.code ?? '',
    name: type?.name ?? '',
    description: type?.description ?? '',
    category: (type?.category ?? 'OTHER') as DocumentCategory,
    defaultConfidentiality: (type?.defaultConfidentiality ?? 'HR_ONLY') as Confidentiality,
    expiryTracked: type?.expiryTracked ?? false,
    employeeProvided: type?.employeeProvided ?? false,
  });
  return (
    <form
      aria-label={type ? 'Edit document type' : 'Create document type'}
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        const shared = {
          name: form.name.trim(),
          description: form.description.trim() || null,
          defaultConfidentiality: form.defaultConfidentiality,
          expiryTracked: form.expiryTracked,
          employeeProvided: form.employeeProvided,
        };
        void mutate(
          () =>
            type
              ? documentsApi.updateType(type.id, shared)
              : documentsApi.createType({
                  organizationId,
                  code: form.code.trim(),
                  category: form.category,
                  ...shared,
                }),
          type ? 'Document type saved.' : 'Document type created.',
        ).then((ok) => {
          if (ok) onDone();
        });
      }}
    >
      <h2 className="text-base font-semibold text-slate-900 sm:col-span-3">
        {type ? `Edit ${type.name}` : 'New document type'}
      </h2>
      {!type && (
        <Field label="Type code">
          <input
            className={inputClass}
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.currentTarget.value })}
          />
        </Field>
      )}
      <Field label="Type name">
        <input
          className={inputClass}
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
        />
      </Field>
      {!type && (
        <Field label="Category">
          <select
            className={inputClass}
            value={form.category}
            onChange={(e) =>
              setForm({ ...form, category: e.currentTarget.value as DocumentCategory })
            }
          >
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {label(category)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Default confidentiality">
        <select
          className={inputClass}
          value={form.defaultConfidentiality}
          onChange={(e) =>
            setForm({ ...form, defaultConfidentiality: e.currentTarget.value as Confidentiality })
          }
        >
          {CONFIDENTIALITY_LEVELS.map((level) => (
            <option key={level} value={level}>
              {CONFIDENTIALITY_LABELS[level]}
            </option>
          ))}
        </select>
      </Field>
      <div className="sm:col-span-3">
        <Field label="Type description">
          <textarea
            className={inputClass}
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.currentTarget.value })}
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          checked={form.expiryTracked}
          onChange={(e) => setForm({ ...form, expiryTracked: e.currentTarget.checked })}
          className={checkbox}
        />
        Expiry tracked
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          checked={form.employeeProvided}
          onChange={(e) => setForm({ ...form, employeeProvided: e.currentTarget.checked })}
          className={checkbox}
        />
        Employees provide it
      </label>
      <div className="flex gap-2 sm:col-span-3">
        <button type="submit" className={primaryButton} disabled={busy}>
          {type ? 'Save type' : 'Create type'}
        </button>
        <button type="button" className={secondaryButton} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
