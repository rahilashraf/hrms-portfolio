import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  d,
  FixedPayrollClock,
  payGroup,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
  failure,
  PAYROLL_WORLD_USERS,
  world,
  type World,
} from './support/payroll-world.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
} from './support/scheduling-fixtures.js';
import {
  FixedClock,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** Check 1 of the read-only 4C preflight (overlapping periods, classified by ownership). */
const OVERLAP_CHECK = readFileSync(
  new URL(
    '../../../docs/security/sql/batch-4c-attendance-lifecycle-preflight.sql',
    import.meta.url,
  ),
  'utf8',
)
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((statement) => statement.trim())
  .find((statement) => statement.startsWith('WITH owners'))!;

const USERS = {
  ...PAYROLL_WORLD_USERS,
  timeManager: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
};

/**
 * Batch 4C (decision 1, option B) — ownership-aware time period overlaps.
 *
 * A time period is payroll-owned when a PayrollPeriod uses it (the relationship itself, never a
 * label), attendance-owned otherwise. Payroll reuses a period with exactly its dates, whoever
 * created it; it may overlap periods of OTHER pay groups (several pay groups with different
 * calendars in one organization stay supported), never an attendance-owned period with
 * different dates (409 TIME_PERIOD_OVERLAP). Attendance-owned periods never overlap any period
 * with different dates. Within one pay group the payroll calendar's own refusals are unchanged.
 */
describe('Time period ownership (Batch 4C, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (
      w: World & { time: ReturnType<typeof timeServices>['time'] },
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, [
            ...TIME_PERMISSIONS,
          ]);
          await seedTimePolicy(tx, fx.orgA);
          const client = rollbackClient(tx);
          const svc = payrollServices(client, new FixedPayrollClock());
          const time = timeServices(client, new FixedClock()).time;
          const w = await world(tx, fx, svc);
          await run({ ...w, time }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 180_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const calendarOf = (
    payGroupId: string,
    cadence: 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY',
    anchorDate: string,
  ) => ({
    payGroupId,
    cadence,
    timezone: 'America/Toronto',
    anchorDate,
    payDateOffsetDays: cadence === 'WEEKLY' ? 3 : 5,
    processingCutoffOffsetDays: 2,
    effectiveFrom: anchorDate,
  });

  it('keeps multiple pay groups with different calendars working, reuses exact dates and refuses attendance-owned overlaps', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin, payGroupId, time } = w;
      const manager = fx.users.timeManager!;
      const periodsOf = async (groupId: string) =>
        (
          await tx.payrollPeriod.findMany({
            where: { payGroupId: groupId },
            orderBy: { periodStart: 'asc' },
            select: { periodStart: true, periodEnd: true, timePeriodId: true },
          })
        ).map((period) => ({
          dates: `${period.periodStart.toISOString().slice(0, 10)}..${period.periodEnd.toISOString().slice(0, 10)}`,
          timePeriodId: period.timePeriodId,
        }));

      // A finalized run of the bi-weekly group's first period (Oct 4–17): never changes below.
      const [first] = await tx.payrollPeriod.findMany({
        where: { payGroupId },
      });
      const run = await svc.runs.createRun(
        { payrollPeriodId: first!.id, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run.id, admin);
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
      await svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!));
      const frozen = async () => ({
        run: await tx.payrollRun.findUniqueOrThrow({
          where: { id: run.id },
          select: { status: true, grossAmount: true, sourceFingerprint: true },
        }),
        claims: await tx.payrollSourceClaim.findMany({
          where: { payrollRunId: run.id },
          orderBy: { id: 'asc' },
        }),
        lines: await tx.payrollEarningLine.findMany({
          where: { payrollRunId: run.id },
          orderBy: { id: 'asc' },
        }),
        period: await tx.payrollPeriod.findUniqueOrThrow({
          where: { id: first!.id },
        }),
      });
      const before = await frozen();
      expect(before.run.status).toBe('FINALIZED');

      // 1. Multi-cadence payroll: a weekly and a monthly pay group in the same organization
      //    overlap the bi-weekly group's (payroll-owned) periods, as before.
      const weekly = await payGroup(tx, fx.orgA, `PG-W-${fx.suffix}`);
      await svc.calendars.createCalendar(
        calendarOf(weekly.id, 'WEEKLY', '2026-10-04'),
        admin,
      );
      await svc.calendars.generatePeriods(
        { payGroupId: weekly.id, throughDate: '2026-10-24' },
        admin,
      );
      const monthly = await payGroup(tx, fx.orgA, `PG-M-${fx.suffix}`);
      await svc.calendars.createCalendar(
        calendarOf(monthly.id, 'MONTHLY', '2026-10-01'),
        admin,
      );
      await svc.calendars.generatePeriods(
        { payGroupId: monthly.id, throughDate: '2026-10-01' },
        admin,
      );
      expect((await periodsOf(weekly.id)).map((p) => p.dates)).toEqual([
        '2026-10-04..2026-10-10',
        '2026-10-11..2026-10-17',
        '2026-10-18..2026-10-24',
      ]);
      expect((await periodsOf(monthly.id)).map((p) => p.dates)).toEqual([
        '2026-10-01..2026-10-31',
      ]);
      // Within one pay group the payroll calendar's own refusal is unchanged.
      expect(
        await failure(
          svc.calendars.createCalendar(
            calendarOf(weekly.id, 'WEEKLY', '2026-10-11'),
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'PAYROLL_CALENDAR_OVERLAP' });

      // 2. Exact-date reuse: attendance creates Nov 1–14 first; the bi-weekly group's period of
      //    exactly those dates reuses it, and the period is payroll-owned from then on.
      const attendance = await time.generateTimePeriods(
        manager,
        {
          organizationId: fx.orgA,
          startDate: '2026-11-01',
          cadence: 'BIWEEKLY',
        },
        ctx(manager),
      );
      const shared = attendance.periods[0]!;
      await svc.calendars.generatePeriods(
        { payGroupId, throughDate: '2026-11-14' },
        admin,
      );
      expect(await periodsOf(payGroupId)).toEqual([
        { dates: '2026-10-04..2026-10-17', timePeriodId: first!.timePeriodId },
        { dates: '2026-10-18..2026-10-31', timePeriodId: expect.any(String) },
        { dates: '2026-11-01..2026-11-14', timePeriodId: shared.id },
      ]);
      const listed = await time.listTimePeriods(manager, {
        organizationId: fx.orgA,
        from: '2026-11-01',
        to: '2026-11-14',
      });
      expect(
        listed.items.find((period) => period.id === shared.id),
      ).toMatchObject({ payrollManaged: true });
      // Attendance workflows keep working on it: the same dates are reused (idempotent), and
      // its timesheets are materialized.
      expect(
        (
          await time.generateTimePeriods(
            manager,
            {
              organizationId: fx.orgA,
              startDate: '2026-11-01',
              cadence: 'BIWEEKLY',
            },
            ctx(manager),
          )
        ).periods[0]!.id,
      ).toBe(shared.id);
      expect(
        await time.materializeTimesheets(manager, shared.id, ctx(manager)),
      ).toMatchObject({ existing: expect.any(Number) });

      // 3. A conflict: attendance owns Nov 15–21; the bi-weekly group's Nov 15–28 overlaps it
      //    with different dates and is refused, atomically (no payroll period, nothing changed).
      const owned = (
        await time.generateTimePeriods(
          manager,
          {
            organizationId: fx.orgA,
            startDate: '2026-11-15',
            cadence: 'WEEKLY',
          },
          ctx(manager),
        )
      ).periods[0]!;
      const ownedBefore = await tx.timePeriod.findUniqueOrThrow({
        where: { id: owned.id },
        include: { timesheets: true },
      });
      const refused = await failure(
        svc.calendars.generatePeriods(
          { payGroupId, throughDate: '2026-11-28' },
          admin,
        ),
      );
      expect(refused).toEqual({ status: 409, code: 'TIME_PERIOD_OVERLAP' });
      expect((await periodsOf(payGroupId)).map((p) => p.dates)).not.toContain(
        '2026-11-15..2026-11-28',
      );
      expect(
        await tx.timePeriod.findUniqueOrThrow({
          where: { id: owned.id },
          include: { timesheets: true },
        }),
      ).toEqual(ownedBefore);
      // The weekly group's Nov 15–21 has exactly those dates: reused (now payroll-owned); its
      // Nov 1–7 and 8–14 overlap the bi-weekly group's payroll-owned Nov 1–14: allowed.
      await svc.calendars.generatePeriods(
        { payGroupId: weekly.id, throughDate: '2026-11-21' },
        admin,
      );
      const weeklyPeriods = await periodsOf(weekly.id);
      expect(weeklyPeriods.at(-1)).toEqual({
        dates: '2026-11-15..2026-11-21',
        timePeriodId: owned.id,
      });
      expect(weeklyPeriods.map((p) => p.dates)).toEqual(
        expect.arrayContaining([
          '2026-11-01..2026-11-07',
          '2026-11-08..2026-11-14',
        ]),
      );
      // Attendance still refuses a period overlapping any period with different dates.
      expect(
        await failure(
          time.generateTimePeriods(
            manager,
            {
              organizationId: fx.orgA,
              startDate: '2026-11-10',
              cadence: 'WEEKLY',
            },
            ctx(manager),
          ),
        ),
      ).toEqual({ status: 409, code: 'TIME_PERIOD_OVERLAP' });

      // The preflight classifies overlaps by ownership: the pay groups' overlaps are allowed;
      // a historical attendance-owned overlap (written directly here, as before 4C) is a
      // conflict for review.
      const periodIds = (
        await tx.timePeriod.findMany({
          where: { organizationId: fx.orgA },
          select: { id: true },
        })
      ).map((row) => row.id);
      const historical = await tx.timePeriod.create({
        data: {
          organizationId: fx.orgA,
          startDate: d('2026-10-06'),
          endDate: d('2026-10-12'),
          status: 'OPEN',
          openedAt: new Date('2026-10-01T12:00:00.000Z'),
        },
      });
      const classified = (
        await tx.$queryRawUnsafe<
          Array<{ classification: string; period_a: string; period_b: string }>
        >(OVERLAP_CHECK)
      ).filter((row) => row.period_a !== undefined);
      const ofOrg = new Set([...periodIds, historical.id]);
      const mine = classified.filter(
        (row) => ofOrg.has(row.period_a) || ofOrg.has(row.period_b),
      );
      expect(new Set(mine.map((row) => row.classification))).toEqual(
        new Set(['PAYROLL_PAYROLL_OTHER_GROUPS', 'ATTENDANCE_CONFLICT']),
      );
      expect(
        mine
          .filter((row) => row.classification === 'ATTENDANCE_CONFLICT')
          .every(
            (row) =>
              row.period_a === historical.id || row.period_b === historical.id,
          ),
      ).toBe(true);
      await tx.timePeriod.delete({ where: { id: historical.id } });

      // 4. The finalized run, its claims, lines and period never changed.
      expect(await frozen()).toEqual(before);
      // And no time period was ever created twice for the same dates.
      const every = await tx.timePeriod.findMany({
        where: { organizationId: fx.orgA },
      });
      expect(
        new Set(
          every.map(
            (period) =>
              `${period.startDate.toISOString()}..${period.endDate.toISOString()}`,
          ),
        ).size,
      ).toBe(every.length);
      expect(d('2026-11-15')).toEqual(ownedBefore.startDate);
    });
  });
});
