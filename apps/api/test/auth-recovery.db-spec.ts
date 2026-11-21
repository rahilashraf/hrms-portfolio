import type { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { config } from 'dotenv';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNT_EMAIL_QUEUE,
  AccountEmailJobError,
  DELIVER_ACCOUNT_EMAIL_JOB,
  deliverAccountRecoveryEmail,
  parseAccountEmailJobData,
  runDeliverAccountEmailJob,
} from '../src/auth/account-email-jobs.js';
import { AccountRecoveryQueue } from '../src/auth/account-recovery-queue.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  authServices,
  createLogin,
  META,
  NEW_PASSWORD,
  PASSWORD,
  RecordingEmails,
  statusOf,
} from './support/auth-fixtures.js';
import {
  createSchedulingFixtures,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const usableTokens = (
  tx: Tx,
  userId: string,
  type: 'PASSWORD_RESET' | 'EMAIL_VERIFICATION',
) =>
  tx.accountToken.count({
    where: { userId, type, usedAt: null, expiresAt: { gt: new Date() } },
  });

/**
 * Batch 2 (D6): account recovery through the worker. The API queues one job per request for
 * known and unknown addresses alike; the worker issues, sends and audits the single-use link.
 */
describe('Account recovery email jobs (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (h: {
      tx: Tx;
      fx: SchedulingFixtures;
      client: PrismaService;
      services: ReturnType<typeof authServices>;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, {});
          const client = rollbackClient(tx);
          await run({ tx, fx, client, services: authServices(client) }).catch(
            (error: unknown) => {
              console.error('SCENARIO FAILURE', error);
              throw error;
            },
          );
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('queues one identical job for known and unknown addresses; only the known one gets a link', async () => {
    await scenario(async ({ tx, fx, client, services }) => {
      const { auth, recovery, emails } = services;
      const ada = await createLogin(tx, fx, 'ada');
      const known = await auth.forgotPassword(ada.email);
      const unknown = await auth.forgotPassword(
        `nobody-${fx.suffix}@example.com`,
      );
      expect(known).toEqual(unknown);
      expect(recovery.jobs).toEqual([
        {
          kind: 'password-reset',
          userId: ada.id,
          requestedAt: expect.any(String),
        },
        {
          kind: 'password-reset',
          userId: null,
          requestedAt: expect.any(String),
        },
      ]);
      // Nothing was issued or sent by the API itself.
      expect(await usableTokens(tx, ada.id, 'PASSWORD_RESET')).toBe(0);
      expect(emails.sent).toEqual([]);

      expect(await recovery.deliver(client, emails)).toEqual([
        { status: 'SENT' },
        { status: 'SKIPPED', reason: 'NO_ACCOUNT' },
      ]);
      expect(emails.sent).toHaveLength(1);
      expect(emails.sent[0]).toMatchObject({
        kind: 'password-reset',
        message: { email: ada.email, userId: ada.id },
      });
      const audit = await tx.auditLog.findMany({
        where: { action: 'AUTH_PASSWORD_RESET_REQUESTED', entityId: ada.id },
      });
      expect(audit.map((entry) => entry.metadata)).toEqual([
        { outcome: 'SENT' },
      ]);
      expect(JSON.stringify(audit)).not.toContain(
        emails.sent[0]!.message.token,
      );

      // The link works once.
      await auth.resetPassword(
        emails.sent[0]!.message.token,
        NEW_PASSWORD,
        META,
      );
      expect(
        statusOf(
          await rejection(
            auth.resetPassword(
              emails.sent[0]!.message.token,
              'Yet-Another-Pass-11',
              META,
            ),
          ),
        ),
      ).toBe(401);
    });
  });

  it('re-checks eligibility at delivery and skips requests older than the link lifetime', async () => {
    await scenario(async ({ tx, fx, client, services }) => {
      const { auth, recovery, emails } = services;
      const ada = await createLogin(tx, fx, 'ada');
      await auth.forgotPassword(ada.email);
      await tx.user.update({
        where: { id: ada.id },
        data: { status: 'DISABLED' },
      });
      expect(await recovery.deliver(client, emails)).toEqual([
        { status: 'SKIPPED', reason: 'NOT_ELIGIBLE' },
      ]);

      const bob = await createLogin(tx, fx, 'bob');
      const stale = {
        kind: 'password-reset' as const,
        userId: bob.id,
        requestedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      };
      expect(await deliverAccountRecoveryEmail(client, emails, stale)).toEqual({
        status: 'SKIPPED',
        reason: 'STALE',
      });
      expect(await usableTokens(tx, bob.id, 'PASSWORD_RESET')).toBe(0);
      expect(emails.sent).toEqual([]);
    });
  });

  it('withdraws the link when delivery fails, retries with a fresh one and voids the earlier link', async () => {
    await scenario(async ({ tx, fx, client, services }) => {
      const { auth, recovery } = services;
      const ada = await createLogin(tx, fx, 'ada');
      await auth.forgotPassword(ada.email);
      const [job] = recovery.jobs.splice(0);
      const failing = new RecordingEmails();
      failing.failing = true;
      const error = await rejection(
        deliverAccountRecoveryEmail(client, failing, job!),
      );
      expect(error).toBeInstanceOf(AccountEmailJobError);
      expect((error as AccountEmailJobError).retryable).toBe(true);
      expect((error as Error).message).toContain(
        'ACCOUNT_EMAIL_DELIVERY_FAILED',
      );
      expect((error as Error).message).not.toContain(ada.email);
      expect(await usableTokens(tx, ada.id, 'PASSWORD_RESET')).toBe(0);

      // The retry issues a new link; a link from an earlier attempt stops working.
      const first = new RecordingEmails();
      await deliverAccountRecoveryEmail(client, first, job!);
      const second = new RecordingEmails();
      await deliverAccountRecoveryEmail(client, second, job!);
      expect(await usableTokens(tx, ada.id, 'PASSWORD_RESET')).toBe(1);
      expect(
        statusOf(
          await rejection(
            auth.resetPassword(
              first.sent[0]!.message.token,
              NEW_PASSWORD,
              META,
            ),
          ),
        ),
      ).toBe(401);
      await auth.resetPassword(
        second.sent[0]!.message.token,
        NEW_PASSWORD,
        META,
      );
      expect(
        (
          await tx.auditLog.findMany({
            where: {
              action: 'AUTH_PASSWORD_RESET_REQUESTED',
              entityId: ada.id,
            },
            orderBy: { occurredAt: 'asc' },
          })
        ).map((entry) => (entry.metadata as { outcome: string }).outcome),
      ).toEqual(['DELIVERY_FAILED', 'SENT', 'SENT']);
    });
  });

  it('lets a user who must change their password recover it by email, which clears the requirement and ends sessions', async () => {
    await scenario(async ({ tx, fx, client, services }) => {
      const { auth, recovery, emails, sessions } = services;
      const ada = await createLogin(tx, fx, 'ada', {
        mustChangePassword: true,
      });
      await auth.login(ada.email, PASSWORD, META);
      const session = await tx.authSession.findFirstOrThrow({
        where: { userId: ada.id },
      });
      await auth.forgotPassword(ada.email);
      await recovery.deliver(client, emails);
      await auth.resetPassword(
        emails.sent[0]!.message.token,
        NEW_PASSWORD,
        META,
      );
      expect(
        await tx.user.findUniqueOrThrow({ where: { id: ada.id } }),
      ).toMatchObject({
        mustChangePassword: false,
      });
      expect(
        await sessions.findActiveByIdAndUser(session.id, ada.id, new Date()),
      ).toBeNull();
      const result = await auth.login(ada.email, NEW_PASSWORD, META);
      expect(result.identity.mustChangePassword).toBe(false);
    });
  });

  it('sends verification links only to unverified accounts', async () => {
    await scenario(async ({ tx, fx, client, services }) => {
      const { auth, recovery, emails } = services;
      const verified = await createLogin(tx, fx, 'ver');
      const unverified = await createLogin(tx, fx, 'unver');
      await tx.user.update({
        where: { id: unverified.id },
        data: { emailVerifiedAt: null },
      });
      await auth.resendVerification(verified.email, META);
      await auth.resendVerification(unverified.email, META);
      expect(recovery.jobs.map((job) => job.userId)).toEqual([
        null,
        unverified.id,
      ]);
      await recovery.deliver(client, emails);
      expect(emails.sent).toEqual([
        expect.objectContaining({
          kind: 'verification',
          message: expect.objectContaining({ userId: unverified.id }),
        }),
      ]);
      await auth.verifyEmail(emails.sent[0]!.message.token, META);
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: unverified.id } }))
          .emailVerifiedAt,
      ).not.toBeNull();
    });
  });

  it('runs as a worker job with the deployment email composition, and refuses malformed jobs permanently', async () => {
    await scenario(async ({ tx, fx, client }) => {
      const ada = await createLogin(tx, fx, 'ada');
      const job = {
        kind: 'password-reset',
        userId: ada.id,
        requestedAt: new Date().toISOString(),
      };
      // No Gmail connection and no SMTP: development's in-memory service delivers.
      await expect(
        runDeliverAccountEmailJob(job, {
          prisma: client,
          env: { NODE_ENV: 'test' },
        }),
      ).resolves.toEqual({ status: 'SENT' });
      // In production without any provider the job fails retryably (and leaves no usable link).
      const unavailable = await rejection(
        runDeliverAccountEmailJob(job, {
          prisma: client,
          env: {
            NODE_ENV: 'production',
            WEB_ORIGIN: 'https://hrms.example.com',
          },
        }),
      );
      expect(unavailable).toMatchObject({ retryable: true });
      expect((unavailable as Error).message).toContain(
        'ACCOUNT_EMAIL_UNAVAILABLE',
      );
      // The attempt superseded the earlier link and withdrew its own.
      expect(await usableTokens(tx, ada.id, 'PASSWORD_RESET')).toBe(0);

      for (const bad of [
        null,
        [],
        { ...job, kind: 'invitation' },
        { ...job, userId: 'not-a-uuid' },
        { ...job, requestedAt: 'yesterday' },
        { ...job, email: 'ada@example.com' },
      ]) {
        const error = (() => {
          try {
            parseAccountEmailJobData(bad);
          } catch (caught) {
            return caught;
          }
          return null;
        })();
        expect(error, JSON.stringify(bad)).toMatchObject({ retryable: false });
      }
    });
  });

  it('puts the job on the worker queue in Redis with retries, carrying no address or token', async () => {
    const marker = new Date(Date.now() - 1234).toISOString();
    const queue = new AccountRecoveryQueue({
      getOrThrow: () => process.env.REDIS_URL,
    } as unknown as ConfigService);
    const connection = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null,
    });
    const reader = new Queue(ACCOUNT_EMAIL_QUEUE, { connection });
    try {
      await queue.enqueue({
        kind: 'password-reset',
        userId: null,
        requestedAt: marker,
      });
      const jobs = (
        await reader.getJobs(['waiting', 'delayed', 'prioritized'])
      ).filter(
        (job) =>
          job.name === DELIVER_ACCOUNT_EMAIL_JOB &&
          (job.data as { requestedAt?: string }).requestedAt === marker,
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.data).toEqual({
        kind: 'password-reset',
        userId: null,
        requestedAt: marker,
      });
      expect(jobs[0]!.opts).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
      });
      await jobs[0]!.remove();
    } finally {
      await reader.close();
      connection.disconnect();
      await queue.onModuleDestroy();
    }
  });
});
