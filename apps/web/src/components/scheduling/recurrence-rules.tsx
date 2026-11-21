'use client';

import { checkboxClass } from '../ui/tokens';

import { useRef, useState, type FormEvent } from 'react';
import { buttonClass } from '../ui/button';
import type {
  DayOfWeek,
  RecurrenceRule,
  RecurrenceRuleInput,
  RecurrenceRuleUpdateInput,
} from '../../lib/scheduling/types';
import {
  Field,
  FormError,
  inputClass,
  type Structure,
  structureName,
  useEditFormFocus,
} from './scheduling-shared';
import { ConfirmButton } from '../ui/confirm-button';
import { DataTable } from '../ui/data-table';

export const DAYS: DayOfWeek[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];

export function dayLabel(day: DayOfWeek): string {
  return day.charAt(0) + day.slice(1).toLowerCase();
}

function sortRules(rules: RecurrenceRule[]) {
  return [...rules].sort(
    (a, b) =>
      a.weekIndex - b.weekIndex ||
      DAYS.indexOf(a.dayOfWeek) - DAYS.indexOf(b.dayOfWeek) ||
      a.startLocalTime.localeCompare(b.startLocalTime),
  );
}

/** The weekly rules of a template or pattern, with optional edit and delete. */
export function RuleTable({
  rules,
  rotationWeeks,
  structure,
  onEdit,
  onDelete,
  busy,
}: {
  rules: RecurrenceRule[];
  rotationWeeks: number;
  structure: Structure;
  onEdit?(rule: RecurrenceRule): void;
  onDelete?(rule: RecurrenceRule): void;
  busy?: boolean;
}) {
  if (rules.length === 0) {
    return <p className="text-sm text-slate-600">No shift rules yet.</p>;
  }
  return (
    <DataTable
      bare
      label="Shift rules"
      rows={sortRules(rules)}
      rowKey={(rule) => rule.id}
      columns={[
        ...(rotationWeeks > 1
          ? [{ key: 'week', header: 'Week', cell: (rule: RecurrenceRule) => rule.weekIndex + 1 }]
          : []),
        { key: 'day', header: 'Day', cell: (rule) => dayLabel(rule.dayOfWeek) },
        {
          key: 'time',
          header: 'Time',
          cell: (rule) => (
            <>
              {rule.startLocalTime}–{rule.endLocalTime}
              {rule.overnight && ' (overnight)'}
            </>
          ),
        },
        {
          key: 'location',
          header: 'Location',
          cell: (rule) =>
            structureName(structure, rule.workLocationId) ??
            (rule.workLocationId ? rule.workLocationId.slice(0, 8) : 'Position default'),
        },
        ...(onDelete || onEdit
          ? [
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                align: 'right' as const,
                cell: (rule: RecurrenceRule) => (
                  <span className="inline-flex gap-1">
                    {onEdit && (
                      <button
                        type="button"
                        disabled={busy}
                        className={buttonClass('ghost', 'sm')}
                        onClick={() => onEdit(rule)}
                        aria-label={`Edit ${dayLabel(rule.dayOfWeek)} ${rule.startLocalTime} rule`}
                      >
                        Edit
                      </button>
                    )}
                    {onDelete && (
                      <ConfirmButton
                        disabled={busy}
                        className={buttonClass('ghost', 'sm')}
                        confirm={{
                          title: `Remove the ${dayLabel(rule.dayOfWeek)} ${rule.startLocalTime} rule?`,
                          description:
                            'Shifts are no longer generated from this rule. Shifts already generated are not changed.',
                          confirmLabel: 'Remove rule',
                        }}
                        onConfirm={() => onDelete(rule)}
                        aria-label={`Remove ${dayLabel(rule.dayOfWeek)} ${rule.startLocalTime} rule`}
                      >
                        Remove
                      </ConfirmButton>
                    )}
                  </span>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

/** One weekly shift rule: rotation week, weekday, local start/end and optional location. */
export function RuleForm({
  rotationWeeks,
  structure,
  busy,
  submitLabel = 'Add rule',
  onSubmit,
}: {
  rotationWeeks: number;
  structure: Structure;
  busy?: boolean;
  submitLabel?: string;
  /** One rule per selected day. */
  onSubmit(rules: RecurrenceRuleInput[]): void | Promise<unknown>;
}) {
  const [days, setDays] = useState<DayOfWeek[]>(['MONDAY']);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    void onSubmit(
      DAYS.filter((day) => days.includes(day)).map((day) => ({
        weekIndex: Number(text('weekIndex') || 0),
        dayOfWeek: day,
        startLocalTime: text('startLocalTime'),
        endLocalTime: text('endLocalTime'),
        ...(text('workLocationId') ? { workLocationId: text('workLocationId') } : {}),
      })),
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Shift rule"
      className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3"
    >
      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Days</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {DAYS.map((day) => (
            <label key={day} className="inline-flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={days.includes(day)}
                onChange={(event) =>
                  setDays((current) =>
                    event.target.checked ? [...current, day] : current.filter((d) => d !== day),
                  )
                }
              />
              {dayLabel(day).slice(0, 3)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-4">
        {rotationWeeks > 1 && (
          <Field label="Rotation week">
            <select name="weekIndex" className={inputClass} defaultValue="0">
              {Array.from({ length: rotationWeeks }, (_, index) => (
                <option key={index} value={index}>
                  Week {index + 1}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Starts">
          <input
            name="startLocalTime"
            type="time"
            required
            className={inputClass}
            defaultValue="09:00"
          />
        </Field>
        <Field label="Ends" hint="Earlier than the start means overnight.">
          <input
            name="endLocalTime"
            type="time"
            required
            className={inputClass}
            defaultValue="17:00"
          />
        </Field>
        {structure.available && (
          <Field label="Work location">
            <select name="workLocationId" className={inputClass} defaultValue="">
              <option value="">Position default</option>
              {structure.workLocations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <button
        type="submit"
        disabled={busy || days.length === 0}
        className={buttonClass('secondary', 'sm')}
      >
        {submitLabel}
      </button>
    </form>
  );
}

/** The fields of a rule edit that differ from the stored rule (an empty object changes nothing). */
export function ruleChanges(
  rule: RecurrenceRule,
  next: Required<
    Pick<RecurrenceRuleInput, 'weekIndex' | 'dayOfWeek' | 'startLocalTime' | 'endLocalTime'>
  > & {
    workLocationId: string | null;
  },
): RecurrenceRuleUpdateInput {
  const changes: RecurrenceRuleUpdateInput = {};
  if (next.weekIndex !== rule.weekIndex) changes.weekIndex = next.weekIndex;
  if (next.dayOfWeek !== rule.dayOfWeek) changes.dayOfWeek = next.dayOfWeek;
  if (next.startLocalTime !== rule.startLocalTime) changes.startLocalTime = next.startLocalTime;
  if (next.endLocalTime !== rule.endLocalTime) changes.endLocalTime = next.endLocalTime;
  if (next.workLocationId !== rule.workLocationId) changes.workLocationId = next.workLocationId;
  return changes;
}

/**
 * Edits one existing weekly rule (R3.1). The current values are shown before editing; only the
 * fields that change are sent, and the API re-validates the rule against the others (overlaps,
 * rotation week, location).
 */
export function RuleEditForm({
  rule,
  rotationWeeks,
  structure,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  rule: RecurrenceRule;
  rotationWeeks: number;
  structure: Structure;
  busy?: boolean;
  /** R4-A.7: the API's refusal of the last save, shown in this form. */
  error?: string | null;
  onCancel(): void;
  onSubmit(changes: RecurrenceRuleUpdateInput): void | Promise<unknown>;
}) {
  const [unchanged, setUnchanged] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEditFormFocus(formRef);
  const label = `${dayLabel(rule.dayOfWeek)} ${rule.startLocalTime} rule`;
  // A location that is no longer listed (archived) stays selectable so the rule is shown as it is.
  const knownLocation =
    !rule.workLocationId || structure.workLocations.some((item) => item.id === rule.workLocationId);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const changes = ruleChanges(rule, {
      weekIndex: Number(text('weekIndex') || rule.weekIndex),
      dayOfWeek: text('dayOfWeek') as DayOfWeek,
      startLocalTime: text('startLocalTime'),
      endLocalTime: text('endLocalTime'),
      workLocationId: structure.available ? text('workLocationId') || null : rule.workLocationId,
    });
    if (Object.keys(changes).length === 0) {
      setUnchanged(true);
      return;
    }
    setUnchanged(false);
    void onSubmit(changes);
  }

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      aria-label={`Edit ${label}`}
      className="space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/40 p-3"
    >
      <p className="text-sm font-medium text-slate-800">Edit the {label}</p>
      <div className="grid gap-3 sm:grid-cols-5">
        {rotationWeeks > 1 && (
          <Field label="Rotation week">
            <select name="weekIndex" className={inputClass} defaultValue={String(rule.weekIndex)}>
              {Array.from({ length: rotationWeeks }, (_, index) => (
                <option key={index} value={index}>
                  Week {index + 1}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Day">
          <select name="dayOfWeek" className={inputClass} defaultValue={rule.dayOfWeek}>
            {DAYS.map((day) => (
              <option key={day} value={day}>
                {dayLabel(day)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Starts">
          <input
            name="startLocalTime"
            type="time"
            required
            className={inputClass}
            defaultValue={rule.startLocalTime}
          />
        </Field>
        <Field label="Ends" hint="Earlier than the start means overnight.">
          <input
            name="endLocalTime"
            type="time"
            required
            className={inputClass}
            defaultValue={rule.endLocalTime}
          />
        </Field>
        {structure.available && (
          <Field label="Work location">
            <select
              name="workLocationId"
              className={inputClass}
              defaultValue={rule.workLocationId ?? ''}
            >
              <option value="">Position default</option>
              {!knownLocation && rule.workLocationId && (
                <option value={rule.workLocationId}>Current location (not listed)</option>
              )}
              {structure.workLocations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {unchanged && (
        <p role="status" className="text-sm text-slate-600">
          Nothing changed.
        </p>
      )}
      <FormError message={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
          Save rule
        </button>
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
