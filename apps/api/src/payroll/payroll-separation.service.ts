import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  effectiveSettingValue,
  settingDefinition,
} from '../features/features-domain.js';
import type { PayrollClient } from './payroll-common.js';

/**
 * Security remediation M2 — payroll separation of duties (maker-checker).
 *
 * With `payroll.dualControl` on (the default for every organization), nobody approves a run
 * they prepared: the person who last calculated it, the author of an adjustment it carries,
 * and anyone who authored or closed compensation it pays (provenance: the compensation records
 * the run's snapshots used, the closure ledger, and the sources recorded on retro adjustments
 * it carries — never timestamps or "last editor"). The calculator never finalizes it, and a
 * run is finalized only on an approval that is itself independent. A legacy run whose
 * calculator is unknown is recalculated first. With dual control off, today's behaviour
 * applies. In both modes only an active user account approves or finalizes (automation acts
 * without one and never does), and nobody approves their own pay (unchanged rule).
 *
 * Checks are identity-based, never role-based: one person holding every payroll permission is
 * still refused. They run inside the approval / finalization transaction after the run lock
 * (and, for the setting, a shared lock on the organization's feature lock, so a concurrent
 * setting change commits wholly before or after), and the read model uses the same checks
 * for its capability flags.
 */
export type PayrollSeparationReason =
  | 'APPROVER_NOT_ELIGIBLE'
  | 'CALCULATOR_UNKNOWN_RECALCULATE'
  | 'CALCULATED_BY_YOU'
  | 'ADJUSTMENT_BY_YOU'
  | 'ADJUSTMENT_CANCELLED_BY_YOU'
  | 'MANUAL_LINE_BY_YOU'
  | 'COMPENSATION_CHANGED_BY_YOU'
  | 'INDEPENDENT_APPROVAL_REQUIRED';

export const PAYROLL_SEPARATION_MESSAGES: Readonly<
  Record<PayrollSeparationReason, string>
> = Object.freeze({
  APPROVER_NOT_ELIGIBLE:
    'Only an active administrator account can approve or finalize payroll.',
  CALCULATOR_UNKNOWN_RECALCULATE:
    'This run was calculated before calculations were attributed: recalculate it, then have someone else approve it.',
  CALCULATED_BY_YOU:
    'You calculated this run: another administrator must approve and finalize it.',
  ADJUSTMENT_BY_YOU:
    'This run carries an adjustment you added: another administrator must approve it.',
  ADJUSTMENT_CANCELLED_BY_YOU:
    'You cancelled an adjustment this run carried: another administrator must approve it.',
  MANUAL_LINE_BY_YOU:
    'You added or reversed a manual line on this run: another administrator must approve it.',
  COMPENSATION_CHANGED_BY_YOU:
    'You changed compensation this run pays: another administrator must approve it.',
  INDEPENDENT_APPROVAL_REQUIRED:
    'This run’s approval was not independent of its preparation: recalculate it and have it approved again.',
});

export interface SeparationRun {
  id: string;
  organizationId: string;
  calculatedByUserId: string | null;
  approvedByUserId: string | null;
}

@Injectable()
export class PayrollSeparationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The organization's dual-control setting. With `lock`, takes a shared transaction lock on the
   * organization's feature lock first, so a setting change in progress commits before (or waits
   * for) the caller's transaction.
   */
  async dualControl(
    client: PayrollClient,
    organizationId: string,
    options: { lock?: boolean } = {},
  ): Promise<boolean> {
    if (options.lock) {
      await client.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`organization-features:${organizationId}`}, 0))`,
      );
    }
    const definition = settingDefinition('payroll.dualControl')!;
    const row = await client.organizationSetting.findUnique({
      where: {
        organizationId_key: { organizationId, key: 'payroll.dualControl' },
      },
    });
    return effectiveSettingValue(definition, row ?? null).value === true;
  }

  /** The attribution columns of a run (read within the caller's transaction, after its lock). */
  async runOf(client: PayrollClient, runId: string): Promise<SeparationRun> {
    return client.payrollRun.findUniqueOrThrow({
      where: { id: runId },
      select: {
        id: true,
        organizationId: true,
        calculatedByUserId: true,
        approvedByUserId: true,
      },
    });
  }

  /** Why `actorUserId` may not approve the run (null: may). */
  async approvalRefusal(
    client: PayrollClient,
    run: SeparationRun,
    actorUserId: string | undefined,
    dualControl: boolean,
  ): Promise<PayrollSeparationReason | null> {
    if (!(await this.eligible(client, actorUserId)))
      return 'APPROVER_NOT_ELIGIBLE';
    if (!dualControl) return null;
    if (!run.calculatedByUserId) return 'CALCULATOR_UNKNOWN_RECALCULATE';
    if (run.calculatedByUserId === actorUserId) return 'CALCULATED_BY_YOU';
    return this.contribution(client, run.id, actorUserId!);
  }

  /** Why `actorUserId` may not finalize the run (null: may). */
  async finalizationRefusal(
    client: PayrollClient,
    run: SeparationRun,
    actorUserId: string | undefined,
    dualControl: boolean,
  ): Promise<PayrollSeparationReason | null> {
    if (!(await this.eligible(client, actorUserId)))
      return 'APPROVER_NOT_ELIGIBLE';
    if (!dualControl) return null;
    if (!run.calculatedByUserId) return 'CALCULATOR_UNKNOWN_RECALCULATE';
    if (run.calculatedByUserId === actorUserId) return 'CALCULATED_BY_YOU';
    // The approval it rests on must itself be independent (e.g. one given before M2).
    const approver = run.approvedByUserId;
    if (
      !approver ||
      approver === run.calculatedByUserId ||
      (await this.contribution(client, run.id, approver)) !== null
    )
      return 'INDEPENDENT_APPROVAL_REQUIRED';
    return null;
  }

  /**
   * Approval eligibility of the account itself: an actor (automation has none), whose user
   * account exists and is active. A human administrator without an Employee record is
   * eligible (the own-pay rule then has nothing to compare).
   */
  private async eligible(client: PayrollClient, actorUserId?: string) {
    if (!actorUserId) return false;
    const user = await client.user.findUnique({
      where: { id: actorUserId },
      select: { status: true, archivedAt: true },
    });
    return user?.status === 'ACTIVE' && user.archivedAt === null;
  }

  /** Whether the user prepared any of the run's financial inputs (adjustments, compensation). */
  private async contribution(
    client: PayrollClient,
    runId: string,
    userId: string,
  ): Promise<PayrollSeparationReason | null> {
    // Adjustments the run carries (claimed under the run lock at calculation).
    const adjustments = await client.payrollAdjustment.count({
      where: {
        payrollRunId: runId,
        status: 'PENDING',
        createdByUserId: userId,
      },
    });
    if (adjustments > 0) return 'ADJUSTMENT_BY_YOU';
    // Adjustments removed from this run by cancellation (independent review M1).
    const cancelled = await client.payrollAdjustment.count({
      where: { cancelledFromRunId: runId, cancelledByUserId: userId },
    });
    if (cancelled > 0) return 'ADJUSTMENT_CANCELLED_BY_YOU';
    // Manual lines (and reversals) on the run, whoever's line they reverse (review B1).
    const where = { payrollRunId: runId, createdByUserId: userId };
    const lines =
      (await client.payrollEarningLine.count({ where })) +
      (await client.payrollDeductionLine.count({ where })) +
      (await client.payrollEmployerContributionLine.count({ where }));
    if (lines > 0) return 'MANUAL_LINE_BY_YOU';
    const [row] = await client.$queryRaw<
      Array<{ changed: boolean }>
    >(Prisma.sql`
      WITH run AS (
        SELECT r."id", r."payGroupId", p."periodStart", p."periodEnd"
        FROM "PayrollRun" r JOIN "PayrollPeriod" p ON p."id" = r."payrollPeriodId"
        WHERE r."id" = ${runId}::uuid
      ),
      -- Records whose changes can affect the run: of an assignment in the run, or of the run's
      -- pay group (a change may have taken the assignment out of the run altogether).
      in_scope AS (
        SELECT c."id", c."employmentAssignmentId" FROM "CompensationRecord" c, run
        WHERE c."payGroupId" = run."payGroupId"
           OR c."employmentAssignmentId" IN (
             SELECT "employmentAssignmentId" FROM "PayrollRunAssignment"
             WHERE "payrollRunId" = ${runId}::uuid)
      ),
      -- Compensation the run pays: the records its snapshots were taken from.
      used AS (
        SELECT DISTINCT s."compensationRecordId" AS "id"
        FROM "PayrollCompensationSnapshot" s WHERE s."payrollRunId" = ${runId}::uuid
      ),
      -- Closures that removed days of the period from an in-scope record.
      closures AS (
        SELECT 1 FROM "CompensationRecordClosure" c, run
        WHERE c."closedByUserId" = ${userId}::uuid
          AND c."compensationRecordId" IN (SELECT "id" FROM in_scope)
          AND c."newEffectiveTo" < run."periodEnd"
          AND (c."previousEffectiveTo" IS NULL OR c."previousEffectiveTo" >= run."periodStart")
      ),
      -- Retro adjustments the run carries, with the compensation records they were computed
      -- from, and the records the finalized source run had already paid.
      retro AS (
        SELECT a."id", a."employmentAssignmentId", a."sourceRunId", src."finalizedAt"
        FROM "PayrollAdjustment" a JOIN "PayrollRun" src ON src."id" = a."sourceRunId"
        WHERE a."payrollRunId" = ${runId}::uuid AND a."status" = 'PENDING'
      ),
      retro_records AS (
        SELECT s."compensationRecordId" AS "id", r."finalizedAt",
          EXISTS (
            SELECT 1 FROM "PayrollCompensationSnapshot" f
            JOIN "PayrollRunAssignment" fa ON fa."id" = f."payrollRunAssignmentId"
            WHERE f."payrollRunId" = r."sourceRunId"
              AND fa."employmentAssignmentId" = r."employmentAssignmentId"
              AND f."compensationRecordId" = s."compensationRecordId"
          ) AS "alreadyPaid"
        FROM retro r JOIN "PayrollAdjustmentCompensationSource" s ON s."adjustmentId" = r."id"
        UNION ALL
        SELECT f."compensationRecordId", r."finalizedAt", true
        FROM retro r
        JOIN "PayrollRunAssignment" fa ON fa."payrollRunId" = r."sourceRunId"
          AND fa."employmentAssignmentId" = r."employmentAssignmentId"
        JOIN "PayrollCompensationSnapshot" f ON f."payrollRunAssignmentId" = fa."id"
        WHERE EXISTS (SELECT 1 FROM "PayrollAdjustmentCompensationSource" x WHERE x."adjustmentId" = r."id")
      )
      SELECT (
        EXISTS (
          SELECT 1 FROM "CompensationRecord" c JOIN used ON used."id" = c."id"
          WHERE c."createdByUserId" = ${userId}::uuid)
        OR EXISTS (SELECT 1 FROM closures)
        -- A correction of a record that paid days of the period, by its replacement's author
        -- (it may have moved pay out of the period entirely; review L1).
        OR EXISTS (
          SELECT 1 FROM "CompensationRecord" old
          JOIN "CompensationRecord" replacement ON replacement."supersedesRecordId" = old."id"
          CROSS JOIN run
          WHERE replacement."createdByUserId" = ${userId}::uuid
            AND old."id" IN (SELECT "id" FROM in_scope)
            AND old."effectiveFrom" <= run."periodEnd"
            AND (old."effectiveTo" IS NULL OR old."effectiveTo" >= run."periodStart"))
        -- A record the retro difference was computed from that the finalized run did not pay.
        OR EXISTS (
          SELECT 1 FROM retro_records rr JOIN "CompensationRecord" c ON c."id" = rr."id"
          WHERE NOT rr."alreadyPaid" AND c."createdByUserId" = ${userId}::uuid)
        -- A closure, after the source run was finalized, of a record behind the difference.
        OR EXISTS (
          SELECT 1 FROM retro_records rr
          JOIN "CompensationRecordClosure" c ON c."compensationRecordId" = rr."id"
          WHERE c."closedByUserId" = ${userId}::uuid
            AND (rr."finalizedAt" IS NULL OR c."createdAt" > rr."finalizedAt"))
      ) AS "changed"`);
    return row?.changed ? 'COMPENSATION_CHANGED_BY_YOU' : null;
  }
}
