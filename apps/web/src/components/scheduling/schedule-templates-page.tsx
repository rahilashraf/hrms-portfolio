'use client';

import { checkboxClass } from '../ui/tokens';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { buttonClass } from '../ui/button';
import { ErrorState } from '../ui/states';
import { useConfirm } from '../ui/use-confirm';
import { schedulingApi } from '../../lib/scheduling/api';
import { schedulingErrorMessage } from '../../lib/scheduling/errors';
import type {
  RecurrenceRule,
  RecurrenceRuleInput,
  ScheduleTemplate,
} from '../../lib/scheduling/types';
import { RuleEditForm, RuleForm, RuleTable } from './recurrence-rules';
import {
  Feedback,
  Field,
  Panel,
  SCHEDULE_PERMISSIONS,
  SchedulingAdminPage,
  inputClass,
  useStructure,
  type SchedulingContext,
} from './scheduling-shared';

export function ScheduleTemplatesPage() {
  return (
    <SchedulingAdminPage
      title="Shift templates"
      description="Reusable weekly shift rules. Applying a template to an assignment copies its rules into a recurring pattern."
      anyOf={[
        SCHEDULE_PERMISSIONS.read,
        SCHEDULE_PERMISSIONS.templates,
        SCHEDULE_PERMISSIONS.patterns,
      ]}
    >
      {(context) => <Templates key={context.organization.id} context={context} />}
    </SchedulingAdminPage>
  );
}

/** Adds rules one by one, stopping at the first refusal (e.g. an overlapping rule). */
export async function addRulesInOrder(
  rules: RecurrenceRuleInput[],
  add: (rule: RecurrenceRuleInput) => Promise<unknown>,
) {
  for (const rule of rules) await add(rule);
}

function Templates({ context }: { context: SchedulingContext }) {
  const organizationId = context.organization.id;
  const canManage = context.can(SCHEDULE_PERMISSIONS.templates);
  const structure = useStructure(organizationId);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [templates, setTemplates] = useState<ScheduleTemplate[] | null>(null);
  const [open, setOpen] = useState<ScheduleTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingRule, setEditingRule] = useState<RecurrenceRule | null>(null);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    const items: ScheduleTemplate[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await schedulingApi.listTemplates(organizationId, includeArchived, afterId);
      items.push(...result.items);
      if (!result.nextAfterId) break;
      afterId = result.nextAfterId;
    }
    setTemplates(items);
  }, [organizationId, includeArchived]);

  const initialLoad = useCallback(() => {
    setLoadError(null);
    setTemplates(null);
    load().catch((cause) => {
      setLoadError(schedulingErrorMessage(cause, 'Templates could not be loaded.'));
    });
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(initialLoad, 0);
    return () => window.clearTimeout(timer);
  }, [initialLoad]);

  async function refreshOpen(id: string) {
    setOpen(await schedulingApi.getTemplate(id));
  }

  /**
   * R4-A.7: `inlineError`, when given, receives a refusal so the open edit form shows it (and
   * the page banner does not repeat it).
   */
  async function run(
    action: () => Promise<unknown>,
    message: string,
    inlineError?: (message: string | null) => void,
  ) {
    setBusy(true);
    setError(null);
    inlineError?.(null);
    setSuccess(null);
    try {
      await action();
      setSuccess(message);
      await load();
      return true;
    } catch (cause) {
      const text = schedulingErrorMessage(cause, 'The template could not be updated.');
      if (inlineError) inlineError(text);
      else setError(text);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    void run(async () => {
      const created = await schedulingApi.createTemplate({
        organizationId,
        name: text('name'),
        ...(text('description') ? { description: text('description') } : {}),
        rotationWeeks: Number(text('rotationWeeks') || 1),
      });
      setOpen(created);
    }, 'Template created. Add its shift rules below.').then((ok) => ok && setCreating(false));
  }

  function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!open) return;
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    void run(async () => {
      setOpen(
        await schedulingApi.updateTemplate(open.id, {
          name: text('name'),
          description: text('description') || null,
          rotationWeeks: Number(text('rotationWeeks') || 1),
        }),
      );
    }, 'Template updated.').then((ok) => ok && setEditing(false));
  }

  async function archive(template: ScheduleTemplate) {
    if (
      !(await confirm({
        title: `Archive “${template.name}”?`,
        description:
          'Archived templates cannot be applied to new patterns. Patterns already created from it keep their own copy of the rules.',
        confirmLabel: 'Archive',
      }))
    )
      return;
    await run(() => schedulingApi.archiveTemplate(template.id), 'Template archived.');
    setOpen(null);
  }

  async function remove(template: ScheduleTemplate) {
    if (
      !(await confirm({
        title: `Delete “${template.name}”?`,
        description: 'Only a template that was never applied can be deleted; otherwise archive it.',
        confirmLabel: 'Delete',
      }))
    )
      return;
    if (await run(() => schedulingApi.deleteTemplate(template.id), 'Template deleted.'))
      setOpen(null);
  }

  return (
    <div className="space-y-5">
      {confirmDialog}
      <Feedback error={error} success={success} />
      <Panel
        title="Templates"
        actions={
          <div className="flex items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              Show archived
            </label>
            {canManage && !creating && (
              <button
                type="button"
                className={buttonClass('primary', 'sm')}
                onClick={() => setCreating(true)}
              >
                New template
              </button>
            )}
          </div>
        }
      >
        {creating && (
          <form
            onSubmit={create}
            aria-label="New template"
            className="mb-4 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3"
          >
            <Field label="Name">
              <input name="name" required maxLength={200} className={inputClass} />
            </Field>
            <Field label="Rotation (weeks)" hint="1 for every week; 2 for alternating weeks, …">
              <input
                name="rotationWeeks"
                type="number"
                min={1}
                max={52}
                defaultValue={1}
                required
                className={inputClass}
              />
            </Field>
            <Field label="Description">
              <input name="description" maxLength={2000} className={inputClass} />
            </Field>
            <div className="flex gap-2 sm:col-span-3">
              <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
                Create template
              </button>
              <button
                type="button"
                className={buttonClass('ghost', 'sm')}
                onClick={() => setCreating(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {loadError ? (
          <ErrorState
            title="Templates could not be loaded"
            message={loadError}
            onRetry={initialLoad}
          />
        ) : templates === null ? (
          <p role="status" className="text-sm text-slate-600">
            Loading templates…
          </p>
        ) : templates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
            No templates yet.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {templates.map((template) => (
              <li
                key={template.id}
                className="flex flex-wrap items-center justify-between gap-2 p-3"
              >
                <div>
                  <p className="font-medium text-slate-900">
                    {template.name}
                    {template.archivedAt && (
                      <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                        Archived
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-slate-600">
                    {template.rotationWeeks === 1
                      ? 'Every week'
                      : `${template.rotationWeeks}-week rotation`}{' '}
                    · {template.ruleCount ?? template.rules?.length ?? 0} rule(s)
                    {template.description && ` · ${template.description}`}
                  </p>
                </div>
                <button
                  type="button"
                  className={buttonClass('secondary', 'sm')}
                  onClick={() => {
                    setEditing(false);
                    void refreshOpen(template.id).catch((cause) =>
                      setError(schedulingErrorMessage(cause, 'The template could not be opened.')),
                    );
                  }}
                >
                  {canManage && !template.archivedAt ? 'Manage' : 'View'}{' '}
                  <span className="sr-only">{template.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {open && (
        <Panel
          title={open.name}
          actions={
            canManage && !open.archivedAt ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  className={buttonClass('ghost', 'sm')}
                  onClick={() => setEditing(true)}
                >
                  Edit <span className="sr-only">{open.name}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('ghost', 'sm')}
                  onClick={() => void archive(open)}
                >
                  Archive <span className="sr-only">{open.name}</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('ghost', 'sm')}
                  onClick={() => void remove(open)}
                >
                  Delete <span className="sr-only">{open.name}</span>
                </button>
              </div>
            ) : null
          }
        >
          <div className="space-y-4">
            {editing && (
              <form
                onSubmit={update}
                aria-label="Edit template"
                className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3"
              >
                <Field label="Name">
                  <input
                    name="name"
                    required
                    maxLength={200}
                    defaultValue={open.name}
                    className={inputClass}
                  />
                </Field>
                <Field label="Rotation (weeks)">
                  <input
                    name="rotationWeeks"
                    type="number"
                    min={1}
                    max={52}
                    required
                    defaultValue={open.rotationWeeks}
                    className={inputClass}
                  />
                </Field>
                <Field label="Description">
                  <input
                    name="description"
                    maxLength={2000}
                    defaultValue={open.description ?? ''}
                    className={inputClass}
                  />
                </Field>
                <div className="flex gap-2 sm:col-span-3">
                  <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
                    Save
                  </button>
                  <button
                    type="button"
                    className={buttonClass('ghost', 'sm')}
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            <RuleTable
              rules={open.rules ?? []}
              rotationWeeks={open.rotationWeeks}
              structure={structure}
              busy={busy}
              onEdit={
                canManage && !open.archivedAt
                  ? (rule) => {
                      setRuleError(null);
                      setEditingRule(rule);
                    }
                  : undefined
              }
              onDelete={
                canManage && !open.archivedAt
                  ? (rule) =>
                      void run(async () => {
                        await schedulingApi.deleteTemplateRule(open.id, rule.id);
                        await refreshOpen(open.id);
                      }, 'Rule removed.')
                  : undefined
              }
            />
            {canManage &&
              !open.archivedAt &&
              editingRule &&
              open.rules?.some((rule) => rule.id === editingRule.id) && (
                <RuleEditForm
                  key={editingRule.id}
                  rule={editingRule}
                  rotationWeeks={open.rotationWeeks}
                  structure={structure}
                  busy={busy}
                  error={ruleError}
                  onCancel={() => {
                    setRuleError(null);
                    setEditingRule(null);
                  }}
                  onSubmit={(changes) =>
                    run(
                      async () => {
                        try {
                          await schedulingApi.updateTemplateRule(open.id, editingRule.id, changes);
                        } finally {
                          await refreshOpen(open.id);
                        }
                      },
                      'Rule saved.',
                      setRuleError,
                    ).then((ok) => ok && setEditingRule(null))
                  }
                />
              )}
            {canManage && !open.archivedAt && (
              <RuleForm
                rotationWeeks={open.rotationWeeks}
                structure={structure}
                busy={busy}
                onSubmit={(rules) =>
                  run(
                    async () => {
                      try {
                        await addRulesInOrder(rules, (rule) =>
                          schedulingApi.addTemplateRule(open.id, rule),
                        );
                      } finally {
                        await refreshOpen(open.id);
                      }
                    },
                    rules.length === 1 ? 'Rule added.' : `${rules.length} rules added.`,
                  )
                }
              />
            )}
            <p className="text-xs text-slate-500">
              Changes to a template do not change patterns already created from it.
            </p>
          </div>
        </Panel>
      )}
    </div>
  );
}
