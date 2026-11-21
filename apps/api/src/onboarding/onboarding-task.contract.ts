/**
 * Phase 14 — the consumer-side contract through which onboarding / offboarding tasks are
 * completed from systems outside the HRMS (an onboarding Google Form, a Code of Conduct form;
 * later other providers).
 *
 * Integrations never write workflow tables. A provider adapter (e.g. the shared Google
 * Workspace connector of a later phase) hands normalized submissions to
 * WorkflowTaskCompletionIngestion.completeFromSubmissions, which owns every rule:
 *
 * - Organization: only workflows of the given organization are considered.
 * - Identity: the respondent's email is matched to exactly one HRMS user whose employee has
 *   the workflow; anything ambiguous or unknown is reported, never guessed.
 * - Task: an open EMPLOYEE task of an active workflow whose reference is the submitted
 *   resource (e.g. referenceType GOOGLE_FORM with the form id). Acknowledgement tasks are
 *   never completed externally: acknowledging is the employee's own act in the HRMS.
 * - Deduplication: a submission completes a task once (externalCompletionId); re-delivery is a
 *   no-op.
 */

export interface ExternalTaskSubmission {
  /** The provider's resource id the task references (e.g. a Google Form id). */
  externalResourceId: string;
  /** The provider's response id (unique per resource). */
  externalResponseId: string;
  respondentEmail: string;
  /** ISO-8601 instant. */
  submittedAt: string;
}

export type TaskCompletionOutcomeKind =
  | 'COMPLETED'
  | 'UNCHANGED'
  | 'NO_MATCHING_EMPLOYEE'
  | 'NO_OPEN_TASK'
  | 'REJECTED';

export interface TaskCompletionOutcome {
  externalResponseId: string;
  outcome: TaskCompletionOutcomeKind;
  taskId?: string;
  reason?: string;
}

export const WORKFLOW_TASK_COMPLETION_INGESTION = Symbol(
  'WORKFLOW_TASK_COMPLETION_INGESTION',
);

export interface WorkflowTaskCompletionIngestion {
  completeFromSubmissions(
    organizationId: string,
    referenceType: 'GOOGLE_FORM' | 'GOOGLE_DOC' | 'EXTERNAL_URL',
    submissions: readonly ExternalTaskSubmission[],
    actorUserId: string | null,
  ): Promise<{ outcomes: TaskCompletionOutcome[] }>;
}
