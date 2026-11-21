'use client';

import { useId, useState } from 'react';
import { timeApi } from '../../../lib/time/api';
import {
  LOCAL_TIME_SELECT_OCCURRENCE,
  localTimeOccurrences,
  timeErrorCode,
  timeErrorMessage,
} from '../../../lib/time/errors';
import type { LocalTimeOccurrence, TimeEntryRead } from '../../../lib/time/types';
import { checkboxClass, inputClass } from '../../ui/tokens';

/**
 * Batch 4E-1 (D3) — a manager's direct correction of an entry and manual missing entry, through
 * the existing routes (time.correct; never one's own time). Raw punches are never changed: the
 * API records the correction as an approved adjustment with its reason, in the audit trail.
 *
 * Typed times are local to the entry's time zone. On a day the clocks go back, a repeated time
 * is refused (409 TIME_LOCAL_TIME_AMBIGUOUS, both occurrences listed): the manager picks one and
 * it is sent again with that explicit offset. A time skipped by the clocks going forward is
 * refused with an explanation.
 */

/** An ISO instant as `YYYY-MM-DDTHH:mm` in a time zone (the datetime-local input's format). */
export function toLocalInput(iso: string | null | undefined, timezone: string): string {
  if (!iso) return '';
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(iso))
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    return '';
  }
}

/** Shared since Batch 5C (components/ui/form-dialog); re-exported for existing imports. */
import { FormDialog } from '../../ui/form-dialog';
export { FormDialog };

export function LocalTimeField({
  label,
  value,
  onChange,
  timezone,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  timezone: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        type="datetime-local"
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={`${id}-zone`}
        className={inputClass}
      />
      <p id={`${id}-zone`} className="mt-1 text-xs text-slate-600">
        Local time in {timezone}.
      </p>
    </div>
  );
}

export function ReasonField({ value, onChange }: { value: string; onChange(value: string): void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        Reason
      </label>
      <textarea
        id={id}
        rows={2}
        required
        maxLength={1000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={`${id}-hint`}
        className={inputClass}
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-slate-600">
        Recorded with the correction in the audit trail.
      </p>
    </div>
  );
}

/** The choice between both occurrences of a repeated local time. */
export function OccurrenceChoice({
  occurrences,
  value,
  onChange,
}: {
  occurrences: LocalTimeOccurrence[];
  value: string;
  onChange(value: string): void;
}) {
  const name = useId();
  const local = occurrences[0]?.value.slice(0, 16).replace('T', ' ') ?? '';
  return (
    <fieldset className="rounded-lg border border-amber-300 bg-amber-50 p-3">
      <legend className="px-1 text-sm font-semibold text-amber-950">
        {local} happens twice on this day. Which one?
      </legend>
      <div className="mt-2 space-y-2">
        {occurrences.map((occurrence, index) => (
          <label key={occurrence.value} className="flex items-center gap-2 text-sm text-slate-900">
            <input
              type="radio"
              name={name}
              value={occurrence.value}
              checked={value === occurrence.value}
              onChange={() => onChange(occurrence.value)}
            />
            {index === 0 ? 'First' : 'Second'} occurrence (UTC{occurrence.offset})
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Sends a request whose local times may need an explicit offset. Returns the field that was
 * ambiguous and its occurrences, or null when it succeeded (other errors are thrown).
 */
export function useLocalTimeSubmission() {
  const [ambiguous, setAmbiguous] = useState<{
    field: string;
    occurrences: LocalTimeOccurrence[];
  } | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});

  /** The value to send for a field: the chosen occurrence when the typed time is ambiguous. */
  function resolved(field: string, typed: string): string {
    const pick = chosen[field];
    return pick && pick.startsWith(typed) ? pick : typed;
  }

  function absorb(error: unknown, fields: Record<string, string>): boolean {
    if (timeErrorCode(error) !== 'TIME_LOCAL_TIME_AMBIGUOUS') return false;
    const occurrences = localTimeOccurrences(error);
    const field = Object.entries(fields).find(([, typed]) =>
      occurrences.some((occurrence) => occurrence.value.startsWith(typed)),
    )?.[0];
    if (!field || occurrences.length === 0) return false;
    setAmbiguous({ field, occurrences });
    return true;
  }

  return {
    ambiguous,
    chosen,
    choose(field: string, value: string) {
      setChosen((current) => ({ ...current, [field]: value }));
    },
    reset() {
      setAmbiguous(null);
      setChosen({});
    },
    resolved,
    absorb,
  };
}

type CorrectionKind =
  'CHANGE_CLOCK_IN' | 'CHANGE_CLOCK_OUT' | 'ADD_MISSING_CLOCK_OUT' | 'CHANGE_COVERAGE';

/** R4-A.4: an assignment a correction may make the entry cover (the server re-checks it). */
export interface CoverageOption {
  id: string;
  name: string;
}

/** The covered assignments besides the payroll owner (what CHANGE_COVERAGE replaces). */
export function currentCoverageIds(entry: TimeEntryRead): string[] {
  return (entry.coverage ?? [])
    .filter((covered) => !covered.isPayrollOwner)
    .map((covered) => covered.employmentAssignmentId);
}

export function CorrectEntryDialog({
  entry,
  coverageOptions = [],
  onClose,
  onDone,
}: {
  entry: TimeEntryRead | null;
  /** The employee's assignments in this organization (e.g. the timesheet's segments). */
  coverageOptions?: CoverageOption[];
  onClose(): void;
  onDone(message: string): void;
}) {
  // Keyed by entry: every opening starts from that entry's own times.
  return entry ? (
    <CorrectEntryForm
      key={entry.id}
      entry={entry}
      coverageOptions={coverageOptions}
      onClose={onClose}
      onDone={onDone}
    />
  ) : null;
}

function CorrectEntryForm({
  entry,
  coverageOptions,
  onClose,
  onDone,
}: {
  entry: TimeEntryRead;
  coverageOptions: CoverageOption[];
  onClose(): void;
  onDone(message: string): void;
}) {
  const open = true;
  const timezone = entry.timezone;
  const isOpen = entry.clockOutAt === null;
  const [kind, setKind] = useState<CorrectionKind>(
    entry.clockOutAt ? 'CHANGE_CLOCK_OUT' : 'ADD_MISSING_CLOCK_OUT',
  );
  const [value, setValue] = useState(() =>
    toLocalInput(entry.clockOutAt ?? entry.clockInAt, entry.timezone),
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = useLocalTimeSubmission();
  const kindId = useId();
  const coverageId = useId();
  // R4-A.4: other assignments the entry may cover (never the payroll owner itself).
  const owner = entry.assignment.id;
  const extraOptions = coverageOptions.filter((option) => option.id !== owner);
  const before = currentCoverageIds(entry);
  const [covered, setCovered] = useState<string[]>(before);
  const coverage = kind === 'CHANGE_COVERAGE';
  const nameOf = (id: string) =>
    extraOptions.find((option) => option.id === id)?.name ??
    entry.coverage?.find((c) => c.employmentAssignmentId === id)?.assignment.position.name ??
    'Another assignment';
  const coverageChanged =
    covered.length !== before.length || covered.some((id) => !before.includes(id));

  const field = kind === 'CHANGE_CLOCK_IN' ? 'clockInAt' : 'clockOutAt';
  const needsChoice =
    !coverage && local.ambiguous?.field === field && !local.chosen[field]?.startsWith(value);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (coverage) {
        await timeApi.correctEntry(entry.id, {
          type: 'CHANGE_COVERAGE',
          reason: reason.trim(),
          additionalEmploymentAssignmentIds: covered,
        });
        onDone('Coverage corrected. The recorded time is unchanged and still counted once.');
        return;
      }
      const sent = local.resolved(field, value);
      await timeApi.correctEntry(entry.id, { type: kind, reason: reason.trim(), [field]: sent });
      onDone('Time entry corrected.');
    } catch (cause) {
      if (local.absorb(cause, { [field]: value })) {
        setError(LOCAL_TIME_SELECT_OCCURRENCE);
      } else {
        setError(timeErrorMessage(cause, 'Unable to correct this entry.'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open={open}
      title="Correct time entry"
      description={
        <>
          {entry.employeeName} · {entry.assignment.position.name} · work date {entry.workDate}. The
          original punches are kept; the correction is recorded with your reason.
        </>
      }
      submitLabel="Save correction"
      busy={busy}
      canSubmit={
        reason.trim() !== '' && (coverage ? coverageChanged : value !== '' && !needsChoice)
      }
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <div>
        <label htmlFor={kindId} className="block text-sm font-medium text-slate-800">
          What to correct
        </label>
        <select
          id={kindId}
          value={kind}
          onChange={(event) => {
            const next = event.target.value as CorrectionKind;
            setKind(next);
            setValue(
              toLocalInput(
                next === 'CHANGE_CLOCK_IN'
                  ? entry.clockInAt
                  : (entry.clockOutAt ?? entry.clockInAt),
                timezone,
              ),
            );
            local.reset();
          }}
          className={inputClass}
        >
          <option value="CHANGE_CLOCK_IN">Clock-in time</option>
          {isOpen ? (
            <option value="ADD_MISSING_CLOCK_OUT">Missing clock-out</option>
          ) : (
            <option value="CHANGE_CLOCK_OUT">Clock-out time</option>
          )}
          {(extraOptions.length > 0 || before.length > 0) && (
            <option value="CHANGE_COVERAGE">Assignments covered</option>
          )}
        </select>
      </div>
      {coverage ? (
        <CoverageFields
          id={coverageId}
          ownerName={entry.assignment.position.name}
          options={[
            ...extraOptions,
            // A covered assignment no longer listed (e.g. ended) can still be removed.
            ...before
              .filter((id) => !extraOptions.some((option) => option.id === id))
              .map((id) => ({ id, name: nameOf(id) })),
          ]}
          value={covered}
          onChange={(next) => {
            setCovered(next);
            setError(null);
          }}
          before={before.map(nameOf)}
          after={covered.map(nameOf)}
        />
      ) : (
        <>
          <LocalTimeField
            label={kind === 'CHANGE_CLOCK_IN' ? 'New clock-in' : 'New clock-out'}
            value={value}
            onChange={(next) => {
              setValue(next);
              setError(null);
            }}
            timezone={timezone}
          />
          {local.ambiguous?.field === field && (
            <OccurrenceChoice
              occurrences={local.ambiguous.occurrences}
              value={local.chosen[field] ?? ''}
              onChange={(next) => local.choose(field, next)}
            />
          )}
        </>
      )}
      <ReasonField value={reason} onChange={setReason} />
    </FormDialog>
  );
}

/**
 * R4-A.4: which other assignments the entry also covers. The payroll owner never changes here;
 * coverage adds no minutes. The preview states the change before it is saved.
 */
function CoverageFields({
  id,
  ownerName,
  options,
  value,
  onChange,
  before,
  after,
}: {
  id: string;
  ownerName: string;
  options: CoverageOption[];
  value: string[];
  onChange(next: string[]): void;
  before: string[];
  after: string[];
}) {
  const list = (names: string[]) => (names.length > 0 ? names.join(', ') : 'none');
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">Also covers</legend>
        <p id={`${id}-hint`} className="text-xs text-slate-600">
          Paid under {ownerName}. Covered assignments record presence only; the time is counted
          once.
        </p>
        {options.length === 0 ? (
          <p className="text-sm text-slate-700">
            This employee has no other assignment in this timesheet.
          </p>
        ) : (
          options.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm text-slate-800">
              <input
                type="checkbox"
                className={checkboxClass}
                aria-describedby={`${id}-hint`}
                checked={value.includes(option.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...value, option.id]
                      : value.filter((item) => item !== option.id),
                  )
                }
              />
              {option.name}
            </label>
          ))
        )}
      </fieldset>
      <dl
        aria-label="Coverage change"
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-slate-50 p-3 text-sm"
      >
        <dt className="text-slate-600">Now covers</dt>
        <dd className="text-slate-900">{list(before)}</dd>
        <dt className="text-slate-600">After saving</dt>
        <dd className="text-slate-900">{list(after)}</dd>
      </dl>
    </>
  );
}

interface AddEntryTarget {
  employeeId: string;
  employeeName: string;
  timezone: string;
  assignments: Array<{ id: string; name: string }>;
  defaultDate: string;
}

export function AddEntryDialog({
  target,
  onClose,
  onDone,
}: {
  target: AddEntryTarget | null;
  onClose(): void;
  onDone(message: string): void;
}) {
  return target ? (
    <AddEntryForm
      key={`${target.employeeId}-${target.defaultDate}`}
      target={target}
      onClose={onClose}
      onDone={onDone}
    />
  ) : null;
}

function AddEntryForm({
  target,
  onClose,
  onDone,
}: {
  target: AddEntryTarget;
  onClose(): void;
  onDone(message: string): void;
}) {
  const [assignmentId, setAssignmentId] = useState(target.assignments[0]?.id ?? '');
  const [startAt, setStartAt] = useState(`${target.defaultDate}T09:00`);
  const [endAt, setEndAt] = useState(`${target.defaultDate}T17:00`);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = useLocalTimeSubmission();
  const assignmentField = useId();

  const needsChoice =
    local.ambiguous !== null &&
    !(local.chosen[local.ambiguous.field] ?? '').startsWith(
      local.ambiguous.field === 'startAt' ? startAt : endAt,
    );

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await timeApi.addEntry(target.employeeId, {
        employmentAssignmentId: assignmentId,
        startAt: local.resolved('startAt', startAt),
        endAt: local.resolved('endAt', endAt),
        reason: reason.trim(),
      });
      onDone('Missing time entry added.');
    } catch (cause) {
      setError(
        local.absorb(cause, { startAt, endAt })
          ? LOCAL_TIME_SELECT_OCCURRENCE
          : timeErrorMessage(cause, 'Unable to add this entry.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open
      title="Add missing time entry"
      description={`${target.employeeName}. Recorded with your reason.`}
      submitLabel="Add entry"
      busy={busy}
      canSubmit={
        assignmentId !== '' &&
        startAt !== '' &&
        endAt !== '' &&
        reason.trim() !== '' &&
        !needsChoice
      }
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <div>
        <label htmlFor={assignmentField} className="block text-sm font-medium text-slate-800">
          Assignment
        </label>
        <select
          id={assignmentField}
          value={assignmentId}
          onChange={(event) => setAssignmentId(event.target.value)}
          className={inputClass}
        >
          {target.assignments.map((assignment) => (
            <option key={assignment.id} value={assignment.id}>
              {assignment.name}
            </option>
          ))}
        </select>
      </div>
      <LocalTimeField
        label="Start"
        value={startAt}
        onChange={(next) => {
          setStartAt(next);
          setError(null);
        }}
        timezone={target.timezone}
      />
      {local.ambiguous?.field === 'startAt' && (
        <OccurrenceChoice
          occurrences={local.ambiguous.occurrences}
          value={local.chosen.startAt ?? ''}
          onChange={(next) => local.choose('startAt', next)}
        />
      )}
      <LocalTimeField
        label="End"
        value={endAt}
        onChange={(next) => {
          setEndAt(next);
          setError(null);
        }}
        timezone={target.timezone}
      />
      {local.ambiguous?.field === 'endAt' && (
        <OccurrenceChoice
          occurrences={local.ambiguous.occurrences}
          value={local.chosen.endAt ?? ''}
          onChange={(next) => local.choose('endAt', next)}
        />
      )}
      <ReasonField value={reason} onChange={setReason} />
    </FormDialog>
  );
}
