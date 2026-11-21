'use client';

import { useRef, useCallback, useEffect, useState, type FormEvent } from 'react';
import { buttonClass } from '../ui/button';
import { ErrorBanner } from '../organization/shared';
import { ErrorState } from '../ui/states';
import { useConfirm } from '../ui/use-confirm';
import { schedulingApi } from '../../lib/scheduling/api';
import { schedulingErrorMessage } from '../../lib/scheduling/errors';
import type {
  GenerationIssue,
  GenerationResult,
  PatternUpdateInput,
  RecurrenceRule,
  RecurrenceRuleInput,
  SchedulePattern,
  ScheduleTemplate,
} from '../../lib/scheduling/types';
import {
  addDays,
  formatDay,
  latestDateAnywhere,
  startOfWeek,
  todayIn,
} from '../../lib/scheduling/time';
import { RuleEditForm, RuleForm, RuleTable } from './recurrence-rules';
import { addRulesInOrder } from './schedule-templates-page';
import {
  EmployeeAssignmentPicker,
  Feedback,
  Field,
  Panel,
  SCHEDULE_PERMISSIONS,
  SchedulingAdminPage,
  assignmentLabel,
  inputClass,
  useStructure,
  type AssignmentChoice,
  type SchedulingContext,
  type Structure,
  FormError,
  useEditFormFocus,
} from './scheduling-shared';

export function SchedulePatternsPage() {
  return (
    <SchedulingAdminPage
      title="Recurring patterns"
      description="Each employment assignment can repeat weekly shifts. Generation fills weekly draft schedules; running it again never duplicates shifts."
      anyOf={[SCHEDULE_PERMISSIONS.read, SCHEDULE_PERMISSIONS.patterns]}
    >
      {(context) => <Patterns key={context.organization.id} context={context} />}
    </SchedulingAdminPage>
  );
}

function Patterns({ context }: { context: SchedulingContext }) {
  const organizationId = context.organization.id;
  const structure = useStructure(organizationId);
  const [choice, setChoice] = useState<AssignmentChoice | null>(null);
  return (
    <div className="space-y-5">
      <Panel title="Employee and assignment">
        <p className="mb-3 text-sm text-slate-600">
          Patterns belong to one assignment: an employee working in two positions (for example
          Reception and Warehouse) has a separate pattern for each position.
        </p>
        <EmployeeAssignmentPicker
          organizationId={organizationId}
          value={choice}
          onChange={setChoice}
        />
      </Panel>
      {choice && (
        <AssignmentPatterns
          key={choice.assignment.id}
          context={context}
          choice={choice}
          structure={structure}
        />
      )}
    </div>
  );
}

function AssignmentPatterns({
  context,
  choice,
  structure,
}: {
  context: SchedulingContext;
  choice: AssignmentChoice;
  structure: Structure;
}) {
  const assignmentId = choice.assignment.id;
  const canManage = context.can(SCHEDULE_PERMISSIONS.patterns);
  const [patterns, setPatterns] = useState<SchedulePattern[] | null>(null);
  const [templates, setTemplates] = useState<ScheduleTemplate[]>([]);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPatterns((await schedulingApi.listPatterns(assignmentId)).items);
  }, [assignmentId]);

  const loadPatterns = useCallback(() => {
    setLoadError(null);
    setPatterns(null);
    load().catch((cause) => {
      setLoadError(schedulingErrorMessage(cause, 'Patterns could not be loaded.'));
    });
  }, [load]);

  const loadTemplates = useCallback(() => {
    setTemplatesError(null);
    schedulingApi
      .listTemplates(context.organization.id)
      .then((page) => setTemplates(page.items.filter((t) => !t.archivedAt)))
      .catch((cause) => {
        setTemplates([]);
        setTemplatesError(schedulingErrorMessage(cause, 'Templates could not be loaded.'));
      });
  }, [context.organization.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadPatterns();
      loadTemplates();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadPatterns, loadTemplates]);

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
      const text = schedulingErrorMessage(cause, 'The pattern could not be updated.');
      if (inlineError) inlineError(text);
      else setError(text);
      await load().catch(() => undefined);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <Panel
        title={`Patterns for ${choice.employee.displayName}`}
        actions={
          canManage && !creating ? (
            <button
              type="button"
              className={buttonClass('primary', 'sm')}
              onClick={() => setCreating(true)}
            >
              New pattern
            </button>
          ) : null
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{assignmentLabel(choice.assignment)}</p>
          <Feedback error={error} success={success} />
          {creating && (
            <PatternForm
              structure={structure}
              templates={templates}
              templatesError={templatesError}
              onRetryTemplates={loadTemplates}
              busy={busy}
              onCancel={() => setCreating(false)}
              onSubmit={(input) =>
                run(
                  () =>
                    input.templateId
                      ? schedulingApi.patternFromTemplate(assignmentId, {
                          ...input.period,
                          templateId: input.templateId,
                        })
                      : schedulingApi.createPattern(assignmentId, {
                          ...input.period,
                          rotationWeeks: input.rotationWeeks,
                          rules: input.rules,
                        }),
                  'Pattern created. Generate shifts to fill the draft schedules.',
                ).then((ok) => ok && setCreating(false))
              }
            />
          )}
          {loadError ? (
            <ErrorState
              title="Patterns could not be loaded"
              message={loadError}
              onRetry={loadPatterns}
            />
          ) : patterns === null ? (
            <p role="status" className="text-sm text-slate-600">
              Loading patterns…
            </p>
          ) : patterns.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
              This assignment has no recurring pattern.
            </p>
          ) : (
            <ul className="space-y-4">
              {patterns.map((pattern) => (
                <PatternCard
                  key={pattern.id}
                  pattern={pattern}
                  assignmentId={assignmentId}
                  structure={structure}
                  canManage={canManage}
                  busy={busy}
                  run={run}
                  onGenerated={setResult}
                />
              ))}
            </ul>
          )}
        </div>
      </Panel>
      {result && <GenerationSummary result={result} onClose={() => setResult(null)} />}
    </div>
  );
}

interface PatternFormValue {
  period: { name?: string; effectiveFrom: string; effectiveTo?: string; anchorDate: string };
  templateId: string;
  rotationWeeks: number;
  rules: RecurrenceRuleInput[];
}

function PatternForm({
  structure,
  templates,
  templatesError,
  onRetryTemplates,
  busy,
  onCancel,
  onSubmit,
}: {
  structure: Structure;
  templates: ScheduleTemplate[];
  templatesError: string | null;
  onRetryTemplates(): void;
  busy: boolean;
  onCancel(): void;
  onSubmit(value: PatternFormValue): void;
}) {
  const [source, setSource] = useState<'template' | 'rules'>(
    templates.length > 0 ? 'template' : 'rules',
  );
  const [effectiveFrom, setEffectiveFrom] = useState(() => todayIn(null));
  const [rotationWeeks, setRotationWeeks] = useState(1);
  const [rules, setRules] = useState<RecurrenceRuleInput[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    if (source === 'rules' && rules.length === 0) {
      setProblem('Add at least one shift rule.');
      return;
    }
    if (source === 'template' && !text('templateId')) {
      setProblem('Choose a template.');
      return;
    }
    onSubmit({
      period: {
        ...(text('name') ? { name: text('name') } : {}),
        effectiveFrom,
        ...(text('effectiveTo') ? { effectiveTo: text('effectiveTo') } : {}),
        // Rotation weeks count from a Monday.
        anchorDate: startOfWeek(text('anchorDate') || effectiveFrom),
      },
      templateId: source === 'template' ? text('templateId') : '',
      rotationWeeks,
      rules,
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3">
      <form onSubmit={submit} aria-label="New pattern" className="space-y-3" id="pattern-form">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Name (optional)">
            <input name="name" maxLength={200} className={inputClass} />
          </Field>
          <Field label="Effective from">
            <input
              type="date"
              required
              className={inputClass}
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </Field>
          <Field label="Effective to (optional)">
            <input name="effectiveTo" type="date" className={inputClass} />
          </Field>
          <Field
            label="Rotation starts (week of)"
            hint="Week 1 of the rotation begins on this Monday."
          >
            <input name="anchorDate" type="date" className={inputClass} />
          </Field>
        </div>
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="sr-only">Pattern source</legend>
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              checked={source === 'template'}
              disabled={templates.length === 0}
              onChange={() => setSource('template')}
            />
            From a template
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" checked={source === 'rules'} onChange={() => setSource('rules')} />
            Custom rules
          </label>
        </fieldset>
        {templatesError && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 p-2 text-sm text-rose-900"
          >
            <span>{templatesError} Only custom rules are available until they load.</span>
            <button
              type="button"
              className={buttonClass('secondary', 'sm')}
              onClick={onRetryTemplates}
            >
              Retry
            </button>
          </div>
        )}
        {source === 'template' ? (
          <Field
            label="Template"
            hint="The template's rules are copied once; later template edits do not change this pattern."
          >
            <select name="templateId" className={inputClass} defaultValue="">
              <option value="">Select…</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} (
                  {template.rotationWeeks === 1 ? 'weekly' : `${template.rotationWeeks}-week`})
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Rotation (weeks)">
            <input
              type="number"
              min={1}
              max={52}
              className={`${inputClass} w-32`}
              value={rotationWeeks}
              onChange={(event) => setRotationWeeks(Math.max(1, Number(event.target.value) || 1))}
            />
          </Field>
        )}
      </form>
      {source === 'rules' && (
        <>
          <RuleTable
            rules={rules.map((rule, index) => ({
              id: String(index),
              weekIndex: rule.weekIndex,
              dayOfWeek: rule.dayOfWeek,
              startLocalTime: rule.startLocalTime,
              endLocalTime: rule.endLocalTime,
              overnight: rule.endLocalTime <= rule.startLocalTime,
              workLocationId: rule.workLocationId ?? null,
              timezone: null,
              sortOrder: index,
            }))}
            rotationWeeks={rotationWeeks}
            structure={structure}
            onDelete={(rule) =>
              setRules((current) => current.filter((_, index) => String(index) !== rule.id))
            }
          />
          <RuleForm
            rotationWeeks={rotationWeeks}
            structure={structure}
            submitLabel="Add to pattern"
            onSubmit={(added) => setRules((current) => [...current, ...added])}
          />
        </>
      )}
      {problem && <ErrorBanner>{problem}</ErrorBanner>}
      <div className="flex gap-2">
        <button
          type="submit"
          form="pattern-form"
          disabled={busy}
          className={buttonClass('primary', 'sm')}
        >
          Create pattern
        </button>
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function PatternCard({
  pattern,
  assignmentId,
  structure,
  canManage,
  busy,
  run,
  onGenerated,
}: {
  pattern: SchedulePattern;
  assignmentId: string;
  structure: Structure;
  canManage: boolean;
  busy: boolean;
  run(
    action: () => Promise<unknown>,
    message: string,
    inlineError?: (message: string | null) => void,
  ): Promise<boolean>;
  onGenerated(result: GenerationResult): void;
}) {
  const [confirm, confirmDialog] = useConfirm();
  const [panel, setPanel] = useState<'end' | 'generate' | 'rule' | 'edit' | null>(null);
  const [editingRule, setEditingRule] = useState<RecurrenceRule | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // The API treats a pattern as started once its first day has begun anywhere (UTC+14), and from
  // then on it can only be ended; editing, re-ruling and deleting are offered only before that.
  const started = pattern.effectiveFrom <= latestDateAnywhere();
  const patternName = pattern.name ?? `pattern from ${formatDay(pattern.effectiveFrom)}`;

  async function remove() {
    if (
      !(await confirm({
        title: 'Delete this pattern?',
        description:
          'Only a pattern that has not started can be deleted; otherwise set an end date.',
        confirmLabel: 'Delete pattern',
      }))
    )
      return;
    await run(() => schedulingApi.deletePattern(assignmentId, pattern.id), 'Pattern deleted.');
  }

  function end(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const effectiveTo = String(new FormData(event.currentTarget).get('effectiveTo') ?? '');
    void run(
      () => schedulingApi.endPattern(assignmentId, pattern.id, effectiveTo),
      'Pattern end date set. Draft shifts after it are removed on the next generation.',
    ).then((ok) => ok && setPanel(null));
  }

  function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    void run(async () => {
      onGenerated(
        await schedulingApi.generate(assignmentId, pattern.id, {
          ...(text('from') ? { from: text('from') } : {}),
          ...(text('to') ? { to: text('to') } : {}),
        }),
      );
    }, 'Generation finished.').then((ok) => ok && setPanel(null));
  }

  return (
    <li className="rounded-lg border border-slate-200 p-3">
      {confirmDialog}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-slate-900">{pattern.name ?? 'Recurring pattern'}</p>
          <p className="text-sm text-slate-600">
            {formatDay(pattern.effectiveFrom)} –{' '}
            {pattern.effectiveTo ? formatDay(pattern.effectiveTo) : 'ongoing'} ·{' '}
            {pattern.rotationWeeks === 1
              ? 'every week'
              : `${pattern.rotationWeeks}-week rotation from ${pattern.anchorDate}`}
            {pattern.sourceTemplateId && ' · from a template'}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass('primary', 'sm')}
              onClick={() => setPanel('generate')}
            >
              Generate shifts <span className="sr-only">for {patternName}</span>
            </button>
            {!started && (
              <button
                type="button"
                className={buttonClass('ghost', 'sm')}
                onClick={() => {
                  setEditingRule(null);
                  setFormError(null);
                  setPanel('edit');
                }}
              >
                Edit pattern <span className="sr-only">{patternName}</span>
              </button>
            )}
            {!started && (
              <button
                type="button"
                className={buttonClass('ghost', 'sm')}
                onClick={() => {
                  setEditingRule(null);
                  setPanel('rule');
                }}
              >
                Add rule <span className="sr-only">to {patternName}</span>
              </button>
            )}
            <button
              type="button"
              className={buttonClass('ghost', 'sm')}
              onClick={() => setPanel('end')}
            >
              Set end date <span className="sr-only">for {patternName}</span>
            </button>
            {!started && (
              <button
                type="button"
                disabled={busy}
                className={buttonClass('ghost', 'sm')}
                onClick={() => void remove()}
              >
                Delete <span className="sr-only">{patternName}</span>
              </button>
            )}
          </div>
        )}
      </div>
      <div className="mt-3">
        <RuleTable
          rules={pattern.rules}
          rotationWeeks={pattern.rotationWeeks}
          structure={structure}
          busy={busy}
          onEdit={
            canManage && !started
              ? (rule) => {
                  setPanel(null);
                  setFormError(null);
                  setEditingRule(rule);
                }
              : undefined
          }
          onDelete={
            canManage && !started
              ? (rule) =>
                  void run(
                    () => schedulingApi.deletePatternRule(assignmentId, pattern.id, rule.id),
                    'Rule removed.',
                  )
              : undefined
          }
        />
      </div>
      {canManage &&
        !started &&
        editingRule &&
        pattern.rules.some((rule) => rule.id === editingRule.id) && (
          <div className="mt-3">
            <RuleEditForm
              key={editingRule.id}
              rule={editingRule}
              rotationWeeks={pattern.rotationWeeks}
              structure={structure}
              busy={busy}
              error={formError}
              onCancel={() => {
                setFormError(null);
                setEditingRule(null);
              }}
              onSubmit={(changes) =>
                run(
                  () =>
                    schedulingApi.updatePatternRule(
                      assignmentId,
                      pattern.id,
                      editingRule.id,
                      changes,
                    ),
                  'Rule saved.',
                  setFormError,
                ).then((ok) => ok && setEditingRule(null))
              }
            />
          </div>
        )}
      {panel === 'edit' && canManage && !started && (
        <PatternEditForm
          pattern={pattern}
          busy={busy}
          error={formError}
          onCancel={() => {
            setFormError(null);
            setPanel(null);
          }}
          onSubmit={(changes) =>
            run(
              () => schedulingApi.updatePattern(assignmentId, pattern.id, changes),
              'Pattern saved. Generate shifts again to apply the change to draft weeks.',
              setFormError,
            ).then((ok) => ok && setPanel(null))
          }
        />
      )}
      {panel === 'rule' && (
        <div className="mt-3">
          <RuleForm
            rotationWeeks={pattern.rotationWeeks}
            structure={structure}
            busy={busy}
            onSubmit={(rules) =>
              run(
                () =>
                  addRulesInOrder(rules, (rule) =>
                    schedulingApi.addPatternRule(assignmentId, pattern.id, rule),
                  ),
                'Rule added.',
              ).then((ok) => ok && setPanel(null))
            }
          />
        </div>
      )}
      {panel === 'end' && (
        <form
          onSubmit={end}
          aria-label="End pattern"
          className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3"
        >
          <Field label="Last day of the pattern">
            <input
              name="effectiveTo"
              type="date"
              required
              min={pattern.effectiveFrom}
              className={inputClass}
            />
          </Field>
          <button type="submit" disabled={busy} className={buttonClass('secondary', 'sm')}>
            Set end date
          </button>
          <button
            type="button"
            className={buttonClass('ghost', 'sm')}
            onClick={() => setPanel(null)}
          >
            Cancel
          </button>
        </form>
      )}
      {panel === 'generate' && (
        <form
          onSubmit={generate}
          aria-label="Generate shifts"
          className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3"
        >
          <p className="text-sm text-slate-600">
            Shifts go into weekly draft schedules (created when the policy allows). Published weeks,
            manual shifts and corrected shifts are never touched, and running it again does not
            duplicate shifts. Leave the dates empty to use the policy’s generation horizon.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From (optional)">
              <input name="from" type="date" className={inputClass} />
            </Field>
            <Field label="To (optional)">
              <input name="to" type="date" className={inputClass} />
            </Field>
            <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
              Generate
            </button>
            <button
              type="button"
              className={buttonClass('ghost', 'sm')}
              onClick={() => setPanel(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

function IssueList({
  title,
  issues,
  tone,
}: {
  title: string;
  issues: GenerationIssue[];
  tone: string;
}) {
  if (issues.length === 0) return null;
  return (
    <div className={`rounded-lg p-3 text-sm ${tone}`}>
      <p className="font-semibold">
        {title} ({issues.length})
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {issues.slice(0, 50).map((issue) => (
          <li key={`${issue.occurrenceKey}-${issue.code}`}>
            {issue.workDate}: {issue.message}
          </li>
        ))}
      </ul>
      {issues.length > 50 && <p className="mt-1">…and {issues.length - 50} more.</p>}
    </div>
  );
}

export function GenerationSummary({
  result,
  onClose,
}: {
  result: GenerationResult;
  onClose(): void;
}) {
  const stats: Array<[string, number]> = [
    ['Created', result.created],
    ['Updated', result.updated],
    ['Unchanged', result.unchanged],
    ['Removed', result.removed],
    ['Protected', result.protected],
    ['Blocked', result.blocked.length],
    ['Failed', result.errors.length],
  ];
  return (
    <Panel
      title="Generation summary"
      actions={
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          {formatDay(result.range.from)} – {formatDay(result.range.to)}
          {result.schedulesCreated.length > 0 &&
            ` · ${result.schedulesCreated.length} weekly draft schedule(s) created`}
        </p>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-7" aria-label="Generation counts">
          {stats.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-slate-200 p-2 text-center">
              <dt className="text-xs uppercase text-slate-500">{label}</dt>
              <dd className="text-lg font-semibold text-slate-950">{value}</dd>
            </div>
          ))}
        </dl>
        <IssueList
          title="Blocked (conflicts or published weeks)"
          issues={result.blocked}
          tone="bg-amber-50 text-amber-950"
        />
        <IssueList title="Failed" issues={result.errors} tone="bg-rose-50 text-rose-950" />
        <IssueList title="Notices" issues={result.notices} tone="bg-slate-50 text-slate-800" />
        <p className="text-xs text-slate-500">
          Generated shifts are drafts: review them on the Schedules page and publish each week.
        </p>
      </div>
    </Panel>
  );
}

/** The fields of a pattern edit that differ from the stored pattern. */
export function patternChanges(
  pattern: SchedulePattern,
  next: {
    name: string;
    effectiveFrom: string;
    effectiveTo: string;
    anchorDate: string;
    rotationWeeks: number;
  },
): PatternUpdateInput {
  const changes: PatternUpdateInput = {};
  const name = next.name.trim() || null;
  if (name !== pattern.name) changes.name = name;
  if (next.effectiveFrom !== pattern.effectiveFrom) changes.effectiveFrom = next.effectiveFrom;
  const effectiveTo = next.effectiveTo || null;
  if (effectiveTo !== pattern.effectiveTo) changes.effectiveTo = effectiveTo;
  if (next.anchorDate !== pattern.anchorDate) changes.anchorDate = next.anchorDate;
  if (next.rotationWeeks !== pattern.rotationWeeks) changes.rotationWeeks = next.rotationWeeks;
  return changes;
}

/**
 * Edits a pattern that has not started (R3.1): name, dates, rotation anchor and length. The
 * current values are shown; only changed fields are sent, and the API re-checks overlap with the
 * assignment's other patterns and that every rule still fits the rotation.
 */
function PatternEditForm({
  pattern,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  pattern: SchedulePattern;
  busy: boolean;
  /** R4-A.7: the API's refusal of the last save, shown in this form. */
  error?: string | null;
  onCancel(): void;
  onSubmit(changes: PatternUpdateInput): void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  useEditFormFocus(formRef);
  const [effectiveFrom, setEffectiveFrom] = useState(pattern.effectiveFrom);
  const [problem, setProblem] = useState<string | null>(null);
  const usedWeeks = pattern.rules.reduce((max, rule) => Math.max(max, rule.weekIndex + 1), 1);
  const firstAllowed = addDays(latestDateAnywhere(), 1);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const next = {
      name: text('name'),
      effectiveFrom: text('effectiveFrom'),
      effectiveTo: text('effectiveTo'),
      anchorDate: text('anchorDate'),
      rotationWeeks: Number(text('rotationWeeks')),
    };
    if (next.effectiveTo && next.effectiveTo < next.effectiveFrom) {
      setProblem('The last day cannot be before the first day.');
      return;
    }
    // The API counts rotation weeks from a Monday and refuses any other anchor day.
    if (next.anchorDate && startOfWeek(next.anchorDate) !== next.anchorDate) {
      setProblem('The rotation must start on a Monday.');
      return;
    }
    if (next.rotationWeeks < usedWeeks) {
      setProblem(
        `The rules use ${usedWeeks} rotation weeks; remove or move the rules in the later weeks first.`,
      );
      return;
    }
    const changes = patternChanges(pattern, next);
    if (Object.keys(changes).length === 0) {
      setProblem('Nothing changed.');
      return;
    }
    setProblem(null);
    onSubmit(changes);
  }

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      aria-label={`Edit ${pattern.name ?? 'recurring pattern'}`}
      className="mt-3 space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3"
    >
      <p className="text-sm text-slate-600">
        A pattern can be changed only before it starts. Shifts already generated stay as they are
        until shifts are generated again.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name (optional)">
          <input
            name="name"
            maxLength={200}
            defaultValue={pattern.name ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="First day" hint="Must be after today everywhere.">
          <input
            name="effectiveFrom"
            type="date"
            required
            min={firstAllowed}
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Last day (optional)" hint="Leave empty for an ongoing pattern.">
          <input
            name="effectiveTo"
            type="date"
            min={effectiveFrom || undefined}
            defaultValue={pattern.effectiveTo ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Rotation weeks">
          <input
            name="rotationWeeks"
            type="number"
            required
            min={Math.max(1, usedWeeks)}
            max={52}
            defaultValue={pattern.rotationWeeks}
            className={inputClass}
          />
        </Field>
        <Field label="Rotation starts on" hint="A Monday: week 1 of the rotation begins that day.">
          <input
            name="anchorDate"
            type="date"
            required
            defaultValue={pattern.anchorDate}
            className={inputClass}
          />
        </Field>
      </div>
      {problem && (
        <p role="alert" className="text-sm text-red-700">
          {problem}
        </p>
      )}
      {!problem && <FormError message={error} />}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
          Save pattern
        </button>
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
