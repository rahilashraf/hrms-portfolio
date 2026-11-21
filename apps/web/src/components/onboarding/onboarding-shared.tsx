'use client';

import { checkboxClass } from '../ui/tokens';

import Link from 'next/link';
import { useState } from 'react';
import { onboardingApi } from '../../lib/onboarding/api';
import type {
  Progress,
  ReferenceType,
  SystemAction,
  TaskCategory,
  TaskOwnerType,
  TaskReference,
  TaskStatus,
  TemplateStatus,
  WorkflowEventType,
  WorkflowKind,
  WorkflowStatus,
  WorkflowTask,
} from '../../lib/onboarding/types';
import {
  Field,
  formatDateOnly,
  inputClass,
  isHttpsUrl,
  label,
  primaryButton,
  SafeLink,
  secondaryButton,
} from '../recruitment/recruitment-shared';

import { StatusBadge } from '../ui/status-badge';
import type { Tone } from '../ui/tokens';

export {
  dateTimeText,
  EmptyState,
  Field,
  formatDateOnly,
  inputClass,
  isHttpsUrl,
  label,
  primaryButton,
  SafeLink,
  secondaryButton,
  Section,
} from '../recruitment/recruitment-shared';

export type Run = (action: () => Promise<unknown>, message: string) => Promise<boolean>;

export const ONBOARDING_PERMISSION_KEYS = [
  'onboarding.read',
  'onboarding.manage',
  'offboarding.read',
  'offboarding.manage',
  'onboarding.template.manage',
] as const;

const badge = 'inline-flex rounded-full px-2.5 py-1 text-xs font-medium';

export const KIND_LABELS: Record<WorkflowKind, string> = {
  ONBOARDING: 'Onboarding',
  OFFBOARDING: 'Offboarding',
};

const KIND_STYLES: Record<WorkflowKind, string> = {
  ONBOARDING: 'bg-indigo-50 text-indigo-800',
  OFFBOARDING: 'bg-violet-50 text-violet-800',
};

export function KindBadge({ kind }: { kind: WorkflowKind }) {
  return <span className={`${badge} ${KIND_STYLES[kind]}`}>{KIND_LABELS[kind]}</span>;
}

/**
 * Batch 10E-1 — workflow, task and template statuses use the shared `StatusBadge` with a tone
 * per status (the words are always shown). An active workflow is in progress (not "done", as
 * ACTIVE means elsewhere); a waived task is a warning (done without being completed).
 */
const WORKFLOW_TONES: Record<WorkflowStatus, Tone> = {
  ACTIVE: 'info',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
};

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  return <StatusBadge status={status} label={label(status)} tone={WORKFLOW_TONES[status]} />;
}

const TASK_TONES: Record<TaskStatus, Tone> = {
  NOT_STARTED: 'neutral',
  IN_PROGRESS: 'info',
  COMPLETED: 'success',
  WAIVED: 'warning',
  CANCELLED: 'neutral',
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <StatusBadge status={status} label={label(status)} tone={TASK_TONES[status]} />;
}

const TEMPLATE_TONES: Record<TemplateStatus, Tone> = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  ARCHIVED: 'neutral',
};

export function TemplateStatusBadge({ status }: { status: TemplateStatus }) {
  return <StatusBadge status={status} label={label(status)} tone={TEMPLATE_TONES[status]} />;
}

export function OverdueBadge() {
  return <StatusBadge status="OVERDUE" label="Overdue" tone="danger" />;
}

export const CATEGORIES: TaskCategory[] = [
  'PAPERWORK',
  'POLICY',
  'ACCOUNT_ACCESS',
  'EQUIPMENT',
  'ORIENTATION',
  'TRAINING',
  'PAYROLL',
  'BENEFITS',
  'MEETING',
  'RECORDS',
  'OTHER',
];

export const OWNER_TYPE_LABELS: Record<TaskOwnerType, string> = {
  EMPLOYEE: 'Employee',
  MANAGER: 'Manager',
  HR: 'HR',
  SPECIFIC_USER: 'Specific user',
};

export const REFERENCE_TYPE_LABELS: Record<ReferenceType, string> = {
  EXTERNAL_URL: 'Link',
  GOOGLE_FORM: 'Google Form',
  GOOGLE_DOC: 'Google Doc',
  GOOGLE_DRIVE_FILE: 'Drive file',
  GOOGLE_DRIVE_FOLDER: 'Drive folder',
  INTERNAL_DOCUMENT: 'HRMS document',
  POLICY_DOCUMENT: 'HRMS policy',
  DOCUMENT_TYPE: 'Required document',
};

/** Phase 15 references name an HRMS record (a policy or a document type) by its id. */
export const isRecordReference = (type: ReferenceType | '' | null | undefined) =>
  type === 'POLICY_DOCUMENT' || type === 'DOCUMENT_TYPE';

export const SYSTEM_ACTION_LABELS: Record<SystemAction, string> = {
  NONE: 'None',
  PROVISION_HRMS_ACCOUNT: 'Provision HRMS account',
  DISABLE_HRMS_ACCOUNT: 'Disable HRMS account',
  PROVISION_EXTERNAL_ACCOUNT: 'Provision external account',
  DISABLE_EXTERNAL_ACCOUNT: 'Disable external account',
  REVOKE_BUILDING_ACCESS: 'Revoke building access',
  ISSUE_EQUIPMENT: 'Issue equipment',
  COLLECT_EQUIPMENT: 'Collect equipment',
};

export const EVENT_LABELS: Record<WorkflowEventType, string> = {
  STARTED: 'Workflow started',
  TASK_STARTED: 'Task started',
  TASK_COMPLETED: 'Task completed',
  TASK_ACKNOWLEDGED: 'Task acknowledged',
  TASK_WAIVED: 'Task waived',
  TASK_REOPENED: 'Task reopened',
  TASK_REASSIGNED: 'Task reassigned',
  TASK_DUE_DATE_CHANGED: 'Due date changed',
  TASK_CANCELLED: 'Task cancelled',
  COMPLETED: 'Workflow completed',
  REOPENED: 'Workflow reopened',
  CANCELLED: 'Workflow cancelled',
};

export function ProgressBar({ progress, name }: { progress: Progress; name: string }) {
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label={`${name} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        className="h-2 w-full overflow-hidden rounded-full bg-slate-100"
      >
        <div
          className="h-full rounded-full bg-indigo-600"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      <p className="text-xs text-slate-600">
        {progress.percent}% · {progress.done} of {progress.total} tasks done
        {progress.requiredTotal > 0 &&
          ` · ${progress.requiredDone} of ${progress.requiredTotal} required`}
        {progress.overdue > 0 && (
          <span className="text-rose-800"> · {progress.overdue} overdue</span>
        )}
      </p>
    </div>
  );
}

/** A task's reference: its type label, and a link only for https URLs. */
export function TaskReferenceLink({ reference }: { reference: TaskReference | null }) {
  if (!reference) return null;
  const typeLabel = REFERENCE_TYPE_LABELS[reference.type];
  const text = reference.label || typeLabel;
  if (isRecordReference(reference.type)) {
    return (
      <p className="text-sm text-slate-700">
        <span className="text-xs font-medium text-slate-500">{typeLabel}: </span>
        <span>{text}</span>
        {reference.type === 'DOCUMENT_TYPE' && (
          <>
            {' · '}
            <Link className="text-indigo-700 underline" href="/documents">
              Provide it in My documents
            </Link>
          </>
        )}
      </p>
    );
  }
  return (
    <p className="text-sm text-slate-700">
      <span className="text-xs font-medium text-slate-500">{typeLabel}: </span>
      {isHttpsUrl(reference.url) ? (
        <SafeLink href={reference.url}>{text}</SafeLink>
      ) : (
        <span>
          {text}
          {reference.externalId ? ` (${reference.externalId})` : ''}
        </span>
      )}
    </p>
  );
}

export function dueText(task: Pick<WorkflowTask, 'dueDate'>) {
  return task.dueDate ? `Due ${formatDateOnly(task.dueDate)}` : 'No due date';
}

/**
 * The work actions on a task offered by its `actions` flags: start, complete (with a note and
 * an evidence reference) and, for the employee's own acknowledgement tasks, acknowledging the
 * exact statement frozen on the task. The API re-checks every action.
 */
export function TaskWork({ task, busy, run }: { task: WorkflowTask; busy: boolean; run: Run }) {
  const [completing, setCompleting] = useState(false);
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState('');
  const [missingEvidence, setMissingEvidence] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const { actions } = task;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.canStart && (
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => void run(() => onboardingApi.startTask(task.id), 'Task started.')}
          >
            Start
          </button>
        )}
        {actions.canComplete && !completing && (
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => setCompleting(true)}
          >
            Complete
          </button>
        )}
      </div>
      {actions.canComplete && completing && (
        <form
          aria-label={`Complete ${task.title}`}
          className="grid grid-cols-1 gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const values = {
              note: note.trim() || null,
              evidenceReference: evidence.trim() || null,
            };
            if (task.evidenceRequired && !values.note && !values.evidenceReference) {
              setMissingEvidence(true);
              return;
            }
            setMissingEvidence(false);
            void run(() => onboardingApi.completeTask(task.id, values), 'Task completed.').then(
              (ok) => {
                if (ok) setCompleting(false);
              },
            );
          }}
        >
          <Field label="Completion note">
            <textarea
              className={inputClass}
              rows={2}
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
            />
          </Field>
          <Field label="Evidence reference">
            <input
              className={inputClass}
              value={evidence}
              onChange={(e) => setEvidence(e.currentTarget.value)}
            />
          </Field>
          {task.evidenceRequired && (
            <p className="text-xs text-slate-600 sm:col-span-2">
              This task needs a completion note or an evidence reference (for example a receipt
              number or a link to the signed document).
            </p>
          )}
          {missingEvidence && (
            <p role="alert" className="text-sm text-rose-800 sm:col-span-2">
              Add a completion note or an evidence reference.
            </p>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" className={primaryButton} disabled={busy}>
              Mark complete
            </button>
            <button type="button" className={secondaryButton} onClick={() => setCompleting(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {actions.canAcknowledge && (
        <form
          aria-label={`Acknowledge ${task.title}`}
          className="space-y-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!accepted) return;
            void run(() => onboardingApi.acknowledgeTask(task.id), 'Acknowledgement recorded.');
          }}
        >
          <p className="text-xs font-semibold uppercase text-indigo-800">Acknowledgement</p>
          <blockquote className="whitespace-pre-line text-sm text-slate-900">
            {task.acknowledgementStatement}
          </blockquote>
          <label className="flex items-start gap-2 text-sm text-slate-800">
            <input
              type="checkbox"
              required
              checked={accepted}
              onChange={(e) => setAccepted(e.currentTarget.checked)}
              className={`${checkboxClass} mt-0.5`}
            />
            I acknowledge the statement above.
          </label>
          <button type="submit" className={primaryButton} disabled={busy || !accepted}>
            Acknowledge
          </button>
        </form>
      )}
    </div>
  );
}

/** What was recorded when a task was finished. */
export function TaskOutcome({ task }: { task: WorkflowTask }) {
  if (task.status === 'COMPLETED') {
    return (
      <p className="text-xs text-slate-600">
        {task.acknowledgedAt ? 'Acknowledged' : 'Completed'}
        {task.completionSource === 'EXTERNAL' ? ' from an external submission' : ''}
        {task.completionNote ? ` · Note: ${task.completionNote}` : ''}
        {task.evidenceReference ? ` · Evidence: ${task.evidenceReference}` : ''}
      </p>
    );
  }
  if (task.status === 'WAIVED') {
    return (
      <p className="text-xs text-amber-800">
        Waived{task.waiverReason ? `: ${task.waiverReason}` : ''}
      </p>
    );
  }
  return null;
}
