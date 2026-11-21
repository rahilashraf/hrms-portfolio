import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, formatDate } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  PayrollAdjustmentKind,
  PayrollAdjustmentStatus,
} from '../generated/prisma/client.js';
import { PayrollAccessService } from './payroll-access.service.js';
import {
  lockPayGroup,
  PayrollClock,
  writePayrollAudit,
  type PayrollClient,
  type PayrollRequestContext,
} from './payroll-common.js';
import {
  parsePayrollAmount,
  parsePayrollCurrency,
  requirePayrollText,
} from './payroll-domain.js';
import { money } from './payroll-engine.js';
import { PayrollRunService, type LockedRun } from './payroll-run.service.js';

type Tx = Prisma.TransactionClient;

const sumOf = (lines: ReadonlyArray<{ amount: Prisma.Decimal | string }>) =>
  lines
    .reduce((total, line) => total.add(line.amount), new Prisma.Decimal(0))
    .toFixed(2);
const Decimal = Prisma.Decimal;

export type ManualLineKind = 'EARNING' | 'DEDUCTION' | 'CONTRIBUTION';
const MANUAL_LINE_KINDS: readonly ManualLineKind[] = [
  'EARNING',
  'DEDUCTION',
  'CONTRIBUTION',
];
const LINE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export interface ManualLineInput {
  payrollRunAssignmentId: string;
  kind: ManualLineKind;
  amount: unknown;
  description: unknown;
  reason: unknown;
  code?: unknown;
}

/** Batch 7C (C2) — an explicit resolution of a benefit-only retro difference. */
export interface BenefitResolutionInput {
  employmentAssignmentId: string;
  outcome: unknown;
  reason: unknown;
  /** ADJUSTED: the manual DEDUCTION adjustment (created from this run) that corrects it. */
  adjustmentId?: string | null;
  /**
   * ADJUSTED, instead of `adjustmentId`: the DEDUCTION adjustment to create (amount and
   * description) in the same transaction as the resolution — one request, so a retry after a
   * failure never leaves an extra adjustment behind.
   */
  adjustment?: { amount: unknown; description?: unknown } | null;
}

export interface AdjustmentInput {
  payGroupId: string;
  employmentAssignmentId: string;
  currency: unknown;
  kind: PayrollAdjustmentKind;
  amount: unknown;
  description: unknown;
  reason: unknown;
  sourceRunId?: string | null;
}

/** One assignment's difference between a finalized run and what its sources say now. */
export interface RetroDifference {
  employmentAssignmentId: string;
  employeeId: string;
  displayName: string | null;
  blocked: boolean;
  blockingCodes: string[];
  finalizedGross: string;
  currentGross: string;
  alreadyAdjusted: string;
  difference: string;
  sourceFingerprint: string | null;
  /**
   * Security remediation M2: the compensation records the current evaluation used for this
   * assignment (recorded on a retro adjustment as its sources, for separation of duties).
   */
  compensationRecordIds: string[];
  /**
   * Benefit costs (Phase 11): finalized vs current. Shown only; a difference is corrected with
   * a manual payroll adjustment, never generated automatically.
   */
  benefits: {
    finalizedDeductions: string;
    currentDeductions: string;
    finalizedContributions: string;
    currentContributions: string;
  };
  /**
   * Batch 7C (C2): the benefit cost difference (current − finalized) — employee deductions and
   * employer contributions. Never adjusted or resolved automatically: until a person resolves it
   * explicitly (resolveBenefitDifference) the assignment keeps warning
   * BENEFIT_DIFFERENCE_UNRESOLVED here and PRIOR_PERIOD_SOURCE_CHANGED in later runs.
   */
  benefitDifference: {
    employeeDeductions: string;
    employerContributions: string;
    resolved: boolean;
  };
  warnings: string[];
  lines: Array<{
    type: string;
    date: string | null;
    finalizedAmount: string;
    currentAmount: string;
    difference: string;
    finalizedLineIds: string[];
  }>;
}

/**
 * Phase 10 Batch 8 — what payroll staff add to a run by hand, and corrections that carry into a
 * later run (payroll.adjust).
 *
 * Manual lines (earning, deduction, employer contribution) belong to one run assignment of an
 * unapproved run; they are never edited or deleted, only reversed by a negating line, and they
 * survive recalculation. Adjustments are pending corrections of a pay group and currency that
 * the next calculated run claims, carries as ADJUSTMENT lines and applies at finalization; a
 * retroactive adjustment is the difference between a finalized run and what its sources say
 * now — the finalized run itself is never rewritten. Nobody adjusts their own pay.
 */
@Injectable()
export class PayrollAdjustmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PayrollAccessService,
    private readonly audit: AuditService,
    private readonly clock: PayrollClock,
    private readonly runs: PayrollRunService,
  ) {}

  // ─── Manual lines ──────────────────────────────────────────────────────────

  async addManualLine(
    runId: string,
    input: ManualLineInput,
    context: PayrollRequestContext,
  ) {
    if (!MANUAL_LINE_KINDS.includes(input.kind)) {
      throw new BadRequestException(
        'kind must be EARNING, DEDUCTION or CONTRIBUTION.',
      );
    }
    const amount = parsePayrollAmount(input.amount);
    const description = requirePayrollText(
      input.description,
      'description',
      200,
    );
    const reason = requirePayrollText(input.reason, 'reason');
    const code =
      typeof input.code === 'string' && input.code.trim() !== ''
        ? input.code.trim().toUpperCase()
        : null;
    if (code !== null && !LINE_CODE.test(code)) {
      throw new BadRequestException(
        domainError(
          400,
          'PAYROLL_LINE_CODE_INVALID',
          'code must look like BONUS or UNIFORM_2026.',
        ),
      );
    }
    if (code !== null && input.kind === 'EARNING') {
      throw new BadRequestException('Earning lines take no code.');
    }
    const run = await this.runs.runOrThrow(runId);
    await this.access.assert(
      context.actorUserId,
      'payroll.adjust',
      run.organizationId,
    );
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await this.lockEditableRun(tx, run);
        const target = await tx.payrollRunAssignment.findFirst({
          where: { id: input.payrollRunAssignmentId, payrollRunId: locked.id },
        });
        if (!target)
          throw new NotFoundException('Payroll run assignment not found.');
        await this.assertNotOwnPay(tx, target.employeeId, context);
        const base = {
          payrollRunId: locked.id,
          payrollRunAssignmentId: target.id,
          description,
          amount,
          currency: locked.currency,
          reason,
          createdByUserId: context.actorUserId!,
        };
        const line =
          input.kind === 'EARNING'
            ? await tx.payrollEarningLine.create({
                data: {
                  ...base,
                  origin: 'MANUAL',
                  type: 'MANUAL_EARNING',
                  calculationRule: 'MANUAL',
                  calculationRuleVersion: 1,
                },
              })
            : input.kind === 'DEDUCTION'
              ? await tx.payrollDeductionLine.create({
                  data: { ...base, category: 'MANUAL', code },
                })
              : await tx.payrollEmployerContributionLine.create({
                  data: { ...base, category: 'MANUAL', code },
                });
        const totals = await this.refreshRun(tx, locked.id);
        await writePayrollAudit(this.audit, tx, {
          action: {
            EARNING: 'PAYROLL_MANUAL_EARNING_ADDED',
            DEDUCTION: 'PAYROLL_MANUAL_DEDUCTION_ADDED',
            CONTRIBUTION: 'PAYROLL_EMPLOYER_CONTRIBUTION_ADDED',
          }[input.kind],
          entityType: 'PayrollRun',
          entityId: locked.id,
          context,
          metadata: {
            lineId: line.id,
            kind: input.kind,
            payrollRunAssignmentId: target.id,
            employmentAssignmentId: target.employmentAssignmentId,
            amount,
            currency: locked.currency,
            code,
            reason,
            ...totals,
          },
        });
        return { id: line.id, kind: input.kind };
      },
      { timeout: 60_000 },
    );
  }

  /** Reverses a manual line with a negating line of the same run; the original stays. */
  async reverseManualLine(
    runId: string,
    input: { lineId: string; kind: ManualLineKind; reason: unknown },
    context: PayrollRequestContext,
  ) {
    if (!MANUAL_LINE_KINDS.includes(input.kind)) {
      throw new BadRequestException(
        'kind must be EARNING, DEDUCTION or CONTRIBUTION.',
      );
    }
    const reason = requirePayrollText(input.reason, 'reason');
    const run = await this.runs.runOrThrow(runId);
    await this.access.assert(
      context.actorUserId,
      'payroll.adjust',
      run.organizationId,
    );
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await this.lockEditableRun(tx, run);
        const where = { id: input.lineId, payrollRunId: locked.id };
        const original =
          input.kind === 'EARNING'
            ? await tx.payrollEarningLine.findFirst({
                where: { ...where, origin: 'MANUAL' },
                include: { reversedBy: true, runAssignment: true },
              })
            : input.kind === 'DEDUCTION'
              ? await tx.payrollDeductionLine.findFirst({
                  where: { ...where, category: 'MANUAL' },
                  include: { reversedBy: true, runAssignment: true },
                })
              : await tx.payrollEmployerContributionLine.findFirst({
                  where: { ...where, category: 'MANUAL' },
                  include: { reversedBy: true, runAssignment: true },
                });
        if (!original)
          throw new NotFoundException('Manual payroll line not found.');
        if (original.reversesLineId || original.reversedBy) {
          throw new ConflictException(
            domainError(
              409,
              'PAYROLL_LINE_ALREADY_REVERSED',
              original.reversesLineId
                ? 'A reversal line cannot itself be reversed.'
                : 'The line is already reversed.',
            ),
          );
        }
        await this.assertNotOwnPay(
          tx,
          original.runAssignment.employeeId,
          context,
        );
        const base = {
          payrollRunId: locked.id,
          payrollRunAssignmentId: original.payrollRunAssignmentId,
          description: `Reversal: ${original.description}`.slice(0, 200),
          amount: original.amount.negated(),
          currency: original.currency,
          reason,
          createdByUserId: context.actorUserId!,
          reversesLineId: original.id,
        };
        const code = 'code' in original ? original.code : null;
        const reversal =
          input.kind === 'EARNING'
            ? await tx.payrollEarningLine.create({
                data: {
                  ...base,
                  origin: 'MANUAL',
                  type: 'MANUAL_EARNING',
                  calculationRule: 'MANUAL',
                  calculationRuleVersion: 1,
                },
              })
            : input.kind === 'DEDUCTION'
              ? await tx.payrollDeductionLine.create({
                  data: { ...base, category: 'MANUAL', code },
                })
              : await tx.payrollEmployerContributionLine.create({
                  data: { ...base, category: 'MANUAL', code },
                });
        const totals = await this.refreshRun(tx, locked.id);
        await writePayrollAudit(this.audit, tx, {
          action: 'PAYROLL_MANUAL_LINE_REVERSED',
          entityType: 'PayrollRun',
          entityId: locked.id,
          context,
          metadata: {
            kind: input.kind,
            lineId: original.id,
            reversalLineId: reversal.id,
            amount: base.amount.toFixed(2),
            reason,
            ...totals,
          },
        });
        return { id: reversal.id, reversesLineId: original.id };
      },
      { timeout: 60_000 },
    );
  }

  // ─── Adjustments ───────────────────────────────────────────────────────────

  async createAdjustment(
    input: AdjustmentInput,
    context: PayrollRequestContext,
  ) {
    if (input.kind !== 'EARNING' && input.kind !== 'DEDUCTION') {
      throw new BadRequestException('kind must be EARNING or DEDUCTION.');
    }
    const amount = parsePayrollAmount(input.amount, { allowNegative: true });
    const currency = parsePayrollCurrency(input.currency);
    const description = requirePayrollText(
      input.description,
      'description',
      200,
    );
    const reason = requirePayrollText(input.reason, 'reason');
    const payGroup = await this.prisma.payGroup.findUnique({
      where: { id: input.payGroupId },
    });
    if (!payGroup) throw new NotFoundException('Pay group not found.');
    await this.access.assert(
      context.actorUserId,
      'payroll.adjust',
      payGroup.organizationId,
    );
    return this.prisma.$transaction(
      async (tx) => {
        await lockPayGroup(tx, payGroup.id);
        const assignment = await tx.employmentAssignment.findUnique({
          where: { id: input.employmentAssignmentId },
          select: {
            id: true,
            employeeId: true,
            position: { select: { organizationId: true } },
          },
        });
        if (
          !assignment ||
          assignment.position.organizationId !== payGroup.organizationId
        ) {
          throw new NotFoundException('Employment assignment not found.');
        }
        await this.assertNotOwnPay(tx, assignment.employeeId, context);
        if (input.sourceRunId) {
          const source = await tx.payrollRun.findUnique({
            where: { id: input.sourceRunId },
          });
          if (
            !source ||
            source.status !== 'FINALIZED' ||
            source.payGroupId !== payGroup.id ||
            source.currency !== currency
          ) {
            throw new ConflictException(
              domainError(
                409,
                'PAYROLL_ADJUSTMENT_SOURCE_INVALID',
                'An adjustment can only correct a finalized run of the same pay group and currency.',
              ),
            );
          }
        }
        const adjustment = await tx.payrollAdjustment.create({
          data: {
            organizationId: payGroup.organizationId,
            payGroupId: payGroup.id,
            employeeId: assignment.employeeId,
            employmentAssignmentId: assignment.id,
            currency,
            kind: input.kind,
            amount,
            description,
            reason,
            sourceRunId: input.sourceRunId ?? null,
            createdByUserId: context.actorUserId!,
          },
        });
        await writePayrollAudit(this.audit, tx, {
          action: 'PAYROLL_ADJUSTMENT_CREATED',
          entityType: 'PayrollAdjustment',
          entityId: adjustment.id,
          context,
          metadata: {
            payGroupId: payGroup.id,
            employmentAssignmentId: assignment.id,
            kind: input.kind,
            amount,
            currency,
            reason,
            sourceRunId: adjustment.sourceRunId,
            retroactive: false,
          },
        });
        return this.adjustmentShape(adjustment);
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Cancels a pending adjustment. One carried by a live run leaves it (its line is removed and
   * the run's totals refreshed); the run's fingerprint no longer matches, so it must be
   * recalculated before approval. One carried by an approved run cannot be cancelled until
   * that run is recalculated or voided.
   */
  async cancelAdjustment(
    adjustmentId: string,
    reasonInput: unknown,
    context: PayrollRequestContext,
  ) {
    const reason = requirePayrollText(reasonInput, 'reason');
    const adjustment = await this.prisma.payrollAdjustment.findUnique({
      where: { id: adjustmentId },
    });
    if (!adjustment)
      throw new NotFoundException('Payroll adjustment not found.');
    await this.access.assert(
      context.actorUserId,
      'payroll.adjust',
      adjustment.organizationId,
    );
    return this.prisma.$transaction(
      async (tx) => {
        await lockPayGroup(tx, adjustment.payGroupId);
        // The carrying run cannot change while the pay group is locked (calculation claims
        // adjustments under the same lock), so lock it, then the adjustment.
        const claimed = await tx.payrollAdjustment.findUniqueOrThrow({
          where: { id: adjustment.id },
          select: { payrollRunId: true },
        });
        const run = claimed.payrollRunId
          ? await this.runs.lockRun(tx, claimed.payrollRunId)
          : null;
        const rows = await tx.$queryRaw<
          Array<{
            status: PayrollAdjustmentStatus;
            payrollRunId: string | null;
          }>
        >(Prisma.sql`
          SELECT "status", "payrollRunId" FROM "PayrollAdjustment"
          WHERE "id" = ${adjustment.id}::uuid FOR UPDATE`);
        const current = rows[0]!;
        if (current.status !== 'PENDING') {
          throw new ConflictException(
            domainError(
              409,
              'PAYROLL_ADJUSTMENT_NOT_PENDING',
              `A ${current.status.toLowerCase()} adjustment cannot be cancelled.`,
            ),
          );
        }
        if (run && run.status === 'APPROVED') {
          throw new ConflictException(
            domainError(
              409,
              'PAYROLL_ADJUSTMENT_IN_APPROVED_RUN',
              'The adjustment is carried by an approved run; recalculate or void that run first.',
              { payrollRunId: run.id },
            ),
          );
        }
        if (run) {
          await tx.payrollEarningLine.deleteMany({
            where: { payrollRunId: run.id, payrollAdjustmentId: adjustment.id },
          });
          await tx.payrollDeductionLine.deleteMany({
            where: { payrollRunId: run.id, payrollAdjustmentId: adjustment.id },
          });
          await tx.payrollValidationIssue.deleteMany({
            where: {
              payrollRunId: run.id,
              code: 'ADJUSTMENT_INCLUDED',
              metadata: {
                path: ['payrollAdjustmentId'],
                equals: adjustment.id,
              },
            },
          });
        }
        const now = this.clock.now();
        await tx.payrollAdjustment.update({
          where: { id: adjustment.id },
          data: {
            status: 'CANCELLED',
            payrollRunId: null,
            // M2: the live run whose pay this cancellation changed (separation of duties).
            cancelledFromRunId: run?.id ?? null,
            cancelledAt: now,
            cancelledByUserId: context.actorUserId,
            cancelReason: reason,
          },
        });
        const totals = run ? await this.refreshRun(tx, run.id) : null;
        await writePayrollAudit(this.audit, tx, {
          action: 'PAYROLL_ADJUSTMENT_CANCELLED',
          entityType: 'PayrollAdjustment',
          entityId: adjustment.id,
          context,
          metadata: {
            reason,
            amount: adjustment.amount.toFixed(2),
            kind: adjustment.kind,
            removedFromRunId: run?.id ?? null,
            ...totals,
          },
        });
        return { id: adjustment.id, status: 'CANCELLED' as const };
      },
      { timeout: 60_000 },
    );
  }

  async listAdjustments(
    userId: string,
    query: {
      organizationId: string;
      payGroupId?: string;
      status?: PayrollAdjustmentStatus;
      sourceRunId?: string;
      payrollRunId?: string;
    },
  ) {
    await this.access.assert(userId, 'payroll.read', query.organizationId);
    const rows = await this.prisma.payrollAdjustment.findMany({
      where: {
        organizationId: query.organizationId,
        ...(query.payGroupId ? { payGroupId: query.payGroupId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.sourceRunId ? { sourceRunId: query.sourceRunId } : {}),
        ...(query.payrollRunId ? { payrollRunId: query.payrollRunId } : {}),
      },
      include: {
        employmentAssignment: {
          select: {
            position: { select: { name: true } },
            employee: {
              select: {
                employeeNumber: true,
                person: {
                  select: {
                    firstName: true,
                    lastName: true,
                    preferredName: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 500,
    });
    return {
      items: rows.map((row) => {
        const person = row.employmentAssignment.employee.person;
        return {
          ...this.adjustmentShape(row),
          employeeNumber: row.employmentAssignment.employee.employeeNumber,
          displayName: [
            person.preferredName ?? person.firstName,
            person.lastName,
          ]
            .filter(Boolean)
            .join(' '),
          positionName: row.employmentAssignment.position.name,
        };
      }),
    };
  }

  // ─── Retroactive corrections ───────────────────────────────────────────────

  /**
   * What a finalized run would pay if calculated from today's sources, per assignment and
   * line, less the retroactive adjustments already made from it. Read-only: the finalized run
   * and its stored lines never change.
   */
  async retroPreview(runId: string, userId: string) {
    const run = await this.runs.runOrThrow(runId);
    await this.access.assert(userId, 'payroll.read', run.organizationId);
    this.assertFinalized(run);
    return {
      payrollRunId: run.id,
      // The preview never lists compensation record ids (internal provenance only).
      items: (await this.retroDifferences(this.prisma, run)).map(
        ({ compensationRecordIds: _sources, ...item }) => item,
      ),
    };
  }

  /**
   * Creates one pending EARNING adjustment per assignment whose difference is not zero.
   * Idempotent: differences already answered by earlier retro adjustments are subtracted, and
   * a per-run advisory lock serializes concurrent requests. Blocked assignments (incomplete
   * current sources) are reported, never guessed.
   */
  async createRetroAdjustments(
    runId: string,
    reasonInput: unknown,
    context: PayrollRequestContext,
  ) {
    const reason = requirePayrollText(reasonInput, 'reason');
    const run = await this.runs.runOrThrow(runId);
    await this.access.assert(
      context.actorUserId,
      'payroll.adjust',
      run.organizationId,
    );
    this.assertFinalized(run);
    return this.prisma.$transaction(
      async (tx) => {
        await lockPayGroup(tx, run.payGroupId);
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${`payroll-retro:${run.id}`}, 0))`);
        const differences = await this.retroDifferences(tx, run);
        const ownEmployeeId = await this.employeeIdOf(tx, context.actorUserId);
        const created: string[] = [];
        const blocked: string[] = [];
        const skippedOwnPay: string[] = [];
        const resolved: string[] = [];
        // Batch 7C (C2): assignments whose benefit costs differ — a person resolves those.
        const benefitDifferences: string[] = [];
        // What each assignment's sources were when the run was finalized: a resolution is only
        // recorded where they changed since (anything else needs none).
        const finalizedFingerprints = new Map(
          (
            await tx.payrollRunAssignment.findMany({
              where: { payrollRunId: run.id },
              select: { employmentAssignmentId: true, sourceFingerprint: true },
            })
          ).map((row) => [row.employmentAssignmentId, row.sourceFingerprint]),
        );
        const changedSinceFinalized = (item: RetroDifference) =>
          item.sourceFingerprint !== null &&
          item.sourceFingerprint !==
            finalizedFingerprints.get(item.employmentAssignmentId);
        for (const item of differences) {
          if (item.blocked) {
            blocked.push(item.employmentAssignmentId);
            continue;
          }
          const benefitPending = item.warnings.includes(
            'BENEFIT_DIFFERENCE_UNRESOLVED',
          );
          if (benefitPending)
            benefitDifferences.push(item.employmentAssignmentId);
          if (new Decimal(item.difference).isZero()) {
            // Batch 7C (C2): a benefit-only difference is never "no adjustment required".
            if (benefitPending) continue;
            // Batch 4A: nothing to pay. Record it against the current sources and the retro
            // adjustments counted, so the PRIOR_PERIOD_SOURCE_CHANGED warning is answered until
            // either changes. Never for one's own pay (no self-attestation).
            if (
              changedSinceFinalized(item) &&
              item.employeeId !== ownEmployeeId &&
              (await this.recordResolution(
                tx,
                run,
                item,
                item.alreadyAdjusted,
                'NO_ADJUSTMENT_REQUIRED',
                reason,
                context,
              ))
            ) {
              resolved.push(item.employmentAssignmentId);
            }
            continue;
          }
          if (item.employeeId === ownEmployeeId) {
            skippedOwnPay.push(item.employmentAssignmentId);
            continue;
          }
          const changed = item.lines.filter(
            (line) => !new Decimal(line.difference).isZero(),
          );
          const sourceLine =
            changed.length === 1 && changed[0]!.finalizedLineIds.length === 1
              ? changed[0]!.finalizedLineIds[0]!
              : null;
          const adjustment = await tx.payrollAdjustment.create({
            data: {
              organizationId: run.organizationId,
              payGroupId: run.payGroupId,
              employeeId: item.employeeId,
              employmentAssignmentId: item.employmentAssignmentId,
              currency: run.currency,
              kind: 'EARNING',
              amount: item.difference,
              description: await this.retroDescription(tx, run),
              reason,
              sourceRunId: run.id,
              sourceEarningLineId: sourceLine,
              // Batch 7C (C2): an earning correction never answers a pending benefit difference
              // (an adjustment's fingerprint alone answers the warning when unresolved).
              sourceFingerprint: benefitPending ? null : item.sourceFingerprint,
              createdByUserId: context.actorUserId!,
            },
          });
          created.push(adjustment.id);
          // M2: the compensation records behind the difference (separation of duties).
          if (item.compensationRecordIds.length > 0) {
            await tx.payrollAdjustmentCompensationSource.createMany({
              data: item.compensationRecordIds.map((compensationRecordId) => ({
                adjustmentId: adjustment.id,
                compensationRecordId,
              })),
            });
          }
          // Batch 4A: settled at these sources with this adjustment counted.
          if (changedSinceFinalized(item) && !benefitPending) {
            await this.recordResolution(
              tx,
              run,
              item,
              money(
                new Decimal(item.alreadyAdjusted).add(item.difference),
              ).toFixed(2),
              'ADJUSTED',
              reason,
              context,
            );
          }
          await writePayrollAudit(this.audit, tx, {
            action: 'PAYROLL_ADJUSTMENT_CREATED',
            entityType: 'PayrollAdjustment',
            entityId: adjustment.id,
            context,
            metadata: {
              payGroupId: run.payGroupId,
              employmentAssignmentId: item.employmentAssignmentId,
              kind: 'EARNING',
              amount: item.difference,
              currency: run.currency,
              reason,
              sourceRunId: run.id,
              sourceEarningLineId: sourceLine,
              sourceFingerprint: item.sourceFingerprint,
              retroactive: true,
              finalizedGross: item.finalizedGross,
              currentGross: item.currentGross,
            },
          });
        }
        return {
          payrollRunId: run.id,
          created,
          blocked,
          skippedOwnPay,
          resolved,
          benefitDifferences,
        };
      },
      { timeout: 120_000 },
    );
  }

  /**
   * Batch 7C (C2) — a person resolves one assignment's benefit-only difference (payroll.adjust,
   * never for their own pay): ADJUSTED, naming the manual DEDUCTION adjustment created from this
   * run that corrects the employee's share, or NO_ADJUSTMENT_REQUIRED (decided, with a reason —
   * e.g. an employer-only difference settled with the carrier). Recorded as a retro resolution
   * at the current sources and earning adjustments, so the warnings return if either changes.
   * Gross differences go through the retro tool first. Finalized payroll never changes.
   */
  async resolveBenefitDifference(
    runId: string,
    input: BenefitResolutionInput,
    context: PayrollRequestContext,
  ) {
    const reason = requirePayrollText(input.reason, 'reason');
    if (
      input.outcome !== 'ADJUSTED' &&
      input.outcome !== 'NO_ADJUSTMENT_REQUIRED'
    ) {
      throw new BadRequestException(
        'outcome must be ADJUSTED or NO_ADJUSTMENT_REQUIRED.',
      );
    }
    const outcome = input.outcome;
    if (
      outcome === 'ADJUSTED' &&
      Boolean(input.adjustmentId) === Boolean(input.adjustment)
    ) {
      throw new BadRequestException(
        'Give either adjustmentId or the adjustment to create when the difference was adjusted.',
      );
    }
    if (
      outcome === 'NO_ADJUSTMENT_REQUIRED' &&
      (input.adjustmentId || input.adjustment)
    ) {
      throw new BadRequestException(
        'No adjustment is named or created when none is required.',
      );
    }
    const toCreate =
      outcome === 'ADJUSTED' && input.adjustment
        ? {
            amount: parsePayrollAmount(input.adjustment.amount, {
              allowNegative: true,
            }),
            description: requirePayrollText(
              input.adjustment.description ?? 'Benefit deduction correction',
              'description',
              200,
            ),
          }
        : null;
    const run = await this.runs.runOrThrow(runId);
    await this.access.assert(
      context.actorUserId,
      'payroll.adjust',
      run.organizationId,
    );
    this.assertFinalized(run);
    return this.prisma.$transaction(
      async (tx) => {
        await lockPayGroup(tx, run.payGroupId);
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${`payroll-retro:${run.id}`}, 0))`);
        const item = (await this.retroDifferences(tx, run)).find(
          (row) => row.employmentAssignmentId === input.employmentAssignmentId,
        );
        if (!item) {
          throw new NotFoundException('Employment assignment not found.');
        }
        await this.assertNotOwnPay(tx, item.employeeId, context);
        const refuse = (code: string, message: string) =>
          new ConflictException(domainError(409, code, message));
        if (item.blocked || !item.sourceFingerprint) {
          throw refuse(
            'PAYROLL_RETRO_BLOCKED',
            'The current sources are incomplete; resolve the blocking issues first.',
          );
        }
        if (!new Decimal(item.difference).isZero()) {
          throw refuse(
            'PAYROLL_RETRO_GROSS_PENDING',
            'Create the retroactive pay adjustments first; then resolve the benefit difference.',
          );
        }
        if (
          new Decimal(item.benefitDifference.employeeDeductions).isZero() &&
          new Decimal(item.benefitDifference.employerContributions).isZero()
        ) {
          throw refuse(
            'PAYROLL_BENEFIT_DIFFERENCE_NONE',
            'The benefit costs of this assignment did not change.',
          );
        }
        if (item.benefitDifference.resolved) {
          return { resolved: true, alreadyResolved: true };
        }
        let adjustmentId = input.adjustmentId ?? null;
        if (toCreate) {
          const created = await tx.payrollAdjustment.create({
            data: {
              organizationId: run.organizationId,
              payGroupId: run.payGroupId,
              employeeId: item.employeeId,
              employmentAssignmentId: item.employmentAssignmentId,
              currency: run.currency,
              kind: 'DEDUCTION',
              amount: toCreate.amount,
              description: toCreate.description,
              reason,
              sourceRunId: run.id,
              createdByUserId: context.actorUserId!,
            },
          });
          adjustmentId = created.id;
          await writePayrollAudit(this.audit, tx, {
            action: 'PAYROLL_ADJUSTMENT_CREATED',
            entityType: 'PayrollAdjustment',
            entityId: created.id,
            context,
            metadata: {
              payGroupId: run.payGroupId,
              employmentAssignmentId: item.employmentAssignmentId,
              kind: 'DEDUCTION',
              amount: toCreate.amount,
              currency: run.currency,
              reason,
              sourceRunId: run.id,
              retroactive: true,
              benefit: true,
            },
          });
        } else if (outcome === 'ADJUSTED') {
          const adjustment = await tx.payrollAdjustment.findUnique({
            where: { id: adjustmentId! },
          });
          if (
            !adjustment ||
            adjustment.sourceRunId !== run.id ||
            adjustment.employmentAssignmentId !== item.employmentAssignmentId ||
            adjustment.kind !== 'DEDUCTION' ||
            adjustment.status === 'CANCELLED'
          ) {
            throw refuse(
              'PAYROLL_ADJUSTMENT_SOURCE_INVALID',
              'Name a deduction adjustment of this assignment created from this run.',
            );
          }
        }
        await this.recordResolution(
          tx,
          run,
          item,
          item.alreadyAdjusted,
          outcome,
          reason,
          context,
          {
            benefit: true,
            adjustmentId,
            employeeDeductionDifference:
              item.benefitDifference.employeeDeductions,
            employerContributionDifference:
              item.benefitDifference.employerContributions,
          },
        );
        return { resolved: true, alreadyResolved: false, adjustmentId };
      },
      { timeout: 120_000 },
    );
  }

  /**
   * Batch 4A — an append-only, audited resolution settling one assignment of a finalized run at
   * its current source fingerprint and the run's adjustments then counted (`adjustedAmount`):
   * NO_ADJUSTMENT_REQUIRED, or ADJUSTED with the adjustment just created. A repeat of the same
   * calculation adds nothing (unique key). Returns whether a row was written.
   */
  private async recordResolution(
    tx: Prisma.TransactionClient,
    run: LockedRun,
    item: RetroDifference,
    adjustedAmount: string,
    outcome: 'NO_ADJUSTMENT_REQUIRED' | 'ADJUSTED',
    reason: string,
    context: PayrollRequestContext,
    extra: Record<string, unknown> = {},
  ) {
    const written = await tx.payrollRetroResolution.createMany({
      data: [
        {
          payrollRunId: run.id,
          employeeId: item.employeeId,
          employmentAssignmentId: item.employmentAssignmentId,
          sourceFingerprint: item.sourceFingerprint!,
          adjustedAmount,
          outcome,
          reason,
          resolvedByUserId: context.actorUserId!,
        },
      ],
      skipDuplicates: true,
    });
    if (written.count === 0) return false;
    await writePayrollAudit(this.audit, tx, {
      action: 'PAYROLL_RETRO_RESOLVED',
      entityType: 'PayrollRun',
      entityId: run.id,
      context,
      metadata: {
        payGroupId: run.payGroupId,
        employmentAssignmentId: item.employmentAssignmentId,
        outcome,
        sourceFingerprint: item.sourceFingerprint,
        adjustedAmount,
        finalizedGross: item.finalizedGross,
        currentGross: item.currentGross,
        currency: run.currency,
        reason,
        ...extra,
      },
    });
    return true;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async retroDifferences(
    client: PayrollClient,
    run: LockedRun,
  ): Promise<RetroDifference[]> {
    const { result } = await this.runs.evaluate(client, run);
    const stored = await client.payrollRunAssignment.findMany({
      where: { payrollRunId: run.id },
      include: {
        runEmployee: { select: { displayName: true } },
        earningLines: { where: { origin: 'CALCULATED' } },
        deductionLines: { where: { category: 'BENEFIT' } },
        contributionLines: { where: { category: 'BENEFIT' } },
        validationIssues: { where: { code: 'PAY_GROUP_CHANGE_IN_PERIOD' } },
      },
    });
    const prior = await client.payrollAdjustment.groupBy({
      by: ['employmentAssignmentId'],
      where: {
        sourceRunId: run.id,
        kind: 'EARNING',
        status: { not: 'CANCELLED' },
      },
      _sum: { amount: true },
    });
    const adjusted = new Map(
      prior.map((row) => [
        row.employmentAssignmentId,
        row._sum.amount ?? new Decimal(0),
      ]),
    );
    // Batch 7C (C2): a resolution answers while it holds (the same sources and earning
    // adjustments), exactly as the PRIOR_PERIOD_SOURCE_CHANGED warning reads it.
    const resolutions = await client.payrollRetroResolution.findMany({
      where: { payrollRunId: run.id },
      select: {
        employmentAssignmentId: true,
        sourceFingerprint: true,
        adjustedAmount: true,
      },
    });
    const ids = new Set([
      ...stored.map((row) => row.employmentAssignmentId),
      ...result.assignments
        .filter((a) => a.inRun)
        .map((a) => a.employmentAssignmentId),
    ]);
    const items: RetroDifference[] = [];
    for (const id of [...ids].sort()) {
      const row = stored.find((item) => item.employmentAssignmentId === id);
      const current = result.assignments.find(
        (item) => item.employmentAssignmentId === id && item.inRun,
      );
      const blockingCodes = (current?.issues ?? [])
        .filter((issue) => issue.severity === 'ERROR')
        .map((issue) => issue.code);
      // Dates moving to (or from) another pay group after finalization are not a pay
      // difference of this run: the owning pay group's run pays them, and an automatic
      // negative correction here would move pay silently. A person resolves it.
      const ownership = (metadata: unknown) => {
        const value = (metadata ?? {}) as Record<string, unknown>;
        return JSON.stringify([value.count, value.first, value.last]);
      };
      const finalizedOwnership = ownership(
        row?.validationIssues[0]?.metadata ?? null,
      );
      const currentOwnership = ownership(
        current?.issues.find(
          (issue) => issue.code === 'PAY_GROUP_CHANGE_IN_PERIOD',
        )?.metadata ?? null,
      );
      if (row && current && finalizedOwnership !== currentOwnership) {
        blockingCodes.push('PAY_GROUP_OWNERSHIP_CHANGED');
      }
      const byKey = new Map<
        string,
        {
          type: string;
          date: string | null;
          finalized: Prisma.Decimal;
          current: Prisma.Decimal;
          ids: string[];
        }
      >();
      const entry = (type: string, date: string | null) => {
        const key = `${type}|${date ?? ''}`;
        let value = byKey.get(key);
        if (!value) {
          value = {
            type,
            date,
            finalized: new Decimal(0),
            current: new Decimal(0),
            ids: [],
          };
          byKey.set(key, value);
        }
        return value;
      };
      for (const line of row?.earningLines ?? []) {
        const date = line.workDate ?? line.periodFrom;
        const value = entry(line.type, date ? formatDate(date) : null);
        value.finalized = value.finalized.add(line.amount);
        value.ids.push(line.id);
      }
      for (const line of current?.lines ?? []) {
        const value = entry(line.type, line.workDate ?? line.periodFrom);
        value.current = value.current.add(line.amount);
      }
      const finalizedGross = [...byKey.values()].reduce(
        (sum, value) => sum.add(value.finalized),
        new Decimal(0),
      );
      const currentGross = new Decimal(current?.grossAmount ?? 0);
      const already = adjusted.get(id) ?? new Decimal(0);
      const blocked = blockingCodes.length > 0;
      const deductionsFinalized = sumOf(row?.deductionLines ?? []);
      const deductionsCurrent = sumOf(
        (current?.benefitLines ?? []).filter(
          (line) => line.kind === 'DEDUCTION',
        ),
      );
      const contributionsFinalized = sumOf(row?.contributionLines ?? []);
      const contributionsCurrent = sumOf(
        (current?.benefitLines ?? []).filter(
          (line) => line.kind === 'CONTRIBUTION',
        ),
      );
      const deductionDifference = new Decimal(deductionsCurrent).sub(
        deductionsFinalized,
      );
      const contributionDifference = new Decimal(contributionsCurrent).sub(
        contributionsFinalized,
      );
      const fingerprint = current?.fingerprint ?? null;
      const benefitResolved = resolutions.some(
        (resolution) =>
          resolution.employmentAssignmentId === id &&
          resolution.sourceFingerprint === fingerprint &&
          resolution.adjustedAmount.equals(already),
      );
      const benefitChanged =
        !blocked &&
        (!deductionDifference.isZero() || !contributionDifference.isZero());
      items.push({
        compensationRecordIds: [
          ...new Set(
            (current?.compensation ?? []).map(
              (fact) => fact.compensationRecordId,
            ),
          ),
        ].sort(),
        employmentAssignmentId: id,
        employeeId: row?.employeeId ?? current!.employeeId,
        displayName: row?.runEmployee.displayName ?? null,
        blocked,
        blockingCodes,
        finalizedGross: money(finalizedGross).toFixed(2),
        currentGross: money(currentGross).toFixed(2),
        alreadyAdjusted: money(already).toFixed(2),
        difference: blocked
          ? '0.00'
          : money(currentGross.sub(finalizedGross).sub(already)).toFixed(2),
        sourceFingerprint: fingerprint,
        benefits: {
          finalizedDeductions: deductionsFinalized,
          currentDeductions: deductionsCurrent,
          finalizedContributions: contributionsFinalized,
          currentContributions: contributionsCurrent,
        },
        benefitDifference: {
          employeeDeductions: money(deductionDifference).toFixed(2),
          employerContributions: money(contributionDifference).toFixed(2),
          resolved: benefitChanged && benefitResolved,
        },
        warnings:
          benefitChanged && !benefitResolved
            ? ['BENEFIT_DIFFERENCE_UNRESOLVED']
            : [],
        lines: [...byKey.values()]
          .filter((value) => !value.current.equals(value.finalized))
          .sort((a, b) =>
            a.type === b.type
              ? (a.date ?? '').localeCompare(b.date ?? '')
              : a.type.localeCompare(b.type),
          )
          .map((value) => ({
            type: value.type,
            date: value.date,
            finalizedAmount: money(value.finalized).toFixed(2),
            currentAmount: money(value.current).toFixed(2),
            difference: money(value.current.sub(value.finalized)).toFixed(2),
            finalizedLineIds: value.ids,
          })),
      });
    }
    return items;
  }

  private async retroDescription(tx: Tx, run: LockedRun) {
    const period = await tx.payrollPeriod.findUniqueOrThrow({
      where: { id: run.payrollPeriodId },
    });
    return `Retroactive correction for ${formatDate(period.periodStart)} to ${formatDate(period.periodEnd)}`;
  }

  private assertFinalized(run: LockedRun) {
    if (run.status !== 'FINALIZED') {
      throw new ConflictException(
        domainError(
          409,
          'PAYROLL_RUN_NOT_FINALIZED',
          'Retroactive adjustments correct finalized runs only; recalculate a live run instead.',
        ),
      );
    }
  }

  /** Locks the pay group then the run; manual lines change only DRAFT or CALCULATED runs. */
  private async lockEditableRun(tx: Tx, run: LockedRun) {
    await lockPayGroup(tx, run.payGroupId);
    const locked = await this.runs.lockRun(tx, run.id);
    if (locked.status !== 'DRAFT' && locked.status !== 'CALCULATED') {
      throw this.runs.statusConflict(locked.status, 'changed by hand');
    }
    return locked;
  }

  /** Totals, pay checks and manual-line warnings after a line changed. */
  private async refreshRun(tx: Tx, runId: string) {
    const totals = await this.runs.applyTotals(tx, runId);
    await tx.payrollRun.update({ where: { id: runId }, data: totals });
    await this.runs.refreshPayChecks(tx, runId);
    await this.runs.refreshManualWarnings(tx, runId);
    return {
      grossAmount: totals.grossAmount.toFixed(2),
      deductionAmount: totals.deductionAmount.toFixed(2),
      employerContributionAmount: totals.employerContributionAmount.toFixed(2),
    };
  }

  private async employeeIdOf(tx: Tx, userId: string | null | undefined) {
    if (!userId) return null;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { person: { select: { employee: { select: { id: true } } } } },
    });
    return user?.person?.employee?.id ?? null;
  }

  private async assertNotOwnPay(
    tx: Tx,
    employeeId: string,
    context: PayrollRequestContext,
  ) {
    if ((await this.employeeIdOf(tx, context.actorUserId)) === employeeId) {
      throw new ForbiddenException(
        domainError(
          403,
          'PAYROLL_SELF_ADJUSTMENT',
          'You cannot change your own pay.',
        ),
      );
    }
  }

  private adjustmentShape(row: {
    id: string;
    organizationId: string;
    payGroupId: string;
    employeeId: string;
    employmentAssignmentId: string;
    currency: string;
    kind: PayrollAdjustmentKind;
    amount: Prisma.Decimal;
    description: string;
    reason: string;
    status: PayrollAdjustmentStatus;
    sourceRunId: string | null;
    sourceEarningLineId: string | null;
    payrollRunId: string | null;
    appliedAt: Date | null;
    cancelledAt: Date | null;
    cancelReason: string | null;
    createdByUserId: string;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      payGroupId: row.payGroupId,
      employeeId: row.employeeId,
      employmentAssignmentId: row.employmentAssignmentId,
      currency: row.currency,
      kind: row.kind,
      amount: row.amount.toFixed(2),
      description: row.description,
      reason: row.reason,
      status: row.status,
      sourceRunId: row.sourceRunId,
      sourceEarningLineId: row.sourceEarningLineId,
      payrollRunId: row.payrollRunId,
      appliedAt: row.appliedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt.toISOString(),
      retroactive: row.sourceRunId !== null,
    };
  }
}
