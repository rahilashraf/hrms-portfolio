import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AuthUser } from '../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../auth/auth-user.decorator.js';
import { domainRequestContext } from '../calendar/holiday.controller.js';
import {
  filtersOf,
  OrganizationQueryDto,
  ReportKeyParam,
  ReportQueryDto,
} from './reporting.dto.js';
import { ReportingService } from './reporting.service.js';
import { RATE_LIMITS, RateLimit } from '../rate-limit/rate-limit.js';

/**
 * Phase 17 — Reporting & Analytics. Every route is authenticated; authorization (report.read /
 * report.export together with each report's source-domain read permission, per scope) is decided
 * in the services. Reports are aggregates computed at request time from the domain tables.
 */
@Controller('reports')
@UseGuards(AccessTokenGuard)
export class ReportingController {
  constructor(private readonly reports: ReportingService) {}

  @Get('organizations')
  organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return this.reports.organizations(identity.userId);
  }

  @Get('catalog')
  catalog(
    @Query() query: OrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.reports.catalog(identity.userId, query.organizationId);
  }

  @Get(':reportKey/export.csv')
  @RateLimit(...RATE_LIMITS.reportCsvExport)
  async exportCsv(
    @Param() params: ReportKeyParam,
    @Query() query: ReportQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.reports.exportCsv(
      params.reportKey,
      query.organizationId,
      filtersOf(query),
      domainRequestContext(identity, request),
    );
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName}"`,
    );
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Batch 4F (Q9): a capped export is never presented as complete.
    response.setHeader('X-Report-Truncated', file.truncated ? 'true' : 'false');
    return file.content;
  }

  @Post(':reportKey/export/google-sheets')
  @RateLimit(...RATE_LIMITS.reportSheetsExport)
  @HttpCode(201)
  exportGoogleSheets(
    @Param() params: ReportKeyParam,
    @Body() body: ReportQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.reports.exportGoogleSheets(
      params.reportKey,
      body.organizationId,
      filtersOf(body),
      domainRequestContext(identity, request),
    );
  }

  @Get(':reportKey')
  run(
    @Param() params: ReportKeyParam,
    @Query() query: ReportQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.reports.run(
      identity.userId,
      params.reportKey,
      query.organizationId,
      filtersOf(query),
    );
  }
}
