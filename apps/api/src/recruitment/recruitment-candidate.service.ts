import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  advisoryLock,
  domainError,
  requireActor,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  Prisma,
  RecruitmentCandidate,
  RecruitmentCandidateDocument,
  RecruitmentSource,
} from '../generated/prisma/client.js';
import { RecruitmentAccessService } from './recruitment-access.service.js';
import {
  candidateDisplayName,
  conflict,
  isUniqueViolation,
  lockCandidate,
  personDisplayName,
  RecruitmentClock,
  recordActivity,
  writeRecruitmentAudit,
  type RecruitmentClient,
  type RecruitmentRequestContext,
  type Tx,
} from './recruitment-common.js';
import {
  invalid,
  LIVE_APPLICATION,
  normalizeCandidateEmail,
  parseDocumentReference,
  parseText,
  type DocumentReferenceInput,
} from './recruitment-domain.js';

export interface CandidateDetailsInput {
  firstName: string;
  lastName: string;
  preferredName?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  source?: RecruitmentSource;
  notes?: string | null;
}

export function parseCandidateDetails(
  input: Partial<CandidateDetailsInput>,
  partial = false,
) {
  const out: Record<string, unknown> = {};
  if (!partial || input.firstName !== undefined)
    out.firstName = parseText(input.firstName, 'firstName', {
      required: true,
      max: 120,
    });
  if (!partial || input.lastName !== undefined)
    out.lastName = parseText(input.lastName, 'lastName', {
      required: true,
      max: 120,
    });
  if (input.preferredName !== undefined)
    out.preferredName = parseText(input.preferredName, 'preferredName', {
      max: 120,
    });
  if (input.email !== undefined) {
    const normalized = normalizeCandidateEmail(input.email);
    out.email = normalized ? input.email!.trim() : null;
    out.normalizedEmail = normalized;
  }
  if (input.phone !== undefined)
    out.phone = parseText(input.phone, 'phone', { max: 50 });
  if (input.location !== undefined)
    out.location = parseText(input.location, 'location', { max: 200 });
  if (input.notes !== undefined) out.notes = parseText(input.notes, 'notes');
  if (input.source !== undefined) out.source = input.source;
  return out as {
    firstName?: string;
    lastName?: string;
    preferredName?: string | null;
    email?: string | null;
    normalizedEmail?: string | null;
    phone?: string | null;
    location?: string | null;
    notes?: string | null;
    source?: RecruitmentSource;
  };
}

export function documentShape(document: RecruitmentCandidateDocument) {
  return {
    id: document.id,
    candidateId: document.candidateId,
    applicationId: document.applicationId,
    kind: document.kind,
    title: document.title,
    provider: document.provider,
    externalUrl: document.externalUrl,
    externalFileId: document.externalFileId,
    fileName: document.fileName,
    mimeType: document.mimeType,
    addedAt: document.addedAt.toISOString(),
    removedAt: document.removedAt?.toISOString() ?? null,
  };
}

const CANDIDATE_INCLUDE = {
  internalEmployee: {
    select: {
      id: true,
      employeeNumber: true,
      person: {
        select: { firstName: true, lastName: true, preferredName: true },
      },
    },
  },
} as const;

type CandidateRow = Prisma.RecruitmentCandidateGetPayload<{
  include: typeof CANDIDATE_INCLUDE;
}>;

export function candidateShape(
  row: CandidateRow | RecruitmentCandidate,
  full: boolean,
) {
  const internal = 'internalEmployee' in row ? row.internalEmployee : null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    displayName: candidateDisplayName(row),
    firstName: row.firstName,
    lastName: row.lastName,
    preferredName: row.preferredName,
    status: row.status,
    source: row.source,
    internal: row.internalEmployeeId !== null,
    internalEmployee: internal
      ? {
          id: internal.id,
          employeeNumber: internal.employeeNumber,
          displayName: personDisplayName(internal.person),
        }
      : null,
    mergedIntoCandidateId: row.mergedIntoCandidateId,
    hired: row.personId !== null,
    ...(full
      ? {
          email: row.email,
          phone: row.phone,
          location: row.location,
          notes: row.notes,
        }
      : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Phase 13 — candidates: Recruitment-owned identities (never a Person, Employee or User until
 * hire conversion). One unmerged candidate per normalized email in an organization (database
 * enforced, serialized by an advisory lock); never deduplicated by name. Merges are explicit,
 * permanent and recorded.
 *
 * Organization-level recruitment.read lists every candidate; otherwise candidates are reached
 * through applications the user reads. Candidate identity and documents are changed with
 * organization-level recruitment.manage or recruitment.manage on one of their applications.
 */
@Injectable()
export class RecruitmentCandidateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RecruitmentAccessService,
    private readonly audit: AuditService,
    private readonly clock: RecruitmentClock,
  ) {}

  async list(
    userId: string,
    organizationId: string,
    filters: { search?: string; includeMerged?: boolean } = {},
  ) {
    const grants = await this.access.grants(userId);
    const user = await this.access.userContext(userId);
    const orgWide =
      this.access.canInOrganization(
        grants,
        'recruitment.read',
        organizationId,
      ) ||
      this.access.canInOrganization(
        grants,
        'recruitment.manage',
        organizationId,
      );
    let candidateFilter: Prisma.RecruitmentCandidateWhereInput = {};
    if (orgWide) await this.access.requireEnabled(organizationId);
    if (!orgWide) {
      const { items } = await this.access.visibleOpenings(
        userId,
        organizationId,
      );
      const openingIds = items
        .filter(({ access }) => access.canRead)
        .map(({ opening }) => opening.id);
      candidateFilter = {
        applications: { some: { openingId: { in: openingIds } } },
      };
    }
    const search = filters.search?.trim();
    const rows = await this.prisma.recruitmentCandidate.findMany({
      where: {
        organizationId,
        ...candidateFilter,
        ...(filters.includeMerged ? {} : { status: { not: 'MERGED' } }),
        ...(search
          ? {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { preferredName: { contains: search, mode: 'insensitive' } },
                { normalizedEmail: { contains: search.toLowerCase() } },
              ],
            }
          : {}),
      },
      include: {
        ...CANDIDATE_INCLUDE,
        _count: { select: { applications: true } },
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    return {
      items: rows
        .filter((row) => !this.access.isSelf(user, row))
        .map((row) => ({
          ...candidateShape(row, true),
          applicationCount: row._count.applications,
        })),
    };
  }

  /** Candidate profile: identity, readable applications, documents and timeline. */
  async detail(userId: string, candidateId: string) {
    const { candidate, orgWide, readableOpenings, user } = await this.readable(
      userId,
      candidateId,
    );
    if (this.access.isSelf(user, candidate)) {
      throw new ForbiddenException(
        domainError(
          403,
          'RECRUITMENT_SELF_ACCESS',
          'You cannot access your own candidacy.',
        ),
      );
    }
    const merged = await this.prisma.recruitmentCandidate.findMany({
      where: { mergedIntoCandidateId: candidateId },
      select: { id: true },
    });
    const candidateIds = [candidateId, ...merged.map((row) => row.id)];
    const applications = await this.prisma.recruitmentApplication.findMany({
      where: {
        candidateId,
        ...(orgWide ? {} : { openingId: { in: readableOpenings } }),
      },
      include: {
        opening: {
          select: { id: true, code: true, title: true, status: true },
        },
        stage: { select: { id: true, name: true, kind: true } },
      },
      orderBy: [{ appliedAt: 'desc' }, { id: 'asc' }],
    });
    const applicationIds = applications.map((row) => row.id);
    const documents = await this.prisma.recruitmentCandidateDocument.findMany({
      where: {
        candidateId,
        removedAt: null,
        ...(orgWide
          ? {}
          : {
              OR: [
                { applicationId: null },
                { applicationId: { in: applicationIds } },
              ],
            }),
      },
      orderBy: [{ addedAt: 'desc' }, { id: 'asc' }],
    });
    const activity = await this.prisma.recruitmentActivity.findMany({
      where: {
        candidateId: { in: candidateIds },
        ...(orgWide
          ? {}
          : {
              OR: [
                { applicationId: null },
                { applicationId: { in: applicationIds } },
              ],
            }),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
      take: 200,
    });
    const grants = await this.access.grants(userId);
    const canManage =
      this.access.canInOrganization(
        grants,
        'recruitment.manage',
        candidate.organizationId,
      ) || (await this.canManageThroughApplication(userId, candidateId));
    return {
      ...candidateShape(candidate, true),
      applications: applications.map((row) => ({
        id: row.id,
        status: row.status,
        opening: row.opening,
        stage: row.stage,
        appliedAt: row.appliedAt.toISOString(),
      })),
      documents: documents.map(documentShape),
      activity: activity.map(activityShape),
      actions: {
        canEdit: canManage,
        canMerge: this.access.canInOrganization(
          grants,
          'recruitment.manage',
          candidate.organizationId,
        ),
        canMarkInternal: this.access.canInOrganization(
          grants,
          'recruitment.manage',
          candidate.organizationId,
        ),
      },
    };
  }

  /** A standalone candidate (organization-level recruitment.manage). */
  async create(
    input: CandidateDetailsInput & { organizationId: string },
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'recruitment.manage',
      input.organizationId,
    );
    const details = parseCandidateDetails(input);
    return this.prisma.$transaction(async (tx) => {
      const { candidate, created } = await this.findOrCreate(
        tx,
        input.organizationId,
        details,
        actor,
      );
      if (!created) {
        throw conflict(
          'RECRUITMENT_CANDIDATE_EXISTS',
          'A candidate with this email already exists in the organization.',
          { candidateId: candidate.id },
        );
      }
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_CANDIDATE_CREATED',
        entityType: 'RecruitmentCandidate',
        entityId: candidate.id,
        context,
        metadata: {
          organizationId: candidate.organizationId,
          source: candidate.source,
        },
      });
      return candidateShape(candidate, true);
    });
  }

  /**
   * The candidate with this normalized email (unmerged, in the organization), else a new one.
   * Serialized per (organization, email) so concurrent deliveries never race the unique index.
   * Candidates without an email are always new (never matched by name).
   */
  async findOrCreate(
    tx: Tx,
    organizationId: string,
    details: ReturnType<typeof parseCandidateDetails>,
    actorUserId: string | null,
  ): Promise<{ candidate: RecruitmentCandidate; created: boolean }> {
    if (details.normalizedEmail) {
      await advisoryLock(
        tx,
        `recruitment-candidate-email:${organizationId}:${details.normalizedEmail}`,
      );
      const existing = await tx.recruitmentCandidate.findFirst({
        where: {
          organizationId,
          normalizedEmail: details.normalizedEmail,
          mergedIntoCandidateId: null,
        },
      });
      if (existing) return { candidate: existing, created: false };
    }
    const candidate = await tx.recruitmentCandidate.create({
      data: {
        organizationId,
        firstName: details.firstName!,
        lastName: details.lastName!,
        preferredName: details.preferredName ?? null,
        email: details.email ?? null,
        normalizedEmail: details.normalizedEmail ?? null,
        phone: details.phone ?? null,
        location: details.location ?? null,
        notes: details.notes ?? null,
        source: details.source ?? 'DIRECT',
        createdByUserId: actorUserId,
      },
    });
    return { candidate, created: true };
  }

  async update(
    candidateId: string,
    input: Partial<CandidateDetailsInput>,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const details = parseCandidateDetails(input, true);
    return this.prisma.$transaction(async (tx) => {
      const candidate = await this.requireCandidateManage(
        actor,
        candidateId,
        tx,
      );
      if (candidate.status === 'MERGED') {
        throw conflict(
          'RECRUITMENT_CANDIDATE_MERGED',
          'The candidate was merged into another candidate.',
        );
      }
      if (
        details.normalizedEmail &&
        details.normalizedEmail !== candidate.normalizedEmail
      ) {
        await advisoryLock(
          tx,
          `recruitment-candidate-email:${candidate.organizationId}:${details.normalizedEmail}`,
        );
        const taken = await tx.recruitmentCandidate.findFirst({
          where: {
            organizationId: candidate.organizationId,
            normalizedEmail: details.normalizedEmail,
            mergedIntoCandidateId: null,
            id: { not: candidateId },
          },
          select: { id: true },
        });
        if (taken) {
          throw conflict(
            'RECRUITMENT_CANDIDATE_EXISTS',
            'Another candidate has this email; merge the two candidates instead.',
          );
        }
      }
      const row = await tx.recruitmentCandidate.update({
        where: { id: candidateId },
        data: details,
        include: CANDIDATE_INCLUDE,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_CANDIDATE_UPDATED',
        entityType: 'RecruitmentCandidate',
        entityId: candidateId,
        context,
        metadata: {
          organizationId: row.organizationId,
          fields: Object.keys(details),
        },
      });
      return candidateShape(row, true);
    });
  }

  /** Links (or unlinks) the existing employee an internal candidate is. */
  async setInternalEmployee(
    candidateId: string,
    employeeId: string | null,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      await lockCandidate(tx, candidateId);
      const candidate = await this.candidateOrThrow(candidateId, tx);
      await this.requireOrganizationManage(actor, candidate, tx);
      const user = await this.access.userContext(actor, tx);
      if (
        this.access.isSelf(user, candidate) ||
        (employeeId && employeeId === user.employeeId)
      ) {
        throw new ForbiddenException(
          domainError(
            403,
            'RECRUITMENT_SELF_ACCESS',
            'You cannot manage your own candidacy.',
          ),
        );
      }
      if (candidate.personId) {
        throw conflict(
          'RECRUITMENT_CANDIDATE_HIRED',
          'A hired candidate keeps its links.',
        );
      }
      if (employeeId) {
        const inOrg = await tx.employmentAssignment.count({
          where: {
            employeeId,
            status: { not: 'CANCELLED' },
            position: { organizationId: candidate.organizationId },
          },
        });
        if (!inOrg) {
          invalid(
            'RECRUITMENT_INTERNAL_EMPLOYEE_INVALID',
            'The employee does not work in the organization.',
          );
        }
      }
      try {
        const row = await tx.recruitmentCandidate.update({
          where: { id: candidateId },
          data: {
            internalEmployeeId: employeeId,
            ...(employeeId ? { source: 'INTERNAL' } : {}),
          },
          include: CANDIDATE_INCLUDE,
        });
        await writeRecruitmentAudit(this.audit, tx, {
          action: 'RECRUITMENT_CANDIDATE_INTERNAL_LINKED',
          entityType: 'RecruitmentCandidate',
          entityId: candidateId,
          context,
          metadata: { organizationId: row.organizationId, employeeId },
        });
        return candidateShape(row, true);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict(
            'RECRUITMENT_INTERNAL_CANDIDATE_EXISTS',
            'The employee is already a candidate.',
          );
        }
        throw error;
      }
    });
  }

  async archive(candidateId: string, context: RecruitmentRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      await lockCandidate(tx, candidateId);
      const candidate = await this.candidateOrThrow(candidateId, tx);
      await this.requireOrganizationManage(actor, candidate, tx);
      if (candidate.status !== 'ACTIVE') {
        throw conflict(
          'RECRUITMENT_CANDIDATE_NOT_ACTIVE',
          'Only active candidates are archived.',
        );
      }
      const live = await tx.recruitmentApplication.count({
        where: { candidateId, status: { in: LIVE_APPLICATION } },
      });
      if (live > 0) {
        throw conflict(
          'RECRUITMENT_CANDIDATE_HAS_LIVE_APPLICATIONS',
          'Close the candidate’s live applications first.',
        );
      }
      const row = await tx.recruitmentCandidate.update({
        where: { id: candidateId },
        data: { status: 'ARCHIVED' },
        include: CANDIDATE_INCLUDE,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_CANDIDATE_ARCHIVED',
        entityType: 'RecruitmentCandidate',
        entityId: candidateId,
        context,
        metadata: { organizationId: row.organizationId },
      });
      return candidateShape(row, true);
    });
  }

  /**
   * Explicit merge of a duplicate (source) into the surviving candidate (target): the source's
   * applications, documents and submissions move to the target (allowed by the database only
   * along the recorded merge), blank target fields are filled from the source, and the source
   * stays as a MERGED record. Hired candidates and conflicting live applications are refused.
   */
  async merge(
    sourceId: string,
    targetId: string,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    if (sourceId === targetId)
      invalid('RECRUITMENT_MERGE_INVALID', 'Choose two different candidates.');
    return this.prisma.$transaction(async (tx) => {
      for (const id of [sourceId, targetId].sort()) await lockCandidate(tx, id);
      const source = await this.candidateOrThrow(sourceId, tx);
      const target = await this.candidateOrThrow(targetId, tx);
      if (source.organizationId !== target.organizationId) {
        throw new NotFoundException('Candidate not found.');
      }
      await this.requireOrganizationManage(actor, source, tx);
      const user = await this.access.userContext(actor, tx);
      if (
        this.access.isSelf(user, source) ||
        this.access.isSelf(user, target)
      ) {
        throw new ForbiddenException(
          domainError(
            403,
            'RECRUITMENT_SELF_ACCESS',
            'You cannot manage your own candidacy.',
          ),
        );
      }
      if (source.status !== 'ACTIVE' && source.status !== 'ARCHIVED') {
        throw conflict(
          'RECRUITMENT_MERGE_INVALID',
          'The duplicate was already merged.',
        );
      }
      if (target.status === 'MERGED') {
        throw conflict(
          'RECRUITMENT_MERGE_INVALID',
          'Merge into an unmerged candidate.',
        );
      }
      if (
        source.personId ||
        (await tx.recruitmentHire.count({ where: { candidateId: sourceId } }))
      ) {
        throw conflict(
          'RECRUITMENT_MERGE_HIRED',
          'A hired candidate is never merged away.',
        );
      }
      if (
        source.internalEmployeeId &&
        target.internalEmployeeId &&
        source.internalEmployeeId !== target.internalEmployeeId
      ) {
        throw conflict(
          'RECRUITMENT_MERGE_CONFLICT',
          'The candidates are different employees.',
        );
      }
      const sourceApplications = await tx.recruitmentApplication.findMany({
        where: { candidateId: sourceId },
      });
      const targetLive = await tx.recruitmentApplication.findMany({
        where: {
          candidateId: targetId,
          status: { in: ['ACTIVE', 'OFFERED', 'HIRED'] },
        },
        select: { openingId: true },
      });
      const clash = sourceApplications.filter(
        (application) =>
          ['ACTIVE', 'OFFERED', 'HIRED'].includes(application.status) &&
          targetLive.some((live) => live.openingId === application.openingId),
      );
      if (clash.length > 0) {
        throw conflict(
          'RECRUITMENT_MERGE_CONFLICT',
          'Both candidates have a live application to the same opening; close one first.',
          { applicationIds: clash.map((row) => row.id) },
        );
      }
      const now = this.clock.now();
      await tx.recruitmentCandidate.update({
        where: { id: sourceId },
        data: {
          status: 'MERGED',
          mergedIntoCandidateId: targetId,
          mergedAt: now,
          mergedByUserId: actor,
        },
      });
      await tx.recruitmentApplication.updateMany({
        where: { candidateId: sourceId },
        data: { candidateId: targetId },
      });
      await tx.recruitmentCandidateDocument.updateMany({
        where: { candidateId: sourceId },
        data: { candidateId: targetId },
      });
      await tx.recruitmentIntakeSubmission.updateMany({
        where: { candidateId: sourceId },
        data: { candidateId: targetId },
      });
      const fill: Prisma.RecruitmentCandidateUncheckedUpdateInput = {};
      if (!target.normalizedEmail && source.normalizedEmail) {
        fill.email = source.email;
        fill.normalizedEmail = source.normalizedEmail;
      }
      if (!target.phone && source.phone) fill.phone = source.phone;
      if (!target.preferredName && source.preferredName)
        fill.preferredName = source.preferredName;
      if (!target.location && source.location) fill.location = source.location;
      if (!target.internalEmployeeId && source.internalEmployeeId)
        fill.internalEmployeeId = source.internalEmployeeId;
      if (source.notes)
        fill.notes = [target.notes, source.notes].filter(Boolean).join('\n\n');
      const row = await tx.recruitmentCandidate.update({
        where: { id: targetId },
        data: {
          ...fill,
          ...(target.status === 'ARCHIVED' && source.status === 'ACTIVE'
            ? { status: 'ACTIVE' }
            : {}),
        },
        include: CANDIDATE_INCLUDE,
      });
      for (const candidateId of [sourceId, targetId]) {
        await recordActivity(tx, {
          organizationId: source.organizationId,
          candidateId,
          type: 'CANDIDATE_MERGED',
          summary: 'Duplicate candidate record merged',
          relatedId: candidateId === sourceId ? targetId : sourceId,
          actorUserId: actor,
        });
      }
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_CANDIDATE_MERGED',
        entityType: 'RecruitmentCandidate',
        entityId: targetId,
        context,
        metadata: {
          organizationId: source.organizationId,
          mergedCandidateId: sourceId,
          applications: sourceApplications.length,
          filledFields: Object.keys(fill),
        },
      });
      return candidateShape(row, true);
    });
  }

  // ─── Documents (references only) ──────────────────────────────────────────

  async addDocument(
    candidateId: string,
    input: DocumentReferenceInput & { applicationId?: string | null },
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const reference = parseDocumentReference(input);
    return this.prisma.$transaction(async (tx) => {
      const candidate = await this.requireCandidateManage(
        actor,
        candidateId,
        tx,
        input.applicationId ?? null,
      );
      if (candidate.status === 'MERGED') {
        throw conflict(
          'RECRUITMENT_CANDIDATE_MERGED',
          'The candidate was merged into another candidate.',
        );
      }
      const row = await tx.recruitmentCandidateDocument.create({
        data: {
          organizationId: candidate.organizationId,
          candidateId,
          applicationId: input.applicationId ?? null,
          ...reference,
          addedByUserId: actor,
        },
      });
      await recordActivity(tx, {
        organizationId: candidate.organizationId,
        candidateId,
        applicationId: row.applicationId,
        type: 'DOCUMENT_ADDED',
        summary: `Document added: ${reference.kind.replaceAll('_', ' ').toLowerCase()}`,
        relatedId: row.id,
        actorUserId: actor,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_DOCUMENT_ADDED',
        entityType: 'RecruitmentCandidateDocument',
        entityId: row.id,
        context,
        metadata: {
          organizationId: candidate.organizationId,
          candidateId,
          kind: row.kind,
          provider: row.provider,
        },
      });
      return documentShape(row);
    });
  }

  async removeDocument(
    documentId: string,
    reason: string,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(reason, 'reason', { required: true, max: 1000 })!;
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.recruitmentCandidateDocument.findUnique({
        where: { id: documentId },
      });
      if (!document) throw new NotFoundException('Document not found.');
      await this.requireCandidateManage(
        actor,
        document.candidateId,
        tx,
        document.applicationId,
      );
      if (document.removedAt) return documentShape(document);
      const row = await tx.recruitmentCandidateDocument.update({
        where: { id: documentId },
        data: {
          removedAt: this.clock.now(),
          removedByUserId: actor,
          removalReason: note,
        },
      });
      await recordActivity(tx, {
        organizationId: row.organizationId,
        candidateId: row.candidateId,
        applicationId: row.applicationId,
        type: 'DOCUMENT_REMOVED',
        summary: 'Document removed',
        relatedId: row.id,
        actorUserId: actor,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_DOCUMENT_REMOVED',
        entityType: 'RecruitmentCandidateDocument',
        entityId: row.id,
        context,
        metadata: {
          organizationId: row.organizationId,
          candidateId: row.candidateId,
        },
      });
      return documentShape(row);
    });
  }

  // ─── Access helpers ───────────────────────────────────────────────────────

  private async candidateOrThrow(
    candidateId: string,
    client: RecruitmentClient = this.prisma,
  ) {
    const candidate = await client.recruitmentCandidate.findUnique({
      where: { id: candidateId },
      include: CANDIDATE_INCLUDE,
    });
    if (!candidate) throw new NotFoundException('Candidate not found.');
    // Phase 19: the feature gate is NOT applied here. Every caller authorizes first (404 for
    // a candidate the caller may not see) and only then checks the module, so a disabled
    // module never answers FEATURE_DISABLED for an id the caller cannot reach.
    return candidate;
  }

  /** Readable when organization-wide, or through at least one readable application. */
  private async readable(userId: string, candidateId: string) {
    const candidate = await this.candidateOrThrow(candidateId);
    const grants = await this.access.grants(userId);
    const user = await this.access.userContext(userId);
    const orgWide =
      this.access.canInOrganization(
        grants,
        'recruitment.read',
        candidate.organizationId,
      ) ||
      this.access.canInOrganization(
        grants,
        'recruitment.manage',
        candidate.organizationId,
      );
    let readableOpenings: string[] = [];
    if (!orgWide) {
      const { items } = await this.access.visibleOpenings(
        userId,
        candidate.organizationId,
      );
      readableOpenings = items
        .filter(({ access }) => access.canRead)
        .map(({ opening }) => opening.id);
      const reachable = await this.prisma.recruitmentApplication.count({
        where: { candidateId, openingId: { in: readableOpenings } },
      });
      if (!reachable) throw new NotFoundException('Candidate not found.');
    }
    // Phase 18 gate, after authorization (Phase 19).
    await this.access.requireEnabled(candidate.organizationId);
    return { candidate, orgWide, readableOpenings, user };
  }

  private async canManageThroughApplication(
    userId: string,
    candidateId: string,
    client: RecruitmentClient = this.prisma,
    applicationId: string | null = null,
  ) {
    const applications = await client.recruitmentApplication.findMany({
      where: { candidateId, ...(applicationId ? { id: applicationId } : {}) },
      select: { id: true },
    });
    for (const application of applications) {
      const access = await this.access.applicationAccess(
        userId,
        application.id,
        client,
      );
      if (access.canManage) return true;
    }
    return false;
  }

  /**
   * Organization-level recruitment.manage, or recruitment.manage on one of the candidate's
   * applications (the given one, when a document concerns an application). Never one's own.
   */
  async requireCandidateManage(
    userId: string,
    candidateId: string,
    client: RecruitmentClient,
    applicationId: string | null = null,
  ) {
    const candidate = await this.candidateOrThrow(candidateId, client);
    const user = await this.access.userContext(userId, client);
    if (this.access.isSelf(user, candidate)) {
      throw new ForbiddenException(
        domainError(
          403,
          'RECRUITMENT_SELF_ACCESS',
          'You cannot manage your own candidacy.',
        ),
      );
    }
    if (applicationId) {
      const application = await client.recruitmentApplication.findUnique({
        where: { id: applicationId },
        select: { candidateId: true },
      });
      if (!application || application.candidateId !== candidateId) {
        invalid(
          'RECRUITMENT_DOCUMENT_APPLICATION_INVALID',
          'The application belongs to another candidate.',
        );
      }
    }
    const grants = await this.access.grants(userId, client);
    if (
      (!applicationId &&
        this.access.canInOrganization(
          grants,
          'recruitment.manage',
          candidate.organizationId,
        )) ||
      (await this.canManageThroughApplication(
        userId,
        candidateId,
        client,
        applicationId,
      ))
    ) {
      // Phase 18 gate, after authorization (Phase 19).
      await this.access.requireEnabled(candidate.organizationId, client);
      return candidate;
    }
    const orgRead = this.access.canInOrganization(
      grants,
      'recruitment.read',
      candidate.organizationId,
    );
    if (!orgRead && !(await this.anyReadable(userId, candidateId, client))) {
      throw new NotFoundException('Candidate not found.');
    }
    throw new ForbiddenException(
      'Missing permission recruitment.manage for the candidate.',
    );
  }

  /**
   * Organization-level recruitment.manage on the candidate's organization. A caller with no
   * recruitment grant in that organization and no view of the candidate gets the same 404 as
   * for a missing id (Phase 19: no cross-organization existence oracle); everyone else keeps
   * the 403.
   */
  private async requireOrganizationManage(
    userId: string,
    candidate: { id: string; organizationId: string },
    client: RecruitmentClient,
  ) {
    const grants = await this.access.grants(userId, client);
    if (
      !(await this.access.hasAnyInOrganization(
        userId,
        candidate.organizationId,
        client,
        grants,
      )) &&
      !(await this.anyReadable(userId, candidate.id, client))
    ) {
      throw new NotFoundException('Candidate not found.');
    }
    return this.access.requireOrganization(
      userId,
      'recruitment.manage',
      candidate.organizationId,
      client,
    );
  }

  private async anyReadable(
    userId: string,
    candidateId: string,
    client: RecruitmentClient,
  ) {
    const applications = await client.recruitmentApplication.findMany({
      where: { candidateId },
      select: { id: true },
    });
    for (const application of applications) {
      const access = await this.access.applicationAccess(
        userId,
        application.id,
        client,
      );
      if (access.view) return true;
    }
    return false;
  }
}

export function activityShape(activity: {
  id: string;
  applicationId: string | null;
  type: string;
  summary: string;
  relatedId: string | null;
  actorUserId: string | null;
  occurredAt: Date;
}) {
  return {
    id: activity.id,
    applicationId: activity.applicationId,
    type: activity.type,
    summary: activity.summary,
    relatedId: activity.relatedId,
    actorUserId: activity.actorUserId,
    occurredAt: activity.occurredAt.toISOString(),
  };
}
