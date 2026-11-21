import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { requireActor } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  Prisma,
  type Notification,
  type NotificationSourceDomain,
} from '../generated/prisma/client.js';
import { NotificationsAccessService } from './notifications-access.service.js';
import {
  NotificationsClock,
  type NotificationsRequestContext,
  type Tx,
} from './notifications-common.js';
import {
  BODY_MAX,
  decodeCursor,
  encodeCursor,
  invalid,
  isMandatory,
  notificationType,
  PAGE_DEFAULT,
  PAGE_MAX,
  renderTemplate,
  resolveEmailDelivery,
  SUBJECT_MAX,
  validateDedupeKey,
  validateLink,
} from './notifications-domain.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { NotificationTemplateService } from './notification-template.service.js';
import type { FeatureModule } from '../features/features-domain.js';

export interface PublishInput {
  organizationId: string;
  recipientUserId: string;
  /** A registered notification type (see NOTIFICATION_TYPES). */
  type: string;
  /** Values of the type's allowed variables (others are ignored). */
  variables?: Record<string, string | number | Date | null | undefined>;
  /** A relative application path the recipient can open. */
  link?: string | null;
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  /** Idempotency key: one notification per (organization, recipient, key). */
  dedupeKey: string;
}

export type PublishResult =
  | { outcome: 'CREATED'; notification: Notification }
  | { outcome: 'EXISTING'; notification: Notification }
  | {
      outcome: 'REJECTED';
      /** FEATURE_DISABLED (Phase 18): the producing module is disabled (never mandatory ones). */
      reason: 'RECIPIENT_NOT_IN_ORGANIZATION' | 'FEATURE_DISABLED';
    };

/** Phase 18: the module whose notifications a source domain produces (none for SYSTEM / AUTH). */
const SOURCE_MODULE: Partial<Record<NotificationSourceDomain, FeatureModule>> =
  {
    ONBOARDING: 'ONBOARDING',
    DOCUMENTS: 'DOCUMENTS',
    PERFORMANCE: 'PERFORMANCE',
    RECRUITMENT: 'RECRUITMENT',
    LEAVE: 'LEAVE',
    SCHEDULING: 'SCHEDULING',
    PAYROLL: 'PAYROLL',
    BENEFITS: 'BENEFITS',
    TIME: 'ATTENDANCE',
  };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function notificationShape(
  row: Notification & { organization?: { id: string; name: string } | null },
) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    organization: row.organization
      ? { id: row.organization.id, name: row.organization.name }
      : undefined,
    type: row.type,
    category: row.category,
    mandatory: row.mandatory,
    title: row.title,
    body: row.body,
    link: row.link,
    sourceDomain: row.sourceDomain,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/**
 * Phase 16 — the shared notification service. Domains publish through it (never inventing
 * their own delivery); users read and mark their own inbox.
 *
 * publish() is idempotent per (organization, recipient, dedupeKey) — also under concurrency:
 * the notification is inserted with ON CONFLICT DO NOTHING, so a racing duplicate never
 * raises (and never aborts a caller's outer transaction) and returns the existing row.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NotificationsAccessService,
    private readonly templates: NotificationTemplateService,
    private readonly settings: NotificationSettingsService,
    private readonly clock: NotificationsClock,
  ) {}

  /**
   * Publishes one notification: resolves the template (organization override, else system),
   * renders it with whitelisted variables, validates the link, and creates the notification
   * with its IN_APP delivery (SENT) and EMAIL delivery (PENDING, or SUPPRESSED with the
   * reason) in one transaction — the caller's when given.
   */
  async publish(input: PublishInput, tx?: Tx): Promise<PublishResult> {
    const type = notificationType(input.type);
    if (!type)
      invalid('NOTIFICATION_TYPE_UNKNOWN', 'Unknown notification type.');
    if (!UUID.test(input.organizationId) || !UUID.test(input.recipientUserId))
      invalid('NOTIFICATION_RECIPIENT_INVALID', 'Invalid recipient.');
    if (input.sourceEntityId && !UUID.test(input.sourceEntityId))
      invalid('NOTIFICATION_SOURCE_INVALID', 'Invalid source entity.');
    if (
      input.sourceEntityType &&
      !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(input.sourceEntityType)
    )
      invalid('NOTIFICATION_SOURCE_INVALID', 'Invalid source entity type.');
    const dedupeKey = validateDedupeKey(input.dedupeKey);
    const link = validateLink(input.link);
    const run = async (client: Tx): Promise<PublishResult> => {
      const existing = () =>
        client.notification.findUnique({
          where: {
            organizationId_recipientUserId_dedupeKey: {
              organizationId: input.organizationId,
              recipientUserId: input.recipientUserId,
              dedupeKey,
            },
          },
        });
      const found = await existing();
      if (found) return { outcome: 'EXISTING', notification: found };
      if (
        !(await this.access.isOrganizationMember(
          input.recipientUserId,
          input.organizationId,
          client,
        ))
      )
        return { outcome: 'REJECTED', reason: 'RECIPIENT_NOT_IN_ORGANIZATION' };
      const resolved = await this.templates.resolve(
        client,
        input.organizationId,
        type.key,
      );
      if (!resolved)
        invalid('NOTIFICATION_TYPE_UNKNOWN', 'Unknown notification type.');
      const allowed = resolved.system.allowedVariables;
      const variables = input.variables ?? {};
      const title = renderTemplate(
        resolved.template.subjectTemplate,
        variables,
        allowed,
        SUBJECT_MAX,
      );
      const body = renderTemplate(
        resolved.template.bodyTemplate,
        variables,
        allowed,
        BODY_MAX,
      );
      const category = resolved.system.category;
      const mandatory = isMandatory(category, resolved.system.mandatory);
      // Phase 18: a disabled module produces no (non-mandatory) notifications; mandatory
      // SECURITY / HR_REQUIRED notices are always recorded in-app.
      const sourceModule = SOURCE_MODULE[type.sourceDomain];
      if (
        sourceModule &&
        !mandatory &&
        !(await this.access.features.isEnabled(
          input.organizationId,
          sourceModule,
          client,
        ))
      )
        return { outcome: 'REJECTED', reason: 'FEATURE_DISABLED' };
      const now = this.clock.now();
      const id = randomUUID();
      const inserted = await client.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          INSERT INTO "Notification"
            ("id", "organizationId", "recipientUserId", "type", "category", "mandatory", "title",
             "body", "link", "sourceDomain", "sourceEntityType", "sourceEntityId", "dedupeKey",
             "templateId", "templateVersion", "createdAt")
          VALUES (${id}::uuid, ${input.organizationId}::uuid, ${input.recipientUserId}::uuid,
            ${type.key}, ${category}::"NotificationCategory", ${mandatory}, ${title || type.key},
            ${body}, ${link}, ${type.sourceDomain satisfies NotificationSourceDomain}::"NotificationSourceDomain",
            ${input.sourceEntityType ?? null}, ${input.sourceEntityId ?? null}::uuid, ${dedupeKey},
            ${resolved.template.id}::uuid, ${resolved.template.version}, ${now})
          ON CONFLICT ("organizationId", "recipientUserId", "dedupeKey") DO NOTHING
          RETURNING "id"`,
      );
      if (!inserted[0]) {
        // A concurrent publisher committed the same notification first.
        const raced = await existing();
        if (!raced) throw new Error('Notification conflict without a row.');
        return { outcome: 'EXISTING', notification: raced };
      }
      const decision = resolveEmailDelivery({
        category,
        mandatory,
        ...(await this.settings.emailInputs(
          client,
          input.organizationId,
          input.recipientUserId,
          category,
        )),
      });
      await client.notificationDelivery.createMany({
        data: [
          {
            notificationId: id,
            organizationId: input.organizationId,
            channel: 'IN_APP',
            status: 'SENT',
            sentAt: now,
          },
          decision.deliver
            ? {
                notificationId: id,
                organizationId: input.organizationId,
                channel: 'EMAIL',
                status: 'PENDING',
                nextAttemptAt: now,
              }
            : {
                notificationId: id,
                organizationId: input.organizationId,
                channel: 'EMAIL',
                status: 'SUPPRESSED',
                suppressedReason: decision.reason,
              },
        ],
      });
      return {
        outcome: 'CREATED',
        notification: await client.notification.findUniqueOrThrow({
          where: { id },
        }),
      };
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  // ─── The user's own inbox ─────────────────────────────────────────────────

  async mine(
    userId: string,
    query: {
      limit?: number;
      cursor?: string;
      unreadOnly?: boolean;
      archived?: boolean;
      organizationId?: string;
    } = {},
  ) {
    const limit = Math.min(Math.max(query.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.notification.findMany({
      where: {
        recipientUserId: userId,
        ...(query.organizationId
          ? { organizationId: query.organizationId }
          : {}),
        archivedAt: query.archived ? { not: null } : null,
        ...(query.unreadOnly ? { readAt: null } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      include: { organization: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(notificationShape),
      nextCursor:
        rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
    };
  }

  async unreadCount(userId: string) {
    return {
      unread: await this.prisma.notification.count({
        where: { recipientUserId: userId, readAt: null, archivedAt: null },
      }),
    };
  }

  async markRead(notificationId: string, context: NotificationsRequestContext) {
    const actor = requireActor(context);
    const row = await this.own(actor, notificationId);
    if (!row.readAt) {
      await this.prisma.notification.updateMany({
        where: { id: row.id, recipientUserId: actor, readAt: null },
        data: { readAt: this.clock.now() },
      });
    }
    return notificationShape(await this.own(actor, notificationId));
  }

  async markAllRead(
    context: NotificationsRequestContext,
    organizationId?: string,
  ) {
    const actor = requireActor(context);
    const { count } = await this.prisma.notification.updateMany({
      where: {
        recipientUserId: actor,
        readAt: null,
        archivedAt: null,
        ...(organizationId ? { organizationId } : {}),
      },
      data: { readAt: this.clock.now() },
    });
    return { updated: count };
  }

  /** Archiving also marks the notification read. */
  async archive(notificationId: string, context: NotificationsRequestContext) {
    const actor = requireActor(context);
    const row = await this.own(actor, notificationId);
    if (!row.archivedAt) {
      const now = this.clock.now();
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE "Notification" SET "archivedAt" = ${now}, "readAt" = COALESCE("readAt", ${now})
          WHERE "id" = ${row.id}::uuid AND "recipientUserId" = ${actor}::uuid AND "archivedAt" IS NULL`,
      );
    }
    return notificationShape(await this.own(actor, notificationId));
  }

  /** The user's own notification; anybody else's is not found. */
  private async own(userId: string, notificationId: string) {
    const row = await this.prisma.notification.findFirst({
      where: { id: notificationId, recipientUserId: userId },
      include: { organization: { select: { id: true, name: true } } },
    });
    if (!row) throw new NotFoundException('Notification not found.');
    return row;
  }
}
