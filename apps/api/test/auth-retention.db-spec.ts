import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  pruneAuthRecords,
  runPruneAuthRecordsJob,
} from '../src/sessions/auth-retention-jobs.js';
import { createLogin } from './support/auth-fixtures.js';
import {
  createSchedulingFixtures,
  rejection,
  rollbackClient,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);

/**
 * Batch 2 (D3): sessions revoked or expired over 90 days ago and account tokens used or expired
 * over 30 days ago are deleted; live sessions and usable tokens never are.
 */
describe('Sign-in record retention (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('deletes nothing while switched off; when on, deletes only records past retention, in batches', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const startedAt = new Date();
          const fx = await createSchedulingFixtures(tx, {});
          const client = rollbackClient(tx);
          const ada = await createLogin(tx, fx, 'ada');
          const session = (
            label: string,
            data: { revokedAt?: Date; expiresAt: Date },
          ) =>
            tx.authSession.create({
              data: {
                userId: ada.id,
                refreshTokenHash: `${label}-${fx.suffix}`,
                createdAt: ago(200),
                ...data,
              },
            });
          const keep = [
            await session('live', { expiresAt: ahead(10) }),
            await session('revoked-recently', {
              revokedAt: ago(10),
              expiresAt: ago(5),
            }),
            await session('expired-recently', { expiresAt: ago(60) }),
          ];
          const remove = [
            await session('revoked-long-ago', {
              revokedAt: ago(91),
              expiresAt: ago(80),
            }),
            await session('expired-long-ago', { expiresAt: ago(91) }),
            await session('revoked-and-expired', {
              revokedAt: ago(120),
              expiresAt: ago(100),
            }),
          ];
          const token = (
            label: string,
            data: { usedAt?: Date; expiresAt: Date },
          ) =>
            tx.accountToken.create({
              data: {
                userId: ada.id,
                type: 'PASSWORD_RESET',
                tokenHash: `${label}-${fx.suffix}`,
                createdAt: ago(100),
                ...data,
              },
            });
          const keepTokens = [
            await token('usable', { expiresAt: ahead(1) }),
            await token('used-recently', { usedAt: ago(5), expiresAt: ago(4) }),
            await token('expired-recently', { expiresAt: ago(29) }),
          ];
          const removeTokens = [
            await token('used-long-ago', {
              usedAt: ago(31),
              expiresAt: ago(30),
            }),
            await token('expired-long-ago', { expiresAt: ago(31) }),
          ];

          // Disabled (the default): the scheduled run deletes nothing.
          const ids = async () => ({
            sessions: (
              await tx.authSession.findMany({ where: { userId: ada.id } })
            )
              .map((row) => row.id)
              .sort(),
            tokens: (
              await tx.accountToken.findMany({ where: { userId: ada.id } })
            )
              .map((row) => row.id)
              .sort(),
          });
          const before = await ids();
          for (const env of [{}, { AUTH_RECORD_RETENTION_ENABLED: 'false' }])
            expect(
              await runPruneAuthRecordsJob({}, { prisma: client, env }),
            ).toEqual({
              enabled: false,
              sessionsDeleted: 0,
              tokensDeleted: 0,
              complete: true,
            });
          expect(await ids()).toEqual(before);
          expect(before.sessions).toHaveLength(keep.length + remove.length);
          expect(
            await tx.auditLog.count({
              where: {
                action: 'AUTH_RECORDS_PRUNED',
                occurredAt: { gte: startedAt },
              },
            }),
          ).toBe(0);

          // Enabled: the scheduled run deletes what is past retention.
          const viaJob = await runPruneAuthRecordsJob(
            {},
            { prisma: client, env: { AUTH_RECORD_RETENTION_ENABLED: 'true' } },
          );
          expect(viaJob.enabled).toBe(true);
          expect(viaJob.complete).toBe(true);
          expect(viaJob.sessionsDeleted).toBeGreaterThanOrEqual(remove.length);
          expect(await ids()).toEqual({
            sessions: keep.map((row) => row.id).sort(),
            tokens: keepTokens.map((row) => row.id).sort(),
          });
          // Put the expired rows back to exercise the batching directly.
          for (const row of remove) await tx.authSession.create({ data: row });
          for (const row of removeTokens)
            await tx.accountToken.create({ data: row });

          const outcome = await pruneAuthRecords(client, { batchSize: 1 });
          expect(outcome.complete).toBe(true);
          expect(outcome.sessionsDeleted).toBeGreaterThanOrEqual(remove.length);
          expect(outcome.tokensDeleted).toBeGreaterThanOrEqual(
            removeTokens.length,
          );
          expect(
            (await tx.authSession.findMany({ where: { userId: ada.id } }))
              .map((row) => row.id)
              .sort(),
          ).toEqual(keep.map((row) => row.id).sort());
          expect(
            (await tx.accountToken.findMany({ where: { userId: ada.id } }))
              .map((row) => row.id)
              .sort(),
          ).toEqual(keepTokens.map((row) => row.id).sort());
          const recorded = await tx.auditLog.findMany({
            where: { action: 'AUTH_RECORDS_PRUNED' },
            orderBy: { occurredAt: 'desc' },
            take: 1,
          });
          expect(recorded[0]!.metadata).toEqual({
            sessionsDeleted: outcome.sessionsDeleted,
            tokensDeleted: outcome.tokensDeleted,
          });

          // A second run finds nothing more of this account's and records nothing new.
          const again = await pruneAuthRecords(client);
          expect(again).toEqual({
            sessionsDeleted: 0,
            tokensDeleted: 0,
            complete: true,
          });
          expect(
            await tx.auditLog.count({
              where: {
                action: 'AUTH_RECORDS_PRUNED',
                occurredAt: { gte: startedAt },
              },
            }),
          ).toBe(2);
          expect(
            (
              (await rejection(
                runPruneAuthRecordsJob(
                  { days: 1 },
                  {
                    prisma: client,
                    env: { AUTH_RECORD_RETENTION_ENABLED: 'true' },
                  },
                ),
              )) as Error
            ).message,
          ).toContain('takes no parameters');
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });
});
