import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { GoogleWorkspaceEmailTransport } from '../src/integrations/google/google-workspace.adapters.js';
import type { GoogleApiClient } from '../src/integrations/google/google-api.client.js';
import type { GoogleWorkspaceRuntime } from '../src/integrations/google/google-workspace-runtime.js';
import {
  DevNotificationEmailTransport,
  type NotificationEmailMessage,
} from '../src/notifications/notification-email.transport.js';
import {
  EMAIL_MAX_AGE_MS,
  SEND_LEASE_MS,
  validateTemplateText,
} from '../src/notifications/notifications-domain.js';
import { deliverPendingNotifications } from '../src/notifications/notifications-jobs.js';
import { notificationServices } from '../src/notifications/notifications-producers.js';
import type { PublishInput } from '../src/notifications/notification.service.js';
import {
  NOTIFICATION_USERS,
  RecordingTransport,
} from './support/notifications-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  type SchedulingFixtures,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

/**
 * Batch 8 — delivery reliability regressions (D1–D3, O1, O2). These run on committed data:
 * overlapping workers are separate claims and transactions, which a rollback scenario hides.
 */
describe('Batch 8 delivery reliability (database)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let counter = 0;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, NOTIFICATION_USERS),
      { timeout: 60_000 },
    );
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  const publish = async (recipientUserId: string, at?: Date) => {
    counter += 1;
    const clock = { now: () => at ?? new Date() };
    const input: PublishInput = {
      organizationId: fx.orgA,
      recipientUserId,
      type: 'onboarding.tasks-due',
      variables: { overdueCount: 1, dueSoonCount: 0, taskTitles: 'Accounts' },
      link: '/onboarding',
      dedupeKey: `b8-delivery-${fx.suffix}-${counter}`,
    };
    const result = await notificationServices(
      prisma,
      clock,
    ).notifications.publish(input);
    if (result.outcome !== 'CREATED') throw new Error('not created');
    return result.notification.id;
  };

  const emailOf = (notificationId: string) =>
    prisma.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId, channel: 'EMAIL' } },
      include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
    });

  it('D1: a worker whose batch outlives its lease never sends a delivery another worker reclaimed', async () => {
    const ids = [await publish(fx.selfUser1), await publish(fx.selfUser2)];
    const t0 = new Date(Date.now() + 60_000);
    // Worker A claims the batch at t0 (lease t0 + 5 min); its sends start 4.5 minutes later
    // (earlier sends of a large batch were slow).
    let calls = 0;
    const aClock = {
      now: () =>
        calls++ === 0 ? t0 : new Date(t0.getTime() + SEND_LEASE_MS - 30_000),
    };
    const b = new RecordingTransport();
    const a = new RecordingTransport();
    const send = a.send.bind(a);
    let first = true;
    a.send = async (message: NotificationEmailMessage) => {
      if (first) {
        first = false;
        // While A's first send is in flight, a second worker (another process or an
        // overlapping deploy) runs after the batch lease ended and reclaims the rest.
        await deliverPendingNotifications(prisma, b, {
          batchSize: 10,
          maxBatches: 1,
          organizationIds: [fx.orgA],
          clock: { now: () => new Date(t0.getTime() + SEND_LEASE_MS + 60_000) },
        });
      }
      return send(message);
    };
    const outcome = await deliverPendingNotifications(prisma, a, {
      batchSize: 10,
      maxBatches: 1,
      organizationIds: [fx.orgA],
      clock: aClock,
    });
    const handed = [...a.sent, ...b.sent]
      .map((m) => m.notificationId)
      .filter((id) => ids.includes(id));
    // Each email is handed to a transport once.
    expect(handed.sort()).toEqual([...ids].sort());
    expect(outcome.lost).toBe(1);
    for (const id of ids) {
      const row = await emailOf(id);
      expect(row.status).toBe('SENT');
      // The record matches what happened: one succeeded attempt, abandoned ones only for
      // claims that never sent.
      expect(row.attempts.filter((x) => x.status === 'SUCCEEDED')).toHaveLength(
        1,
      );
    }
  });

  it('D1: a send that outlives its time budget is recorded as uncertain and never retried automatically', async () => {
    const id = await publish(fx.selfUser1);
    const slow = new RecordingTransport(() => null, 300);
    const outcome = await deliverPendingNotifications(prisma, slow, {
      organizationIds: [fx.orgA],
      sendTimeoutMs: 50,
    });
    expect(outcome.uncertain).toBeGreaterThanOrEqual(1);
    const row = await emailOf(id);
    expect(row).toMatchObject({
      status: 'FAILED',
      lastErrorCode: 'DELIVERY_OUTCOME_UNCERTAIN',
    });
    expect(row.attempts).toEqual([
      expect.objectContaining({
        status: 'UNCERTAIN',
        errorCode: 'SEND_TIMEOUT',
      }),
    ]);
    // Nothing resends it.
    const again = new RecordingTransport();
    await deliverPendingNotifications(prisma, again, {
      organizationIds: [fx.orgA],
    });
    expect(again.sent.map((m) => m.notificationId)).not.toContain(id);
  });

  it('D1 (review M1): a claim whose send may have started is never resent after its lease ends; a stale worker never overwrites', async () => {
    const id = await publish(fx.selfUser1);
    const t0 = new Date(Date.now() + 60_000);
    let now = t0;
    const b = new RecordingTransport();
    const a = new RecordingTransport();
    const send = a.send.bind(a);
    let reclaim: Awaited<
      ReturnType<typeof deliverPendingNotifications>
    > | null = null;
    a.send = async (message: NotificationEmailMessage) => {
      // Worker A renewed its lease and handed the message to the provider, then stopped (a
      // crash during a deploy, a frozen VM). Another worker runs after the lease ended.
      now = new Date(t0.getTime() + SEND_LEASE_MS + 60_000);
      reclaim = await deliverPendingNotifications(prisma, b, {
        organizationIds: [fx.orgA],
        clock: { now: () => now },
      });
      return send(message);
    };
    const outcome = await deliverPendingNotifications(prisma, a, {
      organizationIds: [fx.orgA],
      clock: { now: () => now },
    });
    // The other worker does not send it again: the outcome is unknown, recorded as such.
    expect(b.sent.map((m) => m.notificationId)).not.toContain(id);
    expect(reclaim!.uncertain).toBeGreaterThanOrEqual(1);
    // A's late result never overwrites what was recorded.
    expect(outcome.lost).toBe(1);
    const row = await emailOf(id);
    expect(row).toMatchObject({
      status: 'FAILED',
      lastErrorCode: 'DELIVERY_OUTCOME_UNCERTAIN',
    });
    expect(row.attempts).toEqual([
      expect.objectContaining({
        status: 'UNCERTAIN',
        errorCode: 'LEASE_EXPIRED_DURING_SEND',
      }),
    ]);
  });

  it('D1: a claim that never reached its send is reclaimed and sent (abandoned, not uncertain)', async () => {
    const id = await publish(fx.selfUser1);
    const t0 = new Date(Date.now() + 60_000);
    // A claim made by a worker that stopped before its send (never renewed): simulated by a
    // claim-only transaction like the worker's.
    await prisma.$transaction(async (tx) => {
      const delivery = await tx.notificationDelivery.findUniqueOrThrow({
        where: {
          notificationId_channel: { notificationId: id, channel: 'EMAIL' },
        },
      });
      await tx.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'SENDING',
          attemptCount: 1,
          leaseExpiresAt: new Date(t0.getTime() + SEND_LEASE_MS),
        },
      });
      await tx.notificationDeliveryAttempt.create({
        data: {
          deliveryId: delivery.id,
          organizationId: fx.orgA,
          attemptNumber: 1,
          status: 'STARTED',
          provider: 'test',
          startedAt: t0,
        },
      });
    });
    const b = new RecordingTransport();
    await deliverPendingNotifications(prisma, b, {
      organizationIds: [fx.orgA],
      clock: { now: () => new Date(t0.getTime() + SEND_LEASE_MS + 60_000) },
    });
    expect(b.sent.map((m) => m.notificationId)).toContain(id);
    const row = await emailOf(id);
    expect(row.status).toBe('SENT');
    expect(row.attempts.map((x) => x.status)).toEqual([
      'ABANDONED',
      'SUCCEEDED',
    ]);
  });

  it('D2: with no email provider configured, email is suppressed with a reason instead of exhausting retries', async () => {
    const id = await publish(fx.selfUser1);
    const outcome = await deliverPendingNotifications(
      prisma,
      new DevNotificationEmailTransport(true),
      { organizationIds: [fx.orgA] },
    );
    expect(outcome.providerNotConfigured).toBeGreaterThanOrEqual(1);
    const row = await emailOf(id);
    expect(row).toMatchObject({
      status: 'SUPPRESSED',
      suppressedReason: 'EMAIL_PROVIDER_NOT_CONFIGURED',
      attemptCount: 1,
    });
    expect(row.attempts).toEqual([
      expect.objectContaining({
        status: 'PERMANENT_FAILURE',
        errorCode: 'EMAIL_PROVIDER_NOT_CONFIGURED',
        provider: 'none',
      }),
    ]);
    // In-app delivery is untouched.
    const inApp = await prisma.notificationDelivery.findUniqueOrThrow({
      where: {
        notificationId_channel: { notificationId: id, channel: 'IN_APP' },
      },
    });
    expect(inApp.status).toBe('SENT');
  });

  it('D3: each attempt records the provider that actually handled it', async () => {
    const id = await publish(fx.selfUser1);
    const fallback = new RecordingTransport();
    const router = new GoogleWorkspaceEmailTransport(
      { connectionFor: async () => null } as unknown as GoogleWorkspaceRuntime,
      {} as GoogleApiClient,
      fallback,
    );
    await deliverPendingNotifications(prisma, router, {
      organizationIds: [fx.orgA],
    });
    const row = await emailOf(id);
    expect(row.status).toBe('SENT');
    expect(row.attempts).toEqual([
      expect.objectContaining({ status: 'SUCCEEDED', provider: 'test' }),
    ]);
  });

  it('O1: email that waited past its maximum age (e.g. while the module was disabled) is suppressed, not sent', async () => {
    const old = new Date(Date.now() - EMAIL_MAX_AGE_MS - 60_000);
    const id = await publish(fx.selfUser1, old);
    const fresh = await publish(fx.selfUser2);
    const transport = new RecordingTransport();
    await deliverPendingNotifications(prisma, transport, {
      organizationIds: [fx.orgA],
    });
    const sent = transport.sent.map((m) => m.notificationId);
    expect(sent).not.toContain(id);
    expect(sent).toContain(fresh);
    expect(await emailOf(id)).toMatchObject({
      status: 'SUPPRESSED',
      suppressedReason: 'DELIVERY_EXPIRED',
      attemptCount: 0,
    });
  });

  it('O2: template text refuses bare domains as well as URLs', () => {
    for (const text of [
      'Reset at hrms-login.example.com/reset now',
      'Visit example.com',
      'See portal.example.org.',
    ]) {
      expect(() => validateTemplateText(text, 'Body', [])).toThrow(
        /must not contain links/,
      );
    }
    expect(() =>
      validateTemplateText(
        'Leave approved, e.g. for 2026-03-16. Thanks.',
        'Your leave {{startDate}} was approved.',
        ['startDate'],
      ),
    ).not.toThrow();
  });
});
