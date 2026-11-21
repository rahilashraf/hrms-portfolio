import type { PrismaService } from '../../src/database/prisma.service.js';
import {
  EventNotificationPublisher,
  type PublishEventsOutcome,
} from '../../src/notifications/notifications-events.js';
import type { Tx } from './scheduling-fixtures.js';

/** The lowest cursor id: every event at or after the primed instant is published. */
export const ZERO_CURSOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Batch 8 — puts the given event sources' checkpoints just before `at` inside a scenario
 * transaction (rolled back with it), so a test publishes exactly the events recorded from then
 * on. Committed checkpoints of other runs are untouched once the scenario rolls back.
 */
export async function primeEventCheckpoints(
  tx: Tx,
  sources: readonly string[],
  at: Date,
) {
  for (const producerKey of [...sources].sort()) {
    await tx.notificationProducerCheckpoint.deleteMany({
      where: { producerKey },
    });
    await tx.notificationProducerCheckpoint.create({
      data: {
        producerKey,
        cursorAt: new Date(at.getTime() - 1),
        cursorId: ZERO_CURSOR_ID,
      },
    });
  }
}

/** The scenario transaction's start (the `now()` its rows default to). */
export async function transactionStart(tx: Tx) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`;
  return row!.now;
}

/**
 * Runs the event publisher with an explicit horizon: inside a scenario transaction the
 * computed horizon would stay behind the scenario's own open transaction.
 */
export function publishEvents(
  client: PrismaService,
  sources: readonly string[],
  options: { horizon?: Date; pageSize?: number; maxEvents?: number } = {},
): Promise<PublishEventsOutcome> {
  return new EventNotificationPublisher(client).run({
    sources,
    horizon: options.horizon ?? new Date(Date.now() + 10 * 60_000),
    pageSize: options.pageSize,
    maxEvents: options.maxEvents,
  });
}

/** The notifications of a type in an organization (all recipients), oldest first. */
export function noticesOf(tx: Tx, organizationId: string, type: string) {
  return tx.notification.findMany({
    where: { organizationId, type },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { deliveries: true },
  });
}
