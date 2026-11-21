import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import { domainRequestContext } from '../calendar/holiday.controller.js';
import { RecruitmentAccessService } from './recruitment-access.service.js';
import { RecruitmentApplicationService } from './recruitment-application.service.js';
import { RecruitmentCandidateService } from './recruitment-candidate.service.js';
import { RecruitmentDashboardService } from './recruitment-dashboard.service.js';
import { RecruitmentHireService } from './recruitment-hire.service.js';
import { RecruitmentIntakeService } from './recruitment-intake.service.js';
import { RecruitmentInterviewService } from './recruitment-interview.service.js';
import { RecruitmentOfferService } from './recruitment-offer.service.js';
import { RecruitmentOpeningService } from './recruitment-opening.service.js';
import { RecruitmentOptionsService } from './recruitment-options.service.js';
import { RecruitmentStageService } from './recruitment-stage.service.js';
import {
  AddDocumentDto,
  ApplicationQueryDto,
  AssignOpeningDto,
  CandidateQueryDto,
  ConvertToEmployeeDto,
  CreateApplicationDto,
  CreateCandidateDto,
  CreateIntakeSourceDto,
  CreateOfferDto,
  CreateOpeningDto,
  CreateStageDto,
  FeedbackDto,
  ImportSubmissionsDto,
  InitializeStagesDto,
  InternalEmployeeDto,
  InterviewerDto,
  IntakeQueueQueryDto,
  MergeCandidateDto,
  MoveStageDto,
  OpeningQueryDto,
  OrganizationQueryDto,
  ReasonDto,
  ReorderStagesDto,
  RecruitmentOptionQueryDto,
  RequiredReasonDto,
  RescheduleInterviewDto,
  ScheduleInterviewDto,
  ScreeningDto,
  UpdateCandidateDto,
  UpdateIntakeSourceDto,
  UpdateOfferDto,
  UpdateOpeningDto,
  UpdateStageDto,
} from './recruitment.dto.js';
import { RATE_LIMITS, RateLimit } from '../rate-limit/rate-limit.js';

const OPENING_ACTIONS = {
  open: 'open',
  hold: 'hold',
  resume: 'resume',
  close: 'close',
  cancel: 'cancel',
} as const;
const OFFER_ACTIONS = {
  approve: 'approve',
  revise: 'revise',
  send: 'send',
  accept: 'accept',
  decline: 'decline',
  withdraw: 'withdraw',
} as const;

/**
 * Phase 13 — Recruitment / ATS. Every route is authenticated; authorization (recruitment.*
 * scoped through the opening, the explicit hiring manager and interviewers, and Core HR's
 * employee.manage for hire conversion) is decided in the services.
 */
@Controller('recruitment')
@UseGuards(AccessTokenGuard)
export class RecruitmentController {
  constructor(
    private readonly access: RecruitmentAccessService,
    private readonly stages: RecruitmentStageService,
    private readonly openings: RecruitmentOpeningService,
    private readonly dashboardService: RecruitmentDashboardService,
    private readonly optionsService: RecruitmentOptionsService,
  ) {}

  /** Batch 7A — picker options for the opening form and interview scheduling. */
  @Get('options')
  options(
    @Query() query: RecruitmentOptionQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.optionsService.options(identity.userId, query);
  }

  @Get('organizations')
  organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return this.access.organizations(identity.userId);
  }

  @Get('dashboard')
  dashboard(
    @Query() query: OrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.dashboardService.dashboard(
      identity.userId,
      query.organizationId,
    );
  }

  // ─── Stages ───────────────────────────────────────────────────────────────

  @Get('stages')
  listStages(
    @Query() query: OrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.stages.list(
      identity.userId,
      query.organizationId,
      query.includeArchived,
    );
  }

  @Post('stages')
  createStage(
    @Body() body: CreateStageDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.stages.create(body, domainRequestContext(identity, request));
  }

  @Post('stages/initialize')
  initializeStages(
    @Body() body: InitializeStagesDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.stages.initializeDefaults(
      body.organizationId,
      domainRequestContext(identity, request),
    );
  }

  @Post('stages/reorder')
  reorderStages(
    @Body() body: ReorderStagesDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.stages.reorder(
      body.organizationId,
      body.stageIds,
      domainRequestContext(identity, request),
    );
  }

  @Patch('stages/:stageId')
  updateStage(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() body: UpdateStageDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.stages.update(
      stageId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('stages/:stageId/archive')
  archiveStage(
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.stages.archive(
      stageId,
      domainRequestContext(identity, request),
    );
  }

  // ─── Openings ─────────────────────────────────────────────────────────────

  @Get('openings')
  listOpenings(
    @Query() query: OpeningQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.openings.list(identity.userId, query.organizationId, {
      status: query.status,
      search: query.search,
    });
  }

  @Post('openings')
  createOpening(
    @Body() body: CreateOpeningDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.openings.create(body, domainRequestContext(identity, request));
  }

  @Get('openings/:openingId')
  opening(
    @Param('openingId', ParseUUIDPipe) openingId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.openings.detail(identity.userId, openingId);
  }

  @Patch('openings/:openingId')
  updateOpening(
    @Param('openingId', ParseUUIDPipe) openingId: string,
    @Body() body: UpdateOpeningDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.openings.update(
      openingId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('openings/:openingId/:action')
  transitionOpening(
    @Param('openingId', ParseUUIDPipe) openingId: string,
    @Param('action', new ParseEnumPipe(OPENING_ACTIONS))
    action: keyof typeof OPENING_ACTIONS,
    @Body() body: ReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.openings.transition(
      openingId,
      action,
      body.reason,
      domainRequestContext(identity, request),
    );
  }
}

@Controller('recruitment')
@UseGuards(AccessTokenGuard)
export class RecruitmentCandidateController {
  constructor(
    private readonly candidates: RecruitmentCandidateService,
    private readonly applications: RecruitmentApplicationService,
    private readonly offers: RecruitmentOfferService,
    private readonly hires: RecruitmentHireService,
  ) {}

  // ─── Candidates ───────────────────────────────────────────────────────────

  @Get('candidates')
  listCandidates(
    @Query() query: CandidateQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.candidates.list(identity.userId, query.organizationId, {
      search: query.search,
      includeMerged: query.includeMerged,
    });
  }

  @Post('candidates')
  createCandidate(
    @Body() body: CreateCandidateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.candidates.create(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('candidates/:candidateId')
  candidate(
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.candidates.detail(identity.userId, candidateId);
  }

  @Patch('candidates/:candidateId')
  updateCandidate(
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @Body() body: UpdateCandidateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.candidates.update(
      candidateId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Put('candidates/:candidateId/internal-employee')
  internalEmployee(
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @Body() body: InternalEmployeeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.candidates.setInternalEmployee(
      candidateId,
      body.employeeId,
      domainRequestContext(identity, request),
    );
  }

  @Post('candidates/:candidateId/archive')
  archiveCandidate(
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.candidates.archive(
      candidateId,
      domainRequestContext(identity, request),
    );
  }

  @Post('candidates/:candidateId/merge')
  mergeCandidate(
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @Body() body: MergeCandidateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.candidates.merge(
      candidateId,
      body.intoCandidateId,
      domainRequestContext(identity, request),
    );
  }

  @Post('candidates/:candidateId/documents')
  addDocument(
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @Body() body: AddDocumentDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.candidates.addDocument(
      candidateId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('documents/:documentId/remove')
  removeDocument(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() body: RequiredReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.candidates.removeDocument(
      documentId,
      body.reason,
      domainRequestContext(identity, request),
    );
  }

  // ─── Applications ─────────────────────────────────────────────────────────

  @Get('applications')
  listApplications(
    @Query() query: ApplicationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.applications.list(identity.userId, query.organizationId, query);
  }

  @Post('applications')
  createApplication(
    @Body() body: CreateApplicationDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.applications.create(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('applications/:applicationId')
  application(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.applications.detail(identity.userId, applicationId);
  }

  @Post('applications/:applicationId/stage')
  moveStage(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() body: MoveStageDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.applications.moveStage(
      applicationId,
      body.stageId,
      body.note,
      domainRequestContext(identity, request),
    );
  }

  @Put('applications/:applicationId/screening')
  screening(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() body: ScreeningDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.applications.recordScreening(
      applicationId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('applications/:applicationId/withdraw')
  withdraw(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() body: RequiredReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.applications.withdraw(
      applicationId,
      body.reason,
      domainRequestContext(identity, request),
    );
  }

  @Post('applications/:applicationId/reject')
  reject(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() body: RequiredReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.applications.reject(
      applicationId,
      body.reason,
      domainRequestContext(identity, request),
    );
  }

  // ─── Offers and hire conversion ───────────────────────────────────────────

  @Post('applications/:applicationId/offers')
  createOffer(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() body: CreateOfferDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.offers.create(
      applicationId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Patch('offers/:offerId')
  updateOffer(
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Body() body: UpdateOfferDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.offers.update(
      offerId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('offers/:offerId/:action')
  offerAction(
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Param('action', new ParseEnumPipe(OFFER_ACTIONS))
    action: keyof typeof OFFER_ACTIONS,
    @Body() body: ReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.offers.act(
      offerId,
      action,
      body.reason,
      domainRequestContext(identity, request),
    );
  }

  @Post('applications/:applicationId/hire')
  hire(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() body: ConvertToEmployeeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.hires.convert(
      applicationId,
      body,
      domainRequestContext(identity, request),
    );
  }
}

@Controller('recruitment')
@UseGuards(AccessTokenGuard)
export class RecruitmentInterviewController {
  constructor(private readonly interviews: RecruitmentInterviewService) {}

  @Get('me/interviews')
  myInterviews(@AuthUser() identity: AuthenticatedIdentity) {
    return this.interviews.mine(identity.userId);
  }

  @Post('applications/:applicationId/interviews')
  schedule(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Body() body: ScheduleInterviewDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.interviews.schedule(
      applicationId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Patch('interviews/:interviewId')
  reschedule(
    @Param('interviewId', ParseUUIDPipe) interviewId: string,
    @Body() body: RescheduleInterviewDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.interviews.reschedule(
      interviewId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('interviews/:interviewId/complete')
  complete(
    @Param('interviewId', ParseUUIDPipe) interviewId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.interviews.conclude(
      interviewId,
      'COMPLETED',
      null,
      domainRequestContext(identity, request),
    );
  }

  @Post('interviews/:interviewId/no-show')
  noShow(
    @Param('interviewId', ParseUUIDPipe) interviewId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.interviews.conclude(
      interviewId,
      'NO_SHOW',
      null,
      domainRequestContext(identity, request),
    );
  }

  @Post('interviews/:interviewId/cancel')
  cancel(
    @Param('interviewId', ParseUUIDPipe) interviewId: string,
    @Body() body: RequiredReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.interviews.conclude(
      interviewId,
      'CANCELLED',
      body.reason,
      domainRequestContext(identity, request),
    );
  }

  @Post('interviews/:interviewId/interviewers')
  addInterviewer(
    @Param('interviewId', ParseUUIDPipe) interviewId: string,
    @Body() body: InterviewerDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.interviews.addInterviewer(
      interviewId,
      body.userId,
      domainRequestContext(identity, request),
    );
  }

  @Delete('interviews/:interviewId/interviewers/:userId')
  removeInterviewer(
    @Param('interviewId', ParseUUIDPipe) interviewId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.interviews.removeInterviewer(
      interviewId,
      userId,
      domainRequestContext(identity, request),
    );
  }

  @Get('interviews/:interviewId/feedback')
  feedbackHistory(
    @Param('interviewId', ParseUUIDPipe) interviewId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.interviews.feedbackHistory(identity.userId, interviewId);
  }

  @Put('interviews/:interviewId/feedback/me')
  saveFeedback(
    @Param('interviewId', ParseUUIDPipe) interviewId: string,
    @Body() body: FeedbackDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.interviews.saveFeedback(
      interviewId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('interviews/:interviewId/feedback/me/submit')
  submitFeedback(
    @Param('interviewId', ParseUUIDPipe) interviewId: string,
    @Body() body: FeedbackDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.interviews.submitFeedback(
      interviewId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('feedback/:feedbackId/reopen')
  reopenFeedback(
    @Param('feedbackId', ParseUUIDPipe) feedbackId: string,
    @Body() body: RequiredReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.interviews.reopenFeedback(
      feedbackId,
      body.reason,
      domainRequestContext(identity, request),
    );
  }
}

@Controller('recruitment')
@UseGuards(AccessTokenGuard)
export class RecruitmentIntakeController {
  constructor(private readonly intake: RecruitmentIntakeService) {}

  @Get('intake-sources')
  sources(
    @Query() query: OrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.intake.sources(identity.userId, query.organizationId);
  }

  @Post('intake-sources')
  createSource(
    @Body() body: CreateIntakeSourceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.intake.createSource(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Patch('intake-sources/:sourceId')
  updateSource(
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Body() body: UpdateIntakeSourceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.intake.updateSource(
      sourceId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('intake-sources/:sourceId/archive')
  archiveSource(
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.intake.archiveSource(
      sourceId,
      domainRequestContext(identity, request),
    );
  }

  /** The same ingestion contract a provider synchronization uses. */
  @Post('intake-sources/:sourceId/import')
  @RateLimit(...RATE_LIMITS.intakeImport)
  import(
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Body() body: ImportSubmissionsDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.intake.ingest(
      sourceId,
      body.submissions,
      'IMPORT',
      identity.userId,
    );
  }

  @Get('intake')
  queue(
    @Query() query: IntakeQueueQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.intake.queue(
      identity.userId,
      query.organizationId,
      query.status,
      { sourceId: query.sourceId, limit: query.limit, afterId: query.afterId },
    );
  }

  @Post('intake/:submissionId/assign-opening')
  assignOpening(
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() body: AssignOpeningDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.intake.assignOpening(
      submissionId,
      body.openingId,
      domainRequestContext(identity, request),
    );
  }

  @Post('intake/:submissionId/reject')
  rejectSubmission(
    @Param('submissionId', ParseUUIDPipe) submissionId: string,
    @Body() body: RequiredReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.intake.rejectSubmission(
      submissionId,
      body.reason,
      domainRequestContext(identity, request),
    );
  }
}
