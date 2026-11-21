import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  formatDate,
  jsonValue,
  parseDateOnly,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PayrollRunStatus } from '../generated/prisma/client.js';
import { PayrollAccessService } from './payroll-access.service.js';
import {
  lockPayGroup,
  PayrollClock,
  writePayrollAudit,
  type PayrollRequestContext,
} from './payroll-common.js';
import { parsePayrollCurrency } from './payroll-domain.js';
import {
  calculate,
  money,
  PAYROLL_CALCULATION_VERSION,
  runFingerprint,
  type AssignmentResult,
  type EngineInput,
  type EngineIssue,
} from './payroll-engine.js';
import { PayrollSourceService } from './payroll-source.service.js';

type Tx = Prisma.TransactionClient;
const Decimal = Prisma.Decimal;

export interface LockedRun {
  id: string;
  organizationId: string;
  payGroupId: string;
  payrollPeriodId: string;
  currency: string;
  status: PayrollRunStatus;
  sourceFingerprint: string | null;
  approvedAt: Date | null;
}

/** A run-level issue added to every calculation: gross pay is complete, legal net pay is not. */
export const NET_PAY_NOT_CALCULATED: EngineIssue = {
  severity: 'INFO',
  code: 'NET_PAY_NOT_CALCULATED',
  message:
    'Statutory deductions (income tax, CPP/CPP2, EI) are not calculated: this run is gross pay only, not legally complete net pay.',
};

/**
 * Phase 10 Batches 4–7 — payroll runs: creation, calculation and recalculation, source
 * snapshots and freshness.
 *
 * Calculation locks the run row (FOR UPDATE) after the pay group (see payroll-common lock
 * order), collects the period's source facts through the domain contracts, runs the pure gross
 * engine, and in one transaction replaces the run's calculated results: CALCULATED and
 * ADJUSTMENT lines, snapshots and issues are deleted and written again; MANUAL lines are never
 * touched. The run's source fingerprint and every assignment's are stored, so approval and
 * finalization can prove the sources did not change since. Recalculating an approved run drops
 * its approval. A finalized or voided run is never recalculated (the database refuses it too).
 */
@Injectable()
export class PayrollRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PayrollAccessService,
    private readonly audit: AuditService,
    private readonly clock: PayrollClock,
    private readonly sources: PayrollSourceService,
  ) {}

  // ─── Creation ──────────────────────────────────────────────────────────────

  async createRun(
    input: { payrollPeriodId: string; currency: string },
    context: PayrollRequestContext,
  ) {
    const currency = parsePayrollCurrency(input.currency);
    return this.prisma.$transaction(async (tx) => {
      const period = await tx.payrollPeriod.findUnique({
        where: { id: input.payrollPeriodId },
      });
      if (!period) throw new NotFoundException('Payroll period not found.');
      await lockPayGroup(tx, period.payGroupId);
      await this.access.assert(
        context.actorUserId,
        'payroll.manage',
        period.organizationId,
        tx,
      );
      const current = await tx.payrollPeriod.findUniqueOrThrow({
        where: { id: period.id },
      });
      if (current.status !== 'OPEN' && current.status !== 'PROCESSING') {
        throw new ConflictException(
          domainError(
            409,
            'PAYROLL_PERIOD_NOT_OPEN',
            current.status === 'FINALIZED'
              ? 'The pay period is finalized; later changes become adjustments in a later period.'
              : 'The pay period has not started yet.',
          ),
        );
      }
      const live = await tx.payrollRun.findFirst({
        where: {
          payrollPeriodId: period.id,
          currency,
          status: { not: 'VOIDED' },
        },
      });
      if (live) {
        throw new ConflictException(
          domainError(
            409,
            'PAYROLL_RUN_EXISTS',
            `The period already has a ${currency} payroll run (${live.status.toLowerCase()}).`,
            { payrollRunId: live.id },
          ),
        );
      }
      const run = await tx.payrollRun.create({
        data: {
          organizationId: period.organizationId,
          payGroupId: period.payGroupId,
          payrollPeriodId: period.id,
          currency,
          createdByUserId: context.actorUserId!,
        },
      });
      if (current.status === 'OPEN') {
        await tx.payrollPeriod.update({
          where: { id: period.id },
          data: { status: 'PROCESSING' },
        });
      }
      await writePayrollAudit(this.audit, tx, {
        action: 'PAYROLL_RUN_CREATED',
        entityType: 'PayrollRun',
        entityId: run.id,
        context,
        metadata: {
          payrollPeriodId: period.id,
          payGroupId: period.payGroupId,
          currency,
          periodStart: formatDate(period.periodStart),
          periodEnd: formatDate(period.periodEnd),
        },
      });
      return run;
    });
  }

  // ─── Calculation ───────────────────────────────────────────────────────────

  async calculate(runId: string, context: PayrollRequestContext) {
    const run = await this.runOrThrow(runId);
    await this.access.assert(
      context.actorUserId,
      'payroll.calculate',
      run.organizationId,
    );
    return this.prisma.$transaction(
      async (tx) => {
        await lockPayGroup(tx, run.payGroupId);
        const locked = await this.lockRun(tx, runId);
        if (!['DRAFT', 'CALCULATED', 'APPROVED'].includes(locked.status)) {
          throw this.statusConflict(locked.status, 'calculated');
        }
        const recalculation = locked.status !== 'DRAFT';
        await this.claimAdjustments(tx, locked);
        const { input, result, extras } = await this.evaluate(tx, locked);
        await this.persist(tx, locked, input, result, extras);
        const totals = await this.applyTotals(tx, locked.id);
        await this.refreshPayChecks(tx, locked.id);
        await this.priorPeriodChanges(tx, locked, result);
        const issues = await tx.payrollValidationIssue.groupBy({
          by: ['severity'],
          where: { payrollRunId: locked.id },
          _count: { _all: true },
        });
        const now = this.clock.now();
        await tx.payrollRun.update({
          where: { id: locked.id },
          data: {
            status: 'CALCULATED',
            calculatedAt: now,
            // M2: who last calculated the run (never inferred from its creator or approver).
            calculatedByUserId: context.actorUserId ?? null,
            calculationVersion: PAYROLL_CALCULATION_VERSION,
            sourceFingerprint: extras.fingerprint,
            approvedAt: null,
            approvedByUserId: null,
            ...totals,
            salaryUnpaidLeaveRule: input.salaryUnpaidLeaveRule,
            salaryStandardAnnualHours: input.salaryStandardAnnualHours,
          },
        });
        await writePayrollAudit(this.audit, tx, {
          action: recalculation
            ? 'PAYROLL_RUN_RECALCULATED'
            : 'PAYROLL_RUN_CALCULATED',
          entityType: 'PayrollRun',
          entityId: locked.id,
          context,
          metadata: {
            previousStatus: locked.status,
            status: 'CALCULATED',
            calculatedByUserId: context.actorUserId ?? null,
            previousSourceFingerprint: locked.sourceFingerprint,
            sourceFingerprint: extras.fingerprint,
            calculationVersion: PAYROLL_CALCULATION_VERSION,
            approvalCleared: locked.status === 'APPROVED',
            assignments: result.assignments.filter((a) => a.inRun).length,
            issues: Object.fromEntries(
              issues.map((row) => [row.severity, row._count._all]),
            ),
            grossAmount: totals.grossAmount.toFixed(2),
            deductionAmount: totals.deductionAmount.toFixed(2),
            employerContributionAmount:
              totals.employerContributionAmount.toFixed(2),
          },
        });
        return { id: locked.id };
      },
      { timeout: 120_000 },
    );
  }

  /**
   * Whether the sources changed since the run was calculated: the current fingerprint against
   * the stored one, per assignment too. Read-only.
   */
  async freshness(runId: string, userId: string) {
    const run = await this.runOrThrow(runId);
    await this.access.assert(userId, 'payroll.read', run.organizationId);
    return this.freshnessOf(this.prisma, run);
  }

  async freshnessOf(client: PrismaService | Tx, run: LockedRun) {
    if (!run.sourceFingerprint) {
      return {
        stale: false,
        calculated: false,
        changedAssignmentIds: [] as string[],
        currentAssignmentFingerprints: {} as Record<string, string>,
      };
    }
    const { result, extras } = await this.evaluate(client, run);
    const stored = await client.payrollRunAssignment.findMany({
      where: { payrollRunId: run.id },
      select: { employmentAssignmentId: true, sourceFingerprint: true },
    });
    const current = new Map(
      result.assignments
        .filter((assignment) => assignment.inRun)
        .map((assignment) => [
          assignment.employmentAssignmentId,
          assignment.fingerprint,
        ]),
    );
    const changed = new Set<string>();
    for (const row of stored) {
      if (current.get(row.employmentAssignmentId) !== row.sourceFingerprint) {
        changed.add(row.employmentAssignmentId);
      }
    }
    for (const id of current.keys()) {
      if (!stored.some((row) => row.employmentAssignmentId === id))
        changed.add(id);
    }
    return {
      stale: extras.fingerprint !== run.sourceFingerprint,
      calculated: true,
      storedFingerprint: run.sourceFingerprint,
      currentFingerprint: extras.fingerprint,
      changedAssignmentIds: [...changed].sort(),
      currentAssignmentFingerprints: Object.fromEntries(current),
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Collects sources and runs the engine for a run. `extras` carries what else the run
   * fingerprint covers (a later batch adds the adjustments the run applies).
   */
  async evaluate(client: PrismaService | Tx, run: LockedRun) {
    const period = await client.payrollPeriod.findUniqueOrThrow({
      where: { id: run.payrollPeriodId },
      include: { calendar: true },
    });
    const manualAssignments = await client.payrollRunAssignment.findMany({
      where: {
        payrollRunId: run.id,
        OR: [
          { earningLines: { some: { origin: 'MANUAL' } } },
          { deductionLines: { some: { category: 'MANUAL' } } },
          { contributionLines: { some: { category: 'MANUAL' } } },
        ],
      },
      select: { employmentAssignmentId: true },
    });
    const adjustments = await this.adjustmentsFor(client, run);
    const assignments = await this.sources.collect(
      {
        payGroupId: run.payGroupId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        timePeriodId: period.timePeriodId,
        timezone: period.timezone,
        extraAssignmentIds: [
          ...manualAssignments.map((row) => row.employmentAssignmentId),
          ...adjustments.map((row) => row.employmentAssignmentId),
        ],
      },
      client,
    );
    const input: EngineInput = {
      currency: run.currency,
      payGroupId: run.payGroupId,
      period: {
        periodStart: formatDate(period.periodStart),
        periodEnd: formatDate(period.periodEnd),
        cadence: period.calendar.cadence,
      },
      salaryUnpaidLeaveRule: period.calendar.salaryUnpaidLeaveRule,
      salaryStandardAnnualHours:
        period.calendar.salaryStandardAnnualHours?.toFixed(2) ?? null,
      assignments,
    };
    const result = calculate(input);
    const fingerprint = runFingerprint(input, result.assignments, {
      adjustments: adjustments
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          amount: row.amount.toFixed(2),
          employmentAssignmentId: row.employmentAssignmentId,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    return { input, result, extras: { fingerprint, adjustments } };
  }

  /**
   * The pending adjustments a run carries: of its pay group and currency, for any assignment,
   * not carried by another live run. (A run whose period is already finalized carries none.)
   */
  async adjustmentsFor(client: PrismaService | Tx, run: LockedRun) {
    if (run.status === 'FINALIZED' || run.status === 'VOIDED') {
      return client.payrollAdjustment.findMany({
        where: { payrollRunId: run.id, status: { not: 'CANCELLED' } },
        orderBy: { id: 'asc' },
      });
    }
    return client.payrollAdjustment.findMany({
      where: {
        payGroupId: run.payGroupId,
        currency: run.currency,
        status: 'PENDING',
        OR: [{ payrollRunId: null }, { payrollRunId: run.id }],
      },
      orderBy: { id: 'asc' },
    });
  }

  /**
   * Claims the run's pending adjustments under row locks (after the run lock: payroll lock
   * order) and releases those it no longer carries. Two runs never carry one adjustment.
   */
  private async claimAdjustments(tx: Tx, run: LockedRun) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "PayrollAdjustment"
      WHERE "status" = 'PENDING' AND ("payrollRunId" = ${run.id}::uuid
        OR ("payrollRunId" IS NULL AND "payGroupId" = ${run.payGroupId}::uuid AND "currency" = ${run.currency}))
      ORDER BY "id" FOR UPDATE`);
    await tx.payrollAdjustment.updateMany({
      where: {
        payrollRunId: run.id,
        status: 'PENDING',
        NOT: { payGroupId: run.payGroupId, currency: run.currency },
      },
      data: { payrollRunId: null },
    });
    await tx.payrollAdjustment.updateMany({
      where: {
        payrollRunId: null,
        status: 'PENDING',
        payGroupId: run.payGroupId,
        currency: run.currency,
      },
      data: { payrollRunId: run.id },
    });
  }

  private async persist(
    tx: Tx,
    run: LockedRun,
    input: EngineInput,
    result: ReturnType<typeof calculate>,
    extras: Awaited<ReturnType<PayrollRunService['evaluate']>>['extras'],
  ) {
    // Replace what the previous calculation wrote (its source claims included, so a
    // recalculation never collides with itself); manual lines stay.
    await tx.payrollSourceClaim.deleteMany({ where: { payrollRunId: run.id } });
    await tx.payrollEarningLine.deleteMany({
      where: {
        payrollRunId: run.id,
        origin: { in: ['CALCULATED', 'ADJUSTMENT'] },
      },
    });
    await tx.payrollDeductionLine.deleteMany({
      where: {
        payrollRunId: run.id,
        category: { in: ['ADJUSTMENT', 'BENEFIT'] },
      },
    });
    await tx.payrollEmployerContributionLine.deleteMany({
      where: { payrollRunId: run.id, category: 'BENEFIT' },
    });
    await tx.payrollBenefitSnapshot.deleteMany({
      where: { payrollRunId: run.id },
    });
    await tx.payrollValidationIssue.deleteMany({
      where: { payrollRunId: run.id },
    });
    await tx.payrollCompensationSnapshot.deleteMany({
      where: { payrollRunId: run.id },
    });
    await tx.payrollTimeSnapshot.deleteMany({
      where: { payrollRunId: run.id },
    });
    await tx.payrollLeaveSnapshot.deleteMany({
      where: { payrollRunId: run.id },
    });
    await tx.payrollPresenceSnapshot.deleteMany({
      where: { payrollRunId: run.id },
    });

    const adjusted = new Set(
      extras.adjustments.map((row) => row.employmentAssignmentId),
    );
    // Assignments the run pays, or carries an adjustment (or manual line) for.
    const held = new Set(
      (
        await tx.payrollRunAssignment.findMany({
          where: {
            payrollRunId: run.id,
            OR: [
              { earningLines: { some: { origin: 'MANUAL' } } },
              { deductionLines: { some: { category: 'MANUAL' } } },
              { contributionLines: { some: { category: 'MANUAL' } } },
            ],
          },
          select: { employmentAssignmentId: true },
        })
      ).map((row) => row.employmentAssignmentId),
    );
    const included = result.assignments.filter(
      (assignment) =>
        assignment.inRun ||
        adjusted.has(assignment.employmentAssignmentId) ||
        held.has(assignment.employmentAssignmentId),
    );
    const keep = new Set(
      included.map((assignment) => assignment.employmentAssignmentId),
    );
    // Assignments no longer in the run: dropped, unless manual lines hold them in it.
    const existing = await tx.payrollRunAssignment.findMany({
      where: { payrollRunId: run.id },
      include: {
        _count: {
          select: {
            earningLines: true,
            deductionLines: true,
            contributionLines: true,
          },
        },
      },
    });
    for (const row of existing) {
      if (
        !keep.has(row.employmentAssignmentId) &&
        row._count.earningLines +
          row._count.deductionLines +
          row._count.contributionLines ===
          0
      ) {
        await tx.payrollRunAssignment.delete({ where: { id: row.id } });
      }
    }
    await tx.payrollRunEmployee.deleteMany({
      where: { payrollRunId: run.id, assignments: { none: {} } },
    });

    const issues: Prisma.PayrollValidationIssueCreateManyInput[] = [
      {
        payrollRunId: run.id,
        severity: NET_PAY_NOT_CALCULATED.severity,
        code: NET_PAY_NOT_CALCULATED.code,
        message: NET_PAY_NOT_CALCULATED.message,
      },
    ];
    if (included.length === 0) {
      issues.push({
        payrollRunId: run.id,
        severity: 'INFO',
        code: 'NO_EMPLOYEES',
        message: `No assignment is paid in ${run.currency} by this pay group in the period.`,
      });
    }
    // Batch 7C (audit F12): benefit timelines (employee and plan) are locked once, in one sorted
    // order, before any claim is checked — two runs claiming the same employees' benefit days
    // never take those locks in opposite orders.
    await this.lockBenefitTimelines(
      tx,
      included.flatMap((assignment) =>
        assignment.benefitLines.map((line) => line.enrollmentId),
      ),
    );
    for (const assignment of included) {
      const sources = input.assignments.find(
        (item) =>
          item.employment.employmentAssignmentId ===
          assignment.employmentAssignmentId,
      )!;
      const ids = await this.upsertMembers(
        tx,
        run.id,
        sources.employment,
        assignment,
      );
      const snapshotIds = await this.writeSnapshots(
        tx,
        run.id,
        ids.assignmentId,
        assignment,
        input,
      );
      const benefitSnapshots = await this.writeBenefitSnapshots(
        tx,
        run.id,
        ids.assignmentId,
        assignment,
      );
      const conflicts =
        assignment.lines.length + assignment.benefitLines.length > 0
          ? await this.claimSources(tx, run.id, ids.assignmentId, assignment)
          : [];
      if (conflicts.length > 0) {
        issues.push({
          payrollRunId: run.id,
          payrollRunEmployeeId: ids.employeeId,
          payrollRunAssignmentId: ids.assignmentId,
          severity: 'ERROR',
          code: 'PAYROLL_SOURCE_ALREADY_CONSUMED',
          message:
            'Some of these sources are already paid by another payroll run; they are not paid again (a finalized payment is corrected by an adjustment).',
          metadata: jsonValue({ conflicts }),
        });
      } else if (assignment.lines.length + assignment.benefitLines.length > 0) {
        await this.writeBenefitLines(
          tx,
          run,
          ids.assignmentId,
          assignment,
          benefitSnapshots,
        );
        await tx.payrollEarningLine.createMany({
          data: assignment.lines.map((line) => ({
            payrollRunId: run.id,
            payrollRunAssignmentId: ids.assignmentId,
            origin: 'CALCULATED' as const,
            type: line.type,
            description: line.description,
            workDate: line.workDate
              ? parseDateOnly(line.workDate, 'workDate')
              : null,
            periodFrom: line.periodFrom
              ? parseDateOnly(line.periodFrom, 'periodFrom')
              : null,
            periodTo: line.periodTo
              ? parseDateOnly(line.periodTo, 'periodTo')
              : null,
            quantity: line.quantity,
            quantityUnit: line.quantityUnit,
            rateAmount: line.rateAmount,
            amount: line.amount,
            currency: run.currency,
            calculationRule: line.calculationRule,
            calculationRuleVersion: line.calculationRuleVersion,
            compensationSnapshotId: line.compensationRecordId
              ? (snapshotIds.compensation.get(line.compensationRecordId) ??
                null)
              : null,
            timeSnapshotId: line.timeKey
              ? (snapshotIds.time.get(line.timeKey) ?? null)
              : null,
            leaveSnapshotId: line.leaveRequestDayId
              ? (snapshotIds.leave.get(line.leaveRequestDayId) ?? null)
              : null,
          })),
        });
      }
      for (const issue of assignment.issues) {
        issues.push({
          payrollRunId: run.id,
          payrollRunEmployeeId: ids.employeeId,
          payrollRunAssignmentId: ids.assignmentId,
          severity: issue.severity,
          code: issue.code,
          message: issue.message,
          metadata: issue.metadata ? jsonValue(issue.metadata) : undefined,
        });
      }
    }
    // Adjustments carried by this run become lines of the assignments they correct.
    for (const adjustment of extras.adjustments) {
      const target = await tx.payrollRunAssignment.findFirst({
        where: {
          payrollRunId: run.id,
          employmentAssignmentId: adjustment.employmentAssignmentId,
        },
        select: { id: true, payrollRunEmployeeId: true },
      });
      if (!target) continue;
      if (adjustment.kind === 'EARNING') {
        await tx.payrollEarningLine.create({
          data: {
            payrollRunId: run.id,
            payrollRunAssignmentId: target.id,
            origin: 'ADJUSTMENT',
            type: 'RETRO_ADJUSTMENT',
            description: adjustment.description,
            amount: adjustment.amount,
            currency: run.currency,
            calculationRule: 'PAYROLL_ADJUSTMENT',
            calculationRuleVersion: 1,
            payrollAdjustmentId: adjustment.id,
          },
        });
      } else {
        await tx.payrollDeductionLine.create({
          data: {
            payrollRunId: run.id,
            payrollRunAssignmentId: target.id,
            category: 'ADJUSTMENT',
            description: adjustment.description,
            amount: adjustment.amount,
            currency: run.currency,
            payrollAdjustmentId: adjustment.id,
          },
        });
      }
      issues.push({
        payrollRunId: run.id,
        payrollRunEmployeeId: target.payrollRunEmployeeId,
        payrollRunAssignmentId: target.id,
        severity: 'INFO',
        code: 'ADJUSTMENT_INCLUDED',
        message: `A payroll adjustment is carried: ${adjustment.description}.`,
        metadata: jsonValue({
          payrollAdjustmentId: adjustment.id,
          sourceRunId: adjustment.sourceRunId,
        }),
      });
    }
    await tx.payrollValidationIssue.createMany({ data: issues });
    await this.refreshManualWarnings(tx, run.id);
  }

  /** The benefit facts an assignment's benefit lines come from, frozen with the run. */
  private async writeBenefitSnapshots(
    tx: Tx,
    runId: string,
    runAssignmentId: string,
    assignment: AssignmentResult,
  ) {
    const ids: string[] = [];
    for (const fact of assignment.benefits) {
      const id = randomUUID();
      ids.push(id);
      await tx.payrollBenefitSnapshot.create({
        data: {
          id,
          payrollRunId: runId,
          payrollRunAssignmentId: runAssignmentId,
          benefitEnrollmentId: fact.enrollmentId,
          planId: fact.planId,
          planCode: fact.planCode,
          planName: fact.planName,
          benefitType: fact.benefitType,
          optionId: fact.optionId,
          optionCode: fact.optionCode,
          coverageLevel: fact.coverageLevel,
          rateId: fact.rateId,
          frequency: fact.frequency,
          employeeAmount: fact.employeeAmount,
          employerAmount: fact.employerAmount,
          currency: fact.currency,
          employerContributionTaxable: fact.employerContributionTaxable,
          coveredFrom: parseDateOnly(fact.from, 'from'),
          coveredTo: parseDateOnly(fact.to, 'to'),
        },
      });
    }
    return ids;
  }

  /** BENEFIT deduction (employee cost) and employer contribution lines. */
  private async writeBenefitLines(
    tx: Tx,
    run: LockedRun,
    runAssignmentId: string,
    assignment: AssignmentResult,
    snapshotIds: string[],
  ) {
    for (const line of assignment.benefitLines) {
      const data = {
        payrollRunId: run.id,
        payrollRunAssignmentId: runAssignmentId,
        category: 'BENEFIT' as const,
        description: line.description,
        amount: line.amount,
        currency: run.currency,
        benefitSnapshotId: snapshotIds[line.factIndex]!,
      };
      if (line.kind === 'DEDUCTION') {
        await tx.payrollDeductionLine.create({ data });
      } else {
        await tx.payrollEmployerContributionLine.create({ data });
      }
    }
  }

  /**
   * Batch 7C (audit F12): one transaction lock per employee and plan whose benefit days this run
   * claims, taken in a single sorted order (two runs never deadlock on them).
   */
  private async lockBenefitTimelines(tx: Tx, enrollmentIds: string[]) {
    if (enrollmentIds.length === 0) return;
    const enrollments = await tx.benefitEnrollment.findMany({
      where: { id: { in: [...new Set(enrollmentIds)] } },
      select: { employeeId: true, planId: true },
    });
    const timelines = [
      ...new Set(enrollments.map((row) => `${row.employeeId}:${row.planId}`)),
    ].sort();
    for (const timeline of timelines) {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`payroll-benefit-day:${timeline}`}, 0))`);
    }
  }

  /**
   * Batch 7C (audit F12): BENEFIT_DAY claims of other runs (live or finalized — voided runs
   * release theirs) for the same employee, plan and date through another election of the plan.
   * The caller holds the timelines' locks (lockBenefitTimelines), so two runs never both pass.
   */
  private async benefitDaysPaidElsewhere(
    tx: Tx,
    runId: string,
    rows: ReadonlyArray<{
      kind: string;
      workDate: string;
      sourceId: string | null;
    }>,
  ) {
    const benefitRows = rows.filter(
      (row) => row.kind === 'BENEFIT_DAY' && row.sourceId,
    );
    if (benefitRows.length === 0) return [];
    const enrollments = await tx.benefitEnrollment.findMany({
      where: {
        id: { in: [...new Set(benefitRows.map((row) => row.sourceId!))] },
      },
      select: { id: true, employeeId: true, planId: true },
    });
    // The timelines' locks are held already (lockBenefitTimelines, before the claims loop).
    const byId = new Map(enrollments.map((row) => [row.id, row]));
    const wanted = benefitRows.map((row) => ({
      ...byId.get(row.sourceId!)!,
      workDate: row.workDate,
    }));
    const held = await tx.$queryRaw<
      Array<{
        workDate: Date;
        benefitEnrollmentId: string;
        payrollRunId: string;
        status: string;
      }>
    >(Prisma.sql`
      SELECT c."workDate", c."benefitEnrollmentId", c."payrollRunId", r."status"::text AS "status"
      FROM "PayrollSourceClaim" c
      JOIN "BenefitEnrollment" e ON e."id" = c."benefitEnrollmentId"
      JOIN "PayrollRun" r ON r."id" = c."payrollRunId"
      JOIN unnest(
        ${wanted.map((row) => row.employeeId)}::uuid[],
        ${wanted.map((row) => row.planId)}::uuid[],
        ${wanted.map((row) => row.workDate)}::date[],
        ${wanted.map((row) => row.id)}::uuid[]
      ) AS w("employeeId", "planId", "workDate", "enrollmentId")
        ON w."employeeId" = e."employeeId" AND w."planId" = e."planId"
       AND w."workDate" = c."workDate" AND w."enrollmentId" <> c."benefitEnrollmentId"
      WHERE c."kind" = 'BENEFIT_DAY' AND c."payrollRunId" <> ${runId}::uuid
      ORDER BY c."workDate", c."benefitEnrollmentId"`);
    return held.map((row) => ({
      kind: 'BENEFIT_DAY' as const,
      workDate: formatDate(row.workDate),
      leaveRequestDayId: null,
      benefitEnrollmentId: row.benefitEnrollmentId,
      payrollRunId: row.payrollRunId,
      payrollRunStatus: row.status,
    }));
  }

  /**
   * Claims the sources an assignment's calculated lines pay: worked time and salaried days per
   * assignment date, leave per leave day. INSERT … ON CONFLICT DO NOTHING waits for a concurrent
   * claimer and never aborts the transaction; any source already claimed by another (live or
   * finalized) run is returned as a conflict, and then none of the assignment's claims are kept
   * (its lines are not written: never a partial payment). Keys are inserted in a fixed order so
   * two concurrent calculations cannot deadlock on them.
   */
  private async claimSources(
    tx: Tx,
    runId: string,
    runAssignmentId: string,
    assignment: AssignmentResult,
  ) {
    const claims = new Map<
      string,
      {
        kind: 'WORKED_TIME' | 'SALARY_DAY' | 'LEAVE' | 'BENEFIT_DAY';
        workDate: string;
        /** The leave day (LEAVE) or benefit election (BENEFIT_DAY) paid. */
        sourceId: string | null;
      }
    >();
    for (const line of assignment.lines) {
      const kind =
        line.type === 'REGULAR_HOURLY'
          ? 'WORKED_TIME'
          : line.type === 'REGULAR_SALARY'
            ? 'SALARY_DAY'
            : line.leaveRequestDayId
              ? 'LEAVE'
              : null;
      if (!kind) continue;
      for (const workDate of line.sourceDates) {
        const sourceId = kind === 'LEAVE' ? line.leaveRequestDayId : null;
        claims.set(`${kind}:${workDate}:${sourceId ?? ''}`, {
          kind,
          workDate,
          sourceId,
        });
      }
    }
    // A benefit election is paid (deducted and contributed) once per date.
    for (const line of assignment.benefitLines) {
      for (const workDate of line.sourceDates) {
        claims.set(`BENEFIT_DAY:${workDate}:${line.enrollmentId}`, {
          kind: 'BENEFIT_DAY',
          workDate,
          sourceId: line.enrollmentId,
        });
      }
    }
    const rows = [...claims.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, claim]) => claim);
    if (rows.length === 0) return [];
    // Batch 7C (audit F12): a benefit is paid once per employee, plan and date — whichever
    // election of the plan's timeline carries it. A transfer or correction creates a new
    // election over dates another run may already have paid (possibly in another pay group):
    // those dates are already consumed. Serialized per employee and plan.
    const benefitDays = await this.benefitDaysPaidElsewhere(tx, runId, rows);
    if (benefitDays.length > 0) return benefitDays;
    const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "PayrollSourceClaim"
        ("id", "payrollRunId", "payrollRunAssignmentId", "employmentAssignmentId", "kind", "workDate",
         "leaveRequestDayId", "benefitEnrollmentId")
      SELECT gen_random_uuid(), ${runId}::uuid, ${runAssignmentId}::uuid, ${assignment.employmentAssignmentId}::uuid,
             claim.kind::"PayrollSourceKind", claim.work_date::date,
             CASE WHEN claim.kind = 'LEAVE' THEN claim.source_id::uuid END,
             CASE WHEN claim.kind = 'BENEFIT_DAY' THEN claim.source_id::uuid END
      FROM unnest(
        ${rows.map((row) => row.kind)}::text[],
        ${rows.map((row) => row.workDate)}::text[],
        ${rows.map((row) => row.sourceId)}::text[]
      ) WITH ORDINALITY AS claim(kind, work_date, source_id, position)
      ORDER BY claim.position
      ON CONFLICT DO NOTHING
      RETURNING "id"`);
    if (inserted.length === rows.length) return [];
    await tx.payrollSourceClaim.deleteMany({
      where: { payrollRunId: runId, payrollRunAssignmentId: runAssignmentId },
    });
    const held = await tx.payrollSourceClaim.findMany({
      where: {
        payrollRunId: { not: runId },
        OR: rows.map((row) =>
          row.kind === 'LEAVE'
            ? {
                kind: 'LEAVE' as const,
                leaveRequestDayId: row.sourceId,
              }
            : row.kind === 'BENEFIT_DAY'
              ? {
                  kind: 'BENEFIT_DAY' as const,
                  benefitEnrollmentId: row.sourceId,
                  workDate: parseDateOnly(row.workDate, 'workDate'),
                }
              : {
                  kind: row.kind,
                  employmentAssignmentId: assignment.employmentAssignmentId,
                  workDate: parseDateOnly(row.workDate, 'workDate'),
                },
        ),
      },
      include: { run: { select: { status: true } } },
      orderBy: [{ workDate: 'asc' }, { kind: 'asc' }],
    });
    return held.map((row) => ({
      kind: row.kind,
      workDate: formatDate(row.workDate),
      leaveRequestDayId: row.leaveRequestDayId,
      benefitEnrollmentId: row.benefitEnrollmentId,
      payrollRunId: row.payrollRunId,
      payrollRunStatus: row.run.status,
    }));
  }

  /**
   * Manual lines are payroll-internal facts the reviewers must see: one warning per assignment
   * and kind of manual line still in effect (a line and its reversal cancel out).
   */
  async refreshManualWarnings(tx: Tx, runId: string) {
    const codes = {
      earning: 'MANUAL_EARNING_PRESENT',
      deduction: 'MANUAL_DEDUCTION_PRESENT',
      contribution: 'MANUAL_CONTRIBUTION_PRESENT',
    } as const;
    await tx.payrollValidationIssue.deleteMany({
      where: { payrollRunId: runId, code: { in: Object.values(codes) } },
    });
    const select = {
      id: true,
      reversesLineId: true,
      payrollRunAssignmentId: true,
      runAssignment: { select: { payrollRunEmployeeId: true } },
    } as const;
    const kinds = [
      [
        'earning',
        await tx.payrollEarningLine.findMany({
          where: { payrollRunId: runId, origin: 'MANUAL' },
          select,
        }),
      ],
      [
        'deduction',
        await tx.payrollDeductionLine.findMany({
          where: { payrollRunId: runId, category: 'MANUAL' },
          select,
        }),
      ],
      [
        'contribution',
        await tx.payrollEmployerContributionLine.findMany({
          where: { payrollRunId: runId, category: 'MANUAL' },
          select,
        }),
      ],
    ] as const;
    const issues: Prisma.PayrollValidationIssueCreateManyInput[] = [];
    for (const [kind, lines] of kinds) {
      const reversed = new Set(lines.map((line) => line.reversesLineId));
      const active = new Map<string, string>();
      for (const line of lines) {
        if (line.reversesLineId || reversed.has(line.id)) continue;
        active.set(
          line.payrollRunAssignmentId,
          line.runAssignment.payrollRunEmployeeId,
        );
      }
      for (const [assignmentId, employeeId] of active) {
        issues.push({
          payrollRunId: runId,
          payrollRunEmployeeId: employeeId,
          payrollRunAssignmentId: assignmentId,
          severity: 'WARNING',
          code: codes[kind],
          message: `A manually entered ${kind === 'contribution' ? 'employer contribution' : kind} is included.`,
        });
      }
    }
    if (issues.length > 0)
      await tx.payrollValidationIssue.createMany({ data: issues });
  }

  private async upsertMembers(
    tx: Tx,
    runId: string,
    employment: EngineInput['assignments'][number]['employment'],
    assignment: AssignmentResult,
  ) {
    const employee = await tx.payrollRunEmployee.upsert({
      where: {
        payrollRunId_employeeId: {
          payrollRunId: runId,
          employeeId: employment.employeeId,
        },
      },
      create: {
        payrollRunId: runId,
        employeeId: employment.employeeId,
        employeeNumber: employment.employeeNumber,
        displayName: employment.displayName,
      },
      update: {
        employeeNumber: employment.employeeNumber,
        displayName: employment.displayName,
      },
    });
    const snapshot = {
      organizationId: employment.organizationId,
      positionId: employment.positionId,
      positionName: employment.positionName,
      employmentType: employment.employmentType,
      assignmentStatus: employment.assignmentStatus,
      assignmentStartDate: parseDateOnly(employment.startDate, 'startDate'),
      assignmentEndDate: employment.endDate
        ? parseDateOnly(employment.endDate, 'endDate')
        : null,
      timezone: null as string | null,
      sourceFingerprint: assignment.fingerprint,
    };
    const row = await tx.payrollRunAssignment.upsert({
      where: {
        payrollRunEmployeeId_employmentAssignmentId: {
          payrollRunEmployeeId: employee.id,
          employmentAssignmentId: employment.employmentAssignmentId,
        },
      },
      create: {
        payrollRunId: runId,
        payrollRunEmployeeId: employee.id,
        employeeId: employment.employeeId,
        employmentAssignmentId: employment.employmentAssignmentId,
        ...snapshot,
      },
      update: snapshot,
    });
    return { employeeId: employee.id, assignmentId: row.id };
  }

  private async writeSnapshots(
    tx: Tx,
    runId: string,
    runAssignmentId: string,
    assignment: AssignmentResult,
    input: EngineInput,
  ) {
    const sources = input.assignments.find(
      (item) =>
        item.employment.employmentAssignmentId ===
        assignment.employmentAssignmentId,
    )!;
    await tx.payrollRunAssignment.update({
      where: { id: runAssignmentId },
      data: { timezone: sources.time.timezone },
    });
    const compensation = new Map<string, string>();
    const time = new Map<string, string>();
    const leave = new Map<string, string>();
    const base = {
      payrollRunId: runId,
      payrollRunAssignmentId: runAssignmentId,
    };
    if (assignment.compensation.length > 0) {
      await tx.payrollCompensationSnapshot.createMany({
        data: assignment.compensation.map((fact) => {
          const id = randomUUID();
          compensation.set(fact.compensationRecordId, id);
          return {
            id,
            ...base,
            compensationRecordId: fact.compensationRecordId,
            payBasis: fact.payBasis,
            rateAmount: fact.rateAmount,
            salaryArrangement: fact.salaryArrangement,
            salaryMonthlyAmount: fact.salaryMonthlyAmount,
            salaryPaidMonths: fact.salaryPaidMonths,
            salaryContractAmount: fact.salaryContractAmount,
            salaryPeriodStart: fact.salaryPeriodStart
              ? parseDateOnly(fact.salaryPeriodStart, 'salaryPeriodStart')
              : null,
            salaryPeriodEnd: fact.salaryPeriodEnd
              ? parseDateOnly(fact.salaryPeriodEnd, 'salaryPeriodEnd')
              : null,
            currency: fact.currency,
            effectiveFrom: parseDateOnly(fact.effectiveFrom, 'effectiveFrom'),
            effectiveTo: fact.effectiveTo
              ? parseDateOnly(fact.effectiveTo, 'effectiveTo')
              : null,
            payGroupId: fact.payGroupId,
          };
        }),
      });
    }
    if (assignment.time.length > 0) {
      await tx.payrollTimeSnapshot.createMany({
        data: assignment.time.map((output) => {
          const id = randomUUID();
          time.set(output.key, id);
          return {
            id,
            ...base,
            timePeriodId: output.timePeriodId,
            timesheetId: output.timesheetId,
            timesheetSegmentId: output.timesheetSegmentId,
            timesheetVersion: output.timesheetVersion,
            finalizationStatus: output.finalizationStatus,
            workDate: parseDateOnly(output.workDate, 'workDate'),
            approvedWorkedMinutes: output.approvedWorkedMinutes,
            grossMinutes: output.grossMinutes,
            paidBreakMinutes: output.paidBreakMinutes,
            unpaidBreakMinutes: output.unpaidBreakMinutes,
            policyDeductionMinutes: output.policyDeductionMinutes,
          };
        }),
      });
    }
    if (assignment.leave.length > 0) {
      await tx.payrollLeaveSnapshot.createMany({
        data: assignment.leave.map((day) => {
          const id = randomUUID();
          leave.set(day.leaveRequestDayId, id);
          return {
            id,
            ...base,
            leaveRequestId: day.leaveRequestId,
            leaveRequestDayId: day.leaveRequestDayId,
            leaveTypeId: day.leaveTypeId,
            leaveTypeCode: day.leaveTypeCode,
            classification: day.classification,
            date: parseDateOnly(day.date, 'date'),
            minutes: day.minutes,
            scheduledShiftRevisionIds: day.scheduledShiftRevisionIds,
          };
        }),
      });
    }
    if (assignment.presence.length > 0) {
      await tx.payrollPresenceSnapshot.createMany({
        data: assignment.presence.map((fact) => ({
          ...base,
          attendanceSignInId: fact.signInId,
          signedInAt: new Date(fact.signedInAt),
          workDate: parseDateOnly(fact.workDate, 'workDate'),
          scheduledShiftRevisionId: fact.scheduledShiftRevisionId,
        })),
      });
    }
    return { compensation, time, leave };
  }

  /** Recomputes and stores assignment, employee and run totals from the run's lines. */
  async applyTotals(tx: Tx, runId: string) {
    const assignments = await tx.payrollRunAssignment.findMany({
      where: { payrollRunId: runId },
      select: { id: true, payrollRunEmployeeId: true },
    });
    const sums = await tx.payrollEarningLine.groupBy({
      by: ['payrollRunAssignmentId'],
      where: { payrollRunId: runId },
      _sum: { amount: true },
    });
    const gross = new Map(
      sums.map((row) => [
        row.payrollRunAssignmentId,
        row._sum.amount ?? new Decimal(0),
      ]),
    );
    const deductions = await this.deductionTotals(tx, runId);
    const contributions = await this.contributionTotals(tx, runId);
    const byEmployee = new Map<
      string,
      {
        gross: Prisma.Decimal;
        deductions: Prisma.Decimal;
        contributions: Prisma.Decimal;
      }
    >();
    let runGross = new Decimal(0);
    let runDeductions = new Decimal(0);
    let runContributions = new Decimal(0);
    for (const assignment of assignments) {
      const g = money(new Decimal(gross.get(assignment.id) ?? 0));
      const d = money(new Decimal(deductions.get(assignment.id) ?? 0));
      const c = money(new Decimal(contributions.get(assignment.id) ?? 0));
      await tx.payrollRunAssignment.update({
        where: { id: assignment.id },
        data: {
          grossAmount: g,
          deductionAmount: d,
          employerContributionAmount: c,
        },
      });
      const employee = byEmployee.get(assignment.payrollRunEmployeeId) ?? {
        gross: new Decimal(0),
        deductions: new Decimal(0),
        contributions: new Decimal(0),
      };
      employee.gross = employee.gross.add(g);
      employee.deductions = employee.deductions.add(d);
      employee.contributions = employee.contributions.add(c);
      byEmployee.set(assignment.payrollRunEmployeeId, employee);
      runGross = runGross.add(g);
      runDeductions = runDeductions.add(d);
      runContributions = runContributions.add(c);
    }
    for (const [employeeId, totals] of byEmployee) {
      await tx.payrollRunEmployee.update({
        where: { id: employeeId },
        data: {
          grossAmount: totals.gross,
          deductionAmount: totals.deductions,
          employerContributionAmount: totals.contributions,
        },
      });
    }
    return {
      grossAmount: money(runGross),
      deductionAmount: money(runDeductions),
      employerContributionAmount: money(runContributions),
    };
  }

  private async deductionTotals(tx: Tx, runId: string) {
    const rows = await tx.payrollDeductionLine.groupBy({
      by: ['payrollRunAssignmentId'],
      where: { payrollRunId: runId },
      _sum: { amount: true },
    });
    return new Map(
      rows.map((row) => [
        row.payrollRunAssignmentId,
        row._sum.amount ?? new Decimal(0),
      ]),
    );
  }

  private async contributionTotals(tx: Tx, runId: string) {
    const rows = await tx.payrollEmployerContributionLine.groupBy({
      by: ['payrollRunAssignmentId'],
      where: { payrollRunId: runId },
      _sum: { amount: true },
    });
    return new Map(
      rows.map((row) => [
        row.payrollRunAssignmentId,
        row._sum.amount ?? new Decimal(0),
      ]),
    );
  }

  /**
   * Pay that cannot be paid blocks approval: an employee's gross below zero (adjustments larger
   * than this period's earnings) or deductions above gross. Recomputed after every change.
   */
  async refreshPayChecks(tx: Tx, runId: string) {
    await tx.payrollValidationIssue.deleteMany({
      where: {
        payrollRunId: runId,
        code: { in: ['NEGATIVE_GROSS_PAY', 'DEDUCTIONS_EXCEED_GROSS'] },
      },
    });
    const employees = await tx.payrollRunEmployee.findMany({
      where: { payrollRunId: runId },
    });
    const issues: Prisma.PayrollValidationIssueCreateManyInput[] = [];
    for (const employee of employees) {
      if (employee.grossAmount.lt(0)) {
        issues.push({
          payrollRunId: runId,
          payrollRunEmployeeId: employee.id,
          severity: 'ERROR',
          code: 'NEGATIVE_GROSS_PAY',
          message:
            'Gross pay is below zero; defer or cancel the adjustment that causes it.',
          metadata: jsonValue({ grossAmount: employee.grossAmount.toFixed(2) }),
        });
      } else if (employee.deductionAmount.gt(employee.grossAmount)) {
        issues.push({
          payrollRunId: runId,
          payrollRunEmployeeId: employee.id,
          severity: 'ERROR',
          code: 'DEDUCTIONS_EXCEED_GROSS',
          message: 'Deductions exceed gross pay.',
          metadata: jsonValue({
            grossAmount: employee.grossAmount.toFixed(2),
            deductionAmount: employee.deductionAmount.toFixed(2),
          }),
        });
      }
    }
    if (issues.length > 0)
      await tx.payrollValidationIssue.createMany({ data: issues });
  }

  /**
   * Warns when the sources of an earlier finalized run changed for anyone in this run: the
   * finalized run is never rewritten; a retroactive adjustment may be due. Checked against the
   * pay group's previous finalized period and (Batch 4A) every finalized run a reopened timesheet
   * recorded a retro requirement against for an assignment in this run, however far back.
   */
  private async priorPeriodChanges(
    tx: Tx,
    run: LockedRun,
    result: ReturnType<typeof calculate>,
  ) {
    const period = await tx.payrollPeriod.findUniqueOrThrow({
      where: { id: run.payrollPeriodId },
    });
    const inRunIds = result.assignments
      .filter((a) => a.inRun)
      .map((a) => a.employmentAssignmentId);
    const prior = await tx.payrollRun.findFirst({
      where: {
        payGroupId: run.payGroupId,
        currency: run.currency,
        status: 'FINALIZED',
        period: { periodEnd: { lt: period.periodStart } },
      },
      orderBy: { period: { periodStart: 'desc' } },
    });
    const required =
      inRunIds.length === 0
        ? []
        : await tx.payrollRetroRequirement.findMany({
            where: {
              employmentAssignmentId: { in: inRunIds },
              payrollRunId: { not: run.id },
              run: { status: 'FINALIZED', currency: run.currency },
            },
            select: { payrollRunId: true, employmentAssignmentId: true },
          });
    const candidates = new Map<string, Set<string> | null>();
    // The previous period: any changed assignment in this run (as before).
    if (prior) candidates.set(prior.id, null);
    // Reopened time: the assignments a requirement names. Always re-evaluated from the run's
    // current sources (freshnessOf): a resolution answers only the exact source fingerprint and
    // adjusted amount it recorded, and many payroll sources (compensation, employment, leave,
    // benefits, rules, time policy, live entries) change without touching the timesheet, so no
    // timestamp can stand in for that comparison.
    for (const row of required) {
      const existing = candidates.get(row.payrollRunId);
      if (existing === null) continue;
      const set = existing ?? new Set<string>();
      set.add(row.employmentAssignmentId);
      candidates.set(row.payrollRunId, set);
    }
    for (const [sourceRunId, only] of candidates) {
      const source = await tx.payrollRun.findUniqueOrThrow({
        where: { id: sourceRunId },
        select: {
          id: true,
          organizationId: true,
          payGroupId: true,
          payrollPeriodId: true,
          currency: true,
          status: true,
          sourceFingerprint: true,
          approvedAt: true,
        },
      });
      await this.warnPriorRunChanges(tx, run, source, inRunIds, only);
    }
  }

  private async warnPriorRunChanges(
    tx: Tx,
    run: LockedRun,
    prior: LockedRun,
    inRunIds: string[],
    only: Set<string> | null,
  ) {
    const freshness = await this.freshnessOf(tx, prior);
    if (!freshness.stale || freshness.changedAssignmentIds.length === 0) return;
    const inRun = new Set(
      inRunIds.filter((id) => only === null || only.has(id)),
    );
    // A retroactive adjustment computed from the current sources already answers the change.
    const answered = await tx.payrollAdjustment.findMany({
      where: { sourceRunId: prior.id, status: { not: 'CANCELLED' } },
      select: {
        employmentAssignmentId: true,
        sourceFingerprint: true,
        kind: true,
        amount: true,
      },
    });
    // Batch 4A: the retro tool records a resolution whenever it settles an assignment (with or
    // without a new adjustment). A resolution answers while it holds: the same source fingerprint
    // (same run and assignment) and the same adjustments counted, so a later change of either
    // (an adjustment cancelled, sources changed again) brings the warning back.
    const resolutions = await tx.payrollRetroResolution.findMany({
      where: {
        payrollRunId: prior.id,
        employmentAssignmentId: { in: [...inRun] },
      },
      select: {
        employmentAssignmentId: true,
        sourceFingerprint: true,
        adjustedAmount: true,
      },
    });
    const resolvedOnce = new Set(
      resolutions.map((row) => row.employmentAssignmentId),
    );
    const adjustedSum = new Map<string, Prisma.Decimal>();
    for (const row of answered) {
      if (row.kind === 'EARNING') {
        adjustedSum.set(
          row.employmentAssignmentId,
          (
            adjustedSum.get(row.employmentAssignmentId) ?? new Prisma.Decimal(0)
          ).add(row.amount),
        );
      }
      // Retro adjustments from before resolutions existed keep answering by fingerprint, as
      // before; once an assignment has a resolution, only resolutions decide.
      if (
        row.sourceFingerprint &&
        !resolvedOnce.has(row.employmentAssignmentId) &&
        freshness.currentAssignmentFingerprints[row.employmentAssignmentId] ===
          row.sourceFingerprint
      ) {
        inRun.delete(row.employmentAssignmentId);
      }
    }
    for (const row of resolutions) {
      if (
        freshness.currentAssignmentFingerprints[row.employmentAssignmentId] ===
          row.sourceFingerprint &&
        row.adjustedAmount.equals(
          adjustedSum.get(row.employmentAssignmentId) ?? 0,
        )
      ) {
        inRun.delete(row.employmentAssignmentId);
      }
    }
    const rows = await tx.payrollRunAssignment.findMany({
      where: {
        payrollRunId: run.id,
        employmentAssignmentId: {
          in: freshness.changedAssignmentIds.filter((id) => inRun.has(id)),
        },
      },
    });
    if (rows.length === 0) return;
    await tx.payrollValidationIssue.createMany({
      data: rows.map((row) => ({
        payrollRunId: run.id,
        payrollRunEmployeeId: row.payrollRunEmployeeId,
        payrollRunAssignmentId: row.id,
        severity: 'WARNING' as const,
        code: 'PRIOR_PERIOD_SOURCE_CHANGED',
        message:
          'Sources of an earlier finalized payroll run changed; review its retroactive adjustments.',
        metadata: jsonValue({ sourceRunId: prior.id }),
      })),
    });
  }

  /** Locks the run row (after the pay group, per the payroll lock order). */
  async lockRun(tx: Tx, runId: string): Promise<LockedRun> {
    const rows = await tx.$queryRaw<LockedRun[]>(Prisma.sql`
      SELECT "id", "organizationId", "payGroupId", "payrollPeriodId", "currency", "status",
             "sourceFingerprint", "approvedAt"
      FROM "PayrollRun" WHERE "id" = ${runId}::uuid FOR UPDATE`);
    if (!rows[0]) throw new NotFoundException('Payroll run not found.');
    return rows[0];
  }

  async runOrThrow(
    runId: string,
    client: PrismaService | Tx = this.prisma,
  ): Promise<LockedRun> {
    const run = await client.payrollRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        organizationId: true,
        payGroupId: true,
        payrollPeriodId: true,
        currency: true,
        status: true,
        sourceFingerprint: true,
        approvedAt: true,
      },
    });
    if (!run) throw new NotFoundException('Payroll run not found.');
    return run;
  }

  statusConflict(status: PayrollRunStatus, action: string) {
    return new ConflictException(
      domainError(
        409,
        status === 'FINALIZED' || status === 'VOIDED'
          ? 'PAYROLL_RUN_FINAL'
          : 'PAYROLL_RUN_STATUS',
        status === 'FINALIZED'
          ? `A finalized payroll run cannot be ${action}; later changes become adjustments.`
          : `A ${status.toLowerCase()} payroll run cannot be ${action}.`,
        { status },
      ),
    );
  }
}
