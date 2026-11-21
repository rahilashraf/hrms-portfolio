import { BadRequestException } from '@nestjs/common';
import { addDays, domainError } from '../common/domain-support.js';
import type {
  EmployeeWorkflowKind,
  EmployeeWorkflowTaskStatus,
  WorkflowReferenceType,
  WorkflowTaskOwnerType,
} from '../generated/prisma/client.js';

/**
 * Phase 14 — pure onboarding / offboarding rules (no Nest services, no database). Each rule
 * mirrors, and fails before, the matching constraint or trigger of the phase14 migration.
 */

const CODE = /^[A-Z0-9_-]{2,64}$/;

/**
 * Security fix: the one answer for a task owner who is unknown, inactive or not connected to
 * the organization, so an id outside the organization reveals nothing about that account.
 */
export const TASK_OWNER_INVALID =
  'A task owner must be an active user of this organization.';

export function invalid(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new BadRequestException(domainError(400, code, message, extra));
}

export function parseWorkflowCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!CODE.test(code)) {
    invalid(
      'WORKFLOW_CODE_INVALID',
      'code must be 2–64 characters: letters, digits, "_" or "-" (e.g. "TEACHER-ONBOARDING").',
    );
  }
  return code;
}

export function parseText(
  value: unknown,
  field: string,
  options: { required?: boolean; max?: number } = {},
): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    if (options.required)
      invalid('WORKFLOW_TEXT_REQUIRED', `${field} is required.`);
    return null;
  }
  if (text.length > (options.max ?? 10_000)) {
    invalid('WORKFLOW_TEXT_TOO_LONG', `${field} is too long.`);
  }
  return text;
}

export function parseHttpsUrl(value: unknown, field: string): string | null {
  const text = parseText(value, field, { max: 2000 });
  if (text && !/^https:\/\/\S+$/i.test(text)) {
    invalid('WORKFLOW_URL_INVALID', `${field} must be an https URL.`);
  }
  return text;
}

// ─── Templates ───────────────────────────────────────────────────────────────

export interface TemplateTaskInput {
  /** The existing template task this entry is, when editing (see checkOwners). */
  id?: string;
  title: string;
  description?: string | null;
  category: string;
  ownerType: WorkflowTaskOwnerType;
  ownerUserId?: string | null;
  dueOffsetDays?: number;
  required?: boolean;
  evidenceRequired?: boolean;
  acknowledgementRequired?: boolean;
  acknowledgementStatement?: string | null;
  referenceType?: WorkflowReferenceType | null;
  referenceUrl?: string | null;
  referenceExternalId?: string | null;
  referenceLabel?: string | null;
  systemAction?: string;
}

/** A template task: owner rule, offsets and acknowledgement/reference shape. */
export function parseTemplateTask(input: TemplateTaskInput) {
  const dueOffsetDays = input.dueOffsetDays ?? 0;
  if (
    !Number.isInteger(dueOffsetDays) ||
    dueOffsetDays < -365 ||
    dueOffsetDays > 365
  ) {
    invalid(
      'WORKFLOW_OFFSET_INVALID',
      'dueOffsetDays is a whole number of days from -365 to 365.',
    );
  }
  if ((input.ownerType === 'SPECIFIC_USER') !== Boolean(input.ownerUserId)) {
    invalid(
      'WORKFLOW_OWNER_INVALID',
      'A specific-user task names its owner; other owner types never do.',
    );
  }
  const acknowledgementRequired = input.acknowledgementRequired ?? false;
  const statement = parseText(
    input.acknowledgementStatement,
    'acknowledgementStatement',
    {
      max: 4000,
    },
  );
  if (acknowledgementRequired !== Boolean(statement)) {
    invalid(
      'WORKFLOW_ACKNOWLEDGEMENT_INVALID',
      'An acknowledgement task states exactly what the employee acknowledges.',
    );
  }
  if (acknowledgementRequired && input.ownerType !== 'EMPLOYEE') {
    invalid(
      'WORKFLOW_ACKNOWLEDGEMENT_INVALID',
      'Only the employee acknowledges; an acknowledgement task belongs to the employee.',
    );
  }
  const referenceUrl = parseHttpsUrl(input.referenceUrl, 'referenceUrl');
  const referenceExternalId = parseText(
    input.referenceExternalId,
    'referenceExternalId',
    {
      max: 500,
    },
  );
  const referenceType = input.referenceType ?? null;
  if (Boolean(referenceType) !== Boolean(referenceUrl || referenceExternalId)) {
    invalid(
      'WORKFLOW_REFERENCE_INVALID',
      'A reference has a type and a link or resource id (and nothing without a type).',
    );
  }
  if (
    (referenceType === 'POLICY_DOCUMENT' ||
      referenceType === 'DOCUMENT_TYPE') &&
    !referenceExternalId
  ) {
    invalid(
      'WORKFLOW_REFERENCE_INVALID',
      'A policy or document-type reference names the HRMS record (referenceExternalId).',
    );
  }
  if (
    referenceType === 'DOCUMENT_TYPE' &&
    (input.ownerType !== 'EMPLOYEE' || acknowledgementRequired)
  ) {
    invalid(
      'WORKFLOW_REFERENCE_INVALID',
      'A required-document task belongs to the employee and is completed by providing it.',
    );
  }
  return {
    title: parseText(input.title, 'title', { required: true, max: 300 })!,
    description: parseText(input.description, 'description'),
    category: input.category,
    ownerType: input.ownerType,
    ownerUserId:
      input.ownerType === 'SPECIFIC_USER' ? input.ownerUserId! : null,
    dueOffsetDays,
    required: input.required ?? true,
    evidenceRequired: input.evidenceRequired ?? false,
    acknowledgementRequired,
    acknowledgementStatement: statement,
    referenceType,
    referenceUrl,
    referenceExternalId,
    referenceLabel: parseText(input.referenceLabel, 'referenceLabel', {
      max: 300,
    }),
    systemAction: input.systemAction ?? 'NONE',
  };
}

// ─── Workflows and tasks ─────────────────────────────────────────────────────

/** A task's due date: the workflow's anchor (start date or last day) plus the offset. */
export function dueDateOf(anchorDate: Date, dueOffsetDays: number): Date {
  return addDays(anchorDate, dueOffsetDays);
}

const TASK_TRANSITIONS: Record<
  EmployeeWorkflowTaskStatus,
  EmployeeWorkflowTaskStatus[]
> = {
  NOT_STARTED: ['IN_PROGRESS', 'COMPLETED', 'WAIVED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'WAIVED', 'CANCELLED'],
  COMPLETED: ['IN_PROGRESS'],
  WAIVED: ['IN_PROGRESS'],
  CANCELLED: [],
};

export function canMoveTask(
  from: EmployeeWorkflowTaskStatus,
  to: EmployeeWorkflowTaskStatus,
) {
  return TASK_TRANSITIONS[from].includes(to);
}

export const OPEN_TASK: EmployeeWorkflowTaskStatus[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
];
export const DONE_TASK: EmployeeWorkflowTaskStatus[] = ['COMPLETED', 'WAIVED'];

/** Overdue is date-derived: open and due before the organization's today. */
export function isOverdue(
  task: { status: EmployeeWorkflowTaskStatus; dueDate: Date | null },
  today: Date,
) {
  return (
    OPEN_TASK.includes(task.status) &&
    task.dueDate !== null &&
    task.dueDate < today
  );
}

export interface ProgressTask {
  status: EmployeeWorkflowTaskStatus;
  required: boolean;
  dueDate: Date | null;
}

/** Progress over non-cancelled tasks; the workflow is done when every task is done. */
export function progressOf(tasks: readonly ProgressTask[], today: Date) {
  const live = tasks.filter((task) => task.status !== 'CANCELLED');
  const done = live.filter((task) => DONE_TASK.includes(task.status)).length;
  const required = live.filter((task) => task.required);
  const requiredDone = required.filter((task) =>
    DONE_TASK.includes(task.status),
  ).length;
  return {
    total: live.length,
    done,
    percent: live.length === 0 ? 100 : Math.floor((done * 100) / live.length),
    requiredTotal: required.length,
    requiredDone,
    overdue: live.filter((task) => isOverdue(task, today)).length,
    allDone: done === live.length,
    requiredComplete: requiredDone === required.length,
  };
}

/** The permission family of a workflow kind (offboarding is more sensitive than onboarding). */
export function permissionFamily(kind: EmployeeWorkflowKind) {
  return kind === 'ONBOARDING' ? 'onboarding' : 'offboarding';
}

/**
 * What completing a task needs: acknowledgement tasks are the employee's own act; evidence
 * tasks need a note or a reference.
 */
export function assertCompletable(
  task: { acknowledgementRequired: boolean; evidenceRequired: boolean },
  completion: {
    note: string | null;
    evidenceReference: string | null;
    acknowledging: boolean;
  },
) {
  if (task.acknowledgementRequired && !completion.acknowledging) {
    invalid(
      'WORKFLOW_ACKNOWLEDGEMENT_REQUIRED',
      'This task is completed by the employee acknowledging it.',
    );
  }
  if (
    task.evidenceRequired &&
    !completion.note &&
    !completion.evidenceReference
  ) {
    invalid(
      'WORKFLOW_EVIDENCE_REQUIRED',
      'This task needs a completion note or an evidence reference.',
    );
  }
}
