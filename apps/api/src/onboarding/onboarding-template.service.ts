import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { advisoryLock, requireActor } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  EmployeeWorkflowKind,
  WorkflowTaskCategory,
  WorkflowSystemAction,
} from '../generated/prisma/client.js';
import type { Prisma } from '../generated/prisma/client.js';
import { OnboardingAccessService } from './onboarding-access.service.js';
import {
  conflict,
  lockTemplate,
  OnboardingClock,
  writeOnboardingAudit,
  type OnboardingRequestContext,
  type Tx,
} from './onboarding-common.js';
import {
  invalid,
  parseTemplateTask,
  parseText,
  parseWorkflowCode,
  TASK_OWNER_INVALID,
  type TemplateTaskInput,
} from './onboarding-domain.js';
import type { EffectiveGrant } from '../authorization/authorization.types.js';

export interface TemplateInput {
  organizationId: string;
  kind: EmployeeWorkflowKind;
  code: string;
  name: string;
  description?: string | null;
  tasks: TemplateTaskInput[];
}

const TEMPLATE_INCLUDE = {
  tasks: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  _count: { select: { workflows: true } },
} satisfies Prisma.WorkflowTemplateInclude;

type TemplateRow = Prisma.WorkflowTemplateGetPayload<{
  include: typeof TEMPLATE_INCLUDE;
}>;

export function templateShape(row: TemplateRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    isDefault: row.isDefault,
    workflowCount: row._count.workflows,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    tasks: row.tasks.map((task) => ({
      id: task.id,
      sortOrder: task.sortOrder,
      title: task.title,
      description: task.description,
      category: task.category,
      ownerType: task.ownerType,
      ownerUserId: task.ownerUserId,
      dueOffsetDays: task.dueOffsetDays,
      required: task.required,
      evidenceRequired: task.evidenceRequired,
      acknowledgementRequired: task.acknowledgementRequired,
      acknowledgementStatement: task.acknowledgementStatement,
      referenceType: task.referenceType,
      referenceUrl: task.referenceUrl,
      referenceExternalId: task.referenceExternalId,
      referenceLabel: task.referenceLabel,
      systemAction: task.systemAction,
    })),
  };
}

/**
 * Phase 14 — onboarding and offboarding templates (onboarding.template.manage at the
 * organization). A template is an ordered checklist of task definitions; editing it never
 * changes workflows already started (they hold snapshots). Archived templates are frozen; one
 * active default per organization and kind is used when HR picks none.
 */
const TASK_ID_INVALID = [
  'WORKFLOW_TASK_ID_INVALID',
  'A task id must name a task of this template.',
] as const;

/**
 * Security hardening: on a template update, a task entry's `id` names the existing task it
 * edits (it keeps that id, and an owner it already had). Each id may appear once, and only an
 * id of this template's own tasks is accepted: another template's id and an unknown id get the
 * same answer. Entries without an id are new tasks; tasks left out are deleted.
 */
function keptTaskIds(
  ids: readonly (string | undefined)[],
  existing: readonly { id: string }[],
) {
  const own = new Set(existing.map((task) => task.id));
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id))
      invalid(
        'WORKFLOW_TASK_ID_DUPLICATE',
        'A task id may appear only once in a template.',
      );
    seen.add(id);
  }
  for (const id of ids) if (id && !own.has(id)) invalid(...TASK_ID_INVALID);
  return ids;
}

@Injectable()
export class OnboardingTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OnboardingAccessService,
    private readonly audit: AuditService,
    private readonly clock: OnboardingClock,
  ) {}

  /** Templates are listed to template managers and to anyone who starts workflows. */
  async list(
    userId: string,
    organizationId: string,
    kind?: EmployeeWorkflowKind,
  ) {
    const grants = await this.access.grants(userId);
    const canManage = this.access.canInOrganization(
      grants,
      'onboarding.template.manage',
      organizationId,
    );
    const starters = grants.filter(
      (g) =>
        g.permission === 'onboarding.manage' ||
        g.permission === 'offboarding.manage',
    );
    if (
      !canManage &&
      !(await this.access.hasAnyInOrganization(organizationId, starters))
    ) {
      throw new ForbiddenException(
        'Missing onboarding permissions for the organization.',
      );
    }
    await this.access.requireEnabled(organizationId);
    const rows = await this.prisma.workflowTemplate.findMany({
      where: {
        organizationId,
        ...(kind ? { kind } : {}),
        ...(canManage ? {} : { status: 'ACTIVE' }),
      },
      include: TEMPLATE_INCLUDE,
      orderBy: [{ kind: 'asc' }, { status: 'asc' }, { name: 'asc' }],
    });
    return { items: rows.map(templateShape) };
  }

  async create(input: TemplateInput, context: OnboardingRequestContext) {
    const actor = requireActor(context);
    const grants = await this.access.requireOrganization(
      actor,
      'onboarding.template.manage',
      input.organizationId,
    );
    const code = parseWorkflowCode(input.code);
    // A new template's tasks are new: no id (none can be borrowed from another template).
    if (input.tasks.some((task) => task.id)) invalid(...TASK_ID_INVALID);
    const tasks = await this.parseTasks(
      this.prisma,
      input.tasks,
      input.organizationId,
    );
    return this.prisma.$transaction(async (tx) => {
      await this.checkOwners(tx, tasks, input.organizationId, grants);
      if (
        await tx.workflowTemplate.findUnique({
          where: {
            organizationId_code: { organizationId: input.organizationId, code },
          },
        })
      ) {
        throw conflict(
          'WORKFLOW_TEMPLATE_EXISTS',
          `A template with code ${code} already exists.`,
        );
      }
      const row = await tx.workflowTemplate.create({
        data: {
          organizationId: input.organizationId,
          kind: input.kind,
          code,
          name: parseText(input.name, 'name', { required: true, max: 200 })!,
          description: parseText(input.description, 'description'),
          createdByUserId: actor,
        },
      });
      await this.writeTasks(tx, row.id, input.organizationId, tasks);
      await writeOnboardingAudit(this.audit, tx, {
        action: 'WORKFLOW_TEMPLATE_CREATED',
        entityType: 'WorkflowTemplate',
        entityId: row.id,
        context,
        metadata: {
          organizationId: row.organizationId,
          kind: row.kind,
          code,
          tasks: tasks.length,
        },
      });
      return templateShape(
        await tx.workflowTemplate.findUniqueOrThrow({
          where: { id: row.id },
          include: TEMPLATE_INCLUDE,
        }),
      );
    });
  }

  /** Name, description and (as a whole) the task list. Started workflows keep their snapshot. */
  async update(
    templateId: string,
    input: {
      name?: string;
      description?: string | null;
      tasks?: TemplateTaskInput[];
    },
    context: OnboardingRequestContext,
  ) {
    const actor = requireActor(context);
    // Batch 7A (Q4): authorize before validating task owners, so another organization's
    // template (or its people) is never probed through validation errors.
    const existing = await this.prisma.workflowTemplate.findUnique({
      where: { id: templateId },
      select: { organizationId: true },
    });
    if (!existing) throw new NotFoundException('Template not found.');
    await this.access.requireOrganizationRecord(
      actor,
      'onboarding.template.manage',
      existing.organizationId,
      'Template not found.',
    );
    const tasks = input.tasks
      ? await this.parseTasks(this.prisma, input.tasks, existing.organizationId)
      : null;
    return this.prisma.$transaction(async (tx) => {
      const template = await this.locked(tx, actor, templateId);
      if (template.status === 'ARCHIVED')
        throw conflict(
          'WORKFLOW_TEMPLATE_ARCHIVED',
          'An archived template is frozen.',
        );
      await tx.workflowTemplate.update({
        where: { id: templateId },
        data: {
          ...(input.name !== undefined
            ? {
                name: parseText(input.name, 'name', {
                  required: true,
                  max: 200,
                })!,
              }
            : {}),
          ...(input.description !== undefined
            ? { description: parseText(input.description, 'description') }
            : {}),
        },
      });
      if (tasks) {
        if (template.status === 'ACTIVE' && tasks.length === 0) {
          invalid(
            'WORKFLOW_TEMPLATE_EMPTY',
            'An active template needs at least one task.',
          );
        }
        const keptIds = keptTaskIds(
          input.tasks!.map((task) => task.id),
          template.tasks,
        );
        await this.checkOwners(
          tx,
          tasks,
          template.organizationId,
          await this.access.grants(actor, tx),
          { keptIds, existing: template.tasks },
        );
        await tx.workflowTemplateTask.deleteMany({ where: { templateId } });
        await this.writeTasks(
          tx,
          templateId,
          template.organizationId,
          tasks,
          keptIds,
        );
      }
      await writeOnboardingAudit(this.audit, tx, {
        action: 'WORKFLOW_TEMPLATE_UPDATED',
        entityType: 'WorkflowTemplate',
        entityId: templateId,
        context,
        metadata: {
          organizationId: template.organizationId,
          fields: Object.keys(input).filter(
            (key) => input[key as keyof typeof input] !== undefined,
          ),
          tasks: tasks?.length ?? null,
        },
      });
      return templateShape(
        await tx.workflowTemplate.findUniqueOrThrow({
          where: { id: templateId },
          include: TEMPLATE_INCLUDE,
        }),
      );
    });
  }

  async activate(templateId: string, context: OnboardingRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const template = await this.locked(tx, actor, templateId);
      if (template.status !== 'DRAFT')
        throw conflict(
          'WORKFLOW_TEMPLATE_NOT_DRAFT',
          'Only a draft template is activated.',
        );
      if (
        (await tx.workflowTemplateTask.count({ where: { templateId } })) === 0
      ) {
        invalid(
          'WORKFLOW_TEMPLATE_EMPTY',
          'A template needs at least one task.',
        );
      }
      await tx.workflowTemplate.update({
        where: { id: templateId },
        data: { status: 'ACTIVE', activatedAt: this.clock.now() },
      });
      await this.auditAction(
        tx,
        'WORKFLOW_TEMPLATE_ACTIVATED',
        template,
        context,
      );
      return templateShape(
        await tx.workflowTemplate.findUniqueOrThrow({
          where: { id: templateId },
          include: TEMPLATE_INCLUDE,
        }),
      );
    });
  }

  async archive(templateId: string, context: OnboardingRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const template = await this.locked(tx, actor, templateId);
      if (template.status === 'ARCHIVED') return templateShape(template);
      await tx.workflowTemplate.update({
        where: { id: templateId },
        data: {
          status: 'ARCHIVED',
          archivedAt: this.clock.now(),
          isDefault: false,
        },
      });
      await this.auditAction(
        tx,
        'WORKFLOW_TEMPLATE_ARCHIVED',
        template,
        context,
      );
      return templateShape(
        await tx.workflowTemplate.findUniqueOrThrow({
          where: { id: templateId },
          include: TEMPLATE_INCLUDE,
        }),
      );
    });
  }

  /** Makes an active template the organization's default for its kind (one at a time). */
  async setDefault(templateId: string, context: OnboardingRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const template = await this.locked(tx, actor, templateId);
      if (template.status !== 'ACTIVE')
        throw conflict(
          'WORKFLOW_TEMPLATE_NOT_ACTIVE',
          'Only an active template is the default.',
        );
      await advisoryLock(
        tx,
        `workflow-template-default:${template.organizationId}:${template.kind}`,
      );
      await tx.workflowTemplate.updateMany({
        where: {
          organizationId: template.organizationId,
          kind: template.kind,
          isDefault: true,
          id: { not: templateId },
        },
        data: { isDefault: false },
      });
      await tx.workflowTemplate.update({
        where: { id: templateId },
        data: { isDefault: true },
      });
      await this.auditAction(
        tx,
        'WORKFLOW_TEMPLATE_DEFAULT_SET',
        template,
        context,
      );
      return templateShape(
        await tx.workflowTemplate.findUniqueOrThrow({
          where: { id: templateId },
          include: TEMPLATE_INCLUDE,
        }),
      );
    });
  }

  private async locked(tx: Tx, actor: string, templateId: string) {
    await lockTemplate(tx, templateId);
    const template = await tx.workflowTemplate.findUnique({
      where: { id: templateId },
      include: TEMPLATE_INCLUDE,
    });
    if (!template) throw new NotFoundException('Template not found.');
    await this.access.requireOrganizationRecord(
      actor,
      'onboarding.template.manage',
      template.organizationId,
      'Template not found.',
      tx,
    );
    return template;
  }

  private auditAction(
    tx: Tx,
    action: string,
    template: { id: string; organizationId: string; kind: string },
    context: OnboardingRequestContext,
  ) {
    return writeOnboardingAudit(this.audit, tx, {
      action,
      entityType: 'WorkflowTemplate',
      entityId: template.id,
      context,
      metadata: {
        organizationId: template.organizationId,
        kind: template.kind,
      },
    });
  }

  private async parseTasks(
    client: PrismaService | Tx,
    tasks: readonly TemplateTaskInput[],
    organizationId: string | null,
  ) {
    if (tasks.length > 100)
      invalid(
        'WORKFLOW_TEMPLATE_TOO_LARGE',
        'A template has at most 100 tasks.',
      );
    const parsed = tasks.map((task) => parseTemplateTask(task));
    for (const task of parsed) {
      // Phase 15 references must name a record of the template's organization.
      if (
        task.referenceType === 'POLICY_DOCUMENT' ||
        task.referenceType === 'DOCUMENT_TYPE'
      ) {
        const id = task.referenceExternalId!;
        const uuid = /^[0-9a-f-]{36}$/i.test(id);
        const exists =
          uuid &&
          organizationId &&
          (task.referenceType === 'POLICY_DOCUMENT'
            ? await client.policyDocument.count({
                where: { id, organizationId },
              })
            : await client.documentType.count({
                where: { id, organizationId, archivedAt: null },
              }));
        if (!exists) {
          invalid(
            'WORKFLOW_REFERENCE_INVALID',
            'The referenced policy or document type is not one of the organization.',
          );
        }
      }
    }
    // Task owners are checked by checkOwners, after the actor's permission (no answer about an
    // account before that).
    return parsed;
  }

  /**
   * Security fix: a template task's specific owner must be connected to the template's
   * organization (OnboardingAccessService.isEligibleTaskOwner), or any active account when the
   * actor manages templates at System scope. On an update, an entry that names an existing
   * task of this template (`id`) with that task's unchanged owner keeps the former rule (an
   * active account): templates saved before this check stay editable and nothing stored is
   * changed. The exception belongs to that one task (ids are unique and of this template, see
   * keptTaskIds): the same owner on a new task or on another task is checked as a new owner.
   * Workflow start then puts an ineligible owner's task in the HR pool
   * (OnboardingWorkflowService.startIn).
   */
  private async checkOwners(
    tx: Tx,
    tasks: ReturnType<typeof parseTemplateTask>[],
    organizationId: string,
    grants: EffectiveGrant[],
    previous?: {
      keptIds: readonly (string | undefined)[];
      existing: readonly { id: string; ownerUserId: string | null }[];
    },
  ) {
    const system = this.access.hasSystemGrant(
      grants,
      'onboarding.template.manage',
    );
    const existingOwner = new Map(
      (previous?.existing ?? []).map((task) => [task.id, task.ownerUserId]),
    );
    const eligible = new Map<string, boolean>();
    for (const [index, task] of tasks.entries()) {
      const owner = task.ownerUserId;
      if (!owner) continue;
      const keptId = previous?.keptIds[index];
      const unchanged =
        keptId !== undefined && existingOwner.get(keptId) === owner;
      const ok =
        system || unchanged
          ? await this.access.isActiveUser(owner, tx)
          : (eligible.get(owner) ??
            (await this.access.isEligibleTaskOwner(owner, organizationId, {
              client: tx,
            })));
      if (!system && !unchanged) eligible.set(owner, ok);
      if (!ok) invalid('WORKFLOW_OWNER_INVALID', TASK_OWNER_INVALID);
    }
  }

  private async writeTasks(
    tx: Tx,
    templateId: string,
    organizationId: string,
    tasks: ReturnType<typeof parseTemplateTask>[],
    keptIds: readonly (string | undefined)[] = [],
  ) {
    for (const [index, task] of tasks.entries()) {
      await tx.workflowTemplateTask.create({
        data: {
          // An edited task keeps its id (its old row was just deleted).
          ...(keptIds[index] ? { id: keptIds[index] } : {}),
          templateId,
          organizationId,
          sortOrder: (index + 1) * 10,
          ...task,
          category: task.category as WorkflowTaskCategory,
          systemAction: task.systemAction as WorkflowSystemAction,
        },
      });
    }
  }
}
