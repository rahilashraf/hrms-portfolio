import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { advisoryLock, requireActor } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  Prisma,
  type NotificationTemplate,
} from '../generated/prisma/client.js';
import { NotificationsAccessService } from './notifications-access.service.js';
import {
  conflict,
  NotificationsClock,
  writeNotificationsAudit,
  type NotificationsClient,
  type NotificationsRequestContext,
  type Tx,
} from './notifications-common.js';
import {
  BODY_MAX,
  invalid,
  notificationType,
  NOTIFICATION_TYPES,
  isSystemOnlyNotificationType,
  renderTemplate,
  SUBJECT_MAX,
  validateTemplateText,
} from './notifications-domain.js';

export function templateShape(row: NotificationTemplate) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    key: row.key,
    category: row.category,
    subjectTemplate: row.subjectTemplate,
    bodyTemplate: row.bodyTemplate,
    allowedVariables: row.allowedVariables,
    mandatory: row.mandatory,
    status: row.status,
    version: row.version,
    system: row.organizationId === null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/**
 * Notification templates: system defaults per notification type (seeded idempotently from
 * the type registry; existing rows are never overwritten) and organization overrides
 * (notification.template.manage). Placeholders are validated against the system template's
 * allowed variables when saved; rendering substitutes only those, escaped.
 */
@Injectable()
export class NotificationTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NotificationsAccessService,
    private readonly audit: AuditService,
    private readonly clock: NotificationsClock,
  ) {}

  /** Inserts missing system templates (ON CONFLICT DO NOTHING: concurrent-safe, non-destructive). */
  async ensureSystemTemplates(client: NotificationsClient = this.prisma) {
    for (const type of NOTIFICATION_TYPES) {
      await client.$executeRaw(Prisma.sql`
        INSERT INTO "NotificationTemplate"
          ("id", "organizationId", "key", "category", "subjectTemplate", "bodyTemplate",
           "allowedVariables", "mandatory", "status", "version", "createdAt", "updatedAt")
        VALUES (${randomUUID()}::uuid, NULL, ${type.key}, ${type.category}::"NotificationCategory",
          ${type.subjectTemplate}, ${type.bodyTemplate}, ${[...type.allowedVariables]}::text[],
          ${type.mandatory}, 'ACTIVE', 1, now(), now())
        ON CONFLICT ("key") WHERE "organizationId" IS NULL DO NOTHING`);
    }
  }

  async systemTemplate(client: NotificationsClient, key: string) {
    const find = () =>
      client.notificationTemplate.findFirst({
        where: { organizationId: null, key },
      });
    let row = await find();
    if (!row && notificationType(key)) {
      await this.ensureSystemTemplates(client);
      row = await find();
    }
    return row;
  }

  /** The template a notification of this type renders with: the organization's, else the system's. */
  async resolve(
    client: NotificationsClient,
    organizationId: string,
    key: string,
  ) {
    const system = await this.systemTemplate(client, key);
    if (!system) return null;
    // M1: a system-only notice always renders from its system template.
    if (isSystemOnlyNotificationType(key)) return { system, template: system };
    const override = await client.notificationTemplate.findFirst({
      where: { organizationId, key, status: 'ACTIVE' },
    });
    return { system, template: override ?? system };
  }

  /** Every notification type with its system template and the organization's active override. */
  async list(userId: string, organizationId: string, includeArchived = false) {
    await this.access.requireOrganization(
      userId,
      'notification.template.manage',
      organizationId,
    );
    await this.ensureSystemTemplates();
    const system = await this.prisma.notificationTemplate.findMany({
      where: { organizationId: null },
      orderBy: { key: 'asc' },
    });
    // M1: system-only notices are neither listed nor editable for an organization.
    const listed = system.filter(
      (row) => !isSystemOnlyNotificationType(row.key),
    );
    const overrides = await this.prisma.notificationTemplate.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { status: 'ACTIVE' }),
      },
      orderBy: [{ key: 'asc' }, { createdAt: 'desc' }],
    });
    return {
      items: listed.map((row) => ({
        key: row.key,
        category: row.category,
        mandatory: row.mandatory,
        allowedVariables: row.allowedVariables,
        sample: notificationType(row.key)?.sample ?? {},
        system: templateShape(row),
        override:
          overrides
            .filter((o) => o.key === row.key && o.status === 'ACTIVE')
            .map(templateShape)[0] ?? null,
        archived: includeArchived
          ? overrides
              .filter((o) => o.key === row.key && o.status === 'ARCHIVED')
              .map(templateShape)
          : undefined,
      })),
    };
  }

  async create(
    input: {
      organizationId: string;
      key: string;
      subjectTemplate: string;
      bodyTemplate: string;
    },
    context: NotificationsRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'notification.template.manage',
      input.organizationId,
    );
    const system = await this.systemTemplate(this.prisma, input.key);
    if (!system || isSystemOnlyNotificationType(system.key))
      invalid('NOTIFICATION_TYPE_UNKNOWN', 'Unknown notification type.');
    const text = validateTemplateText(
      input.subjectTemplate,
      input.bodyTemplate,
      system.allowedVariables,
    );
    try {
      return await this.prisma.$transaction(async (tx) => {
        // One active override per organization and type: serialized here, unique index below.
        await advisoryLock(
          tx,
          `notification-template:${input.organizationId}:${system.key}`,
        );
        if (
          await tx.notificationTemplate.findFirst({
            where: {
              organizationId: input.organizationId,
              key: system.key,
              status: 'ACTIVE',
            },
            select: { id: true },
          })
        )
          throw conflict(
            'NOTIFICATION_TEMPLATE_EXISTS',
            'The organization already has an active template for this notification type; edit or archive it.',
          );
        const row = await tx.notificationTemplate.create({
          data: {
            organizationId: input.organizationId,
            key: system.key,
            category: system.category,
            ...text,
            allowedVariables: system.allowedVariables,
            mandatory: false,
            createdByUserId: actor,
            updatedByUserId: actor,
          },
        });
        await this.writeAudit(
          tx,
          'NOTIFICATION_TEMPLATE_CREATED',
          row,
          context,
        );
        return templateShape(row);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw conflict(
          'NOTIFICATION_TEMPLATE_EXISTS',
          'The organization already has an active template for this notification type; edit or archive it.',
        );
      }
      throw error;
    }
  }

  async update(
    templateId: string,
    input: { subjectTemplate?: string; bodyTemplate?: string },
    context: NotificationsRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lockedOverride(tx, actor, templateId);
      if (row.status !== 'ACTIVE')
        throw conflict(
          'NOTIFICATION_TEMPLATE_ARCHIVED',
          'An archived template cannot be edited.',
        );
      const text = validateTemplateText(
        input.subjectTemplate ?? row.subjectTemplate,
        input.bodyTemplate ?? row.bodyTemplate,
        row.allowedVariables,
      );
      if (
        text.subjectTemplate === row.subjectTemplate &&
        text.bodyTemplate === row.bodyTemplate
      )
        return templateShape(row);
      const updated = await tx.notificationTemplate.update({
        where: { id: row.id },
        data: { ...text, version: row.version + 1, updatedByUserId: actor },
      });
      await this.writeAudit(
        tx,
        'NOTIFICATION_TEMPLATE_UPDATED',
        updated,
        context,
        {
          subjectChanged: text.subjectTemplate !== row.subjectTemplate,
          bodyChanged: text.bodyTemplate !== row.bodyTemplate,
        },
      );
      return templateShape(updated);
    });
  }

  async archive(templateId: string, context: NotificationsRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const row = await this.lockedOverride(tx, actor, templateId);
      if (row.status === 'ARCHIVED') return templateShape(row);
      const updated = await tx.notificationTemplate.update({
        where: { id: row.id },
        data: {
          status: 'ARCHIVED',
          archivedAt: this.clock.now(),
          updatedByUserId: actor,
        },
      });
      await this.writeAudit(
        tx,
        'NOTIFICATION_TEMPLATE_ARCHIVED',
        updated,
        context,
      );
      return templateShape(updated);
    });
  }

  /**
   * Renders a template with the type's sample values: the given text (validated as on save),
   * else the organization's active template, else the system template.
   */
  async preview(
    userId: string,
    input: {
      organizationId: string;
      key: string;
      subjectTemplate?: string;
      bodyTemplate?: string;
    },
  ) {
    await this.access.requireOrganization(
      userId,
      'notification.template.manage',
      input.organizationId,
    );
    const resolved = await this.resolve(
      this.prisma,
      input.organizationId,
      input.key,
    );
    // M1: a system-only notice is not previewed for an organization either.
    if (!resolved || isSystemOnlyNotificationType(input.key))
      invalid('NOTIFICATION_TYPE_UNKNOWN', 'Unknown notification type.');
    const text = validateTemplateText(
      input.subjectTemplate ?? resolved.template.subjectTemplate,
      input.bodyTemplate ?? resolved.template.bodyTemplate,
      resolved.system.allowedVariables,
    );
    const sample = notificationType(input.key)?.sample ?? {};
    return {
      key: input.key,
      variables: sample,
      subject: renderTemplate(
        text.subjectTemplate,
        sample,
        resolved.system.allowedVariables,
        SUBJECT_MAX,
      ),
      body: renderTemplate(
        text.bodyTemplate,
        sample,
        resolved.system.allowedVariables,
        BODY_MAX,
      ),
    };
  }

  /** An organization template the user manages (system templates and others' are not found). */
  private async lockedOverride(tx: Tx, actor: string, templateId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "NotificationTemplate" WHERE "id" = ${templateId}::uuid AND "organizationId" IS NOT NULL FOR NO KEY UPDATE`,
    );
    if (!rows[0]) throw new NotFoundException('Template not found.');
    const row = await tx.notificationTemplate.findUniqueOrThrow({
      where: { id: templateId },
    });
    const grants = await this.access.allGrants(actor, tx);
    if (
      !this.access.canInOrganization(
        grants,
        'notification.template.manage',
        row.organizationId!,
      )
    )
      throw new NotFoundException('Template not found.');
    await this.access.features.require(row.organizationId, 'NOTIFICATIONS', tx);
    return row;
  }

  private writeAudit(
    tx: Tx,
    action: string,
    row: NotificationTemplate,
    context: NotificationsRequestContext,
    extra: Record<string, unknown> = {},
  ) {
    return writeNotificationsAudit(this.audit, tx, {
      action,
      entityType: 'NotificationTemplate',
      entityId: row.id,
      context,
      metadata: {
        organizationId: row.organizationId,
        key: row.key,
        category: row.category,
        version: row.version,
        status: row.status,
        ...extra,
      },
    });
  }
}
