import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  COMPENSATION_PERMISSIONS,
  COMPENSATION_USERS,
  compensationServices,
} from './support/compensation-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

const codeOf = (error: unknown) =>
  (error as { getResponse?: () => { code?: string } }).getResponse?.().code ??
  String(error);

const hourly = (rateAmount: string, effectiveFrom: string) => ({
  payBasis: 'HOURLY' as const,
  rateAmount,
  currency: 'CAD',
  effectiveFrom,
});

/**
 * Phase 9 concurrency on committed data with real concurrent transactions. Each transaction pauses
 * after reading the compensation timeline, widening the window in which an unserialized overlap
 * check would pass twice. `unlocked` additionally drops the service's assignment-row lock, proving
 * the database trigger alone still refuses the overlap.
 */
function pausingTx(tx: Tx, pauseMs: number, unlocked: boolean): Tx {
  const records = new Proxy(tx.compensationRecord, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        !['findMany', 'findFirst', 'findUnique'].includes(String(property)) ||
        typeof value !== 'function'
      ) {
        return value;
      }
      return async (...args: unknown[]) => {
        const result = await (
          value as (...a: unknown[]) => Promise<unknown>
        ).apply(target, args);
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
        return result;
      };
    },
  });
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'compensationRecord') return records;
      if (unlocked && property === '$queryRaw') {
        const queryRaw = Reflect.get(target, property, receiver) as (
          ...a: unknown[]
        ) => Promise<unknown>;
        return (query: { sql?: string }, ...rest: unknown[]) =>
          String(query?.sql ?? '').includes('"EmploymentAssignment"') &&
          String(query?.sql).includes('FOR NO KEY UPDATE')
            ? Promise.resolve([])
            : queryRaw.call(target, query, ...rest);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('Compensation concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) =>
        createSchedulingFixtures(
          tx,
          COMPENSATION_USERS,
          COMPENSATION_PERMISSIONS,
        ),
      {
        timeout: 30_000,
      },
    );
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  function racing({ pauseMs = 200, unlocked = false } = {}) {
    const client = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === '$transaction') {
          return (run: (tx: Tx) => Promise<unknown>, options?: object) =>
            target.$transaction((tx) => run(pausingTx(tx, pauseMs, unlocked)), {
              ...options,
              timeout: 60_000,
            });
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as PrismaService;
    return compensationServices(client);
  }

  async function settle<T>(...operations: Promise<T>[]) {
    const results = await Promise.allSettled(operations);
    return {
      fulfilled: results
        .filter(
          (r): r is PromiseFulfilledResult<Awaited<T>> =>
            r.status === 'fulfilled',
        )
        .map((r) => r.value),
      rejected: results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => codeOf(r.reason)),
    };
  }

  const activeTimeline = (assignmentId: string) =>
    prisma.compensationRecord.findMany({
      where: { employmentAssignmentId: assignmentId, supersededAt: null },
      orderBy: { effectiveFrom: 'asc' },
    });

  it('applies exactly one of two concurrent changes effective the same day', async () => {
    const hr = ctx(fx.users.hr!);
    await compensationServices(prisma).compensation.create(
      fx.assignmentTeamA,
      hourly('20', '2026-01-01'),
      hr,
    );
    const svc = racing();
    const result = await settle(
      svc.compensation.change(
        fx.assignmentTeamA,
        hourly('22', '2026-07-01'),
        hr,
      ),
      svc.compensation.change(
        fx.assignmentTeamA,
        hourly('23', '2026-07-01'),
        hr,
      ),
    );
    expect(result.fulfilled).toHaveLength(1);
    expect(result.rejected).toEqual(['COMPENSATION_CHANGE_ON_START']);
    const timeline = await activeTimeline(fx.assignmentTeamA);
    expect(
      timeline.map((r) => [
        r.effectiveFrom.toISOString().slice(0, 10),
        r.effectiveTo?.toISOString().slice(0, 10) ?? null,
      ]),
    ).toEqual([
      ['2026-01-01', '2026-06-30'],
      ['2026-07-01', null],
    ]);
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'COMPENSATION_CHANGED',
          entityId: { in: timeline.map((r) => r.id) },
        },
      }),
    ).toBe(1);
  });

  it('creates only one of two concurrent overlapping periods', async () => {
    const hr = ctx(fx.users.hr!);
    const svc = racing();
    const result = await settle(
      svc.compensation.create(
        fx.assignmentDeptB,
        hourly('18', '2026-01-01'),
        hr,
      ),
      svc.compensation.create(
        fx.assignmentDeptB,
        hourly('19', '2026-03-01'),
        hr,
      ),
    );
    expect(result.fulfilled).toHaveLength(1);
    expect(result.rejected).toEqual(['COMPENSATION_OVERLAP']);
    expect(await activeTimeline(fx.assignmentDeptB)).toHaveLength(1);
  });

  it('lets one of a concurrent correction and change win, never both, on the same record', async () => {
    const hr = ctx(fx.users.hr!);
    const initial = await compensationServices(prisma).compensation.create(
      fx.otherTeamA,
      hourly('20', '2026-01-01'),
      hr,
    );
    const svc = racing();
    const result = await settle<unknown>(
      svc.compensation.correct(
        fx.otherTeamA,
        initial.id,
        { rateAmount: '21', reason: 'Typo in offer letter' },
        hr,
      ),
      svc.compensation.change(fx.otherTeamA, hourly('25', '2026-09-01'), hr),
    );
    // Whichever runs second sees the other's result: a correction finds its record superseded or
    // closed (and still applies), a change finds the corrected record. Never an overlap.
    expect(result.fulfilled.length + result.rejected.length).toBe(2);
    expect(
      result.rejected.every((code) => code.startsWith('COMPENSATION_')),
    ).toBe(true);
    const timeline = await activeTimeline(fx.otherTeamA);
    for (let i = 1; i < timeline.length; i += 1) {
      expect(timeline[i - 1]!.effectiveTo!.getTime()).toBeLessThan(
        timeline[i]!.effectiveFrom.getTime(),
      );
    }
  });

  it('still refuses an overlap in the database when the service lock is removed (mutation check)', async () => {
    const hr = ctx(fx.users.hr!);
    const svc = racing({ unlocked: true });
    const result = await settle(
      svc.compensation.create(fx.orgLevel, hourly('30', '2026-01-01'), hr),
      svc.compensation.create(fx.orgLevel, hourly('31', '2026-02-01'), hr),
    );
    // Both pass the application's overlap check (both read an empty timeline); the trigger,
    // serializing on the assignment row, rejects the second insert.
    expect(result.fulfilled).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toContain(
      'Compensation periods of an assignment cannot overlap',
    );
    expect(await activeTimeline(fx.orgLevel)).toHaveLength(1);
  });
});
