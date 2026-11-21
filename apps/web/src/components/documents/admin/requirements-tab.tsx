'use client';

import { useCallback, useMemo, useState } from 'react';
import { documentsApi } from '../../../lib/documents/api';
import type {
  DocumentRequirement,
  EmploymentType,
  PickerOption,
} from '../../../lib/documents/types';
import {
  ArchivedBadge,
  dateTimeText,
  EmptyState,
  EMPLOYMENT_TYPES,
  Field,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
} from '../documents-shared';
import { ConfirmButton } from '../../ui/confirm-button';
import { documentStructureSource } from '../../../lib/pickers/sources';
import type { RecordSource } from '../../../lib/pickers/use-record-search';
import { FormDialog } from '../../ui/form-dialog';
import { RecordCombobox } from '../../ui/record-combobox';
import { Loading, type Mutate, checkbox, useData } from './admin-shared';
import { DataTable } from '../../ui/data-table';

// Batch 10E-2: requirements, their criteria and replacement (moved from
// documents-admin-page.tsx unchanged).
export function RequirementsTab({
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
  const departments = useMemo(
    () => documentStructureSource(organizationId, 'department'),
    [organizationId],
  );
  const positions = useMemo(
    () => documentStructureSource(organizationId, 'position'),
    [organizationId],
  );
  const [showHistory, setShowHistory] = useState(false);
  const load = useCallback(
    () =>
      Promise.all([
        documentsApi.requirements(organizationId, showHistory),
        documentsApi.types(organizationId),
      ]),
    [organizationId, showHistory],
  );
  const { data, loaded } = useData(load, onError);
  const [form, setForm] = useState<CriteriaForm>(emptyCriteria());
  const [replacing, setReplacing] = useState<DocumentRequirement | null>(null);
  if (!loaded) return <Loading />;
  const requirements = data?.[0].items ?? [];
  const types = data?.[1].items ?? [];
  const typeId = form.typeId || types[0]?.id || '';
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        A requirement applies to employees whose assignment matches every criterion it sets.
        Changing a requirement replaces it: the previous one is archived and kept in the history.
      </p>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className={checkbox}
          checked={showHistory}
          onChange={(e) => setShowHistory(e.currentTarget.checked)}
        />
        Show archived requirements (history)
      </label>
      {requirements.length === 0 ? (
        <EmptyState>No required documents.</EmptyState>
      ) : (
        <DataTable
          label="Requirements"
          minWidth="min-w-[760px]"
          rows={requirements}
          rowKey={(requirement) => requirement.id}
          columns={[
            {
              key: 'type',
              header: 'Document type',
              rowHeader: true,
              cell: (requirement) => <>{requirement.typeName ?? 'Document type'}</>,
            },
            {
              key: 'appliesTo',
              header: 'Applies to',
              cell: (requirement) => <>{requirementCriteria(requirement)}</>,
            },
            {
              key: 'note',
              header: 'Note',
              cell: (requirement) => <>{requirement.note ?? '—'}</>,
            },
            {
              key: 'status',
              header: 'Status',
              cell: (requirement) => (
                <>
                  {requirement.archivedAt ? (
                    <>
                      <ArchivedBadge />
                      <span className="block text-xs text-slate-500">
                        {dateTimeText(requirement.archivedAt)}
                      </span>
                    </>
                  ) : (
                    'Active'
                  )}
                </>
              ),
            },
            {
              key: 'actions',
              header: 'Actions',
              cell: (requirement) => (
                <>
                  {canManage && !requirement.archivedAt && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={secondaryButton}
                        aria-label={`Change requirement ${requirement.typeName ?? ''}`.trim()}
                        disabled={busy}
                        onClick={() => setReplacing(requirement)}
                      >
                        Change
                      </button>
                      <ConfirmButton
                        className={secondaryButton}
                        aria-label={`Archive requirement ${requirement.typeName ?? ''}`.trim()}
                        disabled={busy}
                        confirm={{
                          title: 'Archive this requirement?',
                          description:
                            'Employees are no longer asked for this document. Documents already provided are kept.',
                          confirmLabel: 'Archive requirement',
                        }}
                        onConfirm={() =>
                          void mutate(
                            () => documentsApi.archiveRequirement(requirement.id),
                            'Requirement archived.',
                          )
                        }
                      >
                        Archive
                      </ConfirmButton>
                    </div>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
      {replacing && (
        <ReplaceRequirementDialog
          requirement={replacing}
          departments={departments}
          positions={positions}
          busy={busy}
          mutate={mutate}
          onClose={() => setReplacing(null)}
        />
      )}
      {canManage && (
        <form
          aria-label="Add requirement"
          className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!typeId) return;
            void mutate(
              () =>
                documentsApi.createRequirement({
                  organizationId,
                  typeId,
                  ...criteriaInput(form),
                }),
              'Requirement added.',
            ).then((ok) => {
              if (ok) setForm(emptyCriteria());
            });
          }}
        >
          <h2 className="text-base font-semibold text-slate-900 sm:col-span-3">
            Add a required document
          </h2>
          <Field label="Required type">
            <select
              className={inputClass}
              value={typeId}
              onChange={(e) => setForm({ ...form, typeId: e.currentTarget.value })}
            >
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </Field>
          <CriteriaFields
            form={form}
            onChange={(patch) => setForm({ ...form, ...patch })}
            departments={departments}
            positions={positions}
          />
          <div className="sm:col-span-3">
            <button type="submit" className={primaryButton} disabled={busy || !typeId}>
              Add requirement
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

interface CriteriaForm {
  typeId: string;
  employmentType: EmploymentType | '';
  department: PickerOption | null;
  position: PickerOption | null;
  note: string;
}

const emptyCriteria = (): CriteriaForm => ({
  typeId: '',
  employmentType: '',
  department: null,
  position: null,
  note: '',
});

const criteriaInput = (form: CriteriaForm) => ({
  employmentType: form.employmentType || null,
  departmentId: form.department?.id ?? null,
  positionId: form.position?.id ?? null,
  note: form.note.trim() || null,
});

/** Who a requirement applies to, by name (never raw ids). */
export function requirementCriteria(requirement: DocumentRequirement): string {
  return (
    [
      requirement.employmentType ? label(requirement.employmentType) : null,
      requirement.departmentId
        ? `Department ${requirement.departmentName ?? '(unavailable)'}`
        : null,
      requirement.positionId ? `Position ${requirement.positionName ?? '(unavailable)'}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'Everyone in the organization'
  );
}

/** Employment type, department and position pickers (authorized options) and the note. */
function CriteriaFields({
  form,
  onChange,
  departments,
  positions,
}: {
  form: CriteriaForm;
  onChange(patch: Partial<CriteriaForm>): void;
  departments: RecordSource<PickerOption>;
  positions: RecordSource<PickerOption>;
}) {
  return (
    <>
      <Field label="Employment type">
        <select
          className={inputClass}
          value={form.employmentType}
          onChange={(e) =>
            onChange({ employmentType: e.currentTarget.value as EmploymentType | '' })
          }
        >
          <option value="">Any</option>
          {EMPLOYMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {label(type)}
            </option>
          ))}
        </select>
      </Field>
      <RecordCombobox
        label="Department (optional)"
        source={departments}
        value={form.department?.id ?? ''}
        selected={form.department}
        onChange={(_id, option) => onChange({ department: option ?? null })}
        placeholder="Any department"
        noResultsText="No departments match."
      />
      <RecordCombobox
        label="Position (optional)"
        source={positions}
        value={form.position?.id ?? ''}
        selected={form.position}
        onChange={(_id, option) => onChange({ position: option ?? null })}
        placeholder="Any position"
        noResultsText="No positions match."
      />
      <div className="sm:col-span-2">
        <Field label="Requirement note">
          <input
            className={inputClass}
            value={form.note}
            onChange={(e) => onChange({ note: e.currentTarget.value })}
          />
        </Field>
      </div>
    </>
  );
}

/**
 * Batch 9 (D10): a requirement is changed by replacing it — the current one is archived (kept
 * in the history) and the replacement is added, in one step.
 */
function ReplaceRequirementDialog({
  requirement,
  departments,
  positions,
  busy,
  mutate,
  onClose,
}: {
  requirement: DocumentRequirement;
  departments: RecordSource<PickerOption>;
  positions: RecordSource<PickerOption>;
  busy: boolean;
  mutate: Mutate;
  onClose(): void;
}) {
  const [form, setForm] = useState<CriteriaForm>({
    typeId: requirement.typeId,
    employmentType: requirement.employmentType ?? '',
    department: requirement.departmentId
      ? { id: requirement.departmentId, label: requirement.departmentName ?? 'Department' }
      : null,
    position: requirement.positionId
      ? { id: requirement.positionId, label: requirement.positionName ?? 'Position' }
      : null,
    note: requirement.note ?? '',
  });
  const input = criteriaInput(form);
  const unchanged =
    input.employmentType === requirement.employmentType &&
    input.departmentId === requirement.departmentId &&
    input.positionId === requirement.positionId &&
    input.note === requirement.note;
  return (
    <FormDialog
      open
      title={`Change requirement: ${requirement.typeName ?? 'document'}`}
      description={`Currently applies to: ${requirementCriteria(requirement)}. Saving archives this requirement (it stays in the history) and adds the replacement.`}
      submitLabel="Replace requirement"
      busy={busy}
      canSubmit={!unchanged}
      error={null}
      onClose={onClose}
      onSubmit={() =>
        void mutate(
          () => documentsApi.replaceRequirement(requirement.id, input),
          'Requirement replaced. The previous version is kept in the history.',
        ).then((ok) => {
          if (ok) onClose();
        })
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CriteriaFields
          form={form}
          onChange={(patch) => setForm({ ...form, ...patch })}
          departments={departments}
          positions={positions}
        />
      </div>
      {unchanged && (
        <p className="mt-2 text-xs text-slate-600">Change at least one criterion or the note.</p>
      )}
    </FormDialog>
  );
}
