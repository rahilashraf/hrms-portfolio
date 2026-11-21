'use client';

import { checkboxClass } from '../ui/tokens';

import { PageContainer } from '../ui/page-container';
import { useCallback, useEffect, useState } from 'react';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { onboardingApi } from '../../lib/onboarding/api';
import { onboardingErrorMessage } from '../../lib/onboarding/errors';
import type { MyTask, WorkflowDetail, WorkflowTask } from '../../lib/onboarding/types';
import {
  dueText,
  EmptyState,
  formatDateOnly,
  KIND_LABELS,
  KindBadge,
  label,
  OverdueBadge,
  ProgressBar,
  type Run,
  TaskOutcome,
  TaskReferenceLink,
  TaskStatusBadge,
  TaskWork,
  WorkflowStatusBadge,
} from './onboarding-shared';

/**
 * Self-service "My onboarding": the signed-in employee's own onboarding and offboarding
 * workflows (only their own tasks, never an offboarding reason), and the tasks assigned to them
 * in other people's workflows (a manager's or IT's checklist items).
 */
export function MyOnboardingPage() {
  const [workflows, setWorkflows] = useState<WorkflowDetail[]>([]);
  const [assigned, setAssigned] = useState<MyTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  // Batch 7A: assigned tasks already done are listed on request.
  const [includeDone, setIncludeDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const [mine, tasks] = await Promise.all([
        onboardingApi.mine(),
        onboardingApi.myTasks(includeDone),
      ]);
      setWorkflows(mine.items);
      setAssigned(tasks.items);
      setError(null);
    } catch (cause) {
      setError(onboardingErrorMessage(cause, 'Unable to load your onboarding.'));
    } finally {
      setLoading(false);
    }
  }, [includeDone]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const run: Run = async (action, message) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      await load();
      setVersion((v) => v + 1);
      setSuccess(message);
      return true;
    } catch (cause) {
      setError(onboardingErrorMessage(cause, 'Unable to update the task.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Self-service"
        title="My onboarding"
        description="Your onboarding and offboarding checklists, and tasks others' checklists assign to you."
      />
      <div className="mt-8 space-y-6">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {loading ? (
          <p role="status" className="text-sm text-slate-600">
            Loading onboarding…
          </p>
        ) : (
          <>
            {workflows.length === 0 ? (
              <EmptyState>You have no onboarding or offboarding checklist.</EmptyState>
            ) : (
              workflows.map((workflow) => (
                <MyWorkflow
                  key={`${workflow.id}-${version}`}
                  workflow={workflow}
                  busy={busy}
                  run={run}
                />
              ))
            )}
            <section
              aria-label="Tasks assigned to me"
              className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-slate-900">Tasks assigned to me</h2>
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={includeDone}
                    onChange={(event) => setIncludeDone(event.currentTarget.checked)}
                    className={checkboxClass}
                  />
                  Show completed tasks
                </label>
              </div>
              {assigned.length === 0 ? (
                <EmptyState>
                  {includeDone
                    ? 'No tasks are assigned to you.'
                    : 'No open tasks are assigned to you.'}
                </EmptyState>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {assigned.map((task) => (
                    <AssignedTask key={`${task.id}-${version}`} task={task} busy={busy} run={run} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </PageContainer>
  );
}

function MyWorkflow({
  workflow,
  busy,
  run,
}: {
  workflow: WorkflowDetail;
  busy: boolean;
  run: Run;
}) {
  const name = `My ${KIND_LABELS[workflow.kind].toLowerCase()}`;
  return (
    <section
      aria-label={`${name} — ${workflow.position.name}`}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-slate-900">
          {KIND_LABELS[workflow.kind]}: {workflow.position.name}
        </h2>
        <KindBadge kind={workflow.kind} />
        <WorkflowStatusBadge status={workflow.status} />
      </div>
      <p className="text-sm text-slate-600">
        {workflow.organization.name} ·{' '}
        {workflow.kind === 'ONBOARDING'
          ? `Starts ${formatDateOnly(workflow.anchorDate)}`
          : `Last day ${formatDateOnly(workflow.plannedEndDate)}`}
      </p>
      <ProgressBar progress={workflow.progress} name={name} />
      {workflow.tasks.length === 0 ? (
        <EmptyState>No tasks of this checklist are yours.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100">
          {workflow.tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              busy={busy}
              run={run}
              workflowActive={workflow.status === 'ACTIVE'}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TaskItem({
  task,
  busy,
  run,
  workflowActive,
}: {
  task: WorkflowTask;
  busy: boolean;
  run: Run;
  workflowActive: boolean;
}) {
  return (
    <li aria-label={`Task ${task.title}`} className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{task.title}</h3>
        <TaskStatusBadge status={task.status} />
        {task.overdue && <OverdueBadge />}
        {!task.required && <span className="text-xs text-slate-500">Optional</span>}
      </div>
      <p className="text-xs text-slate-500">
        {dueText(task)} · {label(task.category)}
      </p>
      {task.description && (
        <p className="whitespace-pre-line text-sm text-slate-700">{task.description}</p>
      )}
      <TaskReferenceLink reference={task.reference} />
      <TaskOutcome task={task} />
      <TaskWork task={task} busy={busy} run={run} />
      {selfCompletionOff(task, workflowActive) && (
        <p role="note" className="text-xs text-slate-600">
          Your organization has HR record this task for you: you cannot start or complete it here.
          Contact HR when it is done.
        </p>
      )}
    </li>
  );
}

/**
 * Batch 7A: with onboarding.employeeTaskCompletion off the API offers no start or complete on
 * the employee's own open tasks (acknowledgements stay theirs); say why instead of showing none.
 */
function selfCompletionOff(task: WorkflowTask, workflowActive: boolean) {
  const open = task.status === 'NOT_STARTED' || task.status === 'IN_PROGRESS';
  return (
    workflowActive &&
    open &&
    task.ownerType === 'EMPLOYEE' &&
    !task.acknowledgementRequired &&
    !task.actions.canStart &&
    !task.actions.canComplete
  );
}

function AssignedTask({ task, busy, run }: { task: MyTask; busy: boolean; run: Run }) {
  return (
    <li aria-label={`Assigned task ${task.title}`} className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{task.title}</h3>
        <TaskStatusBadge status={task.status} />
        {task.overdue && <OverdueBadge />}
      </div>
      <p className="text-xs text-slate-500">
        {task.workflow.employee.displayName ?? 'Employee'} · {KIND_LABELS[task.workflow.kind]} ·{' '}
        {task.workflow.organization.name} · {dueText(task)}
      </p>
      {task.description && (
        <p className="whitespace-pre-line text-sm text-slate-700">{task.description}</p>
      )}
      <TaskReferenceLink reference={task.reference} />
      <TaskWork task={task} busy={busy} run={run} />
    </li>
  );
}
