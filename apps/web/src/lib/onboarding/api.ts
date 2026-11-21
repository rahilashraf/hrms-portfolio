import { apiRequest } from '../auth/api-client';
import type {
  CompletionOutcome,
  EmployeeWorkflowSummary,
  ExternalSubmission,
  ImportReferenceType,
  MyTask,
  OnboardingOption,
  OnboardingOptionKind,
  OnboardingOrganization,
  ReferenceType,
  StartFromHireResult,
  SystemAction,
  TaskCategory,
  TaskOwnerType,
  Template,
  WorkflowDashboard,
  WorkflowDetail,
  WorkflowKind,
} from './types';

const enc = encodeURIComponent;

function send<T>(method: 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<T> {
  return apiRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** `?organizationId=…` plus any defined filters. */
function query(organizationId: string, filters: Record<string, string | boolean | undefined> = {}) {
  const params = new URLSearchParams({ organizationId });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return `?${params.toString()}`;
}

export interface TemplateTaskInput {
  /** The existing template task this entry is, when editing (keeps an owner it already had). */
  id?: string;
  title: string;
  description?: string | null;
  category: TaskCategory;
  ownerType: TaskOwnerType;
  ownerUserId?: string | null;
  dueOffsetDays?: number;
  required?: boolean;
  evidenceRequired?: boolean;
  acknowledgementRequired?: boolean;
  acknowledgementStatement?: string | null;
  referenceType?: ReferenceType | null;
  referenceUrl?: string | null;
  referenceExternalId?: string | null;
  referenceLabel?: string | null;
  systemAction?: SystemAction;
}

export interface TemplateInput {
  organizationId: string;
  kind: WorkflowKind;
  code: string;
  name: string;
  description?: string | null;
  tasks: TemplateTaskInput[];
}

export interface TemplateUpdate {
  name?: string;
  description?: string | null;
  tasks?: TemplateTaskInput[];
}

export interface StartOnboardingInput {
  employmentAssignmentId: string;
  templateId?: string | null;
}

export interface StartOffboardingInput extends StartOnboardingInput {
  plannedEndDate: string;
  reason?: string | null;
}

export interface CompleteTaskInput {
  note?: string | null;
  evidenceReference?: string | null;
}

export const onboardingApi = {
  // ─── Organizations and self-service ───────────────────────────────────────
  organizations(): Promise<{ items: OnboardingOrganization[] }> {
    return apiRequest('/onboarding/organizations');
  },
  mine(): Promise<{ items: WorkflowDetail[] }> {
    return apiRequest('/onboarding/me');
  },
  myTasks(includeDone = false): Promise<{ items: MyTask[] }> {
    return apiRequest(`/onboarding/me/tasks${includeDone ? '?includeDone=true' : ''}`);
  },

  /** Batch 7A — picker options scoped to onboarding permissions (owners, assignments, hires). */
  options(
    organizationId: string,
    kind: OnboardingOptionKind,
    filters: {
      workflowKind?: WorkflowKind;
      search?: string;
      afterId?: string;
      limit?: number;
    } = {},
  ): Promise<{ items: OnboardingOption[]; nextAfterId: string | null }> {
    return apiRequest(
      `/onboarding/options${query(organizationId, {
        kind,
        workflowKind: filters.workflowKind,
        search: filters.search,
        afterId: filters.afterId,
        limit: filters.limit === undefined ? undefined : String(filters.limit),
      })}`,
    );
  },

  // ─── Templates ────────────────────────────────────────────────────────────
  templates(organizationId: string, kind?: WorkflowKind): Promise<{ items: Template[] }> {
    return apiRequest(`/onboarding/templates${query(organizationId, { kind })}`);
  },
  createTemplate(input: TemplateInput): Promise<Template> {
    return send('POST', '/onboarding/templates', input);
  },
  updateTemplate(templateId: string, input: TemplateUpdate): Promise<Template> {
    return send('PATCH', `/onboarding/templates/${enc(templateId)}`, input);
  },
  activateTemplate(templateId: string): Promise<Template> {
    return send('POST', `/onboarding/templates/${enc(templateId)}/activate`);
  },
  archiveTemplate(templateId: string): Promise<Template> {
    return send('POST', `/onboarding/templates/${enc(templateId)}/archive`);
  },
  setDefaultTemplate(templateId: string): Promise<Template> {
    return send('POST', `/onboarding/templates/${enc(templateId)}/default`);
  },

  // ─── Workflows ────────────────────────────────────────────────────────────
  dashboard(
    organizationId: string,
    kind: WorkflowKind,
    includeClosed = false,
  ): Promise<WorkflowDashboard> {
    return apiRequest(
      `/onboarding/workflows${query(organizationId, { kind, ...(includeClosed ? { includeClosed } : {}) })}`,
    );
  },
  employeeWorkflows(employeeId: string): Promise<{ items: EmployeeWorkflowSummary[] }> {
    return apiRequest(`/onboarding/employees/${enc(employeeId)}/workflows`);
  },
  startOnboarding(input: StartOnboardingInput): Promise<WorkflowDetail> {
    return send('POST', '/onboarding/workflows/onboarding', input);
  },
  startOffboarding(input: StartOffboardingInput): Promise<WorkflowDetail> {
    return send('POST', '/onboarding/workflows/offboarding', input);
  },
  startFromHire(hireId: string, templateId?: string | null): Promise<StartFromHireResult> {
    return send('POST', `/onboarding/from-hire/${enc(hireId)}`, templateId ? { templateId } : {});
  },
  workflow(workflowId: string): Promise<WorkflowDetail> {
    return apiRequest(`/onboarding/workflows/${enc(workflowId)}`);
  },
  cancelWorkflow(workflowId: string, reason: string): Promise<WorkflowDetail> {
    return send('POST', `/onboarding/workflows/${enc(workflowId)}/cancel`, { reason });
  },
  completeWorkflow(workflowId: string): Promise<WorkflowDetail> {
    return send('POST', `/onboarding/workflows/${enc(workflowId)}/complete`);
  },

  // ─── Tasks ────────────────────────────────────────────────────────────────
  startTask(taskId: string): Promise<WorkflowDetail> {
    return send('POST', `/onboarding/tasks/${enc(taskId)}/start`);
  },
  completeTask(taskId: string, input: CompleteTaskInput): Promise<WorkflowDetail> {
    return send('POST', `/onboarding/tasks/${enc(taskId)}/complete`, input);
  },
  acknowledgeTask(taskId: string): Promise<WorkflowDetail> {
    return send('POST', `/onboarding/tasks/${enc(taskId)}/acknowledge`, {
      statementAccepted: true,
    });
  },
  waiveTask(taskId: string, reason: string): Promise<WorkflowDetail> {
    return send('POST', `/onboarding/tasks/${enc(taskId)}/waive`, { reason });
  },
  reopenTask(taskId: string, reason: string): Promise<WorkflowDetail> {
    return send('POST', `/onboarding/tasks/${enc(taskId)}/reopen`, { reason });
  },
  reassignTask(taskId: string, ownerUserId: string | null): Promise<WorkflowDetail> {
    return send('PUT', `/onboarding/tasks/${enc(taskId)}/owner`, { ownerUserId });
  },
  setTaskDueDate(taskId: string, dueDate: string | null, reason: string): Promise<WorkflowDetail> {
    return send('PUT', `/onboarding/tasks/${enc(taskId)}/due-date`, { dueDate, reason });
  },

  // ─── External completions ─────────────────────────────────────────────────
  importCompletions(input: {
    organizationId: string;
    referenceType: ImportReferenceType;
    submissions: ExternalSubmission[] | unknown[];
  }): Promise<{ outcomes: CompletionOutcome[] }> {
    return send('POST', '/onboarding/task-completions/import', input);
  },
};
