import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  parseDateOnly,
  requireActor,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  EmployeeWorkflow,
  EmployeeWorkflowKind,
  EmployeeWorkflowTask,
  Prisma,
} from '../generated/prisma/client.js';
import {
  DOCUMENT_ACKNOWLEDGEMENT,
  type DocumentAcknowledgementContract,
} from '../documents/document-storage.contract.js';
import {
  OnboardingAccessService,
  type OnboardingPermission,
} from './onboarding-access.service.js';
import type { EffectiveGrant } from '../authorization/authorization.types.js';
import {
  conflict,
  isoDate,
  lockWorkflow,
  OnboardingClock,
  workflowEvent,
  writeOnboardingAudit,
  type OnboardingRequestContext,
  type Tx,
} from './onboarding-common.js';
import {
  assertCompletable,
  canMoveTask,
  DONE_TASK,
  invalid,
  OPEN_TASK,
  parseText,
  permissionFamily,
  TASK_OWNER_INVALID,
} from './onboarding-domain.js';
import type {
  ExternalTaskSubmission,
  TaskCompletionOutcome,
  WorkflowTaskCompletionIngestion,
} from './onboarding-task.contract.js';
import { OnboardingWorkflowService } from './onboarding-workflow.service.js';

interface LockedTask {
  workflow: EmployeeWorkflow;
  task: EmployeeWorkflowTask;
  canManage: boolean;
  isSelf: boolean;
  isOwner: boolean;
  /** The actor's onboarding grants (for System-scope authority). */
  grants: EffectiveGrant[];
  /** The assignment's current manager's active account, if any. */
  managerUserId: string | null;
}

/**
 * Phase 14 — task work. Locks the workflow then reads the task (serializing task work with
 * workflow cancellation and completion). Owners work their tasks; HR (manage) may complete any
 * non-acknowledgement task on someone's behalf, waive, reopen, reassign and re-date tasks.
 * Acknowledgement tasks are only ever the employee's own act. Finished tasks reopen only
 * explicitly (counted, reasoned and recorded). A workflow whose every task is done completes.
 */
@Injectable()
export class OnboardingTaskService implements WorkflowTaskCompletionIngestion {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OnboardingAccessService,
    private readonly audit: AuditService,
    private readonly clock: OnboardingClock,
    private readonly workflows: OnboardingWorkflowService,
    /** Phase 15 Documents (policy acknowledgements, required documents); absent in isolation. */
    @Optional()
    @Inject(DOCUMENT_ACKNOWLEDGEMENT)
    private readonly documents?: DocumentAcknowledgementContract,
  ) {}

  async start(taskId: string, context: OnboardingRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.locked(tx, actor, taskId);
      this.requireWorker(locked);
      await this.requireSelfCompletion(tx, locked);
      if (locked.task.status !== 'NOT_STARTED') {
        throw conflict(
          'WORKFLOW_TASK_TRANSITION_INVALID',
          `The task is ${locked.task.status.toLowerCase()}.`,
        );
      }
      await tx.employeeWorkflowTask.update({
        where: { id: taskId },
        data: { status: 'IN_PROGRESS', startedAt: this.clock.now() },
      });
      await workflowEvent(tx, {
        workflowId: locked.workflow.id,
        taskId,
        type: 'TASK_STARTED',
        fromStatus: 'NOT_STARTED',
        toStatus: 'IN_PROGRESS',
        actorUserId: actor,
      });
      return this.workflows.detailIn(tx, actor, locked.workflow.id);
    });
  }

  async complete(
    taskId: string,
    input: { note?: string | null; evidenceReference?: string | null },
    context: OnboardingRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(input.note, 'note', { max: 4000 });
    const evidenceReference = parseText(
      input.evidenceReference,
      'evidenceReference',
      { max: 2000 },
    );
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.locked(tx, actor, taskId);
      this.requireWorker(locked);
      await this.requireSelfCompletion(tx, locked);
      this.requireOpen(locked.task);
      assertCompletable(locked.task, {
        note,
        evidenceReference,
        acknowledging: false,
      });
      // A required-document task is done when the employee holds a valid record of the type.
      let evidence = evidenceReference;
      if (locked.task.referenceType === 'DOCUMENT_TYPE') {
        const found = this.documents
          ? await this.documents.validDocumentOfType(tx, {
              organizationId: locked.workflow.organizationId,
              employeeId: locked.workflow.employeeId,
              typeId: locked.task.referenceExternalId!,
            })
          : null;
        if (!found) {
          throw conflict(
            'WORKFLOW_DOCUMENT_REQUIRED',
            'The employee has no valid document of the required type yet.',
          );
        }
        evidence = evidence ?? `employee-document:${found.documentId}`;
      }
      await this.finish(
        tx,
        locked,
        actor,
        {
          note,
          evidenceReference: evidence,
          acknowledging: false,
          source: 'MANUAL',
        },
        context,
      );
      return this.workflows.detailIn(tx, actor, locked.workflow.id);
    });
  }

  /** The employee's acknowledgement (of exactly the statement frozen on the task). */
  async acknowledge(
    taskId: string,
    input: { statementAccepted: boolean },
    context: OnboardingRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.locked(tx, actor, taskId);
      if (!locked.task.acknowledgementRequired) {
        throw conflict(
          'WORKFLOW_NOT_AN_ACKNOWLEDGEMENT',
          'This task is not an acknowledgement.',
        );
      }
      if (!locked.isSelf || !locked.isOwner) {
        throw new ForbiddenException(
          domainError(
            403,
            'WORKFLOW_ACKNOWLEDGEMENT_SELF_ONLY',
            'Only the employee acknowledges their own task.',
          ),
        );
      }
      this.requireOpen(locked.task);
      if (input.statementAccepted !== true) {
        invalid(
          'WORKFLOW_ACKNOWLEDGEMENT_REQUIRED',
          'Confirm the acknowledgement statement.',
        );
      }
      // A policy-document task records the authoritative Documents acknowledgement of the
      // policy's current published version (idempotent; never covers later versions).
      let documentAcknowledgementId: string | undefined;
      if (locked.task.referenceType === 'POLICY_DOCUMENT') {
        if (!this.documents) {
          throw conflict(
            'WORKFLOW_DOCUMENTS_UNAVAILABLE',
            'Policy acknowledgements are unavailable.',
          );
        }
        const result = await this.documents.acknowledgeCurrentVersion(tx, {
          organizationId: locked.workflow.organizationId,
          policyId: locked.task.referenceExternalId!,
          employeeId: locked.workflow.employeeId,
          userId: actor,
          source: 'ONBOARDING_TASK',
        });
        documentAcknowledgementId = result.acknowledgementId;
      }
      await this.finish(
        tx,
        locked,
        actor,
        {
          note: null,
          evidenceReference: null,
          acknowledging: true,
          source: 'MANUAL',
          documentAcknowledgementId,
        },
        context,
      );
      return this.workflows.detailIn(tx, actor, locked.workflow.id);
    });
  }

  async waive(
    taskId: string,
    reason: string,
    context: OnboardingRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(reason, 'reason', { required: true, max: 2000 })!;
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.locked(tx, actor, taskId);
      this.requireManage(locked);
      this.requireOpen(locked.task);
      const now = this.clock.now();
      await tx.employeeWorkflowTask.update({
        where: { id: taskId },
        data: {
          status: 'WAIVED',
          waivedAt: now,
          waivedByUserId: actor,
          waiverReason: note,
        },
      });
      await workflowEvent(tx, {
        workflowId: locked.workflow.id,
        taskId,
        type: 'TASK_WAIVED',
        fromStatus: locked.task.status,
        toStatus: 'WAIVED',
        note,
        actorUserId: actor,
      });
      await this.audit_(tx, 'WORKFLOW_TASK_WAIVED', locked, context, {
        required: locked.task.required,
      });
      await this.completeIfDone(tx, locked.workflow, actor, context);
      return this.workflows.detailIn(tx, actor, locked.workflow.id);
    });
  }

  /** Explicit, reasoned reopening of a completed or waived task (reopens a completed workflow). */
  async reopen(
    taskId: string,
    reason: string,
    context: OnboardingRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(reason, 'reason', { required: true, max: 2000 })!;
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.locked(tx, actor, taskId);
      this.requireManage(locked);
      const { task, workflow } = locked;
      if (!DONE_TASK.includes(task.status)) {
        throw conflict(
          'WORKFLOW_TASK_NOT_FINISHED',
          'Only a completed or waived task is reopened.',
        );
      }
      if (workflow.status === 'CANCELLED')
        throw conflict('WORKFLOW_NOT_ACTIVE', 'The workflow was cancelled.');
      if (workflow.status === 'COMPLETED') {
        await tx.employeeWorkflow.update({
          where: { id: workflow.id },
          data: {
            status: 'ACTIVE',
            completedAt: null,
            completedByUserId: null,
          },
        });
        await workflowEvent(tx, {
          workflowId: workflow.id,
          type: 'REOPENED',
          fromStatus: 'COMPLETED',
          toStatus: 'ACTIVE',
          note,
          actorUserId: actor,
        });
      }
      await tx.employeeWorkflowTask.update({
        where: { id: taskId },
        data: {
          status: 'IN_PROGRESS',
          startedAt: task.startedAt ?? this.clock.now(),
          reopenCount: task.reopenCount + 1,
          completedAt: null,
          completedByUserId: null,
          completionNote: null,
          evidenceReference: null,
          completionSource: null,
          externalCompletionId: null,
          acknowledgedAt: null,
          acknowledgedByUserId: null,
          documentAcknowledgementId: null,
          waivedAt: null,
          waivedByUserId: null,
          waiverReason: null,
        },
      });
      await workflowEvent(tx, {
        workflowId: workflow.id,
        taskId,
        type: 'TASK_REOPENED',
        fromStatus: task.status,
        toStatus: 'IN_PROGRESS',
        note,
        actorUserId: actor,
      });
      await this.audit_(tx, 'WORKFLOW_TASK_REOPENED', locked, context, {
        from: task.status,
        reopenCount: task.reopenCount + 1,
      });
      return this.workflows.detailIn(tx, actor, workflow.id);
    });
  }

  /**
   * Gives an open task to another owner (or the HR pool). Employee tasks stay the employee's
   * (identity-scoped).
   */
  async reassign(
    taskId: string,
    ownerUserId: string | null,
    context: OnboardingRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.locked(tx, actor, taskId);
      this.requireManage(locked);
      this.requireOpen(locked.task);
      if (locked.task.ownerType === 'EMPLOYEE') {
        throw conflict(
          'WORKFLOW_TASK_EMPLOYEE_OWNED',
          'An employee task belongs to the employee.',
        );
      }
      if (ownerUserId) {
        // Security fix: the owner must be connected to the workflow's organization (or be the
        // employee's manager); only System-scope authority may name any active account. An
        // unknown, inactive or unrelated account gets the same answer (no existence oracle).
        const system = this.access.hasSystemGrant(
          locked.grants,
          `${permissionFamily(locked.workflow.kind)}.manage` as OnboardingPermission,
        );
        const eligible = system
          ? await this.access.isActiveUser(ownerUserId, tx)
          : await this.access.isEligibleTaskOwner(
              ownerUserId,
              locked.workflow.organizationId,
              { managerUserId: locked.managerUserId, client: tx },
            );
        if (!eligible) invalid('WORKFLOW_OWNER_INVALID', TASK_OWNER_INVALID);
        const user = await tx.user.findUniqueOrThrow({
          where: { id: ownerUserId },
          select: {
            person: { select: { employee: { select: { id: true } } } },
          },
        });
        if (user.person?.employee?.id === locked.workflow.employeeId) {
          invalid(
            'WORKFLOW_OWNER_INVALID',
            'Tasks of this kind are never given to the employee themselves.',
          );
        }
      } else if (locked.task.ownerType === 'SPECIFIC_USER') {
        invalid(
          'WORKFLOW_OWNER_INVALID',
          'A specific-user task needs an owner.',
        );
      }
      await tx.employeeWorkflowTask.update({
        where: { id: taskId },
        data: { ownerUserId },
      });
      await workflowEvent(tx, {
        workflowId: locked.workflow.id,
        taskId,
        type: 'TASK_REASSIGNED',
        actorUserId: actor,
      });
      await this.audit_(tx, 'WORKFLOW_TASK_REASSIGNED', locked, context, {
        ownerUserId,
      });
      return this.workflows.detailIn(tx, actor, locked.workflow.id);
    });
  }

  async setDueDate(
    taskId: string,
    dueDate: string | null,
    reason: string,
    context: OnboardingRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(reason, 'reason', { required: true, max: 2000 })!;
    const date = dueDate ? parseDateOnly(dueDate, 'dueDate') : null;
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.locked(tx, actor, taskId);
      this.requireManage(locked);
      this.requireOpen(locked.task);
      await tx.employeeWorkflowTask.update({
        where: { id: taskId },
        data: { dueDate: date },
      });
      await workflowEvent(tx, {
        workflowId: locked.workflow.id,
        taskId,
        type: 'TASK_DUE_DATE_CHANGED',
        fromStatus: isoDate(locked.task.dueDate),
        toStatus: isoDate(date),
        note,
        actorUserId: actor,
      });
      // Phase 19 audit gap: HR changing a due date is now audited (dates only; the reason
      // stays on the workflow event).
      await this.audit_(tx, 'WORKFLOW_TASK_DUE_DATE_CHANGED', locked, context, {
        from: isoDate(locked.task.dueDate),
        to: isoDate(date),
      });
      return this.workflows.detailIn(tx, actor, locked.workflow.id);
    });
  }

  // ─── External completions (the contract) ─────────────────────────────────

  async completeFromSubmissions(
    organizationId: string,
    referenceType: 'GOOGLE_FORM' | 'GOOGLE_DOC' | 'EXTERNAL_URL',
    submissions: readonly ExternalTaskSubmission[],
    actorUserId: string | null,
  ) {
    // Batch 7A (S2): onboarding and offboarding are separate permission families. An importer
    // completes only tasks of the workflow kinds they manage at organization level (a system
    // delivery, with no actor, completes either kind).
    let kinds: EmployeeWorkflowKind[] = ['ONBOARDING', 'OFFBOARDING'];
    if (actorUserId) {
      const grants = await this.access.grants(actorUserId);
      kinds = kinds.filter((kind) =>
        this.access.canInOrganization(
          grants,
          kind === 'ONBOARDING' ? 'onboarding.manage' : 'offboarding.manage',
          organizationId,
        ),
      );
      if (kinds.length === 0) {
        throw new ForbiddenException(
          'Missing permission onboarding.manage or offboarding.manage for the organization.',
        );
      }
    }
    // Phase 18: the completion contract (e.g. Google Forms) is refused while the module is off.
    await this.access.requireEnabled(organizationId);
    const outcomes: TaskCompletionOutcome[] = [];
    for (const submission of submissions) {
      outcomes.push(
        await this.completeOne(
          organizationId,
          referenceType,
          submission,
          actorUserId,
          kinds,
        ),
      );
    }
    return { outcomes };
  }

  private async completeOne(
    organizationId: string,
    referenceType: 'GOOGLE_FORM' | 'GOOGLE_DOC' | 'EXTERNAL_URL',
    submission: ExternalTaskSubmission,
    actorUserId: string | null,
    kinds: readonly EmployeeWorkflowKind[],
  ): Promise<TaskCompletionOutcome> {
    const base = {
      externalResponseId: String(submission?.externalResponseId ?? ''),
    };
    const resource = parseTextSafe(submission?.externalResourceId, 500);
    const response = parseTextSafe(submission?.externalResponseId, 500);
    const email =
      typeof submission?.respondentEmail === 'string'
        ? submission.respondentEmail.trim().toLowerCase()
        : '';
    const submittedAt =
      typeof submission?.submittedAt === 'string'
        ? new Date(submission.submittedAt)
        : null;
    if (
      !resource ||
      !response ||
      !email ||
      !submittedAt ||
      Number.isNaN(submittedAt.getTime())
    ) {
      return { ...base, outcome: 'REJECTED', reason: 'INVALID_SUBMISSION' };
    }
    const users = await this.prisma.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: {
        id: true,
        person: {
          select: { employee: { select: { id: true, archivedAt: true } } },
        },
      },
      take: 2,
    });
    const matches = users.filter(
      (user) => user.person?.employee && !user.person.employee.archivedAt,
    );
    if (matches.length !== 1)
      return { ...base, outcome: 'NO_MATCHING_EMPLOYEE' };
    const user = matches[0]!;
    const employeeId = user.person!.employee!.id;
    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.employeeWorkflowTask.findMany({
        where: {
          organizationId,
          referenceType,
          referenceExternalId: resource,
          ownerType: 'EMPLOYEE',
          workflow: { employeeId, status: 'ACTIVE', kind: { in: [...kinds] } },
        },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      });
      const already = candidates.find(
        (task) => task.externalCompletionId === response,
      );
      if (already)
        return { ...base, outcome: 'UNCHANGED' as const, taskId: already.id };
      const target = candidates.find(
        (task) =>
          OPEN_TASK.includes(task.status) && !task.acknowledgementRequired,
      );
      if (!target) return { ...base, outcome: 'NO_OPEN_TASK' as const };
      await lockWorkflow(tx, target.workflowId);
      const workflow = await tx.employeeWorkflow.findUniqueOrThrow({
        where: { id: target.workflowId },
      });
      const task = await tx.employeeWorkflowTask.findUniqueOrThrow({
        where: { id: target.id },
      });
      if (workflow.status !== 'ACTIVE' || !OPEN_TASK.includes(task.status)) {
        return { ...base, outcome: 'UNCHANGED' as const, taskId: task.id };
      }
      await this.finish(
        tx,
        {
          workflow,
          task,
          canManage: false,
          isSelf: true,
          isOwner: true,
          grants: [],
          managerUserId: null,
        },
        actorUserId ?? task.ownerUserId,
        {
          note: null,
          evidenceReference: `${referenceType}:${resource}/${response}`,
          acknowledging: false,
          source: 'EXTERNAL',
          externalCompletionId: response,
          completedAt: submittedAt,
        },
        { actorUserId: actorUserId ?? undefined },
      );
      return { ...base, outcome: 'COMPLETED' as const, taskId: task.id };
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async finish(
    tx: Tx,
    locked: LockedTask,
    actor: string | null,
    completion: {
      note: string | null;
      evidenceReference: string | null;
      acknowledging: boolean;
      source: 'MANUAL' | 'EXTERNAL';
      externalCompletionId?: string;
      completedAt?: Date;
      documentAcknowledgementId?: string;
    },
    context: OnboardingRequestContext,
  ) {
    const now = this.clock.now();
    const data: Prisma.EmployeeWorkflowTaskUncheckedUpdateInput = {
      status: 'COMPLETED',
      startedAt: locked.task.startedAt ?? now,
      completedAt: completion.completedAt ?? now,
      completedByUserId: actor,
      completionNote: completion.note,
      evidenceReference: completion.evidenceReference,
      completionSource: completion.source,
      externalCompletionId: completion.externalCompletionId ?? null,
      documentAcknowledgementId: completion.documentAcknowledgementId ?? null,
      ...(completion.acknowledging
        ? { acknowledgedAt: now, acknowledgedByUserId: actor }
        : {}),
    };
    await tx.employeeWorkflowTask.update({
      where: { id: locked.task.id },
      data,
    });
    await workflowEvent(tx, {
      workflowId: locked.workflow.id,
      taskId: locked.task.id,
      type: completion.acknowledging ? 'TASK_ACKNOWLEDGED' : 'TASK_COMPLETED',
      fromStatus: locked.task.status,
      toStatus: 'COMPLETED',
      note:
        completion.source === 'EXTERNAL'
          ? 'Completed from an external submission'
          : null,
      actorUserId: actor,
    });
    await this.audit_(
      tx,
      completion.acknowledging
        ? 'WORKFLOW_TASK_ACKNOWLEDGED'
        : 'WORKFLOW_TASK_COMPLETED',
      locked,
      context,
      {
        source: completion.source,
        onBehalf: !locked.isOwner,
      },
    );
    await this.completeIfDone(tx, locked.workflow, actor, context);
  }

  private async completeIfDone(
    tx: Tx,
    workflow: EmployeeWorkflow,
    actor: string | null,
    context: OnboardingRequestContext,
  ) {
    const tasks = await tx.employeeWorkflowTask.findMany({
      where: { workflowId: workflow.id },
      select: { status: true },
    });
    const live = tasks.filter((task) => task.status !== 'CANCELLED');
    if (
      live.length > 0 &&
      live.every((task) => DONE_TASK.includes(task.status))
    ) {
      await this.workflows.markCompleted(tx, workflow, actor, context);
    }
  }

  private async locked(
    tx: Tx,
    actor: string,
    taskId: string,
  ): Promise<LockedTask> {
    const found = await tx.employeeWorkflowTask.findUnique({
      where: { id: taskId },
      select: { workflowId: true },
    });
    if (!found) throw new NotFoundException('Task not found.');
    await lockWorkflow(tx, found.workflowId);
    const workflow = await tx.employeeWorkflow.findUniqueOrThrow({
      where: { id: found.workflowId },
    });
    const task = await tx.employeeWorkflowTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    const access = await this.access.workflowAccess(actor, workflow, tx);
    const isOwner = task.ownerUserId === actor;
    // The employee reaches the tasks of their own workflow (and is refused others' precisely).
    if (!access.canRead && !isOwner && !access.isSelf)
      throw new NotFoundException('Task not found.');
    const manager = access.assignment.manager?.employee.person.user;
    return {
      workflow,
      task,
      canManage: access.canManage,
      isSelf: access.isSelf,
      isOwner,
      grants: access.grants,
      managerUserId:
        manager && manager.status === 'ACTIVE' && !manager.archivedAt
          ? manager.id
          : null,
    };
  }

  /** Owners work their tasks; HR may work any task (HR-pool tasks are HR's). */
  private requireWorker(locked: LockedTask) {
    if (locked.isOwner || locked.canManage) return;
    if (locked.isSelf) {
      throw new ForbiddenException(
        domainError(
          403,
          'WORKFLOW_TASK_NOT_YOURS',
          'This task of your workflow belongs to someone else.',
        ),
      );
    }
    throw new ForbiddenException(
      `Missing permission ${permissionFamily(locked.workflow.kind)}.manage for the task.`,
    );
  }

  /**
   * Phase 18 (onboarding.employeeTaskCompletion): with the setting off, an employee no longer
   * works the tasks of their own workflow through self-service; HR (manage) still can, and
   * acknowledgements stay the employee's own act.
   */
  private async requireSelfCompletion(tx: Tx, locked: LockedTask) {
    if (!locked.isSelf || locked.canManage) return;
    await this.access.features.requireSetting(
      locked.workflow.organizationId,
      'onboarding.employeeTaskCompletion',
      tx,
    );
  }

  private requireManage(locked: LockedTask) {
    if (!locked.canManage) {
      throw new ForbiddenException(
        `Missing permission ${permissionFamily(locked.workflow.kind)}.manage for the task.`,
      );
    }
  }

  private requireOpen(task: EmployeeWorkflowTask) {
    if (!canMoveTask(task.status, 'COMPLETED')) {
      throw conflict(
        'WORKFLOW_TASK_NOT_OPEN',
        `The task is ${task.status.toLowerCase().replace('_', ' ')}.`,
        { status: task.status },
      );
    }
  }

  private audit_(
    tx: Tx,
    action: string,
    locked: LockedTask,
    context: OnboardingRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return writeOnboardingAudit(this.audit, tx, {
      action,
      entityType: 'EmployeeWorkflowTask',
      entityId: locked.task.id,
      context,
      metadata: {
        organizationId: locked.workflow.organizationId,
        workflowId: locked.workflow.id,
        kind: locked.workflow.kind,
        ...metadata,
      },
    });
  }
}

function parseTextSafe(value: unknown, max: number) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= max ? text : null;
}
