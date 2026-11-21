'use client';

import { useMemo, useState } from 'react';
import { performanceApi, type GoalInput } from '../../../lib/performance/api';
import { performanceErrorMessage } from '../../../lib/performance/errors';
import { performanceOptionSource } from '../../../lib/performance/pickers';
import type { Goal } from '../../../lib/performance/types';
import { ConfirmButton } from '../../ui/confirm-button';
import { FormDialog } from '../../ui/form-dialog';
import { RecordCombobox } from '../../ui/record-combobox';
import {
  formatDateOnly,
  GoalStatusBadge,
  inputClass,
  secondaryButton,
} from '../performance-shared';
import { DataTable } from '../../ui/data-table';

/** Runs an action with the page's busy/success/error handling; resolves true on success. */
export type GoalRun = (action: () => Promise<unknown>, message: string) => Promise<boolean>;

const OPEN = ['NOT_STARTED', 'IN_PROGRESS'] as const;
export const goalIsOpen = (goal: Goal) => (OPEN as readonly string[]).includes(goal.status);

/**
 * Batch 7B (D5): who set a goal. The employee sees "Set by your manager" for a goal their
 * manager or HR set; others see the name.
 */
export function GoalProvenance({
  goal,
  viewerIsEmployee,
}: {
  goal: Goal;
  viewerIsEmployee: boolean;
}) {
  if (goal.setBy === 'MANAGER') {
    return (
      <span className="inline-flex rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800">
        {viewerIsEmployee
          ? `Set by your manager${goal.createdBy ? ` (${goal.createdBy.displayName})` : ''}`
          : `Set by ${goal.createdBy?.displayName ?? 'a manager'}`}
      </span>
    );
  }
  if (goal.setBy === 'EMPLOYEE') {
    return (
      <span className="text-xs text-slate-500">
        {viewerIsEmployee ? 'Set by you' : 'Set by the employee'}
      </span>
    );
  }
  return null;
}

interface GoalFields {
  title: string;
  description: string;
  measure: string;
  startDate: string;
  dueDate: string;
  progressPercent: string;
}

const fieldsOf = (goal: Goal | null): GoalFields => ({
  title: goal?.title ?? '',
  description: goal?.description ?? '',
  measure: goal?.measure ?? '',
  startDate: goal?.startDate ?? '',
  dueDate: goal?.dueDate ?? '',
  progressPercent:
    goal?.progressPercent === null || goal?.progressPercent === undefined
      ? ''
      : String(goal.progressPercent),
});

/**
 * Create or edit a goal in a dialog. Creating needs the assignment: fixed (`assignmentId`), or
 * picked through the performance options (`organizationId` + `employeeId`, HR and managers).
 */
export function GoalDialog({
  open,
  goal,
  assignmentId,
  pick,
  title,
  onClose,
  onSaved,
}: {
  open: boolean;
  goal: Goal | null;
  assignmentId?: string;
  pick?: { organizationId: string; employeeId: string };
  title: string;
  onClose(): void;
  onSaved(goal: Goal): Promise<void> | void;
}) {
  const [fields, setFields] = useState<GoalFields>(() => fieldsOf(goal));
  const [assignment, setAssignment] = useState(assignmentId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assignments = useMemo(
    () =>
      pick
        ? performanceOptionSource(pick.organizationId, 'assignment', {
            employeeId: pick.employeeId,
          })
        : null,
    [pick],
  );
  const set = (key: keyof GoalFields) => (value: string) =>
    setFields((current) => ({ ...current, [key]: value }));
  const progress = fields.progressPercent === '' ? null : Number(fields.progressPercent);
  const valid =
    fields.title.trim() !== '' &&
    fields.startDate !== '' &&
    (goal !== null || assignment !== '') &&
    (progress === null || (Number.isInteger(progress) && progress >= 0 && progress <= 100));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const values = {
        title: fields.title.trim(),
        description: fields.description.trim() || null,
        measure: fields.measure.trim() || null,
        startDate: fields.startDate,
        dueDate: fields.dueDate || null,
        progressPercent: progress,
      };
      const saved = goal
        ? await performanceApi.updateGoal(goal.id, {
            ...values,
            ...(progress && progress > 0 && goal.status === 'NOT_STARTED'
              ? { status: 'IN_PROGRESS' as const }
              : {}),
          })
        : await performanceApi.createGoal({
            employmentAssignmentId: assignment,
            ...values,
          } satisfies GoalInput);
      await onSaved(saved);
    } catch (cause) {
      setError(performanceErrorMessage(cause, 'Unable to save the goal.'));
    } finally {
      setBusy(false);
    }
  }

  const fieldId = (name: string) => `goal-${name}`;
  return (
    <FormDialog
      open={open}
      title={title}
      submitLabel={goal ? 'Save goal' : 'Set goal'}
      busy={busy}
      canSubmit={valid}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {!goal && assignments && (
          <div className="sm:col-span-2">
            <RecordCombobox
              label="Position"
              required
              source={assignments}
              value={assignment}
              onChange={(id) => setAssignment(id)}
              placeholder="Search the employee's positions"
              noResultsText="No position you may set goals on."
            />
          </div>
        )}
        <label
          className="text-sm font-medium text-slate-800 sm:col-span-2"
          htmlFor={fieldId('title')}
        >
          Goal
          <input
            id={fieldId('title')}
            className={inputClass}
            required
            value={fields.title}
            onChange={(e) => set('title')(e.currentTarget.value)}
          />
        </label>
        <label
          className="text-sm font-medium text-slate-800 sm:col-span-2"
          htmlFor={fieldId('description')}
        >
          Description
          <textarea
            id={fieldId('description')}
            className={inputClass}
            rows={2}
            value={fields.description}
            onChange={(e) => set('description')(e.currentTarget.value)}
          />
        </label>
        <label
          className="text-sm font-medium text-slate-800 sm:col-span-2"
          htmlFor={fieldId('measure')}
        >
          Measure of success
          <input
            id={fieldId('measure')}
            className={inputClass}
            value={fields.measure}
            onChange={(e) => set('measure')(e.currentTarget.value)}
          />
        </label>
        <label className="text-sm font-medium text-slate-800" htmlFor={fieldId('start')}>
          Start date
          <input
            id={fieldId('start')}
            type="date"
            required
            className={inputClass}
            value={fields.startDate}
            onChange={(e) => set('startDate')(e.currentTarget.value)}
          />
        </label>
        <label className="text-sm font-medium text-slate-800" htmlFor={fieldId('due')}>
          Due date
          <input
            id={fieldId('due')}
            type="date"
            className={inputClass}
            value={fields.dueDate}
            onChange={(e) => set('dueDate')(e.currentTarget.value)}
          />
        </label>
        <label className="text-sm font-medium text-slate-800" htmlFor={fieldId('progress')}>
          Progress (%)
          <input
            id={fieldId('progress')}
            type="number"
            min={0}
            max={100}
            className={inputClass}
            value={fields.progressPercent}
            onChange={(e) => set('progressPercent')(e.currentTarget.value)}
          />
        </label>
      </div>
    </FormDialog>
  );
}

/**
 * The actions on one goal. The employee edits their goals and updates progress; completing or
 * cancelling a goal their manager set is for the manager or HR (Batch 7B D5), so those actions
 * are not offered to them and the reason is said instead.
 */
export function GoalActions({
  goal,
  viewerIsEmployee,
  busy,
  run,
}: {
  goal: Goal;
  viewerIsEmployee: boolean;
  busy: boolean;
  run: GoalRun;
}) {
  const [editing, setEditing] = useState(false);
  if (!goalIsOpen(goal)) return null;
  const managerSet = viewerIsEmployee && goal.setBy === 'MANAGER';
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        className={secondaryButton}
        disabled={busy}
        aria-label={`Edit ${goal.title}`}
        onClick={() => setEditing(true)}
      >
        Edit
      </button>
      {managerSet ? (
        <span className="text-xs text-slate-600">
          Your manager or HR completes or cancels this goal.
        </span>
      ) : (
        <>
          <ConfirmButton
            className={secondaryButton}
            disabled={busy}
            aria-label={`Complete ${goal.title}`}
            confirm={{
              title: `Complete “${goal.title}”?`,
              description:
                'A completed goal is frozen: it can no longer be edited, reopened or cancelled.',
              confirmLabel: 'Complete goal',
              reason: { label: 'Completion notes', required: false },
            }}
            onConfirm={(notes) =>
              void run(
                () =>
                  performanceApi.updateGoal(goal.id, {
                    status: 'COMPLETED',
                    completionNotes: notes.trim() || null,
                  }),
                'Goal completed.',
              )
            }
          >
            Complete
          </ConfirmButton>
          <ConfirmButton
            className={secondaryButton}
            disabled={busy}
            aria-label={`Cancel ${goal.title}`}
            confirm={{
              title: `Cancel “${goal.title}”?`,
              description: 'A cancelled goal is frozen and kept in the history with its reason.',
              confirmLabel: 'Cancel goal',
              destructive: true,
              reason: { label: 'Why is the goal cancelled?', required: true },
            }}
            onConfirm={(reason) =>
              void run(
                () =>
                  performanceApi.updateGoal(goal.id, {
                    status: 'CANCELLED',
                    cancellationReason: reason.trim(),
                  }),
                'Goal cancelled.',
              )
            }
          >
            Cancel goal
          </ConfirmButton>
        </>
      )}
      {editing && (
        <GoalDialog
          open
          goal={goal}
          title={`Edit “${goal.title}”`}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await run(async () => undefined, 'Goal saved.');
          }}
        />
      )}
    </div>
  );
}

/** A goals table with provenance and (when `run` is given) the goal actions. */
export function GoalsTable({
  goals,
  viewerIsEmployee,
  busy = false,
  run,
  label,
}: {
  goals: Goal[];
  viewerIsEmployee: boolean;
  busy?: boolean;
  run?: GoalRun;
  label: string;
}) {
  return (
    <DataTable
      label={label}
      rows={goals}
      rowKey={(goal) => goal.id}
      columns={[
        {
          key: 'goal',
          header: 'Goal',
          rowHeader: true,
          cell: (goal) => (
            <>
              <span className="font-medium">{goal.title}</span>
              <span className="mt-0.5 block">
                <GoalProvenance goal={goal} viewerIsEmployee={viewerIsEmployee} />
              </span>
              {goal.measure && (
                <span className="block text-xs font-normal text-slate-500">{goal.measure}</span>
              )}
              {goal.status === 'CANCELLED' && goal.cancellationReason && (
                <span className="block text-xs font-normal text-slate-500">
                  Cancelled: {goal.cancellationReason}
                </span>
              )}
              {goal.status === 'COMPLETED' && goal.completionNotes && (
                <span className="block text-xs font-normal text-slate-500">
                  {goal.completionNotes}
                </span>
              )}
            </>
          ),
        },
        {
          key: 'position',
          header: 'Position',
          cell: (goal) => <>{goal.positionName ?? '—'}</>,
        },
        {
          key: 'due',
          header: 'Due',
          cell: (goal) => <>{goal.dueDate ? formatDateOnly(goal.dueDate) : '—'}</>,
        },
        {
          key: 'status',
          header: 'Status',
          cell: (goal) => (
            <>
              <GoalStatusBadge status={goal.status} />
            </>
          ),
        },
        {
          key: 'progress',
          header: 'Progress',
          cell: (goal) => <>{goal.progressPercent ?? 0}%</>,
        },
        // The actions column only where goals can be acted on (as before).
        ...(run
          ? [
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                cell: (goal: Goal) => (
                  <GoalActions
                    goal={goal}
                    viewerIsEmployee={viewerIsEmployee}
                    busy={busy}
                    run={run}
                  />
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
