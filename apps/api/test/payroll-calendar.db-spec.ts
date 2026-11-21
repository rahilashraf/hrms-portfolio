import type { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  d,
  FixedPayrollClock,
  PAYROLL_USERS,
  payGroup,
  payrollServices,
  type PayrollServices,
} from './support/payroll-fixtures.js';
import {
  cleanupSchedulingFixtures,
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
  fx: SchedulingFixtures;
  svc: PayrollServices;
  clock: FixedPayrollClock;
  admin: ReturnType<typeof ctx>;
  payGroupId: string;
}

const failure = async (promise: Promise<unknown>) => {
  const error = (await rejection(promise)) as HttpException;
  const body = error.getResponse?.() as { code?: string } | string | undefined;
  return {
    status: error.getStatus?.(),
    code: typeof body === 'object' ? body?.code : undefined,
  };
};

const biweekly = (payGroupId: string, extra: Record<string, unknown> = {}) => ({
  payGroupId,
  cadence: 'BIWEEKLY' as const,
  timezone: 'America/Toronto',
  anchorDate: '2026-10-04',
  payDateOffsetDays: 5,
  processingCutoffOffsetDays: 2,
  effectiveFrom: '2026-10-04',
  ...extra,
});

/**
 * Phase 10 Batch 2: payroll calendars and deterministic, idempotent pay-period generation,
 * scoped to organization payroll permissions.
 */
describe('Payroll calendars and periods (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(run: (h: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, PAYROLL_USERS);
          const clock = new FixedPayrollClock();
          const svc = payrollServices(rollbackClient(tx), clock);
          const group = await payGroup(tx, fx.orgA, `PG-${fx.suffix}`);
          await run({
            tx,
            fx,
            svc,
            clock,
            admin: ctx(fx.users.payrollAdmin!),
            payGroupId: group.id,
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('generates bi-weekly periods once, with pay dates, cutoffs and statuses', async () => {
    await scenario(async ({ tx, svc, admin, payGroupId, fx }) => {
      const calendar = await svc.calendars.createCalendar(
        biweekly(payGroupId),
        admin,
      );
      expect(calendar).toMatchObject({
        cadence: 'BIWEEKLY',
        organizationId: fx.orgA,
      });
      const first = await svc.calendars.generatePeriods(
        { payGroupId, throughDate: '2026-11-20' },
        admin,
      );
      expect(
        first.created.map((p) => [
          p.periodStart,
          p.periodEnd,
          p.payDate,
          p.status,
        ]),
      ).toEqual([
        ['2026-10-04', '2026-10-17', '2026-10-22', 'OPEN'],
        ['2026-10-18', '2026-10-31', '2026-11-05', 'OPEN'],
        // The clock is 2026-11-01 07:00 in Toronto: this period has started.
        ['2026-11-01', '2026-11-14', '2026-11-19', 'OPEN'],
        ['2026-11-15', '2026-11-28', '2026-12-03', 'UPCOMING'],
      ]);
      // The cutoff is the end of 2026-11-03 (two days before pay), EST after the DST change.
      expect(first.created[1]!.processingCutoffAt).toBe(
        '2026-11-04T04:59:59.999Z',
      );
      // Idempotent: nothing new, nothing rewritten.
      const again = await svc.calendars.generatePeriods(
        { payGroupId, throughDate: '2026-11-20' },
        admin,
      );
      expect(again.created).toEqual([]);
      expect(await tx.payrollPeriod.count({ where: { payGroupId } })).toBe(4);
      expect(
        await tx.auditLog.count({
          where: { action: 'PAYROLL_PERIODS_GENERATED', entityId: payGroupId },
        }),
      ).toBe(1);
    });
  });

  it('generates weekly, semi-monthly and monthly series', async () => {
    await scenario(async ({ tx, svc, admin, fx }) => {
      const series = async (
        cadence: 'WEEKLY' | 'SEMIMONTHLY' | 'MONTHLY',
        anchorDate: string,
        payDateOffsetDays: number,
      ) => {
        const group = await payGroup(tx, fx.orgA, `PG-${cadence}-${fx.suffix}`);
        await svc.calendars.createCalendar(
          {
            ...biweekly(group.id),
            cadence,
            anchorDate,
            effectiveFrom: anchorDate,
            payDateOffsetDays,
          },
          admin,
        );
        return (
          await svc.calendars.generatePeriods(
            { payGroupId: group.id, throughDate: '2027-02-16' },
            admin,
          )
        ).created.map((p) => `${p.periodStart}..${p.periodEnd}→${p.payDate}`);
      };
      expect(await series('MONTHLY', '2026-12-01', 0)).toEqual([
        '2026-12-01..2026-12-31→2026-12-31',
        '2027-01-01..2027-01-31→2027-01-31',
        '2027-02-01..2027-02-28→2027-02-28',
      ]);
      expect(await series('SEMIMONTHLY', '2027-01-16', 0)).toEqual([
        '2027-01-16..2027-01-31→2027-01-31',
        '2027-02-01..2027-02-15→2027-02-15',
        '2027-02-16..2027-02-28→2027-02-28',
      ]);
      expect((await series('WEEKLY', '2027-01-24', 3)).slice(0, 2)).toEqual([
        '2027-01-24..2027-01-30→2027-02-02',
        '2027-01-31..2027-02-06→2027-02-09',
      ]);
    });
  });

  it('keeps calendars from overlapping and generated history from being rewritten', async () => {
    await scenario(async ({ tx, svc, admin, payGroupId }) => {
      const calendar = await svc.calendars.createCalendar(
        biweekly(payGroupId),
        admin,
      );
      expect(
        await failure(
          svc.calendars.createCalendar(
            biweekly(payGroupId, { effectiveFrom: '2026-11-01' }),
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'PAYROLL_CALENDAR_OVERLAP' });
      // Unconsumed rules can still change...
      await svc.calendars.updateCalendar(
        calendar.id,
        { ...biweekly(payGroupId), payDateOffsetDays: 6 },
        admin,
      );
      await svc.calendars.generatePeriods(
        { payGroupId, throughDate: '2026-10-31' },
        admin,
      );
      // ...but not once periods exist.
      expect(
        await failure(
          svc.calendars.updateCalendar(
            calendar.id,
            { ...biweekly(payGroupId), payDateOffsetDays: 2 },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'PAYROLL_CALENDAR_IN_USE' });
      // Ending must not cut through generated periods, and must end on a period end.
      expect(
        await failure(
          svc.calendars.endCalendar(
            calendar.id,
            { effectiveTo: '2026-10-17' },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'PAYROLL_CALENDAR_END_BEFORE_PERIODS' });
      expect(
        await failure(
          svc.calendars.endCalendar(
            calendar.id,
            { effectiveTo: '2026-11-07' },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'PAYROLL_CALENDAR_SERIES_INVALID' });
      await svc.calendars.endCalendar(
        calendar.id,
        { effectiveTo: '2026-11-14' },
        admin,
      );
      // A new semi-monthly calendar continues the timeline; the old periods keep their rules.
      await svc.calendars.createCalendar(
        {
          ...biweekly(payGroupId),
          cadence: 'SEMIMONTHLY',
          anchorDate: '2026-11-16',
          effectiveFrom: '2026-11-16',
          payDateOffsetDays: 0,
          timezone: 'America/Vancouver',
        },
        admin,
      );
      // The gap day 2026-11-15 belongs to no calendar: nothing is invented for it.
      const created = await svc.calendars.generatePeriods(
        { payGroupId, throughDate: '2026-12-01' },
        admin,
      );
      expect(
        created.created.map((p) => [
          p.periodStart,
          p.periodEnd,
          p.payDate,
          p.timezone,
        ]),
      ).toEqual([
        ['2026-11-01', '2026-11-14', '2026-11-20', 'America/Toronto'],
        ['2026-11-16', '2026-11-30', '2026-11-30', 'America/Vancouver'],
        ['2026-12-01', '2026-12-15', '2026-12-15', 'America/Vancouver'],
      ]);
      const oldest = await tx.payrollPeriod.findFirstOrThrow({
        where: { payGroupId },
        orderBy: { periodStart: 'asc' },
      });
      expect(oldest.payDate).toEqual(d('2026-10-23'));
    });
  });

  it('refuses invalid rules, archived pay groups and generation too far ahead', async () => {
    await scenario(async ({ tx, svc, admin, payGroupId, fx }) => {
      const cases: Array<[Record<string, unknown>, number, string]> = [
        [{ timezone: 'Mars/Olympus' }, 400, 'PAYROLL_TIMEZONE_INVALID'],
        [
          { effectiveFrom: '2026-10-05' },
          400,
          'PAYROLL_CALENDAR_SERIES_INVALID',
        ],
        [
          { effectiveFrom: '2026-09-20' },
          400,
          'PAYROLL_CALENDAR_SERIES_INVALID',
        ],
        [
          {
            cadence: 'MONTHLY',
            anchorDate: '2026-10-29',
            effectiveFrom: '2026-10-29',
          },
          400,
          'PAYROLL_CALENDAR_ANCHOR_INVALID',
        ],
        [
          { cadence: 'WEEKLY', payDateOffsetDays: -7 },
          400,
          'PAYROLL_CALENDAR_SERIES_INVALID',
        ],
      ];
      for (const [extra, status, code] of cases) {
        expect(
          await failure(
            svc.calendars.createCalendar(biweekly(payGroupId, extra), admin),
          ),
        ).toEqual({ status, code });
      }
      await svc.calendars.createCalendar(biweekly(payGroupId), admin);
      expect(
        await failure(
          svc.calendars.generatePeriods(
            { payGroupId, throughDate: '2028-01-01' },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'PAYROLL_GENERATION_HORIZON' });
      const archived = await payGroup(tx, fx.orgA, `PG-ARCH-${fx.suffix}`);
      await tx.payGroup.update({
        where: { id: archived.id },
        data: { archivedAt: new Date() },
      });
      expect(
        await failure(
          svc.calendars.createCalendar(biweekly(archived.id), admin),
        ),
      ).toEqual({ status: 409, code: 'PAYROLL_PAY_GROUP_ARCHIVED' });
    });
  });

  it('is organization-scoped and never implied by HR, compensation or team grants', async () => {
    await scenario(async ({ svc, fx, payGroupId }) => {
      for (const label of [
        'teamPayroll',
        'hr',
        'orgBPayroll',
        'payrollReader',
      ]) {
        expect(
          await failure(
            svc.calendars.createCalendar(
              biweekly(payGroupId),
              ctx(fx.users[label]!),
            ),
          ),
        ).toMatchObject({ status: 403 });
      }
      for (const label of ['teamPayroll', 'hr', 'orgBPayroll']) {
        expect(
          await failure(
            svc.calendars.calendars(fx.users[label]!, {
              organizationId: fx.orgA,
            }),
          ),
        ).toMatchObject({ status: 403 });
      }
      const listed = await svc.calendars.calendars(fx.users.payrollReader!, {
        organizationId: fx.orgA,
      });
      expect(listed.items).toEqual([]);
      expect(
        (await svc.access.organizations(fx.users.teamPayroll!)).items,
      ).toEqual([]);
      const reader = await svc.access.organizations(fx.users.payrollReader!);
      expect(reader.items.map((o) => o.id)).toEqual([fx.orgA]);
      expect(reader.items[0]!.actions).toMatchObject({
        canRead: true,
        canManage: false,
      });
    });
  });
});

describe('Payroll period generation concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let payGroupId: string;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, PAYROLL_USERS),
      { timeout: 60_000 },
    );
    payGroupId = (
      await payGroup(prisma as unknown as Tx, fx.orgA, `PG-RACE-${fx.suffix}`)
    ).id;
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  it('creates each period exactly once when two generations race', async () => {
    const svc = payrollServices(prisma, new FixedPayrollClock());
    const admin = ctx(fx.users.payrollAdmin!);
    await svc.calendars.createCalendar(biweekly(payGroupId), admin);
    const results = await Promise.all([
      svc.calendars.generatePeriods(
        { payGroupId, throughDate: '2026-12-31' },
        admin,
      ),
      svc.calendars.generatePeriods(
        { payGroupId, throughDate: '2026-12-31' },
        admin,
      ),
    ]);
    expect(results.map((r) => r.created.length).sort((a, b) => a - b)).toEqual([
      0, 7,
    ]);
    expect(await prisma.payrollPeriod.count({ where: { payGroupId } })).toBe(7);
  });
});
