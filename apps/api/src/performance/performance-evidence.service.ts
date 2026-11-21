import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  advisoryLock,
  domainError,
  formatDate,
  requireActor,
} from '../common/domain-support.js';
import { pageList, type ListPaging } from '../common/option-paging.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  Prisma,
  type PerformanceEvidence,
  type PerformanceEvidenceKind,
  type PerformanceEvidenceProvider,
  type PerformanceEvidenceSource,
} from '../generated/prisma/client.js';
import { PerformanceAccessService } from './performance-access.service.js';
import { displayName } from './performance-cycle.service.js';
import {
  isUniqueViolation,
  lockReview,
  PerformanceClock,
  shareCycle,
  writePerformanceAudit,
  type PerformanceClient,
  type PerformanceRequestContext,
} from './performance-common.js';
import {
  evidenceContentHash,
  normalizeEmail,
  normalizeScore,
  parsePerformanceCode,
  parseText,
} from './performance-domain.js';
import type {
  EvidenceIngestionOutcome,
  EvidenceIngestionOutcomeKind,
  EvidenceIngestionReport,
  ExternalAssessmentResult,
  PerformanceEvidenceIngestion,
} from './performance-evidence.contract.js';
import { WRITABLE } from './performance-review.service.js';

export interface SourceInput {
  organizationId: string;
  code: string;
  name: string;
  provider: PerformanceEvidenceProvider;
  kind: PerformanceEvidenceKind;
  externalResourceId?: string | null;
  resourceTitle?: string | null;
  resourceUrl?: string | null;
  passThresholdPercent?: string | null;
}

export interface ManualEvidenceInput {
  organizationId: string;
  employeeId: string;
  employmentAssignmentId?: string | null;
  provider: Exclude<PerformanceEvidenceProvider, 'GOOGLE_FORMS'>;
  kind: PerformanceEvidenceKind;
  title: string;
  completedAt: string;
  score?: string | null;
  maxScore?: string | null;
  passed?: boolean | null;
  passThresholdPercent?: string | null;
  resultUrl?: string | null;
  notes?: string | null;
}

const conflict = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new ConflictException(domainError(409, code, message, extra));
const invalid = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new BadRequestException(domainError(400, code, message, extra));

/** Batch 7B (D3): clock skew tolerated on a source's update time. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const EMPTY_COUNTS = (): Record<EvidenceIngestionOutcomeKind, number> => ({
  CREATED: 0,
  UNCHANGED: 0,
  CORRECTED: 0,
  WITHDRAWN: 0,
  STALE: 0,
  PENDING_MATCH: 0,
  REJECTED: 0,
});

/** Normalized fields kept with an unmatched result (never the raw payload). */
interface IntakeResult {
  title: string;
  completedAt: string;
  score: string | null;
  maxScore: string | null;
  passed: boolean | null;
  resultUrl: string | null;
  externalUpdatedAt: string | null;
  employmentAssignmentId: string | null;
  channel: 'IMPORT' | 'SYNC';
}

function instant(value: string | null | undefined, field: string): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalid(
      'PERFORMANCE_EVIDENCE_DATE_INVALID',
      `${field} must be an ISO-8601 instant.`,
    );
  }
  return date;
}

function url(value: string | null | undefined): string | null {
  const text = parseText(value, 'resultUrl', { max: 2000 });
  if (text && !/^https:\/\/\S+$/i.test(text)) {
    throw invalid(
      'PERFORMANCE_EVIDENCE_URL_INVALID',
      'Links must be https URLs.',
    );
  }
  return text;
}

function threshold(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value) || Number(value) > 100) {
    throw invalid(
      'PERFORMANCE_THRESHOLD_INVALID',
      'The pass threshold is a percentage from 0 to 100.',
    );
  }
  return new Prisma.Decimal(value).toFixed(2);
}

/** Phase 19: most intake rows one request returns. */
export const INTAKE_LIMIT = 500;

/**
 * Phase 12 Batch 12.6 — Performance Evidence: assessment results and other evidence about an
 * employee, recorded by HR or consumed from external sources (Google Forms quizzes and, later,
 * other providers) through the provider-neutral ingestion contract
 * (performance-evidence.contract.ts). Evidence is immutable and versioned (corrections are new
 * revisions), deduplicated per external result, scoped to its organization, linked into
 * reviews explicitly and never decides a rating or score.
 *
 * Access: performance.evidence.manage at the organization configures sources, imports,
 * records, corrects, re-maps and withdraws evidence and resolves unmatched results (never for
 * their own evidence); performance.read on the employee's assignment (or the employee
 * themselves) reads it; the reviewer (or HR) links it into a review being written.
 */
@Injectable()
export class PerformanceEvidenceService implements PerformanceEvidenceIngestion {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PerformanceAccessService,
    private readonly audit: AuditService,
    private readonly clock: PerformanceClock,
  ) {}

  // ─── Sources ──────────────────────────────────────────────────────────────

  async sources(
    userId: string,
    organizationId: string,
    includeArchived = false,
  ) {
    await this.access.requireOrganization(
      userId,
      'performance.evidence.manage',
      organizationId,
    );
    const rows = await this.prisma.performanceEvidenceSource.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: {
        _count: {
          select: {
            evidence: { where: { supersededAt: null } },
            intakes: { where: { status: 'PENDING_MATCH' } },
          },
        },
      },
      orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
    });
    return {
      items: rows.map((row) => ({
        ...sourceShape(row),
        evidenceCount: row._count.evidence,
        pendingMatches: row._count.intakes,
      })),
    };
  }

  async createSource(input: SourceInput, context: PerformanceRequestContext) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'performance.evidence.manage',
      input.organizationId,
    );
    const code = parsePerformanceCode(input.code);
    const externalResourceId = parseText(
      input.externalResourceId,
      'externalResourceId',
      { max: 500 },
    );
    if (input.provider !== 'MANUAL' && !externalResourceId) {
      throw invalid(
        'PERFORMANCE_SOURCE_RESOURCE_REQUIRED',
        "External sources need the provider's resource identifier (e.g. the Google Form id).",
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const taken = await tx.performanceEvidenceSource.findFirst({
        where: {
          organizationId: input.organizationId,
          OR: [
            { code },
            ...(externalResourceId
              ? [{ provider: input.provider, externalResourceId }]
              : []),
          ],
        },
        select: { code: true },
      });
      if (taken) {
        throw conflict(
          'PERFORMANCE_SOURCE_EXISTS',
          taken.code === code
            ? `A source with code ${code} already exists.`
            : 'This external resource is already a source of the organization.',
        );
      }
      const row = await tx.performanceEvidenceSource.create({
        data: {
          organizationId: input.organizationId,
          code,
          name: parseText(input.name, 'name', { required: true, max: 200 })!,
          provider: input.provider,
          kind: input.kind,
          externalResourceId,
          resourceTitle: parseText(input.resourceTitle, 'resourceTitle', {
            max: 500,
          }),
          resourceUrl: url(input.resourceUrl),
          passThresholdPercent: threshold(input.passThresholdPercent),
          createdByUserId: actor,
        },
      });
      await this.auditWrite(
        tx,
        'PERFORMANCE_EVIDENCE_SOURCE_CREATED',
        'PerformanceEvidenceSource',
        row.id,
        context,
        {
          organizationId: row.organizationId,
          code,
          provider: row.provider,
        },
      );
      return sourceShape(row);
    });
  }

  /**
   * Name, resource title/link and pass threshold. A new threshold applies to results imported
   * from now on; existing results keep the threshold they were judged by.
   */
  async updateSource(
    sourceId: string,
    input: Partial<
      Pick<
        SourceInput,
        'name' | 'resourceTitle' | 'resourceUrl' | 'passThresholdPercent'
      >
    >,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const source = await this.sourceOrThrow(sourceId);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.evidence.manage',
      source.organizationId,
      'Evidence source not found.',
    );
    if (source.archivedAt)
      throw conflict('PERFORMANCE_SOURCE_ARCHIVED', 'The source is archived.');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.performanceEvidenceSource.update({
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
          ...(input.resourceTitle !== undefined
            ? {
                resourceTitle: parseText(input.resourceTitle, 'resourceTitle', {
                  max: 500,
                }),
              }
            : {}),
          ...(input.resourceUrl !== undefined
            ? { resourceUrl: url(input.resourceUrl) }
            : {}),
          ...(input.passThresholdPercent !== undefined
            ? { passThresholdPercent: threshold(input.passThresholdPercent) }
            : {}),
        },
      });
      await this.auditWrite(
        tx,
        'PERFORMANCE_EVIDENCE_SOURCE_UPDATED',
        'PerformanceEvidenceSource',
        sourceId,
        context,
        {
          organizationId: row.organizationId,
          fields: Object.keys(input).filter(
            (key) => input[key as keyof typeof input] !== undefined,
          ),
        },
      );
      return sourceShape(row);
    });
  }

  async archiveSource(sourceId: string, context: PerformanceRequestContext) {
    const actor = requireActor(context);
    const source = await this.sourceOrThrow(sourceId);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.evidence.manage',
      source.organizationId,
      'Evidence source not found.',
    );
    if (source.archivedAt) return sourceShape(source);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "PerformanceEvidenceSource" WHERE "id" = ${sourceId}::uuid FOR NO KEY UPDATE`,
      );
      const row = await tx.performanceEvidenceSource.update({
        where: { id: sourceId },
        data: { archivedAt: this.clock.now() },
      });
      await this.auditWrite(
        tx,
        'PERFORMANCE_EVIDENCE_SOURCE_ARCHIVED',
        'PerformanceEvidenceSource',
        sourceId,
        context,
        {
          organizationId: row.organizationId,
        },
      );
      return sourceShape(row);
    });
  }

  // ─── Ingestion (the contract) ─────────────────────────────────────────────

  async ingest(
    sourceId: string,
    results: readonly ExternalAssessmentResult[],
    channel: 'IMPORT' | 'SYNC',
    actorUserId: string | null,
  ): Promise<EvidenceIngestionReport> {
    const source = await this.sourceOrThrow(sourceId);
    if (channel === 'IMPORT') {
      if (!actorUserId)
        throw new ForbiddenException(
          domainError(
            403,
            'PERFORMANCE_PERMISSION_REQUIRED',
            'Sign in to import results.',
          ),
        );
      await this.access.requireOrganizationRecord(
        actorUserId,
        'performance.evidence.manage',
        source.organizationId,
        'Evidence source not found.',
      );
    }
    // Phase 18: the ingestion contract (sync jobs, Google Forms) refuses while disabled.
    else await this.access.requireEnabled(source.organizationId);
    if (!source.externalResourceId) {
      throw conflict(
        'PERFORMANCE_SOURCE_NO_RESOURCE',
        'Only sources with an external resource receive external results.',
      );
    }
    return this.prisma.$transaction(
      async (tx) => {
        // Ingestions of one source run one at a time (they update its sync state); results
        // are further serialized per external result by the advisory lock (resolution, HR).
        const locked = await tx.$queryRaw<Array<{ archivedAt: Date | null }>>(
          Prisma.sql`SELECT "archivedAt" FROM "PerformanceEvidenceSource" WHERE "id" = ${sourceId}::uuid FOR NO KEY UPDATE`,
        );
        if (locked[0]?.archivedAt) {
          throw conflict(
            'PERFORMANCE_SOURCE_ARCHIVED',
            'The source is archived.',
          );
        }
        const counts = EMPTY_COUNTS();
        const outcomes: EvidenceIngestionOutcome[] = [];
        // Batch 7B (S3): an importer never records their own evidence.
        const actorEmployeeId =
          channel === 'IMPORT' && actorUserId
            ? await this.access.employeeIdOfUser(actorUserId, tx)
            : null;
        for (const result of results) {
          const outcome = await this.ingestOne(
            tx,
            source,
            result,
            channel,
            actorUserId,
            actorEmployeeId,
          ).catch((error: unknown) => {
            // Validation failures reject the one result (checked before any write).
            if (error instanceof HttpException && error.getStatus() === 400) {
              const body = error.getResponse() as { code?: string };
              return {
                externalResultId: String(result?.externalResultId ?? ''),
                outcome: 'REJECTED' as const,
                reason: body.code ?? 'INVALID',
              };
            }
            throw error;
          });
          counts[outcome.outcome] += 1;
          outcomes.push(outcome);
        }
        if (channel === 'SYNC') {
          await tx.performanceEvidenceSource.update({
            where: { id: sourceId },
            data: {
              lastSyncedAt: this.clock.now(),
              lastSyncStatus: 'OK',
              lastSyncMessage: `${results.length} result(s): ${counts.CREATED} new, ${counts.CORRECTED} corrected, ${counts.PENDING_MATCH} unmatched.`,
            },
          });
        }
        await writePerformanceAudit(this.audit, tx, {
          action: 'PERFORMANCE_EVIDENCE_INGESTED',
          entityType: 'PerformanceEvidenceSource',
          entityId: sourceId,
          context: { actorUserId: actorUserId ?? undefined },
          metadata: {
            organizationId: source.organizationId,
            channel,
            received: results.length,
            counts,
          },
        });
        return { sourceId, received: results.length, counts, outcomes };
      },
      { timeout: 60_000 },
    );
  }

  private async ingestOne(
    tx: Prisma.TransactionClient,
    source: PerformanceEvidenceSource,
    result: ExternalAssessmentResult,
    channel: 'IMPORT' | 'SYNC',
    actorUserId: string | null,
    actorEmployeeId: string | null = null,
  ): Promise<EvidenceIngestionOutcome> {
    // Validate everything first: a database error would abort the whole batch.
    const externalResultId = parseText(
      result.externalResultId,
      'externalResultId',
      {
        required: true,
        max: 500,
      },
    )!;
    const completedAt = instant(result.completedAt, 'completedAt');
    if (!completedAt) {
      throw invalid(
        'PERFORMANCE_EVIDENCE_DATE_INVALID',
        'completedAt is required.',
      );
    }
    const externalUpdatedAt = instant(
      result.externalUpdatedAt,
      'externalUpdatedAt',
    );
    // Batch 7B (D3): a source's update time in the future would make every later genuine
    // correction look stale (the result frozen); it is refused.
    if (
      externalUpdatedAt &&
      externalUpdatedAt.getTime() >
        this.clock.now().getTime() + FUTURE_TOLERANCE_MS
    ) {
      throw invalid(
        'PERFORMANCE_EVIDENCE_UPDATED_IN_FUTURE',
        'The result reports an update time in the future.',
      );
    }
    const givenTitle = parseText(result.title, 'title', { max: 500 });
    const resultUrl = url(result.resultUrl);
    const givenAssignment = result.employmentAssignmentId ?? null;
    // Raw (source-reported) score fields: what deduplication compares.
    const raw = normalizeScore(result, null);
    const resource = source.externalResourceId!;
    await advisoryLock(
      tx,
      `performance-evidence:${source.organizationId}:${source.provider}:${resource}:${externalResultId}`,
    );
    const current = await tx.performanceEvidence.findFirst({
      where: {
        organizationId: source.organizationId,
        provider: source.provider,
        externalResourceId: resource,
        externalResultId,
        supersededAt: null,
      },
    });
    // The title as completed: given by the source, else kept from the existing result (a later
    // rename of the form never retitles it), else the source's current title.
    const title =
      givenTitle ?? current?.title ?? source.resourceTitle ?? source.name;
    const hash = evidenceContentHash({
      title,
      completedAt,
      score: raw.score,
      maxScore: raw.maxScore,
      passed: result.passed ?? null,
      resultUrl,
      employmentAssignmentId: givenAssignment,
    });
    const base = { externalResultId };
    const selfRefused = {
      ...base,
      outcome: 'REJECTED' as const,
      reason: 'PERFORMANCE_SELF_EVIDENCE',
    };
    if (current) {
      if (channel === 'IMPORT') {
        // Batch 7B (S3/D3): imports never change one's own evidence, nor a result the source
        // synchronizes (it is corrected at the source, or through correct/remap/withdraw).
        if (actorEmployeeId && current.employeeId === actorEmployeeId)
          return selfRefused;
        if (current.channel === 'SYNC') {
          return {
            ...base,
            outcome: 'REJECTED',
            evidenceId: current.id,
            reason: 'PERFORMANCE_SYNCED_RESULT',
          };
        }
      }
      if (result.withdrawn) {
        if (current.status === 'WITHDRAWN')
          return { ...base, outcome: 'UNCHANGED', evidenceId: current.id };
        await tx.performanceEvidence.update({
          where: { id: current.id },
          data: {
            status: 'WITHDRAWN',
            withdrawnAt: this.clock.now(),
            withdrawalReason: 'Removed or invalidated at the source',
          },
        });
        return { ...base, outcome: 'WITHDRAWN', evidenceId: current.id };
      }
      if (
        externalUpdatedAt &&
        current.externalUpdatedAt &&
        externalUpdatedAt < current.externalUpdatedAt
      ) {
        return {
          ...base,
          outcome: 'STALE',
          evidenceId: current.id,
          reason: 'OLDER_THAN_CURRENT',
        };
      }
      // Same content: a duplicate delivery (an HR withdrawal stands until the source changes).
      if (current.contentHash === hash) {
        return { ...base, outcome: 'UNCHANGED', evidenceId: current.id };
      }
      // Batch 7B (D1): a synchronized change to an employee's result needs the respondent's
      // trusted identity, and it must be that employee — never a response whose form stopped
      // verifying emails, nor someone else's account. (Withdrawals and unchanged deliveries
      // above never alter the record's content; HR corrects through correct/remap otherwise.)
      if (channel === 'SYNC') {
        const identity = await this.matchEmployee(
          tx,
          source.organizationId,
          result,
        );
        if (
          identity.kind !== 'MATCHED' ||
          identity.employeeId !== current.employeeId
        ) {
          return {
            ...base,
            outcome: 'REJECTED',
            evidenceId: current.id,
            reason:
              identity.kind === 'UNMATCHED' &&
              identity.reason === 'NO_RESPONDENT_EMAIL'
                ? 'PERFORMANCE_IDENTITY_UNVERIFIED'
                : 'PERFORMANCE_IDENTITY_MISMATCH',
          };
        }
      }
      const assignment = givenAssignment
        ? await this.validAssignment(
            tx,
            current.employeeId,
            source.organizationId,
            givenAssignment,
          )
        : current.employmentAssignmentId;
      const revision = await this.supersede(tx, current, {
        title,
        completedAt,
        ...normalizeScore(
          result,
          current.passThresholdPercent?.toFixed(2) ?? null,
        ),
        passThresholdPercent: current.passThresholdPercent?.toFixed(2) ?? null,
        resultUrl,
        externalUpdatedAt,
        contentHash: hash,
        employmentAssignmentId: assignment,
        channel,
        recordedByUserId: actorUserId,
        correctionReason: 'Corrected at the source',
      });
      return { ...base, outcome: 'CORRECTED', evidenceId: revision.id };
    }
    const pending = await tx.performanceEvidenceIntake.findUnique({
      where: {
        sourceId_externalResultId: { sourceId: source.id, externalResultId },
      },
    });
    if (result.withdrawn) {
      if (pending?.status === 'PENDING_MATCH') {
        await tx.performanceEvidenceIntake.update({
          where: { id: pending.id },
          data: {
            status: 'REJECTED',
            resolvedAt: this.clock.now(),
            resolutionNote: 'Withdrawn at the source',
          },
        });
      }
      return { ...base, outcome: 'UNCHANGED', reason: 'NOTHING_TO_WITHDRAW' };
    }
    if (pending?.status === 'REJECTED') {
      return {
        ...base,
        outcome: 'REJECTED',
        intakeId: pending.id,
        reason: 'PREVIOUSLY_REJECTED',
      };
    }
    const intakeResult: IntakeResult = {
      title,
      completedAt: completedAt.toISOString(),
      score: raw.score,
      maxScore: raw.maxScore,
      passed: result.passed ?? null,
      resultUrl,
      externalUpdatedAt: externalUpdatedAt?.toISOString() ?? null,
      employmentAssignmentId: givenAssignment,
      channel,
    };
    const match = await this.matchEmployee(tx, source.organizationId, result);
    if (match.kind === 'REJECTED')
      return { ...base, outcome: 'REJECTED', reason: match.reason };
    if (
      match.kind === 'MATCHED' &&
      actorEmployeeId &&
      match.employeeId === actorEmployeeId
    )
      return selfRefused;
    if (match.kind === 'UNMATCHED') {
      const respondentEmail = normalizeEmail(result.respondentEmail);
      const respondentReference = parseText(
        result.respondentReference,
        'respondentReference',
        {
          max: 500,
        },
      );
      const intake = pending
        ? await tx.performanceEvidenceIntake.update({
            where: { id: pending.id },
            data: {
              result: intakeResult as unknown as Prisma.InputJsonValue,
              respondentEmail,
              respondentReference,
              reason: match.reason,
              lastReceivedAt: this.clock.now(),
            },
          })
        : await tx.performanceEvidenceIntake.create({
            data: {
              organizationId: source.organizationId,
              sourceId: source.id,
              externalResultId,
              respondentEmail,
              respondentReference,
              result: intakeResult as unknown as Prisma.InputJsonValue,
              reason: match.reason,
            },
          });
      return {
        ...base,
        outcome: 'PENDING_MATCH',
        intakeId: intake.id,
        reason: match.reason,
      };
    }
    const evidence = await this.createFromResult(
      tx,
      source,
      externalResultId,
      intakeResult,
      {
        employeeId: match.employeeId,
        hash,
        actorUserId,
      },
    );
    return { ...base, outcome: 'CREATED', evidenceId: evidence.id };
  }

  /** The employee a result belongs to, inside the source's organization. */
  private async matchEmployee(
    tx: Prisma.TransactionClient,
    organizationId: string,
    result: ExternalAssessmentResult,
  ): Promise<
    | { kind: 'MATCHED'; employeeId: string }
    | { kind: 'UNMATCHED'; reason: string }
    | { kind: 'REJECTED'; reason: string }
  > {
    if (result.employeeId) {
      return (await this.inOrganization(tx, result.employeeId, organizationId))
        ? { kind: 'MATCHED', employeeId: result.employeeId }
        : { kind: 'REJECTED', reason: 'EMPLOYEE_NOT_IN_ORGANIZATION' };
    }
    const email = normalizeEmail(result.respondentEmail);
    if (!email) return { kind: 'UNMATCHED', reason: 'NO_RESPONDENT_EMAIL' };
    const users = await tx.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: {
        person: {
          select: { employee: { select: { id: true, archivedAt: true } } },
        },
      },
      take: 2,
    });
    const employees = users
      .map((user) => user.person?.employee)
      .filter((employee): employee is { id: string; archivedAt: Date | null } =>
        Boolean(employee && !employee.archivedAt),
      );
    if (employees.length !== 1)
      return { kind: 'UNMATCHED', reason: 'NO_MATCHING_EMPLOYEE' };
    if (!(await this.inOrganization(tx, employees[0]!.id, organizationId))) {
      return { kind: 'UNMATCHED', reason: 'EMPLOYEE_NOT_IN_ORGANIZATION' };
    }
    return { kind: 'MATCHED', employeeId: employees[0]!.id };
  }

  private async inOrganization(
    client: PerformanceClient,
    employeeId: string,
    organizationId: string,
  ) {
    return (
      (await client.employmentAssignment.count({
        where: {
          employeeId,
          status: { not: 'CANCELLED' },
          position: { organizationId },
        },
      })) > 0
    );
  }

  /**
   * The assignment of a result: the given one (must be the employee's, in the organization),
   * else the employee's only assignment in the organization on the completion date, else none.
   */
  private async resolveAssignment(
    tx: Prisma.TransactionClient,
    employeeId: string,
    organizationId: string,
    given: string | null,
    completedAt: Date,
  ) {
    if (given)
      return this.validAssignment(tx, employeeId, organizationId, given);
    const day = new Date(`${formatDate(completedAt)}T00:00:00.000Z`);
    const rows = await tx.employmentAssignment.findMany({
      where: {
        employeeId,
        status: { not: 'CANCELLED' },
        position: { organizationId },
        startDate: { lte: day },
        OR: [{ endDate: null }, { endDate: { gte: day } }],
      },
      select: { id: true },
      take: 2,
    });
    return rows.length === 1 ? rows[0]!.id : null;
  }

  private async validAssignment(
    client: PerformanceClient,
    employeeId: string,
    organizationId: string,
    assignmentId: string,
  ) {
    const row = await client.employmentAssignment.findFirst({
      where: { id: assignmentId, employeeId, position: { organizationId } },
      select: { id: true },
    });
    if (!row) {
      throw invalid(
        'PERFORMANCE_EVIDENCE_ASSIGNMENT_INVALID',
        "The assignment is not the employee's in this organization.",
      );
    }
    return row.id;
  }

  private async createFromResult(
    tx: Prisma.TransactionClient,
    source: PerformanceEvidenceSource,
    externalResultId: string,
    result: IntakeResult,
    options: {
      employeeId: string;
      employmentAssignmentId?: string | null;
      hash: string;
      actorUserId: string | null;
    },
  ) {
    const completedAt = new Date(result.completedAt);
    const passThreshold = source.passThresholdPercent?.toFixed(2) ?? null;
    return tx.performanceEvidence.create({
      data: {
        organizationId: source.organizationId,
        employeeId: options.employeeId,
        employmentAssignmentId:
          options.employmentAssignmentId !== undefined
            ? options.employmentAssignmentId
            : await this.resolveAssignment(
                tx,
                options.employeeId,
                source.organizationId,
                result.employmentAssignmentId,
                completedAt,
              ),
        sourceId: source.id,
        provider: source.provider,
        kind: source.kind,
        channel: result.channel,
        title: result.title,
        externalResourceId: source.externalResourceId,
        externalResultId,
        completedAt,
        ...normalizeScore(result, passThreshold),
        passThresholdPercent: passThreshold,
        resultUrl: result.resultUrl,
        externalUpdatedAt: result.externalUpdatedAt
          ? new Date(result.externalUpdatedAt)
          : null,
        contentHash: options.hash,
        importedAt: this.clock.now(),
        recordedByUserId: options.actorUserId,
      },
    });
  }

  /** A new revision of the current one (same external identity), superseding it. */
  private async supersede(
    tx: Prisma.TransactionClient,
    current: PerformanceEvidence,
    changes: Partial<Prisma.PerformanceEvidenceUncheckedCreateInput> & {
      correctionReason: string;
    },
  ) {
    await tx.performanceEvidence.update({
      where: { id: current.id },
      data: { supersededAt: this.clock.now() },
    });
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      supersededAt: _s,
      ...kept
    } = current;
    return tx.performanceEvidence.create({
      data: {
        ...kept,
        status: 'ACTIVE',
        withdrawnAt: null,
        withdrawalReason: null,
        ...changes,
        revision: current.revision + 1,
        supersedesEvidenceId: current.id,
        importedAt: this.clock.now(),
      } as Prisma.PerformanceEvidenceUncheckedCreateInput,
    });
  }

  // ─── Unmatched results ────────────────────────────────────────────────────

  async intake(
    userId: string,
    organizationId: string,
    status: 'PENDING_MATCH' | 'MATCHED' | 'REJECTED' = 'PENDING_MATCH',
    /** Batch 7B: by source, and cursor paging (afterId / nextAfterId). */
    options: { sourceId?: string; limit?: number; afterId?: string } = {},
  ) {
    await this.access.requireOrganization(
      userId,
      'performance.evidence.manage',
      organizationId,
    );
    const limit = Math.min(
      Math.max(options.limit ?? INTAKE_LIMIT, 1),
      INTAKE_LIMIT,
    );
    const where = {
      organizationId,
      status,
      ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    };
    if (
      options.afterId &&
      !(await this.prisma.performanceEvidenceIntake.count({
        where: { ...where, id: options.afterId },
      }))
    ) {
      throw invalid(
        'PERFORMANCE_CURSOR_INVALID',
        'The page cursor is not valid here.',
      );
    }
    const rows = await this.prisma.performanceEvidenceIntake.findMany({
      where,
      include: {
        source: {
          select: { id: true, code: true, name: true, provider: true },
        },
      },
      // Oldest first (Phase 19 cap per page; `truncated` / `nextAfterId` tell the UI).
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(options.afterId ? { cursor: { id: options.afterId }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    return {
      truncated: rows.length > limit,
      nextAfterId: rows.length > limit ? page[page.length - 1]!.id : null,
      items: page.map((row) => ({
        id: row.id,
        source: row.source,
        externalResultId: row.externalResultId,
        respondentEmail: row.respondentEmail,
        respondentReference: row.respondentReference,
        result: row.result,
        status: row.status,
        reason: row.reason,
        evidenceId: row.evidenceId,
        receivedAt: row.receivedAt.toISOString(),
        lastReceivedAt: row.lastReceivedAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        resolutionNote: row.resolutionNote,
      })),
    };
  }

  /** HR matches an unmatched result to an employee (of the source's organization) or rejects it. */
  async resolveIntake(
    intakeId: string,
    input:
      | {
          action: 'MATCH';
          employeeId: string;
          employmentAssignmentId?: string | null;
          note?: string | null;
        }
      | { action: 'REJECT'; note: string },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const row = await this.prisma.performanceEvidenceIntake.findUnique({
      where: { id: intakeId },
      include: { source: true },
    });
    if (!row) throw new NotFoundException('Unmatched result not found.');
    await this.access.requireOrganizationRecord(
      actor,
      'performance.evidence.manage',
      row.organizationId,
      'Unmatched result not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await advisoryLock(
        tx,
        `performance-evidence:${row.organizationId}:${row.source.provider}:${row.source.externalResourceId}:${row.externalResultId}`,
      );
      const intake = await tx.performanceEvidenceIntake.findUniqueOrThrow({
        where: { id: intakeId },
      });
      if (intake.status !== 'PENDING_MATCH') {
        throw conflict(
          'PERFORMANCE_INTAKE_RESOLVED',
          'This result was already resolved.',
        );
      }
      const now = this.clock.now();
      if (input.action === 'REJECT') {
        const note = parseText(input.note, 'note', {
          required: true,
          max: 500,
        })!;
        await tx.performanceEvidenceIntake.update({
          where: { id: intakeId },
          data: {
            status: 'REJECTED',
            resolvedAt: now,
            resolvedByUserId: actor,
            resolutionNote: note,
          },
        });
        await this.auditWrite(
          tx,
          'PERFORMANCE_EVIDENCE_INTAKE_REJECTED',
          'PerformanceEvidenceIntake',
          intakeId,
          context,
          {
            organizationId: row.organizationId,
            sourceId: row.sourceId,
          },
        );
        return { status: 'REJECTED' as const, evidenceId: null };
      }
      if (
        (await this.access.employeeIdOfUser(actor, tx)) === input.employeeId
      ) {
        throw new ForbiddenException(
          domainError(
            403,
            'PERFORMANCE_SELF_MANAGEMENT',
            'You cannot record your own evidence.',
          ),
        );
      }
      if (
        !(await this.inOrganization(tx, input.employeeId, row.organizationId))
      ) {
        throw invalid(
          'PERFORMANCE_EVIDENCE_EMPLOYEE_INVALID',
          "The employee does not work in the result's organization.",
        );
      }
      const result = intake.result as unknown as IntakeResult;
      const assignment = input.employmentAssignmentId
        ? await this.validAssignment(
            tx,
            input.employeeId,
            row.organizationId,
            input.employmentAssignmentId,
          )
        : undefined;
      const evidence = await this.createFromResult(
        tx,
        row.source,
        row.externalResultId,
        result,
        {
          employeeId: input.employeeId,
          employmentAssignmentId: assignment,
          hash: evidenceContentHash({
            title: result.title,
            completedAt: new Date(result.completedAt),
            score: result.score,
            maxScore: result.maxScore,
            passed: result.passed,
            resultUrl: result.resultUrl,
            employmentAssignmentId: result.employmentAssignmentId,
          }),
          actorUserId: actor,
        },
      );
      await tx.performanceEvidenceIntake.update({
        where: { id: intakeId },
        data: {
          status: 'MATCHED',
          evidenceId: evidence.id,
          resolvedAt: now,
          resolvedByUserId: actor,
          resolutionNote: parseText(input.note, 'note', { max: 500 }),
        },
      });
      await this.auditWrite(
        tx,
        'PERFORMANCE_EVIDENCE_INTAKE_MATCHED',
        'PerformanceEvidenceIntake',
        intakeId,
        context,
        {
          organizationId: row.organizationId,
          sourceId: row.sourceId,
          evidenceId: evidence.id,
          employeeId: input.employeeId,
        },
      );
      return { status: 'MATCHED' as const, evidenceId: evidence.id };
    });
  }

  // ─── Manual evidence and corrections ──────────────────────────────────────

  async recordManual(
    input: ManualEvidenceInput,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'performance.evidence.manage',
      input.organizationId,
    );
    if ((input.provider as string) === 'GOOGLE_FORMS') {
      throw invalid(
        'PERFORMANCE_EVIDENCE_PROVIDER_INVALID',
        'External results arrive through their source.',
      );
    }
    if ((await this.access.employeeIdOfUser(actor)) === input.employeeId) {
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_SELF_MANAGEMENT',
          'You cannot record your own evidence.',
        ),
      );
    }
    const completedAt = instant(input.completedAt, 'completedAt');
    if (!completedAt)
      throw invalid(
        'PERFORMANCE_EVIDENCE_DATE_INVALID',
        'completedAt is required.',
      );
    const passThreshold = threshold(input.passThresholdPercent);
    const score = normalizeScore(input, passThreshold);
    return this.prisma.$transaction(async (tx) => {
      if (
        !(await this.inOrganization(tx, input.employeeId, input.organizationId))
      ) {
        throw invalid(
          'PERFORMANCE_EVIDENCE_EMPLOYEE_INVALID',
          'The employee does not work in this organization.',
        );
      }
      const assignment = input.employmentAssignmentId
        ? await this.validAssignment(
            tx,
            input.employeeId,
            input.organizationId,
            input.employmentAssignmentId,
          )
        : null;
      const row = await tx.performanceEvidence.create({
        data: {
          organizationId: input.organizationId,
          employeeId: input.employeeId,
          employmentAssignmentId: assignment,
          provider: input.provider,
          kind: input.kind,
          channel: 'MANUAL',
          title: parseText(input.title, 'title', { required: true, max: 500 })!,
          completedAt,
          ...score,
          passThresholdPercent: passThreshold,
          resultUrl: url(input.resultUrl),
          notes: parseText(input.notes, 'notes', { max: 4000 }),
          importedAt: this.clock.now(),
          recordedByUserId: actor,
        },
      });
      await this.auditWrite(
        tx,
        'PERFORMANCE_EVIDENCE_RECORDED',
        'PerformanceEvidence',
        row.id,
        context,
        {
          organizationId: row.organizationId,
          employeeId: row.employeeId,
          provider: row.provider,
          kind: row.kind,
        },
      );
      return this.evidenceShape(row, null, true);
    });
  }

  /** HR corrects manually recorded evidence: a new revision with a reason. */
  async correct(
    evidenceId: string,
    input: {
      title?: string;
      completedAt?: string;
      score?: string | null;
      maxScore?: string | null;
      passed?: boolean | null;
      notes?: string | null;
      employmentAssignmentId?: string | null;
      reason: string;
    },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const reason = parseText(input.reason, 'reason', {
      required: true,
      max: 500,
    })!;
    return this.changeCurrent(
      evidenceId,
      actor,
      context,
      async (tx, current) => {
        if (current.channel !== 'MANUAL') {
          throw conflict(
            'PERFORMANCE_EVIDENCE_EXTERNAL',
            'External results are corrected at their source (or withdrawn / re-matched here).',
          );
        }
        const completedAt = input.completedAt
          ? instant(input.completedAt, 'completedAt')!
          : current.completedAt;
        const score = normalizeScore(
          {
            score:
              input.score !== undefined
                ? input.score
                : (current.score?.toFixed(2) ?? null),
            maxScore:
              input.maxScore !== undefined
                ? input.maxScore
                : (current.maxScore?.toFixed(2) ?? null),
            passed: input.passed !== undefined ? input.passed : null,
          },
          current.passThresholdPercent?.toFixed(2) ?? null,
        );
        const assignment =
          input.employmentAssignmentId !== undefined
            ? input.employmentAssignmentId
              ? await this.validAssignment(
                  tx,
                  current.employeeId,
                  current.organizationId,
                  input.employmentAssignmentId,
                )
              : null
            : current.employmentAssignmentId;
        const revision = await this.supersede(tx, current, {
          title:
            input.title !== undefined
              ? parseText(input.title, 'title', { required: true, max: 500 })!
              : current.title,
          completedAt,
          ...score,
          notes:
            input.notes !== undefined
              ? parseText(input.notes, 'notes', { max: 4000 })
              : current.notes,
          employmentAssignmentId: assignment,
          recordedByUserId: actor,
          correctionReason: reason,
        });
        return { revision, action: 'PERFORMANCE_EVIDENCE_CORRECTED' };
      },
    );
  }

  /** Moves a result matched to the wrong employee (or assignment) — a new revision. */
  async remap(
    evidenceId: string,
    input: {
      employeeId: string;
      employmentAssignmentId?: string | null;
      reason: string;
    },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const reason = parseText(input.reason, 'reason', {
      required: true,
      max: 500,
    })!;
    return this.changeCurrent(
      evidenceId,
      actor,
      context,
      async (tx, current) => {
        if (
          (await this.access.employeeIdOfUser(actor, tx)) === input.employeeId
        ) {
          throw new ForbiddenException(
            domainError(
              403,
              'PERFORMANCE_SELF_MANAGEMENT',
              'You cannot record your own evidence.',
            ),
          );
        }
        if (
          !(await this.inOrganization(
            tx,
            input.employeeId,
            current.organizationId,
          ))
        ) {
          throw invalid(
            'PERFORMANCE_EVIDENCE_EMPLOYEE_INVALID',
            "The employee does not work in the evidence's organization.",
          );
        }
        const assignment = input.employmentAssignmentId
          ? await this.validAssignment(
              tx,
              input.employeeId,
              current.organizationId,
              input.employmentAssignmentId,
            )
          : input.employeeId === current.employeeId
            ? null
            : await this.resolveAssignment(
                tx,
                input.employeeId,
                current.organizationId,
                null,
                current.completedAt,
              );
        const revision = await this.supersede(tx, current, {
          employeeId: input.employeeId,
          employmentAssignmentId: assignment,
          recordedByUserId: actor,
          correctionReason: reason,
        });
        return { revision, action: 'PERFORMANCE_EVIDENCE_REMAPPED' };
      },
    );
  }

  async withdraw(
    evidenceId: string,
    input: { reason: string },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const reason = parseText(input.reason, 'reason', {
      required: true,
      max: 500,
    })!;
    return this.changeCurrent(
      evidenceId,
      actor,
      context,
      async (tx, current) => {
        if (current.status === 'WITHDRAWN') {
          throw conflict(
            'PERFORMANCE_EVIDENCE_WITHDRAWN',
            'The evidence is already withdrawn.',
          );
        }
        const revision = await tx.performanceEvidence.update({
          where: { id: current.id },
          data: {
            status: 'WITHDRAWN',
            withdrawnAt: this.clock.now(),
            withdrawalReason: reason,
          },
        });
        return { revision, action: 'PERFORMANCE_EVIDENCE_WITHDRAWN' };
      },
    );
  }

  private async changeCurrent(
    evidenceId: string,
    actor: string,
    context: PerformanceRequestContext,
    change: (
      tx: Prisma.TransactionClient,
      current: PerformanceEvidence,
    ) => Promise<{ revision: PerformanceEvidence; action: string }>,
  ) {
    const existing = await this.prisma.performanceEvidence.findUnique({
      where: { id: evidenceId },
    });
    if (!existing) throw new NotFoundException('Evidence not found.');
    await this.access.requireOrganizationRecord(
      actor,
      'performance.evidence.manage',
      existing.organizationId,
      'Evidence not found.',
    );
    if ((await this.access.employeeIdOfUser(actor)) === existing.employeeId) {
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_SELF_MANAGEMENT',
          'You cannot change your own evidence.',
        ),
      );
    }
    return this.prisma.$transaction(async (tx) => {
      if (existing.externalResultId) {
        await advisoryLock(
          tx,
          `performance-evidence:${existing.organizationId}:${existing.provider}:${existing.externalResourceId}:${existing.externalResultId}`,
        );
      } else {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "PerformanceEvidence" WHERE "id" = ${evidenceId}::uuid FOR NO KEY UPDATE`,
        );
      }
      const current = await tx.performanceEvidence.findUniqueOrThrow({
        where: { id: evidenceId },
      });
      if (current.supersededAt) {
        throw conflict(
          'PERFORMANCE_EVIDENCE_SUPERSEDED',
          'Change the current revision of the evidence.',
        );
      }
      const { revision, action } = await change(tx, current);
      await this.auditWrite(
        tx,
        action,
        'PerformanceEvidence',
        revision.id,
        context,
        {
          organizationId: revision.organizationId,
          previousRevisionId: revision.id === current.id ? null : current.id,
          employeeId: revision.employeeId,
          previousEmployeeId:
            current.employeeId === revision.employeeId
              ? undefined
              : current.employeeId,
        },
      );
      return this.evidenceShape(revision, null, true);
    });
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  async mine(
    userId: string,
    status?: PerformanceEvidence['status'],
    paging: ListPaging = {},
  ) {
    const employeeId = await this.access.requireEmployee(userId);
    const rows = await this.prisma.performanceEvidence.findMany({
      where: {
        employeeId,
        supersededAt: null,
        ...(status ? { status } : {}),
        organizationId: { notIn: await this.access.disabledOrganizations() },
      },
      include: EVIDENCE_INCLUDE,
      orderBy: [{ completedAt: 'desc' }, { id: 'asc' }],
    });
    const page = pageList(rows, paging.limit, paging.afterId);
    return {
      total: page.total,
      nextAfterId: page.nextAfterId,
      items: page.items.map((row) => this.evidenceShape(row, row, false)),
    };
  }

  /**
   * An employee's current evidence in the organizations where the user reads their
   * performance (performance.read/manage on one of their assignments there) or manages
   * evidence. Every revision is kept; reads show the current one with its revision number.
   */
  async forEmployee(
    userId: string,
    employeeId: string,
    /** Batch 7B: by status (ACTIVE / WITHDRAWN). */
    status?: PerformanceEvidence['status'],
    /** Batch 7B: cursor paging by the last evidence id of the previous page. */
    paging: ListPaging = {},
  ) {
    const employee = await this.access.employeeAccess(userId, employeeId);
    if (employee.isSelf) return this.mine(userId, status, paging);
    const organizations = new Set<string>();
    for (const row of employee.assignments) {
      const organizationId = row.assignment.position.organizationId;
      if (
        row.canRead ||
        this.access.canInOrganization(
          employee.grants,
          'performance.evidence.manage',
          organizationId,
        )
      ) {
        organizations.add(organizationId);
      }
    }
    // The active reviewer reads the evidence of the organization they review the employee in.
    for (const row of await this.access.reviewingAssignments(
      userId,
      employeeId,
    )) {
      organizations.add(row.organizationId);
    }
    if (organizations.size === 0) {
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Missing permission performance.read for the employee.',
        ),
      );
    }
    const rows = await this.prisma.performanceEvidence.findMany({
      where: {
        employeeId,
        supersededAt: null,
        organizationId: { in: [...organizations] },
        ...(status ? { status } : {}),
      },
      include: EVIDENCE_INCLUDE,
      orderBy: [{ completedAt: 'desc' }, { id: 'asc' }],
    });
    const page = pageList(rows, paging.limit, paging.afterId);
    return {
      total: page.total,
      nextAfterId: page.nextAfterId,
      items: page.items.map((row) => ({
        // Batch 7B (D2): confidential HR notes for evidence managers and HR only.
        ...this.evidenceShape(
          row,
          row,
          this.notesVisible(employee, row.organizationId),
        ),
        actions: {
          canManage: this.access.canInOrganization(
            employee.grants,
            'performance.evidence.manage',
            row.organizationId,
          ),
        },
      })),
    };
  }

  /**
   * Batch 7B (D2): confidential HR evidence notes are for evidence managers of the
   * organization and HR (performance.manage over one of the employee's assignments there) —
   * never the employee, read-only viewers or reviewers as such.
   */
  private notesVisible(
    employee: Awaited<ReturnType<PerformanceAccessService['employeeAccess']>>,
    organizationId: string,
  ) {
    if (employee.isSelf) return false;
    return (
      this.access.canInOrganization(
        employee.grants,
        'performance.evidence.manage',
        organizationId,
      ) ||
      employee.assignments.some(
        (row) =>
          row.canManage &&
          row.assignment.position.organizationId === organizationId,
      )
    );
  }

  /** Every revision of a piece of evidence (oldest first), for authorized readers. */
  async history(userId: string, evidenceId: string) {
    const row = await this.prisma.performanceEvidence.findUnique({
      where: { id: evidenceId },
    });
    if (!row) throw new NotFoundException('Evidence not found.');
    // Phase 19: authorization first. forEmployee reports FEATURE_DISABLED only to a caller who
    // could otherwise read the employee; anyone else gets the same 404 as for a missing id.
    const readable = await this.forEmployee(userId, row.employeeId).catch(
      (error: unknown) => {
        if (isFeatureDisabled(error)) throw error;
        return null;
      },
    );
    if (
      !readable?.items.some(
        (item) => item.organizationId === row.organizationId,
      )
    ) {
      // One's own evidence in an organization where Performance is disabled.
      if ((await this.access.employeeIdOfUser(userId)) === row.employeeId)
        await this.access.requireEnabled(row.organizationId);
      throw new NotFoundException('Evidence not found.');
    }
    await this.access.requireEnabled(row.organizationId);
    const chain: PerformanceEvidence[] = [];
    let cursor: PerformanceEvidence | null = row;
    // Walk back to the first revision, then forward to the latest.
    while (cursor?.supersedesEvidenceId) {
      cursor = await this.prisma.performanceEvidence.findUnique({
        where: { id: cursor.supersedesEvidenceId },
      });
    }
    while (cursor) {
      chain.push(cursor);
      cursor = await this.prisma.performanceEvidence.findFirst({
        where: { supersedesEvidenceId: cursor.id },
      });
    }
    // Batch 7B (S2/D2): the employee and read-only viewers never receive HR notes.
    const showNotes = this.notesVisible(
      await this.access.employeeAccess(userId, row.employeeId),
      row.organizationId,
    );
    // Batch 7B: who recorded each revision (by name) and whose evidence it was.
    const people = await this.prisma.user.findMany({
      where: {
        id: {
          in: [
            ...new Set(chain.map((r) => r.recordedByUserId).filter(Boolean)),
          ] as string[],
        },
      },
      select: {
        id: true,
        person: {
          select: { firstName: true, lastName: true, preferredName: true },
        },
      },
    });
    const recorder = new Map(
      people.map((u) => [
        u.id,
        (u.person && displayName(u.person)) || 'Unnamed',
      ]),
    );
    return {
      items: chain.map((revision) => ({
        ...this.evidenceShape(revision, null, showNotes),
        recordedBy: revision.recordedByUserId
          ? {
              userId: revision.recordedByUserId,
              displayName: recorder.get(revision.recordedByUserId) ?? 'Unnamed',
            }
          : null,
        correctionReason: revision.correctionReason,
        supersededAt: revision.supersededAt?.toISOString() ?? null,
      })),
    };
  }

  // ─── Review links ─────────────────────────────────────────────────────────

  /**
   * Links current, active evidence of the reviewed employee (of the review's organization and,
   * when it names one, its assignment) into a review being written — by the reviewer or HR.
   */
  async link(
    reviewId: string,
    input: { evidenceId: string; formItemId?: string | null },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const review = await this.lockWritableReview(tx, reviewId, actor);
      const evidence = await tx.performanceEvidence.findUnique({
        where: { id: input.evidenceId },
      });
      if (
        !evidence ||
        evidence.employeeId !== review.employeeId ||
        evidence.organizationId !== review.organizationId
      ) {
        throw new NotFoundException('Evidence not found.');
      }
      if (evidence.supersededAt || evidence.status !== 'ACTIVE') {
        throw conflict(
          'PERFORMANCE_EVIDENCE_NOT_CURRENT',
          'Link the current, active revision.',
        );
      }
      if (
        evidence.employmentAssignmentId &&
        evidence.employmentAssignmentId !== review.employmentAssignmentId
      ) {
        throw invalid(
          'PERFORMANCE_EVIDENCE_OTHER_ASSIGNMENT',
          'The evidence concerns another assignment of the employee.',
        );
      }
      if (input.formItemId) {
        const item = await tx.performanceFormItem.findFirst({
          where: { id: input.formItemId, cycleId: review.cycleId },
          select: { itemType: true },
        });
        if (!item || item.itemType !== 'EVIDENCE_REFERENCE') {
          throw invalid(
            'PERFORMANCE_ITEM_NOT_EVIDENCE',
            'Evidence links only to evidence items of the form.',
          );
        }
      }
      const active = await tx.performanceReviewEvidence.findFirst({
        where: { reviewId, evidenceId: evidence.id, unlinkedAt: null },
      });
      if (active) return { linkId: active.id };
      const link = await tx.performanceReviewEvidence
        .create({
          data: {
            reviewId,
            evidenceId: evidence.id,
            employeeId: review.employeeId,
            cycleId: review.cycleId,
            formItemId: input.formItemId ?? null,
            linkedByUserId: actor,
          },
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error))
            throw conflict('PERFORMANCE_EVIDENCE_LINKED', 'Already linked.');
          throw error;
        });
      await writePerformanceAudit(this.audit, tx, {
        action: 'PERFORMANCE_EVIDENCE_LINKED',
        entityType: 'PerformanceReview',
        entityId: reviewId,
        context,
        metadata: {
          organizationId: review.organizationId,
          evidenceId: evidence.id,
          linkId: link.id,
        },
      });
      return { linkId: link.id };
    });
  }

  async unlink(
    reviewId: string,
    linkId: string,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const review = await this.lockWritableReview(tx, reviewId, actor);
      const link = await tx.performanceReviewEvidence.findFirst({
        where: { id: linkId, reviewId },
      });
      if (!link) throw new NotFoundException('Evidence link not found.');
      if (!link.unlinkedAt) {
        await tx.performanceReviewEvidence.update({
          where: { id: linkId },
          data: { unlinkedAt: this.clock.now(), unlinkedByUserId: actor },
        });
        await writePerformanceAudit(this.audit, tx, {
          action: 'PERFORMANCE_EVIDENCE_UNLINKED',
          entityType: 'PerformanceReview',
          entityId: reviewId,
          context,
          metadata: {
            organizationId: review.organizationId,
            evidenceId: link.evidenceId,
            linkId,
          },
        });
      }
      return { unlinked: true };
    });
  }

  private async lockWritableReview(
    tx: Prisma.TransactionClient,
    reviewId: string,
    actor: string,
  ) {
    const row = await tx.performanceReview.findUnique({
      where: { id: reviewId },
    });
    if (!row) throw new NotFoundException('Review not found.');
    await shareCycle(tx, row.cycleId);
    await lockReview(tx, reviewId);
    const review = await tx.performanceReview.findUniqueOrThrow({
      where: { id: reviewId },
      include: { cycle: { select: { status: true } } },
    });
    const access = await this.access.reviewAccess(actor, review, tx);
    if (!(access.isReviewer || access.canManage)) {
      if (!access.isSelf && !access.canRead)
        await this.access.notFoundOutside(
          actor,
          access.target.organizationId,
          'Review not found.',
          tx,
        );
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Only the reviewer (or HR) links evidence to the review.',
        ),
      );
    }
    if (!WRITABLE.includes(review.status) || review.cycle.status !== 'OPEN') {
      throw conflict(
        'PERFORMANCE_REVIEW_FINAL',
        "A finalized review's links are locked.",
      );
    }
    return review;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async sourceOrThrow(sourceId: string) {
    const row = await this.prisma.performanceEvidenceSource.findUnique({
      where: { id: sourceId },
    });
    if (!row) throw new NotFoundException('Evidence source not found.');
    return row;
  }

  /** Readers other than HR never see HR notes; nobody sees source configuration here. */
  evidenceShape(
    row: PerformanceEvidence,
    included: {
      source?: {
        name: string;
        lastSyncedAt: Date | null;
        lastSyncStatus: string | null;
      } | null;
      employmentAssignment?: { position: { name: string } } | null;
      employee?: {
        employeeNumber: string;
        person: Parameters<typeof displayName>[0];
      } | null;
    } | null,
    showNotes: boolean,
  ) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      employeeId: row.employeeId,
      employee: included?.employee
        ? {
            id: row.employeeId,
            employeeNumber: included.employee.employeeNumber,
            displayName: displayName(included.employee.person) || 'Unnamed',
          }
        : null,
      employmentAssignment: row.employmentAssignmentId
        ? {
            id: row.employmentAssignmentId,
            positionName: included?.employmentAssignment?.position.name ?? null,
          }
        : null,
      provider: row.provider,
      kind: row.kind,
      channel: row.channel,
      title: row.title,
      sourceId: row.sourceId,
      sourceName: included?.source?.name ?? null,
      completedAt: row.completedAt.toISOString(),
      score: row.score?.toFixed(2) ?? null,
      maxScore: row.maxScore?.toFixed(2) ?? null,
      percentage: row.percentage?.toFixed(2) ?? null,
      passed: row.passed,
      passThresholdPercent: row.passThresholdPercent?.toFixed(2) ?? null,
      resultUrl: row.resultUrl,
      status: row.status,
      withdrawalReason: row.withdrawalReason,
      revision: row.revision,
      importedAt: row.importedAt.toISOString(),
      sync: included?.source
        ? {
            lastSyncedAt: included.source.lastSyncedAt?.toISOString() ?? null,
            lastSyncStatus: included.source.lastSyncStatus,
          }
        : null,
      ...(showNotes ? { notes: row.notes } : {}),
    };
  }

  private auditWrite(
    tx: Prisma.TransactionClient,
    action: string,
    entityType: string,
    entityId: string,
    context: PerformanceRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return writePerformanceAudit(this.audit, tx, {
      action,
      entityType,
      entityId,
      context,
      metadata,
    });
  }
}

const EVIDENCE_INCLUDE = {
  source: { select: { name: true, lastSyncedAt: true, lastSyncStatus: true } },
  employmentAssignment: { select: { position: { select: { name: true } } } },
  // Batch 7B: the employee by name and number (lists, history, intake resolution).
  employee: {
    select: {
      employeeNumber: true,
      person: {
        select: { firstName: true, lastName: true, preferredName: true },
      },
    },
  },
} as const;

export function sourceShape(row: PerformanceEvidenceSource) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    code: row.code,
    name: row.name,
    provider: row.provider,
    kind: row.kind,
    externalResourceId: row.externalResourceId,
    resourceTitle: row.resourceTitle,
    resourceUrl: row.resourceUrl,
    passThresholdPercent: row.passThresholdPercent?.toFixed(2) ?? null,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncMessage: row.lastSyncMessage,
    archived: row.archivedAt !== null,
  };
}

function isFeatureDisabled(error: unknown) {
  if (!(error instanceof ForbiddenException)) return false;
  const body = error.getResponse();
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { code?: unknown }).code === 'FEATURE_DISABLED'
  );
}
