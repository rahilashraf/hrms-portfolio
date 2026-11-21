import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
import { NotificationsAccessService } from './notifications-access.service.js';
import { NotificationService } from './notification.service.js';
import { NotificationDeliveryLogService } from './notification-delivery-log.service.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { NotificationTemplateService } from './notification-template.service.js';
import {
  CreateTemplateDto,
  DeliveryLogQueryDto,
  InboxQueryDto,
  OrganizationQueryDto,
  OrganizationSettingsDto,
  PreferencesDto,
  PreviewQueryDto,
  ReadAllDto,
  TemplateListQueryDto,
  UpdateTemplateDto,
} from './notifications.dto.js';
import { RATE_LIMITS, RateLimit } from '../rate-limit/rate-limit.js';

/**
 * Phase 16 — Notifications. Every route is authenticated. /me routes act on the caller's own
 * notifications and preferences only (anybody else's notification is not found); templates
 * and organization settings need notification.template.manage / notification.settings.manage
 * at organization scope; the read-only delivery log (Batch 8) notification.delivery.read.
 */
@Controller('notifications')
@UseGuards(AccessTokenGuard)
export class NotificationsController {
  constructor(
    private readonly access: NotificationsAccessService,
    private readonly notifications: NotificationService,
    private readonly templates: NotificationTemplateService,
    private readonly settings: NotificationSettingsService,
    private readonly deliveryLog: NotificationDeliveryLogService,
  ) {}

  // ─── The caller's inbox ───────────────────────────────────────────────────

  @Get('me')
  mine(
    @Query() query: InboxQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.notifications.mine(identity.userId, query);
  }

  @Get('me/unread-count')
  unreadCount(@AuthUser() identity: AuthenticatedIdentity) {
    return this.notifications.unreadCount(identity.userId);
  }

  @Post('me/read-all')
  @RateLimit(...RATE_LIMITS.notificationsReadAll)
  @HttpCode(200)
  readAll(
    @Body() body: ReadAllDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.notifications.markAllRead(
      domainRequestContext(identity, request),
      body.organizationId,
    );
  }

  @Get('me/preferences')
  preferences(@AuthUser() identity: AuthenticatedIdentity) {
    return this.settings.preferences(identity.userId);
  }

  @Put('me/preferences')
  updatePreferences(
    @Body() body: PreferencesDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.settings.updatePreferences(
      body.preferences,
      domainRequestContext(identity, request),
    );
  }

  @Post('me/:notificationId/read')
  @HttpCode(200)
  read(
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.notifications.markRead(
      notificationId,
      domainRequestContext(identity, request),
    );
  }

  @Post('me/:notificationId/archive')
  @HttpCode(200)
  archive(
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.notifications.archive(
      notificationId,
      domainRequestContext(identity, request),
    );
  }

  // ─── Organization administration ──────────────────────────────────────────

  @Get('organizations')
  organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return this.access.organizations(identity.userId);
  }

  @Get('templates')
  listTemplates(
    @Query() query: TemplateListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.templates.list(
      identity.userId,
      query.organizationId,
      query.includeArchived,
    );
  }

  @Get('templates/preview')
  preview(
    @Query() query: PreviewQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.templates.preview(identity.userId, query);
  }

  @Post('templates')
  createTemplate(
    @Body() body: CreateTemplateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.create(body, domainRequestContext(identity, request));
  }

  @Patch('templates/:templateId')
  updateTemplate(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() body: UpdateTemplateDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.update(
      templateId,
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('templates/:templateId/archive')
  @HttpCode(200)
  archiveTemplate(
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.templates.archive(
      templateId,
      domainRequestContext(identity, request),
    );
  }

  @Get('settings')
  organizationSettings(
    @Query() query: OrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.settings.organizationSettings(
      identity.userId,
      query.organizationId,
    );
  }

  @Put('settings')
  updateOrganizationSettings(
    @Body() body: OrganizationSettingsDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.settings.updateOrganizationSettings(
      body,
      domainRequestContext(identity, request),
    );
  }

  // ─── Batch 8: delivery log (read-only) ────────────────────────────────────

  @Get('deliveries')
  deliveries(
    @Query() query: DeliveryLogQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.deliveryLog.list(identity.userId, query);
  }

  @Get('deliveries/:deliveryId')
  delivery(
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.deliveryLog.detail(identity.userId, deliveryId);
  }
}
