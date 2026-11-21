import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertCompensationFitsAssignment } from '../src/compensation/compensation-assignment.guard.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import {
  COMPENSATION_PERMISSIONS,
  COMPENSATION_USERS,
  compensationServices,
  systemOwnerUser,
  type CompensationServices,
} from './support/compensation-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  svc: CompensationServices;
  hr: ReturnType<typeof ctx>;
}

const body = (error: unknown) =>
  (error as { getResponse(): Record<string, unknown> }).getResponse();
const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const hourly = (
  rateAmount: string,
  effectiveFrom: string,
  extra: Record<string, unknown> = {},
) => ({
  payBasis: 'HOURLY' as const,
  rateAmount,
  currency: 'CAD',
  effectiveFrom,
  ...extra,
});

describe('Compensation (database)', () => {
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
          const fx = await createSchedulingFixtures(
            tx,
            COMPENSATION_USERS,
            COMPENSATION_PERMISSIONS,
          );
          const svc = compensationServices(rollbackClient(tx));
          await run({ tx, fx, svc, hr: ctx(fx.users.hr!) }).catch((e) => {
            console.log('SCENARIO FAILURE', e?.stack);
            throw e;
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const timeline = async (
    svc: CompensationServices,
    fx: SchedulingFixtures,
    assignmentId = fx.assignmentTeamA,
  ) =>
    (await svc.compensation.history(fx.users.hr!, assignmentId)).timeline.map(
      (r) => [
        r.payBasis,
        r.rateAmount,
        r.currency,
        r.effectiveFrom,
        r.effectiveTo,
      ],
    );

  // ─── Batch 1: schema and integrity ─────────────────────────────────────────

  it('stores money as exact decimals, currency and date-only periods, and relates records to assignments', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const big = await svc.compensation.create(
        fx.assignmentTeamA,
        {
          payBasis: 'SALARY',
          rateAmount: '123456789012345.6789',
          currency: 'usd',
          effectiveFrom: '2026-01-01',
        },
        hr,
      );
      // Exact Decimal(19,4) round trip, as a string, never a float.
      expect(big).toMatchObject({
        rateAmount: '123456789012345.6789',
        currency: 'USD',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      });
      expect(typeof big.rateAmount).toBe('string');
      const row = await tx.compensationRecord.findUniqueOrThrow({
        where: { id: big.id },
        include: { employmentAssignment: true },
      });
      expect(row.rateAmount.toFixed(4)).toBe('123456789012345.6789');
      expect(row.employmentAssignment.id).toBe(fx.assignmentTeamA);
      expect(row.organizationId).toBe(fx.orgA);
      expect(row.effectiveFrom.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      // 0.1 + 0.2 stays 0.3000 (no binary floating point anywhere).
      const cents = await svc.compensation.create(
        fx.assignmentDeptB,
        hourly('0.3', '2026-01-01'),
        hr,
      );
      expect(cents.rateAmount).toBe('0.3000');
      for (const rateAmount of [
        '0',
        '-1',
        '1.23456',
        '1e3',
        '1234567890123456',
        24.5 as unknown as string,
      ]) {
        expect(
          body(
            await rejection(
              svc.compensation.create(
                fx.otherTeamA,
                hourly(rateAmount, '2026-01-01'),
                hr,
              ),
            ),
          ),
        ).toMatchObject({
          code: 'COMPENSATION_RATE_INVALID',
        });
      }
      for (const currency of ['CA', 'XYZ', '$$$', '']) {
        expect(
          body(
            await rejection(
              svc.compensation.create(
                fx.otherTeamA,
                hourly('20', '2026-01-01', { currency }),
                hr,
              ),
            ),
          ),
        ).toMatchObject({ code: 'COMPENSATION_CURRENCY_INVALID' });
      }
    });
  });

  it('records annual and contracted salary arrangement metadata without changing pay basis', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const annual = await svc.compensation.create(
        fx.assignmentTeamA,
        {
          payBasis: 'SALARY',
          rateAmount: '62000',
          currency: 'CAD',
          effectiveFrom: '2026-01-01',
        },
        hr,
      );
      expect(annual).toMatchObject({
        payBasis: 'SALARY',
        salaryArrangement: 'ANNUAL',
        salaryContractAmount: null,
      });
      const fixed = await svc.compensation.create(
        fx.assignmentDeptB,
        {
          payBasis: 'SALARY',
          rateAmount: '4000',
          salaryArrangement: 'FIXED_PERIOD',
          salaryMonthlyAmount: '4000',
          salaryPaidMonths: 10,
          salaryContractAmount: '40000',
          salaryPeriodStart: '2026-09-01',
          salaryPeriodEnd: '2027-06-30',
          currency: 'CAD',
          effectiveFrom: '2026-09-01',
          effectiveTo: '2027-06-30',
        },
        hr,
      );
      expect(fixed).toMatchObject({
        payBasis: 'SALARY',
        rateAmount: '4000.0000',
        salaryArrangement: 'FIXED_PERIOD',
        salaryMonthlyAmount: '4000.0000',
        salaryPaidMonths: 10,
        salaryContractAmount: '40000.0000',
        salaryPeriodStart: '2026-09-01',
        salaryPeriodEnd: '2027-06-30',
      });
      const row = await tx.compensationRecord.findUniqueOrThrow({
        where: { id: fixed.id },
      });
      expect(row.salaryMonthlyAmount?.toFixed(4)).toBe('4000.0000');
      expect(row.salaryPeriodEnd?.toISOString()).toBe(
        '2027-06-30T00:00:00.000Z',
      );
      expect(
        body(
          await rejection(
            svc.compensation.create(
              fx.orgLevel,
              {
                payBasis: 'SALARY',
                rateAmount: '4000',
                salaryArrangement: 'FIXED_PERIOD',
                salaryMonthlyAmount: '4000',
                salaryPaidMonths: 9,
                salaryContractAmount: '40000',
                salaryPeriodStart: '2026-09-01',
                salaryPeriodEnd: '2027-06-30',
                currency: 'CAD',
                effectiveFrom: '2026-09-01',
                effectiveTo: '2027-06-30',
              },
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_SALARY_ARRANGEMENT_INVALID',
      });
    });
  });

  it('enforces the same invariants in the database: no deletes, no rewrites, no overlap, no cross-organization pay group', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const record = await svc.compensation.create(
        fx.assignmentTeamA,
        hourly('20', '2026-01-01'),
        hr,
      );
      const db = (sql: string) =>
        violation(tx, () => tx.$executeRawUnsafe(sql));
      expect(
        String(
          await db(
            `DELETE FROM "CompensationRecord" WHERE "id" = '${record.id}'`,
          ),
        ),
      ).toMatch(/cannot be deleted/);
      expect(
        String(
          await db(
            `UPDATE "CompensationRecord" SET "rateAmount" = 99 WHERE "id" = '${record.id}'`,
          ),
        ),
      ).toMatch(/immutable/);
      expect(
        String(
          await db(
            `UPDATE "CompensationRecord" SET "effectiveFrom" = '2026-02-01' WHERE "id" = '${record.id}'`,
          ),
        ),
      ).toMatch(/immutable/);
      // Closing a period is allowed — with a closure entry naming who closed it (security
      // remediation M2) — and reopening or extending it never is.
      expect(
        String(
          await db(
            `UPDATE "CompensationRecord" SET "effectiveTo" = '2026-06-30' WHERE "id" = '${record.id}'`,
          ),
        ),
      ).toMatch(/closure entry/);
      await tx.$executeRawUnsafe(
        `INSERT INTO "CompensationRecordClosure" ("id","compensationRecordId","employmentAssignmentId","organizationId","previousEffectiveTo","newEffectiveTo","closedByUserId","source") SELECT gen_random_uuid(), "id", "employmentAssignmentId", "organizationId", "effectiveTo", '2026-06-30', '${fx.users.hr}', 'APPLICATION' FROM "CompensationRecord" WHERE "id" = '${record.id}'`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "CompensationRecord" SET "effectiveTo" = '2026-06-30' WHERE "id" = '${record.id}'`,
      );
      expect(
        String(
          await db(
            `UPDATE "CompensationRecord" SET "effectiveTo" = NULL WHERE "id" = '${record.id}'`,
          ),
        ),
      ).toMatch(/closed earlier/);
      expect(
        String(
          await db(
            `UPDATE "CompensationRecord" SET "effectiveTo" = '2026-07-31' WHERE "id" = '${record.id}'`,
          ),
        ),
      ).toMatch(/closed earlier/);
      const insert = (from: string, to: string | null, extra = '') =>
        db(`INSERT INTO "CompensationRecord" ("id","employmentAssignmentId","organizationId","recordType","payBasis","rateAmount","currency","effectiveFrom","effectiveTo","updatedAt"${extra ? ',"payGroupId"' : ''})
            VALUES (gen_random_uuid(), '${fx.assignmentTeamA}', '${fx.orgA}', 'INITIAL', 'HOURLY', 21, 'CAD', '${from}', ${to ? `'${to}'` : 'NULL'}, now()${extra})`);
      expect(String(await insert('2026-06-30', null))).toMatch(
        /cannot overlap/,
      );
      expect(String(await insert('2025-12-31', '2025-12-31'))).toMatch(
        /within its assignment/,
      );
      const otherOrgGroup = await tx.payGroup.create({
        data: { organizationId: fx.orgB, code: 'OTHER', name: 'Other org' },
      });
      expect(
        String(await insert('2026-07-01', null, `, '${otherOrgGroup.id}'`)),
      ).toMatch(/foreign key/);
      for (const check of [`"rateAmount" = 0`, `"currency" = 'cad'`]) {
        const [column, value] = check.split(' = ');
        expect(
          String(
            await db(`INSERT INTO "CompensationRecord" ("id","employmentAssignmentId","organizationId","recordType","payBasis","rateAmount","currency","effectiveFrom","updatedAt")
              VALUES (gen_random_uuid(), '${fx.assignmentDeptB}', '${fx.orgA}', 'INITIAL', 'HOURLY', ${column === '"rateAmount"' ? value : 20}, ${column === '"currency"' ? value : "'CAD'"}, '2026-01-01', now())`),
          ),
        ).toMatch(/check constraint/);
      }
      // The assignment cannot be re-dated or cancelled out from under its compensation.
      expect(
        String(
          await db(
            `UPDATE "EmploymentAssignment" SET "startDate" = '2026-02-01' WHERE "id" = '${fx.assignmentTeamA}'`,
          ),
        ),
      ).toMatch(/outside the assignment/);
      expect(
        String(
          await db(
            `UPDATE "EmploymentAssignment" SET "status" = 'CANCELLED' WHERE "id" = '${fx.assignmentTeamA}'`,
          ),
        ),
      ).toMatch(/outside the assignment/);
    });
  });

  // ─── Batch 2: domain engine ────────────────────────────────────────────────

  it('resolves inclusive periods, open ends and gaps to zero or exactly one record', async () => {
    await scenario(async ({ fx, svc, hr }) => {
      const first = await svc.compensation.create(
        fx.assignmentTeamA,
        hourly('20', '2026-01-01', { effectiveTo: '2026-03-31' }),
        hr,
      );
      const second = await svc.compensation.create(
        fx.assignmentTeamA,
        hourly('21', '2026-05-01'),
        hr,
      );
      const at = async (date: string) =>
        (await svc.compensation.asOf(fx.users.hr!, fx.assignmentTeamA, date))
          .record?.id ?? null;
      expect(await at('2025-12-31')).toBeNull(); // before the assignment
      expect(await at('2026-01-01')).toBe(first.id); // inclusive start
      expect(await at('2026-03-31')).toBe(first.id); // inclusive end
      expect(await at('2026-04-01')).toBeNull(); // a gap is missing data, never guessed
      expect(await at('2026-04-30')).toBeNull();
      expect(await at('2026-05-01')).toBe(second.id);
      expect(await at('2099-12-31')).toBe(second.id); // open-ended
      // Overlaps are refused, including touching inclusive boundaries.
      for (const [from, to] of [
        ['2026-03-31', '2026-04-15'],
        ['2026-04-15', '2026-05-01'],
        ['2026-04-01', null],
      ]) {
        expect(
          body(
            await rejection(
              svc.compensation.create(
                fx.assignmentTeamA,
                hourly('22', from!, to ? { effectiveTo: to } : {}),
                hr,
              ),
            ),
          ),
        ).toMatchObject({ code: 'COMPENSATION_OVERLAP' });
      }
      // The gap can be filled exactly.
      await svc.compensation.create(
        fx.assignmentTeamA,
        hourly('20.5', '2026-04-01', { effectiveTo: '2026-04-30' }),
        hr,
      );
      expect(await at('2026-04-15')).not.toBeNull();
      expect(
        body(
          await rejection(
            svc.compensation.asOf(
              fx.users.hr!,
              fx.assignmentTeamA,
              '2026-02-30',
            ),
          ),
        ),
      ).toBeDefined();
    });
  });

  it('keeps compensation inside the assignment lifecycle', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      // An ENDED assignment keeps its history and takes nothing after its end.
      await svc.compensation.create(
        fx.assignmentDeptB,
        hourly('20', '2026-01-01'),
        hr,
      );
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentDeptB },
        data: { status: 'ENDED', endDate: d('2026-06-30') },
      });
      expect(
        (
          await svc.compensation.asOf(
            fx.users.hr!,
            fx.assignmentDeptB,
            '2026-06-30',
          )
        ).record,
      ).not.toBeNull();
      expect(
        (
          await svc.compensation.asOf(
            fx.users.hr!,
            fx.assignmentDeptB,
            '2026-07-01',
          )
        ).record,
      ).toBeNull();
      expect(
        body(
          await rejection(
            svc.compensation.change(
              fx.assignmentDeptB,
              hourly('22', '2026-07-01'),
              hr,
            ),
          ),
        ),
      ).toMatchObject({ code: 'COMPENSATION_OUTSIDE_ASSIGNMENT' });
      expect(
        body(
          await rejection(
            svc.compensation.create(
              fx.assignmentDeptB,
              hourly('22', '2026-07-01'),
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_OUTSIDE_ASSIGNMENT',
      });
      // A retroactive change inside the ended assignment is still possible.
      await svc.compensation.change(
        fx.assignmentDeptB,
        hourly('21', '2026-04-01'),
        hr,
      );
      expect(await timeline(svc, fx, fx.assignmentDeptB)).toEqual([
        ['HOURLY', '20.0000', 'CAD', '2026-01-01', '2026-03-31'],
        ['HOURLY', '21.0000', 'CAD', '2026-04-01', null],
      ]);
      // Nothing before the start.
      expect(
        body(
          await rejection(
            svc.compensation.create(
              fx.assignmentTeamA,
              hourly('20', '2025-12-31'),
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_OUTSIDE_ASSIGNMENT',
      });
      // A PLANNED assignment may hold future compensation; a CANCELLED one none.
      await tx.employmentAssignment.update({
        where: { id: fx.orgLevel },
        data: { status: 'PLANNED', startDate: d('2027-01-01') },
      });
      const planned = await svc.compensation.create(
        fx.orgLevel,
        {
          payBasis: 'SALARY',
          rateAmount: '62000',
          currency: 'CAD',
          effectiveFrom: '2027-01-01',
        },
        hr,
      );
      expect(planned).toMatchObject({
        payBasis: 'SALARY',
        rateAmount: '62000.0000',
      });
      await tx.employmentAssignment.update({
        where: { id: fx.otherTeamA },
        data: { status: 'CANCELLED' },
      });
      expect(
        body(
          await rejection(
            svc.compensation.create(
              fx.otherTeamA,
              hourly('20', '2026-01-01'),
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_ASSIGNMENT_CANCELLED',
      });
    });
  });

  it('refuses assignment changes that would strand compensation, without touching it', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      await svc.compensation.create(
        fx.assignmentTeamA,
        hourly('20', '2026-01-01'),
        hr,
      );
      await svc.compensation.change(
        fx.assignmentTeamA,
        hourly('22', '2026-12-01'),
        hr,
      );
      const guard = (next: {
        status: 'ACTIVE' | 'ENDED' | 'CANCELLED';
        startDate: Date;
        endDate: Date | null;
      }) =>
        rejection(
          assertCompensationFitsAssignment(tx, fx.assignmentTeamA, next),
        );
      // Moving the start past the first period, ending before a scheduled raise, cancelling.
      for (const next of [
        {
          status: 'ACTIVE' as const,
          startDate: d('2026-02-01'),
          endDate: null,
        },
        {
          status: 'ENDED' as const,
          startDate: d('2026-01-01'),
          endDate: d('2026-11-30'),
        },
        {
          status: 'CANCELLED' as const,
          startDate: d('2026-01-01'),
          endDate: null,
        },
      ]) {
        const error = await guard(next);
        expect(error).toBeInstanceOf(ConflictException);
        expect(body(error)).toMatchObject({
          code: 'COMPENSATION_OUTSIDE_ASSIGNMENT',
        });
      }
      // Ending after the raise starts is fine: open-ended compensation ends with the assignment.
      await assertCompensationFitsAssignment(tx, fx.assignmentTeamA, {
        status: 'ENDED',
        startDate: d('2026-01-01'),
        endDate: d('2026-12-31'),
      });
      expect(await timeline(svc, fx)).toEqual([
        ['HOURLY', '20.0000', 'CAD', '2026-01-01', '2026-11-30'],
        ['HOURLY', '22.0000', 'CAD', '2026-12-01', null],
      ]);
    });
  });

  // ─── Batch 3: write workflows ──────────────────────────────────────────────

  it('changes compensation as new periods: raises, salary changes, conversions, future and retroactive', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const initial = await svc.compensation.create(
        fx.assignmentTeamA,
        hourly('20', '2026-01-01'),
        hr,
      );
      // A raise effective July 1: the backend closes the old period and opens the new one.
      const raise = await svc.compensation.change(
        fx.assignmentTeamA,
        hourly('22', '2026-07-01', { reason: 'Annual review' }),
        hr,
      );
      expect(raise.previous).toMatchObject({
        id: initial.id,
        effectiveTo: '2026-06-30',
      });
      // A future conversion to salary, scheduled ahead.
      await svc.compensation.change(
        fx.assignmentTeamA,
        {
          payBasis: 'SALARY',
          rateAmount: '62000',
          currency: 'CAD',
          effectiveFrom: '2027-01-01',
        },
        hr,
      );
      // A retroactive raise recorded later (October 20 for October 1) splits the July period.
      await svc.compensation.change(
        fx.assignmentTeamA,
        hourly('23', '2026-10-01'),
        hr,
      );
      // And back from salary to hourly.
      await svc.compensation.change(
        fx.assignmentTeamA,
        hourly('35', '2027-06-01'),
        hr,
      );
      expect(await timeline(svc, fx)).toEqual([
        ['HOURLY', '20.0000', 'CAD', '2026-01-01', '2026-06-30'],
        ['HOURLY', '22.0000', 'CAD', '2026-07-01', '2026-09-30'],
        ['HOURLY', '23.0000', 'CAD', '2026-10-01', '2026-12-31'],
        ['SALARY', '62000.0000', 'CAD', '2027-01-01', '2027-05-31'],
        ['HOURLY', '35.0000', 'CAD', '2027-06-01', null],
      ]);
      const at = async (date: string) =>
        (await svc.compensation.asOf(fx.users.hr!, fx.assignmentTeamA, date))
          .record?.rateAmount;
      expect([
        await at('2026-06-30'),
        await at('2026-07-01'),
        await at('2026-10-15'),
        await at('2027-03-01'),
      ]).toEqual(['20.0000', '22.0000', '23.0000', '62000.0000']);
      // Rules of a change.
      expect(
        body(
          await rejection(
            svc.compensation.change(
              fx.assignmentTeamA,
              hourly('24', '2026-07-01'),
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_CHANGE_ON_START',
      });
      expect(
        body(
          await rejection(
            svc.compensation.change(
              fx.assignmentTeamA,
              hourly('23', '2026-11-01'),
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_CHANGE_UNCHANGED',
      });
      expect(
        body(
          await rejection(
            svc.compensation.change(
              fx.assignmentDeptB,
              hourly('23', '2026-11-01'),
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_NOT_IN_EFFECT',
      });
      // Audit: one entry per change with before/after and the record it closed.
      const audits = await tx.auditLog.findMany({
        where: { action: 'COMPENSATION_CHANGED', entityId: raise.record.id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toMatchObject({
        employmentAssignmentId: fx.assignmentTeamA,
        previousRecordId: initial.id,
        previousEffectiveTo: { before: null, after: '2026-06-30' },
        before: { payBasis: 'HOURLY', rateAmount: '20.0000', currency: 'CAD' },
        after: {
          payBasis: 'HOURLY',
          rateAmount: '22.0000',
          currency: 'CAD',
          effectiveFrom: '2026-07-01',
        },
        reason: 'Annual review',
      });
      expect(
        await tx.auditLog.count({
          where: { action: 'COMPENSATION_CREATED', entityId: initial.id },
        }),
      ).toBe(1);
    });
  });

  it('changes into a contracted salary for exactly its paid period, never over a scheduled record', async () => {
    await scenario(async ({ fx, svc, hr }) => {
      const annual = (rateAmount: string, effectiveFrom: string) => ({
        payBasis: 'SALARY' as const,
        rateAmount,
        currency: 'CAD',
        effectiveFrom,
      });
      const fixedPeriod = {
        payBasis: 'SALARY' as const,
        rateAmount: '4000',
        salaryArrangement: 'FIXED_PERIOD' as const,
        salaryMonthlyAmount: '4000',
        salaryPaidMonths: 10,
        salaryContractAmount: '40000',
        salaryPeriodStart: '2026-09-01',
        salaryPeriodEnd: '2027-06-30',
        currency: 'CAD',
        effectiveFrom: '2026-09-01',
      };

      // 1. Open-ended annual → fixed period: annual closes Aug 31, the contract is Sep 1–Jun 30.
      const initial = await svc.compensation.create(
        fx.assignmentTeamA,
        annual('62000', '2026-01-01'),
        hr,
      );
      const toFixed = await svc.compensation.change(
        fx.assignmentTeamA,
        fixedPeriod,
        hr,
      );
      expect(toFixed.previous).toMatchObject({
        id: initial.id,
        effectiveTo: '2026-08-31',
      });
      expect(toFixed.record).toMatchObject({
        salaryArrangement: 'FIXED_PERIOD',
        salaryContractAmount: '40000.0000',
        effectiveFrom: '2026-09-01',
        effectiveTo: '2027-06-30',
      });
      expect(await timeline(svc, fx)).toEqual([
        ['SALARY', '62000.0000', 'CAD', '2026-01-01', '2026-08-31'],
        ['SALARY', '4000.0000', 'CAD', '2026-09-01', '2027-06-30'],
      ]);

      // 2. A change already scheduled from Jan 1, 2027 is inside the contract: refused, untouched.
      await svc.compensation.create(
        fx.assignmentDeptB,
        annual('62000', '2026-01-01'),
        hr,
      );
      await svc.compensation.change(
        fx.assignmentDeptB,
        annual('65000', '2027-01-01'),
        hr,
      );
      const scheduledTimeline = [
        ['SALARY', '62000.0000', 'CAD', '2026-01-01', '2026-12-31'],
        ['SALARY', '65000.0000', 'CAD', '2027-01-01', null],
      ];
      expect(await timeline(svc, fx, fx.assignmentDeptB)).toEqual(
        scheduledTimeline,
      );
      expect(
        body(
          await rejection(
            svc.compensation.change(fx.assignmentDeptB, fixedPeriod, hr),
          ),
        ),
      ).toMatchObject({ code: 'COMPENSATION_CHANGE_OVERLAPS_SCHEDULED' });
      expect(await timeline(svc, fx, fx.assignmentDeptB)).toEqual(
        scheduledTimeline,
      );

      // 4. Annual → annual is unchanged: it runs to where the covering record ended.
      const raise = await svc.compensation.change(
        fx.assignmentDeptB,
        annual('63000', '2026-06-01'),
        hr,
      );
      expect(raise.previous).toMatchObject({ effectiveTo: '2026-05-31' });
      expect(raise.record).toMatchObject({
        salaryArrangement: 'ANNUAL',
        effectiveFrom: '2026-06-01',
        effectiveTo: '2026-12-31',
      });
      expect(await timeline(svc, fx, fx.assignmentDeptB)).toEqual([
        ['SALARY', '62000.0000', 'CAD', '2026-01-01', '2026-05-31'],
        ['SALARY', '63000.0000', 'CAD', '2026-06-01', '2026-12-31'],
        ['SALARY', '65000.0000', 'CAD', '2027-01-01', null],
      ]);

      // 3. Annual → contract total with an explicit contract period behaves the same way.
      await svc.compensation.create(
        fx.orgLevel,
        annual('62000', '2026-01-01'),
        hr,
      );
      const toContract = await svc.compensation.change(
        fx.orgLevel,
        {
          payBasis: 'SALARY',
          rateAmount: '30000',
          salaryArrangement: 'CONTRACT_TOTAL',
          salaryContractAmount: '30000',
          salaryPeriodStart: '2026-09-01',
          salaryPeriodEnd: '2027-06-30',
          currency: 'CAD',
          effectiveFrom: '2026-09-01',
        },
        hr,
      );
      expect(toContract.previous).toMatchObject({ effectiveTo: '2026-08-31' });
      expect(toContract.record).toMatchObject({
        salaryArrangement: 'CONTRACT_TOTAL',
        salaryContractAmount: '30000.0000',
        effectiveFrom: '2026-09-01',
        effectiveTo: '2027-06-30',
      });
      expect(await timeline(svc, fx, fx.orgLevel)).toEqual([
        ['SALARY', '62000.0000', 'CAD', '2026-01-01', '2026-08-31'],
        ['SALARY', '30000.0000', 'CAD', '2026-09-01', '2027-06-30'],
      ]);
    });
  });

  it('corrects by superseding with a reason, never rewriting or deleting history', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const wrong = await svc.compensation.create(
        fx.assignmentTeamA,
        hourly('23', '2026-01-01'),
        hr,
      );
      const missingReason = await rejection(
        svc.compensation.correct(
          fx.assignmentTeamA,
          wrong.id,
          { rateAmount: '24', reason: '  ' },
          hr,
        ),
      );
      expect(body(missingReason)).toMatchObject({
        code: 'COMPENSATION_REASON_REQUIRED',
      });
      const fixed = await svc.compensation.correct(
        fx.assignmentTeamA,
        wrong.id,
        { rateAmount: '24', reason: 'Offer letter says $24/hour' },
        hr,
      );
      expect(fixed).toMatchObject({
        recordType: 'CORRECTION',
        rateAmount: '24.0000',
        supersedesRecordId: wrong.id,
        effectiveFrom: '2026-01-01',
      });
      // The mis-entered record is kept exactly, only marked superseded, and leaves the timeline.
      const kept = await tx.compensationRecord.findUniqueOrThrow({
        where: { id: wrong.id },
      });
      expect(kept.rateAmount.toFixed(4)).toBe('23.0000');
      expect(kept.supersededAt).not.toBeNull();
      const view = await svc.compensation.history(
        fx.users.hr!,
        fx.assignmentTeamA,
      );
      expect(view.timeline.map((r) => r.id)).toEqual([fixed.id]);
      expect(view.superseded.map((r) => r.id)).toEqual([wrong.id]);
      expect(
        (
          await svc.compensation.asOf(
            fx.users.hr!,
            fx.assignmentTeamA,
            '2026-03-01',
          )
        ).record?.rateAmount,
      ).toBe('24.0000');
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'COMPENSATION_CORRECTED', entityId: fixed.id },
      });
      expect(audit.metadata).toMatchObject({
        correctedRecordId: wrong.id,
        replacementRecordId: fixed.id,
        before: { rateAmount: '23.0000' },
        after: { rateAmount: '24.0000' },
        reason: 'Offer letter says $24/hour',
      });
      // A superseded record cannot be acted on again; nothing-changing corrections are refused.
      expect(
        body(
          await rejection(
            svc.compensation.correct(
              fx.assignmentTeamA,
              wrong.id,
              { rateAmount: '25', reason: 'x' },
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_RECORD_SUPERSEDED',
      });
      expect(
        body(
          await rejection(
            svc.compensation.correct(
              fx.assignmentTeamA,
              fixed.id,
              { rateAmount: '24.0', reason: 'x' },
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_CORRECTION_UNCHANGED',
      });
      // Correcting dates still respects the timeline.
      await svc.compensation.change(
        fx.assignmentTeamA,
        hourly('26', '2026-07-01'),
        hr,
      );
      expect(
        body(
          await rejection(
            svc.compensation.correct(
              fx.assignmentTeamA,
              fixed.id,
              { effectiveTo: null, reason: 'x' },
              hr,
            ),
          ),
        ),
      ).toMatchObject({ code: 'COMPENSATION_OVERLAP' });
      // Ending a period leaves a gap and is audited; it never extends.
      const current = (
        await svc.compensation.history(fx.users.hr!, fx.assignmentTeamA)
      ).timeline.at(-1)!;
      await svc.compensation.end(
        fx.assignmentTeamA,
        current.id,
        { effectiveTo: '2026-09-30', reason: 'Unpaid secondment' },
        hr,
      );
      expect(
        (
          await svc.compensation.asOf(
            fx.users.hr!,
            fx.assignmentTeamA,
            '2026-10-01',
          )
        ).record,
      ).toBeNull();
      expect(
        body(
          await rejection(
            svc.compensation.end(
              fx.assignmentTeamA,
              current.id,
              { effectiveTo: '2026-12-31' },
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_END_NOT_EARLIER',
      });
      expect(
        await tx.auditLog.count({
          where: { action: 'COMPENSATION_ENDED', entityId: current.id },
        }),
      ).toBe(1);
      // No row was ever deleted: 1 superseded + 1 correction + 1 change.
      expect(
        await tx.compensationRecord.count({
          where: { employmentAssignmentId: fx.assignmentTeamA },
        }),
      ).toBe(3);
    });
  });

  it('rolls the record back when its audit write fails (same transaction)', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const spy = vi
        .spyOn(svc.audit, 'write')
        .mockRejectedValueOnce(new Error('audit unavailable'));
      const error = await violation(tx, () =>
        svc.compensation.create(
          fx.assignmentTeamA,
          hourly('20', '2026-01-01'),
          hr,
        ),
      );
      expect(String(error)).toMatch(/audit unavailable/);
      spy.mockRestore();
      expect(
        await tx.compensationRecord.count({
          where: { employmentAssignmentId: fx.assignmentTeamA },
        }),
      ).toBe(0);
    });
  });

  // ─── Pay groups ────────────────────────────────────────────────────────────

  it('administers minimal organization pay groups and moves compensation between them by change', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const biweekly = await svc.payGroups.create(
        { organizationId: fx.orgA, code: 'hbl biweekly', name: 'HBL Biweekly' },
        hr,
      );
      expect(biweekly).toMatchObject({
        code: 'HBL-BIWEEKLY',
        name: 'HBL Biweekly',
        archivedAt: null,
      });
      expect(
        body(
          await violation(tx, () =>
            svc.payGroups.create(
              { organizationId: fx.orgA, code: 'HBL-BIWEEKLY', name: 'Dup' },
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'PAY_GROUP_CODE_TAKEN',
      });
      const monthly = await svc.payGroups.create(
        { organizationId: fx.orgA, code: 'HBL-MONTHLY', name: 'HBL Monthly' },
        hr,
      );
      await svc.compensation.create(
        fx.assignmentTeamA,
        hourly('20', '2026-01-01', { payGroupId: biweekly.id }),
        hr,
      );
      // A pay-group move is an effective-dated change (no mutable current pay group anywhere).
      const moved = await svc.compensation.change(
        fx.assignmentTeamA,
        hourly('20', '2026-07-01', { payGroupId: monthly.id }),
        hr,
      );
      expect(moved.record.payGroup).toMatchObject({ code: 'HBL-MONTHLY' });
      expect(
        (
          await svc.payroll.compensationEffectiveOn({
            employmentAssignmentId: fx.assignmentTeamA,
            date: '2026-06-30',
          })
        )?.payGroupId,
      ).toBe(biweekly.id);
      // Another organization's pay group is refused.
      const foreign = await tx.payGroup.create({
        data: { organizationId: fx.orgB, code: 'B-GROUP', name: 'B' },
      });
      expect(
        body(
          await rejection(
            svc.compensation.create(
              fx.assignmentDeptB,
              hourly('20', '2026-01-01', { payGroupId: foreign.id }),
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_PAY_GROUP_INVALID',
      });
      // Archive keeps history; an archived group is not chosen for new compensation.
      await svc.payGroups.update(biweekly.id, { name: 'HBL Bi-weekly' }, hr);
      await svc.payGroups.archive(biweekly.id, hr);
      expect(
        body(
          await rejection(
            svc.compensation.create(
              fx.assignmentDeptB,
              hourly('20', '2026-01-01', { payGroupId: biweekly.id }),
              hr,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_PAY_GROUP_ARCHIVED',
      });
      expect(
        (
          await svc.payGroups.list(fx.users.reader!, {
            organizationId: fx.orgA,
          })
        ).items.map((g) => g.code),
      ).toEqual(['HBL-MONTHLY']);
      expect(
        (
          await svc.payGroups.list(fx.users.hr!, {
            organizationId: fx.orgA,
            includeArchived: true,
          })
        ).items.map((g) => [g.code, g.actions.canEdit]),
      ).toEqual([
        ['HBL-BIWEEKLY', false],
        ['HBL-MONTHLY', true],
      ]);
      expect(
        await tx.auditLog.count({
          where: {
            entityId: biweekly.id,
            action: {
              in: [
                'PAY_GROUP_CREATED',
                'PAY_GROUP_UPDATED',
                'PAY_GROUP_ARCHIVED',
              ],
            },
          },
        }),
      ).toBe(3);
      // Scoped and outside users.
      await expect(
        svc.payGroups.create(
          { organizationId: fx.orgA, code: 'X1', name: 'x' },
          ctx(fx.users.deptBManager!),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.payGroups.list(fx.users.employeeAdmin!, {
          organizationId: fx.orgA,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        svc.payGroups.list(fx.users.outsider!, { organizationId: fx.orgA }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        (
          await svc.payGroups.list(fx.users.teamReader!, {
            organizationId: fx.orgA,
          })
        ).items,
      ).toHaveLength(1);
      // Organizations offered to the pay-group admin: those with any compensation grant.
      expect((await svc.payGroups.organizations(fx.users.hr!)).items).toEqual([
        expect.objectContaining({ id: fx.orgA, canManagePayGroups: true }),
      ]);
      expect(
        (await svc.payGroups.organizations(fx.users.teamReader!)).items,
      ).toEqual([
        expect.objectContaining({ id: fx.orgA, canManagePayGroups: false }),
      ]);
      expect(
        (await svc.payGroups.organizations(fx.users.deptBManager!)).items,
      ).toEqual([
        expect.objectContaining({ id: fx.orgA, canManagePayGroups: false }),
      ]);
      expect(
        (await svc.payGroups.organizations(fx.users.employeeAdmin!)).items,
      ).toEqual([]);
    });
  });

  // ─── Batch 4: authorization ────────────────────────────────────────────────

  it('grants pay access only through compensation permissions in scope, read-only to oneself', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      await svc.compensation.create(
        fx.assignmentTeamA,
        hourly('24.5', '2026-01-01'),
        hr,
      );
      await svc.compensation.create(
        fx.assignmentDeptB,
        hourly('18', '2026-01-01'),
        hr,
      );
      const read = (user: string, assignment: string) =>
        svc.compensation.history(user, assignment);
      const forbidden = async (promise: Promise<unknown>) =>
        expect(await rejection(promise)).toBeInstanceOf(ForbiddenException);
      // SYSTEM.
      const system = await systemOwnerUser(tx, fx.suffix);
      // Dept B has no resolvable timezone (no "current" without a date), so read as of a date.
      expect(
        (await svc.compensation.asOf(system, fx.assignmentDeptB, '2026-07-01'))
          .record?.rateAmount,
      ).toBe('18.0000');
      await svc.compensation.change(
        fx.assignmentDeptB,
        hourly('19', '2026-08-01'),
        ctx(system),
      );
      // Organization, unit and team scope.
      expect(
        (await read(fx.users.reader!, fx.assignmentDeptB)).actions,
      ).toEqual({ canCreate: false, canChange: false });
      expect(
        (await read(fx.users.unitReader!, fx.assignmentTeamA)).current
          ?.rateAmount,
      ).toBe('24.5000');
      await forbidden(read(fx.users.unitReader!, fx.assignmentDeptB));
      expect(
        (await read(fx.users.teamReader!, fx.assignmentTeamA)).current
          ?.rateAmount,
      ).toBe('24.5000');
      await forbidden(read(fx.users.teamReader!, fx.assignmentDeptB));
      // Department-scoped manager: writes in Dept B only; reading Dept B comes with manage.
      expect(
        (await read(fx.users.deptBManager!, fx.assignmentDeptB)).actions,
      ).toEqual({ canCreate: true, canChange: true });
      await svc.compensation.change(
        fx.assignmentDeptB,
        hourly('20', '2026-09-01'),
        ctx(fx.users.deptBManager!),
      );
      await forbidden(
        svc.compensation.change(
          fx.assignmentTeamA,
          hourly('30', '2026-09-01'),
          ctx(fx.users.deptBManager!),
        ),
      );
      await forbidden(
        svc.compensation.create(
          fx.orgLevel,
          hourly('30', '2026-01-01'),
          ctx(fx.users.reader!),
        ),
      );
      // employee.read / employee.manage never expose pay.
      await forbidden(read(fx.users.employeeAdmin!, fx.assignmentTeamA));
      await forbidden(
        svc.compensation.employee(fx.users.employeeAdmin!, fx.employee1),
      );
      await forbidden(
        svc.compensation.create(
          fx.otherTeamA,
          hourly('30', '2026-01-01'),
          ctx(fx.users.employeeAdmin!),
        ),
      );
      // Managing someone grants nothing: Employee 2 manages Employee 1 (and can read them) but has no compensation grant.
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { managerAssignmentId: fx.otherTeamA },
      });
      await forbidden(read(fx.selfUser2, fx.assignmentTeamA));
      await forbidden(svc.compensation.employee(fx.selfUser2, fx.employee1));
      // Another organization.
      await forbidden(read(fx.users.outsider!, fx.assignmentTeamA));
      // Self: Employee 1 reads their own compensation read-only, even holding compensation.manage...
      const own = await read(fx.selfUser1, fx.assignmentTeamA);
      expect(own.current?.rateAmount).toBe('24.5000');
      expect(own.actions).toEqual({ canCreate: false, canChange: false });
      expect(
        own.timeline.every((r) => !r.actions.canCorrect && !r.actions.canEnd),
      ).toBe(true);
      // ...and can never change it because it is theirs, though they manage others.
      for (const write of [
        svc.compensation.change(
          fx.assignmentTeamA,
          hourly('99', '2026-09-01'),
          ctx(fx.selfUser1),
        ),
        svc.compensation.create(
          fx.assignmentTeamA,
          hourly('99', '2025-01-01'),
          ctx(fx.selfUser1),
        ),
      ]) {
        expect(body(await rejection(write))).toMatchObject({
          code: 'COMPENSATION_SELF_MANAGEMENT',
        });
      }
      await svc.compensation.create(
        fx.otherTeamA,
        hourly('21', '2026-01-01'),
        ctx(fx.selfUser1),
      );
      // Employee 2 sees only their own (no compensation grant at all).
      const mine = await svc.compensation.me(fx.selfUser2);
      expect(
        mine.assignments.map((a) => [
          a.assignment.id,
          a.current?.rateAmount ?? null,
        ]),
      ).toEqual([
        [fx.otherTeamA, '21.0000'],
        [fx.orgLevel, null],
      ]);
      await expect(svc.compensation.me(fx.users.hr!)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  // ─── Batch 5: read models ──────────────────────────────────────────────────

  it('serves current, history and as-of models with assignment context and no silent UTC', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const group = await svc.payGroups.create(
        { organizationId: fx.orgA, code: 'HBL-BIWEEKLY', name: 'HBL Biweekly' },
        hr,
      );
      await svc.compensation.create(
        fx.assignmentTeamA,
        hourly('24.5', '2026-01-01', { payGroupId: group.id }),
        hr,
      );
      await svc.compensation.change(
        fx.assignmentTeamA,
        hourly('26', '2026-12-01'),
        hr,
      );
      const view = await svc.compensation.history(
        fx.users.hr!,
        fx.assignmentTeamA,
      );
      expect(view.assignment).toMatchObject({
        id: fx.assignmentTeamA,
        status: 'ACTIVE',
        startDate: '2026-01-01',
        position: { id: fx.positionTeamA },
        organization: { id: fx.orgA },
      });
      // "Today" is the assignment-local date (Toronto work location).
      expect(view.asOf).toBe('2026-10-05');
      expect(view.current).toMatchObject({
        rateAmount: '24.5000',
        currency: 'CAD',
        payGroup: { code: 'HBL-BIWEEKLY', name: 'HBL Biweekly' },
      });
      expect(
        view.timeline.map((r) => [
          r.effectiveFrom,
          r.effectiveTo,
          r.recordType,
        ]),
      ).toEqual([
        ['2026-01-01', '2026-11-30', 'INITIAL'],
        ['2026-12-01', null, 'CHANGE'],
      ]);
      expect(view.timeline[1]!.payGroup?.id).toBe(group.id); // a change keeps the pay group unless told otherwise
      expect(
        await svc.compensation.current(fx.users.hr!, fx.assignmentTeamA),
      ).toMatchObject({
        date: '2026-10-05',
        record: { rateAmount: '24.5000' },
      });
      expect(
        await svc.compensation.current(
          fx.users.hr!,
          fx.assignmentTeamA,
          '2026-12-01',
        ),
      ).toMatchObject({ record: { rateAmount: '26.0000' } });
      // Dept B has no work location and Org A no timezone: "today" is unknown, never UTC.
      await svc.compensation.create(
        fx.assignmentDeptB,
        hourly('18', '2026-01-01'),
        hr,
      );
      expect(
        (await svc.compensation.history(fx.users.hr!, fx.assignmentDeptB)).asOf,
      ).toBeNull();
      expect(
        body(
          await rejection(
            svc.compensation.current(fx.users.hr!, fx.assignmentDeptB),
          ),
        ),
      ).toMatchObject({
        code: 'COMPENSATION_TIMEZONE_UNRESOLVED',
      });
      expect(
        (
          await svc.compensation.asOf(
            fx.users.hr!,
            fx.assignmentDeptB,
            '2026-03-01',
          )
        ).record?.rateAmount,
      ).toBe('18.0000');
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'America/Vancouver' },
      });
      expect(
        (await svc.compensation.history(fx.users.hr!, fx.assignmentDeptB)).asOf,
      ).toBe('2026-10-05');
      // The profile model returns only the assignments the reader may see.
      const teamView = await svc.compensation.employee(
        fx.users.teamReader!,
        fx.employee1,
      );
      expect(teamView.assignments.map((a) => a.assignment.id)).toEqual([
        fx.assignmentTeamA,
      ]);
      const hrView = await svc.compensation.employee(
        fx.users.hr!,
        fx.employee1,
      );
      expect(hrView.assignments.map((a) => a.assignment.id).sort()).toEqual(
        [fx.assignmentDeptB, fx.assignmentTeamA].sort(),
      );
      // Nothing compensation-related leaks into the response beyond the documented fields.
      expect(Object.keys(view.current!).sort()).toEqual(
        [
          'createdAt',
          'currency',
          'effectiveFrom',
          'effectiveTo',
          'employmentAssignmentId',
          'id',
          'payBasis',
          'payGroup',
          'rateAmount',
          'reason',
          'recordType',
          'salaryArrangement',
          'salaryContractAmount',
          'salaryMonthlyAmount',
          'salaryPaidMonths',
          'salaryPeriodEnd',
          'salaryPeriodStart',
          'supersededAt',
          'supersedesRecordId',
        ].sort(),
      );
    });
  });

  // ─── Batch 6: payroll-facing contract ──────────────────────────────────────

  it('answers payroll with one deterministic, traceable, decimal-safe fact per assignment and date', async () => {
    await scenario(async ({ tx, fx, svc, hr }) => {
      const group = await svc.payGroups.create(
        { organizationId: fx.orgA, code: 'HBL-BIWEEKLY', name: 'HBL Biweekly' },
        hr,
      );
      const first = await svc.compensation.create(
        fx.assignmentTeamA,
        hourly('24.5', '2026-01-01', { payGroupId: group.id }),
        hr,
      );
      await svc.compensation.create(
        fx.otherTeamA,
        {
          payBasis: 'SALARY',
          rateAmount: '62000',
          currency: 'USD',
          effectiveFrom: '2026-01-01',
        },
        hr,
      );
      const fact = await svc.payroll.compensationEffectiveOn({
        employmentAssignmentId: fx.assignmentTeamA,
        date: '2026-10-01',
      });
      expect(fact).toEqual({
        compensationRecordId: first.id,
        employmentAssignmentId: fx.assignmentTeamA,
        payBasis: 'HOURLY',
        rateAmount: '24.5000',
        salaryArrangement: null,
        salaryMonthlyAmount: null,
        salaryPaidMonths: null,
        salaryContractAmount: null,
        salaryPeriodStart: null,
        salaryPeriodEnd: null,
        currency: 'CAD',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        payGroupId: group.id,
      });
      // Facts only: no calculated amount of any kind.
      expect(Object.keys(fact!).sort()).toEqual(
        [
          'compensationRecordId',
          'currency',
          'effectiveFrom',
          'effectiveTo',
          'employmentAssignmentId',
          'payBasis',
          'payGroupId',
          'rateAmount',
          'salaryArrangement',
          'salaryContractAmount',
          'salaryMonthlyAmount',
          'salaryPaidMonths',
          'salaryPeriodEnd',
          'salaryPeriodStart',
        ].sort(),
      );
      // Assignment-aware: another assignment answers with its own fact.
      expect(
        await svc.payroll.compensationEffectiveOn({
          employmentAssignmentId: fx.otherTeamA,
          date: '2026-10-01',
        }),
      ).toMatchObject({
        payBasis: 'SALARY',
        salaryArrangement: 'ANNUAL',
        rateAmount: '62000.0000',
        currency: 'USD',
      });
      // A later raise never changes which record applied to an earlier date.
      await svc.compensation.change(
        fx.assignmentTeamA,
        hourly('26', '2026-11-01'),
        hr,
      );
      const october = await svc.payroll.compensationEffectiveOn({
        employmentAssignmentId: fx.assignmentTeamA,
        date: '2026-10-31',
      });
      const november = await svc.payroll.compensationEffectiveOn({
        employmentAssignmentId: fx.assignmentTeamA,
        date: '2026-11-01',
      });
      expect(october).toMatchObject({
        compensationRecordId: first.id,
        rateAmount: '24.5000',
        effectiveTo: '2026-10-31',
      });
      expect(november).toMatchObject({
        rateAmount: '26.0000',
        effectiveFrom: '2026-11-01',
      });
      expect(november!.compensationRecordId).not.toBe(first.id);
      // One pay period's facts, in order.
      expect(
        (
          await svc.payroll.compensationFactsBetween({
            employmentAssignmentId: fx.assignmentTeamA,
            from: '2026-10-25',
            to: '2026-11-07',
          })
        ).map((f) => [f.compensationRecordId === first.id, f.rateAmount]),
      ).toEqual([
        [true, '24.5000'],
        [false, '26.0000'],
      ]);
      // Never outside the assignment; an open-ended record reports the assignment's end.
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { status: 'ENDED', endDate: d('2027-03-31') },
      });
      expect(
        await svc.payroll.compensationEffectiveOn({
          employmentAssignmentId: fx.assignmentTeamA,
          date: '2027-04-01',
        }),
      ).toBeNull();
      expect(
        await svc.payroll.compensationEffectiveOn({
          employmentAssignmentId: fx.assignmentTeamA,
          date: '2025-12-31',
        }),
      ).toBeNull();
      expect(
        (
          await svc.payroll.compensationEffectiveOn({
            employmentAssignmentId: fx.assignmentTeamA,
            date: '2027-03-31',
          })
        )?.effectiveTo,
      ).toBe('2027-03-31');
      expect(
        await svc.payroll.compensationEffectiveOn({
          employmentAssignmentId: fx.assignmentDeptB,
          date: '2026-10-01',
        }),
      ).toBeNull();
      // Decimal-safe end to end: the stored value and the fact agree exactly.
      const stored = await tx.compensationRecord.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(
        new Prisma.Decimal(fact!.rateAmount).equals(stored.rateAmount),
      ).toBe(true);
      // Validation.
      await expect(
        svc.payroll.compensationEffectiveOn({
          employmentAssignmentId: fx.assignmentTeamA,
          date: '2026-13-01',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
