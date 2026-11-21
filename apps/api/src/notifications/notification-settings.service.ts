import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { advisoryLock, requireActor } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type { NotificationCategory } from '../generated/prisma/client.js';
import { NotificationsAccessService } from './notifications-access.service.js';
import {
  writeNotificationsAudit,
  type NotificationsClient,
  type NotificationsRequestContext,
} from './notifications-common.js';
import {
  CONFIGURABLE_CATEGORIES,
  invalid,
  MANDATORY_CATEGORIES,
  NOTIFICATION_CATEGORIES,
} from './notifications-domain.js';

function requireConfigurable(category: NotificationCategory) {
  if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(category))
    invalid('NOTIFICATION_CATEGORY_UNKNOWN', 'Unknown notification category.');
  if (MANDATORY_CATEGORIES.has(category))
    invalid(
      'NOTIFICATION_CATEGORY_MANDATORY',
      `${category} notifications are mandatory; their email cannot be turned off.`,
    );
}

function uniqueCategories(
  items: ReadonlyArray<{ category: NotificationCategory }>,
) {
  const seen = new Set<string>();
  for (const item of items) {
    requireConfigurable(item.category);
    if (seen.has(item.category))
      invalid(
        'NOTIFICATION_CATEGORY_DUPLICATE',
        `${item.category} is listed twice.`,
      );
    seen.add(item.category);
  }
}

/**
 * Email preferences (per user and category; in-app is always on) and organization email
 * settings (per category, plus the organization's email kill switch). Mandatory categories
 * have neither: they are always delivered unless the organization records the explicit
 * suppressMandatoryEmail decision with email turned off.
 */
@Injectable()
export class NotificationSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NotificationsAccessService,
    private readonly audit: AuditService,
  ) {}

  // ─── The user's own preferences ───────────────────────────────────────────

  async preferences(userId: string, client: NotificationsClient = this.prisma) {
    const rows = await client.notificationPreference.findMany({
      where: { userId },
    });
    return {
      inApp: 'ALWAYS' as const,
      items: NOTIFICATION_CATEGORIES.map((category) => {
        const mandatory = MANDATORY_CATEGORIES.has(category);
        return {
          category,
          mandatory,
          configurable: !mandatory,
          emailEnabled: mandatory
            ? true
            : (rows.find((row) => row.category === category)?.emailEnabled ??
              true),
        };
      }),
    };
  }

  async updatePreferences(
    items: Array<{ category: NotificationCategory; emailEnabled: boolean }>,
    context: NotificationsRequestContext,
  ) {
    const actor = requireActor(context);
    uniqueCategories(items);
    return this.prisma.$transaction(async (tx) => {
      for (const item of items) {
        await tx.notificationPreference.upsert({
          where: {
            userId_category: { userId: actor, category: item.category },
          },
          create: {
            userId: actor,
            category: item.category,
            emailEnabled: item.emailEnabled,
          },
          update: { emailEnabled: item.emailEnabled },
        });
      }
      await writeNotificationsAudit(this.audit, tx, {
        action: 'NOTIFICATION_PREFERENCES_UPDATED',
        entityType: 'User',
        entityId: actor,
        context,
        metadata: {
          preferences: items.map((item) => ({
            category: item.category,
            emailEnabled: item.emailEnabled,
          })),
        },
      });
      return this.preferences(actor, tx);
    });
  }

  // ─── Organization settings ────────────────────────────────────────────────

  async organizationSettings(
    userId: string,
    organizationId: string,
    client: NotificationsClient = this.prisma,
    authorized = false,
  ) {
    if (!authorized)
      await this.access.requireOrganization(
        userId,
        'notification.settings.manage',
        organizationId,
        client,
      );
    // Sequential: the client may be a transaction (one connection).
    const policy = await client.organizationNotificationPolicy.findUnique({
      where: { organizationId },
    });
    const rows = await client.organizationNotificationSetting.findMany({
      where: { organizationId },
    });
    return {
      organizationId,
      emailEnabled: policy?.emailEnabled ?? true,
      suppressMandatoryEmail: policy?.suppressMandatoryEmail ?? false,
      categories: NOTIFICATION_CATEGORIES.map((category) => {
        const mandatory = MANDATORY_CATEGORIES.has(category);
        return {
          category,
          mandatory,
          configurable: !mandatory,
          emailEnabled: mandatory
            ? true
            : (rows.find((row) => row.category === category)?.emailEnabled ??
              true),
        };
      }),
      updatedAt: policy?.updatedAt.toISOString() ?? null,
    };
  }

  async updateOrganizationSettings(
    input: {
      organizationId: string;
      emailEnabled?: boolean;
      suppressMandatoryEmail?: boolean;
      categories?: Array<{
        category: NotificationCategory;
        emailEnabled: boolean;
      }>;
    },
    context: NotificationsRequestContext,
  ) {
    const actor = requireActor(context);
    const categories = input.categories ?? [];
    uniqueCategories(categories);
    return this.prisma.$transaction(async (tx) => {
      await this.access.requireOrganization(
        actor,
        'notification.settings.manage',
        input.organizationId,
        tx,
      );
      await advisoryLock(tx, `notification-settings:${input.organizationId}`);
      const current = await tx.organizationNotificationPolicy.findUnique({
        where: { organizationId: input.organizationId },
      });
      const emailEnabled = input.emailEnabled ?? current?.emailEnabled ?? true;
      const suppressMandatoryEmail =
        input.suppressMandatoryEmail ??
        (emailEnabled ? false : (current?.suppressMandatoryEmail ?? false));
      if (suppressMandatoryEmail && emailEnabled)
        invalid(
          'NOTIFICATION_MANDATORY_SUPPRESSION',
          'Mandatory email can only be suppressed while organization email is turned off.',
        );
      const policyChanged =
        input.emailEnabled !== undefined ||
        input.suppressMandatoryEmail !== undefined;
      if (policyChanged || !current) {
        await tx.organizationNotificationPolicy.upsert({
          where: { organizationId: input.organizationId },
          create: {
            organizationId: input.organizationId,
            emailEnabled,
            suppressMandatoryEmail,
            updatedByUserId: actor,
          },
          update: {
            emailEnabled,
            suppressMandatoryEmail,
            updatedByUserId: actor,
          },
        });
      }
      for (const item of categories) {
        await tx.organizationNotificationSetting.upsert({
          where: {
            organizationId_category: {
              organizationId: input.organizationId,
              category: item.category,
            },
          },
          create: {
            organizationId: input.organizationId,
            category: item.category,
            emailEnabled: item.emailEnabled,
            updatedByUserId: actor,
          },
          update: { emailEnabled: item.emailEnabled, updatedByUserId: actor },
        });
      }
      await writeNotificationsAudit(this.audit, tx, {
        action: 'NOTIFICATION_SETTINGS_UPDATED',
        entityType: 'Organization',
        entityId: input.organizationId,
        context,
        metadata: {
          organizationId: input.organizationId,
          emailEnabled,
          suppressMandatoryEmail,
          categories: categories.map((item) => ({
            category: item.category,
            emailEnabled: item.emailEnabled,
          })),
        },
      });
      return this.organizationSettings(actor, input.organizationId, tx, true);
    });
  }

  /** Inputs of the email decision for one recipient and category (publish and send time). */
  async emailInputs(
    client: NotificationsClient,
    organizationId: string,
    userId: string,
    category: NotificationCategory,
  ) {
    const configurable = (
      CONFIGURABLE_CATEGORIES as readonly string[]
    ).includes(category);
    const preference = configurable
      ? await client.notificationPreference.findUnique({
          where: { userId_category: { userId, category } },
        })
      : null;
    const setting = configurable
      ? await client.organizationNotificationSetting.findUnique({
          where: { organizationId_category: { organizationId, category } },
        })
      : null;
    const policy = await client.organizationNotificationPolicy.findUnique({
      where: { organizationId },
    });
    // Phase 18: with the NOTIFICATIONS module disabled the organization sends no email at all
    // (mandatory included); in-app notices are recorded as always.
    if (
      !(await this.access.features.isEnabled(
        organizationId,
        'NOTIFICATIONS',
        client,
      ))
    )
      return {
        userEmailEnabled: preference?.emailEnabled ?? null,
        organizationCategoryEmailEnabled: setting?.emailEnabled ?? null,
        organizationPolicy: {
          emailEnabled: false,
          suppressMandatoryEmail: true,
        },
      };
    return {
      userEmailEnabled: preference?.emailEnabled ?? null,
      organizationCategoryEmailEnabled: setting?.emailEnabled ?? null,
      organizationPolicy: policy
        ? {
            emailEnabled: policy.emailEnabled,
            suppressMandatoryEmail: policy.suppressMandatoryEmail,
          }
        : null,
    };
  }
}
