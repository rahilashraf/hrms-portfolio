import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { parseDateOnly } from '../src/leave/leave-common.js';
import {
  grantMinutes,
  LEAVE_PERMISSIONS,
  LEAVE_USERS,
  leaveServices,
  seedLeaveConfig,
  TIME_PERMISSIONS,
} from './support/leave-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rejection,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

const codeOf = (error: unknown) =>
  (error as { getResponse?: () => { code?: string } }).getResponse?.().code ??
  String(error);

/**
 * Phase 8 concurrency on committed data with real concurrent transactions. Each transaction
 * pauses after its reads (request days, ledger entries, the unlocked request read), widening
 * the window in which an unserialized check would pass twice.
 */
function pausingTx(tx: Tx, pauseMs: number): Tx {
  const delayed = <T extends object>(delegate: T, methods: string[]) =>
    new Proxy(delegate, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (!methods.includes(String(property)) || typeof value !== 'function')
          return value;
        return async (...args: unknown[]) => {
          const result = await (
            value as (...a: unknown[]) => Promise<unknown>
          ).apply(target, args);
          await new Promise((resolve) => setTimeout(resolve, pauseMs));
          return result;
        };
      },
    });
  const days = delayed(tx.leaveRequestDay, ['findMany']);
  const entries = delayed(tx.leaveLedgerEntry, ['findMany', 'findUnique']);
  const requests = delayed(tx.leaveRequest, ['findUnique']);
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'leaveRequestDay') return days;
      if (property === 'leaveLedgerEntry') return entries;
      if (property === 'leaveRequest') return requests;
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('Leave concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let types: Awaited<ReturnType<typeof seedLeaveConfig>>;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) =>
        createSchedulingFixtures(tx, LEAVE_USERS, [
          ...LEAVE_PERMISSIONS,
          ...TIME_PERMISSIONS,
        ]),
      { timeout: 30_000 },
    );
    types = await seedLeaveConfig(
      prisma as unknown as Tx,
      fx,
      leaveServices(prisma),
      {
        accrualMethod: 'PERIODIC',
        accrualFrequency: 'MONTHLY',
        accrualMinutesPerPeriod: 480,
      },
    );
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  function racing(pauseMs = 200) {
    const client = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === '$transaction') {
          return (run: (tx: Tx) => Promise<unknown>, options?: object) =>
            target.$transaction((tx) => run(pausingTx(tx, pauseMs)), {
              ...options,
              timeout: 60_000,
            });
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as PrismaService;
    return leaveServices(client);
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

  const submit = (
    assignment: string,
    leaveTypeId: string,
    date: string,
    user = fx.selfUser1,
  ) =>
    leaveServices(prisma).requests.submitOwn(
      user,
      {
        employmentAssignmentId: assignment,
        leaveTypeId,
        startDate: date,
        endDate: date,
      },
      ctx(user),
    );

  it('approves a request exactly once when two approvers decide it concurrently', async () => {
    await grantMinutes(
      leaveServices(prisma),
      fx,
      fx.assignmentTeamA,
      types.vacation.id,
      4800,
    );
    const { requestId } = await submit(
      fx.assignmentTeamA,
      types.vacation.id,
      '2027-04-06',
    );
    const svc = racing();
    const result = await settle(
      svc.requests.approve(fx.users.hr!, requestId, {}, ctx(fx.users.hr!)),
      svc.requests.approve(fx.users.hr2!, requestId, {}, ctx(fx.users.hr2!)),
    );
    expect(result.fulfilled).toHaveLength(1);
    expect(result.rejected).toEqual(['LEAVE_REQUEST_NOT_PENDING']);
    expect(
      await prisma.leaveLedgerEntry.count({
        where: { leaveRequestId: requestId },
      }),
    ).toBe(1);
    expect(
      await prisma.leaveRequestEvent.count({
        where: { requestId, type: 'APPROVED' },
      }),
    ).toBe(1);
  });

  it('never approves concurrent requests past the available balance', async () => {
    await grantMinutes(
      leaveServices(prisma),
      fx,
      fx.assignmentDeptB,
      types.vacation.id,
      480,
    );
    // Each fits the balance alone (pending leave is informational, never reserved).
    const first = await submit(
      fx.assignmentDeptB,
      types.vacation.id,
      '2027-04-07',
    );
    const second = await submit(
      fx.assignmentDeptB,
      types.vacation.id,
      '2027-04-08',
    );
    const svc = racing();
    const result = await settle(
      svc.requests.approve(
        fx.users.hr!,
        first.requestId,
        {},
        ctx(fx.users.hr!),
      ),
      svc.requests.approve(
        fx.users.hr2!,
        second.requestId,
        {},
        ctx(fx.users.hr2!),
      ),
    );
    expect(result.fulfilled).toHaveLength(1);
    expect(result.rejected).toEqual(['LEAVE_INSUFFICIENT_BALANCE']);
    const account = await prisma.leaveAccount.findFirstOrThrow({
      where: {
        employmentAssignmentId: fx.assignmentDeptB,
        leaveTypeId: types.vacation.id,
      },
    });
    const balance = await leaveServices(prisma).ledger.balanceOf(
      prisma,
      account.id,
      parseDateOnly('2026-12-31', 'date'),
    );
    expect(balance.availableMinutes).toBe(0);
  });

  it('accepts one of several concurrent overlapping submissions, across leave types', async () => {
    await grantMinutes(
      leaveServices(prisma),
      fx,
      fx.otherTeamA,
      types.vacation.id,
      4800,
    );
    const svc = racing();
    const send = (leaveTypeId: string) =>
      svc.requests.submitOwn(
        fx.selfUser2,
        {
          employmentAssignmentId: fx.otherTeamA,
          leaveTypeId,
          startDate: '2027-04-09',
          endDate: '2027-04-09',
        },
        ctx(fx.selfUser2),
      );
    const result = await settle(
      send(types.vacation.id),
      send(types.personal.id),
      send(types.personal.id),
    );
    expect(result.fulfilled).toHaveLength(1);
    expect(result.rejected).toEqual([
      'LEAVE_REQUEST_OVERLAP',
      'LEAVE_REQUEST_OVERLAP',
    ]);
    expect(
      await prisma.leaveRequest.count({
        where: {
          employmentAssignmentId: fx.otherTeamA,
          startDate: parseDateOnly('2027-04-09', 'date'),
        },
      }),
    ).toBe(1);
  });

  it('settles an approval racing the employee withdrawal into one consistent outcome', async () => {
    const { requestId } = await submit(
      fx.assignmentTeamA,
      types.vacation.id,
      '2027-04-13',
    );
    const svc = racing();
    const result = await settle<unknown>(
      svc.requests.approve(fx.users.hr!, requestId, {}, ctx(fx.users.hr!)),
      svc.requests.cancelOwn(fx.selfUser1, requestId, {}, ctx(fx.selfUser1)),
    );
    const request = await prisma.leaveRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const ledger = await prisma.leaveLedgerEntry.findMany({
      where: { leaveRequestId: requestId },
    });
    const net = ledger.reduce((sum, e) => sum + e.amountMinutes, 0);
    if (request.status === 'APPROVED') {
      // Withdrawal lost: it was refused or ran second against the decided request.
      expect(net).toBe(-480);
    } else {
      // Either the withdrawal won (approval refused) or it cancelled the approved future day.
      expect(request.status).toBe('CANCELLED');
      expect(net).toBe(0);
    }
    expect(result.fulfilled.length + result.rejected.length).toBe(2);
  });

  it('keeps a time period from being locked while a leave change relies on it being open', async () => {
    const period = await prisma.timePeriod.create({
      data: {
        organizationId: fx.orgA,
        startDate: new Date('2027-05-03T00:00:00.000Z'),
        endDate: new Date('2027-05-09T00:00:00.000Z'),
        status: 'OPEN',
        cadence: 'WEEKLY',
        openedAt: new Date(),
      },
    });
    const svc = leaveServices(prisma);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let checked!: () => void;
    const checkedOnce = new Promise<void>((resolve) => (checked = resolve));
    // A leave transaction has checked the dates (FOR SHARE) and has not committed yet.
    const leaveTx = prisma.$transaction(
      async (tx) => {
        const locked = await svc.registry.lockedDates(
          tx,
          {
            organizationId: fx.orgA,
            employeeDates: new Map([
              [fx.employee1, [new Date('2027-05-04T00:00:00.000Z')]],
            ]),
          },
          { lock: true },
        );
        expect(locked.get(fx.employee1)?.size).toBe(0);
        checked();
        await held;
      },
      { timeout: 30_000 },
    );
    await checkedOnce;
    // Locking the period must wait for that transaction (here: time out quickly).
    const blocked = await rejection(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '300ms'`);
        await tx.timePeriod.update({
          where: { id: period.id },
          data: {
            status: 'LOCKED',
            closedAt: new Date(),
            lockedAt: new Date(),
          },
        });
      }),
    );
    expect(String(blocked)).toMatch(/lock timeout/i);
    release();
    await leaveTx;
    // Once the leave change committed, locking proceeds.
    await prisma.timePeriod.update({
      where: { id: period.id },
      data: { status: 'LOCKED', closedAt: new Date(), lockedAt: new Date() },
    });
  });

  it('posts each entitlement once when runs overlap', async () => {
    // Existing accounts, so the account row lock (not a first INSERT) is what serializes runs.
    const ledger = leaveServices(prisma).ledger;
    for (const [employeeId, employmentAssignmentId] of [
      [fx.employee1, fx.assignmentTeamA],
      [fx.employee1, fx.assignmentDeptB],
      [fx.employee2, fx.otherTeamA],
      [fx.employee2, fx.orgLevel],
    ] as const) {
      await ledger.ensureAccount(prisma as unknown as Tx, {
        employeeId,
        employmentAssignmentId,
        leaveTypeId: types.vacation.id,
      });
    }
    const run = () =>
      racing(50).entitlements.processEntitlements({
        asOf: parseDateOnly('2026-03-10', 'date'),
        organizationId: fx.orgA,
      });
    const results = await Promise.all([run(), run(), run()]);
    expect(results.flatMap((r) => r.failed)).toEqual([]);
    // Four assignments, January and February each.
    expect(results.reduce((sum, r) => sum + r.posted.ACCRUAL, 0)).toBe(8);
    expect(
      await prisma.leaveLedgerEntry.count({
        where: {
          entryType: 'ACCRUAL',
          employeeId: { in: [fx.employee1, fx.employee2] },
        },
      }),
    ).toBe(8);
  });
});
