import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  FixedClock,
  LIVE_TIME_POLICY,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
  toronto,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

const USERS = {
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  managerA: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
};

/** Live clocking, breaks, switching, and auto-close at a trusted 17:00 end after 10 hours open. */
const POLICY = {
  ...LIVE_TIME_POLICY,
  missedPunch: {
    ...LIVE_TIME_POLICY.missedPunch,
    allowAutoCloseFromExpectedEnd: true,
    expectedEndLocalTime: '17:00',
  },
};

/**
 * Holds the first transaction that matches `pauses` right after that read, until the test
 * releases it. Everything else goes straight to the database. This makes an interleaving
 * deterministic: start A, wait until A has read, start B, give B time to reach the same point
 * (or to block on a lock), then release A.
 */
function controlled(
  prisma: PrismaService,
  pauses: (model: string, args: { where?: Record<string, unknown> }) => boolean,
) {
  let held = false;
  let signalRead!: () => void;
  const firstRead = new Promise<void>((resolve) => {
    signalRead = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pausing = (tx: Tx) =>
    new Proxy(tx, {
      get(target, property, receiver) {
        const delegate = Reflect.get(target, property, receiver) as unknown;
        if (
          typeof property !== 'string' ||
          !['timeEntry', 'breakEntry'].includes(property)
        ) {
          return delegate;
        }
        return new Proxy(delegate as object, {
          get(model, method, modelReceiver) {
            const fn = Reflect.get(model, method, modelReceiver) as unknown;
            if (method !== 'findFirst' || typeof fn !== 'function') return fn;
            return async (args: { where?: Record<string, unknown> }) => {
              const result = (await (
                fn as (a: unknown) => Promise<unknown>
              ).call(model, args)) as unknown;
              if (!held && pauses(property, args ?? {})) {
                held = true;
                signalRead();
                await released;
              }
              return result;
            };
          },
        });
      },
    });
  const client = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return (run: (tx: Tx) => Promise<unknown>, options?: object) =>
          target.$transaction((tx) => run(pausing(tx)), options);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as PrismaService;
  return { client, firstRead, release };
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Batch 4A — capture concurrency on committed data, with real concurrent transactions.
 *
 * Every write to one employee's time takes a transaction advisory lock first, so racing
 * clock-outs, break ends, assignment switches, the open-entry scan and manual entries are
 * serialized: the second sees what the first committed. Each test forces the dangerous
 * interleaving (the first transaction paused right after reading, the second started meanwhile)
 * and checks the outcome is the serial one. Without the lock (the Batch 4.0 reproduction) the
 * second transaction would read the same open entry and write over the first.
 */
describe('Time capture concurrency (Batch 4A, committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures | undefined;
  const clock = new FixedClock();

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      async (tx) => {
        const created = await createSchedulingFixtures(
          tx,
          USERS,
          TIME_PERMISSIONS,
        );
        await seedTimePolicy(tx, created.orgA, POLICY);
        return created;
      },
      { timeout: 60_000 },
    );
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  const plain = () => timeServices(prisma, clock).time;
  const self = () => ctx(fx!.selfUser1);
  const openEntryRead =
    (employeeId: string) =>
    (model: string, args: { where?: Record<string, unknown> }) =>
      model === 'timeEntry' &&
      args.where?.status === 'OPEN' &&
      (args.where.employeeId === employeeId || 'id' in args.where);

  it('[4A, was a pinned defect] two simultaneous clock-outs record one CLOCK_OUT punch', async () => {
    const f = fx!;
    clock.value = toronto('2027-03-02T09:00');
    await plain().clockIn(f.selfUser1, f.assignmentTeamA, self());
    clock.value = toronto('2027-03-02T17:00');
    const gate = controlled(prisma, openEntryRead(f.employee1));
    const time = timeServices(gate.client, clock).time;
    const first = time.clockOut(f.selfUser1, ctx(f.selfUser1, 'race-1'));
    await gate.firstRead;
    const second = time.clockOut(f.selfUser1, ctx(f.selfUser1, 'race-2'));
    await settle();
    gate.release();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled',
    ]);
    // The second request saw the closed entry and answered the current status.
    expect(
      (outcomes[1] as PromiseFulfilledResult<{ state: string }>).value.state,
    ).toBe('OFF_CLOCK');
    const entry = await prisma.timeEntry.findFirstOrThrow({
      where: { employeeId: f.employee1, workDate: new Date('2027-03-02') },
    });
    expect(entry).toMatchObject({ status: 'CLOSED', clockOutAt: clock.value });
    expect(
      await prisma.timePunch.count({
        where: { timeEntryId: entry.id, type: 'CLOCK_OUT' },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { entityId: entry.id, action: 'TIME_CLOCKED_OUT' },
      }),
    ).toBe(1);
  });

  it('an auto-close racing a live clock-out never overwrites the real clock-out', async () => {
    const f = fx!;
    clock.value = toronto('2027-03-03T09:00');
    await plain().clockIn(f.selfUser1, f.assignmentTeamA, self());
    const open = await prisma.timeEntry.findFirstOrThrow({
      where: { employeeId: f.employee1, status: 'OPEN' },
      include: {
        employmentAssignment: {
          include: {
            position: {
              include: {
                jobTitle: true,
                organization: true,
                organizationalUnit: true,
                department: true,
                team: true,
                workLocation: true,
              },
            },
          },
        },
      },
    });
    // 19:30: past the 600-minute threshold, so the scan would auto-close at the trusted 17:00.
    clock.value = toronto('2027-03-03T19:30');
    const gate = controlled(prisma, openEntryRead(f.employee1));
    const time = timeServices(gate.client, clock).time;
    const clockOut = time.clockOut(f.selfUser1, self());
    await gate.firstRead;
    // The scan of this one entry (the job scans each open entry in its own transaction).
    const scan = (
      time as unknown as {
        scanOpenTimeEntry: (
          entry: typeof open,
          now: Date,
          context: object,
        ) => Promise<{ detected: boolean; autoResolved: boolean }>;
      }
    ).scanOpenTimeEntry(open, clock.value, { userAgent: 'vitest' });
    await settle();
    gate.release();
    const [, scanned] = await Promise.all([clockOut, scan]);
    expect(scanned).toEqual({
      detected: false,
      autoResolved: false,
      escalated: false,
    });
    const entry = await prisma.timeEntry.findUniqueOrThrow({
      where: { id: open.id },
    });
    expect(entry).toMatchObject({
      status: 'CLOSED',
      clockOutAt: toronto('2027-03-03T19:30'),
    });
    const punches = await prisma.timePunch.findMany({
      where: { timeEntryId: open.id, type: 'CLOCK_OUT' },
    });
    expect(punches.map((punch) => punch.source)).toEqual(['LIVE_CLOCK']);
    expect(
      await prisma.attendanceException.count({
        where: { timeEntryId: open.id, type: 'AUTO_CLOSED_CLOCK_OUT' },
      }),
    ).toBe(0);
  });

  it('two simultaneous break ends close the break once', async () => {
    const f = fx!;
    clock.value = toronto('2027-03-04T09:00');
    await plain().clockIn(f.selfUser1, f.assignmentTeamA, self());
    clock.value = toronto('2027-03-04T12:00');
    await plain().startBreak(f.selfUser1, self());
    clock.value = toronto('2027-03-04T12:30');
    const gate = controlled(prisma, openEntryRead(f.employee1));
    const time = timeServices(gate.client, clock).time;
    const first = time.endBreak(f.selfUser1, self());
    await gate.firstRead;
    const second = time.endBreak(f.selfUser1, self());
    await settle();
    gate.release();
    const states = await Promise.all([first, second]);
    expect(states.map((state) => state.state)).toEqual([
      'CLOCKED_IN',
      'CLOCKED_IN',
    ]);
    const entry = await prisma.timeEntry.findFirstOrThrow({
      where: { employeeId: f.employee1, status: 'OPEN' },
      include: { breaks: true },
    });
    expect(entry.breaks).toHaveLength(1);
    expect(entry.breaks[0]!.endAt).toEqual(toronto('2027-03-04T12:30'));
    expect(
      await prisma.timePunch.count({
        where: { timeEntryId: entry.id, type: 'BREAK_END' },
      }),
    ).toBe(1);
    clock.value = toronto('2027-03-04T17:00');
    await plain().clockOut(f.selfUser1, self());
  });

  it('an assignment switch racing a clock-out leaves no entry open and no punch duplicated', async () => {
    const f = fx!;
    await prisma.organization.update({
      where: { id: f.orgA },
      data: { timezone: 'America/Toronto' },
    });
    clock.value = toronto('2027-03-05T09:00');
    await plain().clockIn(f.selfUser1, f.assignmentTeamA, self());
    clock.value = toronto('2027-03-05T12:00');
    const gate = controlled(prisma, openEntryRead(f.employee1));
    const time = timeServices(gate.client, clock).time;
    const switched = time.switchAssignment(
      f.selfUser1,
      f.assignmentDeptB,
      self(),
    );
    await gate.firstRead;
    // The clock-out is pressed a minute later (each request reads the clock when it starts).
    clock.value = toronto('2027-03-05T12:01');
    const clockedOut = time.clockOut(f.selfUser1, self());
    await settle();
    gate.release();
    await Promise.all([switched, clockedOut]);
    // Serial outcome: the switch closed Team A's entry and opened Dept B's at 12:00; the
    // clock-out then closed Dept B's at 12:01.
    const entries = await prisma.timeEntry.findMany({
      where: { employeeId: f.employee1, workDate: new Date('2027-03-05') },
      orderBy: { clockInAt: 'asc' },
    });
    expect(
      entries.map((entry) => [entry.employmentAssignmentId, entry.status]),
    ).toEqual([
      [f.assignmentTeamA, 'CLOSED'],
      [f.assignmentDeptB, 'CLOSED'],
    ]);
    for (const entry of entries) {
      expect(
        await prisma.timePunch.count({
          where: { timeEntryId: entry.id, type: 'CLOCK_OUT' },
        }),
      ).toBe(1);
    }
  });

  it('two overlapping manual entries submitted together: one is stored, the other refused', async () => {
    const f = fx!;
    clock.value = toronto('2027-03-08T09:00');
    const gate = controlled(
      prisma,
      (model, args) => model === 'timeEntry' && Array.isArray(args.where?.OR),
    );
    const time = timeServices(gate.client, clock).time;
    const add = (reason: string) =>
      time.addEntry(
        f.users.managerA!,
        f.employee1,
        {
          employmentAssignmentId: f.assignmentTeamA,
          startAt: '2027-03-06T09:00',
          endAt: '2027-03-06T12:00',
          reason,
        },
        ctx(f.users.managerA!),
      );
    const first = add('Paper record');
    await gate.firstRead;
    const second = add('Same paper record, entered twice');
    await settle();
    gate.release();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const refused = (outcomes[1] as PromiseRejectedResult).reason as {
      getResponse: () => { code: string };
    };
    expect(refused.getResponse()).toMatchObject({ code: 'TIME_ENTRY_OVERLAP' });
    expect(
      await prisma.timeEntry.count({
        where: { employeeId: f.employee1, workDate: new Date('2027-03-06') },
      }),
    ).toBe(1);
  });
});
