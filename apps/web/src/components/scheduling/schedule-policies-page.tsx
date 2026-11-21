'use client';

import { useRef, useCallback, useEffect, useState, type FormEvent } from 'react';
import { buttonClass } from '../ui/button';
import { useConfirm } from '../ui/use-confirm';
import { schedulingApi } from '../../lib/scheduling/api';
import { schedulingErrorMessage } from '../../lib/scheduling/errors';
import {
  POLICY_SETTING_KEYS,
  type ResolvedSchedulePolicy,
  type SchedulePolicy,
  type SchedulePolicyInput,
  type SchedulePolicySettings,
  type SchedulePolicyUpdateInput,
  type ScheduleScopeType,
} from '../../lib/scheduling/types';
import { addDays, formatDay, latestDateAnywhere, todayIn } from '../../lib/scheduling/time';
import {
  EmployeeAssignmentPicker,
  Feedback,
  Field,
  Panel,
  SCHEDULE_PERMISSIONS,
  SCOPE_LABELS,
  SchedulingAdminPage,
  ScopeFields,
  inputClass,
  scopeLabel,
  scopePayload,
  useStructure,
  type AssignmentChoice,
  type SchedulingContext,
  type Structure,
  FormError,
  useEditFormFocus,
} from './scheduling-shared';
import { DataTable } from '../ui/data-table';
import { ErrorState } from '../ui/states';

export function SchedulePoliciesPage() {
  return (
    <SchedulingAdminPage
      title="Scheduling policies"
      description="Effective-dated rules for rest periods, shift length, conflict overrides, clock-in windows and unscheduled work. Narrower scopes override broader ones setting by setting."
      anyOf={[SCHEDULE_PERMISSIONS.read, SCHEDULE_PERMISSIONS.policy]}
    >
      {(context) => <Policies key={context.organization.id} context={context} />}
    </SchedulingAdminPage>
  );
}

type SettingKey = keyof SchedulePolicySettings;

interface SettingSpec {
  label: string;
  kind: 'number' | 'boolean' | 'enum';
  min?: number;
  max?: number;
  unit?: string;
  options?: Array<[string, string]>;
  hint?: string;
}

/** Every setting of the existing API, in the order administrators think about them. */
export const SETTINGS: Record<SettingKey, SettingSpec> = {
  unscheduledWorkMode: {
    label: 'Unscheduled work',
    kind: 'enum',
    options: [
      ['ALLOW_UNSCHEDULED', 'Allow clock-in without a shift'],
      ['WARN_UNSCHEDULED', 'Allow, but flag for review'],
      ['REQUIRE_SCHEDULED_SHIFT', 'Require a published shift'],
    ],
    hint: 'Only published shifts count; drafts never allow a clock-in.',
  },
  clockInEarlyMinutes: {
    label: 'Clock-in opens before the shift',
    kind: 'number',
    min: 0,
    max: 1440,
    unit: 'min',
  },
  clockInLateMinutes: {
    label: 'Clock-in allowed after the start',
    kind: 'number',
    min: 0,
    max: 1440,
    unit: 'min',
  },
  minimumRestMinutes: {
    label: 'Minimum rest between shifts',
    kind: 'number',
    min: 0,
    max: 2880,
    unit: 'min',
  },
  maximumShiftDurationMinutes: {
    label: 'Maximum shift duration',
    kind: 'number',
    min: 1,
    max: 2880,
    unit: 'min',
  },
  overlapConflictSeverity: {
    label: 'Overlapping assignments',
    kind: 'enum',
    options: [
      ['WARNING', 'Warning (can be overridden)'],
      ['ERROR', 'Blocking'],
    ],
  },
  allowManagerConflictOverride: {
    label: 'Conflict overrides',
    kind: 'boolean',
    options: [
      ['true', 'Allowed with a reason'],
      ['false', 'Not allowed (warnings block)'],
    ],
  },
  requireWorkLocation: {
    label: 'Work location on shifts',
    kind: 'boolean',
    options: [
      ['true', 'Required'],
      ['false', 'Optional'],
    ],
  },
  generationHorizonDays: {
    label: 'Generation horizon',
    kind: 'number',
    min: 1,
    max: 366,
    unit: 'days',
  },
  autoCreateSchedules: {
    label: 'Weekly draft schedules',
    kind: 'boolean',
    options: [
      ['true', 'Created automatically by generation'],
      ['false', 'Must exist beforehand'],
    ],
  },
  defaultSchedulePeriod: {
    label: 'Schedule period',
    kind: 'enum',
    options: [['WEEKLY', 'Weekly']],
  },
};

export function settingValue(key: SettingKey, value: unknown): string {
  if (value === null || value === undefined) return 'Inherited';
  const spec = SETTINGS[key];
  if (spec.kind === 'number') return `${String(value)} ${spec.unit ?? ''}`.trim();
  return spec.options?.find(([option]) => option === String(value))?.[1] ?? String(value);
}

/** The settings a form explicitly sets; blank fields stay null (inherited). */
export function settingsFrom(form: FormData): Partial<SchedulePolicySettings> {
  const out: Record<string, unknown> = {};
  for (const key of POLICY_SETTING_KEYS) {
    const raw = String(form.get(key) ?? '').trim();
    if (!raw) continue;
    const spec = SETTINGS[key];
    out[key] =
      spec.kind === 'number' ? Number(raw) : spec.kind === 'boolean' ? raw === 'true' : raw;
  }
  return out as Partial<SchedulePolicySettings>;
}

function Policies({ context }: { context: SchedulingContext }) {
  const organizationId = context.organization.id;
  const canManage = context.can(SCHEDULE_PERMISSIONS.policy);
  const structure = useStructure(organizationId);
  const [policies, setPolicies] = useState<SchedulePolicy[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState<SchedulePolicy | null>(null);
  const [editing, setEditing] = useState<SchedulePolicy | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const today = todayIn(context.organization.timezone);
  // The API treats a policy as in effect once its first day has begun anywhere (UTC+14); only
  // before that can it be edited or deleted.
  const notStartedAfter = latestDateAnywhere();

  const load = useCallback(async () => {
    const items: SchedulePolicy[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await schedulingApi.listPolicies(organizationId, afterId);
      items.push(...result.items);
      if (!result.nextAfterId) break;
      afterId = result.nextAfterId;
    }
    setPolicies(items.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)));
  }, [organizationId]);

  const initialLoad = useCallback(() => {
    setLoadError(null);
    setPolicies(null);
    load().catch((cause) => {
      setLoadError(schedulingErrorMessage(cause, 'Policies could not be loaded.'));
    });
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(initialLoad, 0);
    return () => window.clearTimeout(timer);
  }, [initialLoad]);

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
      const text = schedulingErrorMessage(cause, 'The policy could not be saved.');
      if (inlineError) inlineError(text);
      else setError(text);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(policy: SchedulePolicy) {
    if (
      !(await confirm({
        title: 'Delete this policy?',
        description:
          'Only a policy that has not taken effect can be deleted; to stop one in effect, set an end date.',
        confirmLabel: 'Delete policy',
      }))
    )
      return;
    await run(() => schedulingApi.deletePolicy(policy.id), 'Policy deleted.');
  }

  function end(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ending) return;
    const effectiveTo = String(new FormData(event.currentTarget).get('effectiveTo') ?? '');
    void run(() => schedulingApi.endPolicy(ending.id, effectiveTo), 'Policy end date set.').then(
      (ok) => ok && setEnding(null),
    );
  }

  return (
    <div className="space-y-5">
      {confirmDialog}
      <Feedback error={error} success={success} />
      <Panel
        title="Policy layers"
        actions={
          canManage && !creating ? (
            <button
              type="button"
              className={buttonClass('primary', 'sm')}
              onClick={() => setCreating(true)}
            >
              New policy
            </button>
          ) : null
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Settings left blank are inherited (team → department → business unit → organization →
            built-in default). Layers are never rewritten: to change a setting in effect, end the
            current layer and add a new one.
          </p>
          {creating && (
            <PolicyForm
              organizationId={organizationId}
              structure={structure}
              defaultFrom={today}
              busy={busy}
              onCancel={() => setCreating(false)}
              onSubmit={(input) =>
                run(() => schedulingApi.createPolicy(input), 'Policy added.').then(
                  (ok) => ok && setCreating(false),
                )
              }
            />
          )}
          {loadError ? (
            <ErrorState
              title="Policies could not be loaded"
              message={loadError}
              onRetry={initialLoad}
            />
          ) : policies === null ? (
            <p role="status" className="text-sm text-slate-600">
              Loading policies…
            </p>
          ) : policies.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
              No scheduling policies: the built-in defaults apply (clock-in without a shift is
              allowed).
            </p>
          ) : (
            <ul className="space-y-3">
              {policies.map((policy) => {
                const set = POLICY_SETTING_KEYS.filter((key) => policy[key] !== null);
                const current =
                  policy.effectiveFrom <= today &&
                  (!policy.effectiveTo || policy.effectiveTo >= today);
                return (
                  <li key={policy.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-slate-900">
                          {policy.name ?? 'Scheduling policy'} · {scopeLabel(structure, policy)}
                          {current && (
                            <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800">
                              In effect
                            </span>
                          )}
                        </p>
                        <p className="text-sm text-slate-600">
                          {formatDay(policy.effectiveFrom)} –{' '}
                          {policy.effectiveTo ? formatDay(policy.effectiveTo) : 'open-ended'}
                        </p>
                      </div>
                      {canManage && (
                        <div className="flex gap-2">
                          {policy.effectiveFrom > notStartedAfter && (
                            <button
                              type="button"
                              disabled={busy}
                              className={buttonClass('ghost', 'sm')}
                              onClick={() => {
                                setEnding(null);
                                setEditError(null);
                                setEditing(policy);
                              }}
                            >
                              Edit{' '}
                              <span className="sr-only">
                                {policy.name ?? 'scheduling policy'},{' '}
                                {scopeLabel(structure, policy)}
                              </span>
                            </button>
                          )}
                          <button
                            type="button"
                            className={buttonClass('ghost', 'sm')}
                            onClick={() => {
                              setEditing(null);
                              setEnding(policy);
                            }}
                          >
                            Set end date
                          </button>
                          {policy.effectiveFrom > notStartedAfter && (
                            <button
                              type="button"
                              disabled={busy}
                              className={buttonClass('ghost', 'sm')}
                              onClick={() => void remove(policy)}
                            >
                              Delete{' '}
                              <span className="sr-only">
                                {policy.name ?? 'scheduling policy'},{' '}
                                {scopeLabel(structure, policy)}
                              </span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                      {set.length === 0 ? (
                        <p className="text-slate-600">No settings (inherits everything).</p>
                      ) : (
                        set.map((key) => (
                          <div
                            key={key}
                            className="flex justify-between gap-2 border-b border-slate-100 py-0.5"
                          >
                            <dt className="text-slate-600">{SETTINGS[key].label}</dt>
                            <dd className="font-medium text-slate-900">
                              {settingValue(key, policy[key])}
                            </dd>
                          </div>
                        ))
                      )}
                    </dl>
                    {editing?.id === policy.id && canManage && (
                      <PolicyEditForm
                        key={policy.id}
                        policy={policy}
                        scope={scopeLabel(structure, policy)}
                        firstAllowed={addDays(notStartedAfter, 1)}
                        busy={busy}
                        error={editError}
                        onCancel={() => {
                          setEditError(null);
                          setEditing(null);
                        }}
                        onSubmit={(changes) =>
                          void run(
                            () => schedulingApi.updatePolicy(policy.id, changes),
                            'Policy saved.',
                            setEditError,
                          ).then((ok) => ok && setEditing(null))
                        }
                      />
                    )}
                    {ending?.id === policy.id && (
                      <form
                        onSubmit={end}
                        aria-label="End policy"
                        className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3"
                      >
                        <Field label="Last day in effect">
                          <input
                            name="effectiveTo"
                            type="date"
                            required
                            min={policy.effectiveFrom}
                            className={inputClass}
                          />
                        </Field>
                        <button
                          type="submit"
                          disabled={busy}
                          className={buttonClass('secondary', 'sm')}
                        >
                          Set end date
                        </button>
                        <button
                          type="button"
                          className={buttonClass('ghost', 'sm')}
                          onClick={() => setEnding(null)}
                        >
                          Cancel
                        </button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Panel>
      <EffectivePolicy context={context} />
    </div>
  );
}

function PolicyForm({
  organizationId,
  structure,
  defaultFrom,
  busy,
  onCancel,
  onSubmit,
}: {
  organizationId: string;
  structure: Structure;
  defaultFrom: string;
  busy: boolean;
  onCancel(): void;
  onSubmit(input: SchedulePolicyInput): void;
}) {
  const [scope, setScope] = useState<{ scopeType: ScheduleScopeType; targetId: string }>({
    scopeType: 'ORGANIZATION',
    targetId: '',
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    onSubmit({
      organizationId,
      ...scopePayload(scope.scopeType, scope.targetId),
      ...(text('name') ? { name: text('name') } : {}),
      effectiveFrom: text('effectiveFrom'),
      ...(text('effectiveTo') ? { effectiveTo: text('effectiveTo') } : {}),
      ...settingsFrom(form),
    });
  }

  return (
    <form
      onSubmit={submit}
      aria-label="New scheduling policy"
      className="space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3"
    >
      <div className="grid gap-3 sm:grid-cols-4">
        <ScopeFields
          structure={structure}
          scopeType={scope.scopeType}
          targetId={scope.targetId}
          onChange={setScope}
        />
        <Field label="Name (optional)">
          <input name="name" maxLength={200} className={inputClass} />
        </Field>
        <Field label="Effective from">
          <input
            name="effectiveFrom"
            type="date"
            required
            defaultValue={defaultFrom}
            className={inputClass}
          />
        </Field>
        <Field label="Effective to (optional)">
          <input name="effectiveTo" type="date" className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {POLICY_SETTING_KEYS.map((key) => {
          const spec = SETTINGS[key];
          return (
            <Field key={key} label={spec.label} hint={spec.hint}>
              {spec.kind === 'number' ? (
                <input
                  name={key}
                  type="number"
                  min={spec.min}
                  max={spec.max}
                  placeholder={`Inherit (${spec.unit})`}
                  className={inputClass}
                />
              ) : (
                <select name={key} defaultValue="" className={inputClass}>
                  <option value="">Inherit</option>
                  {spec.options!.map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          );
        })}
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
          Add policy
        </button>
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The changes a policy edit form makes: blank settings become null (inherited again). */
export function policyChanges(policy: SchedulePolicy, form: FormData): SchedulePolicyUpdateInput {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  const changes: Record<string, unknown> = {};
  const name = text('name') || null;
  if (name !== policy.name) changes.name = name;
  if (text('effectiveFrom') !== policy.effectiveFrom) changes.effectiveFrom = text('effectiveFrom');
  const effectiveTo = text('effectiveTo') || null;
  if (effectiveTo !== policy.effectiveTo) changes.effectiveTo = effectiveTo;
  const settings = settingsFrom(form);
  for (const key of POLICY_SETTING_KEYS) {
    const next = settings[key] ?? null;
    if (next !== policy[key]) changes[key] = next;
  }
  return changes as SchedulePolicyUpdateInput;
}

/**
 * Edits a policy that has not taken effect (R3.1). Its scope cannot change; the current values
 * are shown, and only changed fields are sent. Clearing a setting makes it inherited again.
 */
function PolicyEditForm({
  policy,
  scope,
  firstAllowed,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  policy: SchedulePolicy;
  scope: string;
  firstAllowed: string;
  busy: boolean;
  /** R4-A.7: the API's refusal of the last save, shown in this form. */
  error?: string | null;
  onCancel(): void;
  onSubmit(changes: SchedulePolicyUpdateInput): void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  useEditFormFocus(formRef);
  const [effectiveFrom, setEffectiveFrom] = useState(policy.effectiveFrom);
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const from = String(form.get('effectiveFrom') ?? '');
    const to = String(form.get('effectiveTo') ?? '');
    if (to && to < from) {
      setProblem('The last day in effect cannot be before the first day.');
      return;
    }
    if (Object.keys(settingsFrom(form)).length === 0) {
      setProblem(
        'A policy must set at least one setting; delete it instead to inherit everything.',
      );
      return;
    }
    const changes = policyChanges(policy, form);
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
      aria-label={`Edit ${policy.name ?? 'scheduling policy'}`}
      className="mt-3 space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3"
    >
      <p className="text-sm text-slate-600">
        Applies to <span className="font-medium text-slate-900">{scope}</span>. The scope cannot
        change; settings left blank are inherited.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name (optional)">
          <input
            name="name"
            maxLength={200}
            defaultValue={policy.name ?? ''}
            className={inputClass}
          />
        </Field>
        <Field label="Effective from" hint="Must be after today everywhere.">
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
        <Field label="Effective to (optional)">
          <input
            name="effectiveTo"
            type="date"
            min={effectiveFrom || undefined}
            defaultValue={policy.effectiveTo ?? ''}
            className={inputClass}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {POLICY_SETTING_KEYS.map((key) => {
          const spec = SETTINGS[key];
          const current = policy[key];
          return (
            <Field key={key} label={spec.label} hint={spec.hint}>
              {spec.kind === 'number' ? (
                <input
                  name={key}
                  type="number"
                  min={spec.min}
                  max={spec.max}
                  defaultValue={current === null ? '' : String(current)}
                  placeholder={`Inherit (${spec.unit})`}
                  className={inputClass}
                />
              ) : (
                <select
                  name={key}
                  defaultValue={current === null ? '' : String(current)}
                  className={inputClass}
                >
                  <option value="">Inherit</option>
                  {spec.options!.map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          );
        })}
      </div>
      {problem && (
        <p role="alert" className="text-sm text-red-700">
          {problem}
        </p>
      )}
      {!problem && <FormError message={error} />}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
          Save policy
        </button>
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The settings that apply to one assignment on one date, and where each comes from. */
function EffectivePolicy({ context }: { context: SchedulingContext }) {
  const [choice, setChoice] = useState<AssignmentChoice | null>(null);
  const [date, setDate] = useState(() => todayIn(context.organization.timezone));
  const [resolved, setResolved] = useState<ResolvedSchedulePolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assignmentId = choice?.assignment.id ?? null;

  useEffect(() => {
    if (!assignmentId || !date) return;
    let active = true;
    const timer = window.setTimeout(() => {
      schedulingApi
        .resolvePolicy(assignmentId, date)
        .then((value) => {
          if (active) {
            setResolved(value);
            setError(null);
          }
        })
        .catch((cause) => {
          if (active) {
            setResolved(null);
            setError(schedulingErrorMessage(cause, 'The effective policy could not be resolved.'));
          }
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [assignmentId, date]);

  return (
    <Panel title="Effective policy for an assignment">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <EmployeeAssignmentPicker
              organizationId={context.organization.id}
              value={choice}
              onChange={(next) => {
                setChoice(next);
                setResolved(null);
              }}
            />
          </div>
          <Field label="On date">
            <input
              type="date"
              className={inputClass}
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </Field>
        </div>
        <Feedback error={error} success={null} />
        {resolved && (
          <DataTable
            bare
            label="Effective settings table"
            caption="Effective settings"
            rows={POLICY_SETTING_KEYS}
            rowKey={(key) => key}
            columns={[
              {
                key: 'setting',
                header: 'Setting',
                rowHeader: true,
                className: 'text-slate-600',
                cell: (key) => SETTINGS[key].label,
              },
              {
                key: 'value',
                header: 'Value',
                className: 'font-medium',
                cell: (key) => settingValue(key, resolved[key]),
              },
              {
                key: 'from',
                header: 'From',
                className: 'text-slate-600',
                cell: (key) => {
                  const source = resolved.sources[key];
                  return !source || source === 'DEFAULT'
                    ? 'Built-in default'
                    : `${SCOPE_LABELS[source.scopeType]} policy`;
                },
              },
            ]}
          />
        )}
      </div>
    </Panel>
  );
}
