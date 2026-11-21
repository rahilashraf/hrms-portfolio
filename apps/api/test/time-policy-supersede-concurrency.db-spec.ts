import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { TimePolicyService } from '../src/time/time-policy.service.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  schedulingServices,
  type SchedulingFixtures,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

const USERS = {
  adminA: [{ permissions: ['time.manage_policy'], scope: 'org' as const }],
  adminA2: [{ permissions: ['time.manage_policy'], scope: 'org' as const }],
  adminB: [{ permissions: ['time.manage_policy'], scope: 'orgB' as const }],
};

const codeOf = (error: unknown) =>
  (error as { getResponse?: () => { code?: string } }).getResponse?.().code ??
  String(error);

/**
 * Batch 4E-2 (B3) on committed data with real transactions: two administrators replacing the
 * same layer at once (one wins, the other is told it changed), and a replacement that fails after
 * the current layer was already ended in the transaction (nothing at all is kept).
 */
describe('Policy supersede atomicity and concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let policies: TimePolicyService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, USERS, ['time.manage_policy']),
      {
        timeout: 60_000,
      },
    );
    const svc = schedulingServices(prisma);
    policies = new TimePolicyService(
      prisma,
      svc.authorization,
      svc.targets,
      svc.audit,
    );
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  const organizationLayer = (
    organizationId: string,
    from: string,
    to: string | null = null,
  ) =>
    prisma.timeAttendancePolicy.create({
      data: {
        scopeType: 'ORGANIZATION',
        organizationId,
        effectiveFrom: new Date(`${from}T00:00:00.000Z`),
        effectiveTo: to ? new Date(`${to}T00:00:00.000Z`) : null,
        config: { clock: { mode: 'LIVE_CLOCK' } },
      },
    });

  it('lets one of two administrators replace a layer; the other is told it changed', async () => {
    const layer = await organizationLayer(fx.orgA, '2026-01-01');
    const seen = layer.updatedAt.toISOString();
    const replace = (userId: string, effectiveFrom: string) =>
      policies.supersede(
        userId,
        layer.id,
        {
          effectiveFrom,
          expectedUpdatedAt: seen,
          config: { clock: { mode: 'LIVE_CLOCK' }, breaks: { mode: 'NONE' } },
        },
        ctx(userId),
      );
    const results = await Promise.allSettled([
      replace(fx.users.adminA!, '2027-01-01'),
      replace(fx.users.adminA2!, '2027-02-01'),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      .map((result) => codeOf(result.reason));
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toEqual(['TIME_POLICY_CHANGED']);
    const layers = await prisma.timeAttendancePolicy.findMany({
      where: { organizationId: fx.orgA, scopeType: 'ORGANIZATION' },
      orderBy: { effectiveFrom: 'asc' },
    });
    // The original (ended once) and exactly one replacement.
    expect(layers).toHaveLength(2);
    expect(layers[0]!.id).toBe(layer.id);
    expect(layers[0]!.effectiveTo).not.toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { entityId: layer.id, action: 'TIME_POLICY_SUPERSEDED' },
      }),
    ).toBe(1);
  });

  it('keeps nothing when the replacement cannot be created after the layer was ended', async () => {
    const layer = await organizationLayer(fx.orgB, '2026-01-01');
    // An inconsistent layer written around the API (no database constraint stops it) that the
    // replacement would overlap: the insert is refused after the current layer was ended.
    const rogue = await organizationLayer(fx.orgB, '2027-03-01');
    const error = await policies
      .supersede(
        fx.users.adminB!,
        layer.id,
        {
          effectiveFrom: '2027-01-01',
          expectedUpdatedAt: layer.updatedAt.toISOString(),
          config: { clock: { mode: 'DISABLED' } },
        },
        ctx(fx.users.adminB!),
      )
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect(codeOf(error)).toBe('TIME_POLICY_OVERLAP');
    // Rolled back entirely: the layer is untouched, no replacement, no audit.
    expect(
      await prisma.timeAttendancePolicy.findUniqueOrThrow({
        where: { id: layer.id },
      }),
    ).toMatchObject({
      effectiveTo: null,
      updatedAt: layer.updatedAt,
    });
    expect(
      (
        await prisma.timeAttendancePolicy.findMany({
          where: { organizationId: fx.orgB, scopeType: 'ORGANIZATION' },
        })
      ).map((row) => row.id),
    ).toEqual(expect.arrayContaining([layer.id, rogue.id]));
    expect(
      await prisma.timeAttendancePolicy.count({
        where: { organizationId: fx.orgB, scopeType: 'ORGANIZATION' },
      }),
    ).toBe(2);
    expect(
      await prisma.auditLog.count({
        where: {
          entityId: layer.id,
          action: { in: ['TIME_POLICY_SUPERSEDED', 'TIME_POLICY_ENDED'] },
        },
      }),
    ).toBe(0);
  });
});
