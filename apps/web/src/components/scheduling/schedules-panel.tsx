'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { buttonClass } from '../ui/button';
import { ErrorState } from '../ui/states';
import { useConfirm } from '../ui/use-confirm';
import { schedulingApi } from '../../lib/scheduling/api';
import {
  publicationProblems,
  schedulingErrorCode,
  schedulingErrorMessage,
  type PublicationProblem,
} from '../../lib/scheduling/errors';
import type {
  GridShift,
  Schedule,
  ScheduleScopeType,
  ScheduleType,
} from '../../lib/scheduling/types';
import { formatDay } from '../../lib/scheduling/time';
import {
  Feedback,
  Field,
  Panel,
  SCHEDULE_PERMISSIONS,
  ScheduleStatusBadge,
  ScopeFields,
  inputClass,
  scopeLabel,
  scopePayload,
  type SchedulingContext,
  type Structure,
} from './scheduling-shared';

const PUBLICATION_MESSAGES: Record<string, string> = {
  SCHEDULE_PUBLICATION_EMPTY: 'The schedule has no shifts to publish.',
  SCHEDULE_PUBLICATION_INVALID: 'Some shifts are no longer valid. Fix them before publishing.',
  SCHEDULE_CONFLICT_ERROR: 'Some shifts have blocking conflicts. Change them before publishing.',
  SCHEDULE_CONFLICT_OVERRIDE_REQUIRED:
    'Some shifts have conflicts without an override. Edit those shifts and give override reasons, or change them.',
};

/**
 * The schedules overlapping the calendar range: create, edit and delete drafts, publish
 * (one-way: a published schedule cannot be unpublished), and start adding shifts.
 */
export function SchedulesPanel({
  context,
  structure,
  range,
  shifts,
  reloadKey,
  onAddShift,
  onChanged,
}: {
  context: SchedulingContext;
  structure: Structure;
  range: { from: string; to: string };
  shifts: GridShift[];
  reloadKey: number;
  onAddShift(schedule: Schedule): void;
  onChanged(message: string): void;
}) {
  const organizationId = context.organization.id;
  const canManage = context.can(SCHEDULE_PERMISSIONS.manage);
  const canPublish = canManage && context.can(SCHEDULE_PERMISSIONS.publish);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [problems, setProblems] = useState<{
    schedule: Schedule;
    items: PublicationProblem[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    const all: Schedule[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await schedulingApi.listSchedules({
        organizationId,
        from: range.from,
        to: range.to,
        limit: 100,
        afterId,
      });
      all.push(...result.items);
      if (!result.nextAfterId) break;
      afterId = result.nextAfterId;
    }
    return all.sort(
      (a, b) => a.periodStart.localeCompare(b.periodStart) || a.name.localeCompare(b.name),
    );
  }, [organizationId, range.from, range.to]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      load()
        .then((items) => {
          if (!active) return;
          setLoadError(null);
          setSchedules(items);
        })
        .catch((cause) => {
          if (active) setLoadError(schedulingErrorMessage(cause, 'Schedules could not be loaded.'));
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, reloadKey, retryKey]);

  function retry() {
    setLoadError(null);
    setSchedules(null);
    setRetryKey((key) => key + 1);
  }

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged(message);
      return true;
    } catch (cause) {
      setError(schedulingErrorMessage(cause, 'The schedule could not be updated.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(schedule: Schedule) {
    if (
      !(await confirm({
        title: `Delete “${schedule.name}”?`,
        description: 'Only an empty draft schedule can be deleted. This cannot be undone.',
        confirmLabel: 'Delete schedule',
      }))
    )
      return;
    await run(() => schedulingApi.deleteSchedule(schedule.id), 'Draft schedule deleted.');
  }

  async function publish(schedule: Schedule) {
    const count = shifts.filter((shift) => shift.scheduleId === schedule.id).length;
    if (
      !(await confirm({
        title: `Publish “${schedule.name}”?`,
        description: `Publishing makes its shifts visible to employees and usable for attendance. It cannot be undone: later changes are recorded as corrections with a reason. ${
          count > 0 ? `${count} shift(s) are visible in the current calendar range.` : ''
        }`,
        confirmLabel: 'Publish',
        destructive: false,
      }))
    )
      return;
    setBusy(true);
    setError(null);
    setProblems(null);
    try {
      await schedulingApi.publishSchedule(schedule.id);
      onChanged(`“${schedule.name}” published.`);
    } catch (cause) {
      const code = schedulingErrorCode(cause);
      setError(
        (code && PUBLICATION_MESSAGES[code]) ??
          schedulingErrorMessage(cause, 'The schedule could not be published.'),
      );
      const items = publicationProblems(cause);
      if (items.length > 0) setProblems({ schedule, items });
    } finally {
      setBusy(false);
    }
  }

  const shiftLabel = (id: string) => {
    const shift = shifts.find((item) => item.id === id);
    return shift
      ? `${shift.employee.displayName ?? shift.employee.employeeNumber}, ${formatDay(shift.workDate)}`
      : `Shift ${id.slice(0, 8)}`;
  };

  return (
    <Panel
      title="Schedules in this range"
      actions={
        canManage && editing !== 'new' ? (
          <button
            type="button"
            className={buttonClass('primary', 'sm')}
            onClick={() => setEditing('new')}
          >
            New schedule
          </button>
        ) : null
      }
    >
      {confirmDialog}
      <div className="space-y-3">
        <Feedback error={error} success={null} />
        {problems && (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-950"
          >
            <p className="font-semibold">Publication of “{problems.schedule.name}” was refused:</p>
            <ul className="mt-1 list-disc pl-5">
              {problems.items.map((item, index) => (
                <li key={`${item.shiftId}-${index}`}>
                  {shiftLabel(item.shiftId)}: {item.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {editing && (
          <ScheduleForm
            key={editing === 'new' ? 'new' : editing.id}
            organizationId={organizationId}
            structure={structure}
            schedule={editing === 'new' ? null : editing}
            defaults={range}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSubmit={async (input) => {
              const ok =
                editing === 'new'
                  ? await run(() => schedulingApi.createSchedule(input), 'Draft schedule created.')
                  : await run(
                      () =>
                        schedulingApi.updateSchedule(editing.id, {
                          scopeType: input.scopeType,
                          organizationalUnitId: input.organizationalUnitId,
                          departmentId: input.departmentId,
                          teamId: input.teamId,
                          name: input.name,
                          periodStart: input.periodStart,
                          periodEnd: input.periodEnd,
                          type: input.type,
                        }),
                      'Draft schedule updated.',
                    );
              if (ok) setEditing(null);
            }}
          />
        )}
        {loadError ? (
          <ErrorState title="Schedules could not be loaded" message={loadError} onRetry={retry} />
        ) : schedules === null ? (
          <p role="status" className="text-sm text-slate-600">
            Loading schedules…
          </p>
        ) : schedules.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
            No schedules overlap this range.
            {canManage && ' Create a draft schedule to start adding shifts.'}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {schedules.map((schedule) => {
              const draft = schedule.status === 'DRAFT';
              return (
                <li
                  key={schedule.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-slate-900">
                      {schedule.name} <ScheduleStatusBadge status={schedule.status} />
                      {schedule.type === 'AD_HOC' && (
                        <span className="text-xs font-normal text-slate-500">Ad hoc</span>
                      )}
                    </p>
                    <p className="text-sm text-slate-600">
                      {formatDay(schedule.periodStart)} – {formatDay(schedule.periodEnd)} ·{' '}
                      {scopeLabel(structure, schedule)}
                      {schedule.publishedAt &&
                        ` · published ${new Date(schedule.publishedAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(draft ? canManage : canPublish) && (
                      <button
                        type="button"
                        className={buttonClass('secondary', 'sm')}
                        onClick={() => onAddShift(schedule)}
                      >
                        Add shift
                      </button>
                    )}
                    {draft && canManage && (
                      <>
                        <button
                          type="button"
                          className={buttonClass('ghost', 'sm')}
                          onClick={() => setEditing(schedule)}
                        >
                          Edit <span className="sr-only">{schedule.name}</span>
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          className={buttonClass('ghost', 'sm')}
                          onClick={() => void remove(schedule)}
                        >
                          Delete <span className="sr-only">{schedule.name}</span>
                        </button>
                      </>
                    )}
                    {draft && canPublish && (
                      <button
                        type="button"
                        disabled={busy}
                        className={buttonClass('primary', 'sm')}
                        onClick={() => void publish(schedule)}
                      >
                        Publish <span className="sr-only">{schedule.name}</span>
                      </button>
                    )}
                    {context.can('audit.read') && (
                      <Link
                        className={buttonClass('ghost', 'sm')}
                        href={`/admin/audit?organizationId=${encodeURIComponent(organizationId)}&entityType=Schedule&entityId=${encodeURIComponent(schedule.id)}`}
                      >
                        Audit
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function ScheduleForm({
  organizationId,
  structure,
  schedule,
  defaults,
  busy,
  onCancel,
  onSubmit,
}: {
  organizationId: string;
  structure: Structure;
  schedule: Schedule | null;
  defaults: { from: string; to: string };
  busy: boolean;
  onCancel(): void;
  onSubmit(input: Parameters<typeof schedulingApi.createSchedule>[0]): void;
}) {
  const [scope, setScope] = useState<{ scopeType: ScheduleScopeType; targetId: string }>({
    scopeType: schedule?.scopeType ?? 'ORGANIZATION',
    targetId: schedule?.organizationalUnitId ?? schedule?.departmentId ?? schedule?.teamId ?? '',
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    onSubmit({
      organizationId,
      ...scopePayload(scope.scopeType, scope.targetId),
      name: text('name'),
      periodStart: text('periodStart'),
      periodEnd: text('periodEnd'),
      type: text('type') as ScheduleType,
    });
  }

  return (
    <form
      onSubmit={submit}
      aria-label={schedule ? 'Edit schedule' : 'New schedule'}
      className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3"
    >
      <Field label="Name">
        <input
          name="name"
          className={inputClass}
          required
          maxLength={200}
          defaultValue={schedule?.name ?? ''}
        />
      </Field>
      <Field label="Starts">
        <input
          name="periodStart"
          type="date"
          className={inputClass}
          required
          defaultValue={schedule?.periodStart ?? defaults.from}
        />
      </Field>
      <Field label="Ends">
        <input
          name="periodEnd"
          type="date"
          className={inputClass}
          required
          defaultValue={schedule?.periodEnd ?? defaults.to}
        />
      </Field>
      <ScopeFields
        structure={structure}
        scopeType={scope.scopeType}
        targetId={scope.targetId}
        onChange={setScope}
      />
      <Field label="Type">
        <select name="type" className={inputClass} defaultValue={schedule?.type ?? 'STANDARD'}>
          <option value="STANDARD">Standard</option>
          <option value="AD_HOC">Ad hoc</option>
        </select>
      </Field>
      <p className="text-xs text-slate-500 sm:col-span-3">
        New schedules start as drafts: employees only see shifts once the schedule is published.
      </p>
      <div className="flex gap-2 sm:col-span-3">
        <button type="submit" disabled={busy} className={buttonClass('primary', 'sm')}>
          {schedule ? 'Save schedule' : 'Create draft'}
        </button>
        <button type="button" className={buttonClass('ghost', 'sm')} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
