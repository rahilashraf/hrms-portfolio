import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { PerformanceEvidenceService } from './performance-evidence.service.js';
import {
  CorrectEvidenceDto,
  CreateEvidenceSourceDto,
  ImportEvidenceDto,
  IntakeQueryDto,
  LinkEvidenceDto,
  PerformanceOrganizationQueryDto,
  ReasonDto,
  RecordEvidenceDto,
  RemapEvidenceDto,
  ResolveIntakeDto,
  UpdateEvidenceSourceDto,
  EvidenceStatusQueryDto,
} from './performance.dto.js';

/**
 * Performance evidence. Sources, imports, manual records, corrections and unmatched results
 * need performance.evidence.manage at the organization; reading follows performance.read on
 * the employee (or the employee themselves); linking into a review is the reviewer's or HR's.
 * The import endpoint is the same ingestion contract a provider synchronization uses.
 */
@Controller('performance')
@UseGuards(AccessTokenGuard)
export class PerformanceEvidenceController {
  constructor(private readonly evidence: PerformanceEvidenceService) {}

  @Get('evidence-sources')
  sources(
    @Query() query: PerformanceOrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.evidence.sources(
      identity.userId,
      query.organizationId,
      query.includeArchived,
    );
  }

  @Post('evidence-sources')
  createSource(
    @Body() body: CreateEvidenceSourceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.evidence.createSource(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Patch('evidence-sources/:sourceId')
  updateSource(
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Body() body: UpdateEvidenceSourceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.evidence.updateSource(
      sourceId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('evidence-sources/:sourceId/archive')
  archiveSource(
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.evidence.archiveSource(
      sourceId,
      domainRequestContext(identity, request),
    );
  }

  @Post('evidence-sources/:sourceId/import')
  import(
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Body() body: ImportEvidenceDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.evidence.ingest(
      sourceId,
      body.results.map((result) => ({
        externalResultId: result.externalResultId,
        employeeId: result.employeeId,
        employmentAssignmentId: result.employmentAssignmentId,
        respondentEmail: result.respondentEmail,
        respondentReference: result.respondentReference,
        title: result.title,
        completedAt: result.completedAt,
        score: result.score,
        maxScore: result.maxScore,
        passed: result.passed,
        resultUrl: result.resultUrl,
        externalUpdatedAt: result.externalUpdatedAt,
        withdrawn: result.withdrawn,
      })),
      'IMPORT',
      identity.userId,
    );
  }

  @Get('evidence-intake')
  intake(
    @Query() query: IntakeQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.evidence.intake(
      identity.userId,
      query.organizationId,
      query.status,
      { sourceId: query.sourceId, limit: query.limit, afterId: query.afterId },
    );
  }

  @Post('evidence-intake/:intakeId/resolve')
  resolve(
    @Param('intakeId', ParseUUIDPipe) intakeId: string,
    @Body() body: ResolveIntakeDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.evidence.resolveIntake(
      intakeId,
      body.action === 'MATCH'
        ? {
            action: 'MATCH',
            employeeId: body.employeeId!,
            employmentAssignmentId: body.employmentAssignmentId,
            note: body.note,
          }
        : { action: 'REJECT', note: body.note ?? '' },
      domainRequestContext(identity, request),
    );
  }

  @Get('me/evidence')
  mine(
    @Query() query: EvidenceStatusQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.evidence.mine(identity.userId, query.status, query);
  }

  @Get('employees/:employeeId/evidence')
  forEmployee(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: EvidenceStatusQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.evidence.forEmployee(
      identity.userId,
      employeeId,
      query.status,
      query,
    );
  }

  @Post('evidence')
  record(
    @Body() body: RecordEvidenceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.evidence.recordManual(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Get('evidence/:evidenceId/history')
  history(
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.evidence.history(identity.userId, evidenceId);
  }

  @Post('evidence/:evidenceId/correct')
  correct(
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body() body: CorrectEvidenceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.evidence.correct(
      evidenceId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('evidence/:evidenceId/remap')
  remap(
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body() body: RemapEvidenceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.evidence.remap(
      evidenceId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('evidence/:evidenceId/withdraw')
  withdraw(
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body() body: ReasonDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.evidence.withdraw(
      evidenceId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/evidence')
  link(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Body() body: LinkEvidenceDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.evidence.link(
      reviewId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('reviews/:reviewId/evidence/:linkId/unlink')
  unlink(
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.evidence.unlink(
      reviewId,
      linkId,
      domainRequestContext(identity, request),
    );
  }
}
