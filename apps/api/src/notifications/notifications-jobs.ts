import { PrismaService } from '../database/prisma.service.js';
import { SmtpMailer, smtpSettingsFromEnv } from '../email/smtp-mailer.js';
import {
  DevNotificationEmailTransport,
  type NotificationEmailTransport,
} from './notification-email.transport.js';
import {
  NotificationDeliveryService,
  type DeliverPendingOutcome,
} from './notification-delivery.service.js';
import { NotificationsClock } from './notifications-common.js';
import { SmtpNotificationEmailTransport } from './smtp-notification-email.transport.js';
import { notificationServices } from './notifications-producers.js';
import {
  EVENT_SOURCE_KEYS,
  EventNotificationPublisher,
  type PublishEventsOutcome,
} from './notifications-events.js';

/**
 * Background job contract for Notifications (Phase 16): email delivery. The worker routes the
 * job to runDeliverPendingNotificationsJob; the API owns the logic.
 *
 * Every few minutes the job claims due PENDING email deliveries (FOR UPDATE SKIP LOCKED, so
 * concurrent workers never share one), sends them through the registered email transport and
 * records each attempt. It is idempotent: SENT deliveries are final, a crashed SENDING
 * delivery is reclaimed after its lease, and failures retry with exponential backoff until
 * they FAIL. In-app notifications need no job (they are delivered on publish).
 */
export const NOTIFICATIONS_QUEUE = 'hrms-default';
export const DELIVER_PENDING_NOTIFICATIONS_JOB =
  'notifications.deliver-pending';
export const DELIVER_PENDING_NOTIFICATIONS_SCHEDULER =
  'notifications.deliver-pending.frequent';
export const DELIVER_PENDING_NOTIFICATIONS_CRON = '*/2 * * * *';

/**
 * The transport for organizations without their own (Gmail) sender: the deployment's SMTP
 * server when configured (Batch 2), else the development transport (which refuses to send in
 * production; Batch 8 (D2): those deliveries are suppressed as EMAIL_PROVIDER_NOT_CONFIGURED).
 */
export function defaultNotificationEmailTransport(
  env: Record<string, string | undefined> = process.env,
): NotificationEmailTransport {
  const smtp = smtpSettingsFromEnv(env);
  return smtp
    ? new SmtpNotificationEmailTransport(new SmtpMailer(smtp))
    : new DevNotificationEmailTransport(env.NODE_ENV === 'production');
}

export function parseDeliverPendingJobData(data: unknown) {
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== 'object' || Array.isArray(data))
  )
    throw new Error('Job data must be an object.');
  const input = (data ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => key !== 'batchSize');
  if (unknown.length > 0)
    throw new Error(`Unknown notification delivery parameter: ${unknown[0]}.`);
  if (
    input.batchSize !== undefined &&
    (!Number.isInteger(input.batchSize) ||
      (input.batchSize as number) < 1 ||
      (input.batchSize as number) > 500)
  )
    throw new Error('batchSize must be an integer between 1 and 500.');
  return { batchSize: input.batchSize as number | undefined };
}

export function deliverPendingNotifications(
  prisma: PrismaService,
  transport: NotificationEmailTransport = defaultNotificationEmailTransport(),
  options: {
    batchSize?: number;
    maxBatches?: number;
    organizationIds?: string[];
    clock?: { now(): Date };
    webOrigin?: string | null;
    sendTimeoutMs?: number;
  } = {},
): Promise<DeliverPendingOutcome> {
  const clock = options.clock ?? new NotificationsClock();
  const { settings } = notificationServices(prisma, clock);
  return new NotificationDeliveryService(prisma, settings, transport, clock, {
    webOrigin: options.webOrigin ?? process.env.WEB_ORIGIN ?? null,
  }).deliverPending({
    batchSize: options.batchSize,
    maxBatches: options.maxBatches,
    organizationIds: options.organizationIds,
    sendTimeoutMs: options.sendTimeoutMs,
  });
}

export async function runDeliverPendingNotificationsJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    transport?: NotificationEmailTransport;
  } = {},
): Promise<DeliverPendingOutcome> {
  const { batchSize } = parseDeliverPendingJobData(data);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl)
    throw new Error('DATABASE_URL must be configured for notification jobs.');
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await deliverPendingNotifications(prisma, options.transport, {
      batchSize,
    });
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}

// ─── Batch 8: event notifications ────────────────────────────────────────────

/**
 * Batch 8 (N1): publishes the notifications of committed business events (leave, time,
 * scheduling, payroll, benefits) from durable records through persistent checkpoints — see
 * notifications-events.ts. Every two minutes; idempotent (dedupe keys), so a retried or
 * overlapping run creates nothing twice. A failed event keeps its source's checkpoint before
 * it and fails the job (retried by the next run).
 */
export const PUBLISH_EVENT_NOTIFICATIONS_JOB = 'notifications.publish-events';
export const PUBLISH_EVENT_NOTIFICATIONS_SCHEDULER =
  'notifications.publish-events.frequent';
export const PUBLISH_EVENT_NOTIFICATIONS_CRON = '*/2 * * * *';

export function parsePublishEventsJobData(data: unknown) {
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== 'object' || Array.isArray(data))
  )
    throw new Error('Job data must be an object.');
  const input = (data ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => key !== 'sources');
  if (unknown.length > 0)
    throw new Error(`Unknown event notification parameter: ${unknown[0]}.`);
  if (
    input.sources !== undefined &&
    (!Array.isArray(input.sources) ||
      input.sources.some(
        (source) => !(EVENT_SOURCE_KEYS as readonly unknown[]).includes(source),
      ))
  )
    throw new Error(
      `sources must list event sources: ${EVENT_SOURCE_KEYS.join(', ')}.`,
    );
  return { sources: input.sources as string[] | undefined };
}

export async function runPublishEventNotificationsJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    clock?: { now(): Date };
  } = {},
): Promise<PublishEventsOutcome> {
  const { sources } = parsePublishEventsJobData(data);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl)
    throw new Error('DATABASE_URL must be configured for notification jobs.');
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await new EventNotificationPublisher(prisma, options.clock).run({
      sources,
    });
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}
