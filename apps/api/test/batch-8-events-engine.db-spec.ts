import { config } from 'dotenv';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  BOOTSTRAP_CURSOR_ID,
  EventNotificationPublisher,
  eventHorizon,
  type EventCursor,
  type EventSource,
} from '../src/notifications/notifications-events.js';
import { runPublishEventNotificationsJob } from '../src/notifications/notifications-jobs.js';
import type { PublishInput } from '../src/notifications/notification.service.js';
import { NOTIFICATION_USERS } from './support/notifications-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  type SchedulingFixtures,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

/**
 * Batch 8 (N1) — the event publisher's reliability on committed data: bootstrap, the horizon
 * behind open transactions, long outages, restarts and partially processed fan-out, failures
 * that never touch the business record, and concurrent runs. A probe source over audit rows
 * (entity type Batch8Probe) stands in for a domain: the same engine runs every real source.
 */
describe('Batch 8 event publisher (database, committed)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let key: string;
  let entityType: string;
  let recipients: string[];
  /** Recipients whose publish fails while set (simulated internal failure). */
  const failing = new Set<string>();

  type Probe = { id: string; occurredAt: Date; entityId: string | null };

  const probeSource = (): EventSource<Probe> => ({
    key,
    page: (client, after: EventCursor, horizon: Date, take: number) =>
      client.auditLog.findMany({
        where: {
          entityType,
          occurredAt: { lte: horizon },
          OR: [
            { occurredAt: { gt: after.at } },
            { occurredAt: after.at, id: { gt: after.id } },
          ],
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take,
        select: { id: true, occurredAt: true, entityId: true },
      }),
    cursorOf: (event) => ({ at: event.occurredAt, id: event.id }),
    notices: async (_client, event) =>
      recipients.map((recipientUserId): PublishInput => ({
        organizationId: fx.orgA,
        recipientUserId,
        // An unknown type makes publish throw: a simulated internal failure.
        type: failing.has(recipientUserId)
          ? 'batch8.unknown-type'
          : 'onboarding.tasks-due',
        variables: { overdueCount: 1, dueSoonCount: 0, taskTitles: 'Probe' },
        link: '/onboarding',
        dedupeKey: `batch8-probe:${event.id}`,
      })),
  });

  class ProbePublisher extends EventNotificationPublisher {
    override sources() {
      return [probeSource()] as EventSource<unknown>[];
    }
  }

  const publisher = () => new ProbePublisher(prisma);
  /** The database clock: a horizon every record created before it is committed under. */
  const dbNow = async () =>
    (
      await prisma.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS "now"`
    )[0]!.now;
  /**
   * Runs with the database clock as horizon (other suites' open transactions would hold a
   * computed one back); `computed` uses the real horizon with no margin.
   */
  const run = async (
    options: Parameters<EventNotificationPublisher['run']>[0] & {
      computed?: boolean;
    } = {},
  ) => {
    const { computed, ...rest } = options;
    return publisher().run(
      computed
        ? { horizonMarginMs: 0, ...rest }
        : { horizon: await dbNow(), ...rest },
    );
  };

  /** A committed business record (here an audit row) with an optional explicit timestamp. */
  const record = (occurredAt?: Date) =>
    prisma.auditLog.create({
      data: {
        action: 'BATCH8_PROBE',
        entityType,
        entityId: fx.orgA,
        ...(occurredAt ? { occurredAt } : {}),
      },
    });

  const noticesOf = (eventId: string) =>
    prisma.notification.findMany({
      where: { organizationId: fx.orgA, dedupeKey: `batch8-probe:${eventId}` },
      orderBy: { recipientUserId: 'asc' },
    });

  const checkpoint = () =>
    prisma.notificationProducerCheckpoint.findUnique({
      where: { producerKey: key },
    });

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, NOTIFICATION_USERS),
      { timeout: 60_000 },
    );
    const suffix = fx.suffix.toLowerCase().replace(/[^a-z0-9]/g, '');
    key = `events.batch8-probe-${suffix}`;
    entityType = `Batch8Probe${suffix}`;
    recipients = [fx.selfUser1, fx.selfUser2].sort();
  });

  afterAll(async () => {
    if (prisma && key) {
      await prisma.notificationProducerCheckpoint.deleteMany({
        where: { producerKey: key },
      });
    }
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  it('bootstraps at the horizon without notifying history, then publishes new events once', async () => {
    const history = await record();
    const first = await run();
    expect(first.sources[0]).toMatchObject({ bootstrapped: true, events: 0 });
    expect((await checkpoint())?.cursorId).toBe(BOOTSTRAP_CURSOR_ID);
    expect(await noticesOf(history.id)).toEqual([]);

    const event = await record();
    const second = await run();
    expect(second.sources[0]).toMatchObject({
      bootstrapped: false,
      events: 1,
      created: 2,
      failed: [],
    });
    expect((await noticesOf(event.id)).map((n) => n.recipientUserId)).toEqual(
      recipients,
    );
    // A replay (worker restart, overlapping run) creates nothing new.
    const replay = await run();
    expect(replay.sources[0]).toMatchObject({ events: 0, created: 0 });
    expect(await noticesOf(event.id)).toHaveLength(2);
    expect(await noticesOf(history.id)).toEqual([]);
  });

  it('never skips a record committed late by a transaction that was open at the last run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lateId = '';
    let opened!: () => void;
    const started = new Promise<void>((resolve) => (opened = resolve));
    // T1 starts first and writes its record (timestamped at its start) but commits last.
    const slow = prisma.$transaction(
      async (tx) => {
        const late = await tx.auditLog.create({
          data: { action: 'BATCH8_PROBE', entityType, entityId: fx.orgA },
        });
        lateId = late.id;
        opened();
        await gate;
      },
      { timeout: 60_000 },
    );
    await started;
    // T2 starts later and commits first.
    const early = await record();
    const during = await run({ computed: true });
    // The horizon stays behind T1's start: neither record is consumed yet (a naive "now"
    // cursor would publish T2's record and move past T1's forever).
    expect(new Date(during.horizon).getTime()).toBeLessThan(
      early.occurredAt.getTime(),
    );
    expect(await noticesOf(early.id)).toEqual([]);
    release();
    await slow;
    const after = await run();
    expect(after.sources[0]!.failed).toEqual([]);
    expect(await noticesOf(lateId)).toHaveLength(2);
    expect(await noticesOf(early.id)).toHaveLength(2);
  });

  it('(review M2) only the application role’s client transactions hold the horizon back', async () => {
    // Another database role's long transaction (a dump, an analytics session) must not stall
    // every notification; its records are not business events.
    await prisma.$executeRawUnsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrms_b8_other') THEN
        CREATE ROLE hrms_b8_other LOGIN PASSWORD 'b8-other-password';
      END IF;
    END $$`);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = 'hrms_b8_other';
    url.password = 'b8-other-password';
    const other = new PrismaService(url.toString());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let opened!: () => void;
    const started = new Promise<void>((resolve) => (opened = resolve));
    let otherStart!: Date;
    const slow = other.$transaction(
      async (tx) => {
        otherStart = (
          await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`
        )[0]!.now;
        opened();
        await gate;
      },
      { timeout: 60_000 },
    );
    try {
      await started;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const { horizon } = await eventHorizon(prisma, 0);
      // Another suite's own-role transaction that started earlier legitimately holds the
      // horizon (DB suites run in parallel); only then is the strict check skipped.
      const [{ earlier }] = await prisma.$queryRaw<Array<{ earlier: number }>>`
        SELECT count(*)::int AS "earlier" FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND backend_type = 'client backend' AND usename = current_user
          AND xact_start <= ${otherStart}`;
      if (earlier === 0)
        expect(horizon.getTime()).toBeGreaterThan(otherStart.getTime());
    } finally {
      release();
      await slow;
      await other.$disconnect();
    }
  });

  it('catches up after an outage far longer than any lookback, in pages and order', async () => {
    const before = await checkpoint();
    const old = Date.now() - 30 * 24 * 3_600_000;
    // A checkpoint left 30 days behind (the worker was down), with events throughout.
    await prisma.notificationProducerCheckpoint.delete({
      where: { producerKey: key },
    });
    await prisma.notificationProducerCheckpoint.create({
      data: {
        producerKey: key,
        cursorAt: new Date(old),
        cursorId: before!.cursorId,
      },
    });
    const events = [];
    for (let day = 29; day >= 1; day -= 4)
      events.push(await record(new Date(Date.now() - day * 24 * 3_600_000)));
    const outcome = await run({ pageSize: 2 });
    // Every event since the old checkpoint is published (this test rewound the checkpoint
    // by hand, so earlier records are re-checked too; those already notified add nothing).
    expect(outcome.sources[0]!.failed).toEqual([]);
    expect(outcome.sources[0]!.created).toBeGreaterThanOrEqual(
      events.length * 2,
    );
    for (const event of events)
      expect(await noticesOf(event.id)).toHaveLength(2);
  });

  it('resumes a partially processed fan-out after a failure without duplicates; the business record is untouched', async () => {
    const event = await record();
    failing.add(recipients[1]!);
    const failed = await run();
    failing.clear();
    // The first recipient was notified, the second failed: the run reports it and the
    // checkpoint stays before the event; the committed business record still exists.
    expect(failed.sources[0]!.failed).toHaveLength(1);
    expect((await noticesOf(event.id)).map((n) => n.recipientUserId)).toEqual([
      recipients[0],
    ]);
    const cp = await checkpoint();
    expect(
      cp!.cursorAt < event.occurredAt ||
        (cp!.cursorAt.getTime() === event.occurredAt.getTime() &&
          cp!.cursorId < event.id),
    ).toBe(true);
    expect(
      await prisma.auditLog.findUnique({ where: { id: event.id } }),
    ).not.toBeNull();
    // The job fails (so it is retried), the next run completes the fan-out once.
    const resumed = await run();
    expect(resumed.sources[0]).toMatchObject({
      failed: [],
      created: 1,
      existing: 1,
    });
    expect((await noticesOf(event.id)).map((n) => n.recipientUserId)).toEqual(
      recipients,
    );
  });

  it('concurrent runs publish each notice once and never move a checkpoint back', async () => {
    const events = [await record(), await record(), await record()];
    const results = await Promise.all([
      run({ pageSize: 1 }),
      run({ pageSize: 2 }),
      run(),
    ]);
    for (const result of results) expect(result.sources[0]!.failed).toEqual([]);
    for (const event of events)
      expect(await noticesOf(event.id)).toHaveLength(2);
    const last = events.at(-1)!;
    expect(await checkpoint()).toMatchObject({ cursorId: last.id });
    // The guard refuses moving a checkpoint back.
    await expect(
      prisma.notificationProducerCheckpoint.update({
        where: { producerKey: key },
        data: { cursorAt: new Date(0) },
      }),
    ).rejects.toThrow(/only moves forward/);
  });

  it('computes the horizon behind the oldest open transaction and the job validates its parameters', async () => {
    const { horizon, now } = await eventHorizon(prisma, 0);
    expect(horizon.getTime()).toBeLessThanOrEqual(now.getTime());
    const margin = await eventHorizon(prisma);
    expect(
      margin.now.getTime() - margin.horizon.getTime(),
    ).toBeGreaterThanOrEqual(2 * 60_000);
    await expect(
      runPublishEventNotificationsJob(
        { sources: ['events.unknown'] },
        { prisma },
      ),
    ).rejects.toThrow(/sources must list event sources/);
    await expect(
      runPublishEventNotificationsJob({ other: 1 }, { prisma }),
    ).rejects.toThrow(/Unknown event notification parameter/);
  });

  it('business services never publish notifications inside their transactions', () => {
    // N1: notifications come from committed records; a notification failure can never roll
    // back a business action because no business module calls the notification service.
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    for (const domain of [
      'leave',
      'time',
      'scheduling',
      'payroll',
      'benefits',
    ]) {
      for (const file of readdirSync(join(root, domain))) {
        if (!file.endsWith('.ts')) continue;
        const text = readFileSync(join(root, domain, file), 'utf8');
        expect(text, `${domain}/${file}`).not.toMatch(
          /from '\.\.\/notifications\/|NotificationService/,
        );
      }
    }
  });
});
