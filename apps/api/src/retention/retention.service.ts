import { AuditService } from '../audit/audit.service.js';
import { advisoryLock, jsonValue } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  featureGateFor,
  type FeatureGateService,
} from '../features/feature-gate.service.js';
import type { FeatureModule } from '../features/features-domain.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  ANONYMIZED_CANDIDATE,
  emptyRetentionCounts,
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES,
  RETENTION_SETTING_KEYS,
  retentionChanged,
  retentionPlans,
  type RetentionCounts,
  type RetentionDataset,
} from './retention-domain.js';

type Tx = Prisma.TransactionClient;
type BatchRunner = (
  tx: Tx,
  organizationId: string,
  months: number,
  batchSize: number,
  counts: RetentionCounts,
) => Promise<number>;

export interface RetentionOptions {
  /** Rows per batch transaction (default 500). */
  batchSize?: number;
  /** Batches per dataset and organization in one run (default 20). */
  maxBatches?: number;
  /** Restrict the run to these organizations (default: every organization that opted in). */
  organizationIds?: readonly string[];
}

export interface RetentionOrganizationOutcome {
  organizationId: string;
  /** The periods applied, in months (identifiers and numbers only). */
  periods: Partial<Record<RetentionDataset, number>>;
  counts: RetentionCounts;
  /** Datasets that hit the batch cap: the rest is processed by the next run. */
  incomplete: RetentionDataset[];
}

export interface RetentionOutcome {
  organizations: RetentionOrganizationOutcome[];
  /** Organizations with a retention period whose module is disabled (Phase 18 convention). */
  skippedOrganizations: string[];
  failed: Array<{ organizationId: string; message: string }>;
}

/**
 * Phase 19 — the daily retention run (`retention.apply`). Processes only organizations with a
 * non-zero retention setting, in bounded batches (one transaction each, rows locked with SKIP
 * LOCKED so live traffic is never waited on), idempotently (a re-run finds nothing left to do),
 * and audits each organization's run with counts only.
 *
 * Every batch transaction sets `hrms.retention_purge = 'on'` locally; the database triggers then
 * accept exactly the retention deletes / redactions whose age rule they re-check themselves.
 * Writes use SQL so that `updatedAt` and every other column stay as they were (the triggers
 * compare the whole row).
 */
export class RetentionService {
  private readonly features: FeatureGateService;
  private readonly audit: AuditService;

  constructor(
    private readonly prisma: PrismaService,
    features?: FeatureGateService | null,
    audit?: AuditService | null,
  ) {
    this.features = featureGateFor(prisma, features);
    this.audit = audit ?? new AuditService(prisma);
  }

  async apply(options: RetentionOptions = {}): Promise<RetentionOutcome> {
    const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
    const maxBatches = options.maxBatches ?? RETENTION_MAX_BATCHES;
    const rows = await this.prisma.organizationSetting.findMany({
      where: {
        key: { in: [...RETENTION_SETTING_KEYS] },
        ...(options.organizationIds
          ? { organizationId: { in: [...options.organizationIds] } }
          : {}),
      },
      select: {
        organizationId: true,
        key: true,
        value: true,
        schemaVersion: true,
      },
    });
    const modules = new Map<string, Record<FeatureModule, boolean>>();
    for (const organizationId of new Set(rows.map((r) => r.organizationId)))
      modules.set(organizationId, await this.features.modules(organizationId));
    const plans = retentionPlans(
      rows,
      (organizationId, module) => modules.get(organizationId)?.[module] ?? true,
    );

    const outcome: RetentionOutcome = {
      organizations: [],
      skippedOrganizations: plans
        .filter((plan) => plan.gated.length > 0)
        .map((plan) => plan.organizationId),
      failed: [],
    };
    for (const plan of plans) {
      if (plan.datasets.length === 0) continue;
      const result: RetentionOrganizationOutcome = {
        organizationId: plan.organizationId,
        periods: Object.fromEntries(
          plan.datasets.map((d) => [d.dataset, d.months]),
        ),
        counts: emptyRetentionCounts(),
        incomplete: [],
      };
      try {
        for (const { dataset, months } of plan.datasets) {
          const complete = await this.process(
            dataset,
            plan.organizationId,
            months,
            result.counts,
            batchSize,
            maxBatches,
          );
          if (!complete) result.incomplete.push(dataset);
        }
      } catch (error) {
        outcome.failed.push({
          organizationId: plan.organizationId,
          message: error instanceof Error ? error.message : 'Retention failed.',
        });
      }
      if (retentionChanged(result.counts)) await this.record(result);
      outcome.organizations.push(result);
    }
    return outcome;
  }

  /**
   * Runs batches until nothing is left (a short batch; for candidates an empty one, since
   * merged-away records become eligible once their target was anonymized), or the cap.
   * True when done.
   */
  private async process(
    dataset: RetentionDataset,
    organizationId: string,
    months: number,
    counts: RetentionCounts,
    batchSize: number,
    maxBatches: number,
  ) {
    const run = this.batchRunner(dataset);
    for (let batch = 0; batch < maxBatches; batch++) {
      const processed = await this.prisma.$transaction(
        async (tx) => {
          await advisoryLock(tx, `retention:${organizationId}`);
          await tx.$executeRaw`SELECT set_config('hrms.retention_purge', 'on', true)`;
          const count = await run(
            tx,
            organizationId,
            months,
            batchSize,
            counts,
          );
          await tx.$executeRaw`SELECT set_config('hrms.retention_purge', 'off', true)`;
          return count;
        },
        { timeout: 60_000 },
      );
      if (
        processed === 0 ||
        (dataset !== 'candidates' && processed < batchSize)
      )
        return true;
    }
    return false;
  }

  private batchRunner(dataset: RetentionDataset): BatchRunner {
    const runners: Record<RetentionDataset, BatchRunner> = {
      candidates: (...args) => this.anonymizeCandidates(...args),
      notifications: (...args) => this.purgeNotifications(...args),
      deliveryLogs: (...args) => this.purgeDeliveryAttempts(...args),
      syncLogs: (...args) => this.purgeSyncRuns(...args),
      auditLog: (...args) => this.purgeAuditLog(...args),
    };
    return runners[dataset];
  }

  // ─── Candidates ─────────────────────────────────────────────────────────────

  /**
   * Unmerged candidates first, then records merged into an already anonymized candidate; the
   * eligibility rule is the database's own (hrms_candidate_retention_eligible). Returns the
   * number of candidates (plus unlinked submissions) handled in the batch.
   */
  private async anonymizeCandidates(
    tx: Tx,
    organizationId: string,
    months: number,
    batchSize: number,
    counts: RetentionCounts,
  ) {
    const candidates = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT c."id" FROM "RecruitmentCandidate" c
      WHERE c."organizationId" = ${organizationId}::uuid
        AND c."anonymizedAt" IS NULL AND c."personId" IS NULL AND c."internalEmployeeId" IS NULL
        AND c."createdAt" < now() - make_interval(months => ${months}::int)
        AND hrms_candidate_retention_eligible(c."id")
      ORDER BY (c."status" = 'MERGED'), c."createdAt", c."id"
      LIMIT ${batchSize}
      FOR NO KEY UPDATE OF c SKIP LOCKED`;
    // A merged-away record becomes eligible only after its target was anonymized (in an
    // earlier batch), so a batch never mixes a target with its own merged records' redaction.
    const ids = candidates.map((c) => c.id);
    if (ids.length > 0) await this.redactCandidates(tx, ids, counts);

    // Rejected submissions never linked to a candidate carry the same personal data.
    const remaining = batchSize - ids.length;
    let unlinked = 0;
    if (remaining > 0) {
      unlinked = await tx.$executeRaw`
        UPDATE "RecruitmentIntakeSubmission" SET "submission" = ${this.redactedSubmissionSql()}
        WHERE "id" IN (
          SELECT s."id" FROM "RecruitmentIntakeSubmission" s
          WHERE s."organizationId" = ${organizationId}::uuid AND s."candidateId" IS NULL
            AND s."status" = 'REJECTED'
            AND s."lastReceivedAt" < now() - make_interval(months => ${months}::int)
            AND coalesce(s."resolvedAt", s."lastReceivedAt") < now() - make_interval(months => ${months}::int)
            AND NOT coalesce(s."submission"->>'redacted' = 'true', false)
          ORDER BY s."lastReceivedAt", s."id"
          LIMIT ${remaining}
          FOR NO KEY UPDATE SKIP LOCKED
        )`;
      counts.intakeSubmissionsRedacted += unlinked;
    }
    return ids.length + unlinked;
  }

  private redactedSubmissionSql() {
    return Prisma.sql`jsonb_build_object(
      'openingCode', "submission"->'openingCode',
      'candidate', jsonb_build_object(
        'firstName', ${ANONYMIZED_CANDIDATE.firstName}::text,
        'lastName', ${ANONYMIZED_CANDIDATE.lastName}::text,
        'preferredName', NULL, 'email', NULL, 'phone', NULL, 'location', NULL
      ),
      'answers', '[]'::jsonb,
      'documents', '[]'::jsonb,
      'sourceDetail', NULL,
      'redacted', true
    )`;
  }

  /** Children first (their triggers re-check the candidate's eligibility), the candidate last. */
  private async redactCandidates(
    tx: Tx,
    ids: string[],
    counts: RetentionCounts,
  ) {
    const candidateIds = Prisma.sql`${ids}::uuid[]`;
    await tx.$executeRaw`
      UPDATE "RecruitmentCandidateDocument" SET
        "title" = ${ANONYMIZED_CANDIDATE.documentTitle},
        "provider" = 'MANUAL_REFERENCE',
        "externalUrl" = NULL, "externalFileId" = NULL, "fileName" = NULL, "mimeType" = NULL,
        "removedAt" = coalesce("removedAt", now()),
        "removalReason" = ${ANONYMIZED_CANDIDATE.documentRemovalReason}
      WHERE "candidateId" = ANY(${candidateIds})`;
    await tx.$executeRaw`
      UPDATE "RecruitmentScreening" s SET "notes" = NULL
      FROM "RecruitmentApplication" a
      WHERE a."id" = s."applicationId" AND a."candidateId" = ANY(${candidateIds})
        AND s."notes" IS NOT NULL`;
    await tx.$executeRaw`
      UPDATE "RecruitmentInterviewFeedback" f SET "strengths" = NULL, "concerns" = NULL, "comments" = NULL
      FROM "RecruitmentInterview" i
      JOIN "RecruitmentApplication" a ON a."id" = i."applicationId"
      WHERE i."id" = f."interviewId" AND a."candidateId" = ANY(${candidateIds})
        AND (f."strengths" IS NOT NULL OR f."concerns" IS NOT NULL OR f."comments" IS NOT NULL)`;
    await tx.$executeRaw`
      UPDATE "RecruitmentOffer" o SET
        "candidateTerms" = NULL, "internalNotes" = NULL, "declineReason" = NULL,
        "withdrawalReason" = CASE WHEN o."withdrawalReason" IS NULL THEN NULL
                                  ELSE ${ANONYMIZED_CANDIDATE.offerWithdrawalReason} END
      FROM "RecruitmentApplication" a
      WHERE a."id" = o."applicationId" AND a."candidateId" = ANY(${candidateIds})`;
    await tx.$executeRaw`
      UPDATE "RecruitmentApplication" SET "sourceDetail" = NULL, "dispositionReason" = NULL
      WHERE "candidateId" = ANY(${candidateIds})
        AND ("sourceDetail" IS NOT NULL OR "dispositionReason" IS NOT NULL)`;
    counts.intakeSubmissionsRedacted += await tx.$executeRaw`
      UPDATE "RecruitmentIntakeSubmission" SET "submission" = ${this.redactedSubmissionSql()}
      WHERE "candidateId" = ANY(${candidateIds})
        AND NOT coalesce("submission"->>'redacted' = 'true', false)`;
    counts.candidatesAnonymized += await tx.$executeRaw`
      UPDATE "RecruitmentCandidate" SET
        "firstName" = ${ANONYMIZED_CANDIDATE.firstName},
        "lastName" = ${ANONYMIZED_CANDIDATE.lastName},
        "preferredName" = NULL, "email" = NULL, "normalizedEmail" = NULL,
        "phone" = NULL, "location" = NULL, "notes" = NULL,
        "status" = CASE WHEN "status" = 'ACTIVE' THEN 'ARCHIVED'::"RecruitmentCandidateStatus" ELSE "status" END,
        "anonymizedAt" = now()
      WHERE "id" = ANY(${candidateIds}) AND "anonymizedAt" IS NULL`;
  }

  // ─── Notifications and logs ─────────────────────────────────────────────────

  /** Read or archived notifications past the period, with their finished deliveries. */
  private async purgeNotifications(
    tx: Tx,
    organizationId: string,
    months: number,
    batchSize: number,
    counts: RetentionCounts,
  ) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT n."id" FROM "Notification" n
      WHERE n."organizationId" = ${organizationId}::uuid
        AND n."createdAt" < now() - make_interval(months => ${months}::int)
        AND (n."readAt" IS NOT NULL OR n."archivedAt" IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM "NotificationDelivery" d
          WHERE d."notificationId" = n."id" AND d."status" IN ('PENDING', 'SENDING')
        )
        AND NOT EXISTS (
          SELECT 1 FROM "NotificationDelivery" d
          JOIN "NotificationDeliveryAttempt" t ON t."deliveryId" = d."id"
          WHERE d."notificationId" = n."id" AND t."status" = 'STARTED'
        )
      ORDER BY n."createdAt", n."id"
      LIMIT ${batchSize}
      FOR UPDATE OF n SKIP LOCKED`;
    if (rows.length === 0) return 0;
    const ids = Prisma.sql`${rows.map((r) => r.id)}::uuid[]`;
    counts.deliveryAttemptsDeleted += await tx.$executeRaw`
      DELETE FROM "NotificationDeliveryAttempt" t USING "NotificationDelivery" d
      WHERE t."deliveryId" = d."id" AND d."notificationId" = ANY(${ids})`;
    counts.deliveriesDeleted += await tx.$executeRaw`
      DELETE FROM "NotificationDelivery" WHERE "notificationId" = ANY(${ids})`;
    counts.notificationsDeleted += await tx.$executeRaw`
      DELETE FROM "Notification" WHERE "id" = ANY(${ids})`;
    return rows.length;
  }

  /** Finished email delivery attempts past the period (deliveries keep status and count). */
  private async purgeDeliveryAttempts(
    tx: Tx,
    organizationId: string,
    months: number,
    batchSize: number,
    counts: RetentionCounts,
  ) {
    const deleted = await tx.$executeRaw`
      DELETE FROM "NotificationDeliveryAttempt" WHERE "id" IN (
        SELECT "id" FROM "NotificationDeliveryAttempt"
        WHERE "organizationId" = ${organizationId}::uuid AND "status" <> 'STARTED'
          AND "startedAt" < now() - make_interval(months => ${months}::int)
        ORDER BY "startedAt", "id"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )`;
    counts.deliveryAttemptsDeleted += deleted;
    return deleted;
  }

  /** Finished Google synchronization runs past the period. */
  private async purgeSyncRuns(
    tx: Tx,
    organizationId: string,
    months: number,
    batchSize: number,
    counts: RetentionCounts,
  ) {
    const deleted = await tx.$executeRaw`
      DELETE FROM "GoogleSyncRun" WHERE "id" IN (
        SELECT "id" FROM "GoogleSyncRun"
        WHERE "organizationId" = ${organizationId}::uuid AND "status" <> 'RUNNING'
          AND "startedAt" < now() - make_interval(months => ${months}::int)
        ORDER BY "startedAt", "id"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )`;
    counts.syncRunsDeleted += deleted;
    return deleted;
  }

  /** Audit entries recorded for the organization (metadata.organizationId) past the period. */
  private async purgeAuditLog(
    tx: Tx,
    organizationId: string,
    months: number,
    batchSize: number,
    counts: RetentionCounts,
  ) {
    const deleted = await tx.$executeRaw`
      DELETE FROM "AuditLog" WHERE "id" IN (
        SELECT "id" FROM "AuditLog"
        WHERE "metadata" ? 'organizationId'
          AND ("metadata"->>'organizationId') = ${organizationId}::text
          AND "occurredAt" < now() - make_interval(months => ${months}::int)
        ORDER BY "occurredAt", "id"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )`;
    counts.auditEntriesDeleted += deleted;
    return deleted;
  }

  // ─── Audit ──────────────────────────────────────────────────────────────────

  /** One entry per organization and run that changed anything: periods and counts only. */
  private async record(result: RetentionOrganizationOutcome) {
    await this.audit.write({
      action: 'DATA_RETENTION_APPLIED',
      actorUserId: null,
      entityType: 'Organization',
      entityId: result.organizationId,
      metadata: jsonValue({
        organizationId: result.organizationId,
        periods: result.periods,
        counts: result.counts,
        incomplete: result.incomplete,
      }),
    });
  }
}
