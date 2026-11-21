import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { parseDateOnly } from '../src/leave/leave-common.js';
import { runLeaveEntitlementsJob } from '../src/leave/leave-jobs.js';
import {
  FixedClock,
  grantMinutes,
  LEAVE_PERMISSIONS,
  LEAVE_USERS,
  leaveServices,
  seedLeaveConfig,
  TIME_PERMISSIONS,
  type LeaveServices,
} from './support/leave-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

interface Harness {
  tx: Tx;
  client: PrismaService;
  fx: SchedulingFixtures;
  svc: LeaveServices;
  types: Awaited<ReturnType<typeof seedLeaveConfig>>;
  hr: ReturnType<typeof ctx>;
}

const day = (value: Date) => value.toISOString().slice(0, 10);

describe('Leave entitlements (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (h: Harness) => Promise<void>,
    policy: Record<string, unknown> = {},
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, LEAVE_USERS, [
            ...LEAVE_PERMISSIONS,
            ...TIME_PERMISSIONS,
          ]);
          const client = rollbackClient(tx);
          const svc = leaveServices(client, new FixedClock());
          const types = await seedLeaveConfig(tx, fx, svc, policy);
          await run({ tx, client, fx, svc, types, hr: ctx(fx.users.hr!) });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const entriesOf = (
    tx: Tx,
    employmentAssignmentId: string,
    leaveTypeId: string,
  ) =>
    tx.leaveLedgerEntry
      .findMany({
        where: { account: { employmentAssignmentId, leaveTypeId } },
        // Same-day entries order by type (enum declaration order) for determinism.
        orderBy: [{ effectiveDate: 'asc' }, { entryType: 'asc' }],
      })
      .then((rows) =>
        rows.map((r) => ({
          type: r.entryType,
          minutes: r.amountMinutes,
          on: day(r.effectiveDate),
          key: r.idempotencyKey
            .replace(r.accountId, 'acc')
            .replace(r.policyId ?? '\u0000', 'pol'),
          policyId: r.policyId,
        })),
      );

  const MONTHLY = {
    accrualMethod: 'PERIODIC',
    accrualFrequency: 'MONTHLY',
    accrualMinutesPerPeriod: 480,
  };

  it('accrues each completed month up to the cap, reading the cap from the ledger, and reruns post nothing', async () => {
    await scenario(
      async ({ tx, fx, svc, types }) => {
        const first = await svc.entitlements.processEntitlements({
          asOf: parseDateOnly('2026-06-10', 'date'),
          organizationId: fx.orgA,
        });
        // Four Org A assignments; only the tracked, accruing vacation type is processed.
        expect(first).toMatchObject({
          accounts: 4,
          posted: {
            GRANT: 0,
            ACCRUAL: 20,
            CARRYOVER_FORFEIT: 0,
            EXPIRY: 0,
            REVERSAL: 0,
          },
          failed: [],
        });
        const rows = await entriesOf(tx, fx.assignmentTeamA, types.vacation.id);
        expect(rows.map((r) => [r.type, r.minutes, r.on, r.key])).toEqual([
          ['ACCRUAL', 480, '2026-01-31', 'accrual:acc:pol:2026-01-01'],
          ['ACCRUAL', 480, '2026-02-28', 'accrual:acc:pol:2026-02-01'],
          ['ACCRUAL', 480, '2026-03-31', 'accrual:acc:pol:2026-03-01'],
          ['ACCRUAL', 480, '2026-04-30', 'accrual:acc:pol:2026-04-01'],
          // Capped at maxBalanceMinutes 2000.
          ['ACCRUAL', 80, '2026-05-31', 'accrual:acc:pol:2026-05-01'],
        ]);
        expect(rows.every((r) => r.policyId === types.vacationPolicy.id)).toBe(
          true,
        );

        // A rerun on the same date posts nothing and creates no duplicates.
        const rerun = await svc.entitlements.processEntitlements({
          asOf: parseDateOnly('2026-06-10', 'date'),
          organizationId: fx.orgA,
        });
        expect(rerun.posted).toEqual({
          GRANT: 0,
          ACCRUAL: 0,
          CARRYOVER_FORFEIT: 0,
          EXPIRY: 0,
          REVERSAL: 0,
        });

        // June at the cap posts nothing; after a 1000-minute deduction June accrues in full.
        await grantMinutes(
          svc,
          fx,
          fx.assignmentTeamA,
          types.vacation.id,
          -1000,
          '2026-06-15',
        );
        const july = await svc.entitlements.processEntitlements({
          asOf: parseDateOnly('2026-07-10', 'date'),
          organizationId: fx.orgA,
        });
        // Only the account below its cap accrues June.
        expect(july.posted.ACCRUAL).toBe(1);
        const after = await entriesOf(
          tx,
          fx.assignmentTeamA,
          types.vacation.id,
        );
        expect(after.at(-1)).toMatchObject({
          type: 'ACCRUAL',
          minutes: 480,
          on: '2026-06-30',
        });

        // The untracked personal type never gets accounts or entries.
        expect(
          await tx.leaveAccount.count({
            where: { leaveTypeId: types.personal.id },
          }),
        ).toBe(0);
      },
      { ...MONTHLY, maxBalanceMinutes: 2000 },
    );
  });

  it('grants annually, forfeits above the carryover cap and expires unused carryover first-in-first-out', async () => {
    await scenario(
      async ({ tx, fx, svc, types, hr }) => {
        const january = await svc.entitlements.processEntitlements({
          asOf: parseDateOnly('2027-01-15', 'date'),
          organizationId: fx.orgA,
          lookbackDays: 800,
        });
        expect(january.posted).toEqual({
          GRANT: 8,
          ACCRUAL: 0,
          CARRYOVER_FORFEIT: 4,
          EXPIRY: 0,
          REVERSAL: 0,
        });
        expect(
          (await entriesOf(tx, fx.assignmentDeptB, types.vacation.id)).map(
            (r) => [r.type, r.minutes, r.on, r.key],
          ),
        ).toEqual([
          ['GRANT', 2400, '2026-01-01', 'grant:acc:2026-01-01:2026-12-31'],
          ['GRANT', 2400, '2027-01-01', 'grant:acc:2027-01-01:2027-12-31'],
          ['CARRYOVER_FORFEIT', -1800, '2027-01-01', 'yearend:acc:2027-01-01'],
        ]);

        // 480 minutes of leave inside the 90-day carryover window consumes carried minutes first.
        const submitted = await svc.requests.submitOwn(
          fx.selfUser1,
          {
            employmentAssignmentId: fx.assignmentDeptB,
            leaveTypeId: types.vacation.id,
            startDate: '2027-03-09',
            endDate: '2027-03-09',
          },
          ctx(fx.selfUser1),
        );
        await svc.requests.approve(fx.users.hr!, submitted.requestId, {}, hr);

        const may = await svc.entitlements.processEntitlements({
          asOf: parseDateOnly('2027-05-01', 'date'),
          organizationId: fx.orgA,
          lookbackDays: 800,
        });
        expect(may.posted).toEqual({
          GRANT: 0,
          ACCRUAL: 0,
          CARRYOVER_FORFEIT: 0,
          EXPIRY: 4,
          REVERSAL: 0,
        });
        const rows = await entriesOf(tx, fx.assignmentDeptB, types.vacation.id);
        expect(rows.slice(3).map((r) => [r.type, r.minutes, r.on])).toEqual([
          ['USAGE', -480, '2027-03-09'],
          // 600 carried, 480 used before 2027-04-01: 120 expire.
          ['EXPIRY', -120, '2027-04-01'],
        ]);
        const untouched = await entriesOf(
          tx,
          fx.assignmentTeamA,
          types.vacation.id,
        );
        expect(untouched.at(-1)).toMatchObject({
          type: 'EXPIRY',
          minutes: -600,
          on: '2027-04-01',
        });
        const balance = await svc.ledger.balanceOf(
          tx,
          (
            await tx.leaveAccount.findFirstOrThrow({
              where: {
                employmentAssignmentId: fx.assignmentDeptB,
                leaveTypeId: types.vacation.id,
              },
            })
          ).id,
          parseDateOnly('2027-05-01', 'date'),
        );
        expect(balance.currentMinutes).toBe(600 + 2400 - 480 - 120);

        // Retrying the whole window again is a no-op.
        const retry = await svc.entitlements.processEntitlements({
          asOf: parseDateOnly('2027-05-01', 'date'),
          organizationId: fx.orgA,
          lookbackDays: 800,
        });
        expect(retry.posted).toEqual({
          GRANT: 0,
          ACCRUAL: 0,
          CARRYOVER_FORFEIT: 0,
          EXPIRY: 0,
          REVERSAL: 0,
        });
      },
      {
        accrualMethod: 'ANNUAL_GRANT',
        annualGrantMinutes: 2400,
        carryoverMode: 'CAPPED',
        carryoverMaxMinutes: 600,
        carryoverExpiryDays: 90,
      },
    );
  });

  it('follows policy changes, assignment-level overrides and assignment end dates', async () => {
    await scenario(async ({ tx, fx, svc, types, hr }) => {
      await svc.config.endPolicy(
        types.vacationPolicy.id,
        { effectiveTo: '2026-12-31' },
        hr,
      );
      const richer = await svc.config.createPolicy(
        {
          leaveTypeId: types.vacation.id,
          organizationId: fx.orgA,
          scopeType: 'ORGANIZATION',
          effectiveFrom: '2027-01-01',
          ...MONTHLY,
          accrualMinutesPerPeriod: 960,
        } as never,
        hr,
      );
      // The org-level assignment is not eligible for vacation at all.
      await svc.config.createPolicy(
        {
          leaveTypeId: types.vacation.id,
          organizationId: fx.orgA,
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.orgLevel,
          effectiveFrom: '2026-01-01',
          eligible: false,
        } as never,
        hr,
      );
      // Dept B assignment ends mid-February: January only (no proration configured).
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentDeptB },
        data: {
          status: 'ENDED',
          endDate: new Date('2026-02-14T00:00:00.000Z'),
        },
      });

      const outcome = await svc.entitlements.processEntitlements({
        asOf: parseDateOnly('2027-03-10', 'date'),
        organizationId: fx.orgA,
        lookbackDays: 800,
      });
      expect(outcome.failed).toEqual([]);
      expect(outcome.accounts).toBe(3);

      const teamA = await entriesOf(tx, fx.assignmentTeamA, types.vacation.id);
      expect(teamA).toHaveLength(14);
      expect(
        teamA
          .filter((r) => r.policyId === types.vacationPolicy.id)
          .map((r) => r.minutes),
      ).toEqual(Array(12).fill(480));
      expect(
        teamA
          .filter((r) => r.policyId === richer.id)
          .map((r) => [r.minutes, r.on]),
      ).toEqual([
        [960, '2027-01-31'],
        [960, '2027-02-28'],
      ]);
      expect(
        (await entriesOf(tx, fx.assignmentDeptB, types.vacation.id)).map(
          (r) => [r.minutes, r.on],
        ),
      ).toEqual([[480, '2026-01-31']]);
      expect(
        await tx.leaveAccount.count({
          where: { employmentAssignmentId: fx.orgLevel },
        }),
      ).toBe(0);
    }, MONTHLY);
  });

  it('books leave against its own leave year and settles a closed year after the fact', async () => {
    await scenario(
      async ({ tx, fx, svc, types, hr }) => {
        const errorCode = (error: unknown) =>
          (error as { getResponse(): Record<string, unknown> }).getResponse();
        const at = (iso: string) => {
          svc.requests.now = () => new Date(iso);
          svc.entitlements.now = () => new Date(iso);
        };
        const self = ctx(fx.selfUser1);
        const book = (startDate: string, endDate = startDate) =>
          svc.requests.submitOwn(
            fx.selfUser1,
            {
              employmentAssignmentId: fx.assignmentDeptB,
              leaveTypeId: types.vacation.id,
              startDate,
              endDate,
            },
            self,
          );
        at('2026-10-05T16:00:00.000Z');
        await svc.entitlements.processEntitlements({ organizationId: fx.orgA });
        // This year: covered by the 2026 grant.
        const november = await book('2026-11-02', '2026-11-03');
        await svc.requests.approve(fx.users.hr!, november.requestId, {}, hr);
        // Next year: nothing carries over (NONE) and 2027 is not granted yet.
        expect(errorCode(await rejection(book('2027-03-08')))).toMatchObject({
          code: 'LEAVE_INSUFFICIENT_BALANCE',
          leaveYearStart: '2027-01-01',
          availableMinutes: 0,
        });
        // The preview says the same before anything is submitted.
        const preview = await svc.requests.previewOwn(fx.selfUser1, {
          employmentAssignmentId: fx.assignmentDeptB,
          leaveTypeId: types.vacation.id,
          startDate: '2027-03-08',
          endDate: '2027-03-08',
        });
        expect(preview.balance).toMatchObject({
          leaveYear: { start: '2027-01-01', end: '2027-12-31' },
          availableForLeaveYearMinutes: 0,
          sufficient: false,
        });
        // One request per leave year.
        expect(
          errorCode(await rejection(book('2026-12-31', '2027-01-04'))),
        ).toMatchObject({
          code: 'LEAVE_REQUEST_SPANS_LEAVE_YEARS',
          leaveYearStart: '2027-01-01',
        });

        // The year end: 1440 unused minutes are forfeited and 2027 is granted.
        at('2027-01-05T16:00:00.000Z');
        await svc.entitlements.processEntitlements({ organizationId: fx.orgA });
        await svc.requests.approve(
          fx.users.hr!,
          (await book('2027-03-08')).requestId,
          {},
          hr,
        );

        // A December day off is recorded after the year end (supported: the period is open).
        // Had it been on time the forfeit would have been 960, so the posted 1440 is settled.
        await svc.requests.createOnBehalf(
          fx.users.hr!,
          {
            employmentAssignmentId: fx.assignmentDeptB,
            leaveTypeId: types.vacation.id,
            startDate: '2026-12-14',
            endDate: '2026-12-14',
            approve: true,
          },
          hr,
        );
        const settled = await svc.entitlements.processEntitlements({
          organizationId: fx.orgA,
        });
        expect(settled.failed).toEqual([]);
        const account = await tx.leaveAccount.findFirstOrThrow({
          where: {
            employmentAssignmentId: fx.assignmentDeptB,
            leaveTypeId: types.vacation.id,
          },
        });
        const yearEnd = await tx.leaveLedgerEntry.findMany({
          where: {
            accountId: account.id,
            effectiveDate: new Date('2027-01-01T00:00:00.000Z'),
            entryType: { not: 'GRANT' },
          },
          orderBy: { postedAt: 'asc' },
        });
        expect(
          yearEnd.map((e) => [e.entryType, e.amountMinutes, e.sourceType]),
        ).toEqual(
          expect.arrayContaining([
            ['CARRYOVER_FORFEIT', -1440, 'YEAR_END'],
            ['REVERSAL', 1440, 'YEAR_END'],
            ['CARRYOVER_FORFEIT', -960, 'YEAR_END'],
          ]),
        );
        expect(yearEnd).toHaveLength(3);
        // 2027 is exactly what it would have been: the full 2027 grant less the March day.
        const balance = await svc.ledger.balanceOf(
          tx,
          account.id,
          parseDateOnly('2027-01-05', 'date'),
        );
        expect(balance).toMatchObject({
          currentMinutes: 2400,
          availableMinutes: 1920,
          scheduledMinutes: 480,
        });
        // Settled: a rerun posts nothing.
        const rerun = await svc.entitlements.processEntitlements({
          organizationId: fx.orgA,
        });
        expect(rerun.posted).toEqual({
          GRANT: 0,
          ACCRUAL: 0,
          CARRYOVER_FORFEIT: 0,
          EXPIRY: 0,
          REVERSAL: 0,
        });
        // Changes older than the entitlement window (400 days) would escape that settlement, so
        // tracked leave there is refused (a manual adjustment corrects such old balances);
        // untracked leave posts nothing to settle and is unaffected.
        at('2027-03-10T16:00:00.000Z');
        const old = (leaveTypeId: string) =>
          svc.requests.createOnBehalf(
            fx.users.hr!,
            {
              employmentAssignmentId: fx.assignmentDeptB,
              leaveTypeId,
              startDate: '2026-02-02',
              endDate: '2026-02-02',
              approve: true,
            },
            hr,
          );
        expect(
          errorCode(await rejection(old(types.vacation.id))),
        ).toMatchObject({
          code: 'LEAVE_OUTSIDE_ENTITLEMENT_WINDOW',
          earliestDate: '2026-02-03',
        });
        await expect(old(types.personal.id)).resolves.toMatchObject({
          status: 'APPROVED',
        });
      },
      {
        accrualMethod: 'ANNUAL_GRANT',
        annualGrantMinutes: 2400,
        carryoverMode: 'NONE',
      },
    );
  });

  it('never posts ahead of time: a future asOf is refused', async () => {
    await scenario(async ({ tx, fx, svc }) => {
      svc.entitlements.now = () => new Date('2026-03-10T12:00:00.000Z');
      const refused = await rejection(
        svc.entitlements.processEntitlements({
          asOf: parseDateOnly('2026-06-10', 'date'),
          organizationId: fx.orgA,
        }),
      );
      expect(String(refused)).toMatch(/future/);
      // Without asOf each assignment runs as of its own local today.
      const today = await svc.entitlements.processEntitlements({
        organizationId: fx.orgA,
      });
      expect(today.posted.ACCRUAL).toBe(4 * 2);
      expect(
        await tx.leaveLedgerEntry.count({
          where: {
            employeeId: { in: [fx.employee1, fx.employee2] },
            effectiveDate: { gt: new Date('2026-03-10T00:00:00.000Z') },
          },
        }),
      ).toBe(0);
    }, MONTHLY);
  });

  it('runs as a job, validates job data and isolates failing accounts', async () => {
    await scenario(async ({ tx, client, fx, types }) => {
      for (const data of [
        { asOf: '2026-02-30' },
        { organizationId: 'nope' },
        { lookbackDays: 0 },
        [],
      ]) {
        expect(
          await rejection(runLeaveEntitlementsJob(data, { prisma: client })),
        ).toBeInstanceOf(Error);
      }
      // Without an organization timezone, only the Toronto-located position resolves one.
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: null },
      });
      const outcome = await runLeaveEntitlementsJob(
        { asOf: '2026-03-10', organizationId: fx.orgA },
        { prisma: client },
      );
      expect(outcome.posted.ACCRUAL).toBe(2 * 2);
      expect(
        outcome.failed.map((f) => f.employmentAssignmentId).sort(),
      ).toEqual([fx.assignmentDeptB, fx.orgLevel].sort());
      expect(outcome.failed[0]!.message).toMatch(/timezone/i);
      expect(
        await tx.leaveAccount.count({
          where: { leaveTypeId: types.vacation.id },
        }),
      ).toBe(2);
    }, MONTHLY);
  });
});
