import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, jsonValue } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PayrollAccessService } from './payroll-access.service.js';
import { requirePayrollText } from './payroll-domain.js';
import {
  lockPayGroup,
  PayrollClock,
  writePayrollAudit,
  type PayrollRequestContext,
} from './payroll-common.js';
import { PayrollRunService, type LockedRun } from './payroll-run.service.js';
import {
  PAYROLL_SEPARATION_MESSAGES,
  PayrollSeparationService,
  type PayrollSeparationReason,
} from './payroll-separation.service.js';
import {
  STATUTORY_PAYROLL_CALCULATOR,
  type StatutoryPayrollCalculator,
} from './statutory/statutory-payroll.contracts.js';

type Tx = Prisma.TransactionClient;

/**
 * Phase 10 Batch 9 — the payroll run lifecycle after calculation:
 *
 *   DRAFT → CALCULATED → APPROVED → FINALIZED, and VOIDED from any non-final status.
 *
 * Approval (payroll.approve) needs no blocking issue and unchanged sources; finalization
 * (payroll.finalize) checks source freshness again, then makes the run immutable forever (the
 * database enforces it), applies the adjustments it carries and finalizes the pay period once
 * no other live run remains. A stale approved run returns to CALCULATED and needs
 * recalculation and fresh approval. Every transition locks the run row (FOR UPDATE), so two
 * administrators can never approve or finalize the same run twice. No one approves or
 * finalizes a run that pays themselves.
 *
 * Security remediation M2: with payroll dual control on (the default), approval and
 * finalization are also independent of preparation (PayrollSeparationService), checked after
 * the run lock; a refusal is audited (PAYROLL_RUN_APPROVAL_REFUSED / _FINALIZATION_REFUSED)
 * and changes nothing else. Approval and finalization audits record the policy state.
 */
@Injectable()
export class PayrollLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PayrollAccessService,
    private readonly audit: AuditService,
    private readonly clock: PayrollClock,
    private readonly runs: PayrollRunService,
    @Inject(STATUTORY_PAYROLL_CALCULATOR)
    private readonly statutory: StatutoryPayrollCalculator,
    private readonly separation: PayrollSeparationService,
  ) {}

  async approve(runId: string, context: PayrollRequestContext) {
    const run = await this.runs.runOrThrow(runId);
    await this.access.assert(
      context.actorUserId,
      'payroll.approve',
      run.organizationId,
    );
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const locked = await this.runs.lockRun(tx, runId);
        if (locked.status !== 'CALCULATED')
          throw this.runs.statusConflict(locked.status, 'approved');
        await this.assertNotSelf(tx, locked, context, 'approve');
        const policy = await this.separationPolicy(tx, locked.id);
        const refused = await this.separation.approvalRefusal(
          tx,
          policy.run,
          context.actorUserId,
          policy.dualControl,
        );
        if (refused) {
          await this.auditRefusal(
            tx,
            locked.id,
            context,
            'approve',
            refused,
            policy,
          );
          return { stale: null, refused };
        }
        const errors = await tx.payrollValidationIssue.count({
          where: { payrollRunId: locked.id, severity: 'ERROR' },
        });
        if (errors > 0) {
          throw new ConflictException(
            domainError(
              409,
              'PAYROLL_RUN_HAS_ERRORS',
              `The run has ${errors} blocking validation error(s); resolve them and recalculate first.`,
            ),
          );
        }
        const stale = await this.recordIfStale(tx, locked, context);
        if (stale) return { stale, refused: null };
        const now = this.clock.now();
        await tx.payrollRun.update({
          where: { id: locked.id },
          data: {
            status: 'APPROVED',
            approvedAt: now,
            approvedByUserId: context.actorUserId,
          },
        });
        await writePayrollAudit(this.audit, tx, {
          action: 'PAYROLL_RUN_APPROVED',
          entityType: 'PayrollRun',
          entityId: locked.id,
          context,
          metadata: {
            ...(await this.lifecycleMetadata(
              tx,
              locked.id,
              'CALCULATED',
              'APPROVED',
            )),
            dualControl: policy.dualControl,
            calculatedByUserId: policy.run.calculatedByUserId,
          },
        });
        return { stale: null, refused: null };
      },
      { timeout: 120_000 },
    );
    if (outcome.refused) throw this.separationRefusal(outcome.refused);
    if (outcome.stale) throw this.staleConflict(outcome.stale);
    return { id: runId };
  }

  async finalize(runId: string, context: PayrollRequestContext) {
    const run = await this.runs.runOrThrow(runId);
    await this.access.assert(
      context.actorUserId,
      'payroll.finalize',
      run.organizationId,
    );
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const locked = await this.runs.lockRun(tx, runId);
        if (locked.status !== 'APPROVED')
          throw this.runs.statusConflict(locked.status, 'finalized');
        await this.assertNotSelf(tx, locked, context, 'finalize');
        const policy = await this.separationPolicy(tx, locked.id);
        const refused = await this.separation.finalizationRefusal(
          tx,
          policy.run,
          context.actorUserId,
          policy.dualControl,
        );
        if (refused) {
          await this.auditRefusal(
            tx,
            locked.id,
            context,
            'finalize',
            refused,
            policy,
          );
          return { stale: null, refused };
        }
        const stale = await this.recordIfStale(tx, locked, context);
        if (stale) return { stale, refused: null };
        const now = this.clock.now();
        await tx.payrollRun.update({
          where: { id: locked.id },
          data: {
            status: 'FINALIZED',
            finalizedAt: now,
            finalizedByUserId: context.actorUserId,
          },
        });
        const applied = await tx.payrollAdjustment.updateMany({
          where: { payrollRunId: locked.id, status: 'PENDING' },
          data: { status: 'APPLIED', appliedAt: now },
        });
        const otherLive = await tx.payrollRun.count({
          where: {
            payrollPeriodId: locked.payrollPeriodId,
            id: { not: locked.id },
            status: { in: ['DRAFT', 'CALCULATED', 'APPROVED'] },
          },
        });
        if (otherLive === 0) {
          await tx.payrollPeriod.update({
            where: { id: locked.payrollPeriodId },
            data: { status: 'FINALIZED' },
          });
        }
        await writePayrollAudit(this.audit, tx, {
          action: 'PAYROLL_RUN_FINALIZED',
          entityType: 'PayrollRun',
          entityId: locked.id,
          context,
          metadata: {
            ...(await this.lifecycleMetadata(
              tx,
              locked.id,
              'APPROVED',
              'FINALIZED',
            )),
            adjustmentsApplied: applied.count,
            periodFinalized: otherLive === 0,
            dualControl: policy.dualControl,
            calculatedByUserId: policy.run.calculatedByUserId,
            approvedByUserId: policy.run.approvedByUserId,
          },
        });
        return { stale: null, refused: null };
      },
      { timeout: 120_000 },
    );
    if (outcome.refused) throw this.separationRefusal(outcome.refused);
    if (outcome.stale) throw this.staleConflict(outcome.stale);
    return { id: runId };
  }

  async void(runId: string, reason: unknown, context: PayrollRequestContext) {
    const trimmed = requirePayrollText(reason, 'reason');
    const run = await this.runs.runOrThrow(runId);
    await this.access.assert(
      context.actorUserId,
      'payroll.manage',
      run.organizationId,
    );
    return this.prisma.$transaction(async (tx) => {
      await lockPayGroup(tx, run.payGroupId);
      const locked = await this.runs.lockRun(tx, runId);
      if (!['DRAFT', 'CALCULATED', 'APPROVED'].includes(locked.status)) {
        throw this.runs.statusConflict(locked.status, 'voided');
      }
      // Carried adjustments go back to pending for the next run: their lines leave this run
      // first (an adjustment has one line at a time), and the totals follow.
      const carried = await tx.payrollAdjustment.findMany({
        where: { payrollRunId: locked.id, status: 'PENDING' },
        select: { id: true },
      });
      await tx.payrollEarningLine.deleteMany({
        where: { payrollRunId: locked.id, origin: 'ADJUSTMENT' },
      });
      await tx.payrollDeductionLine.deleteMany({
        where: { payrollRunId: locked.id, category: 'ADJUSTMENT' },
      });
      await tx.payrollValidationIssue.deleteMany({
        where: { payrollRunId: locked.id, code: 'ADJUSTMENT_INCLUDED' },
      });
      // A voided run pays nothing: its sources are free for the run that replaces it.
      const releasedClaims = await tx.payrollSourceClaim.deleteMany({
        where: { payrollRunId: locked.id },
      });
      await tx.payrollAdjustment.updateMany({
        where: { id: { in: carried.map((row) => row.id) } },
        data: { payrollRunId: null },
      });
      const totals = await this.runs.applyTotals(tx, locked.id);
      await tx.payrollRun.update({
        where: { id: locked.id },
        data: {
          status: 'VOIDED',
          voidedAt: this.clock.now(),
          voidedByUserId: context.actorUserId,
          voidReason: trimmed,
          ...(locked.status === 'DRAFT' ? {} : totals),
        },
      });
      const otherLive = await tx.payrollRun.count({
        where: {
          payrollPeriodId: locked.payrollPeriodId,
          status: { in: ['DRAFT', 'CALCULATED', 'APPROVED'] },
        },
      });
      const finalized = await tx.payrollRun.count({
        where: { payrollPeriodId: locked.payrollPeriodId, status: 'FINALIZED' },
      });
      if (otherLive === 0) {
        await tx.payrollPeriod.updateMany({
          where: { id: locked.payrollPeriodId, status: 'PROCESSING' },
          data: { status: finalized > 0 ? 'FINALIZED' : 'OPEN' },
        });
      }
      await writePayrollAudit(this.audit, tx, {
        action: 'PAYROLL_RUN_VOIDED',
        entityType: 'PayrollRun',
        entityId: locked.id,
        context,
        metadata: {
          previousStatus: locked.status,
          status: 'VOIDED',
          reason: trimmed,
          adjustmentsReleased: carried.map((row) => row.id),
          sourceClaimsReleased: releasedClaims.count,
        },
      });
      return { id: runId };
    });
  }

  /** What the statutory boundary says for a run (always NOT_CALCULATED in Phase 10). */
  async statutoryStatus(runId: string, userId: string) {
    const run = await this.prisma.payrollRun.findUniqueOrThrow({
      where: { id: runId },
      include: { period: { include: { calendar: true } }, employees: true },
    });
    await this.access.assert(userId, 'payroll.read', run.organizationId);
    const result = await this.statutory.calculate({
      payrollRunId: run.id,
      currency: run.currency,
      payDate: run.period.payDate.toISOString().slice(0, 10),
      payPeriodsPerYear: {
        WEEKLY: 52,
        BIWEEKLY: 26,
        SEMIMONTHLY: 24,
        MONTHLY: 12,
      }[run.period.calendar.cadence],
      employees: [],
    });
    return { statutoryStatus: run.statutoryStatus, ...result };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Compares current sources with the run's fingerprint. When they differ, records a blocking
   * STALE_SOURCE_DATA issue and (for an approved run) withdraws the approval, in this
   * transaction; the caller commits and then refuses the transition.
   */
  private async recordIfStale(
    tx: Tx,
    run: LockedRun,
    context: PayrollRequestContext,
  ) {
    const freshness = await this.runs.freshnessOf(tx, run);
    if (!freshness.stale) return null;
    await tx.payrollValidationIssue.create({
      data: {
        payrollRunId: run.id,
        severity: 'ERROR',
        code: 'STALE_SOURCE_DATA',
        message:
          'Source data changed after the run was calculated; recalculate it.',
        metadata: jsonValue({
          changedAssignmentIds: freshness.changedAssignmentIds,
        }),
      },
    });
    if (run.status === 'APPROVED') {
      await tx.payrollRun.update({
        where: { id: run.id },
        data: {
          status: 'CALCULATED',
          approvedAt: null,
          approvedByUserId: null,
        },
      });
    }
    await writePayrollAudit(this.audit, tx, {
      action: 'PAYROLL_RUN_STALE_DETECTED',
      entityType: 'PayrollRun',
      entityId: run.id,
      context,
      metadata: {
        status: run.status,
        approvalWithdrawn: run.status === 'APPROVED',
        storedFingerprint: run.sourceFingerprint,
        currentFingerprint: freshness.currentFingerprint,
        changedAssignmentIds: freshness.changedAssignmentIds,
      },
    });
    return freshness;
  }

  private staleConflict(freshness: { changedAssignmentIds: string[] }) {
    return new ConflictException(
      domainError(
        409,
        'PAYROLL_RUN_STALE',
        'Source data changed after the run was calculated; it must be recalculated (and approved again).',
        { changedAssignmentIds: freshness.changedAssignmentIds },
      ),
    );
  }

  /** M2: the run's attribution and the organization's dual-control setting, under locks. */
  private async separationPolicy(tx: Tx, runId: string) {
    const run = await this.separation.runOf(tx, runId);
    const dualControl = await this.separation.dualControl(
      tx,
      run.organizationId,
      { lock: true },
    );
    return { run, dualControl };
  }

  /** M2: a refused approval or finalization is audited (it commits; nothing else changes). */
  private async auditRefusal(
    tx: Tx,
    runId: string,
    context: PayrollRequestContext,
    verb: 'approve' | 'finalize',
    reason: PayrollSeparationReason,
    policy: Awaited<ReturnType<PayrollLifecycleService['separationPolicy']>>,
  ) {
    await writePayrollAudit(this.audit, tx, {
      action:
        verb === 'approve'
          ? 'PAYROLL_RUN_APPROVAL_REFUSED'
          : 'PAYROLL_RUN_FINALIZATION_REFUSED',
      entityType: 'PayrollRun',
      entityId: runId,
      context,
      metadata: {
        reason,
        dualControl: policy.dualControl,
        calculatedByUserId: policy.run.calculatedByUserId,
        approvedByUserId: policy.run.approvedByUserId,
      },
    });
  }

  private separationRefusal(reason: PayrollSeparationReason) {
    return new ForbiddenException(
      domainError(
        403,
        'PAYROLL_SEPARATION_OF_DUTIES',
        PAYROLL_SEPARATION_MESSAGES[reason],
        { reason },
      ),
    );
  }

  /** Nobody approves or finalizes a run that pays themselves. */
  private async assertNotSelf(
    tx: Tx,
    run: LockedRun,
    context: PayrollRequestContext,
    verb: string,
  ) {
    const user = await tx.user.findUnique({
      where: { id: context.actorUserId! },
      select: { person: { select: { employee: { select: { id: true } } } } },
    });
    const employeeId = user?.person?.employee?.id;
    if (!employeeId) return;
    const included = await tx.payrollRunEmployee.count({
      where: { payrollRunId: run.id, employeeId },
    });
    if (included > 0) {
      throw new ForbiddenException(
        domainError(
          403,
          'PAYROLL_SELF_APPROVAL',
          `You cannot ${verb} a payroll run that includes your own pay.`,
        ),
      );
    }
  }

  private async lifecycleMetadata(
    tx: Tx,
    runId: string,
    from: string,
    to: string,
  ) {
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    return {
      previousStatus: from,
      status: to,
      currency: run.currency,
      sourceFingerprint: run.sourceFingerprint,
      calculationVersion: run.calculationVersion,
      grossAmount: run.grossAmount?.toFixed(2) ?? null,
      deductionAmount: run.deductionAmount?.toFixed(2) ?? null,
      employerContributionAmount:
        run.employerContributionAmount?.toFixed(2) ?? null,
      statutoryStatus: run.statutoryStatus,
    };
  }
}
