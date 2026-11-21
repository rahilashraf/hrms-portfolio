import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { requireActor } from '../common/domain-support.js';
import {
  parseCurrency,
  parsePayBasis,
  parseRateAmount,
} from '../compensation/compensation-domain.js';
import { PrismaService } from '../database/prisma.service.js';
import { FeatureGateService } from '../features/feature-gate.service.js';
import type {
  CompensationPayBasis,
  EmploymentType,
  Prisma,
  RecruitmentOffer,
  RecruitmentOfferStatus,
} from '../generated/prisma/client.js';
import { RecruitmentApplicationService } from './recruitment-application.service.js';
import {
  conflict,
  isUniqueViolation,
  lockOffer,
  optionalDate,
  RecruitmentClock,
  recordActivity,
  recruitmentToday,
  writeRecruitmentAudit,
  type RecruitmentRequestContext,
  type Tx,
} from './recruitment-common.js';
import {
  canMoveOffer,
  invalid,
  offerIsExpired,
  parseText,
} from './recruitment-domain.js';
import { offerShape } from './recruitment-shapes.js';

export interface OfferInput {
  positionId: string;
  workLocationId?: string | null;
  employmentType: EmploymentType;
  startDate: string;
  payBasis: CompensationPayBasis;
  rateAmount: string;
  currency: string;
  expiresOn?: string | null;
  candidateTerms?: string | null;
  internalNotes?: string | null;
}

type OfferAction =
  'approve' | 'revise' | 'send' | 'accept' | 'decline' | 'withdraw';

const ACTION_TARGET: Record<OfferAction, RecruitmentOfferStatus> = {
  approve: 'APPROVED',
  revise: 'DRAFT',
  send: 'SENT',
  accept: 'ACCEPTED',
  decline: 'DECLINED',
  withdraw: 'WITHDRAWN',
};

const ACTIVITY: Partial<
  Record<OfferAction, Prisma.RecruitmentActivityCreateInput['type']>
> = {
  approve: 'OFFER_APPROVED',
  revise: 'OFFER_REVISED',
  send: 'OFFER_SENT',
  accept: 'OFFER_ACCEPTED',
  decline: 'OFFER_DECLINED',
  withdraw: 'OFFER_WITHDRAWN',
};

/**
 * Phase 13 — offers. Draft → approved (recruitment.offer.approve, never by the person who
 * would be hired) → sent → accepted / declined (recorded by the recruiter on the candidate's
 * behalf), or withdrawn / expired. Terms lock once approved (an approved offer is revised by
 * returning it to draft). Expiry is date-derived; the expiry job only records it. An offer is
 * not a CompensationRecord: hire conversion may initialize compensation from it.
 */
@Injectable()
export class RecruitmentOfferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: RecruitmentClock,
    private readonly applications: RecruitmentApplicationService,
  ) {}

  async create(
    applicationId: string,
    input: OfferInput,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const application = await this.applications.lockedForManage(
          tx,
          actor,
          applicationId,
        );
        if (application.status !== 'ACTIVE') {
          throw conflict(
            'RECRUITMENT_APPLICATION_NOT_ACTIVE',
            'Offers are made on active applications.',
          );
        }
        if (application.opening.status !== 'OPEN') {
          throw conflict(
            'RECRUITMENT_OPENING_NOT_OPEN',
            'The opening is not open.',
          );
        }
        const open = await tx.recruitmentOffer.count({
          where: {
            applicationId,
            status: { in: ['DRAFT', 'APPROVED', 'SENT'] },
          },
        });
        if (open > 0) {
          throw conflict(
            'RECRUITMENT_OFFER_IN_PROGRESS',
            'The application already has an offer in progress.',
          );
        }
        const values = await this.values(
          tx,
          application.organizationId,
          input,
          null,
        );
        const row = await tx.recruitmentOffer.create({
          data: {
            ...values,
            organizationId: application.organizationId,
            applicationId,
            createdByUserId: actor,
          },
        });
        await recordActivity(tx, {
          organizationId: application.organizationId,
          candidateId: application.candidateId,
          applicationId,
          type: 'OFFER_CREATED',
          summary: 'Offer drafted',
          relatedId: row.id,
          actorUserId: actor,
        });
        await writeRecruitmentAudit(this.audit, tx, {
          action: 'RECRUITMENT_OFFER_CREATED',
          entityType: 'RecruitmentOffer',
          entityId: row.id,
          context,
          metadata: {
            organizationId: application.organizationId,
            applicationId,
            positionId: row.positionId,
          },
        });
        return offerShape(
          row,
          await this.today(tx, application.organizationId),
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          'RECRUITMENT_OFFER_IN_PROGRESS',
          'The application already has an offer in progress.',
        );
      }
      throw error;
    }
  }

  async update(
    offerId: string,
    input: Partial<OfferInput>,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const { offer, application } = await this.locked(
        tx,
        actor,
        offerId,
        'recruitment.manage',
      );
      if (offer.status !== 'DRAFT') {
        throw conflict(
          'RECRUITMENT_OFFER_LOCKED',
          'Only a draft offer is edited; return an approved offer to draft first.',
        );
      }
      const values = await this.values(
        tx,
        application.organizationId,
        input,
        offer,
      );
      const row = await tx.recruitmentOffer.update({
        where: { id: offerId },
        data: values,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_OFFER_UPDATED',
        entityType: 'RecruitmentOffer',
        entityId: offerId,
        context,
        metadata: {
          organizationId: application.organizationId,
          fields: Object.keys(input).filter(
            (key) => input[key as keyof OfferInput] !== undefined,
          ),
        },
      });
      return offerShape(row, await this.today(tx, application.organizationId));
    });
  }

  async act(
    offerId: string,
    action: OfferAction,
    reason: string | null | undefined,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(reason, 'reason', { max: 2000 });
    if ((action === 'withdraw' || action === 'decline') && !note) {
      invalid('RECRUITMENT_REASON_REQUIRED', 'A reason is required.');
    }
    return this.prisma.$transaction(async (tx) => {
      const { offer, application } = await this.locked(
        tx,
        actor,
        offerId,
        action === 'approve'
          ? 'recruitment.offer.approve'
          : 'recruitment.manage',
      );
      const to = ACTION_TARGET[action];
      const today = await this.today(tx, application.organizationId);
      if (offerIsExpired(offer, today) && action !== 'withdraw') {
        throw conflict('RECRUITMENT_OFFER_EXPIRED', 'The offer has expired.');
      }
      if (!canMoveOffer(offer.status, to)) {
        throw conflict(
          'RECRUITMENT_OFFER_TRANSITION_INVALID',
          `A ${offer.status.toLowerCase()} offer cannot be ${action === 'revise' ? 'returned to draft' : `${action}${action.endsWith('e') ? 'd' : 'ed'}`}.`,
          { status: offer.status },
        );
      }
      if (action === 'send') {
        if (application.status !== 'ACTIVE') {
          throw conflict(
            'RECRUITMENT_APPLICATION_NOT_ACTIVE',
            'Offers are sent on active applications.',
          );
        }
        if (offer.expiresOn && offer.expiresOn.getTime() < today.getTime()) {
          throw conflict(
            'RECRUITMENT_OFFER_EXPIRED',
            'The acceptance deadline has passed; revise the offer.',
          );
        }
      }
      const now = this.clock.now();
      const data: Prisma.RecruitmentOfferUncheckedUpdateInput = { status: to };
      if (action === 'approve')
        Object.assign(data, { approvedAt: now, approvedByUserId: actor });
      if (action === 'revise')
        Object.assign(data, { approvedAt: null, approvedByUserId: null });
      if (action === 'send')
        Object.assign(data, { sentAt: now, sentByUserId: actor });
      if (action === 'accept' || action === 'decline') {
        Object.assign(data, {
          respondedAt: now,
          responseRecordedByUserId: actor,
          ...(action === 'decline' ? { declineReason: note } : {}),
        });
      }
      if (action === 'withdraw')
        Object.assign(data, { withdrawnAt: now, withdrawalReason: note });
      const row = await tx.recruitmentOffer.update({
        where: { id: offerId },
        data,
      });
      // The application is OFFERED while a sent or accepted offer stands.
      if (action === 'send') {
        await tx.recruitmentApplication.update({
          where: { id: application.id },
          data: { status: 'OFFERED' },
        });
      }
      if (
        (action === 'decline' || action === 'withdraw') &&
        offer.status === 'SENT' &&
        application.status === 'OFFERED'
      ) {
        await tx.recruitmentApplication.update({
          where: { id: application.id },
          data: { status: 'ACTIVE' },
        });
      }
      await recordActivity(tx, {
        organizationId: application.organizationId,
        candidateId: application.candidateId,
        applicationId: application.id,
        type: ACTIVITY[action]!,
        summary: {
          approve: 'Offer approved',
          revise: 'Offer returned to draft for revision',
          send: 'Offer sent to the candidate',
          accept: 'Offer accepted',
          decline: 'Offer declined',
          withdraw: 'Offer withdrawn',
        }[action],
        relatedId: offerId,
        actorUserId: actor,
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: `RECRUITMENT_OFFER_${to}`,
        entityType: 'RecruitmentOffer',
        entityId: offerId,
        context,
        metadata: {
          organizationId: application.organizationId,
          from: offer.status,
          to,
        },
      });
      return offerShape(row, today);
    });
  }

  /**
   * Records the expiry of sent offers past their acceptance day (worker job; idempotent).
   * Correctness never depends on it: expired offers already read as EXPIRED and cannot be
   * accepted.
   */
  async expireDue(): Promise<{
    scanned: number;
    expired: number;
    failed: Array<{ offerId: string; message: string }>;
    skippedOrganizations: string[];
  }> {
    const now = this.clock.now();
    // Phase 18: organizations with Recruitment disabled are skipped (reported).
    const skippedOrganizations = [
      ...(await new FeatureGateService(this.prisma).disabledOrganizations(
        'RECRUITMENT',
      )),
    ].sort();
    const candidates = await this.prisma.recruitmentOffer.findMany({
      where: {
        status: 'SENT',
        expiresOn: { not: null },
        organizationId: { notIn: skippedOrganizations },
      },
      include: {
        application: {
          include: { opening: { include: { organization: true } } },
        },
      },
    });
    const due = candidates.filter((offer) =>
      offerIsExpired(
        offer,
        recruitmentToday(now, offer.application.opening.organization.timezone),
      ),
    );
    const outcome = {
      scanned: candidates.length,
      expired: 0,
      failed: [] as Array<{ offerId: string; message: string }>,
      skippedOrganizations,
    };
    for (const offer of due) {
      try {
        const changed = await this.prisma.$transaction(async (tx) => {
          const { openingId } = offer.application;
          await tx.$queryRawUnsafe(
            `SELECT "id" FROM "JobOpening" WHERE "id" = $1::uuid FOR NO KEY UPDATE`,
            openingId,
          );
          await tx.$queryRawUnsafe(
            `SELECT "id" FROM "RecruitmentApplication" WHERE "id" = $1::uuid FOR NO KEY UPDATE`,
            offer.applicationId,
          );
          await lockOffer(tx, offer.id);
          const current = await tx.recruitmentOffer.findUniqueOrThrow({
            where: { id: offer.id },
          });
          if (current.status !== 'SENT') return false;
          await tx.recruitmentOffer.update({
            where: { id: offer.id },
            data: { status: 'EXPIRED', expiredAt: now },
          });
          const application = await tx.recruitmentApplication.findUniqueOrThrow(
            { where: { id: offer.applicationId } },
          );
          if (application.status === 'OFFERED') {
            await tx.recruitmentApplication.update({
              where: { id: application.id },
              data: { status: 'ACTIVE' },
            });
          }
          await recordActivity(tx, {
            organizationId: application.organizationId,
            candidateId: application.candidateId,
            applicationId: application.id,
            type: 'OFFER_EXPIRED',
            summary: 'Offer expired without a response',
            relatedId: offer.id,
          });
          await writeRecruitmentAudit(this.audit, tx, {
            action: 'RECRUITMENT_OFFER_EXPIRED',
            entityType: 'RecruitmentOffer',
            entityId: offer.id,
            context: {},
            metadata: {
              organizationId: application.organizationId,
              expiresOn: current.expiresOn?.toISOString().slice(0, 10),
            },
          });
          return true;
        });
        if (changed) outcome.expired += 1;
      } catch (error) {
        outcome.failed.push({
          offerId: offer.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcome;
  }

  private async locked(
    tx: Tx,
    actor: string,
    offerId: string,
    permission: 'recruitment.manage' | 'recruitment.offer.approve',
  ) {
    const existing = await tx.recruitmentOffer.findUnique({
      where: { id: offerId },
      select: { applicationId: true },
    });
    if (!existing) throw new NotFoundException('Offer not found.');
    const application = await this.applications.lockedForManage(
      tx,
      actor,
      existing.applicationId,
      permission,
    );
    if (application.access.view !== 'FULL')
      throw new NotFoundException('Offer not found.');
    await lockOffer(tx, offerId);
    const offer = await tx.recruitmentOffer.findUniqueOrThrow({
      where: { id: offerId },
    });
    return { offer, application };
  }

  private async today(tx: Tx, organizationId: string) {
    const organization = await tx.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return recruitmentToday(this.clock.now(), organization?.timezone);
  }

  private async values(
    tx: Tx,
    organizationId: string,
    input: Partial<OfferInput>,
    current: RecruitmentOffer | null,
  ) {
    const data: Prisma.RecruitmentOfferUncheckedUpdateInput &
      Record<string, unknown> = {};
    if (input.positionId !== undefined || !current) {
      const position = input.positionId
        ? await tx.position.findUnique({ where: { id: input.positionId } })
        : null;
      if (
        !position ||
        position.organizationId !== organizationId ||
        position.archivedAt
      ) {
        invalid(
          'RECRUITMENT_POSITION_INVALID',
          'The position is not an active position of the organization.',
        );
      }
      data.positionId = position.id;
      if (input.workLocationId === undefined && !current)
        data.workLocationId = position.workLocationId;
    }
    if (input.workLocationId !== undefined) {
      if (input.workLocationId) {
        const location = await tx.workLocation.findUnique({
          where: { id: input.workLocationId },
        });
        if (!location || location.organizationId !== organizationId) {
          invalid(
            'RECRUITMENT_PLACEMENT_INVALID',
            'The work location does not belong to the organization.',
          );
        }
      }
      data.workLocationId = input.workLocationId ?? null;
    }
    if (input.employmentType !== undefined || !current)
      data.employmentType = input.employmentType;
    if (input.startDate !== undefined || !current) {
      if (!input.startDate)
        invalid('RECRUITMENT_DATE_INVALID', 'startDate is required.');
      data.startDate = optionalDate(input.startDate, 'startDate')!;
    }
    if (input.payBasis !== undefined || !current)
      data.payBasis = parsePayBasis(input.payBasis);
    if (input.rateAmount !== undefined || !current)
      data.rateAmount = parseRateAmount(input.rateAmount).decimal;
    if (input.currency !== undefined || !current)
      data.currency = parseCurrency(input.currency);
    if (input.expiresOn !== undefined) {
      const expiresOn = optionalDate(input.expiresOn, 'expiresOn');
      if (
        expiresOn &&
        expiresOn.getTime() < (await this.today(tx, organizationId)).getTime()
      ) {
        invalid(
          'RECRUITMENT_OFFER_EXPIRY_INVALID',
          'The acceptance deadline is in the past.',
        );
      }
      data.expiresOn = expiresOn;
    }
    if (input.candidateTerms !== undefined)
      data.candidateTerms = parseText(input.candidateTerms, 'candidateTerms');
    if (input.internalNotes !== undefined)
      data.internalNotes = parseText(input.internalNotes, 'internalNotes');
    return data as Prisma.RecruitmentOfferUncheckedCreateInput &
      Prisma.RecruitmentOfferUncheckedUpdateInput;
  }
}
