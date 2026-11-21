'use client';

import { checkboxClass } from '../../ui/tokens';

import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { attendanceApi } from '../../../lib/attendance/api';
import {
  describeValue,
  fieldError,
  fieldText,
  fieldValue,
  POLICY_SECTIONS,
  type PolicyField,
  type PolicySection,
} from '../../../lib/attendance/policy-schema';
import type {
  AttendanceOrganization,
  InheritedPolicy,
  PolicyScopeType,
  TimePolicy,
  TimePolicyInput,
} from '../../../lib/attendance/types';
import { AuthApiError } from '../../../lib/auth/types';
import { structureSource } from '../../../lib/pickers/sources';
import { timeErrorCode, timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, label } from '../../../lib/time/format';
import { AssignmentIdPicker } from '../../ui/assignment-id-picker';
import { buttonClass } from '../../ui/button';
import { RecordCombobox } from '../../ui/record-combobox';
import { inputClass } from '../../ui/tokens';
import { useConfirm } from '../../ui/use-confirm';
import { sourceText } from './effective-policy';

/**
 * Batch 4E-2 — the attendance policy editor: a new layer for a scope, or the replacement of an
 * existing layer from a date (B3, atomic). Every setting the API supports, grouped by section;
 * a blank setting is inherited from broader layers (or the built-in default). Changes to
 * tracking, capture, the time clock, breaks or missed punches are confirmed with a warning, and
 * an OVERRIDE layer is confirmed with what it resets. The API validates and authorizes every
 * write; its field errors are shown on the field.
 */

const SCOPES: PolicyScopeType[] = [
  'ORGANIZATION',
  'ORGANIZATIONAL_UNIT',
  'DEPARTMENT',
  'TEAM',
  'EMPLOYMENT_ASSIGNMENT',
];
const SCOPE_FIELD: Partial<Record<PolicyScopeType, keyof TimePolicyInput>> = {
  ORGANIZATIONAL_UNIT: 'organizationalUnitId',
  DEPARTMENT: 'departmentId',
  TEAM: 'teamId',
  EMPLOYMENT_ASSIGNMENT: 'employmentAssignmentId',
};

type Values = Record<string, string>;
const id = (section: string, key: string) => `${section}.${key}`;

function valuesOf(config: Record<string, Record<string, unknown>> | undefined): Values {
  const values: Values = {};
  for (const section of POLICY_SECTIONS) {
    for (const field of section.fields) {
      const text = fieldText(config?.[section.key]?.[field.key]);
      if (text !== '') values[id(section.key, field.key)] = text;
    }
  }
  return values;
}

function configOf(values: Values, sections: readonly PolicySection[]) {
  const config: Record<string, Record<string, unknown>> = {};
  for (const section of sections) {
    const entries = section.fields
      .filter((field) => (values[id(section.key, field.key)] ?? '') !== '')
      .map((field) => [field.key, fieldValue(field, values[id(section.key, field.key)]!)]);
    if (entries.length > 0) config[section.key] = Object.fromEntries(entries);
  }
  return config;
}

function FieldControl({
  field,
  value,
  error,
  blankText,
  onChange,
}: {
  field: PolicyField;
  value: string;
  error: string | undefined;
  /** What leaving the setting blank means here (inherited value, or the default). */
  blankText: string;
  onChange(value: string): void;
}) {
  const controlId = useId();
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy = [hintId, error ? errorId : null].filter(Boolean).join(' ');
  const common = {
    id: controlId,
    value,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
    className: inputClass,
  };
  let control: ReactNode;
  switch (field.kind.type) {
    case 'boolean':
      control = (
        <select {...common} onChange={(event) => onChange(event.target.value)}>
          <option value="">Inherit</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
      break;
    case 'enum':
      control = (
        <select {...common} onChange={(event) => onChange(event.target.value)}>
          <option value="">Inherit</option>
          {field.kind.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'integer':
      control = (
        <input
          {...common}
          type="number"
          inputMode="numeric"
          min={field.kind.min}
          max={field.kind.max}
          placeholder="Inherit"
          onChange={(event) => onChange(event.target.value)}
        />
      );
      break;
    case 'localTime':
      control = (
        <input {...common} type="time" onChange={(event) => onChange(event.target.value)} />
      );
      break;
    case 'date':
      control = (
        <input {...common} type="date" onChange={(event) => onChange(event.target.value)} />
      );
      break;
  }
  return (
    <div>
      <label htmlFor={controlId} className="block text-sm font-medium text-slate-800">
        {field.label}
        {field.kind.type === 'integer' && field.kind.unit ? ` (${field.kind.unit})` : ''}
      </label>
      {control}
      <p id={hintId} className="mt-1 text-xs text-slate-600">
        {field.help ? `${field.help} ` : ''}
        {blankText}
      </p>
      {error && (
        <p id={errorId} className="mt-1 text-xs font-medium text-rose-800">
          {error}
        </p>
      )}
    </div>
  );
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type InheritedScope = Omit<Parameters<typeof attendanceApi.inheritedPolicy>[0], 'date'>;

type InheritedState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; view: InheritedPolicy };

/** The scope a layer is for, as the inherited-values request names it (null: not chosen yet). */
function inheritedScope(
  organization: AttendanceOrganization,
  existing: TimePolicy | null,
  scopeType: PolicyScopeType,
  scopeTarget: string,
): InheritedScope | null {
  if (existing) {
    switch (existing.scopeType) {
      case 'ORGANIZATION':
        return { scopeType: 'ORGANIZATION', organizationId: existing.organizationId ?? '' };
      case 'ORGANIZATIONAL_UNIT':
        return {
          scopeType: 'ORGANIZATIONAL_UNIT',
          organizationalUnitId: existing.organizationalUnitId ?? '',
        };
      case 'DEPARTMENT':
        return { scopeType: 'DEPARTMENT', departmentId: existing.departmentId ?? '' };
      case 'TEAM':
        return { scopeType: 'TEAM', teamId: existing.teamId ?? '' };
      case 'EMPLOYMENT_ASSIGNMENT':
        return {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: existing.employmentAssignmentId ?? '',
        };
      default:
        return null;
    }
  }
  if (scopeType === 'SYSTEM') return null;
  if (scopeType === 'ORGANIZATION') {
    return { scopeType, organizationId: organization.id };
  }
  const field = SCOPE_FIELD[scopeType];
  return field && scopeTarget ? { scopeType, [field]: scopeTarget } : null;
}

/**
 * What a blank setting means, in words. Inherited values come only from the API's resolution
 * (the runtime's); when they aren't known exactly, no value is shown.
 */
function blankText(
  field: PolicyField,
  section: string,
  overriding: boolean,
  inherited: InheritedState,
): string {
  if (overriding) {
    return `Blank resets to the built-in default: ${field.defaultText}.`;
  }
  if (inherited.status !== 'ready') {
    return 'Blank inherits from broader policies.';
  }
  const view = inherited.view;
  if (!view.determinable) {
    return 'Blank inherits from broader policies; the value depends on the position.';
  }
  const value = view.config[section]?.[field.key];
  const shown = value === undefined ? field.defaultText : describeValue(field, value);
  const source = sourceText(view, section, field.key);
  return source.kind === 'default'
    ? `Blank inherits the built-in default: ${shown}.`
    : `Blank inherits ${shown} (${source.text.charAt(0).toLowerCase()}${source.text.slice(1)}).`;
}

export type PolicyEditorMode = { kind: 'create' } | { kind: 'supersede'; policy: TimePolicy };

export function PolicyEditor({
  organization,
  mode,
  onSaved,
  onCancel,
  onStale,
  onInspect,
}: {
  organization: AttendanceOrganization;
  mode: PolicyEditorMode;
  /** Opens the Effective policy view (when inherited values can't be shown exactly). */
  onInspect?(): void;
  onSaved(message: string, policy: TimePolicy): void;
  onCancel?(): void;
  /** The layer changed meanwhile (409 TIME_POLICY_CHANGED): reload it. */
  onStale?(): void;
}) {
  const existing = mode.kind === 'supersede' ? mode.policy : null;
  const [scopeType, setScopeType] = useState<PolicyScopeType>(
    existing?.scopeType ?? 'ORGANIZATION',
  );
  const [scopeTarget, setScopeTarget] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [inheritance, setInheritance] = useState<'INHERIT' | 'OVERRIDE'>(
    existing?.inheritanceMode ?? 'INHERIT',
  );
  const [values, setValues] = useState<Values>(() => valuesOf(existing?.config));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const ids = { scope: useId(), from: useId(), to: useId(), override: useId() };
  const sections = useMemo(
    () =>
      POLICY_SECTIONS.filter(
        (section) => !section.organizationOnly || scopeType === 'ORGANIZATION',
      ),
    [scopeType],
  );
  const structure = useMemo(() => {
    const kind =
      scopeType === 'ORGANIZATIONAL_UNIT'
        ? 'units'
        : scopeType === 'DEPARTMENT'
          ? 'departments'
          : scopeType === 'TEAM'
            ? 'teams'
            : null;
    return kind ? structureSource(organization.id, kind) : null;
  }, [organization.id, scopeType]);

  const target = useMemo(
    () => inheritedScope(organization, existing, scopeType, scopeTarget),
    [organization, existing, scopeType, scopeTarget],
  );
  const requestKey =
    target && DATE_ONLY.test(effectiveFrom)
      ? JSON.stringify({ ...target, date: effectiveFrom })
      : null;
  const [loaded, setLoaded] = useState<{ key: string; state: InheritedState } | null>(null);
  useEffect(() => {
    if (!requestKey) return;
    let active = true;
    const timer = window.setTimeout(() => {
      Promise.resolve()
        .then(() =>
          attendanceApi.inheritedPolicy(
            JSON.parse(requestKey) as Parameters<typeof attendanceApi.inheritedPolicy>[0],
          ),
        )
        .then((view) => {
          if (!active) return;
          // Anything but the documented shape is treated as unknown, never guessed from.
          const known =
            view?.determinable === true ||
            (view?.determinable === false && Array.isArray(view.varyingScopes));
          setLoaded({
            key: requestKey,
            state: known ? { status: 'ready', view } : { status: 'error' },
          });
        })
        .catch(() => {
          if (active) setLoaded({ key: requestKey, state: { status: 'error' } });
        });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [requestKey]);
  const inherited: InheritedState = !requestKey
    ? { status: 'none' }
    : loaded?.key === requestKey
      ? loaded.state
      : { status: 'loading' };
  const overriding = inheritance === 'OVERRIDE';

  function validate(): boolean {
    const next: Record<string, string> = {};
    for (const section of sections) {
      for (const field of section.fields) {
        const error = fieldError(field, values[id(section.key, field.key)] ?? '');
        if (error) next[id(section.key, field.key)] = error;
      }
    }
    setErrors(next);
    if (!effectiveFrom) {
      setFormError('Choose the first day this policy applies.');
      return false;
    }
    if (mode.kind === 'create' && SCOPE_FIELD[scopeType] && !scopeTarget) {
      setFormError(`Choose the ${label(scopeType).toLowerCase()} this policy applies to.`);
      return false;
    }
    if (Object.keys(next).length > 0) {
      setFormError('Fix the highlighted settings.');
      return false;
    }
    setFormError(null);
    return true;
  }

  /** The sections whose changes need a warning, compared with the layer being replaced. */
  function warnings(config: Record<string, Record<string, unknown>>) {
    const before = existing?.config ?? {};
    return sections.filter(
      (section) =>
        section.warning &&
        JSON.stringify(config[section.key] ?? {}) !== JSON.stringify(before[section.key] ?? {}),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !validate()) return;
    const config = configOf(values, sections);
    const warned = warnings(config);
    const newlyOverriding = overriding && existing?.inheritanceMode !== 'OVERRIDE';
    if (warned.length > 0 || newlyOverriding) {
      const go = await confirm({
        title: 'Save these policy changes?',
        description: (
          <div className="space-y-2">
            <p>From {formatDateOnly(effectiveFrom)}:</p>
            <ul className="list-disc space-y-1 pl-5">
              {newlyOverriding && (
                <li>
                  This layer overrides: every setting it leaves blank resets to the built-in default
                  instead of inheriting from broader layers.
                </li>
              )}
              {warned.map((section) => (
                <li key={section.key}>{section.warning}</li>
              ))}
            </ul>
          </div>
        ),
        confirmLabel: 'Save policy',
        destructive: false,
      });
      if (!go) return;
    }
    setBusy(true);
    setFormError(null);
    try {
      let saved: TimePolicy;
      if (existing) {
        const result = await attendanceApi.supersedePolicy(existing.id, {
          effectiveFrom,
          config,
          inheritanceMode: inheritance,
          expectedUpdatedAt: existing.updatedAt ?? '',
        });
        saved = result.created;
      } else {
        const field = SCOPE_FIELD[scopeType];
        saved = await attendanceApi.createPolicy({
          scopeType,
          ...(scopeType === 'ORGANIZATION' ? { organizationId: organization.id } : {}),
          ...(field ? { [field]: scopeTarget } : {}),
          inheritanceMode: inheritance,
          effectiveFrom,
          ...(effectiveTo ? { effectiveTo } : {}),
          config,
        });
      }
      onSaved(
        existing
          ? `Policy replaced from ${formatDateOnly(effectiveFrom)}; the previous layer ends the day before.`
          : 'Attendance policy added.',
        saved,
      );
    } catch (cause) {
      const code = timeErrorCode(cause);
      const path =
        cause instanceof AuthApiError && typeof cause.details?.path === 'string'
          ? cause.details.path
          : null;
      if (code === 'TIME_POLICY_CONFIG_INVALID' && path) {
        setErrors({
          [path]:
            cause instanceof AuthApiError
              ? (cause.validationMessage ?? 'Invalid value.')
              : 'Invalid value.',
        });
        setFormError('Fix the highlighted settings.');
      } else {
        setFormError(timeErrorMessage(cause, 'Unable to save this policy.'));
        if (code === 'TIME_POLICY_CHANGED') onStale?.();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label={existing ? 'Change policy from a date' : 'Add attendance policy'}
      className="space-y-5"
      noValidate
    >
      {confirmDialog}
      <div className="grid gap-3 md:grid-cols-3">
        {existing ? (
          <p className="text-sm text-slate-700 md:col-span-3">
            Replaces the <strong>{existing.scopeName ?? label(existing.scopeType)}</strong> policy
            from the date you choose: it ends the day before, and its earlier days, with everything
            recorded under them, stay as they were.
          </p>
        ) : (
          <>
            <div>
              <label htmlFor={ids.scope} className="block text-sm font-medium text-slate-700">
                Scope
              </label>
              <select
                id={ids.scope}
                value={scopeType}
                onChange={(event) => {
                  setScopeType(event.target.value as PolicyScopeType);
                  setScopeTarget('');
                }}
                aria-describedby={`${ids.scope}-hint`}
                className={inputClass}
              >
                {SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {label(scope)}
                  </option>
                ))}
              </select>
              <p id={`${ids.scope}-hint`} className="mt-1 text-xs text-slate-600">
                There is no position scope: use the position&apos;s team or department, or an
                employment assignment.
              </p>
            </div>
            {structure && (
              <RecordCombobox
                label={label(scopeType)}
                required
                source={structure}
                value={scopeTarget}
                onChange={(next) => setScopeTarget(next)}
                noResultsText="Nothing matches in this organization."
                manualEntry={{ label: `${label(scopeType)} ID` }}
              />
            )}
            {scopeType === 'EMPLOYMENT_ASSIGNMENT' && (
              <AssignmentIdPicker
                label="Employment assignment"
                organizationId={organization.id}
                required
                value={scopeTarget}
                onChange={setScopeTarget}
              />
            )}
          </>
        )}
        <div>
          <label htmlFor={ids.from} className="block text-sm font-medium text-slate-700">
            {existing ? 'Replace from' : 'Effective from'}
          </label>
          <input
            id={ids.from}
            type="date"
            required
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            className={inputClass}
          />
        </div>
        {!existing && (
          <div>
            <label htmlFor={ids.to} className="block text-sm font-medium text-slate-700">
              Effective to (optional)
            </label>
            <input
              id={ids.to}
              type="date"
              value={effectiveTo}
              onChange={(event) => setEffectiveTo(event.target.value)}
              className={inputClass}
            />
          </div>
        )}
        <div className="flex items-start gap-2 md:col-span-3">
          <input
            id={ids.override}
            type="checkbox"
            checked={inheritance === 'OVERRIDE'}
            onChange={(event) => setInheritance(event.target.checked ? 'OVERRIDE' : 'INHERIT')}
            aria-describedby={`${ids.override}-hint`}
            className={`${checkboxClass} mt-1`}
          />
          <div>
            <label htmlFor={ids.override} className="text-sm font-medium text-slate-800">
              Override broader policies
            </label>
            <p id={`${ids.override}-hint`} className="text-xs text-slate-600">
              Settings left blank then use the built-in defaults instead of inheriting from the
              organization, unit, department or team.
            </p>
          </div>
        </div>
      </div>

      <InheritedNote
        overriding={overriding}
        inherited={inherited}
        scopeChosen={target !== null}
        onInspect={onInspect}
      />

      {sections.map((section) => (
        <fieldset key={section.key} className="rounded-lg border border-slate-200 p-4">
          <legend className="px-1 text-sm font-semibold text-slate-950">{section.title}</legend>
          <p className="text-sm text-slate-600">{section.description}</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {section.fields.map((field) => (
              <FieldControl
                key={field.key}
                field={field}
                value={values[id(section.key, field.key)] ?? ''}
                error={errors[id(section.key, field.key)]}
                blankText={blankText(field, section.key, overriding, inherited)}
                onChange={(next) => {
                  setValues((current) => ({ ...current, [id(section.key, field.key)]: next }));
                  setErrors((current) => {
                    const rest = { ...current };
                    delete rest[id(section.key, field.key)];
                    return rest;
                  });
                }}
              />
            ))}
          </div>
        </fieldset>
      ))}

      {formError && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {formError}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          {busy ? 'Saving…' : existing ? 'Replace policy' : 'Add policy'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={buttonClass('secondary')}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** Above the settings: what blank settings take here, and where to look when it isn't exact. */
function InheritedNote({
  overriding,
  inherited,
  scopeChosen,
  onInspect,
}: {
  overriding: boolean;
  inherited: InheritedState;
  scopeChosen: boolean;
  onInspect?(): void;
}) {
  let text: string;
  let inspect = false;
  if (overriding) {
    text = 'This layer overrides: settings left blank use the built-in defaults shown.';
  } else if (inherited.status === 'none') {
    text = scopeChosen
      ? 'Choose the first day to see what blank settings inherit.'
      : 'Choose the scope and the first day to see what blank settings inherit.';
  } else if (inherited.status === 'loading') {
    text = 'Loading what blank settings inherit…';
  } else if (inherited.status === 'error') {
    text =
      'What blank settings inherit could not be loaded. The Effective policy view shows the settings that apply to an assignment.';
    inspect = true;
  } else if (!inherited.view.determinable) {
    text = `Inherited values are not shown: for a ${
      inherited.view.varyingScopes.includes('DEPARTMENT') ? 'team' : 'department'
    } they depend on each position's ${
      inherited.view.varyingScopes.includes('DEPARTMENT') ? 'unit and department' : 'unit'
    }, and such policies apply on ${formatDateOnly(inherited.view.date)}. Check an assignment in the Effective policy view.`;
    inspect = true;
  } else {
    text = `Blank settings inherit the values shown, as broader policies stand on ${formatDateOnly(
      inherited.view.date,
    )}; a later change to a broader policy changes them too.`;
  }
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700"
    >
      <span>{text}</span>
      {inspect && onInspect && (
        <button type="button" onClick={onInspect} className={buttonClass('secondary', 'sm')}>
          Open the effective policy view
        </button>
      )}
    </div>
  );
}
