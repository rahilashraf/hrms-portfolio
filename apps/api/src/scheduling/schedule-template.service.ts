import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type {
  AuthorizationTarget,
  EffectiveGrant,
} from '../authorization/authorization.types.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  ScheduleTemplate,
  ScheduleTemplateRule,
} from '../generated/prisma/client.js';
import type {
  CreateScheduleTemplateDto,
  RecurrenceRuleDto,
  ScheduleTemplateListQueryDto,
  UpdateRecurrenceRuleDto,
  UpdateScheduleTemplateDto,
} from './schedule-recurrence.dto.js';
import { ScheduleRuleSetService } from './schedule-rule-set.service.js';
import type { SchedulingRequestContext } from './scheduling.service.js';

type Client = Prisma.TransactionClient;
type TemplateWithRules = ScheduleTemplate & { rules: ScheduleTemplateRule[] };

const MANAGE_TEMPLATES = 'schedule.manage_templates';
/** Any of these, anywhere in the Organization, lets an actor see its reusable templates. */
const TEMPLATE_READ_PERMISSIONS = [
  'schedule.read',
  MANAGE_TEMPLATES,
  'schedule.manage_patterns',
] as const;

/**
 * Phase 7 Batch 5 — reusable, organization-level ScheduleTemplates. Templates are presets:
 * applying one copies its rules into an EmployeeSchedulePattern, so editing a template never
 * changes existing patterns. Templates are managed with schedule.manage_templates on the
 * Organization; they are visible to anyone holding a scheduling read or management permission
 * within that Organization (pattern managers need them to apply them).
 */
@Injectable()
export class ScheduleTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly rules: ScheduleRuleSetService,
    private readonly audit: AuditService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** Phase 18: the SCHEDULING module gate. */
  readonly features: FeatureGateService;

  async listTemplates(userId: string, query: ScheduleTemplateListQueryDto) {
    await this.assertCanRead(userId, query.organizationId, this.prisma);
    const max = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const rows = await this.prisma.scheduleTemplate.findMany({
      where: {
        organizationId: query.organizationId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
      },
      include: { _count: { select: { rules: true } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: max + 1,
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    const items = rows.slice(0, max);
    return {
      items: items.map(({ _count, ...row }) => ({
        ...this.templateShape(row),
        ruleCount: _count.rules,
      })),
      nextAfterId: rows.length > max ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async getTemplate(userId: string, templateId: string) {
    const template = await this.loadTemplate(templateId, this.prisma);
    await this.assertCanRead(userId, template.organizationId, this.prisma);
    return this.detailShape(template);
  }

  async createTemplate(
    input: CreateScheduleTemplateDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const name = this.requiredText(input.name, 'name');
    return this.prisma.$transaction(async (tx) => {
      await this.assertCanManage(actor, input.organizationId, tx);
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: input.organizationId },
      });
      if (organization.archivedAt) {
        throw new BadRequestException(
          'Templates cannot be created in an archived organization.',
        );
      }
      const rules = await this.rules.validate(
        input.organizationId,
        input.rotationWeeks,
        (input.rules ?? []).map((rule) => this.rules.fromInput(rule)),
        tx,
      );
      await this.assertNameAvailable(input.organizationId, name, null, tx);
      const template = await this.uniqueName(() =>
        tx.scheduleTemplate.create({
          data: {
            organizationId: input.organizationId,
            name,
            description: this.optionalText(input.description),
            rotationWeeks: input.rotationWeeks,
            rules: { create: rules },
          },
          include: { rules: { orderBy: [...this.rules.ruleOrder] } },
        }),
      );
      const shaped = this.detailShape(template);
      await this.writeAudit(
        tx,
        'SCHEDULE_TEMPLATE_CREATED',
        template.id,
        context,
        {
          template: shaped,
        },
      );
      return shaped;
    });
  }

  /**
   * Templates are presets, not history, so active templates may be edited freely; patterns
   * already copied from them are unaffected. The rule set is re-validated for a new rotation.
   */
  async updateTemplate(
    templateId: string,
    input: UpdateScheduleTemplateDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const template = await this.lockActiveTemplate(actor, templateId, tx);
      const next = {
        name:
          input.name === undefined
            ? template.name
            : this.requiredText(input.name, 'name'),
        description:
          input.description === undefined
            ? template.description
            : this.optionalText(input.description),
        rotationWeeks: input.rotationWeeks ?? template.rotationWeeks,
      };
      const changes = changed(template, next, [
        'name',
        'description',
        'rotationWeeks',
      ]);
      if (Object.keys(changes).length === 0) return this.detailShape(template);
      if (next.rotationWeeks !== template.rotationWeeks) {
        await this.rules.validate(
          template.organizationId,
          next.rotationWeeks,
          template.rules.map((rule) => this.rules.fromStored(rule)),
          tx,
        );
      }
      if (changes.name) {
        await this.assertNameAvailable(
          template.organizationId,
          next.name,
          templateId,
          tx,
        );
      }
      const updated = await this.uniqueName(() =>
        tx.scheduleTemplate.update({
          where: { id: templateId },
          data: next,
          include: { rules: { orderBy: [...this.rules.ruleOrder] } },
        }),
      );
      await this.writeAudit(
        tx,
        'SCHEDULE_TEMPLATE_UPDATED',
        templateId,
        context,
        {
          changes,
        },
      );
      return this.detailShape(updated);
    });
  }

  /** Archiving retires a template from use while keeping it as provenance. Idempotent. */
  async archiveTemplate(templateId: string, context: SchedulingRequestContext) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const template = await this.lockTemplate(actor, templateId, tx);
      if (template.archivedAt) return this.detailShape(template);
      const archived = await tx.scheduleTemplate.update({
        where: { id: templateId },
        data: { archivedAt: new Date() },
        include: { rules: { orderBy: [...this.rules.ruleOrder] } },
      });
      await this.writeAudit(
        tx,
        'SCHEDULE_TEMPLATE_ARCHIVED',
        templateId,
        context,
        {
          template: this.templateShape(archived),
        },
      );
      return this.detailShape(archived);
    });
  }

  /**
   * Hard delete is only for templates no pattern was ever created from; a referenced template
   * is provenance and must be archived instead.
   */
  async deleteTemplate(templateId: string, context: SchedulingRequestContext) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const template = await this.lockTemplate(actor, templateId, tx);
      const references = await tx.employeeSchedulePattern.count({
        where: { sourceTemplateId: templateId },
      });
      if (references > 0) {
        throw new ConflictException(
          `The template was applied to ${references} schedule pattern(s); archive it instead of deleting it.`,
        );
      }
      await tx.scheduleTemplateRule.deleteMany({
        where: { scheduleTemplateId: templateId },
      });
      await tx.scheduleTemplate.delete({ where: { id: templateId } });
      await this.writeAudit(
        tx,
        'SCHEDULE_TEMPLATE_DELETED',
        templateId,
        context,
        {
          template: this.detailShape(template),
        },
      );
      return { success: true };
    });
  }

  // ─── Rules ──────────────────────────────────────────────────────────────────

  async createRule(
    templateId: string,
    input: RecurrenceRuleDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const candidate = this.rules.fromInput(input);
    return this.prisma.$transaction(async (tx) => {
      const template = await this.lockActiveTemplate(actor, templateId, tx);
      const [data] = await this.rules.validate(
        template.organizationId,
        template.rotationWeeks,
        [
          candidate,
          ...template.rules.map((rule) => this.rules.fromStored(rule)),
        ],
        tx,
      );
      const rule = await tx.scheduleTemplateRule.create({
        data: { ...data!, scheduleTemplateId: templateId },
      });
      const shaped = this.rules.shape(rule);
      await this.writeAudit(
        tx,
        'SCHEDULE_TEMPLATE_RULE_CREATED',
        templateId,
        context,
        { rule: shaped },
      );
      return shaped;
    });
  }

  async updateRule(
    templateId: string,
    ruleId: string,
    input: UpdateRecurrenceRuleDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const template = await this.lockActiveTemplate(actor, templateId, tx);
      const rule = this.findRule(template, ruleId);
      const candidate = this.rules.merge(rule, input);
      if (!candidate.fresh) return this.rules.shape(rule);
      const before = this.rules.shape(rule);
      const [data] = await this.rules.validate(
        template.organizationId,
        template.rotationWeeks,
        [
          candidate,
          ...template.rules
            .filter((other) => other.id !== ruleId)
            .map((other) => this.rules.fromStored(other)),
        ],
        tx,
      );
      const updated = await tx.scheduleTemplateRule.update({
        where: { id: ruleId },
        data: data!,
      });
      const after = this.rules.shape(updated);
      await this.writeAudit(
        tx,
        'SCHEDULE_TEMPLATE_RULE_UPDATED',
        templateId,
        context,
        { ruleId, changes: changed(before, after, RULE_FIELDS) },
      );
      return after;
    });
  }

  async deleteRule(
    templateId: string,
    ruleId: string,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const template = await this.lockActiveTemplate(actor, templateId, tx);
      const rule = this.findRule(template, ruleId);
      await tx.scheduleTemplateRule.delete({ where: { id: ruleId } });
      await this.writeAudit(
        tx,
        'SCHEDULE_TEMPLATE_RULE_DELETED',
        templateId,
        context,
        { rule: this.rules.shape(rule) },
      );
      return { success: true };
    });
  }

  // ─── Access ─────────────────────────────────────────────────────────────────

  /**
   * Holds the template FOR UPDATE so rule-set validation and the following write cannot
   * interleave with another rule change or with a template application reading it.
   * Templates the actor cannot see are reported as not found.
   */
  private async lockTemplate(actor: string, templateId: string, tx: Client) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ScheduleTemplate" WHERE "id" = ${templateId}::uuid FOR UPDATE`,
    );
    const template = await this.loadTemplate(templateId, tx);
    await this.assertCanRead(actor, template.organizationId, tx);
    await this.assertCanManage(actor, template.organizationId, tx);
    return template;
  }

  private async lockActiveTemplate(
    actor: string,
    templateId: string,
    tx: Client,
  ) {
    const template = await this.lockTemplate(actor, templateId, tx);
    if (template.archivedAt) {
      throw new ConflictException('Archived templates cannot be changed.');
    }
    return template;
  }

  private async loadTemplate(
    templateId: string,
    client: Client,
  ): Promise<TemplateWithRules> {
    const template = await client.scheduleTemplate.findUnique({
      where: { id: templateId },
      include: { rules: { orderBy: [...this.rules.ruleOrder] } },
    });
    if (!template) throw new NotFoundException('Schedule template not found');
    return template;
  }

  private findRule(template: TemplateWithRules, ruleId: string) {
    const rule = template.rules.find((row) => row.id === ruleId);
    if (!rule) throw new NotFoundException('Schedule template rule not found');
    return rule;
  }

  private async assertCanManage(
    actor: string,
    organizationId: string,
    client: Client,
  ) {
    const grants = await this.authorization.effectiveGrants(
      actor,
      new Date(),
      client,
    );
    const target = await this.organizationTarget(organizationId, client);
    if (!permissionIsGranted(grants, MANAGE_TEMPLATES, target)) {
      throw new ForbiddenException(
        'Missing permission schedule.manage_templates for the organization.',
      );
    }
    await this.features.require(organizationId, 'SCHEDULING', client);
  }

  /** Not found rather than forbidden, so other organizations' templates are never exposed. */
  private async assertCanRead(
    actor: string,
    organizationId: string,
    client: Client,
  ) {
    const grants = (
      await this.authorization.effectiveGrants(actor, new Date(), client)
    ).filter((grant) =>
      (TEMPLATE_READ_PERMISSIONS as readonly string[]).includes(
        grant.permission,
      ),
    );
    if (
      !(await this.grantedWithinOrganization(grants, organizationId, client))
    ) {
      throw new NotFoundException('Schedule template not found');
    }
    await this.features.require(organizationId, 'SCHEDULING', client);
  }

  /** True when any grant's scope is the system or lies inside the Organization. */
  private async grantedWithinOrganization(
    grants: EffectiveGrant[],
    organizationId: string,
    client: Client,
  ) {
    const ids = (type: string) =>
      grants
        .filter((grant) => grant.scope.type === type && grant.scope.id)
        .map((grant) => grant.scope.id!);
    if (
      grants.some(
        (grant) =>
          grant.scope.type === 'SYSTEM' ||
          (grant.scope.type === 'ORGANIZATION' &&
            grant.scope.id === organizationId),
      )
    ) {
      return true;
    }
    const [units, departments, teams] = await Promise.all([
      client.organizationalUnit.count({
        where: { id: { in: ids('ORGANIZATIONAL_UNIT') }, organizationId },
      }),
      client.department.count({
        where: { id: { in: ids('DEPARTMENT') }, organizationId },
      }),
      client.team.count({ where: { id: { in: ids('TEAM') }, organizationId } }),
    ]);
    return units + departments + teams > 0;
  }

  private async organizationTarget(
    organizationId: string,
    client: Client,
  ): Promise<AuthorizationTarget> {
    return this.authorization.resolveTarget(
      { type: 'ORGANIZATION', id: organizationId, organizationId },
      client,
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Active template names are unique per organization (case-insensitive). */
  private async assertNameAvailable(
    organizationId: string,
    name: string,
    excludeTemplateId: string | null,
    client: Client,
  ) {
    const existing = await client.scheduleTemplate.findFirst({
      where: {
        organizationId,
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeTemplateId ? { id: { not: excludeTemplateId } } : {}),
      },
      select: { id: true },
    });
    if (existing) throw this.duplicateName();
  }

  /** The unique index backstops a concurrent create of the same name. */
  private async uniqueName<T>(write: () => Promise<T>) {
    try {
      return await write();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw this.duplicateName();
      }
      throw error;
    }
  }

  private duplicateName() {
    return new ConflictException(
      'An active schedule template with this name already exists in the organization.',
    );
  }

  private requiredText(value: string, label: string) {
    const text = value.trim();
    if (!text) throw new BadRequestException(`${label} is required.`);
    return text;
  }

  private optionalText(value: string | null | undefined) {
    return value?.trim() || null;
  }

  private requireActor(context: SchedulingRequestContext) {
    if (!context.actorUserId) throw new ForbiddenException();
    return context.actorUserId;
  }

  private templateShape(template: ScheduleTemplate) {
    return {
      id: template.id,
      organizationId: template.organizationId,
      name: template.name,
      description: template.description,
      rotationWeeks: template.rotationWeeks,
      archivedAt: template.archivedAt?.toISOString() ?? null,
      createdAt: template.createdAt.toISOString(),
      updatedAt: template.updatedAt.toISOString(),
    };
  }

  private detailShape(template: TemplateWithRules) {
    return {
      ...this.templateShape(template),
      rules: template.rules.map((rule) => this.rules.shape(rule)),
    };
  }

  private writeAudit(
    client: Client,
    action: string,
    templateId: string,
    context: SchedulingRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: 'ScheduleTemplate',
        entityId: templateId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue,
      },
      client,
    );
  }
}

export const RULE_FIELDS = [
  'weekIndex',
  'dayOfWeek',
  'startLocalTime',
  'endLocalTime',
  'workLocationId',
  'timezone',
  'sortOrder',
] as const;

export function changed<T extends object>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of fields) {
    if (before[field] !== after[field]) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }
  return changes;
}
