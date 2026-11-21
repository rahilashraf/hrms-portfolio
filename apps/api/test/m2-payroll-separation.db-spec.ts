import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import type { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { ROLE_TEMPLATES } from '../src/authorization/role-templates.js';
import { compensationServices } from './support/compensation-fixtures.js';
import { featureServices } from './support/features-fixtures.js';
import {
  d,
  FixedPayrollClock,
  PAYROLL_PERMISSION_KEYS,
  payGroup,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
  PAYROLL_WORLD_USERS,
  world,
  type World,
} from './support/payroll-world.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

/**
 * Security remediation M2 — payroll separation of duties (maker-checker), written before the
 * implementation. Rollback harness: every scenario runs in one transaction that is rolled back.
 */
class RollbackFixtures extends Error {}

const template = (key: string) =>
  ROLE_TEMPLATES.find((t) => t.key === key)?.permissions ?? [];

const PREPARER = [
  'payroll.read',
  'payroll.manage',
  'payroll.calculate',
  'payroll.adjust',
  'compensation.read',
  'compensation.manage',
];
const APPROVER = ['payroll.read', 'payroll.approve', 'payroll.finalize'];

const USERS = {
  ...PAYROLL_WORLD_USERS,
  // One person holding both the preparer and the approver permissions.
  both: [
    {
      permissions: [...new Set([...PREPARER, ...APPROVER])],
      scope: 'org' as const,
    },
  ],
  approverFinal: [{ permissions: APPROVER, scope: 'org' as const }],
  // Authors adjustments and may approve.
  adjAuthor: [
    {
      permissions: ['payroll.adjust', ...APPROVER],
      scope: 'org' as const,
    },
  ],
  // Changes compensation and may approve.
  compApprover: [
    {
      permissions: [
        'employee.read',
        'compensation.read',
        'compensation.manage',
        ...APPROVER,
      ],
      scope: 'org' as const,
    },
  ],
  featureAdmin: [
    { permissions: ['feature.manage', 'feature.read'], scope: 'org' as const },
  ],
  self2: [
    ...PAYROLL_WORLD_USERS.self2,
    { permissions: PAYROLL_PERMISSION_KEYS, scope: 'org' as const },
  ],
};

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    const body = http.getResponse?.() as
      { code?: string; reason?: string } | undefined;
    return {
      status: http.getStatus?.(),
      code: body?.code,
      ...(body?.reason ? { reason: body.reason } : {}),
    };
  }
  return { status: 200 };
};

const separation = (reason: string) => ({
  status: 403,
  code: 'PAYROLL_SEPARATION_OF_DUTIES',
  reason,
});

/** A SYSTEM-scope administrator (the reserved System Owner role) inside the test transaction. */
async function systemAdmin(tx: Tx, suffix: string) {
  let role = await tx.role.findFirst({ where: { isSystemOwner: true } });
  if (!role)
    role = await tx.role.create({
      data: { code: 'SYSTEM_OWNER', name: 'System Owner', isSystemOwner: true },
    });
  for (const key of ['feature.manage', 'feature.read', 'payroll.read']) {
    const permission = await tx.permission.upsert({
      where: { key },
      create: { key, name: key, isActive: true },
      update: { isActive: true },
    });
    await tx.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      create: { roleId: role.id, permissionId: permission.id },
      update: {},
    });
  }
  const person = await tx.person.create({ data: {} });
  const user = await tx.user.create({
    data: {
      personId: person.id,
      email: `m2-system-${suffix.toLowerCase()}@example.com`,
      status: 'ACTIVE',
    },
  });
  await tx.roleAssignment.create({
    data: { userId: user.id, roleId: role.id, scopeType: 'SYSTEM' },
  });
  return user.id;
}

const settingVersion = async (tx: Tx, organizationId: string) =>
  (
    await tx.organizationSetting.findUnique({
      where: {
        organizationId_key: { organizationId, key: 'payroll.dualControl' },
      },
    })
  )?.version ?? 0;

/** Splits the backfill file into its statements (each ends with a line holding only `;`). */
const backfillStatements = () =>
  readFileSync(
    new URL(
      '../../../docs/security/sql/m2-payroll-provenance-backfill.sql',
      import.meta.url,
    ),
    'utf8',
  )
    .split(/^;\s*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => /\b(UPDATE|INSERT)\b/.test(statement));

describe('Security remediation M2: payroll separation of duties (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  type Extra = {
    features: ReturnType<typeof featureServices>;
    comp: ReturnType<typeof compensationServices>;
    clock: FixedPayrollClock;
  };

  async function scenario(run: (w: World, extra: Extra) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS).catch(
            (error: unknown) => {
              console.error('FIXTURE FAILURE', error);
              throw error;
            },
          );
          const clock = new FixedPayrollClock();
          const client = rollbackClient(tx);
          const svc = payrollServices(client, clock);
          await run(await world(tx, fx, svc), {
            features: featureServices(client),
            comp: compensationServices(client),
            clock,
          }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 180_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const newRun = async ({ svc, admin, periodId }: World) =>
    svc.runs.createRun({ payrollPeriodId: periodId, currency: 'CAD' }, admin);

  const disable = (
    extra: Extra,
    tx: Tx,
    fx: SchedulingFixtures,
    actor: string,
    body: { reason?: string; confirm?: boolean } = {
      reason: 'Single-person payroll office during the audit',
      confirm: true,
    },
  ) =>
    settingVersion(tx, fx.orgA).then((expectedVersion) =>
      extra.features.features.setSetting(
        {
          organizationId: fx.orgA,
          key: 'payroll.dualControl',
          value: false,
          expectedVersion,
          ...body,
        } as never,
        ctx(actor),
      ),
    );

  // ── 1, 2, 19: calculator vs approver; an administrator without an Employee record ─────────

  it('(1, 2, 19) the calculator cannot approve; another eligible administrator (no Employee record) can', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin } = w;
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      expect(
        (await tx.payrollRun.findUniqueOrThrow({ where: { id: run.id } }))
          .calculatedByUserId,
      ).toBe(fx.users.payrollAdmin);
      expect(await refusal(svc.lifecycle.approve(run.id, admin))).toEqual(
        separation('CALCULATED_BY_YOU'),
      );
      // The refusal is audited with its reason, and nothing changed.
      const refused = await tx.auditLog.findFirstOrThrow({
        where: { entityId: run.id, action: 'PAYROLL_RUN_APPROVAL_REFUSED' },
      });
      expect(refused).toMatchObject({ actorUserId: fx.users.payrollAdmin });
      expect(refused.metadata).toMatchObject({
        reason: 'CALCULATED_BY_YOU',
        dualControl: true,
      });
      expect(
        (await tx.payrollRun.findUniqueOrThrow({ where: { id: run.id } }))
          .status,
      ).toBe('CALCULATED');
      // The approver has no Employee record: a human administrator, eligible.
      const approverUser = await tx.user.findUniqueOrThrow({
        where: { id: fx.users.approver! },
        select: { person: { select: { employee: true } } },
      });
      expect(approverUser.person?.employee ?? null).toBeNull();
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
      const approved = await tx.payrollRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(approved).toMatchObject({
        status: 'APPROVED',
        approvedByUserId: fx.users.approver,
        calculatedByUserId: fx.users.payrollAdmin,
      });
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { entityId: run.id, action: 'PAYROLL_RUN_APPROVED' },
      });
      expect(audit.metadata).toMatchObject({
        dualControl: true,
        calculatedByUserId: fx.users.payrollAdmin,
      });
    });
  });

  it('server capabilities say who may approve, with a safe reason', async () => {
    await scenario(async (w) => {
      const { svc, fx, admin } = w;
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      const forCalculator = await svc.reads.run(fx.users.payrollAdmin!, run.id);
      expect(forCalculator).toMatchObject({
        dualControl: true,
        calculatedBy: { userId: fx.users.payrollAdmin },
        actions: {
          canApprove: false,
          approveBlockedReason: 'CALCULATED_BY_YOU',
        },
      });
      const forApprover = await svc.reads.run(fx.users.approver!, run.id);
      expect(forApprover.actions).toMatchObject({
        canApprove: true,
        approveBlockedReason: null,
      });
    });
  });

  // ── 3: adjustment author; unrelated adjustments never count ───────────────────────────────

  it('(3) the author of an adjustment the run carries cannot approve; an unrelated adjustment does not block', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin, payGroupId } = w;
      const author = ctx(fx.users.adjAuthor!);
      // An adjustment in another pay group: never carried by this run.
      const otherGroup = await payGroup(tx, fx.orgA, `PG2-${fx.suffix}`);
      await svc.adjustments.createAdjustment(
        {
          payGroupId: otherGroup.id,
          employmentAssignmentId: fx.otherTeamA,
          currency: 'CAD',
          kind: 'EARNING',
          amount: '10',
          description: 'Other group',
          reason: 'Unrelated correction',
        },
        ctx(fx.users.adjAuthor!),
      );
      const run = await newRun(w);
      await svc.adjustments.createAdjustment(
        {
          payGroupId,
          employmentAssignmentId: fx.otherTeamA,
          currency: 'CAD',
          kind: 'EARNING',
          amount: '125',
          description: 'Bonus',
          reason: 'Project completion bonus',
        },
        author,
      );
      await svc.runs.calculate(run.id, admin);
      expect(await refusal(svc.lifecycle.approve(run.id, author))).toEqual(
        separation('ADJUSTMENT_BY_YOU'),
      );
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
    });
  });

  // ── Review B1 / M1: manual lines and adjustment cancellations are preparation too ───────

  it('(review B1) whoever added a manual line to the run cannot approve it, nor rest a finalization on that approval', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin } = w;
      const x = ctx(fx.users.adjAuthor!);
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      const target = await tx.payrollRunAssignment.findFirstOrThrow({
        where: { payrollRunId: run.id, employmentAssignmentId: fx.otherTeamA },
      });
      await svc.adjustments.addManualLine(
        run.id,
        {
          payrollRunAssignmentId: target.id,
          kind: 'EARNING',
          amount: '50000.00',
          description: 'Bonus',
          reason: 'Discretionary bonus',
        },
        x,
      );
      expect(await refusal(svc.lifecycle.approve(run.id, x))).toEqual(
        separation('MANUAL_LINE_BY_YOU'),
      );
      expect(
        (await svc.reads.run(fx.users.adjAuthor!, run.id)).actions,
      ).toMatchObject({
        canApprove: false,
        approveBlockedReason: 'MANUAL_LINE_BY_YOU',
      });
      // A pre-M2 style approval by the line's author is not independent at finalization.
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
      await tx.payrollRun.update({
        where: { id: run.id },
        data: { approvedByUserId: fx.users.adjAuthor },
      });
      expect(
        await refusal(svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!))),
      ).toEqual(separation('INDEPENDENT_APPROVAL_REQUIRED'));
    });
  });

  it('(review B1) reversing someone else’s manual line is preparation too', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin } = w;
      const x = ctx(fx.users.adjAuthor!);
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      const target = await tx.payrollRunAssignment.findFirstOrThrow({
        where: { payrollRunId: run.id, employmentAssignmentId: fx.otherTeamA },
      });
      await svc.adjustments.addManualLine(
        run.id,
        {
          payrollRunAssignmentId: target.id,
          kind: 'DEDUCTION',
          amount: '400.00',
          description: 'Overpayment recovery',
          reason: 'Recover September overpayment',
        },
        admin,
      );
      const line = await tx.payrollDeductionLine.findFirstOrThrow({
        where: { payrollRunId: run.id, createdByUserId: fx.users.payrollAdmin },
      });
      await svc.adjustments.reverseManualLine(
        run.id,
        { lineId: line.id, kind: 'DEDUCTION', reason: 'Waived after review' },
        x,
      );
      expect(await refusal(svc.lifecycle.approve(run.id, x))).toEqual(
        separation('MANUAL_LINE_BY_YOU'),
      );
    });
  });

  it('(review M1) whoever cancelled an adjustment the run carried cannot approve it', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin, payGroupId } = w;
      const x = ctx(fx.users.adjAuthor!);
      await svc.adjustments.createAdjustment(
        {
          payGroupId,
          employmentAssignmentId: fx.otherTeamA,
          currency: 'CAD',
          kind: 'DEDUCTION',
          amount: '300',
          description: 'Overpayment recovery',
          reason: 'Paid twice in September',
        },
        admin,
      );
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      const carried = await tx.payrollAdjustment.findFirstOrThrow({
        where: { payrollRunId: run.id, status: 'PENDING' },
      });
      await svc.adjustments.cancelAdjustment(
        carried.id,
        'Not owed after all',
        x,
      );
      expect(
        (
          await tx.payrollAdjustment.findUniqueOrThrow({
            where: { id: carried.id },
          })
        ).cancelledFromRunId,
      ).toBe(run.id);
      expect(await refusal(svc.lifecycle.approve(run.id, x))).toEqual(
        separation('ADJUSTMENT_CANCELLED_BY_YOU'),
      );
      // The cancellation also made the run stale; after recalculation the canceller is still
      // barred (they changed its pay), and an independent approver approves.
      await svc.runs.calculate(run.id, admin);
      expect(await refusal(svc.lifecycle.approve(run.id, x))).toEqual(
        separation('ADJUSTMENT_CANCELLED_BY_YOU'),
      );
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
    });
  });

  it('(review L1) a correction that moved compensation out of the period still names its author', async () => {
    await scenario(async (w, { comp }) => {
      const { tx, fx, svc, admin, payGroupId } = w;
      const corrector = ctx(fx.users.compApprover!);
      const original = await tx.compensationRecord.findFirstOrThrow({
        where: { employmentAssignmentId: fx.otherTeamA, supersededAt: null },
      });
      // The correction ends the record before the period: it no longer pays these days. (As
      // CompensationService.correct does: the original is superseded by a CORRECTION record.)
      await tx.compensationRecord.update({
        where: { id: original.id },
        data: { supersededAt: new Date() },
      });
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: fx.otherTeamA,
          organizationId: fx.orgA,
          recordType: 'CORRECTION',
          payBasis: 'SALARY',
          rateAmount: '52000',
          currency: 'CAD',
          effectiveFrom: original.effectiveFrom,
          effectiveTo: d('2026-09-30'),
          payGroupId,
          supersedesRecordId: original.id,
          reason: 'Salary ended in September',
          createdByUserId: fx.users.compApprover,
        },
      });
      // Someone else adds pay for the rest of the period.
      await comp.compensation.create(
        fx.otherTeamA,
        {
          payBasis: 'SALARY',
          rateAmount: '40000',
          currency: 'CAD',
          effectiveFrom: '2026-10-10',
          payGroupId,
          reason: 'New arrangement',
        },
        ctx(fx.users.hr!),
      );
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      expect(await refusal(svc.lifecycle.approve(run.id, corrector))).toEqual(
        separation('COMPENSATION_CHANGED_BY_YOU'),
      );
    });
  });

  it('(re-review L) ending an employee’s pay so they drop out of the run still bars the closer', async () => {
    await scenario(async (w, { comp }) => {
      const { tx, fx, svc, admin } = w;
      const closer = ctx(fx.users.compApprover!);
      const record = await tx.compensationRecord.findFirstOrThrow({
        where: { employmentAssignmentId: fx.otherTeamA, supersededAt: null },
      });
      // Before the period (2026-10-04 – 2026-10-17): Employee 2 is no longer in the run.
      await comp.compensation.end(
        fx.otherTeamA,
        record.id,
        { effectiveTo: '2026-09-30', reason: 'Left the pay group' },
        closer,
      );
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      expect(
        await tx.payrollRunAssignment.count({
          where: {
            payrollRunId: run.id,
            employmentAssignmentId: fx.otherTeamA,
          },
        }),
      ).toBe(0);
      expect(await refusal(svc.lifecycle.approve(run.id, closer))).toEqual(
        separation('COMPENSATION_CHANGED_BY_YOU'),
      );
    });
  });

  // ── 4, 5: compensation authorship and closures (provenance, not timestamps) ──────────────

  it('(4) whoever changed compensation used by the run cannot approve it', async () => {
    await scenario(async (w, { comp }) => {
      const { tx, fx, svc, admin, payGroupId } = w;
      const changer = ctx(fx.users.compApprover!);
      await comp.compensation.change(
        fx.otherTeamA,
        {
          payBasis: 'SALARY',
          rateAmount: '60000',
          currency: 'CAD',
          effectiveFrom: '2026-10-08',
          payGroupId,
          reason: 'Promotion',
        },
        changer,
      );
      // The change closed the previous record: the closure ledger names who did it.
      const closures = await tx.compensationRecordClosure.findMany({
        where: { employmentAssignmentId: fx.otherTeamA },
      });
      expect(closures).toHaveLength(1);
      expect(closures[0]).toMatchObject({
        closedByUserId: fx.users.compApprover,
        source: 'APPLICATION',
      });
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      expect(await refusal(svc.lifecycle.approve(run.id, changer))).toEqual(
        separation('COMPENSATION_CHANGED_BY_YOU'),
      );
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
    });
  });

  it('(4b) ending a colleague’s compensation inside the period (a closure only) also bars approval', async () => {
    await scenario(async (w, { comp }) => {
      const { tx, fx, svc, admin } = w;
      const closer = ctx(fx.users.compApprover!);
      const record = await tx.compensationRecord.findFirstOrThrow({
        where: {
          employmentAssignmentId: fx.assignmentTeamA,
          supersededAt: null,
        },
      });
      await comp.compensation.end(
        fx.assignmentTeamA,
        record.id,
        { effectiveTo: '2026-10-10', reason: 'Hourly contract ended' },
        closer,
      );
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      expect(await refusal(svc.lifecycle.approve(run.id, closer))).toEqual(
        separation('COMPENSATION_CHANGED_BY_YOU'),
      );
    });
  });

  it('(5) a compensation change that does not affect the run’s pay does not block approval', async () => {
    await scenario(async (w, { comp }) => {
      const { fx, svc, admin, payGroupId } = w;
      const changer = ctx(fx.users.compApprover!);
      // Effective after the period (2026-10-04 – 2026-10-17): no pay in this run changes.
      await comp.compensation.change(
        fx.otherTeamA,
        {
          payBasis: 'SALARY',
          rateAmount: '61000',
          currency: 'CAD',
          effectiveFrom: '2026-11-01',
          payGroupId,
          reason: 'Annual increase',
        },
        changer,
      );
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      await svc.lifecycle.approve(run.id, changer);
    });
  });

  it('the closure ledger is append-only', async () => {
    await scenario(async (w, { comp }) => {
      const { tx, fx } = w;
      const record = await tx.compensationRecord.findFirstOrThrow({
        where: {
          employmentAssignmentId: fx.assignmentTeamA,
          supersededAt: null,
        },
      });
      await comp.compensation.end(
        fx.assignmentTeamA,
        record.id,
        { effectiveTo: '2026-12-31', reason: 'Contract end' },
        ctx(fx.users.compApprover!),
      );
      const closure = await tx.compensationRecordClosure.findFirstOrThrow({
        where: { compensationRecordId: record.id },
      });
      expect(closure).toMatchObject({
        closedByUserId: fx.users.compApprover,
        newEffectiveTo: d('2026-12-31'),
        previousEffectiveTo: null,
      });
      await expect(
        tx.$executeRawUnsafe(
          `DELETE FROM "CompensationRecordClosure" WHERE "id" = '${closure.id}'`,
        ),
      ).rejects.toThrow(/append-only|cannot/i);
    });
  });

  it('a record can no longer be shortened without a closure entry naming who did it', async () => {
    await scenario(async ({ tx, fx }) => {
      const record = await tx.compensationRecord.findFirstOrThrow({
        where: {
          employmentAssignmentId: fx.assignmentTeamA,
          supersededAt: null,
        },
      });
      await expect(
        tx.$executeRawUnsafe(
          `UPDATE "CompensationRecord" SET "effectiveTo" = '2026-10-10' WHERE "id" = '${record.id}'`,
        ),
      ).rejects.toThrow(/closure/i);
    });
  });

  // ── 6, 7: finalization ───────────────────────────────────────────────────────────────────

  it('(6, 7) the calculator cannot finalize even after independent approval; the approver may', async () => {
    await scenario(async (w) => {
      const { fx, svc, admin } = w;
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      await svc.lifecycle.approve(run.id, ctx(fx.users.approverFinal!));
      expect(await refusal(svc.lifecycle.finalize(run.id, admin))).toEqual(
        separation('CALCULATED_BY_YOU'),
      );
      await svc.lifecycle.finalize(run.id, ctx(fx.users.approverFinal!));
    });
  });

  it('finalization requires a valid independent approval (an approval by the calculator from before M2 is not one)', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin } = w;
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
      // Legacy state: the run was approved by the person who calculated it.
      await tx.payrollRun.update({
        where: { id: run.id },
        data: { approvedByUserId: fx.users.payrollAdmin },
      });
      expect(
        await refusal(svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!))),
      ).toEqual(separation('INDEPENDENT_APPROVAL_REQUIRED'));
    });
  });

  // ── 8: own pay ───────────────────────────────────────────────────────────────────────────

  it('(8) the own-pay rule still applies, with dual control on and off', async () => {
    await scenario(async (w, extra) => {
      const { tx, fx, svc, admin } = w;
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      expect(
        await refusal(svc.lifecycle.approve(run.id, ctx(fx.selfUser2))),
      ).toEqual({
        status: 403,
        code: 'PAYROLL_SELF_APPROVAL',
      });
      const system = await systemAdmin(tx, fx.suffix);
      await disable(extra, tx, fx, system);
      expect(
        await refusal(svc.lifecycle.approve(run.id, ctx(fx.selfUser2))),
      ).toEqual({
        status: 403,
        code: 'PAYROLL_SELF_APPROVAL',
      });
    });
  });

  // ── 9: both templates ────────────────────────────────────────────────────────────────────

  it('(9) one person holding both preparer and approver permissions still cannot approve their own calculation', async () => {
    await scenario(async (w) => {
      const { fx, svc } = w;
      const both = ctx(fx.users.both!);
      const run = await svc.runs.createRun(
        { payrollPeriodId: w.periodId, currency: 'CAD' },
        both,
      );
      await svc.runs.calculate(run.id, both);
      expect(await refusal(svc.lifecycle.approve(run.id, both))).toEqual(
        separation('CALCULATED_BY_YOU'),
      );
    });
  });

  it('role templates: Payroll preparer and Payroll approver are offered; the administrator template is unchanged', () => {
    expect([...template('PAYROLL_PREPARER')].sort()).toEqual(
      expect.arrayContaining(PREPARER),
    );
    expect(template('PAYROLL_PREPARER')).not.toContain('payroll.approve');
    expect(template('PAYROLL_PREPARER')).not.toContain('payroll.finalize');
    expect(template('PAYROLL_APPROVER')).toEqual(
      expect.arrayContaining(APPROVER),
    );
    for (const key of [
      'payroll.calculate',
      'payroll.adjust',
      'payroll.manage',
      'compensation.manage',
    ])
      expect(template('PAYROLL_APPROVER')).not.toContain(key);
    expect(template('PAYROLL_ADMINISTRATOR')).toEqual(
      expect.arrayContaining([
        'payroll.calculate',
        'payroll.approve',
        'payroll.finalize',
      ]),
    );
  });

  // ── 10–15: the setting ───────────────────────────────────────────────────────────────────

  it('(10, 11) dual control is on by default for existing and new organizations (no stored row)', async () => {
    await scenario(async (w, { features }) => {
      const { tx, fx } = w;
      const created = await tx.organization.create({
        data: {
          name: `M2 New ${fx.suffix}`,
          code: `M2N${fx.suffix}`.slice(0, 20),
        },
      });
      for (const organizationId of [fx.orgA, fx.orgB, created.id]) {
        expect(
          await tx.organizationSetting.count({
            where: { organizationId, key: 'payroll.dualControl' },
          }),
        ).toBe(0);
        expect(
          await features.gate.setting(
            organizationId,
            'payroll.dualControl' as never,
          ),
        ).toBe(true);
      }
    });
  });

  it('(12, 15) a SYSTEM administrator disables it with a reason: recorded, audited and visible', async () => {
    await scenario(async (w, extra) => {
      const { tx, fx, svc, admin } = w;
      const system = await systemAdmin(tx, fx.suffix);
      await disable(extra, tx, fx, system);
      const change = await tx.organizationSettingChange.findFirstOrThrow({
        where: { organizationId: fx.orgA, subject: 'payroll.dualControl' },
        orderBy: { changedAt: 'desc' },
      });
      expect(change).toMatchObject({
        actorUserId: system,
        reason: 'Single-person payroll office during the audit',
      });
      expect(change.oldValue).toBeNull();
      expect(change.newValue).toBe(false);
      const audit = await tx.auditLog.findFirstOrThrow({
        where: {
          entityId: fx.orgA,
          action: 'PAYROLL_DUAL_CONTROL_DISABLED',
        },
      });
      expect(audit).toMatchObject({ actorUserId: system });
      expect(audit.metadata).toMatchObject({
        previous: true,
        value: false,
        reason: 'Single-person payroll office during the audit',
      });
      // With dual control off the calculator may approve, and the policy state is recorded.
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      expect(
        (await svc.reads.run(fx.users.payrollAdmin!, run.id)).dualControl,
      ).toBe(false);
      await svc.lifecycle.approve(run.id, admin);
      const approved = await tx.auditLog.findFirstOrThrow({
        where: { entityId: run.id, action: 'PAYROLL_RUN_APPROVED' },
      });
      expect(approved.metadata).toMatchObject({ dualControl: false });
      // Restoring is audited too, and any feature administrator may restore it.
      await extra.features.features.setSetting(
        {
          organizationId: fx.orgA,
          key: 'payroll.dualControl',
          value: true,
          expectedVersion: await settingVersion(tx, fx.orgA),
        },
        ctx(fx.users.featureAdmin!),
      );
      expect(
        await tx.auditLog.count({
          where: { entityId: fx.orgA, action: 'PAYROLL_DUAL_CONTROL_ENABLED' },
        }),
      ).toBe(1);
    });
  });

  it('(13) an organization administrator cannot disable it, through set or reset', async () => {
    await scenario(async (w, extra) => {
      const { tx, fx } = w;
      expect(
        await refusal(disable(extra, tx, fx, fx.users.featureAdmin!)),
      ).toEqual({
        status: 403,
        code: 'PAYROLL_DUAL_CONTROL_SYSTEM_REQUIRED',
      });
      expect(
        await tx.organizationSetting.count({
          where: { organizationId: fx.orgA, key: 'payroll.dualControl' },
        }),
      ).toBe(0);
    });
  });

  it('(14) disabling needs a meaningful reason and an explicit confirmation', async () => {
    await scenario(async (w, extra) => {
      const { tx, fx } = w;
      const system = await systemAdmin(tx, fx.suffix);
      expect(
        await refusal(disable(extra, tx, fx, system, { confirm: true })),
      ).toEqual({
        status: 400,
        code: 'SETTING_REASON_REQUIRED',
      });
      expect(
        await refusal(
          disable(extra, tx, fx, system, { reason: 'short', confirm: true }),
        ),
      ).toEqual({ status: 400, code: 'SETTING_REASON_REQUIRED' });
      expect(
        await refusal(
          disable(extra, tx, fx, system, {
            reason: 'A sufficiently long reason',
          }),
        ),
      ).toEqual({ status: 400, code: 'SETTING_CONFIRMATION_REQUIRED' });
    });
  });

  // ── 16, 17: legacy runs and the backfill ─────────────────────────────────────────────────

  it('(16) a run with an unknown calculator must be recalculated before approval or finalization', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin } = w;
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      await tx.payrollRun.update({
        where: { id: run.id },
        data: { calculatedByUserId: null },
      });
      expect(
        await refusal(svc.lifecycle.approve(run.id, ctx(fx.users.approver!))),
      ).toEqual(separation('CALCULATOR_UNKNOWN_RECALCULATE'));
      await svc.runs.calculate(run.id, admin);
      await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));
      await tx.payrollRun.update({
        where: { id: run.id },
        data: { calculatedByUserId: null },
      });
      expect(
        await refusal(svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!))),
      ).toEqual(separation('CALCULATOR_UNKNOWN_RECALCULATE'));
    });
  });

  it('(17) the provenance backfill attributes only verified calculators and closures, and is idempotent', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin } = w;
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      await tx.payrollRun.update({
        where: { id: run.id },
        data: { calculatedByUserId: null },
      });
      // A legacy closure, known only from the audit trail.
      const record = await tx.compensationRecord.findFirstOrThrow({
        where: { employmentAssignmentId: fx.otherTeamA, supersededAt: null },
      });
      await tx.auditLog.create({
        data: {
          action: 'COMPENSATION_ENDED',
          actorUserId: fx.users.hr!,
          entityType: 'CompensationRecord',
          entityId: record.id,
          metadata: {
            employmentAssignmentId: fx.otherTeamA,
            effectiveTo: { before: null, after: '2026-12-31' },
          },
        },
      });
      for (let pass = 0; pass < 2; pass += 1)
        for (const statement of backfillStatements())
          await tx.$executeRawUnsafe(statement);
      expect(
        (await tx.payrollRun.findUniqueOrThrow({ where: { id: run.id } }))
          .calculatedByUserId,
      ).toBe(fx.users.payrollAdmin);
      const closures = await tx.compensationRecordClosure.findMany({
        where: { compensationRecordId: record.id },
      });
      expect(closures).toHaveLength(1);
      expect(closures[0]).toMatchObject({
        closedByUserId: fx.users.hr,
        source: 'LEGACY_AUDIT',
      });
    });
  });

  // ── 18: who may approve at all ───────────────────────────────────────────────────────────

  it('(18) actor-less (service) and disabled accounts never approve', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin } = w;
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      expect(
        (
          await refusal(
            svc.lifecycle.approve(run.id, { actorUserId: undefined } as never),
          )
        ).status,
      ).toBe(403);
      await tx.user.update({
        where: { id: fx.users.approver! },
        data: { status: 'DISABLED' },
      });
      expect(
        (await refusal(svc.lifecycle.approve(run.id, ctx(fx.users.approver!))))
          .status,
      ).toBe(403);
      expect(
        (await tx.payrollRun.findUniqueOrThrow({ where: { id: run.id } }))
          .status,
      ).toBe('CALCULATED');
    });
  });

  // ── 20: finalized payroll stays immutable ────────────────────────────────────────────────

  it('(20) a finalized run stays immutable: no approval, finalization, void or attribution change', async () => {
    await scenario(async (w) => {
      const { tx, fx, svc, admin } = w;
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      await svc.lifecycle.approve(run.id, ctx(fx.users.approverFinal!));
      await svc.lifecycle.finalize(run.id, ctx(fx.users.approverFinal!));
      for (const attempt of [
        svc.lifecycle.approve(run.id, ctx(fx.users.approver!)),
        svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!)),
        svc.lifecycle.void(run.id, 'Too late', admin),
      ])
        expect(await refusal(attempt)).toMatchObject({
          status: 409,
          code: 'PAYROLL_RUN_FINAL',
        });
      await expect(
        tx.$executeRawUnsafe(
          `UPDATE "PayrollRun" SET "calculatedByUserId" = NULL WHERE "id" = '${run.id}'`,
        ),
      ).rejects.toThrow(/final/);
    });
  });

  // ── Void: single-person by owner decision, behaviour preserved ───────────────────────────

  it('voiding a non-final run keeps its existing single-person rules, reason and history', async () => {
    await scenario(async (w) => {
      const { tx, svc, admin } = w;
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      expect(
        await refusal(svc.lifecycle.void(run.id, '  ', admin)),
      ).toMatchObject({
        status: 400,
      });
      await svc.lifecycle.void(
        run.id,
        'Created against the wrong period',
        admin,
      );
      const voided = await tx.payrollRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(voided).toMatchObject({
        status: 'VOIDED',
        voidReason: 'Created against the wrong period',
        calculatedByUserId: admin.actorUserId,
      });
      expect(
        await tx.payrollSourceClaim.count({ where: { payrollRunId: run.id } }),
      ).toBe(0);
      expect(
        await tx.payrollEarningLine.count({ where: { payrollRunId: run.id } }),
      ).toBeGreaterThan(0);
      expect(
        await refusal(svc.lifecycle.void(run.id, 'Again', admin)),
      ).toMatchObject({
        status: 409,
        code: 'PAYROLL_RUN_FINAL',
      });
    });
  });

  // ── Retro adjustments trace their compensation sources ───────────────────────────────────

  it('a retro adjustment records the compensation records behind it; their author cannot approve the run carrying it', async () => {
    await scenario(async (w, { comp }) => {
      const { tx, fx, svc, admin, payGroupId } = w;
      const run1 = await newRun(w);
      await svc.runs.calculate(run1.id, admin);
      await svc.lifecycle.approve(run1.id, ctx(fx.users.approverFinal!));
      await svc.lifecycle.finalize(run1.id, ctx(fx.users.approverFinal!));
      // A backdated raise inside the finalized period, by someone who may approve payroll.
      await comp.compensation.change(
        fx.otherTeamA,
        {
          payBasis: 'SALARY',
          rateAmount: '58000',
          currency: 'CAD',
          effectiveFrom: '2026-10-10',
          payGroupId,
          reason: 'Backdated promotion',
        },
        ctx(fx.users.compApprover!),
      );
      const raise = await tx.compensationRecord.findFirstOrThrow({
        where: { employmentAssignmentId: fx.otherTeamA, recordType: 'CHANGE' },
      });
      const retro = await svc.adjustments.createRetroAdjustments(
        run1.id,
        'Backdated promotion',
        admin,
      );
      expect(retro.created).toHaveLength(1);
      const sources = await tx.payrollAdjustmentCompensationSource.findMany({
        where: { adjustmentId: retro.created[0]! },
      });
      expect(sources.map((row) => row.compensationRecordId)).toContain(
        raise.id,
      );
      await svc.calendars.generatePeriods(
        { payGroupId, throughDate: '2026-10-18' },
        admin,
      );
      const period2 = await tx.payrollPeriod.findFirstOrThrow({
        where: { payGroupId, periodStart: d('2026-10-18') },
      });
      const run2 = await svc.runs.createRun(
        { payrollPeriodId: period2.id, currency: 'CAD' },
        admin,
      );
      await svc.runs.calculate(run2.id, admin);
      expect(
        await tx.payrollAdjustment.count({
          where: { id: retro.created[0]!, payrollRunId: run2.id },
        }),
      ).toBe(1);
      expect(
        await refusal(
          svc.lifecycle.approve(run2.id, ctx(fx.users.compApprover!)),
        ),
      ).toEqual(separation('COMPENSATION_CHANGED_BY_YOU'));
    });
  });

  // ── Engine invariants: who calculated, and the setting, never change amounts ─────────────

  it('amounts are identical whoever calculates and whatever the setting', async () => {
    await scenario(async (w, extra) => {
      const { tx, fx, svc, admin } = w;
      const snapshot = async (runId: string) => ({
        run: await tx.payrollRun.findUniqueOrThrow({
          where: { id: runId },
          select: {
            grossAmount: true,
            deductionAmount: true,
            employerContributionAmount: true,
            sourceFingerprint: true,
            calculationVersion: true,
          },
        }),
        lines: (
          await tx.payrollEarningLine.findMany({
            where: { payrollRunId: runId },
            select: {
              type: true,
              amount: true,
              quantity: true,
              rateAmount: true,
              workDate: true,
            },
          })
        )
          .map((l) => JSON.stringify(l))
          .sort(),
      });
      const run = await newRun(w);
      await svc.runs.calculate(run.id, admin);
      const first = await snapshot(run.id);
      await svc.runs.calculate(run.id, ctx(fx.users.both!));
      expect(await snapshot(run.id)).toEqual(first);
      const system = await systemAdmin(tx, fx.suffix);
      await disable(extra, tx, fx, system);
      await svc.runs.calculate(run.id, admin);
      expect(await snapshot(run.id)).toEqual(first);
    });
  });
});
