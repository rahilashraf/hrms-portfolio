import { Injectable, NotFoundException } from '@nestjs/common';
import {
  addDays,
  localDayStart,
  parseDateOnly,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  NotificationAttemptStatus,
  NotificationCategory,
  NotificationChannel,
  NotificationDeliveryStatus,
  Prisma,
} from '../generated/prisma/client.js';
import { NotificationsAccessService } from './notifications-access.service.js';
import {
  decodeCursor,
  encodeCursor,
  invalid,
  NOTIFICATION_TYPES,
  SYSTEM_ONLY_NOTIFICATION_TYPES,
  isSystemOnlyNotificationType,
  PAGE_DEFAULT,
  PAGE_MAX,
} from './notifications-domain.js';

export interface DeliveryLogQuery {
  organizationId: string;
  type?: string;
  category?: NotificationCategory;
  channel?: NotificationChannel;
  status?: NotificationDeliveryStatus;
  /** Local dates (YYYY-MM-DD) in the organization's time zone, inclusive. */
  from?: string;
  to?: string;
  /** Part of the recipient's name (never an id or address). */
  recipient?: string;
  cursor?: string;
  limit?: number;
}

/** The class of an attempt's outcome, for the log (never the payload or the address). */
export function attemptOutcomeClass(status: NotificationAttemptStatus) {
  switch (status) {
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'RETRYABLE_FAILURE':
      return 'RETRYABLE';
    case 'PERMANENT_FAILURE':
      return 'PERMANENT';
    case 'UNCERTAIN':
      return 'UNCERTAIN';
    case 'ABANDONED':
      return 'ABANDONED';
    default:
      return 'IN_PROGRESS';
  }
}

const RECIPIENT = {
  select: {
    person: {
      select: { firstName: true, lastName: true, preferredName: true },
    },
  },
} as const;

function recipientName(
  user: {
    person: {
      firstName: string | null;
      lastName: string | null;
      preferredName: string | null;
    } | null;
  } | null,
) {
  const person = user?.person;
  return (
    [person?.preferredName || person?.firstName, person?.lastName]
      .filter(Boolean)
      .join(' ') || 'Unnamed user'
  );
}

/**
 * Batch 8 (N5) — the organization delivery log: read-only, notification.delivery.read at
 * organization scope (plus the NOTIFICATIONS module). Deliveries of other organizations are
 * not found (404). Shows the event type, category, channel, status, reasons, safe error codes
 * and attempt history with providers and timestamps — never the subject, body, email address,
 * variables or error messages.
 */
@Injectable()
export class NotificationDeliveryLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: NotificationsAccessService,
  ) {}

  async list(userId: string, query: DeliveryLogQuery) {
    await this.access.requireOrganization(
      userId,
      'notification.delivery.read',
      query.organizationId,
    );
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: query.organizationId },
      select: { timezone: true },
    });
    const timezone = organization.timezone ?? 'UTC';
    // M1: system-only notices (security alerts) are listed for SYSTEM-scope readers only.
    const systemReader = await this.systemReader(userId);
    const limit = Math.min(Math.max(query.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
    const cursor = decodeCursor(query.cursor);
    const from = query.from
      ? localDayStart(parseDateOnly(query.from, 'from'), timezone)
      : null;
    const to = query.to
      ? localDayStart(addDays(parseDateOnly(query.to, 'to'), 1), timezone)
      : null;
    if (from && to && from >= to)
      invalid(
        'NOTIFICATION_DELIVERY_RANGE_INVALID',
        'The start date must not be after the end date.',
      );
    const recipient = query.recipient?.trim();
    const name = recipient
      ? { contains: recipient, mode: 'insensitive' as const }
      : undefined;
    const where: Prisma.NotificationDeliveryWhereInput = {
      organizationId: query.organizationId,
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lt: to } : {}),
            },
          }
        : {}),
      notification: {
        ...(query.type || !systemReader
          ? {
              type: {
                ...(query.type ? { equals: query.type } : {}),
                ...(systemReader
                  ? {}
                  : { notIn: [...SYSTEM_ONLY_NOTIFICATION_TYPES] }),
              },
            }
          : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(name
          ? {
              recipient: {
                person: {
                  OR: [
                    { firstName: name },
                    { lastName: name },
                    { preferredName: name },
                  ],
                },
              },
            }
          : {}),
      },
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.notificationDelivery.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        channel: true,
        status: true,
        attemptCount: true,
        nextAttemptAt: true,
        sentAt: true,
        lastErrorCode: true,
        suppressedReason: true,
        createdAt: true,
        updatedAt: true,
        notification: {
          select: {
            type: true,
            category: true,
            mandatory: true,
            recipient: RECIPIENT,
          },
        },
      },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => this.shape(row)),
      nextCursor: rows.length > limit ? encodeCursor(page.at(-1)!) : null,
      timezone,
      types: NOTIFICATION_TYPES.filter(
        (type) => systemReader || !type.systemOnly,
      ).map((type) => ({
        key: type.key,
        category: type.category,
      })),
    };
  }

  /** Holds notification.delivery.read at SYSTEM scope (sees system-only notices). */
  private async systemReader(userId: string) {
    return (await this.access.allGrants(userId)).some(
      (grant) =>
        grant.permission === 'notification.delivery.read' &&
        grant.scope.type === 'SYSTEM',
    );
  }

  /** One delivery with its attempt history; 404 outside the caller's permitted organizations. */
  async detail(userId: string, deliveryId: string) {
    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: {
        id: true,
        organizationId: true,
        channel: true,
        status: true,
        attemptCount: true,
        nextAttemptAt: true,
        sentAt: true,
        lastErrorCode: true,
        suppressedReason: true,
        createdAt: true,
        updatedAt: true,
        notification: {
          select: {
            type: true,
            category: true,
            mandatory: true,
            recipient: RECIPIENT,
          },
        },
        attempts: {
          orderBy: { attemptNumber: 'asc' },
          select: {
            attemptNumber: true,
            status: true,
            provider: true,
            errorCode: true,
            startedAt: true,
            finishedAt: true,
          },
        },
      },
    });
    const grants = await this.access.allGrants(userId);
    if (
      !delivery ||
      !this.access.canInOrganization(
        grants,
        'notification.delivery.read',
        delivery.organizationId,
      ) ||
      // M1: a system-only notice is not shown to an organization-scoped reader.
      (isSystemOnlyNotificationType(delivery.notification.type) &&
        !grants.some(
          (grant) =>
            grant.permission === 'notification.delivery.read' &&
            grant.scope.type === 'SYSTEM',
        ))
    )
      throw new NotFoundException('Delivery not found');
    await this.access.features.require(
      delivery.organizationId,
      'NOTIFICATIONS',
    );
    return {
      ...this.shape(delivery),
      attempts: delivery.attempts.map((attempt) => ({
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        outcome: attemptOutcomeClass(attempt.status),
        provider: attempt.provider,
        errorCode: attempt.errorCode,
        startedAt: attempt.startedAt.toISOString(),
        finishedAt: attempt.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  private shape(row: {
    id: string;
    channel: NotificationChannel;
    status: NotificationDeliveryStatus;
    attemptCount: number;
    nextAttemptAt: Date | null;
    sentAt: Date | null;
    lastErrorCode: string | null;
    suppressedReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    notification: {
      type: string;
      category: NotificationCategory;
      mandatory: boolean;
      recipient: Parameters<typeof recipientName>[0];
    };
  }) {
    return {
      id: row.id,
      type: row.notification.type,
      category: row.notification.category,
      mandatory: row.notification.mandatory,
      recipientName: recipientName(row.notification.recipient),
      channel: row.channel,
      status: row.status,
      attemptCount: row.attemptCount,
      nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      sentAt: row.sentAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      suppressedReason: row.suppressedReason,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
