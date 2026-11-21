'use client';

import { checkboxClass } from '../ui/tokens';

import { ErrorState, LoadingState, TableScroll } from '../ui/states';
import { lifecycleSteps, Stepper } from '../ui/stepper';
import { PageHeader } from '../ui/page-header';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Forbidden } from '../auth/forbidden';
import { PageContainer } from '../ui/page-container';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { onboardingApi } from '../../lib/onboarding/api';
import { isOnboardingForbidden, onboardingErrorMessage } from '../../lib/onboarding/errors';
import type { CoreHrContext, WorkflowDetail, WorkflowTask } from '../../lib/onboarding/types';
import {
  dateTimeText,
  dueText,
  EmptyState,
  EVENT_LABELS,
  Field,
  formatDateOnly,
  inputClass,
  KIND_LABELS,
  KindBadge,
  label,
  REFERENCE_TYPE_LABELS,
  OverdueBadge,
  OWNER_TYPE_LABELS,
  primaryButton,
  ProgressBar,
  type Run,
  secondaryButton,
  Section,
  SYSTEM_ACTION_LABELS,
  TaskOutcome,
  TaskReferenceLink,
  TaskStatusBadge,
  TaskWork,
  WorkflowStatusBadge,
} from './onboarding-shared';
import { TaskOwnerPicker } from './onboarding-pickers';

const VIEW_LABELS: Record<WorkflowDetail['view'], string> = {
  HR: 'HR view',
  EMPLOYEE: 'Your checklist',
  TASK_OWNER: 'Your tasks',
};

/**
 * One onboarding or offboarding workflow, as the viewer may see it (decided by the API): HR
 * sees every task, the reason, Core HR's context and the event history; the employee and other
 * task owners see only their own tasks.
 */
export function WorkflowPage({ workflowId }: { workflowId: string }) {
  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      setWorkflow(await onboardingApi.workflow(workflowId));
      setError(null);
    } catch (cause) {
      setForbidden(isOnboardingForbidden(cause));
      setError(onboardingErrorMessage(cause, 'Unable to load the workflow.'));
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

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
      setError(onboardingErrorMessage(cause, 'Unable to save the change.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <PageContainer width="wide">
        <LoadingState label="Loading workflow…" />
      </PageContainer>
    );
  }
  if (forbidden) {
    return (
      <PageContainer width="wide" padded={false}>
        <Forbidden message="You do not have access to this workflow." />
      </PageContainer>
    );
  }
  if (!workflow) {
    return (
      <PageContainer width="wide">
        <ErrorState
          title="Workflow unavailable"
          message={error ?? 'Unable to load the workflow.'}
          onRetry={() => void load()}
        />
      </PageContainer>
    );
  }

  const hr = workflow.view === 'HR';
  const offboarding = workflow.kind === 'OFFBOARDING';

  return (
    <PageContainer width="wide" className="space-y-6">
      <div>
        <Link
          href={hr ? '/admin/onboarding' : '/onboarding'}
          className="text-sm font-medium text-indigo-700 hover:underline"
        >
          ← {hr ? 'Onboarding' : 'My onboarding'}
        </Link>
        <div className="mt-2">
          <PageHeader
            title={`${KIND_LABELS[workflow.kind]}: ${workflow.employee.displayName ?? 'Employee'}`}
            description={
              <>
                {workflow.position.name} · {workflow.organization.name} · Employee{' '}
                {workflow.employee.employeeNumber}
              </>
            }
          />
        </div>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="inline text-slate-500">Kind </dt>
            <dd className="inline">
              <KindBadge kind={workflow.kind} />
            </dd>
          </div>
          <div>
            <dt className="inline text-slate-500">Status </dt>
            <dd className="inline">
              <WorkflowStatusBadge status={workflow.status} />
            </dd>
          </div>
          <div>
            <dt className="inline text-slate-500">
              {offboarding ? 'Planned last day: ' : 'Start date: '}
            </dt>
            <dd className="inline">
              {formatDateOnly(offboarding ? workflow.plannedEndDate : workflow.anchorDate)}
            </dd>
          </div>
          <div>
            <dt className="inline text-slate-500">Template: </dt>
            <dd className="inline">
              {workflow.templateName}
              {workflow.templateCode ? ` (${workflow.templateCode})` : ''}
            </dd>
          </div>
          <div>
            <dt className="inline text-slate-500">View: </dt>
            <dd className="inline">{VIEW_LABELS[workflow.view]}</dd>
          </div>
        </dl>
        {hr && workflow.reason && (
          <p className="mt-2 text-sm text-slate-700">Reason: {workflow.reason}</p>
        )}
        {hr && workflow.cancellationReason && (
          <p className="mt-2 text-sm text-slate-700">Cancelled: {workflow.cancellationReason}</p>
        )}
        {hr && workflow.recruitmentHireId && (
          <p className="mt-2 text-xs text-slate-500">Started from a recruitment hire.</p>
        )}
      </div>
      <WorkflowOverview workflow={workflow} />
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}

      <Section id="progress" title="Progress">
        <ProgressBar progress={workflow.progress} name={KIND_LABELS[workflow.kind]} />
      </Section>

      {hr && workflow.coreHr && <CoreHrPanel coreHr={workflow.coreHr} offboarding={offboarding} />}

      <Section id="tasks" title="Tasks">
        {workflow.tasks.length === 0 ? (
          <EmptyState>No tasks.</EmptyState>
        ) : (
          // Batch 10E-1: a raw table in a named, keyboard-scrollable region (each row is a stateful
          // component with inline reassign / waive / reopen panels, not a DataTable row).
          <TableScroll label="Workflow tasks">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase text-slate-600">
                <tr>
                  {['Task', 'Owner', 'Due', 'Status', 'Actions'].map((heading) => (
                    <th key={heading} scope="col" className="px-4 py-2">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {workflow.tasks.map((task) => (
                  <TaskRow
                    key={`${task.id}-${version}`}
                    task={task}
                    organizationId={workflow.organization.id}
                    hr={hr}
                    busy={busy}
                    run={run}
                  />
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>

      <WorkflowDocuments tasks={workflow.tasks} />

      {hr && (workflow.actions.canCancel || workflow.actions.canComplete) && (
        <WorkflowActions key={version} workflow={workflow} busy={busy} run={run} />
      )}

      {hr && workflow.events && (
        <Section id="history" title="History">
          {workflow.events.length === 0 ? (
            <EmptyState>No events yet.</EmptyState>
          ) : (
            <ol className="space-y-2 text-sm">
              {workflow.events.map((event) => {
                const task = event.taskId
                  ? workflow.tasks.find((t) => t.id === event.taskId)
                  : undefined;
                return (
                  <li key={event.id} className="flex flex-wrap gap-x-3">
                    <span className="text-slate-500">{dateTimeText(event.createdAt)}</span>
                    <span className="text-slate-900">
                      {EVENT_LABELS[event.type]}
                      {task ? `: ${task.title}` : ''}
                      {event.fromStatus || event.toStatus
                        ? ` (${label(event.fromStatus)} → ${label(event.toStatus)})`
                        : ''}
                    </span>
                    {event.note && <span className="text-slate-600">{event.note}</span>}
                  </li>
                );
              })}
            </ol>
          )}
        </Section>
      )}
    </PageContainer>
  );
}

function CoreHrPanel({ coreHr, offboarding }: { coreHr: CoreHrContext; offboarding: boolean }) {
  return (
    <Section title="Core HR">
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        {(
          [
            ['Assignment status', label(coreHr.assignmentStatus)],
            ['Assignment start', formatDateOnly(coreHr.assignmentStartDate)],
            ['Assignment end', formatDateOnly(coreHr.assignmentEndDate)],
            ['Employee status', label(coreHr.employeeStatus)],
            ['Department', coreHr.department?.name ?? '—'],
            ['Team', coreHr.team?.name ?? '—'],
            ['Location', coreHr.workLocation?.name ?? '—'],
            ['Manager', coreHr.manager?.displayName ?? '—'],
          ] as const
        ).map(([term, value]) => (
          <div key={term}>
            <dt className="text-xs font-semibold uppercase text-slate-500">{term}</dt>
            <dd className="mt-1 text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>
      {offboarding && (
        <p
          role="note"
          className={
            coreHr.endDateRecorded
              ? 'rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900'
              : 'rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900'
          }
        >
          {coreHr.endDateRecorded
            ? 'Core HR has recorded the planned last day as the assignment end date.'
            : 'Core HR has not recorded the planned last day as the assignment end date yet.'}{' '}
          Offboarding never ends employment: end the assignment or terminate the employee in Core
          HR.
        </p>
      )}
    </Section>
  );
}

type Panel = 'waive' | 'reopen' | 'reassign' | 'due' | null;

/**
 * Batch 10F: the task table's cell padding, matching the shared DataTable (`px-4 py-2`). The task
 * table stays a raw table — a documented exception — because each row is a stateful component
 * with inline waive / reopen / reassign / due-date panels.
 */
const cell = 'px-4 py-2 text-slate-800';

function TaskRow({
  task,
  organizationId,
  hr,
  busy,
  run,
}: {
  task: WorkflowTask;
  organizationId: string;
  hr: boolean;
  busy: boolean;
  run: Run;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [reason, setReason] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [hrPool, setHrPool] = useState(false);
  // Batch 7A: "no owner" only where the API accepts it. A task's owner type never changes, so
  // an HR task returns to the HR pool and a manager task waits for HR (listed as unassigned);
  // a specific-user task always needs a person.
  const noOwnerLabel =
    task.ownerType === 'HR'
      ? 'Return to the HR pool'
      : task.ownerType === 'MANAGER'
        ? 'Remove the owner (HR handles it; listed as unassigned)'
        : null;
  const canClearOwner = noOwnerLabel !== null && task.owner !== null;
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');
  const { actions } = task;
  const canReassign = actions.canReassign && task.ownerType !== 'EMPLOYEE';
  const canChangeDue = hr && actions.canReassign;
  const toggle = (next: Panel) => {
    setPanel(panel === next ? null : next);
    setReason('');
  };
  const done = () => setPanel(null);
  return (
    <tr aria-label={`Task ${task.title}`}>
      {/* Batch 10E-1: the task names the row (a row header, as in the shared DataTable). */}
      <th scope="row" className={`${cell} text-left align-top font-normal`}>
        <span className="font-medium text-slate-900">{task.title}</span>
        <span className="block text-xs text-slate-500">
          {label(task.category)}
          {task.required ? ' · Required' : ' · Optional'}
          {task.evidenceRequired ? ' · Evidence required' : ''}
          {task.acknowledgementRequired ? ' · Acknowledgement' : ''}
          {task.systemAction !== 'NONE' ? ` · ${SYSTEM_ACTION_LABELS[task.systemAction]}` : ''}
          {task.reopenCount > 0 ? ` · Reopened ${task.reopenCount}×` : ''}
        </span>
        {task.description && (
          <span className="block whitespace-pre-line text-xs text-slate-600">
            {task.description}
          </span>
        )}
        <TaskReferenceLink reference={task.reference} />
        <TaskOutcome task={task} />
      </th>
      <td className={`${cell} align-top`}>
        {OWNER_TYPE_LABELS[task.ownerType]}
        <span className="block text-xs text-slate-500">
          {task.owner?.email ?? (task.ownerType === 'HR' ? 'HR pool' : 'Unassigned')}
        </span>
      </td>
      <td className={`${cell} align-top`}>
        {dueText(task)}
        {task.overdue && (
          <span className="block">
            <OverdueBadge />
          </span>
        )}
      </td>
      <td className={`${cell} align-top`}>
        <TaskStatusBadge status={task.status} />
      </td>
      <td className={`${cell} space-y-2 align-top`}>
        <TaskWork task={task} busy={busy} run={run} />
        <div className="flex flex-wrap gap-2">
          {actions.canWaive && (
            <button type="button" className={secondaryButton} onClick={() => toggle('waive')}>
              Waive
            </button>
          )}
          {actions.canReopen && (
            <button type="button" className={secondaryButton} onClick={() => toggle('reopen')}>
              Reopen
            </button>
          )}
          {canReassign && (
            <button type="button" className={secondaryButton} onClick={() => toggle('reassign')}>
              Reassign
            </button>
          )}
          {canChangeDue && (
            <button type="button" className={secondaryButton} onClick={() => toggle('due')}>
              Change due date
            </button>
          )}
        </div>
        {(panel === 'waive' || panel === 'reopen') && (
          <form
            aria-label={`${panel === 'waive' ? 'Waive' : 'Reopen'} ${task.title}`}
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const text = reason.trim();
              void run(
                () =>
                  panel === 'waive'
                    ? onboardingApi.waiveTask(task.id, text)
                    : onboardingApi.reopenTask(task.id, text),
                panel === 'waive' ? 'Task waived.' : 'Task reopened.',
              ).then((ok) => ok && done());
            }}
          >
            <Field label={panel === 'waive' ? 'Reason for waiving' : 'Reason for reopening'}>
              <input
                className={inputClass}
                required
                value={reason}
                onChange={(e) => setReason(e.currentTarget.value)}
              />
            </Field>
            <button type="submit" className={primaryButton} disabled={busy || !reason.trim()}>
              {panel === 'waive' ? 'Confirm waiver' : 'Confirm reopening'}
            </button>
          </form>
        )}
        {panel === 'reassign' && (
          <form
            aria-label={`Reassign ${task.title}`}
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  onboardingApi.reassignTask(
                    task.id,
                    hrPool && canClearOwner ? null : ownerUserId.trim(),
                  ),
                'Task reassigned.',
              ).then((ok) => ok && done());
            }}
          >
            <TaskOwnerPicker
              organizationId={organizationId}
              label="New owner"
              disabled={hrPool}
              required={!hrPool}
              value={ownerUserId}
              onChange={(id) => setOwnerUserId(id)}
            />
            {canClearOwner && (
              <label className="flex items-center gap-2 text-sm text-slate-800">
                <input
                  type="checkbox"
                  checked={hrPool}
                  onChange={(e) => setHrPool(e.currentTarget.checked)}
                  className={checkboxClass}
                />
                {noOwnerLabel}
              </label>
            )}
            <button
              type="submit"
              className={primaryButton}
              disabled={busy || (!hrPool && !ownerUserId.trim())}
            >
              Save owner
            </button>
          </form>
        )}
        {panel === 'due' && (
          <form
            aria-label={`Change due date of ${task.title}`}
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () => onboardingApi.setTaskDueDate(task.id, dueDate || null, reason.trim()),
                'Due date changed.',
              ).then((ok) => ok && done());
            }}
          >
            <Field label="Due date (empty for none)">
              <input
                className={inputClass}
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.currentTarget.value)}
              />
            </Field>
            <Field label="Reason for the change">
              <input
                className={inputClass}
                required
                value={reason}
                onChange={(e) => setReason(e.currentTarget.value)}
              />
            </Field>
            <button type="submit" className={primaryButton} disabled={busy || !reason.trim()}>
              Save due date
            </button>
          </form>
        )}
      </td>
    </tr>
  );
}

function WorkflowActions({
  workflow,
  busy,
  run,
}: {
  workflow: WorkflowDetail;
  busy: boolean;
  run: Run;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <Section title="Workflow">
      <p className="text-sm text-slate-600">
        Completing closes the workflow once its required tasks are done (open optional tasks are
        closed with it). Cancelling closes every open task.
      </p>
      <div className="flex flex-wrap gap-2">
        {workflow.actions.canComplete && (
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={() =>
              void run(() => onboardingApi.completeWorkflow(workflow.id), 'Workflow completed.')
            }
          >
            Complete workflow
          </button>
        )}
        {workflow.actions.canCancel && (
          <button
            type="button"
            className={secondaryButton}
            onClick={() => setCancelling(!cancelling)}
          >
            Cancel workflow
          </button>
        )}
      </div>
      {cancelling && (
        <form
          aria-label="Cancel workflow"
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () => onboardingApi.cancelWorkflow(workflow.id, reason.trim()),
              'Workflow cancelled.',
            );
          }}
        >
          <Field label="Reason for cancelling">
            <input
              className={inputClass}
              required
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
            />
          </Field>
          <button type="submit" className={secondaryButton} disabled={busy || !reason.trim()}>
            Confirm cancellation
          </button>
        </form>
      )}
    </Section>
  );
}

// ─── Workflow overview (status, sections) ───────────────────────────────────

/** The real WorkflowStatus lifecycle; CANCELLED is terminal and off this path. */
const WORKFLOW_LIFECYCLE = [
  { key: 'ACTIVE', label: 'In progress' },
  { key: 'COMPLETED', label: 'Completed' },
] as const;

function WorkflowOverview({ workflow }: { workflow: WorkflowDetail }) {
  const sections = [
    { href: '#progress', text: 'Progress' },
    { href: '#tasks', text: 'Tasks' },
    { href: '#documents', text: 'Documents' },
    ...(workflow.view === 'HR' && workflow.events ? [{ href: '#history', text: 'History' }] : []),
  ];
  return (
    <section
      aria-label="Workflow status"
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <Stepper
        label="Workflow progress"
        steps={lifecycleSteps<string>(WORKFLOW_LIFECYCLE, workflow.status, {
          completeAtEnd: true,
          reached: 'ACTIVE',
        })}
      />
      <nav aria-label="Workflow sections">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {sections.map((section) => (
            <li key={section.href}>
              <a href={section.href} className="text-indigo-700 hover:underline">
                {section.text}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
}

/** Tasks that carry a document or policy reference, or need an acknowledgement. */
export function documentTasks(tasks: readonly WorkflowTask[]): WorkflowTask[] {
  return tasks.filter((task) => task.reference !== null || task.acknowledgementRequired);
}

function WorkflowDocuments({ tasks }: { tasks: readonly WorkflowTask[] }) {
  const items = documentTasks(tasks);
  const done = items.filter((task) => task.status === 'COMPLETED' || task.status === 'WAIVED');
  return (
    <Section id="documents" title="Documents">
      {items.length === 0 ? (
        <EmptyState>No documents or acknowledgements are part of this workflow.</EmptyState>
      ) : (
        <>
          <p className="text-sm text-slate-700">
            {done.length} of {items.length} document and acknowledgement tasks done. Open each
            document from its task above.
          </p>
          <ul className="space-y-1 text-sm text-slate-800">
            {items.map((task) => (
              <li key={task.id}>
                {`${task.title} — ${task.reference ? REFERENCE_TYPE_LABELS[task.reference.type] : 'Acknowledgement'} · ${label(task.status)}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}
