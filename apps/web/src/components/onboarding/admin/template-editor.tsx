'use client';

import type { FormEvent } from 'react';
import { useState } from 'react';
import { onboardingApi } from '../../../lib/onboarding/api';
import type { Template, WorkflowKind } from '../../../lib/onboarding/types';
import {
  Field,
  inputClass,
  isRecordReference,
  primaryButton,
  secondaryButton,
} from '../onboarding-shared';
import { Mutate } from './admin-shared';
import {
  TaskEditor,
  TaskForm,
  emptyTask,
  formToTask,
  taskToForm,
  useRecordOptions,
} from './task-editor';

// Batch 10E-1: moved from onboarding-admin-page.tsx unchanged.
export function TemplateEditor({
  organizationId,
  template,
  busy,
  mutate,
  onDone,
}: {
  organizationId: string;
  template: Template | null;
  busy: boolean;
  mutate: Mutate;
  onDone(): void;
}) {
  const [form, setForm] = useState({
    code: template?.code ?? '',
    name: template?.name ?? '',
    kind: (template?.kind ?? 'ONBOARDING') as WorkflowKind,
    description: template?.description ?? '',
  });
  const [tasks, setTasks] = useState<TaskForm[]>(
    template ? template.tasks.map(taskToForm) : [emptyTask()],
  );
  const setTask = (index: number, patch: Partial<TaskForm>) =>
    setTasks((current) => current.map((task, i) => (i === index ? { ...task, ...patch } : task)));
  const records = useRecordOptions(
    organizationId,
    tasks.some((task) => isRecordReference(task.referenceType)),
  );
  const move = (index: number, by: number) =>
    setTasks((current) => {
      const next = [...current];
      const [task] = next.splice(index, 1);
      next.splice(index + by, 0, task!);
      return next;
    });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = tasks.map(formToTask);
    const ok = await mutate(
      () =>
        template
          ? onboardingApi.updateTemplate(template.id, {
              name: form.name.trim(),
              description: form.description.trim() || null,
              tasks: input,
            })
          : onboardingApi.createTemplate({
              organizationId,
              kind: form.kind,
              code: form.code.trim(),
              name: form.name.trim(),
              description: form.description.trim() || null,
              tasks: input,
            }),
      template ? 'Template saved.' : 'Template created as a draft.',
    );
    if (ok) onDone();
  }

  return (
    <form
      aria-label={template ? 'Edit template' : 'Create template'}
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-4"
      onSubmit={(event) => void submit(event)}
    >
      <h2 className="text-base font-semibold text-slate-900">
        {template ? `Edit ${template.name}` : 'New template'}
      </h2>
      <p className="text-sm text-slate-600">
        Workflows already started keep the tasks they started with.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {!template && (
          <Field label="Template code">
            <input
              className={inputClass}
              required
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.currentTarget.value })}
            />
          </Field>
        )}
        <Field label="Template name">
          <input
            className={inputClass}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
          />
        </Field>
        {!template && (
          <Field label="Kind">
            <select
              className={inputClass}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.currentTarget.value as WorkflowKind })}
            >
              <option value="ONBOARDING">Onboarding</option>
              <option value="OFFBOARDING">Offboarding</option>
            </select>
          </Field>
        )}
        <div className="sm:col-span-3">
          <Field label="Template description">
            <textarea
              className={inputClass}
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.currentTarget.value })}
            />
          </Field>
        </div>
      </div>
      <h3 className="text-sm font-semibold uppercase text-slate-500">Tasks (in order)</h3>
      <ol className="space-y-3">
        {tasks.map((task, index) => (
          <TaskEditor
            key={index}
            index={index}
            count={tasks.length}
            task={task}
            records={records}
            organizationId={organizationId}
            onChange={(patch) => setTask(index, patch)}
            onMove={(by) => move(index, by)}
            onRemove={() => setTasks((current) => current.filter((_, i) => i !== index))}
          />
        ))}
      </ol>
      <button
        type="button"
        className={secondaryButton}
        onClick={() => setTasks((current) => [...current, emptyTask()])}
      >
        Add task
      </button>
      <div className="flex gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>
          {template ? 'Save template' : 'Create template'}
        </button>
        <button type="button" className={secondaryButton} onClick={onDone}>
          Cancel editing
        </button>
      </div>
    </form>
  );
}
