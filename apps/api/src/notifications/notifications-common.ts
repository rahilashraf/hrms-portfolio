import { ConflictException, Injectable } from '@nestjs/common';
import type { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  formatDate,
  jsonValue,
  localDateOf,
  type DomainRequestContext,
} from '../common/domain-support.js';
import { isIanaTimezone } from '../common/timezone.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

export type NotificationsClient = PrismaService | Prisma.TransactionClient;
export type Tx = Prisma.TransactionClient;
export type NotificationsRequestContext = DomainRequestContext;

/** The notifications clock (overridden in tests). */
@Injectable()
export class NotificationsClock {
  now(): Date {
    return new Date();
  }
}

export const conflict = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new ConflictException(domainError(409, code, message, extra));

/** The organization's local date (YYYY-MM-DD) for daily dedupe keys. */
export function localDay(now: Date, timezone: string | null | undefined) {
  return formatDate(
    timezone && isIanaTimezone(timezone)
      ? localDateOf(now, timezone.trim())
      : now,
  );
}

/**
 * Audit in the caller's transaction. Metadata carries identifiers, keys, categories and
 * booleans only: never template text, rendered content, addresses or provider responses.
 */
export function writeNotificationsAudit(
  audit: AuditService,
  client: Tx,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    context: NotificationsRequestContext;
    metadata: Record<string, unknown>;
  },
) {
  return audit.write(
    {
      action: input.action,
      actorUserId: input.context.actorUserId,
      entityType: input.entityType,
      entityId: input.entityId,
      ipAddress: input.context.ipAddress,
      userAgent: input.context.userAgent,
      correlationId: input.context.correlationId,
      metadata: jsonValue(input.metadata),
    },
    client,
  );
}
