/** Phase 14 Onboarding & Offboarding read and write models (mirror the API). */

export type WorkflowKind = 'ONBOARDING' | 'OFFBOARDING';
export type TemplateStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type WorkflowStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type TaskStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'WAIVED' | 'CANCELLED';
export type TaskCategory =
  | 'PAPERWORK'
  | 'POLICY'
  | 'ACCOUNT_ACCESS'
  | 'EQUIPMENT'
  | 'ORIENTATION'
  | 'TRAINING'
  | 'PAYROLL'
  | 'BENEFITS'
  | 'MEETING'
  | 'RECORDS'
  | 'OTHER';
export type TaskOwnerType = 'EMPLOYEE' | 'MANAGER' | 'HR' | 'SPECIFIC_USER';
export type ReferenceType =
  | 'EXTERNAL_URL'
  | 'GOOGLE_FORM'
  | 'GOOGLE_DOC'
  | 'GOOGLE_DRIVE_FILE'
  | 'GOOGLE_DRIVE_FOLDER'
  | 'INTERNAL_DOCUMENT'
  | 'POLICY_DOCUMENT'
  | 'DOCUMENT_TYPE';
export type SystemAction =
  | 'NONE'
  | 'PROVISION_HRMS_ACCOUNT'
  | 'DISABLE_HRMS_ACCOUNT'
  | 'PROVISION_EXTERNAL_ACCOUNT'
  | 'DISABLE_EXTERNAL_ACCOUNT'
  | 'REVOKE_BUILDING_ACCESS'
  | 'ISSUE_EQUIPMENT'
  | 'COLLECT_EQUIPMENT';
export type CompletionSource = 'MANUAL' | 'EXTERNAL';
export type WorkflowView = 'HR' | 'EMPLOYEE' | 'TASK_OWNER';
export type WorkflowEventType =
  | 'STARTED'
  | 'TASK_STARTED'
  | 'TASK_COMPLETED'
  | 'TASK_ACKNOWLEDGED'
  | 'TASK_WAIVED'
  | 'TASK_REOPENED'
  | 'TASK_REASSIGNED'
  | 'TASK_DUE_DATE_CHANGED'
  | 'TASK_CANCELLED'
  | 'COMPLETED'
  | 'REOPENED'
  | 'CANCELLED';
export type ImportReferenceType = 'GOOGLE_FORM' | 'GOOGLE_DOC' | 'EXTERNAL_URL';
export type CompletionOutcomeKind =
  'COMPLETED' | 'UNCHANGED' | 'NO_MATCHING_EMPLOYEE' | 'NO_OPEN_TASK' | 'REJECTED';

export interface OnboardingOrganization {
  id: string;
  name: string;
  code: string;
  timezone: string | null;
  actions: {
    canManageTemplates: boolean;
    onboarding: boolean;
    offboarding: boolean;
    /** Batch 7A: organization-level manage of the kind (what importing completions needs). */
    canImportOnboarding?: boolean;
    canImportOffboarding?: boolean;
  };
}

export interface TemplateTask {
  id: string;
  sortOrder: number;
  title: string;
  description: string | null;
  category: TaskCategory;
  ownerType: TaskOwnerType;
  ownerUserId: string | null;
  dueOffsetDays: number;
  required: boolean;
  evidenceRequired: boolean;
  acknowledgementRequired: boolean;
  acknowledgementStatement: string | null;
  referenceType: ReferenceType | null;
  referenceUrl: string | null;
  referenceExternalId: string | null;
  referenceLabel: string | null;
  systemAction: SystemAction;
}

export interface Template {
  id: string;
  organizationId: string;
  kind: WorkflowKind;
  code: string;
  name: string;
  description: string | null;
  status: TemplateStatus;
  isDefault: boolean;
  workflowCount: number;
  activatedAt: string | null;
  archivedAt: string | null;
  tasks: TemplateTask[];
}

export interface Progress {
  total: number;
  done: number;
  percent: number;
  requiredTotal: number;
  requiredDone: number;
  overdue: number;
  allDone: boolean;
  requiredComplete: boolean;
}

export interface TaskActions {
  canStart: boolean;
  canComplete: boolean;
  canAcknowledge: boolean;
  canWaive: boolean;
  canReopen: boolean;
  canReassign: boolean;
}

export interface TaskReference {
  type: ReferenceType;
  url: string | null;
  externalId: string | null;
  label: string | null;
}

export interface WorkflowTask {
  id: string;
  workflowId: string;
  sortOrder: number;
  title: string;
  description: string | null;
  category: TaskCategory;
  ownerType: TaskOwnerType;
  owner: { userId: string; email: string } | null;
  dueDate: string | null;
  overdue: boolean;
  required: boolean;
  evidenceRequired: boolean;
  acknowledgementRequired: boolean;
  acknowledgementStatement: string | null;
  reference: TaskReference | null;
  systemAction: SystemAction;
  status: TaskStatus;
  startedAt: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  completionNote: string | null;
  evidenceReference: string | null;
  completionSource: CompletionSource | null;
  acknowledgedAt: string | null;
  waivedAt: string | null;
  waiverReason: string | null;
  reopenCount: number;
  actions: TaskActions;
}

export interface WorkflowEvent {
  id: string;
  taskId: string | null;
  type: WorkflowEventType;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  actorUserId: string | null;
  createdAt: string;
}

export interface NamedRef {
  id: string;
  name: string;
}

export interface CoreHrContext {
  assignmentStatus: string;
  assignmentStartDate: string | null;
  assignmentEndDate: string | null;
  employeeStatus: string;
  department: NamedRef | null;
  team: NamedRef | null;
  workLocation: NamedRef | null;
  manager: { assignmentId: string; displayName: string | null } | null;
  /** Offboarding: whether Core HR has recorded the planned last day as the assignment end. */
  endDateRecorded: boolean | null;
}

export interface WorkflowDetail {
  id: string;
  view: WorkflowView;
  kind: WorkflowKind;
  status: WorkflowStatus;
  templateName: string;
  anchorDate: string | null;
  plannedEndDate: string | null;
  startedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  organization: NamedRef;
  employee: { id: string; employeeNumber: string; displayName: string | null };
  position: NamedRef;
  progress: Progress;
  tasks: WorkflowTask[];
  actions: { canManage: boolean; canCancel: boolean; canComplete: boolean };
  /** HR view only. */
  templateCode?: string;
  reason?: string | null;
  recruitmentHireId?: string | null;
  cancellationReason?: string | null;
  coreHr?: CoreHrContext;
  events?: WorkflowEvent[];
}

export interface StartFromHireResult extends WorkflowDetail {
  created: boolean;
  /** Batch 7A: a new onboarding started because the hire's earlier one was cancelled. */
  restartedFromWorkflowId?: string;
}

/** Batch 7A — GET /onboarding/options. */
export type OnboardingOptionKind = 'owner' | 'assignment' | 'hire';
export interface OnboardingOption {
  id: string;
  label: string;
  description?: string;
  employeeId?: string;
  /** `hire`: its earlier onboarding was cancelled; starting again begins a new one. */
  restartable?: boolean;
}

export interface MyTask extends WorkflowTask {
  workflow: {
    id: string;
    kind: WorkflowKind;
    status: WorkflowStatus;
    anchorDate: string | null;
    organization: NamedRef;
    employee: { id: string; displayName: string | null };
  };
}

export interface DashboardItem {
  id: string;
  status: WorkflowStatus;
  templateName: string;
  anchorDate: string | null;
  plannedEndDate: string | null;
  employee: { id: string; employeeNumber: string; displayName: string | null };
  position: NamedRef;
  assignmentStatus: string;
  assignmentEndDate: string | null;
  progress: Progress;
}

export interface WorkflowDashboard {
  today: string;
  kind: WorkflowKind;
  items: DashboardItem[];
  /** Batch 7A: more workflows are within the caller's scope than the dashboard lists. */
  truncated?: boolean;
  attention: {
    overdueTasks: Array<{
      workflowId: string;
      taskId: string;
      title: string;
      dueDate: string | null;
      ownerType: TaskOwnerType;
      owner: string | null;
      employee: string | null;
    }>;
    unassignedTasks: Array<{
      workflowId: string;
      taskId: string;
      title: string;
      ownerType: TaskOwnerType;
      employee: string | null;
    }>;
    upcoming: Array<{ workflowId: string; employee: string | null; anchorDate: string | null }>;
    coreHrPending: Array<{
      workflowId: string;
      employee: string | null;
      plannedEndDate: string | null;
    }>;
  };
}

export interface EmployeeWorkflowSummary {
  id: string;
  kind: WorkflowKind;
  status: WorkflowStatus;
  templateName: string;
  anchorDate: string | null;
  plannedEndDate: string | null;
  employmentAssignmentId: string;
  positionName: string;
  progress: Progress;
}

export interface ExternalSubmission {
  externalResourceId: string;
  externalResponseId: string;
  respondentEmail: string;
  submittedAt: string;
}

export interface CompletionOutcome {
  externalResponseId: string;
  outcome: CompletionOutcomeKind;
  taskId?: string;
  reason?: string;
}
