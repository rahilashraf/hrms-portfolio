import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, requireActor } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  JobOpening,
  Prisma,
  RecruitmentApplicationStatus,
  RecruitmentCandidate,
  RecruitmentScreeningOutcome,
  RecruitmentSource,
} from '../generated/prisma/client.js';
import {
  RecruitmentAccessService,
  type ApplicationView,
} from './recruitment-access.service.js';
import {
  activityShape,
  candidateShape,
  documentShape,
  parseCandidateDetails,
  RecruitmentCandidateService,
  type CandidateDetailsInput,
} from './recruitment-candidate.service.js';
import {
  candidateDisplayName,
  conflict,
  isUniqueViolation,
  lockApplication,
  lockOpening,
  optionalDate,
  RecruitmentClock,
  recordActivity,
  recruitmentToday,
  writeRecruitmentAudit,
  type RecruitmentClient,
  type RecruitmentRequestContext,
  type Tx,
} from './recruitment-common.js';
import {
  initialStage,
  invalid,
  LIVE_APPLICATION,
  OPEN_OFFER,
  parseDocumentReference,
  parseInstant,
  parseText,
  type DocumentReferenceInput,
} from './recruitment-domain.js';
import {
  hireShape,
  interviewShape,
  INTERVIEW_INCLUDE,
  offerShape,
  screeningShape,
} from './recruitment-shapes.js';
import { RecruitmentStageService } from './recruitment-stage.service.js';

export interface CreateApplicationInput {
  openingId: string;
  candidateId?: string | null;
  candidate?: CandidateDetailsInput | null;
  source?: RecruitmentSource;
  sourceDetail?: string | null;
  appliedAt?: string | null;
  recruiterUserId?: string | null;
  documents?: DocumentReferenceInput[];
}

export interface ScreeningInput {
  outcome: RecruitmentScreeningOutcome;
  meetsMinimumQualifications?: boolean | null;
  workAuthorizationConfirmed?: boolean | null;
  requiredCertificationsHeld?: boolean | null;
  availableFrom?: string | null;
  notes?: string | null;
}

/**
 * Phase 13 — applications and the pipeline. One live application per candidate and opening
 * (database enforced); stage moves are appended to the stage history and the timeline;
 * withdrawals and rejections are kept, close the application's open offer and cancel its
 * scheduled interviews. The Hired stage and the HIRED status are reached only through hire
 * conversion.
 */
/** Activity a hiring manager never sees (screening and offers are FULL-view only). */
export const HIRING_MANAGER_HIDDEN_ACTIVITY = [
  'SCREENING_RECORDED',
  'OFFER_CREATED',
  'OFFER_APPROVED',
  'OFFER_REVISED',
  'OFFER_SENT',
  'OFFER_ACCEPTED',
  'OFFER_DECLINED',
  'OFFER_WITHDRAWN',
  'OFFER_EXPIRED',
] as const;

@Injectable()
export class RecruitmentApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RecruitmentAccessService,
    private readonly audit: AuditService,
    private readonly clock: RecruitmentClock,
    private readonly candidates: RecruitmentCandidateService,
    private readonly stages: RecruitmentStageService,
  ) {}

  async list(
    userId: string,
    organizationId: string,
    filters: {
      openingId?: string;
      stageId?: string;
      status?: RecruitmentApplicationStatus;
      search?: string;
    } = {},
  ) {
    const { items, user } = await this.access.visibleOpenings(
      userId,
      organizationId,
    );
    const access = new Map(
      items.map(({ opening, access }) => [opening.id, access]),
    );
    const openingIds = items
      .map(({ opening }) => opening.id)
      .filter((id) => !filters.openingId || id === filters.openingId);
    const search = filters.search?.trim();
    const rows = await this.prisma.recruitmentApplication.findMany({
      where: {
        organizationId,
        openingId: { in: openingIds },
        ...(filters.stageId ? { stageId: filters.stageId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(search
          ? {
              candidate: {
                OR: [
                  { firstName: { contains: search, mode: 'insensitive' } },
                  { lastName: { contains: search, mode: 'insensitive' } },
                  { preferredName: { contains: search, mode: 'insensitive' } },
                  { normalizedEmail: { contains: search.toLowerCase() } },
                ],
              },
            }
          : {}),
      },
      include: {
        candidate: true,
        opening: {
          select: { id: true, code: true, title: true, status: true },
        },
        stage: {
          select: { id: true, name: true, kind: true, sortOrder: true },
        },
      },
      orderBy: [{ stageEnteredAt: 'desc' }, { id: 'asc' }],
      take: 500,
    });
    return {
      items: rows
        .filter((row) => !this.access.isSelf(user, row.candidate))
        .map((row) => {
          const openingAccess = access.get(row.openingId)!;
          return {
            id: row.id,
            status: row.status,
            source: row.source,
            appliedAt: row.appliedAt.toISOString(),
            stageEnteredAt: row.stageEnteredAt.toISOString(),
            candidate: {
              id: row.candidate.id,
              displayName: candidateDisplayName(row.candidate),
              internal: row.candidate.internalEmployeeId !== null,
            },
            opening: row.opening,
            stage: row.stage,
            view: (openingAccess.canRead
              ? 'FULL'
              : 'HIRING_MANAGER') as ApplicationView,
          };
        }),
    };
  }

  async create(
    input: CreateApplicationInput,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    if (Boolean(input.candidateId) === Boolean(input.candidate)) {
      invalid(
        'RECRUITMENT_APPLICATION_CANDIDATE_REQUIRED',
        'Give an existing candidate or new candidate details, not both.',
      );
    }
    const details = input.candidate
      ? parseCandidateDetails(input.candidate)
      : null;
    const documents = (input.documents ?? []).map((document) =>
      parseDocumentReference(document),
    );
    const appliedAt =
      parseInstant(input.appliedAt, 'appliedAt') ?? this.clock.now();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockOpening(tx, input.openingId);
        const { opening, access } = await this.access.requireOpening(
          actor,
          input.openingId,
          'manage',
          tx,
        );
        let candidate: RecruitmentCandidate;
        if (input.candidateId) {
          const existing = await tx.recruitmentCandidate.findUnique({
            where: { id: input.candidateId },
          });
          if (
            !existing ||
            existing.organizationId !== opening.organizationId ||
            !(await this.canReadCandidate(tx, actor, access.grants, existing))
          ) {
            throw new NotFoundException('Candidate not found.');
          }
          candidate = existing;
        } else {
          const found = await this.candidates.findOrCreate(
            tx,
            opening.organizationId,
            details!,
            actor,
          );
          // Batch 7A (S3): an email that matches an existing candidate attaches the
          // application to them only when the caller may read that candidate, exactly as when
          // choosing an existing candidate. Otherwise refuse neutrally (the same answer whether
          // the match is active or archived), never revealing or linking the other record.
          if (
            !found.created &&
            !(await this.canReadCandidate(
              tx,
              actor,
              access.grants,
              found.candidate,
            ))
          ) {
            throw new ConflictException(
              domainError(
                409,
                'RECRUITMENT_CANDIDATE_EMAIL_UNAVAILABLE',
                'This email cannot be used for a new candidate here. Ask a recruiter with organization-wide access to add the application.',
              ),
            );
          }
          candidate = found.candidate;
        }
        if (this.access.isSelf(access.user, candidate)) {
          throw new ForbiddenException(
            domainError(
              403,
              'RECRUITMENT_SELF_ACCESS',
              'You cannot manage your own candidacy.',
            ),
          );
        }
        const application = await this.createInTransaction(tx, {
          opening,
          candidate,
          source:
            input.source ??
            (candidate.internalEmployeeId ? 'INTERNAL' : candidate.source),
          sourceDetail: parseText(input.sourceDetail, 'sourceDetail', {
            max: 200,
          }),
          appliedAt,
          recruiterUserId: input.recruiterUserId ?? opening.recruiterUserId,
          actorUserId: actor,
          documents,
        });
        await writeRecruitmentAudit(this.audit, tx, {
          action: 'RECRUITMENT_APPLICATION_CREATED',
          entityType: 'RecruitmentApplication',
          entityId: application.id,
          context,
          metadata: {
            organizationId: opening.organizationId,
            openingId: opening.id,
            candidateId: candidate.id,
            source: application.source,
          },
        });
        return {
          id: application.id,
          candidateId: candidate.id,
          status: application.status,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw this.duplicate();
      throw error;
    }
  }

  duplicate() {
    return conflict(
      'RECRUITMENT_APPLICATION_EXISTS',
      'The candidate already has a live application to this opening.',
    );
  }

  /**
   * Creates an application in the caller's transaction (the opening locked by the caller):
   * initial stage, stage history, timeline and document references. Shared by manual entry and
   * external ingestion.
   */
  /**
   * Whether the caller may read a candidate of the opening's organization: organization-wide
   * recruitment read/manage, or through an application to an opening they can read.
   */
  private async canReadCandidate(
    tx: RecruitmentClient,
    actor: string,
    grants: Parameters<RecruitmentAccessService['canInOrganization']>[0],
    candidate: RecruitmentCandidate,
  ) {
    if (
      this.access.canInOrganization(
        grants,
        'recruitment.read',
        candidate.organizationId,
      ) ||
      this.access.canInOrganization(
        grants,
        'recruitment.manage',
        candidate.organizationId,
      )
    ) {
      return true;
    }
    const { items } = await this.access.visibleOpenings(
      actor,
      candidate.organizationId,
      tx,
    );
    const readable = items
      .filter(({ access: a }) => a.canRead)
      .map(({ opening: o }) => o.id);
    return (
      (await tx.recruitmentApplication.count({
        where: { candidateId: candidate.id, openingId: { in: readable } },
      })) > 0
    );
  }

  async createInTransaction(
    tx: Tx,
    input: {
      opening: JobOpening;
      candidate: RecruitmentCandidate;
      source: RecruitmentSource;
      sourceDetail: string | null;
      appliedAt: Date;
      recruiterUserId: string | null;
      actorUserId: string | null;
      documents: ReturnType<typeof parseDocumentReference>[];
    },
  ) {
    const { opening, candidate } = input;
    if (opening.status !== 'OPEN') {
      throw conflict(
        'RECRUITMENT_OPENING_NOT_OPEN',
        'The opening is not accepting applications.',
        {
          status: opening.status,
        },
      );
    }
    if (candidate.status !== 'ACTIVE') {
      throw conflict(
        'RECRUITMENT_CANDIDATE_NOT_ACTIVE',
        'The candidate is archived or merged.',
      );
    }
    const live = await tx.recruitmentApplication.findFirst({
      where: {
        candidateId: candidate.id,
        openingId: opening.id,
        status: { in: ['ACTIVE', 'OFFERED', 'HIRED'] },
      },
      select: { id: true },
    });
    if (live) throw this.duplicate();
    await this.stages.ensureDefaults(
      tx,
      opening.organizationId,
      input.actorUserId ?? undefined,
    );
    const stage = initialStage(
      await tx.recruitmentStage.findMany({
        where: { organizationId: opening.organizationId },
      }),
    );
    if (!stage)
      throw conflict(
        'RECRUITMENT_NO_STAGES',
        'The organization has no hiring stages.',
      );
    const application = await tx.recruitmentApplication.create({
      data: {
        organizationId: opening.organizationId,
        candidateId: candidate.id,
        openingId: opening.id,
        stageId: stage.id,
        source: input.source,
        sourceDetail: input.sourceDetail,
        appliedAt: input.appliedAt,
        recruiterUserId: input.recruiterUserId,
        stageEnteredAt: this.clock.now(),
        createdByUserId: input.actorUserId,
      },
    });
    await tx.recruitmentStageTransition.create({
      data: {
        applicationId: application.id,
        toStageId: stage.id,
        toStageName: stage.name,
        actorUserId: input.actorUserId,
      },
    });
    await recordActivity(tx, {
      organizationId: opening.organizationId,
      candidateId: candidate.id,
      applicationId: application.id,
      type: 'APPLICATION_RECEIVED',
      summary: `Application received for ${opening.title}`,
      relatedId: opening.id,
      actorUserId: input.actorUserId,
      occurredAt: input.appliedAt,
    });
    for (const document of input.documents) {
      await tx.recruitmentCandidateDocument.create({
        data: {
          organizationId: opening.organizationId,
          candidateId: candidate.id,
          applicationId: application.id,
          ...document,
          addedByUserId: input.actorUserId,
        },
      });
    }
    return application;
  }

  /** The application as the viewer may see it (FULL, HIRING_MANAGER or INTERVIEWER). */
  async detail(userId: string, applicationId: string) {
    const access = await this.access.requireApplicationView(
      userId,
      applicationId,
    );
    const { view } = access;
    const now = this.clock.now();
    const row = await this.prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: applicationId },
      include: {
        candidate: {
          include: {
            internalEmployee: {
              select: {
                id: true,
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
        opening: {
          include: {
            organization: { select: { id: true, name: true, timezone: true } },
          },
        },
        stage: true,
        screening: true,
        transitions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        interviews: {
          include: INTERVIEW_INCLUDE,
          orderBy: [{ scheduledStart: 'asc' }, { id: 'asc' }],
        },
        offers: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        hire: true,
        documents: {
          where: { removedAt: null },
          orderBy: [{ addedAt: 'desc' }, { id: 'asc' }],
        },
      },
    });
    const today = recruitmentToday(now, row.opening.organization.timezone);
    const interviews = row.interviews
      .filter(
        (interview) =>
          view !== 'INTERVIEWER' || access.interviewerOn.includes(interview.id),
      )
      .map((interview) =>
        interviewShape(
          interview,
          { userId, seesAllFeedback: view !== 'INTERVIEWER' },
          now,
        ),
      );
    const documents = await this.prisma.recruitmentCandidateDocument.findMany({
      where: {
        candidateId: row.candidateId,
        removedAt: null,
        OR: [{ applicationId: null }, { applicationId }],
      },
      orderBy: [{ addedAt: 'desc' }, { id: 'asc' }],
    });
    const base = {
      id: row.id,
      view,
      status: row.status,
      source: row.source,
      sourceDetail: row.sourceDetail,
      appliedAt: row.appliedAt.toISOString(),
      stageEnteredAt: row.stageEnteredAt.toISOString(),
      stage: { id: row.stage.id, name: row.stage.name, kind: row.stage.kind },
      organization: {
        id: row.opening.organization.id,
        name: row.opening.organization.name,
      },
      opening: {
        id: row.opening.id,
        code: row.opening.code,
        title: row.opening.title,
        status: row.opening.status,
        positionId: row.opening.positionId,
        employmentType: row.opening.employmentType,
      },
      candidate: candidateShape(row.candidate, view === 'FULL'),
      interviews,
      documents: documents.map(documentShape),
    };
    if (view === 'INTERVIEWER') return { ...base, actions: this.noActions() };
    const activity = await this.prisma.recruitmentActivity.findMany({
      where: {
        applicationId,
        // Batch 7A (S4): a hiring manager never sees screening or offers, nor their events.
        ...(view === 'HIRING_MANAGER'
          ? { type: { notIn: [...HIRING_MANAGER_HIDDEN_ACTIVITY] } }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
    });
    const shared = {
      ...base,
      dispositionReason: view === 'FULL' ? row.dispositionReason : null,
      dispositionAt: row.dispositionAt?.toISOString() ?? null,
      transitions: row.transitions.map((transition) => ({
        id: transition.id,
        fromStageName: transition.fromStageName,
        toStageName: transition.toStageName,
        note: view === 'FULL' ? transition.note : null,
        actorUserId: transition.actorUserId,
        createdAt: transition.createdAt.toISOString(),
      })),
      activity: activity.map(activityShape),
      hire: hireShape(row.hire),
    };
    if (view === 'HIRING_MANAGER')
      return { ...shared, actions: this.noActions() };
    const live = LIVE_APPLICATION.includes(row.status);
    const openOffer = row.offers.find((offer) =>
      OPEN_OFFER.includes(offer.status),
    );
    const accepted = row.offers.find((offer) => offer.status === 'ACCEPTED');
    return {
      ...shared,
      screening: screeningShape(row.screening),
      offers: row.offers.map((offer) => offerShape(offer, today)),
      actions: {
        canManage: access.canManage,
        canMoveStage: access.canManage && live,
        canScreen: access.canManage && live,
        canScheduleInterview: access.canManage && live,
        canWithdraw: access.canManage && live,
        canReject: access.canManage && live,
        canCreateOffer:
          access.canManage &&
          row.status === 'ACTIVE' &&
          !openOffer &&
          row.opening.status === 'OPEN',
        canApproveOffer:
          access.canApproveOffers && openOffer?.status === 'DRAFT',
        canHire:
          access.canHire &&
          row.status === 'OFFERED' &&
          Boolean(accepted) &&
          !row.hire,
      },
    };
  }

  private noActions() {
    return {
      canManage: false,
      canMoveStage: false,
      canScreen: false,
      canScheduleInterview: false,
      canWithdraw: false,
      canReject: false,
      canCreateOffer: false,
      canApproveOffer: false,
      canHire: false,
    };
  }

  async moveStage(
    applicationId: string,
    stageId: string,
    note: string | null | undefined,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const text = parseText(note, 'note', { max: 2000 });
    return this.prisma.$transaction(async (tx) => {
      const application = await this.lockedForManage(tx, actor, applicationId);
      this.requireLive(application.status);
      const [from, to] = await Promise.all([
        tx.recruitmentStage.findUniqueOrThrow({
          where: { id: application.stageId },
        }),
        tx.recruitmentStage.findUnique({ where: { id: stageId } }),
      ]);
      if (
        !to ||
        to.organizationId !== application.organizationId ||
        to.archivedAt
      ) {
        invalid(
          'RECRUITMENT_STAGE_INVALID',
          'The stage is not a live stage of the organization.',
        );
      }
      if (to.kind === 'HIRED') {
        throw conflict(
          'RECRUITMENT_STAGE_HIRED_RESERVED',
          'Candidates enter the Hired stage through hire conversion.',
        );
      }
      if (to.id === from.id) {
        throw conflict(
          'RECRUITMENT_STAGE_UNCHANGED',
          'The application is already in this stage.',
        );
      }
      const now = this.clock.now();
      await tx.recruitmentApplication.update({
        where: { id: applicationId },
        data: { stageId: to.id, stageEnteredAt: now },
      });
      await tx.recruitmentStageTransition.create({
        data: {
          applicationId,
          fromStageId: from.id,
          fromStageName: from.name,
          toStageId: to.id,
          toStageName: to.name,
          note: text,
          actorUserId: actor,
        },
      });
      await recordActivity(tx, {
        organizationId: application.organizationId,
        candidateId: application.candidateId,
        applicationId,
        type: 'STAGE_CHANGED',
        summary: `Moved from ${from.name} to ${to.name}`,
        relatedId: to.id,
        actorUserId: actor,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_APPLICATION_STAGE_CHANGED',
        entityType: 'RecruitmentApplication',
        entityId: applicationId,
        context,
        metadata: {
          organizationId: application.organizationId,
          fromStageId: from.id,
          toStageId: to.id,
        },
      });
      return {
        id: applicationId,
        stage: { id: to.id, name: to.name, kind: to.kind },
      };
    });
  }

  /** Structured human screening; no automated score is ever computed. */
  async recordScreening(
    applicationId: string,
    input: ScreeningInput,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const values = {
      outcome: input.outcome,
      meetsMinimumQualifications: input.meetsMinimumQualifications ?? null,
      workAuthorizationConfirmed: input.workAuthorizationConfirmed ?? null,
      requiredCertificationsHeld: input.requiredCertificationsHeld ?? null,
      availableFrom: optionalDate(input.availableFrom, 'availableFrom'),
      notes: parseText(input.notes, 'notes'),
      screenedByUserId: actor,
      screenedAt: this.clock.now(),
    };
    return this.prisma.$transaction(async (tx) => {
      const application = await this.lockedForManage(tx, actor, applicationId);
      this.requireLive(application.status);
      const row = await tx.recruitmentScreening.upsert({
        where: { applicationId },
        create: { applicationId, ...values },
        update: values,
      });
      await recordActivity(tx, {
        organizationId: application.organizationId,
        candidateId: application.candidateId,
        applicationId,
        type: 'SCREENING_RECORDED',
        summary: `Screening recorded (${values.outcome.replaceAll('_', ' ').toLowerCase()})`,
        actorUserId: actor,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_SCREENING_RECORDED',
        entityType: 'RecruitmentApplication',
        entityId: applicationId,
        context,
        metadata: {
          organizationId: application.organizationId,
          outcome: values.outcome,
        },
      });
      return screeningShape(row);
    });
  }

  async withdraw(
    applicationId: string,
    reason: string,
    context: RecruitmentRequestContext,
  ) {
    return this.close(applicationId, 'WITHDRAWN', reason, context);
  }

  async reject(
    applicationId: string,
    reason: string,
    context: RecruitmentRequestContext,
  ) {
    return this.close(applicationId, 'REJECTED', reason, context);
  }

  private async close(
    applicationId: string,
    status: 'WITHDRAWN' | 'REJECTED',
    reason: string,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(reason, 'reason', { required: true, max: 2000 })!;
    return this.prisma.$transaction(async (tx) => {
      const application = await this.lockedForManage(tx, actor, applicationId);
      this.requireLive(application.status);
      const now = this.clock.now();
      // The open offer (if any) is withdrawn and scheduled interviews are cancelled with it.
      const openOffers = await tx.recruitmentOffer.findMany({
        where: { applicationId, status: { in: OPEN_OFFER } },
      });
      for (const offer of openOffers) {
        await tx.recruitmentOffer.update({
          where: { id: offer.id },
          data: {
            status: 'WITHDRAWN',
            withdrawnAt: now,
            withdrawalReason:
              status === 'WITHDRAWN'
                ? 'Application withdrawn'
                : 'Application rejected',
          },
        });
        await recordActivity(tx, {
          organizationId: application.organizationId,
          candidateId: application.candidateId,
          applicationId,
          type: 'OFFER_WITHDRAWN',
          summary: 'Offer withdrawn (application closed)',
          relatedId: offer.id,
          actorUserId: actor,
        });
      }
      const cancelled = await tx.recruitmentInterview.updateMany({
        where: { applicationId, status: 'SCHEDULED' },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancellationReason: 'Application closed',
        },
      });
      await tx.recruitmentApplication.update({
        where: { id: applicationId },
        data: {
          status,
          dispositionReason: note,
          dispositionAt: now,
          dispositionByUserId: actor,
        },
      });
      await recordActivity(tx, {
        organizationId: application.organizationId,
        candidateId: application.candidateId,
        applicationId,
        type:
          status === 'WITHDRAWN'
            ? 'APPLICATION_WITHDRAWN'
            : 'APPLICATION_REJECTED',
        summary:
          status === 'WITHDRAWN'
            ? 'Candidate withdrew'
            : 'Application rejected',
        actorUserId: actor,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action:
          status === 'WITHDRAWN'
            ? 'RECRUITMENT_APPLICATION_WITHDRAWN'
            : 'RECRUITMENT_APPLICATION_REJECTED',
        entityType: 'RecruitmentApplication',
        entityId: applicationId,
        context,
        metadata: {
          organizationId: application.organizationId,
          from: application.status,
          offersWithdrawn: openOffers.length,
          interviewsCancelled: cancelled.count,
        },
      });
      return { id: applicationId, status };
    });
  }

  /** Locks the opening then the application (the shared order) and checks manage access. */
  async lockedForManage(
    tx: Tx,
    actor: string,
    applicationId: string,
    permission:
      | 'recruitment.manage'
      | 'recruitment.offer.approve'
      | 'recruitment.hire' = 'recruitment.manage',
  ) {
    const row = await tx.recruitmentApplication.findUnique({
      where: { id: applicationId },
      select: { openingId: true },
    });
    if (!row) throw new NotFoundException('Application not found.');
    await lockOpening(tx, row.openingId);
    await lockApplication(tx, applicationId);
    const access = await this.access.requireApplicationManage(
      actor,
      applicationId,
      tx,
      permission,
    );
    return Object.assign(access.application, { access });
  }

  requireLive(status: RecruitmentApplicationStatus) {
    if (!LIVE_APPLICATION.includes(status)) {
      throw conflict(
        'RECRUITMENT_APPLICATION_CLOSED',
        'The application is closed.',
        { status },
      );
    }
  }
}

export type ApplicationRow = Prisma.RecruitmentApplicationGetPayload<object>;
