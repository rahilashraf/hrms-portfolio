import { config } from 'dotenv';
import type { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { compensationServices } from './support/compensation-fixtures.js';
import { featureServices } from './support/features-fixtures.js';
import {
  FixedPayrollClock,
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
  type Tx,
} from './support/scheduling-fixtures.js';
import { Gate } from './support/transaction-gates.js';

config({ path: '../../.env' });

/**
 * Security remediation M2 — races on committed data. A gate pauses one transaction just before
 * its audit write (its changes made, not committed); the competing operation must either wait
 * for it (pg_blocking_pids) or see its committed result, and the outcome must be a serial one:
 * no person approves or finalizes payroll they prepared, whatever the interleaving.
 *
 * Payroll history is immutable (finalized and voided runs can never be deleted), so these
 * fixtures are not removed: every test uses its own organizations (unique suffix).
 */

/** Pauses the transaction at its audit write for one action. */
class GatedAudit extends AuditService {
  constructor(
    prisma: PrismaService,
    private readonly gate: Gate,
    private readonly action: string,
  ) {
    super(prisma);
  }
  override async write(
    input: Parameters<AuditService['write']>[0],
    client?: Parameters<AuditService['write']>[1],
  ) {
    if (input.action === this.action) await this.gate.pass(client as never);
    return super.write(input, client);
  }
}

const APPROVER = ['payroll.read', 'payroll.approve', 'payroll.finalize'];
const USERS = {
  ...PAYROLL_WORLD_USERS,
  approverX: [{ permissions: APPROVER, scope: 'org' as const }],
  approverY: [{ permissions: APPROVER, scope: 'org' as const }],
  // Prepares and approves: may calculate, adjust and approve.
  dual: [
    {
      permissions: [
        'payroll.read',
        'payroll.manage',
        'payroll.calculate',
        'payroll.adjust',
        'payroll.approve',
        'payroll.finalize',
        'employee.read',
        'compensation.read',
        'compensation.manage',
      ],
      scope: 'org' as const,
    },
  ],
};

const outcome = (error: unknown) => {
  const http = error as HttpException;
  const body = http.getResponse?.() as
    { code?: string; reason?: string } | undefined;
  return { status: http.getStatus?.(), code: body?.code, reason: body?.reason };
};

describe('M2: payroll separation races (committed data)', () => {
  let prisma: PrismaService;
  const gates: Gate[] = [];

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const gate of gates) gate.open();
    await prisma?.$disconnect();
  });

  async function setup() {
    const fx = await createSchedulingFixtures(prisma as unknown as Tx, USERS);
    const clock = new FixedPayrollClock();
    const svc = payrollServices(prisma, clock);
    const w = await world(prisma as unknown as Tx, fx, svc);
    const run = await svc.runs.createRun(
      { payrollPeriodId: w.periodId, currency: 'CAD' },
      w.admin,
    );
    return { fx, clock, svc, w, run };
  }

  /** Services whose audit write for `action` pauses at `gate`. */
  function gated(clock: FixedPayrollClock, action: string) {
    const gate = new Gate();
    gates.push(gate);
    const audit = new GatedAudit(prisma, gate, action);
    return {
      gate,
      svc: payrollServices(prisma, clock, { audit }),
      features: featureServices(prisma, { audit }),
    };
  }

  async function runAgainst(gate: Gate, operation: () => Promise<unknown>) {
    let settled = false;
    const running = operation().finally(() => {
      settled = true;
    });
    running.catch(() => undefined);
    let waited = false;
    for (let i = 0; i < 200 && !settled && !waited; i += 1) {
      const [{ count }] = await prisma.$queryRawUnsafe<
        Array<{ count: bigint }>
      >(
        'SELECT count(*) AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        gate.pid,
      );
      waited = Number(count) > 0;
      if (!settled && !waited) await new Promise((r) => setTimeout(r, 50));
    }
    return { running, waited, settledFirst: settled };
  }

  const settle = (promise: Promise<unknown>) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  const runRow = (id: string) =>
    prisma.payrollRun.findUniqueOrThrow({ where: { id } });

  it('S1: recalculation by X committing while X approves: the approval waits, then is refused', async () => {
    const { fx, clock, svc, w, run } = await setup();
    await svc.runs.calculate(run.id, w.admin);
    const x = ctx(fx.users.dual!);
    const recalc = gated(clock, 'PAYROLL_RUN_RECALCULATED');
    const first = settle(recalc.svc.runs.calculate(run.id, x));
    await recalc.gate.reached;
    const second = await runAgainst(recalc.gate, () =>
      svc.lifecycle.approve(run.id, x),
    );
    expect(second.waited).toBe(true);
    recalc.gate.open();
    expect((await first).ok).toBe(true);
    const result = await settle(second.running);
    expect(result.ok).toBe(false);
    expect(outcome((result as { error: unknown }).error)).toMatchObject({
      status: 403,
      code: 'PAYROLL_SEPARATION_OF_DUTIES',
      reason: 'CALCULATED_BY_YOU',
    });
    expect(await runRow(run.id)).toMatchObject({
      status: 'CALCULATED',
      calculatedByUserId: fx.users.dual,
      approvedByUserId: null,
    });
  });

  it('S2: X approving first while X recalculates: the recalculation waits, clears the approval, and X can no longer approve', async () => {
    const { fx, clock, svc, w, run } = await setup();
    await svc.runs.calculate(run.id, w.admin);
    const x = ctx(fx.users.dual!);
    const approval = gated(clock, 'PAYROLL_RUN_APPROVED');
    const first = settle(approval.svc.lifecycle.approve(run.id, x));
    await approval.gate.reached;
    const second = await runAgainst(approval.gate, () =>
      svc.runs.calculate(run.id, x),
    );
    expect(second.waited).toBe(true);
    approval.gate.open();
    expect((await first).ok).toBe(true);
    expect((await settle(second.running)).ok).toBe(true);
    expect(await runRow(run.id)).toMatchObject({
      status: 'CALCULATED',
      calculatedByUserId: fx.users.dual,
      approvedByUserId: null,
    });
    const again = await settle(svc.lifecycle.approve(run.id, x));
    expect(outcome((again as { error: unknown }).error)).toMatchObject({
      reason: 'CALCULATED_BY_YOU',
    });
  });

  it('S3: a calculation claiming X’s adjustment while X approves: the approval waits, then is refused', async () => {
    const { fx, clock, svc, w, run } = await setup();
    await svc.runs.calculate(run.id, w.admin);
    const x = ctx(fx.users.dual!);
    await svc.adjustments.createAdjustment(
      {
        payGroupId: w.payGroupId,
        employmentAssignmentId: fx.otherTeamA,
        currency: 'CAD',
        kind: 'EARNING',
        amount: '80',
        description: 'Retention bonus',
        reason: 'Retention agreement',
      },
      x,
    );
    const recalc = gated(clock, 'PAYROLL_RUN_RECALCULATED');
    const first = settle(recalc.svc.runs.calculate(run.id, w.admin));
    await recalc.gate.reached;
    const second = await runAgainst(recalc.gate, () =>
      svc.lifecycle.approve(run.id, x),
    );
    expect(second.waited).toBe(true);
    recalc.gate.open();
    expect((await first).ok).toBe(true);
    const result = await settle(second.running);
    expect(outcome((result as { error: unknown }).error)).toMatchObject({
      reason: 'ADJUSTMENT_BY_YOU',
    });
  });

  it('S4: a compensation change by the approver racing an approval never yields a finalized run on unapproved data', async () => {
    const { fx, clock, svc, w, run } = await setup();
    await svc.runs.calculate(run.id, w.admin);
    const comp = compensationServices(prisma);
    const approval = gated(clock, 'PAYROLL_RUN_APPROVED');
    const first = settle(
      approval.svc.lifecycle.approve(run.id, ctx(fx.users.dual!)),
    );
    await approval.gate.reached;
    // The change does not touch the run: it commits while the approval is open.
    await comp.compensation.change(
      fx.otherTeamA,
      {
        payBasis: 'SALARY',
        rateAmount: '70000',
        currency: 'CAD',
        effectiveFrom: '2026-10-08',
        payGroupId: w.payGroupId,
        reason: 'Raise',
      },
      ctx(fx.users.dual!),
    );
    approval.gate.open();
    expect((await first).ok).toBe(true);
    // Finalization sees the change: the approver changed compensation this run pays, so the
    // approval is not independent; nothing is finalized.
    const finalize = await settle(
      svc.lifecycle.finalize(run.id, ctx(fx.users.approverY!)),
    );
    expect(outcome((finalize as { error: unknown }).error)).toMatchObject({
      code: 'PAYROLL_SEPARATION_OF_DUTIES',
      reason: 'INDEPENDENT_APPROVAL_REQUIRED',
    });
    expect(await runRow(run.id)).toMatchObject({ status: 'APPROVED' });
    // After recalculation the change's author is barred.
    await svc.runs.calculate(run.id, w.admin);
    const again = await settle(
      svc.lifecycle.approve(run.id, ctx(fx.users.dual!)),
    );
    expect(outcome((again as { error: unknown }).error)).toMatchObject({
      reason: 'COMPENSATION_CHANGED_BY_YOU',
    });
  });

  it('S5: disabling dual control while the calculator approves: the approval waits for the setting, then applies it', async () => {
    const { fx, clock, svc, w, run } = await setup();
    await svc.runs.calculate(run.id, w.admin);
    // The reserved System Owner role is removed again afterwards when this test created it:
    // other suites create it inside their own (rolled back) transactions.
    let createdRole: string | null = null;
    let assignmentId: string | null = null;
    const system = await (async () => {
      let role = await prisma.role.findFirst({
        where: { isSystemOwner: true },
      });
      if (!role) {
        role = await prisma.role.create({
          data: {
            code: 'SYSTEM_OWNER',
            name: 'System Owner',
            isSystemOwner: true,
          },
        });
        createdRole = role.id;
      }
      for (const key of ['feature.manage', 'feature.read']) {
        const permission = await prisma.permission.upsert({
          where: { key },
          create: { key, name: key, isActive: true },
          update: { isActive: true },
        });
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permission.id,
            },
          },
          create: { roleId: role.id, permissionId: permission.id },
          update: {},
        });
      }
      const person = await prisma.person.create({ data: {} });
      const user = await prisma.user.create({
        data: {
          personId: person.id,
          email: `m2-race-system-${fx.suffix.toLowerCase()}@example.com`,
          status: 'ACTIVE',
        },
      });
      assignmentId = (
        await prisma.roleAssignment.create({
          data: { userId: user.id, roleId: role.id, scopeType: 'SYSTEM' },
        })
      ).id;
      return user.id;
    })();
    try {
      const setting = gated(clock, 'PAYROLL_DUAL_CONTROL_DISABLED');
      const first = settle(
        setting.features.features.setSetting(
          {
            organizationId: fx.orgA,
            key: 'payroll.dualControl',
            value: false,
            expectedVersion: 0,
            reason: 'Single administrator this week',
            confirm: true,
          } as never,
          ctx(system),
        ),
      );
      await setting.gate.reached;
      const second = await runAgainst(setting.gate, () =>
        svc.lifecycle.approve(run.id, w.admin),
      );
      expect(second.waited).toBe(true);
      setting.gate.open();
      expect((await first).ok).toBe(true);
      expect((await settle(second.running)).ok).toBe(true);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: run.id, action: 'PAYROLL_RUN_APPROVED' },
      });
      expect(audit.metadata).toMatchObject({ dualControl: false });
    } finally {
      if (assignmentId)
        await prisma.roleAssignment.deleteMany({ where: { id: assignmentId } });
      if (createdRole) {
        await prisma.rolePermission.deleteMany({
          where: { roleId: createdRole },
        });
        await prisma.role.deleteMany({ where: { id: createdRole } });
      }
    }
  });

  it('S6: approval then finalization: finalization waits for the approval and then applies the rules', async () => {
    const { fx, clock, svc, w, run } = await setup();
    await svc.runs.calculate(run.id, w.admin);
    const approval = gated(clock, 'PAYROLL_RUN_APPROVED');
    const first = settle(
      approval.svc.lifecycle.approve(run.id, ctx(fx.users.approverX!)),
    );
    await approval.gate.reached;
    // The calculator tries to finalize the moment the approval lands.
    const second = await runAgainst(approval.gate, () =>
      svc.lifecycle.finalize(run.id, w.admin),
    );
    expect(second.waited).toBe(true);
    approval.gate.open();
    expect((await first).ok).toBe(true);
    const result = await settle(second.running);
    expect(outcome((result as { error: unknown }).error)).toMatchObject({
      reason: 'CALCULATED_BY_YOU',
    });
    await svc.lifecycle.finalize(run.id, ctx(fx.users.approverX!));
    expect(await runRow(run.id)).toMatchObject({
      status: 'FINALIZED',
      finalizedByUserId: fx.users.approverX,
    });
  });

  it('S7: two concurrent approvals: exactly one succeeds and is audited', async () => {
    const { fx, clock, svc, w, run } = await setup();
    await svc.runs.calculate(run.id, w.admin);
    const approval = gated(clock, 'PAYROLL_RUN_APPROVED');
    const first = settle(
      approval.svc.lifecycle.approve(run.id, ctx(fx.users.approverX!)),
    );
    await approval.gate.reached;
    const second = await runAgainst(approval.gate, () =>
      svc.lifecycle.approve(run.id, ctx(fx.users.approverY!)),
    );
    expect(second.waited).toBe(true);
    approval.gate.open();
    expect((await first).ok).toBe(true);
    const result = await settle(second.running);
    expect(outcome((result as { error: unknown }).error)).toMatchObject({
      status: 409,
      code: 'PAYROLL_RUN_STATUS',
    });
    expect(
      await prisma.auditLog.count({
        where: { entityId: run.id, action: 'PAYROLL_RUN_APPROVED' },
      }),
    ).toBe(1);
    expect((await runRow(run.id)).approvedByUserId).toBe(fx.users.approverX);
  });

  it('S8: a void and an approval: whichever commits first wins, the other waits and sees it', async () => {
    const { fx, clock, svc, w, run } = await setup();
    await svc.runs.calculate(run.id, w.admin);
    const voiding = gated(clock, 'PAYROLL_RUN_VOIDED');
    const first = settle(
      voiding.svc.lifecycle.void(run.id, 'Wrong period', w.admin),
    );
    await voiding.gate.reached;
    const second = await runAgainst(voiding.gate, () =>
      svc.lifecycle.approve(run.id, ctx(fx.users.approverX!)),
    );
    expect(second.waited).toBe(true);
    voiding.gate.open();
    expect((await first).ok).toBe(true);
    const result = await settle(second.running);
    expect(outcome((result as { error: unknown }).error)).toMatchObject({
      status: 409,
      code: 'PAYROLL_RUN_FINAL',
    });
    expect((await runRow(run.id)).status).toBe('VOIDED');
  });

  it('S9: two concurrent voids: exactly one voids the run', async () => {
    const { fx, clock, svc, w, run } = await setup();
    await svc.runs.calculate(run.id, w.admin);
    const voiding = gated(clock, 'PAYROLL_RUN_VOIDED');
    const first = settle(
      voiding.svc.lifecycle.void(run.id, 'Duplicate run', w.admin),
    );
    await voiding.gate.reached;
    const second = await runAgainst(voiding.gate, () =>
      svc.lifecycle.void(run.id, 'Duplicate run (again)', ctx(fx.users.dual!)),
    );
    expect(second.waited).toBe(true);
    voiding.gate.open();
    expect((await first).ok).toBe(true);
    const result = await settle(second.running);
    expect(outcome((result as { error: unknown }).error)).toMatchObject({
      status: 409,
      code: 'PAYROLL_RUN_FINAL',
    });
    expect(
      await prisma.auditLog.count({
        where: { entityId: run.id, action: 'PAYROLL_RUN_VOIDED' },
      }),
    ).toBe(1);
  });

  void ({} as World);
});
