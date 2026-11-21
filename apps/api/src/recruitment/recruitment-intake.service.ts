import {
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { advisoryLock, requireActor } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  Prisma,
  type RecruitmentIntakeProvider,
  type RecruitmentIntakeSource,
  type RecruitmentIntakeSubmission,
} from '../generated/prisma/client.js';
import { RecruitmentAccessService } from './recruitment-access.service.js';
import { RecruitmentApplicationService } from './recruitment-application.service.js';
import { RecruitmentCandidateService } from './recruitment-candidate.service.js';
import {
  conflict,
  isUniqueViolation,
  lockOpening,
  RecruitmentClock,
  recordActivity,
  writeRecruitmentAudit,
  type RecruitmentRequestContext,
  type Tx,
} from './recruitment-common.js';
import {
  invalid,
  normalizeSubmission,
  parseHttpsUrl,
  parseInstant,
  parseRecruitmentCode,
  parseText,
  submissionHash,
  type NormalizedSubmission,
} from './recruitment-domain.js';
import type {
  ApplicationIngestionOutcome,
  ApplicationIngestionOutcomeKind,
  ApplicationIngestionReport,
  ExternalApplicationSubmission,
  RecruitmentApplicationIngestion,
} from './recruitment-intake.contract.js';

export interface IntakeSourceInput {
  organizationId: string;
  code: string;
  name: string;
  provider: RecruitmentIntakeProvider;
  externalResourceId?: string | null;
  resourceUrl?: string | null;
  defaultOpeningId?: string | null;
}

const EMPTY_COUNTS = (): Record<ApplicationIngestionOutcomeKind, number> => ({
  CREATED: 0,
  ATTACHED: 0,
  UNCHANGED: 0,
  CORRECTED: 0,
  STALE: 0,
  PENDING_OPENING: 0,
  REJECTED: 0,
});

function sourceShape(source: RecruitmentIntakeSource) {
  return {
    id: source.id,
    organizationId: source.organizationId,
    code: source.code,
    name: source.name,
    provider: source.provider,
    externalResourceId: source.externalResourceId,
    resourceUrl: source.resourceUrl,
    defaultOpeningId: source.defaultOpeningId,
    lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
    lastSyncStatus: source.lastSyncStatus,
    lastSyncMessage: source.lastSyncMessage,
    archivedAt: source.archivedAt?.toISOString() ?? null,
  };
}

function submissionShape(row: RecruitmentIntakeSubmission) {
  return {
    id: row.id,
    sourceId: row.sourceId,
    externalResponseId: row.externalResponseId,
    status: row.status,
    reason: row.reason,
    submission: row.submission as unknown as NormalizedSubmission,
    submittedAt: row.submittedAt.toISOString(),
    correctionCount: row.correctionCount,
    candidateId: row.candidateId,
    applicationId: row.applicationId,
    receivedAt: row.receivedAt.toISOString(),
    lastReceivedAt: row.lastReceivedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * Phase 13 — external application intake: configured sources (e.g. the Google Form for staff
 * applications) and the provider-neutral ingestion contract (recruitment-intake.contract.ts).
 * recruitment.intake.manage at the organization configures sources, imports submissions and
 * works the unmatched opening queue. Submissions are deduplicated per source response,
 * serialized per response (advisory lock) and per candidate email.
 */
@Injectable()
export class RecruitmentIntakeService implements RecruitmentApplicationIngestion {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RecruitmentAccessService,
    private readonly audit: AuditService,
    private readonly clock: RecruitmentClock,
    private readonly candidates: RecruitmentCandidateService,
    private readonly applications: RecruitmentApplicationService,
  ) {}

  // ─── Sources ──────────────────────────────────────────────────────────────

  async sources(userId: string, organizationId: string) {
    await this.access.requireOrganization(
      userId,
      'recruitment.intake.manage',
      organizationId,
    );
    const rows = await this.prisma.recruitmentIntakeSource.findMany({
      where: { organizationId },
      include: {
        _count: {
          select: { submissions: { where: { status: 'PENDING_OPENING' } } },
        },
      },
      orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
    });
    return {
      items: rows.map((row) => ({
        ...sourceShape(row),
        pendingOpening: row._count.submissions,
      })),
    };
  }

  async createSource(
    input: IntakeSourceInput,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'recruitment.intake.manage',
      input.organizationId,
    );
    const code = parseRecruitmentCode(input.code);
    const externalResourceId = parseText(
      input.externalResourceId,
      'externalResourceId',
      { max: 500 },
    );
    if (input.provider !== 'MANUAL_IMPORT' && !externalResourceId) {
      invalid(
        'RECRUITMENT_SOURCE_RESOURCE_REQUIRED',
        "External sources need the provider's resource identifier (e.g. the Google Form id).",
      );
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const taken = await tx.recruitmentIntakeSource.findFirst({
          where: {
            organizationId: input.organizationId,
            OR: [
              { code },
              ...(externalResourceId
                ? [{ provider: input.provider, externalResourceId }]
                : []),
            ],
          },
          select: { id: true },
        });
        if (taken) {
          throw conflict(
            'RECRUITMENT_SOURCE_EXISTS',
            'The code or external resource is already a source of the organization.',
          );
        }
        const defaultOpeningId = await this.defaultOpening(
          tx,
          input.organizationId,
          input.defaultOpeningId,
        );
        const row = await tx.recruitmentIntakeSource.create({
          data: {
            organizationId: input.organizationId,
            code,
            name: parseText(input.name, 'name', { required: true, max: 200 })!,
            provider: input.provider,
            externalResourceId,
            resourceUrl: parseHttpsUrl(input.resourceUrl, 'resourceUrl'),
            defaultOpeningId,
            createdByUserId: actor,
          },
        });
        await writeRecruitmentAudit(this.audit, tx, {
          action: 'RECRUITMENT_INTAKE_SOURCE_CREATED',
          entityType: 'RecruitmentIntakeSource',
          entityId: row.id,
          context,
          metadata: {
            organizationId: row.organizationId,
            code,
            provider: row.provider,
          },
        });
        return sourceShape(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          'RECRUITMENT_SOURCE_EXISTS',
          'The code or external resource is already a source of the organization.',
        );
      }
      throw error;
    }
  }

  async updateSource(
    sourceId: string,
    input: Partial<
      Pick<IntakeSourceInput, 'name' | 'resourceUrl' | 'defaultOpeningId'>
    >,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const source = await this.sourceOrThrow(sourceId);
    await this.access.requireOrganizationRecord(
      actor,
      'recruitment.intake.manage',
      source.organizationId,
      'Intake source not found.',
    );
    if (source.archivedAt)
      throw conflict('RECRUITMENT_SOURCE_ARCHIVED', 'The source is archived.');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.recruitmentIntakeSource.update({
        where: { id: sourceId },
        data: {
          ...(input.name !== undefined
            ? {
                name: parseText(input.name, 'name', {
                  required: true,
                  max: 200,
                })!,
              }
            : {}),
          ...(input.resourceUrl !== undefined
            ? { resourceUrl: parseHttpsUrl(input.resourceUrl, 'resourceUrl') }
            : {}),
          ...(input.defaultOpeningId !== undefined
            ? {
                defaultOpeningId: await this.defaultOpening(
                  tx,
                  source.organizationId,
                  input.defaultOpeningId,
                ),
              }
            : {}),
        },
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_INTAKE_SOURCE_UPDATED',
        entityType: 'RecruitmentIntakeSource',
        entityId: sourceId,
        context,
        metadata: {
          organizationId: row.organizationId,
          fields: Object.keys(input).filter(
            (key) => input[key as keyof typeof input] !== undefined,
          ),
        },
      });
      return sourceShape(row);
    });
  }

  async archiveSource(sourceId: string, context: RecruitmentRequestContext) {
    const actor = requireActor(context);
    const source = await this.sourceOrThrow(sourceId);
    await this.access.requireOrganizationRecord(
      actor,
      'recruitment.intake.manage',
      source.organizationId,
      'Intake source not found.',
    );
    if (source.archivedAt) return sourceShape(source);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "RecruitmentIntakeSource" WHERE "id" = ${sourceId}::uuid FOR NO KEY UPDATE`,
      );
      const row = await tx.recruitmentIntakeSource.update({
        where: { id: sourceId },
        data: { archivedAt: this.clock.now() },
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_INTAKE_SOURCE_ARCHIVED',
        entityType: 'RecruitmentIntakeSource',
        entityId: sourceId,
        context,
        metadata: { organizationId: row.organizationId },
      });
      return sourceShape(row);
    });
  }

  // ─── Ingestion (the contract) ─────────────────────────────────────────────

  async ingest(
    sourceId: string,
    submissions: readonly ExternalApplicationSubmission[],
    channel: 'IMPORT' | 'SYNC',
    actorUserId: string | null,
  ): Promise<ApplicationIngestionReport> {
    const source = await this.sourceOrThrow(sourceId);
    if (channel === 'IMPORT') {
      if (!actorUserId) throw new ForbiddenException();
      await this.access.requireOrganizationRecord(
        actorUserId,
        'recruitment.intake.manage',
        source.organizationId,
        'Intake source not found.',
      );
    }
    // Phase 18: the ingestion contract (imports, sync jobs, Google Forms) refuses while
    // Recruitment is disabled or recruitment.externalIntake is turned off.
    await this.access.requireEnabled(source.organizationId);
    await this.access.features.requireSetting(
      source.organizationId,
      'recruitment.externalIntake',
    );
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ archivedAt: Date | null }>>(
          Prisma.sql`SELECT "archivedAt" FROM "RecruitmentIntakeSource" WHERE "id" = ${sourceId}::uuid FOR NO KEY UPDATE`,
        );
        if (locked[0]?.archivedAt)
          throw conflict(
            'RECRUITMENT_SOURCE_ARCHIVED',
            'The source is archived.',
          );
        const counts = EMPTY_COUNTS();
        const outcomes: ApplicationIngestionOutcome[] = [];
        for (const submission of submissions) {
          // Each submission runs in a savepoint: a rejected one never aborts the batch.
          await tx.$executeRawUnsafe('SAVEPOINT recruitment_intake_item');
          const outcome = await this.ingestOne(
            tx,
            source,
            submission,
            actorUserId,
          ).then(
            async (result) => {
              await tx.$executeRawUnsafe(
                'RELEASE SAVEPOINT recruitment_intake_item',
              );
              return result;
            },
            async (error: unknown) => {
              await tx.$executeRawUnsafe(
                'ROLLBACK TO SAVEPOINT recruitment_intake_item',
              );
              if (
                error instanceof HttpException &&
                [400, 409].includes(error.getStatus())
              ) {
                const body = error.getResponse() as { code?: string };
                return {
                  externalResponseId: String(
                    submission?.externalResponseId ?? '',
                  ),
                  outcome: 'REJECTED' as const,
                  reason: body.code ?? 'INVALID',
                };
              }
              throw error;
            },
          );
          counts[outcome.outcome] += 1;
          outcomes.push(outcome);
        }
        if (channel === 'SYNC') {
          await tx.recruitmentIntakeSource.update({
            where: { id: sourceId },
            data: {
              lastSyncedAt: this.clock.now(),
              lastSyncStatus: 'OK',
              lastSyncMessage: `${submissions.length} submission(s): ${counts.CREATED} new, ${counts.CORRECTED} corrected, ${counts.PENDING_OPENING} awaiting an opening.`,
            },
          });
        }
        await writeRecruitmentAudit(this.audit, tx, {
          action: 'RECRUITMENT_APPLICATIONS_INGESTED',
          entityType: 'RecruitmentIntakeSource',
          entityId: sourceId,
          context: { actorUserId: actorUserId ?? undefined },
          metadata: {
            organizationId: source.organizationId,
            channel,
            received: submissions.length,
            counts,
          },
        });
        return { sourceId, received: submissions.length, counts, outcomes };
      },
      { timeout: 60_000 },
    );
  }

  private async ingestOne(
    tx: Tx,
    source: RecruitmentIntakeSource,
    input: ExternalApplicationSubmission,
    actorUserId: string | null,
  ): Promise<ApplicationIngestionOutcome> {
    const externalResponseId = parseText(
      input?.externalResponseId,
      'externalResponseId',
      { required: true, max: 500 },
    )!;
    const submittedAt = parseInstant(input.submittedAt, 'submittedAt');
    if (!submittedAt)
      invalid('RECRUITMENT_DATE_INVALID', 'submittedAt is required.');
    const externalUpdatedAt = parseInstant(
      input.externalUpdatedAt,
      'externalUpdatedAt',
    );
    const normalized = normalizeSubmission(input);
    const hash = submissionHash(normalized, submittedAt);
    const base = { externalResponseId };
    await advisoryLock(
      tx,
      `recruitment-intake:${source.id}:${externalResponseId}`,
    );
    const existing = await tx.recruitmentIntakeSubmission.findUnique({
      where: {
        sourceId_externalResponseId: {
          sourceId: source.id,
          externalResponseId,
        },
      },
    });
    const now = this.clock.now();
    if (existing) {
      if (existing.contentHash === hash) {
        await tx.recruitmentIntakeSubmission.update({
          where: { id: existing.id },
          data: { lastReceivedAt: now },
        });
        return {
          ...base,
          outcome: 'UNCHANGED',
          submissionId: existing.id,
          applicationId: existing.applicationId ?? undefined,
        };
      }
      if (
        externalUpdatedAt &&
        existing.externalUpdatedAt &&
        externalUpdatedAt < existing.externalUpdatedAt
      ) {
        return {
          ...base,
          outcome: 'STALE',
          submissionId: existing.id,
          reason: 'OLDER_THAN_CURRENT',
        };
      }
      if (existing.status === 'REJECTED') {
        return {
          ...base,
          outcome: 'REJECTED',
          submissionId: existing.id,
          reason: 'PREVIOUSLY_REJECTED',
        };
      }
      const updated = await tx.recruitmentIntakeSubmission.update({
        where: { id: existing.id },
        data: {
          submission: normalized as unknown as Prisma.InputJsonValue,
          contentHash: hash,
          externalUpdatedAt,
          submittedAt,
          correctionCount: existing.correctionCount + 1,
          lastReceivedAt: now,
        },
      });
      if (
        existing.status === 'APPLIED' &&
        existing.applicationId &&
        existing.candidateId
      ) {
        await this.addMissingDocuments(
          tx,
          source.organizationId,
          existing.candidateId,
          existing.applicationId,
          normalized,
          actorUserId,
        );
        await recordActivity(tx, {
          organizationId: source.organizationId,
          candidateId: existing.candidateId,
          applicationId: existing.applicationId,
          type: 'APPLICATION_UPDATED_EXTERNALLY',
          summary: 'Application updated at the source',
          relatedId: existing.id,
          actorUserId,
        });
        return {
          ...base,
          outcome: 'CORRECTED',
          submissionId: existing.id,
          applicationId: existing.applicationId,
          candidateId: existing.candidateId,
        };
      }
      // Still waiting for an opening: a corrected opening code may resolve it now.
      const resolved = await this.tryApply(
        tx,
        source,
        updated,
        normalized,
        actorUserId,
        submittedAt,
      );
      return resolved.outcome === 'PENDING_OPENING'
        ? { ...resolved, outcome: 'CORRECTED' }
        : resolved;
    }
    const created = await tx.recruitmentIntakeSubmission.create({
      data: {
        organizationId: source.organizationId,
        sourceId: source.id,
        externalResponseId,
        status: 'PENDING_OPENING',
        submission: normalized as unknown as Prisma.InputJsonValue,
        contentHash: hash,
        submittedAt,
        externalUpdatedAt,
        reason: 'NEW',
      },
    });
    return this.tryApply(
      tx,
      source,
      created,
      normalized,
      actorUserId,
      submittedAt,
    );
  }

  /** Resolves the opening and applies, or leaves the submission in the opening queue. */
  private async tryApply(
    tx: Tx,
    source: RecruitmentIntakeSource,
    submission: RecruitmentIntakeSubmission,
    normalized: NormalizedSubmission,
    actorUserId: string | null,
    submittedAt: Date,
  ): Promise<ApplicationIngestionOutcome> {
    const base = {
      externalResponseId: submission.externalResponseId,
      submissionId: submission.id,
    };
    let openingId: string | null = null;
    let reason: string | null = null;
    if (normalized.openingCode) {
      const opening = await tx.jobOpening.findUnique({
        where: {
          organizationId_code: {
            organizationId: source.organizationId,
            code: normalized.openingCode,
          },
        },
        select: { id: true, status: true },
      });
      if (!opening) reason = 'OPENING_NOT_FOUND';
      else if (opening.status !== 'OPEN') reason = 'OPENING_NOT_OPEN';
      else openingId = opening.id;
    } else if (source.defaultOpeningId) {
      const opening = await tx.jobOpening.findUniqueOrThrow({
        where: { id: source.defaultOpeningId },
        select: { id: true, status: true },
      });
      if (opening.status !== 'OPEN') reason = 'OPENING_NOT_OPEN';
      else openingId = opening.id;
    } else {
      reason = 'NO_OPENING';
    }
    if (!openingId) {
      await tx.recruitmentIntakeSubmission.update({
        where: { id: submission.id },
        data: { status: 'PENDING_OPENING', reason },
      });
      return { ...base, outcome: 'PENDING_OPENING', reason: reason! };
    }
    return this.apply(
      tx,
      source.organizationId,
      submission,
      normalized,
      openingId,
      actorUserId,
      submittedAt,
    );
  }

  private async apply(
    tx: Tx,
    organizationId: string,
    submission: RecruitmentIntakeSubmission,
    normalized: NormalizedSubmission,
    openingId: string,
    actorUserId: string | null,
    submittedAt: Date,
  ): Promise<ApplicationIngestionOutcome> {
    const base = {
      externalResponseId: submission.externalResponseId,
      submissionId: submission.id,
    };
    await lockOpening(tx, openingId);
    const opening = await tx.jobOpening.findUniqueOrThrow({
      where: { id: openingId },
    });
    const { candidate } = await this.candidates.findOrCreate(
      tx,
      organizationId,
      {
        ...normalized.candidate,
        email: normalized.candidate.email,
        normalizedEmail: normalized.candidate.email,
        source: 'EXTERNAL_FORM',
      },
      actorUserId,
    );
    const live = await tx.recruitmentApplication.findFirst({
      where: {
        candidateId: candidate.id,
        openingId,
        status: { in: ['ACTIVE', 'OFFERED', 'HIRED'] },
      },
    });
    let applicationId: string;
    let outcome: ApplicationIngestionOutcome['outcome'] = 'CREATED';
    if (live) {
      applicationId = live.id;
      outcome = 'ATTACHED';
      await this.addMissingDocuments(
        tx,
        organizationId,
        candidate.id,
        live.id,
        normalized,
        actorUserId,
      );
      await recordActivity(tx, {
        organizationId,
        candidateId: candidate.id,
        applicationId: live.id,
        type: 'APPLICATION_UPDATED_EXTERNALLY',
        summary: 'Another submission received for this application',
        relatedId: submission.id,
        actorUserId,
      });
    } else {
      if (candidate.status !== 'ACTIVE') {
        invalid(
          'RECRUITMENT_CANDIDATE_NOT_ACTIVE',
          'The matching candidate is archived.',
        );
      }
      const application = await this.applications.createInTransaction(tx, {
        opening,
        candidate,
        source: 'EXTERNAL_FORM',
        sourceDetail: normalized.sourceDetail,
        appliedAt: submittedAt,
        recruiterUserId: opening.recruiterUserId,
        actorUserId,
        documents: normalized.documents,
      });
      applicationId = application.id;
    }
    await tx.recruitmentIntakeSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'APPLIED',
        reason: outcome === 'ATTACHED' ? 'EXISTING_APPLICATION' : null,
        candidateId: candidate.id,
        applicationId,
        resolvedAt: this.clock.now(),
        resolvedByUserId: actorUserId,
      },
    });
    return {
      ...base,
      outcome,
      applicationId,
      candidateId: candidate.id,
      ...(outcome === 'ATTACHED' ? { reason: 'EXISTING_APPLICATION' } : {}),
    };
  }

  private async addMissingDocuments(
    tx: Tx,
    organizationId: string,
    candidateId: string,
    applicationId: string,
    normalized: NormalizedSubmission,
    actorUserId: string | null,
  ) {
    if (normalized.documents.length === 0) return;
    const existing = await tx.recruitmentCandidateDocument.findMany({
      where: { candidateId, applicationId, removedAt: null },
      select: { externalUrl: true, externalFileId: true },
    });
    for (const document of normalized.documents) {
      const known = existing.some(
        (row) =>
          (document.externalUrl && row.externalUrl === document.externalUrl) ||
          (document.externalFileId &&
            row.externalFileId === document.externalFileId),
      );
      if (known) continue;
      await tx.recruitmentCandidateDocument.create({
        data: {
          organizationId,
          candidateId,
          applicationId,
          ...document,
          addedByUserId: actorUserId,
        },
      });
    }
  }

  // ─── The unmatched opening queue ──────────────────────────────────────────

  /**
   * The intake queue (PENDING_OPENING, oldest first) and its history (REJECTED / APPLIED, most
   * recently received first). Batch 7A: paged with `afterId` / `nextAfterId` and filterable by
   * source (an archived source's submissions stay listed).
   */
  async queue(
    userId: string,
    organizationId: string,
    status: 'PENDING_OPENING' | 'REJECTED' | 'APPLIED' = 'PENDING_OPENING',
    options: { sourceId?: string; limit?: number; afterId?: string } = {},
  ) {
    await this.access.requireOrganization(
      userId,
      'recruitment.intake.manage',
      organizationId,
    );
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const direction = status === 'PENDING_OPENING' ? 'asc' : 'desc';
    const where = {
      organizationId,
      status,
      ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    };
    if (options.afterId) {
      const anchor = await this.prisma.recruitmentIntakeSubmission.findFirst({
        where: { ...where, id: options.afterId },
        select: { id: true },
      });
      if (!anchor)
        invalid(
          'RECRUITMENT_CURSOR_INVALID',
          'The page cursor is not valid here.',
        );
    }
    const rows = await this.prisma.recruitmentIntakeSubmission.findMany({
      where,
      orderBy: [{ submittedAt: direction }, { id: direction }],
      take: limit + 1,
      ...(options.afterId ? { cursor: { id: options.afterId }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(submissionShape),
      nextAfterId: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  async assignOpening(
    submissionId: string,
    openingId: string,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const submission = await this.lockedSubmission(tx, actor, submissionId);
        const opening = await tx.jobOpening.findUnique({
          where: { id: openingId },
        });
        if (!opening || opening.organizationId !== submission.organizationId) {
          throw new NotFoundException('Job opening not found.');
        }
        if (opening.status !== 'OPEN') {
          throw conflict(
            'RECRUITMENT_OPENING_NOT_OPEN',
            'The opening is not open.',
          );
        }
        const result = await this.apply(
          tx,
          submission.organizationId,
          submission,
          submission.submission as unknown as NormalizedSubmission,
          openingId,
          actor,
          submission.submittedAt,
        );
        await writeRecruitmentAudit(this.audit, tx, {
          action: 'RECRUITMENT_INTAKE_OPENING_ASSIGNED',
          entityType: 'RecruitmentIntakeSubmission',
          entityId: submissionId,
          context,
          metadata: {
            organizationId: submission.organizationId,
            openingId,
            outcome: result.outcome,
          },
        });
        return result;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          'RECRUITMENT_APPLICATION_EXISTS',
          'The candidate already has a live application to this opening.',
        );
      }
      throw error;
    }
  }

  async rejectSubmission(
    submissionId: string,
    reason: string,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(reason, 'reason', { required: true, max: 1000 })!;
    return this.prisma.$transaction(async (tx) => {
      const submission = await this.lockedSubmission(tx, actor, submissionId);
      const row = await tx.recruitmentIntakeSubmission.update({
        where: { id: submissionId },
        data: {
          status: 'REJECTED',
          reason: note.slice(0, 200),
          resolvedAt: this.clock.now(),
          resolvedByUserId: actor,
        },
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_INTAKE_REJECTED',
        entityType: 'RecruitmentIntakeSubmission',
        entityId: submissionId,
        context,
        metadata: { organizationId: submission.organizationId },
      });
      return submissionShape(row);
    });
  }

  private async lockedSubmission(tx: Tx, actor: string, submissionId: string) {
    const found = await tx.recruitmentIntakeSubmission.findUnique({
      where: { id: submissionId },
    });
    if (!found) throw new NotFoundException('Submission not found.');
    await this.access.requireOrganizationRecord(
      actor,
      'recruitment.intake.manage',
      found.organizationId,
      'Submission not found.',
      tx,
    );
    await advisoryLock(
      tx,
      `recruitment-intake:${found.sourceId}:${found.externalResponseId}`,
    );
    const submission = await tx.recruitmentIntakeSubmission.findUniqueOrThrow({
      where: { id: submissionId },
    });
    if (submission.status !== 'PENDING_OPENING') {
      throw conflict(
        'RECRUITMENT_INTAKE_RESOLVED',
        'The submission was already resolved.',
      );
    }
    return submission;
  }

  private async defaultOpening(
    tx: Tx,
    organizationId: string,
    openingId: string | null | undefined,
  ) {
    if (!openingId) return null;
    const opening = await tx.jobOpening.findUnique({
      where: { id: openingId },
      select: { organizationId: true },
    });
    if (!opening || opening.organizationId !== organizationId) {
      invalid(
        'RECRUITMENT_OPENING_INVALID',
        'The default opening is not an opening of the organization.',
      );
    }
    return openingId;
  }

  private async sourceOrThrow(sourceId: string) {
    const source = await this.prisma.recruitmentIntakeSource.findUnique({
      where: { id: sourceId },
    });
    if (!source) throw new NotFoundException('Intake source not found.');
    return source;
  }
}
