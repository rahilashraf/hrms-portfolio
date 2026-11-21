import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  addDays,
  advisoryLock,
  domainError,
  positionTargets,
  requireActor,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  EmployeeWorkflowKind,
  EmployeeWorkflowStatus,
  Prisma,
} from '../generated/prisma/client.js';
import {
  OnboardingAccessService,
  type OnboardingPermission,
  type WorkflowView,
} from './onboarding-access.service.js';
import {
  conflict,
  isoDate,
  lockWorkflow,
  OnboardingClock,
  onboardingToday,
  personName,
  workflowEvent,
  writeOnboardingAudit,
  type OnboardingClient,
  type OnboardingRequestContext,
  type Tx,
} from './onboarding-common.js';
import {
  dueDateOf,
  invalid,
  isOverdue,
  OPEN_TASK,
  parseText,
  progressOf,
  permissionFamily,
} from './onboarding-domain.js';
import { parseDateOnly } from '../common/domain-support.js';

export interface StartWorkflowInput {
  employmentAssignmentId: string;
  templateId?: string | null;
  /** Offboarding: the planned last day (Core HR's dates are not changed). */
  plannedEndDate?: string | null;
  /** Offboarding: the reason (HR-only). */
  reason?: string | null;
}

export const WORKFLOW_INCLUDE = {
  tasks: {
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { ownerUser: { select: { id: true, email: true } } },
  },
} satisfies Prisma.EmployeeWorkflowInclude;

/** Batch 7A — the onboarding dashboard reads its scope in batches and stops at a limit. */
const DASHBOARD_BATCH = 500;
const DASHBOARD_LIMIT = 500;
/** At most this many batches are read (10,000 rows); beyond that the list says `truncated`. */
const DASHBOARD_MAX_BATCHES = 20;
const DASHBOARD_INCLUDE = {
  ...WORKFLOW_INCLUDE,
  employmentAssignment: {
    include: {
      employee: {
        select: {
          id: true,
          employeeNumber: true,
          person: {
            select: {
              firstName: true,
              lastName: true,
              preferredName: true,
            },
          },
        },
      },
      position: {
        select: {
          id: true,
          name: true,
          organizationId: true,
          organizationalUnitId: true,
          departmentId: true,
          teamId: true,
        },
      },
    },
  },
} satisfies Prisma.EmployeeWorkflowInclude;
type DashboardRow = Prisma.EmployeeWorkflowGetPayload<{
  include: typeof DASHBOARD_INCLUDE;
}>;

type WorkflowRow = Prisma.EmployeeWorkflowGetPayload<{
  include: typeof WORKFLOW_INCLUDE;
}>;
type TaskRow = WorkflowRow['tasks'][number];

export interface TaskViewer {
  userId: string;
  view: WorkflowView;
  canManage: boolean;
  isSelf: boolean;
  /**
   * Batch 7A: the organization's onboarding.employeeTaskCompletion setting for an employee
   * viewing their own workflow (default true). When off they may not start or complete their
   * tasks (the service refuses), so those actions are not offered; acknowledgements stay.
   */
  selfCompletionAllowed?: boolean;
}

/** Actions a viewer may take on a task (the services re-check every one). */
export function taskActions(
  task: TaskRow,
  workflowStatus: EmployeeWorkflowStatus,
  viewer: TaskViewer,
) {
  const active = workflowStatus === 'ACTIVE';
  const open = OPEN_TASK.includes(task.status);
  const isOwner = task.ownerUserId === viewer.userId;
  const hrPool = task.ownerType === 'HR' && viewer.canManage;
  const selfBlocked =
    viewer.isSelf &&
    !viewer.canManage &&
    viewer.selfCompletionAllowed === false;
  const canWork =
    open && active && !selfBlocked && (isOwner || hrPool || viewer.canManage);
  return {
    canStart: canWork && task.status === 'NOT_STARTED',
    canComplete: canWork && !task.acknowledgementRequired,
    canAcknowledge:
      open &&
      active &&
      task.acknowledgementRequired &&
      isOwner &&
      viewer.isSelf,
    canWaive: open && active && viewer.canManage,
    canReopen:
      (task.status === 'COMPLETED' || task.status === 'WAIVED') &&
      workflowStatus !== 'CANCELLED' &&
      viewer.canManage,
    canReassign: open && active && viewer.canManage,
  };
}

export function taskShape(
  task: TaskRow,
  workflowStatus: EmployeeWorkflowStatus,
  viewer: TaskViewer,
  today: Date,
) {
  return {
    id: task.id,
    workflowId: task.workflowId,
    sortOrder: task.sortOrder,
    title: task.title,
    description: task.description,
    category: task.category,
    ownerType: task.ownerType,
    owner: task.ownerUser
      ? { userId: task.ownerUser.id, email: task.ownerUser.email }
      : null,
    dueDate: isoDate(task.dueDate),
    overdue: isOverdue(task, today),
    required: task.required,
    evidenceRequired: task.evidenceRequired,
    acknowledgementRequired: task.acknowledgementRequired,
    acknowledgementStatement: task.acknowledgementStatement,
    reference: task.referenceType
      ? {
          type: task.referenceType,
          url: task.referenceUrl,
          externalId: task.referenceExternalId,
          label: task.referenceLabel,
        }
      : null,
    systemAction: task.systemAction,
    status: task.status,
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    completedByUserId: task.completedByUserId,
    completionNote: task.completionNote,
    evidenceReference: task.evidenceReference,
    completionSource: task.completionSource,
    acknowledgedAt: task.acknowledgedAt?.toISOString() ?? null,
    waivedAt: task.waivedAt?.toISOString() ?? null,
    waiverReason: viewer.view === 'HR' ? task.waiverReason : null,
    reopenCount: task.reopenCount,
    actions: taskActions(task, workflowStatus, viewer),
  };
}

/**
 * Phase 14 — onboarding and offboarding workflows of employment assignments.
 *
 * Starting freezes the chosen (or default) template into the workflow's own tasks, resolves
 * each task's owner (the employee's account, the assignment's manager at start, a specific
 * user, or the HR pool) and computes due dates from the anchor (the assignment start date, or
 * the planned last day). Starts are serialized per (assignment, kind) and the database allows
 * one active workflow of a kind per assignment. Onboarding can start from a Phase 13 hire
 * (idempotent per hire). Offboarding never ends employment: Core HR stays authoritative for
 * assignment end and termination, and the workflow only shows whether Core HR has caught up.
 */
@Injectable()
export class OnboardingWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OnboardingAccessService,
    private readonly audit: AuditService,
    private readonly clock: OnboardingClock,
  ) {}

  async start(
    kind: EmployeeWorkflowKind,
    input: StartWorkflowInput,
    context: OnboardingRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(
      (tx) => this.startIn(tx, actor, kind, input, null, context),
      { timeout: 60_000 },
    );
  }

  /**
   * The hand-off from Phase 13: starts onboarding for the assignment a hire conversion created.
   * Idempotent — a second call returns the onboarding already started for that hire.
   */
  async startFromHire(
    hireId: string,
    templateId: string | null | undefined,
    context: OnboardingRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(
      async (tx) => {
        const hire = await tx.recruitmentHire.findUnique({
          where: { id: hireId },
        });
        if (!hire) throw new NotFoundException('Hire not found.');
        await this.access.requireStart(
          actor,
          hire.employmentAssignmentId,
          'ONBOARDING',
          tx,
          'Hire not found.',
        );
        // Phase 18: starting from a hire also reads Recruitment's hire record.
        await this.access.features.require(
          hire.organizationId,
          'RECRUITMENT',
          tx,
        );
        await advisoryLock(
          tx,
          `employee-workflow:${hire.employmentAssignmentId}:ONBOARDING`,
        );
        const existing = await tx.employeeWorkflow.findUnique({
          where: { recruitmentHireId: hireId },
        });
        if (existing && existing.status !== 'CANCELLED')
          return {
            ...(await this.detailIn(tx, actor, existing.id)),
            created: false,
          };
        if (existing) {
          // Batch 7A: the hire's onboarding was cancelled. A later onboarding of the same
          // assignment (in progress or completed) is the answer; otherwise a new one starts.
          // The cancelled workflow keeps the hire link (the database allows one per hire).
          const later = await tx.employeeWorkflow.findFirst({
            where: {
              employmentAssignmentId: hire.employmentAssignmentId,
              kind: 'ONBOARDING',
              status: { in: ['ACTIVE', 'COMPLETED'] },
            },
            orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
            select: { id: true },
          });
          if (later)
            return {
              ...(await this.detailIn(tx, actor, later.id)),
              created: false,
            };
          const restarted = await this.startIn(
            tx,
            actor,
            'ONBOARDING',
            {
              employmentAssignmentId: hire.employmentAssignmentId,
              templateId,
            },
            null,
            context,
          );
          return {
            ...restarted,
            created: true,
            restartedFromWorkflowId: existing.id,
          };
        }
        const started = await this.startIn(
          tx,
          actor,
          'ONBOARDING',
          { employmentAssignmentId: hire.employmentAssignmentId, templateId },
          hireId,
          context,
        );
        return { ...started, created: true };
      },
      { timeout: 60_000 },
    );
  }

  private async startIn(
    tx: Tx,
    actor: string,
    kind: EmployeeWorkflowKind,
    input: StartWorkflowInput,
    recruitmentHireId: string | null,
    context: OnboardingRequestContext,
  ) {
    const { assignment, grants } = await this.access.requireStart(
      actor,
      input.employmentAssignmentId,
      kind,
      tx,
    );
    if (assignment.status === 'CANCELLED')
      throw conflict(
        'WORKFLOW_ASSIGNMENT_CANCELLED',
        'The assignment was cancelled.',
      );
    const organizationId = assignment.position.organizationId;
    await advisoryLock(tx, `employee-workflow:${assignment.id}:${kind}`);
    const active = await tx.employeeWorkflow.findFirst({
      where: { employmentAssignmentId: assignment.id, kind, status: 'ACTIVE' },
      select: { id: true },
    });
    if (active) {
      throw conflict(
        'WORKFLOW_ALREADY_ACTIVE',
        `The assignment already has an active ${kind.toLowerCase()}.`,
        {
          workflowId: active.id,
        },
      );
    }
    let plannedEndDate: Date | null = null;
    let reason: string | null = null;
    if (kind === 'OFFBOARDING') {
      if (!input.plannedEndDate)
        invalid(
          'WORKFLOW_END_DATE_REQUIRED',
          'Offboarding needs the planned last day.',
        );
      plannedEndDate = parseDateOnly(input.plannedEndDate, 'plannedEndDate');
      if (plannedEndDate < assignment.startDate) {
        invalid(
          'WORKFLOW_END_DATE_INVALID',
          'The planned last day precedes the assignment start.',
        );
      }
      reason = parseText(input.reason, 'reason', { max: 2000 });
    }
    const template = input.templateId
      ? await tx.workflowTemplate.findUnique({
          where: { id: input.templateId },
          include: { tasks: { orderBy: { sortOrder: 'asc' } } },
        })
      : await tx.workflowTemplate.findFirst({
          where: { organizationId, kind, isDefault: true, status: 'ACTIVE' },
          include: { tasks: { orderBy: { sortOrder: 'asc' } } },
        });
    if (!template) {
      if (input.templateId) throw new NotFoundException('Template not found.');
      throw conflict(
        'WORKFLOW_NO_TEMPLATE',
        `Choose a template: the organization has no default ${kind.toLowerCase()} template.`,
      );
    }
    if (
      template.organizationId !== organizationId ||
      template.kind !== kind ||
      template.status !== 'ACTIVE'
    ) {
      invalid(
        'WORKFLOW_TEMPLATE_INVALID',
        `The template is not an active ${kind.toLowerCase()} template of the organization.`,
      );
    }
    const anchorDate =
      kind === 'ONBOARDING' ? assignment.startDate : plannedEndDate!;
    const employeeUser = assignment.employee.person.user;
    const employeeUserId =
      employeeUser &&
      employeeUser.status === 'ACTIVE' &&
      !employeeUser.archivedAt
        ? employeeUser.id
        : null;
    const managerUser = assignment.manager?.employee.person.user;
    const managerUserId =
      managerUser && managerUser.status === 'ACTIVE' && !managerUser.archivedAt
        ? managerUser.id
        : null;
    // Security fix: a template's specific owner gets the task (and so the task owner's view of
    // this workflow) only while still connected to the organization, or when the actor starts
    // it with System-scope authority. Otherwise the task starts in the HR pool (a specific-user
    // task must have its owner): HR works it or gives it to someone. The template is left as
    // it is.
    const systemStart = this.access.hasSystemGrant(
      grants,
      `${permissionFamily(kind)}.manage` as OnboardingPermission,
    );
    const ownerAllowed = new Map<string, boolean>();
    for (const task of template.tasks) {
      const owner =
        task.ownerType === 'SPECIFIC_USER' ? task.ownerUserId : null;
      if (!owner || ownerAllowed.has(owner)) continue;
      // Batch 7A (S5): nobody is given a task of their own workflow as its specific owner
      // (reassignment already forbids it); such a task starts in the HR pool.
      if (employeeUser && owner === employeeUser.id) {
        ownerAllowed.set(owner, false);
        continue;
      }
      ownerAllowed.set(
        owner,
        systemStart
          ? await this.access.isActiveUser(owner, tx)
          : await this.access.isEligibleTaskOwner(owner, organizationId, {
              managerUserId,
              client: tx,
            }),
      );
    }
    // Tasks (not distinct owners) that start in the HR pool instead of with their owner.
    const ownersMovedToHrPool = template.tasks.filter(
      (task) =>
        task.ownerType === 'SPECIFIC_USER' &&
        task.ownerUserId &&
        !ownerAllowed.get(task.ownerUserId),
    ).length;
    const workflow = await tx.employeeWorkflow.create({
      data: {
        organizationId,
        kind,
        employeeId: assignment.employeeId,
        employmentAssignmentId: assignment.id,
        templateId: template.id,
        templateCode: template.code,
        templateName: template.name,
        anchorDate,
        plannedEndDate,
        reason,
        recruitmentHireId,
        startedByUserId: actor,
        startedAt: this.clock.now(),
      },
    });
    for (const task of template.tasks) {
      const ownerUserId =
        task.ownerType === 'EMPLOYEE'
          ? employeeUserId
          : task.ownerType === 'MANAGER'
            ? managerUserId
            : task.ownerType === 'SPECIFIC_USER' &&
                task.ownerUserId &&
                ownerAllowed.get(task.ownerUserId)
              ? task.ownerUserId
              : null;
      const ownerType =
        task.ownerType === 'SPECIFIC_USER' && !ownerUserId
          ? 'HR'
          : task.ownerType;
      await tx.employeeWorkflowTask.create({
        data: {
          workflowId: workflow.id,
          organizationId,
          templateTaskId: task.id,
          sortOrder: task.sortOrder,
          title: task.title,
          description: task.description,
          category: task.category,
          ownerType,
          ownerUserId,
          dueDate: dueDateOf(anchorDate, task.dueOffsetDays),
          required: task.required,
          evidenceRequired: task.evidenceRequired,
          acknowledgementRequired: task.acknowledgementRequired,
          acknowledgementStatement: task.acknowledgementStatement,
          referenceType: task.referenceType,
          referenceUrl: task.referenceUrl,
          referenceExternalId: task.referenceExternalId,
          referenceLabel: task.referenceLabel,
          systemAction: task.systemAction,
        },
      });
    }
    await workflowEvent(tx, {
      workflowId: workflow.id,
      type: 'STARTED',
      toStatus: 'ACTIVE',
      actorUserId: actor,
    });
    await writeOnboardingAudit(this.audit, tx, {
      action:
        kind === 'ONBOARDING' ? 'ONBOARDING_STARTED' : 'OFFBOARDING_STARTED',
      entityType: 'EmployeeWorkflow',
      entityId: workflow.id,
      context,
      metadata: {
        organizationId,
        employeeId: assignment.employeeId,
        employmentAssignmentId: assignment.id,
        templateId: template.id,
        tasks: template.tasks.length,
        // Tasks whose template owner is not connected to the organization (now in the HR pool).
        ...(ownersMovedToHrPool > 0 ? { ownersMovedToHrPool } : {}),
        recruitmentHireId,
        plannedEndDate: isoDate(plannedEndDate),
      },
    });
    return this.detailIn(tx, actor, workflow.id);
  }

  async detail(userId: string, workflowId: string) {
    return this.detailIn(this.prisma, userId, workflowId);
  }

  /** A workflow as the viewer may see it (HR, the employee, or a task owner). */
  async detailIn(client: OnboardingClient, userId: string, workflowId: string) {
    const row = await client.employeeWorkflow.findUnique({
      where: { id: workflowId },
      include: WORKFLOW_INCLUDE,
    });
    if (!row) throw new NotFoundException('Workflow not found.');
    const access = await this.access.requireWorkflowView(userId, row, client);
    const { assignment } = access;
    const today = onboardingToday(
      this.clock.now(),
      assignment.position.organization.timezone,
    );
    const viewer: TaskViewer = {
      userId,
      view: access.view,
      canManage: access.canManage,
      isSelf: access.isSelf,
      ...(access.isSelf && !access.canManage
        ? {
            selfCompletionAllowed:
              (await this.access.features.setting(
                row.organizationId,
                'onboarding.employeeTaskCompletion',
                client,
              )) === true,
          }
        : {}),
    };
    const visibleTasks =
      access.view === 'HR'
        ? row.tasks
        : row.tasks.filter((task) => task.ownerUserId === userId);
    const base = {
      id: row.id,
      view: access.view,
      kind: row.kind,
      status: row.status,
      templateName: row.templateName,
      anchorDate: isoDate(row.anchorDate),
      plannedEndDate: isoDate(row.plannedEndDate),
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      organization: {
        id: assignment.position.organization.id,
        name: assignment.position.organization.name,
      },
      employee: {
        id: assignment.employee.id,
        employeeNumber: assignment.employee.employeeNumber,
        displayName: personName(assignment.employee.person),
      },
      position: { id: assignment.position.id, name: assignment.position.name },
      progress: progressOf(row.tasks, today),
      tasks: visibleTasks.map((task) =>
        taskShape(task, row.status, viewer, today),
      ),
    };
    if (access.view !== 'HR')
      return {
        ...base,
        actions: { canManage: false, canCancel: false, canComplete: false },
      };
    const events = await client.employeeWorkflowEvent.findMany({
      where: { workflowId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const progress = progressOf(row.tasks, today);
    return {
      ...base,
      templateCode: row.templateCode,
      reason: row.reason,
      recruitmentHireId: row.recruitmentHireId,
      cancellationReason: row.cancellationReason,
      // Core HR is authoritative: the workflow only shows where it stands.
      coreHr: {
        assignmentStatus: assignment.status,
        assignmentStartDate: isoDate(assignment.startDate),
        assignmentEndDate: isoDate(assignment.endDate),
        employeeStatus: assignment.employee.status,
        department: assignment.position.department,
        team: assignment.position.team,
        workLocation: assignment.position.workLocation,
        manager: assignment.manager
          ? {
              assignmentId: assignment.manager.id,
              displayName: personName(assignment.manager.employee.person),
            }
          : null,
        endDateRecorded:
          row.kind === 'OFFBOARDING'
            ? assignment.endDate !== null &&
              row.plannedEndDate !== null &&
              assignment.endDate.getTime() === row.plannedEndDate.getTime()
            : null,
      },
      events: events.map((event) => ({
        id: event.id,
        taskId: event.taskId,
        type: event.type,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        note: event.note,
        actorUserId: event.actorUserId,
        createdAt: event.createdAt.toISOString(),
      })),
      actions: {
        canManage: access.canManage,
        canCancel: access.canManage && row.status === 'ACTIVE',
        canComplete:
          access.canManage &&
          row.status === 'ACTIVE' &&
          progress.requiredComplete,
      },
    };
  }

  /** Cancels an active workflow; its open tasks are cancelled with it (reason required). */
  async cancel(
    workflowId: string,
    reason: string,
    context: OnboardingRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(reason, 'reason', { required: true, max: 2000 })!;
    return this.prisma.$transaction(async (tx) => {
      const workflow = await this.lockedForManage(tx, actor, workflowId);
      if (workflow.status !== 'ACTIVE')
        throw conflict(
          'WORKFLOW_NOT_ACTIVE',
          'Only an active workflow is cancelled.',
        );
      const now = this.clock.now();
      const open = await tx.employeeWorkflowTask.findMany({
        where: { workflowId, status: { in: OPEN_TASK } },
      });
      for (const task of open) {
        await tx.employeeWorkflowTask.update({
          where: { id: task.id },
          data: { status: 'CANCELLED', cancelledAt: now },
        });
        await workflowEvent(tx, {
          workflowId,
          taskId: task.id,
          type: 'TASK_CANCELLED',
          fromStatus: task.status,
          toStatus: 'CANCELLED',
          actorUserId: actor,
        });
      }
      await tx.employeeWorkflow.update({
        where: { id: workflowId },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledByUserId: actor,
          cancellationReason: note,
        },
      });
      await workflowEvent(tx, {
        workflowId,
        type: 'CANCELLED',
        fromStatus: 'ACTIVE',
        toStatus: 'CANCELLED',
        note,
        actorUserId: actor,
      });
      await writeOnboardingAudit(this.audit, tx, {
        action:
          workflow.kind === 'ONBOARDING'
            ? 'ONBOARDING_CANCELLED'
            : 'OFFBOARDING_CANCELLED',
        entityType: 'EmployeeWorkflow',
        entityId: workflowId,
        context,
        metadata: {
          organizationId: workflow.organizationId,
          tasksCancelled: open.length,
        },
      });
      return this.detailIn(tx, actor, workflowId);
    });
  }

  /**
   * Completes a workflow whose required tasks are done; optional tasks still open are
   * cancelled. (A workflow whose every task is done completes by itself.)
   */
  async complete(workflowId: string, context: OnboardingRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const workflow = await this.lockedForManage(tx, actor, workflowId);
      if (workflow.status !== 'ACTIVE')
        throw conflict(
          'WORKFLOW_NOT_ACTIVE',
          'Only an active workflow is completed.',
        );
      const tasks = await tx.employeeWorkflowTask.findMany({
        where: { workflowId },
      });
      const progress = progressOf(
        tasks,
        onboardingToday(this.clock.now(), null),
      );
      if (!progress.requiredComplete) {
        throw conflict(
          'WORKFLOW_REQUIRED_TASKS_OPEN',
          `${progress.requiredTotal - progress.requiredDone} required task(s) are still open.`,
        );
      }
      const now = this.clock.now();
      for (const task of tasks.filter((t) => OPEN_TASK.includes(t.status))) {
        await tx.employeeWorkflowTask.update({
          where: { id: task.id },
          data: { status: 'CANCELLED', cancelledAt: now },
        });
        await workflowEvent(tx, {
          workflowId,
          taskId: task.id,
          type: 'TASK_CANCELLED',
          fromStatus: task.status,
          toStatus: 'CANCELLED',
          note: 'Optional task closed with the workflow',
          actorUserId: actor,
        });
      }
      await this.markCompleted(tx, workflow, actor, context);
      return this.detailIn(tx, actor, workflowId);
    });
  }

  async markCompleted(
    tx: Tx,
    workflow: {
      id: string;
      kind: EmployeeWorkflowKind;
      organizationId: string;
    },
    actor: string | null,
    context: OnboardingRequestContext,
  ) {
    await tx.employeeWorkflow.update({
      where: { id: workflow.id },
      data: {
        status: 'COMPLETED',
        completedAt: this.clock.now(),
        completedByUserId: actor,
      },
    });
    await workflowEvent(tx, {
      workflowId: workflow.id,
      type: 'COMPLETED',
      fromStatus: 'ACTIVE',
      toStatus: 'COMPLETED',
      actorUserId: actor,
    });
    await writeOnboardingAudit(this.audit, tx, {
      action:
        workflow.kind === 'ONBOARDING'
          ? 'ONBOARDING_COMPLETED'
          : 'OFFBOARDING_COMPLETED',
      entityType: 'EmployeeWorkflow',
      entityId: workflow.id,
      context,
      metadata: { organizationId: workflow.organizationId },
    });
  }

  async lockedForManage(tx: Tx, actor: string, workflowId: string) {
    await lockWorkflow(tx, workflowId);
    const workflow = await tx.employeeWorkflow.findUniqueOrThrow({
      where: { id: workflowId },
    });
    const access = await this.access.requireWorkflowView(actor, workflow, tx);
    if (!access.canManage) {
      if (access.isSelf) {
        throw new ForbiddenException(
          domainError(
            403,
            'WORKFLOW_SELF_MANAGEMENT',
            'You cannot manage your own onboarding or offboarding.',
          ),
        );
      }
      throw new ForbiddenException(
        `Missing permission ${permissionFamily(workflow.kind)}.manage for the workflow.`,
      );
    }
    return workflow;
  }

  // ─── Lists ────────────────────────────────────────────────────────────────

  /** Workflows of the organization the user reads (HR), with progress and attention. */
  async dashboard(
    userId: string,
    organizationId: string,
    kind: EmployeeWorkflowKind,
    includeClosed = false,
  ) {
    const grants = await this.access.grants(userId);
    const family = permissionFamily(kind);
    const relevant = grants.filter(
      (g) =>
        g.permission === `${family}.read` ||
        g.permission === `${family}.manage`,
    );
    if (!(await this.access.hasAnyInOrganization(organizationId, relevant))) {
      throw new ForbiddenException(
        `Missing ${family} permissions for the organization.`,
      );
    }
    await this.access.requireEnabled(organizationId);
    const selfEmployee = await this.access.employeeIdOfUser(userId);
    // Batch 7A: an unknown organization (reachable by System-scope grants) is a 404, not a 500.
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
    const today = onboardingToday(this.clock.now(), organization.timezone);
    // Batch 7A: the scope filter runs before the limit — read in batches until DASHBOARD_LIMIT
    // readable workflows are found (a team-scoped reader is never starved by other teams'
    // rows), and say when more exist (`truncated`).
    const readable: DashboardRow[] = [];
    let truncated = false;
    let cursor: string | undefined;
    for (let batches = 0; ; batches += 1) {
      if (batches === DASHBOARD_MAX_BATCHES) {
        truncated = true;
        break;
      }
      const batch: DashboardRow[] = await this.prisma.employeeWorkflow.findMany(
        {
          where: {
            organizationId,
            kind,
            ...(includeClosed ? {} : { status: 'ACTIVE' }),
          },
          include: DASHBOARD_INCLUDE,
          orderBy: [{ anchorDate: 'asc' }, { id: 'asc' }],
          take: DASHBOARD_BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        },
      );
      if (batch.length === 0) break;
      const targets = await positionTargets(
        this.prisma,
        batch.map((row) => row.employmentAssignment.position),
      );
      for (const row of batch) {
        if (
          row.employeeId !== selfEmployee &&
          this.access.kindAccess(
            grants,
            kind,
            targets.get(row.employmentAssignment.position.id)!,
            false,
          ).canRead
        ) {
          if (readable.length === DASHBOARD_LIMIT) {
            truncated = true;
            break;
          }
          readable.push(row);
        }
      }
      if (truncated || batch.length < DASHBOARD_BATCH) break;
      cursor = batch[batch.length - 1]!.id;
    }
    const items = readable.map((row) => ({
      id: row.id,
      status: row.status,
      templateName: row.templateName,
      anchorDate: isoDate(row.anchorDate),
      plannedEndDate: isoDate(row.plannedEndDate),
      employee: {
        id: row.employmentAssignment.employee.id,
        employeeNumber: row.employmentAssignment.employee.employeeNumber,
        displayName: personName(row.employmentAssignment.employee.person),
      },
      position: {
        id: row.employmentAssignment.position.id,
        name: row.employmentAssignment.position.name,
      },
      assignmentStatus: row.employmentAssignment.status,
      assignmentEndDate: isoDate(row.employmentAssignment.endDate),
      progress: progressOf(row.tasks, today),
    }));
    const overdueTasks = readable.flatMap((row) =>
      row.tasks
        .filter((task) => isOverdue(task, today))
        .map((task) => ({
          workflowId: row.id,
          taskId: task.id,
          title: task.title,
          dueDate: isoDate(task.dueDate),
          ownerType: task.ownerType,
          owner: task.ownerUser?.email ?? null,
          employee: personName(row.employmentAssignment.employee.person),
        })),
    );
    const unassignedTasks = readable.flatMap((row) =>
      row.tasks
        .filter(
          (task) =>
            OPEN_TASK.includes(task.status) &&
            task.ownerType !== 'HR' &&
            !task.ownerUserId,
        )
        .map((task) => ({
          workflowId: row.id,
          taskId: task.id,
          title: task.title,
          ownerType: task.ownerType,
          employee: personName(row.employmentAssignment.employee.person),
        })),
    );
    const horizon = addDays(today, 30);
    return {
      today: isoDate(today),
      kind,
      items,
      truncated,
      attention: {
        overdueTasks,
        unassignedTasks,
        upcoming: items
          .filter(
            (item) =>
              item.status === 'ACTIVE' &&
              item.anchorDate! >= isoDate(today)! &&
              item.anchorDate! <= isoDate(horizon)!,
          )
          .map((item) => ({
            workflowId: item.id,
            employee: item.employee.displayName,
            anchorDate: item.anchorDate,
          })),
        // Offboarding whose planned last day passed while Core HR has not ended the assignment.
        coreHrPending:
          kind === 'OFFBOARDING'
            ? items
                .filter(
                  (item) =>
                    item.status === 'ACTIVE' &&
                    item.plannedEndDate! < isoDate(today)! &&
                    item.assignmentStatus !== 'ENDED' &&
                    item.assignmentStatus !== 'CANCELLED',
                )
                .map((item) => ({
                  workflowId: item.id,
                  employee: item.employee.displayName,
                  plannedEndDate: item.plannedEndDate,
                }))
            : [],
      },
    };
  }

  /** The workflows of one employee (profile section), for users who read them. */
  async employeeWorkflows(userId: string, employeeId: string) {
    const disabled =
      await this.access.features.disabledOrganizations('ONBOARDING');
    const rows = await this.prisma.employeeWorkflow.findMany({
      where: { employeeId, organizationId: { notIn: [...disabled] } },
      include: WORKFLOW_INCLUDE,
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
    });
    const items = [];
    for (const row of rows) {
      const access = await this.access.workflowAccess(userId, row);
      if (access.view !== 'HR') continue;
      const today = onboardingToday(
        this.clock.now(),
        access.assignment.position.organization.timezone,
      );
      items.push({
        id: row.id,
        kind: row.kind,
        status: row.status,
        templateName: row.templateName,
        anchorDate: isoDate(row.anchorDate),
        plannedEndDate: isoDate(row.plannedEndDate),
        employmentAssignmentId: row.employmentAssignmentId,
        positionName: access.assignment.position.name,
        progress: progressOf(row.tasks, today),
      });
    }
    return { items };
  }

  /** The signed-in employee's own workflows (only their own tasks; never an offboarding reason). */
  async mine(userId: string) {
    const employeeId = await this.access.employeeIdOfUser(userId);
    if (!employeeId) return { items: [] };
    const disabled =
      await this.access.features.disabledOrganizations('ONBOARDING');
    const rows = await this.prisma.employeeWorkflow.findMany({
      where: {
        employeeId,
        status: { not: 'CANCELLED' },
        organizationId: { notIn: [...disabled] },
      },
      select: { id: true },
      orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
    });
    const items = [];
    for (const row of rows) items.push(await this.detail(userId, row.id));
    return { items };
  }

  /** Tasks assigned to the user in other people's workflows (managers, IT, facilities…). */
  async myTasks(userId: string, includeDone = false) {
    const employeeId = await this.access.employeeIdOfUser(userId);
    const disabled =
      await this.access.features.disabledOrganizations('ONBOARDING');
    const rows = await this.prisma.employeeWorkflowTask.findMany({
      where: {
        ownerUserId: userId,
        ...(includeDone ? {} : { status: { in: OPEN_TASK } }),
        workflow: {
          status: { not: 'CANCELLED' },
          organizationId: { notIn: [...disabled] },
          ...(employeeId ? { employeeId: { not: employeeId } } : {}),
        },
      },
      include: {
        ownerUser: { select: { id: true, email: true } },
        workflow: {
          include: {
            organization: { select: { id: true, name: true, timezone: true } },
            employmentAssignment: {
              include: {
                employee: {
                  select: {
                    id: true,
                    employeeNumber: true,
                    person: {
                      select: {
                        firstName: true,
                        lastName: true,
                        preferredName: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: 300,
    });
    return {
      items: rows.map((row) => {
        const today = onboardingToday(
          this.clock.now(),
          row.workflow.organization.timezone,
        );
        return {
          ...taskShape(
            row,
            row.workflow.status,
            { userId, view: 'TASK_OWNER', canManage: false, isSelf: false },
            today,
          ),
          workflow: {
            id: row.workflow.id,
            kind: row.workflow.kind,
            status: row.workflow.status,
            anchorDate: isoDate(row.workflow.anchorDate),
            organization: {
              id: row.workflow.organization.id,
              name: row.workflow.organization.name,
            },
            employee: {
              id: row.workflow.employmentAssignment.employee.id,
              displayName: personName(
                row.workflow.employmentAssignment.employee.person,
              ),
            },
          },
        };
      }),
    };
  }
}
