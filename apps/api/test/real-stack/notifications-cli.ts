import { PrismaService } from '../../src/database/prisma.service.js';
import { EventNotificationPublisher } from '../../src/notifications/notifications-events.js';
import { deliverPendingNotifications } from '../../src/notifications/notifications-jobs.js';
import {
  assertDisposableDatabase,
  assertDisposableDatabaseUrl,
} from './disposable-database.js';

/**
 * Batch 8 real-stack notification commands (from apps/api, with REAL_STACK_E2E=1 and
 * DATABASE_URL on a marked disposable database) — what the worker's two jobs do:
 *
 *   tsx test/real-stack/notifications-cli.ts publish   # notifications.publish-events
 *   tsx test/real-stack/notifications-cli.ts deliver   # notifications.deliver-pending
 *
 * The first `publish` bootstraps the checkpoints (history is never notified). `publish` uses
 * the computed horizon (behind open transactions) without the two-minute clock margin, so a
 * test need not wait; `deliver` uses the default email transport (development transport).
 */
async function main() {
  const command = process.argv[2];
  if (command !== 'publish' && command !== 'deliver')
    throw new Error('Usage: notifications-cli.ts publish|deliver');
  const { url } = assertDisposableDatabaseUrl(process.env);
  const prisma = new PrismaService(url);
  try {
    await prisma.$connect();
    await assertDisposableDatabase(prisma, process.env);
    const outcome =
      command === 'publish'
        ? await new EventNotificationPublisher(prisma).run({
            horizonMarginMs: 0,
          })
        : await deliverPendingNotifications(prisma);
    console.info(JSON.stringify(outcome));
    if (
      command === 'publish' &&
      'sources' in outcome &&
      outcome.sources.some((source) => source.failed.length > 0)
    )
      process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
