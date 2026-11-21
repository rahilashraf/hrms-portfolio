'use client';

import { useState, type FormEvent } from 'react';
import { buttonClass } from '../ui/button';
import { schedulingApi } from '../../lib/scheduling/api';
import {
  conflictsOf,
  schedulingErrorCode,
  schedulingErrorMessage,
} from '../../lib/scheduling/errors';
import type {
  GridShift,
  Schedule,
  ScheduleConflict,
  ShiftFieldsInput,
} from '../../lib/scheduling/types';
import { addDays, fromZoned, toZoned } from '../../lib/scheduling/time';
import {
  ConflictList,
  EmployeeAssignmentPicker,
  Feedback,
  Field,
  RequiredReason,
  StructureLoadError,
  inputClass,
  overridesFrom,
  type AssignmentChoice,
  type Structure,
} from './scheduling-shared';

export type ShiftEditorMode = 'create' | 'edit' | 'add' | 'correct';

const TITLES: Record<ShiftEditorMode, string> = {
  create: 'Add a draft shift',
  edit: 'Edit draft shift',
  add: 'Add a shift to the published schedule',
  correct: 'Correct a published shift',
};

/**
 * Creates or changes one shift. Drafts are edited directly (with a conflict preview); a
 * published schedule only takes revision-based changes — add and correct — each with a reason.
 * Conflicts are never overridden silently: each needs a reason and the override permission.
 */
export function ShiftEditor({
  mode,
  schedule,
  shift,
  organizationId,
  organizationTimezone,
  structure,
  canOverride,
  onCancel,
  onSaved,
}: {
  mode: ShiftEditorMode;
  schedule: Pick<Schedule, 'id' | 'name' | 'periodStart' | 'periodEnd'>;
  shift?: GridShift;
  organizationId: string;
  organizationTimezone: string | null;
  structure: Structure;
  canOverride: boolean;
  onCancel(): void;
  onSaved(message: string): void;
}) {
  const initial = shift ? toZoned(shift.startsAt, shift.timezone) : null;
  const initialEnd = shift ? toZoned(shift.endsAt, shift.timezone) : null;
  const [choice, setChoice] = useState<AssignmentChoice | null>(null);
  const [workLocationId, setWorkLocationId] = useState(shift?.workLocation?.id ?? '');
  const [workDate, setWorkDate] = useState(
    shift?.workDate ?? (schedule.periodStart > todayGuess() ? schedule.periodStart : todayGuess()),
  );
  const [start, setStart] = useState(initial?.time ?? '09:00');
  const [end, setEnd] = useState(initialEnd?.time ?? '17:00');
  const [reason, setReason] = useState('');
  const [conflicts, setConflicts] = useState<ScheduleConflict[] | null>(null);
  const [overrideReasons, setOverrideReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const published = mode === 'add' || mode === 'correct';
  const assignmentFixed = mode === 'edit' || mode === 'correct';
  const location = structure.workLocations.find((item) => item.id === workLocationId);
  const timezone = location?.timezone ?? shift?.timezone ?? organizationTimezone ?? 'UTC';

  function fields(): ShiftFieldsInput | null {
    const assignmentId = assignmentFixed ? shift!.employmentAssignmentId : choice?.assignment.id;
    if (!assignmentId) {
      setError('Choose the employee and the assignment the shift is for.');
      return null;
    }
    const startsAt = fromZoned(workDate, start, timezone);
    // An end at or before the start is the next day (an overnight shift).
    const endsAt = fromZoned(end <= start ? addDays(workDate, 1) : workDate, end, timezone);
    return {
      employmentAssignmentId: assignmentId,
      ...(workLocationId ? { workLocationId } : {}),
      workDate,
      startsAt,
      endsAt,
      timezone,
    };
  }

  /** The changed fields only (edit and correct send a partial update). */
  function changes(all: ShiftFieldsInput) {
    if (!shift) return all;
    const out: Record<string, unknown> = {};
    if (all.workDate !== shift.workDate) out.workDate = all.workDate;
    if (all.startsAt !== new Date(shift.startsAt).toISOString()) out.startsAt = all.startsAt;
    if (all.endsAt !== new Date(shift.endsAt).toISOString()) out.endsAt = all.endsAt;
    if ((workLocationId || null) !== (shift.workLocation?.id ?? null)) {
      out.workLocationId = workLocationId || null;
    }
    if (Object.keys(out).length > 0) out.timezone = all.timezone;
    return out;
  }

  async function preview() {
    const all = fields();
    if (!all) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'edit' && shift
          ? await schedulingApi.previewShiftUpdate(schedule.id, shift.id, changes(all))
          : await schedulingApi.previewNewShift(schedule.id, all);
      setConflicts(result.conflicts);
    } catch (cause) {
      setError(schedulingErrorMessage(cause, 'The shift could not be checked.'));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const all = fields();
    if (!all) return;
    if (published && !reason.trim()) {
      setError('A reason is required for changes to a published schedule.');
      return;
    }
    const conflictOverrides = conflicts ? overridesFrom(conflicts, overrideReasons) : [];
    const withOverrides = conflictOverrides.length > 0 ? { conflictOverrides } : {};
    setBusy(true);
    setError(null);
    try {
      if (mode === 'create') {
        await schedulingApi.createShift(schedule.id, { ...all, ...withOverrides });
        onSaved('Draft shift added.');
      } else if (mode === 'edit') {
        const delta = changes(all);
        if (Object.keys(delta).length === 0) {
          setError('Nothing changed.');
          return;
        }
        await schedulingApi.updateShift(schedule.id, shift!.id, { ...delta, ...withOverrides });
        onSaved('Draft shift updated.');
      } else if (mode === 'add') {
        await schedulingApi.addPublishedShift(schedule.id, {
          ...all,
          ...withOverrides,
          reason: reason.trim(),
        });
        onSaved('Shift added to the published schedule.');
      } else {
        const delta = changes(all);
        if (Object.keys(delta).length === 0) {
          setError('Change at least one field to correct the shift.');
          return;
        }
        await schedulingApi.correctShift(schedule.id, shift!.id, {
          ...delta,
          ...withOverrides,
          reason: reason.trim(),
        });
        onSaved('Published shift corrected; a new revision was recorded.');
      }
    } catch (cause) {
      const found = conflictsOf(cause);
      if (found) {
        // A refusal for conflicts: show them; the user may give override reasons and retry.
        setConflicts(found);
        const code = schedulingErrorCode(cause);
        setError(
          code === 'SCHEDULE_CONFLICT_ERROR'
            ? 'The shift has a blocking conflict and cannot be saved. Change the shift.'
            : code === 'SCHEDULE_CONFLICT_OVERRIDE_STALE'
              ? 'The conflicts changed meanwhile. Review them and give the override reasons again.'
              : 'The shift has conflicts that need an override reason (or a change to the shift).',
        );
      } else {
        setError(schedulingErrorMessage(cause, 'The shift could not be saved.'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-label={TITLES[mode]}
      className="space-y-4 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4"
    >
      <div>
        <h3 className="text-base font-semibold text-slate-950">{TITLES[mode]}</h3>
        <p className="text-sm text-slate-600">
          {schedule.name} · times in {timezone}
          {published && ' · the original shift is kept in the revision history'}
        </p>
      </div>
      <Feedback error={error} success={null} />
      {assignmentFixed && shift ? (
        <Field label="Employee and assignment">
          <p className="mt-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
            {shift.employee.displayName ?? shift.employee.employeeNumber} —{' '}
            {shift.assignment.position.name} · {shift.assignment.organization.name}
          </p>
        </Field>
      ) : (
        <EmployeeAssignmentPicker
          organizationId={organizationId}
          value={choice}
          onChange={(next) => {
            setChoice(next);
            setConflicts(null);
            if (next?.assignment.workLocation && !workLocationId) {
              setWorkLocationId(next.assignment.workLocation.id);
            }
          }}
        />
      )}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Date">
          <input
            type="date"
            className={inputClass}
            required
            min={schedule.periodStart}
            max={schedule.periodEnd}
            value={workDate}
            onChange={(event) => {
              setWorkDate(event.target.value);
              setConflicts(null);
            }}
          />
        </Field>
        <Field label="Starts">
          <input
            type="time"
            className={inputClass}
            required
            value={start}
            onChange={(event) => {
              setStart(event.target.value);
              setConflicts(null);
            }}
          />
        </Field>
        <Field label="Ends" hint={end <= start ? 'Ends the next day (overnight).' : undefined}>
          <input
            type="time"
            className={inputClass}
            required
            value={end}
            onChange={(event) => {
              setEnd(event.target.value);
              setConflicts(null);
            }}
          />
        </Field>
        <Field label="Work location">
          {structure.available ? (
            <select
              className={inputClass}
              value={workLocationId}
              onChange={(event) => {
                setWorkLocationId(event.target.value);
                setConflicts(null);
              }}
            >
              <option value="">None</option>
              {structure.workLocations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="mt-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
              {choice?.assignment.workLocation?.name ??
                shift?.workLocation?.name ??
                'Position default'}
            </p>
          )}
        </Field>
      </div>
      <StructureLoadError structure={structure} />
      {published && <RequiredReason value={reason} onChange={setReason} />}
      {conflicts && (
        <ConflictList
          conflicts={conflicts}
          canOverride={canOverride}
          reasons={overrideReasons}
          onReasonChange={(key, value) =>
            setOverrideReasons((current) => ({ ...current, [key]: value }))
          }
          timezone={timezone}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
          {mode === 'create' || mode === 'add' ? 'Save shift' : 'Save changes'}
        </button>
        {!published && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void preview()}
            className={buttonClass('secondary', 'sm')}
          >
            Check conflicts
          </button>
        )}
        <button type="button" onClick={onCancel} className={buttonClass('ghost', 'sm')}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function todayGuess(): string {
  return new Date().toISOString().slice(0, 10);
}
