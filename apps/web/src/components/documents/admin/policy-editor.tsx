'use client';

import { useMemo, useState } from 'react';
import { documentsApi } from '../../../lib/documents/api';
import type {
  DocumentType,
  EmploymentType,
  Policy,
  PickerOption,
} from '../../../lib/documents/types';
import {
  EMPLOYMENT_TYPES,
  Field,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
} from '../documents-shared';
import { documentStructureSource } from '../../../lib/pickers/sources';
import { RecordCombobox } from '../../ui/record-combobox';
import { type Mutate, checkbox } from './admin-shared';

// Batch 10E-2: moved from documents-admin-page.tsx unchanged.
export function PolicyEditor({
  organizationId,
  policy,
  types,
  busy,
  mutate,
  onDone,
}: {
  organizationId: string;
  policy: Policy | null;
  types: DocumentType[];
  busy: boolean;
  mutate: Mutate;
  onDone(): void;
}) {
  const audienceDepartments = useMemo(
    () => documentStructureSource(organizationId, 'department'),
    [organizationId],
  );
  const [form, setForm] = useState({
    code: policy?.code ?? '',
    title: policy?.title ?? '',
    description: policy?.description ?? '',
    typeId: policy?.typeId ?? '',
    acknowledgementRequired: policy?.acknowledgementRequired ?? true,
    audienceEmploymentType: (policy?.audience.employmentType ?? '') as EmploymentType | '',
    audienceDepartment: (policy?.audience.departmentId
      ? {
          id: policy.audience.departmentId,
          label: policy.audience.departmentName ?? 'Department',
        }
      : null) as PickerOption | null,
  });
  return (
    <form
      aria-label={policy ? 'Edit policy' : 'Create policy'}
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        const shared = {
          title: form.title.trim(),
          description: form.description.trim() || null,
          acknowledgementRequired: form.acknowledgementRequired,
          audienceEmploymentType: form.audienceEmploymentType || null,
          audienceDepartmentId: form.audienceDepartment?.id ?? null,
        };
        void mutate(
          () =>
            policy
              ? documentsApi.updatePolicy(policy.id, shared)
              : documentsApi.createPolicy({
                  organizationId,
                  code: form.code.trim(),
                  typeId: form.typeId || null,
                  ...shared,
                }),
          policy ? 'Policy saved.' : 'Policy created as a draft. Add a version to publish it.',
        ).then((ok) => {
          if (ok) onDone();
        });
      }}
    >
      <h2 className="text-base font-semibold text-slate-900 sm:col-span-3">
        {policy ? `Edit ${policy.title}` : 'New policy'}
      </h2>
      {!policy && (
        <Field label="Policy code">
          <input
            className={inputClass}
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.currentTarget.value })}
          />
        </Field>
      )}
      <Field label="Policy title">
        <input
          className={inputClass}
          required
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.currentTarget.value })}
        />
      </Field>
      {!policy && (
        <Field label="Document type (optional)">
          <select
            className={inputClass}
            value={form.typeId}
            onChange={(e) => setForm({ ...form, typeId: e.currentTarget.value })}
          >
            <option value="">None</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="sm:col-span-3">
        <Field label="Policy description">
          <textarea
            className={inputClass}
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.currentTarget.value })}
          />
        </Field>
      </div>
      <Field label="Audience employment type">
        <select
          className={inputClass}
          value={form.audienceEmploymentType}
          onChange={(e) =>
            setForm({
              ...form,
              audienceEmploymentType: e.currentTarget.value as EmploymentType | '',
            })
          }
        >
          <option value="">Everyone</option>
          {EMPLOYMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {label(type)}
            </option>
          ))}
        </select>
      </Field>
      <RecordCombobox
        label="Audience department (optional)"
        source={audienceDepartments}
        value={form.audienceDepartment?.id ?? ''}
        selected={form.audienceDepartment}
        onChange={(_id, option) => setForm({ ...form, audienceDepartment: option })}
        placeholder="Every department"
        noResultsText="No departments match."
      />
      <label className="flex items-center gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          checked={form.acknowledgementRequired}
          onChange={(e) => setForm({ ...form, acknowledgementRequired: e.currentTarget.checked })}
          className={checkbox}
        />
        Employees must acknowledge it
      </label>
      <div className="flex gap-2 sm:col-span-3">
        <button type="submit" className={primaryButton} disabled={busy}>
          {policy ? 'Save policy' : 'Create policy'}
        </button>
        <button type="button" className={secondaryButton} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
