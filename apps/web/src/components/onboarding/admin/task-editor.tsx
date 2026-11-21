'use client';

import { checkboxClass } from '../../ui/tokens';

import { useEffect, useRef, useState } from 'react';
import { documentsApi } from '../../../lib/documents/api';
import type { DocumentType, Policy } from '../../../lib/documents/types';
import type { TemplateTaskInput } from '../../../lib/onboarding/api';
import type {
  ReferenceType,
  SystemAction,
  TaskCategory,
  TaskOwnerType,
  Template,
} from '../../../lib/onboarding/types';
import {
  CATEGORIES,
  Field,
  inputClass,
  isRecordReference,
  label,
  OWNER_TYPE_LABELS,
  REFERENCE_TYPE_LABELS,
  secondaryButton,
  SYSTEM_ACTION_LABELS,
} from '../onboarding-shared';
import { TaskOwnerPicker } from '../onboarding-pickers';

// Batch 10E-1: one template task and its references (moved from
// onboarding-admin-page.tsx unchanged).
export interface TaskForm {
  /** The saved template task this row edits; absent for a new task. */
  id?: string;
  title: string;
  description: string;
  category: TaskCategory;
  ownerType: TaskOwnerType;
  ownerUserId: string;
  dueOffsetDays: string;
  required: boolean;
  evidenceRequired: boolean;
  acknowledgementRequired: boolean;
  acknowledgementStatement: string;
  referenceType: ReferenceType | '';
  referenceUrl: string;
  referenceExternalId: string;
  referenceLabel: string;
  systemAction: SystemAction;
}

export const emptyTask = (): TaskForm => ({
  title: '',
  description: '',
  category: 'PAPERWORK',
  ownerType: 'EMPLOYEE',
  ownerUserId: '',
  dueOffsetDays: '0',
  required: true,
  evidenceRequired: false,
  acknowledgementRequired: false,
  acknowledgementStatement: '',
  referenceType: '',
  referenceUrl: '',
  referenceExternalId: '',
  referenceLabel: '',
  systemAction: 'NONE',
});

export function taskToForm(task: Template['tasks'][number]): TaskForm {
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    category: task.category,
    ownerType: task.ownerType,
    ownerUserId: task.ownerUserId ?? '',
    dueOffsetDays: String(task.dueOffsetDays),
    required: task.required,
    evidenceRequired: task.evidenceRequired,
    acknowledgementRequired: task.acknowledgementRequired,
    acknowledgementStatement: task.acknowledgementStatement ?? '',
    referenceType: task.referenceType ?? '',
    referenceUrl: task.referenceUrl ?? '',
    referenceExternalId: task.referenceExternalId ?? '',
    referenceLabel: task.referenceLabel ?? '',
    systemAction: task.systemAction,
  };
}

export function formToTask(form: TaskForm): TemplateTaskInput {
  const acknowledgement = form.ownerType === 'EMPLOYEE' && form.acknowledgementRequired;
  const offset = Number.parseInt(form.dueOffsetDays, 10);
  return {
    ...(form.id ? { id: form.id } : {}),
    title: form.title.trim(),
    description: form.description.trim() || null,
    category: form.category,
    ownerType: form.ownerType,
    ownerUserId: form.ownerType === 'SPECIFIC_USER' ? form.ownerUserId.trim() || null : null,
    dueOffsetDays: Number.isNaN(offset) ? 0 : offset,
    required: form.required,
    evidenceRequired: form.evidenceRequired,
    acknowledgementRequired: acknowledgement,
    acknowledgementStatement: acknowledgement ? form.acknowledgementStatement.trim() || null : null,
    referenceType: form.referenceType || null,
    referenceUrl:
      form.referenceType && !isRecordReference(form.referenceType)
        ? form.referenceUrl.trim() || null
        : null,
    referenceExternalId: form.referenceType ? form.referenceExternalId.trim() || null : null,
    referenceLabel: form.referenceType ? form.referenceLabel.trim() || null : null,
    systemAction: form.systemAction,
  };
}

/** Policies and document types a Phase 15 reference may name (null until loaded / on failure). */
interface RecordOptions {
  loaded: boolean;
  policies: Policy[] | null;
  types: DocumentType[] | null;
}

/** Loads the organization's policies and document types once a task needs them. */
export function useRecordOptions(organizationId: string, needed: boolean): RecordOptions {
  const [state, setState] = useState<RecordOptions & { organizationId: string | null }>({
    organizationId: null,
    loaded: false,
    policies: null,
    types: null,
  });
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!needed || started.current === organizationId) return;
    const timer = window.setTimeout(() => {
      started.current = organizationId;
      void Promise.allSettled([
        documentsApi.policies(organizationId),
        documentsApi.types(organizationId),
      ]).then(([policies, types]) =>
        setState({
          organizationId,
          loaded: true,
          policies: policies.status === 'fulfilled' ? policies.value.items : null,
          types: types.status === 'fulfilled' ? types.value.items : null,
        }),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [organizationId, needed]);
  return state.organizationId === organizationId
    ? state
    : { loaded: false, policies: null, types: null };
}

/**
 * The HRMS record a POLICY_DOCUMENT / DOCUMENT_TYPE reference names: picked from the
 * organization's policies or document types, or typed as an id when they cannot be loaded.
 */
function RecordReferencePicker({
  task,
  records,
  onChange,
}: {
  task: TaskForm;
  records: RecordOptions;
  onChange(patch: Partial<TaskForm>): void;
}) {
  const policy = task.referenceType === 'POLICY_DOCUMENT';
  const fieldLabel = policy ? 'Policy' : 'Document type';
  const options = (policy ? records.policies : records.types)?.map((item) => ({
    id: item.id,
    name: 'title' in item ? item.title : item.name,
  }));
  if (!records.loaded) {
    return (
      <p role="status" className="self-end text-sm text-slate-600">
        Loading {policy ? 'policies' : 'document types'}…
      </p>
    );
  }
  if (!options) {
    return (
      <Field label={`${fieldLabel} ID`}>
        <input
          className={inputClass}
          required
          value={task.referenceExternalId}
          onChange={(e) => onChange({ referenceExternalId: e.currentTarget.value })}
        />
      </Field>
    );
  }
  return (
    <Field label={fieldLabel}>
      <select
        className={inputClass}
        required
        value={task.referenceExternalId}
        onChange={(e) => {
          const id = e.currentTarget.value;
          const chosen = options.find((option) => option.id === id);
          const previous = options.find((option) => option.id === task.referenceExternalId);
          onChange({
            referenceExternalId: id,
            ...(chosen && (!task.referenceLabel.trim() || task.referenceLabel === previous?.name)
              ? { referenceLabel: chosen.name }
              : {}),
          });
        }}
      >
        <option value="">Choose…</option>
        {task.referenceExternalId &&
          !options.some((option) => option.id === task.referenceExternalId) && (
            <option value={task.referenceExternalId}>{task.referenceExternalId}</option>
          )}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TaskEditor({
  index,
  count,
  task,
  records,
  organizationId,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  task: TaskForm;
  records: RecordOptions;
  organizationId: string;
  onChange(patch: Partial<TaskForm>): void;
  onMove(by: number): void;
  onRemove(): void;
}) {
  const check = (
    key: 'required' | 'evidenceRequired' | 'acknowledgementRequired',
    text: string,
  ) => (
    <label className="flex items-center gap-2 text-sm text-slate-800">
      <input
        type="checkbox"
        checked={task[key]}
        onChange={(e) => onChange({ [key]: e.currentTarget.checked })}
        className={checkboxClass}
      />
      {text}
    </label>
  );
  return (
    <li>
      <fieldset
        aria-label={`Task ${index + 1}`}
        className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-4"
      >
        <legend className="px-1 text-sm font-semibold text-slate-900">Task {index + 1}</legend>
        <div className="sm:col-span-2">
          <Field label="Title">
            <input
              className={inputClass}
              required
              value={task.title}
              onChange={(e) => onChange({ title: e.currentTarget.value })}
            />
          </Field>
        </div>
        <Field label="Category">
          <select
            className={inputClass}
            value={task.category}
            onChange={(e) => onChange({ category: e.currentTarget.value as TaskCategory })}
          >
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {label(category)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due offset (days)">
          <input
            className={inputClass}
            type="number"
            min={-365}
            max={365}
            value={task.dueOffsetDays}
            onChange={(e) => onChange({ dueOffsetDays: e.currentTarget.value })}
          />
        </Field>
        <div className="sm:col-span-4">
          <Field label="Description">
            <textarea
              className={inputClass}
              rows={2}
              value={task.description}
              onChange={(e) => onChange({ description: e.currentTarget.value })}
            />
          </Field>
        </div>
        <Field label="Owner">
          <select
            className={inputClass}
            value={task.ownerType}
            onChange={(e) => {
              const ownerType = e.currentTarget.value as TaskOwnerType;
              onChange({
                ownerType,
                ...(ownerType !== 'EMPLOYEE' ? { acknowledgementRequired: false } : {}),
              });
            }}
          >
            {(Object.keys(OWNER_TYPE_LABELS) as TaskOwnerType[]).map((type) => (
              <option key={type} value={type}>
                {OWNER_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </Field>
        {task.ownerType === 'SPECIFIC_USER' && (
          <TaskOwnerPicker
            organizationId={organizationId}
            label="Owner person"
            required
            value={task.ownerUserId}
            onChange={(ownerUserId) => onChange({ ownerUserId })}
          />
        )}
        <Field label="System action">
          <select
            className={inputClass}
            value={task.systemAction}
            onChange={(e) => onChange({ systemAction: e.currentTarget.value as SystemAction })}
          >
            {(Object.keys(SYSTEM_ACTION_LABELS) as SystemAction[]).map((action) => (
              <option key={action} value={action}>
                {SYSTEM_ACTION_LABELS[action]}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex flex-col justify-end gap-1">
          {check('required', 'Required')}
          {check('evidenceRequired', 'Evidence required')}
          {task.ownerType === 'EMPLOYEE' &&
            check('acknowledgementRequired', 'Acknowledgement required')}
        </div>
        {task.ownerType === 'EMPLOYEE' && task.acknowledgementRequired && (
          <div className="sm:col-span-4">
            <Field label="Acknowledgement statement">
              <textarea
                className={inputClass}
                rows={2}
                required
                value={task.acknowledgementStatement}
                onChange={(e) => onChange({ acknowledgementStatement: e.currentTarget.value })}
              />
            </Field>
          </div>
        )}
        <Field label="Reference type">
          <select
            className={inputClass}
            value={task.referenceType}
            onChange={(e) => {
              const referenceType = e.currentTarget.value as ReferenceType | '';
              onChange({
                referenceType,
                // A record reference names a policy or a type: never carry an id across kinds.
                ...(referenceType !== task.referenceType &&
                (isRecordReference(referenceType) || isRecordReference(task.referenceType))
                  ? { referenceExternalId: '' }
                  : {}),
                // A required-document task belongs to the employee, who completes it by
                // providing the document; a policy task is the employee's acknowledgement.
                ...(referenceType === 'DOCUMENT_TYPE'
                  ? { ownerType: 'EMPLOYEE' as const, acknowledgementRequired: false }
                  : {}),
                ...(referenceType === 'POLICY_DOCUMENT'
                  ? { ownerType: 'EMPLOYEE' as const, acknowledgementRequired: true }
                  : {}),
              });
            }}
          >
            <option value="">None</option>
            {(Object.keys(REFERENCE_TYPE_LABELS) as ReferenceType[]).map((type) => (
              <option key={type} value={type}>
                {REFERENCE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </Field>
        {isRecordReference(task.referenceType) && (
          <>
            <RecordReferencePicker task={task} records={records} onChange={onChange} />
            <Field label="Reference label">
              <input
                className={inputClass}
                value={task.referenceLabel}
                onChange={(e) => onChange({ referenceLabel: e.currentTarget.value })}
              />
            </Field>
            <p className="text-xs text-slate-600 sm:col-span-4">
              {task.referenceType === 'POLICY_DOCUMENT'
                ? 'The employee acknowledges the policy’s current published version through this task; the acknowledgement is recorded in Documents.'
                : 'The task is complete once the employee holds a valid document of this type (they can provide it in My documents).'}
            </p>
          </>
        )}
        {task.referenceType && !isRecordReference(task.referenceType) && (
          <>
            <Field label="Reference link (https)">
              <input
                className={inputClass}
                type="url"
                value={task.referenceUrl}
                onChange={(e) => onChange({ referenceUrl: e.currentTarget.value })}
              />
            </Field>
            <Field label="External resource ID">
              <input
                className={inputClass}
                value={task.referenceExternalId}
                onChange={(e) => onChange({ referenceExternalId: e.currentTarget.value })}
              />
            </Field>
            <Field label="Reference label">
              <input
                className={inputClass}
                value={task.referenceLabel}
                onChange={(e) => onChange({ referenceLabel: e.currentTarget.value })}
              />
            </Field>
          </>
        )}
        <div className="flex flex-wrap gap-2 sm:col-span-4">
          <button
            type="button"
            className={secondaryButton}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            Move up
          </button>
          <button
            type="button"
            className={secondaryButton}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            Move down
          </button>
          <button type="button" className={secondaryButton} onClick={onRemove}>
            Remove task
          </button>
        </div>
      </fieldset>
    </li>
  );
}
