import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import { domainRequestContext } from '../calendar/holiday.controller.js';
import { PerformanceHistoryService } from './performance-history.service.js';
import { PerformanceReviewLifecycleService } from './performance-review-lifecycle.service.js';
import { PerformanceReviewService } from './performance-review.service.js';
import {
  AcknowledgeReviewDto,
  CloseReviewDto,
  CorrectReviewDto,
  PerformanceOrganizationQueryDto,
  ReassignReviewerDto,
  ReopenReviewDto,
  SaveAnswersDto,
  AttentionQueryDto,
} from './performance.dto.js';

const answers = (body: SaveAnswersDto) => ({
  answers: body.answers.map((answer) => ({
    itemId: answer.itemId,
    ratingValue: answer.ratingValue,
    numericValue: answer.numericValue,
    booleanValue: answer.booleanValue,
    textValue: answer.textValue,
  })),
  overallRatingValue: body.overallRatingValue,
});

/**
 * Reviews: the employee writes the self part, the assigned reviewer (or HR with
 * performance.manage) the reviewer part; HR reassigns reviewers and reopens parts. What each
 * viewer sees is decided by the service.
 */
@Controller('performance')
@UseGuards(AccessTokenGuard)
export class PerformanceReviewController {
  constructor(
    private readonly reviews: PerformanceReviewService,
    private readonly lifecycle: PerformanceReviewLifecycleService,
    private readonly history: PerformanceHistoryService,
  ) {}

  @Get('me/reviews')
  mine(@AuthUser() identity: AuthenticatedIdentity) {
    return this.history.mine(identity.userId);
  }

  @Get('employees/:employeeId/reviews')
  forEmployee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.history.forEmployee(identity.userId, employeeId);
  }

  @Get('attention')
  attention(
    @Query() query: AttentionQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.history.attention(identity.userId, query.organizationId, {
      cycleId: query.cycleId,
      flag: query.flag,
      limit: query.limit,
      afterId: query.afterId,
    });
  }

  @Post('reviews/:reviewId/finalize')
  finalize(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.finalize(
      reviewId,
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/acknowledge')
  acknowledge(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: AcknowledgeReviewDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.acknowledge(
      reviewId,
      { comment: body.comment },
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/close')
  close(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: CloseReviewDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.close(
      reviewId,
      { reason: body.reason },
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/correct')
  correct(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: CorrectReviewDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.lifecycle.correct(
      reviewId,
      {
        answers: body.answers?.map((answer) => ({
          itemId: answer.itemId,
          ratingValue: answer.ratingValue,
          numericValue: answer.numericValue,
          booleanValue: answer.booleanValue,
          textValue: answer.textValue,
        })),
        overallRatingValue: body.overallRatingValue,
        reason: body.reason,
      },
      domainRequestContext(identity, request),
    );
  }

  @Get('reviewing')
  queue(@AuthUser() identity: AuthenticatedIdentity) {
    return this.reviews.queue(identity.userId);
  }

  @Get('reviews/:reviewId')
  detail(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.reviews.detail(identity.userId, reviewId);
  }

  @Post('reviews/:reviewId/self')
  saveSelf(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: SaveAnswersDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.reviews.saveAnswers(
      reviewId,
      'SELF',
      answers(body),
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/self/submit')
  submitSelf(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.reviews.submit(
      reviewId,
      'SELF',
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/reviewer')
  saveReviewer(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: SaveAnswersDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.reviews.saveAnswers(
      reviewId,
      'REVIEWER',
      answers(body),
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/reviewer/submit')
  submitReviewer(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.reviews.submit(
      reviewId,
      'REVIEWER',
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/reviewer-assignment')
  reassign(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: ReassignReviewerDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.reviews.reassignReviewer(
      reviewId,
      { reviewerEmployeeId: body.reviewerEmployeeId, reason: body.reason },
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/reopen')
  reopen(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: ReopenReviewDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.reviews.reopen(
      reviewId,
      body.part,
      { reason: body.reason },
      domainRequestContext(identity, request),
    );
  }
}
