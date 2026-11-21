import { Injectable } from '@nestjs/common';
import { addDays } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { RecruitmentAccessService } from './recruitment-access.service.js';
import {
  candidateDisplayName,
  isoDate,
  RecruitmentClock,
  recruitmentToday,
} from './recruitment-common.js';
import { offerIsExpired } from './recruitment-domain.js';

const STALE_DAYS = 14;
const EXPIRING_DAYS = 3;

/**
 * Phase 13 — the recruitment dashboard: openings, the live pipeline per stage and attention
 * items, over the openings the user reads (recruitment.read / manage). Attention items are
 * computed on read (never by a job): overdue interview feedback, offers awaiting approval or
 * close to expiry, accepted offers not yet converted, stale applications, openings past their
 * closing date and unmatched external submissions. They are also the boundary a future
 * notification phase consumes for reminders.
 */
@Injectable()
export class RecruitmentDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RecruitmentAccessService,
    private readonly clock: RecruitmentClock,
  ) {}

  async dashboard(userId: string, organizationId: string) {
    await this.access.requireConfigurationRead(userId, organizationId);
    const { items, grants, user } = await this.access.visibleOpenings(
      userId,
      organizationId,
    );
    const readable = items.filter(({ access }) => access.canRead);
    const openingIds = readable.map(({ opening }) => opening.id);
    const now = this.clock.now();
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const today = recruitmentToday(now, organization.timezone);
    const openingsByStatus: Record<string, number> = {};
    for (const { opening } of readable) {
      openingsByStatus[opening.status] =
        (openingsByStatus[opening.status] ?? 0) + 1;
    }
    const stages = await this.prisma.recruitmentStage.findMany({
      where: { organizationId, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const live = await this.prisma.recruitmentApplication.findMany({
      where: {
        openingId: { in: openingIds },
        status: { in: ['ACTIVE', 'OFFERED'] },
      },
      include: {
        candidate: true,
        opening: { select: { id: true, title: true, code: true } },
        stage: { select: { name: true } },
      },
    });
    const visibleLive = live.filter(
      (row) => !this.access.isSelf(user, row.candidate),
    );
    const pipeline = readable
      .filter(
        ({ opening }) =>
          opening.status === 'OPEN' || opening.status === 'ON_HOLD',
      )
      .map(({ opening }) => ({
        opening: {
          id: opening.id,
          code: opening.code,
          title: opening.title,
          status: opening.status,
          openingCount: opening.openingCount,
          hiredCount: opening.hiredCount,
        },
        stages: stages.map((stage) => ({
          stageId: stage.id,
          name: stage.name,
          count: visibleLive.filter(
            (row) => row.openingId === opening.id && row.stageId === stage.id,
          ).length,
        })),
      }));
    const app = (row: (typeof visibleLive)[number]) => ({
      applicationId: row.id,
      candidate: candidateDisplayName(row.candidate),
      opening: row.opening,
    });
    const interviews = await this.prisma.recruitmentInterview.findMany({
      where: {
        application: { openingId: { in: openingIds } },
        status: { in: ['SCHEDULED', 'COMPLETED'] },
      },
      include: {
        interviewers: { where: { removedAt: null } },
        feedback: { where: { supersededAt: null, status: 'SUBMITTED' } },
        application: {
          include: {
            candidate: true,
            opening: { select: { id: true, title: true, code: true } },
          },
        },
      },
    });
    const overdueFeedback = interviews
      .filter(
        (interview) =>
          !this.access.isSelf(user, interview.application.candidate),
      )
      .filter(
        (interview) => interview.feedbackDueAt && interview.feedbackDueAt < now,
      )
      .map((interview) => ({
        interviewId: interview.id,
        applicationId: interview.applicationId,
        title: interview.title,
        candidate: candidateDisplayName(interview.application.candidate),
        opening: interview.application.opening,
        feedbackDueAt: interview.feedbackDueAt!.toISOString(),
        missing: interview.interviewers.filter(
          (interviewer) =>
            !interview.feedback.some(
              (feedback) => feedback.interviewerUserId === interviewer.userId,
            ),
        ).length,
      }))
      .filter((row) => row.missing > 0);
    const upcomingInterviews = interviews
      .filter(
        (interview) =>
          !this.access.isSelf(user, interview.application.candidate),
      )
      .filter(
        (interview) =>
          interview.status === 'SCHEDULED' &&
          interview.scheduledStart >= now &&
          interview.scheduledStart < new Date(now.getTime() + 7 * 86_400_000),
      )
      .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime())
      .map((interview) => ({
        interviewId: interview.id,
        applicationId: interview.applicationId,
        title: interview.title,
        candidate: candidateDisplayName(interview.application.candidate),
        scheduledStart: interview.scheduledStart.toISOString(),
      }));
    const offers = await this.prisma.recruitmentOffer.findMany({
      where: {
        application: { openingId: { in: openingIds } },
        status: { in: ['DRAFT', 'APPROVED', 'SENT', 'ACCEPTED'] },
      },
      include: {
        application: {
          include: {
            candidate: true,
            opening: { select: { id: true, title: true, code: true } },
            hire: true,
          },
        },
      },
    });
    const visibleOffers = offers.filter(
      (offer) => !this.access.isSelf(user, offer.application.candidate),
    );
    const offerRow = (offer: (typeof visibleOffers)[number]) => ({
      offerId: offer.id,
      applicationId: offer.applicationId,
      candidate: candidateDisplayName(offer.application.candidate),
      opening: offer.application.opening,
      status: offer.status,
      expiresOn: isoDate(offer.expiresOn),
    });
    const canIntake = this.access.canInOrganization(
      grants,
      'recruitment.intake.manage',
      organizationId,
    );
    return {
      today: isoDate(today),
      openings: { byStatus: openingsByStatus, total: readable.length },
      pipeline,
      attention: {
        overdueFeedback,
        upcomingInterviews,
        offersAwaitingApproval: visibleOffers
          .filter((offer) => offer.status === 'DRAFT')
          .map(offerRow),
        offersExpiringSoon: visibleOffers
          .filter(
            (offer) =>
              offer.status === 'SENT' &&
              offer.expiresOn !== null &&
              (offerIsExpired(offer, today) ||
                offer.expiresOn <= addDays(today, EXPIRING_DAYS)),
          )
          .map((offer) => ({
            ...offerRow(offer),
            expired: offerIsExpired(offer, today),
          })),
        acceptedNotHired: visibleOffers
          .filter(
            (offer) =>
              offer.status === 'ACCEPTED' &&
              !offer.application.hire &&
              offer.application.status === 'OFFERED',
          )
          .map(offerRow),
        staleApplications: visibleLive
          .filter(
            (row) =>
              row.status === 'ACTIVE' &&
              row.stageEnteredAt < addDays(now, -STALE_DAYS),
          )
          .map((row) => ({
            ...app(row),
            stage: row.stage.name,
            since: row.stageEnteredAt.toISOString(),
          })),
        openingsPastClose: readable
          .filter(
            ({ opening }) =>
              opening.status === 'OPEN' &&
              opening.closesOn &&
              opening.closesOn < today,
          )
          .map(({ opening }) => ({
            openingId: opening.id,
            code: opening.code,
            title: opening.title,
            closesOn: isoDate(opening.closesOn),
          })),
        pendingIntake: canIntake
          ? await this.prisma.recruitmentIntakeSubmission.count({
              where: { organizationId, status: 'PENDING_OPENING' },
            })
          : null,
      },
    };
  }
}
