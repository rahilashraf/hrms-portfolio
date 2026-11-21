import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard } from '../../auth/access-token.guard.js';
import { AuthUser } from '../../auth/auth-user.decorator.js';
import type { AuthenticatedIdentity } from '../../auth/auth-user.decorator.js';
import { domainRequestContext } from '../../calendar/holiday.controller.js';
import {
  GoogleConnectionService,
  OAUTH_CALLBACK_COOKIE,
  OAuthCompletionError,
} from './google-connection.service.js';
import { GoogleFormBindingService } from './google-form-binding.service.js';
import { GoogleSyncService } from './google-sync.service.js';
import { GoogleWorkspaceAccessService } from './google-workspace-access.service.js';
import {
  GOOGLE_WORKSPACE_SETTINGS,
  type GoogleWorkspaceSettings,
} from './google-workspace-common.js';
import {
  BindingListQueryDto,
  CreateBindingDto,
  OAuthCompleteDto,
  OAuthStartDto,
  OrganizationBodyDto,
  OrganizationQueryDto,
  plainMapping,
  ServiceAccountDto,
  SyncRunsQueryDto,
  UpdateBindingDto,
} from './google-workspace.dto.js';
import { RATE_LIMITS, RateLimit } from '../../rate-limit/rate-limit.js';

const CALLBACK_COOKIE_PATH = '/integrations/google/oauth';

function cookieOptions(settings: GoogleWorkspaceSettings) {
  return {
    httpOnly: true,
    secure: settings.production,
    sameSite: 'lax' as const,
    path: CALLBACK_COOKIE_PATH,
  };
}

/**
 * Phase 16.5 — Google Workspace integration administration. Every route is authenticated;
 * integration.google.read reads status, bindings and runs, integration.google.manage changes
 * anything (both at organization scope). Responses never contain tokens, keys or verifiers.
 */
@Controller('integrations/google')
@UseGuards(AccessTokenGuard)
export class GoogleWorkspaceController {
  constructor(
    private readonly access: GoogleWorkspaceAccessService,
    private readonly connections: GoogleConnectionService,
    private readonly bindings: GoogleFormBindingService,
    private readonly sync: GoogleSyncService,
    @Inject(GOOGLE_WORKSPACE_SETTINGS)
    private readonly settings: GoogleWorkspaceSettings,
  ) {}

  @Get('organizations')
  organizations(@AuthUser() identity: AuthenticatedIdentity) {
    return this.access.organizations(identity.userId);
  }

  @Get('status')
  status(
    @Query() query: OrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.connections.status(identity.userId, query.organizationId);
  }

  @Post('oauth/start')
  @RateLimit(...RATE_LIMITS.googleOAuth)
  @HttpCode(200)
  async startOAuth(
    @Body() body: OAuthStartDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const started = await this.connections.startOAuth(
      body,
      domainRequestContext(identity, request),
    );
    // Binds the callback to this browser (the state alone is not enough).
    response.cookie(OAUTH_CALLBACK_COOKIE, started.browserNonce, {
      ...cookieOptions(this.settings),
      maxAge: 10 * 60_000,
    });
    return {
      authorizationUrl: started.authorizationUrl,
      expiresAt: started.expiresAt,
    };
  }

  /** Completion by the web app (alternative to the redirect callback): same initiating user only. */
  @Post('oauth/complete')
  @RateLimit(...RATE_LIMITS.googleOAuth)
  @HttpCode(200)
  async completeOAuth(
    @Body() body: OAuthCompleteDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    try {
      const result = await this.connections.completeOAuth(
        body,
        { userId: identity.userId },
        domainRequestContext(identity, request),
      );
      return this.connections.status(identity.userId, result.organizationId);
    } catch (error) {
      if (error instanceof OAuthCompletionError) throw error.toHttp();
      throw error;
    }
  }

  @Post('service-account')
  @HttpCode(200)
  connectServiceAccount(
    @Body() body: ServiceAccountDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.connections.connectServiceAccount(
      body,
      domainRequestContext(identity, request),
    );
  }

  @Post('disconnect')
  @HttpCode(200)
  disconnect(
    @Body() body: OrganizationBodyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.connections.disconnect(
      body.organizationId,
      domainRequestContext(identity, request),
    );
  }

  @Post('health-check')
  @RateLimit(...RATE_LIMITS.googleManual)
  @HttpCode(200)
  healthCheck(
    @Body() body: OrganizationBodyDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.connections.healthCheck(
      body.organizationId,
      domainRequestContext(identity, request),
    );
  }

  @Get('sources')
  sources(
    @Query() query: OrganizationQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.bindings.sources(identity.userId, query.organizationId);
  }

  @Get('bindings')
  listBindings(
    @Query() query: BindingListQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.bindings.list(
      identity.userId,
      query.organizationId,
      query.includeArchived ?? false,
    );
  }

  @Post('bindings')
  createBinding(
    @Body() body: CreateBindingDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.bindings.create(
      {
        organizationId: body.organizationId,
        formId: body.formId,
        target: body.target,
        performanceSourceId: body.performanceSourceId,
        recruitmentSourceId: body.recruitmentSourceId,
        mapping: plainMapping(body.mapping),
        enabled: body.enabled,
      },
      domainRequestContext(identity, request),
    );
  }

  @Patch('bindings/:bindingId')
  updateBinding(
    @Param('bindingId', ParseUUIDPipe) bindingId: string,
    @Body() body: UpdateBindingDto,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.bindings.update(
      bindingId,
      {
        ...(body.mapping ? { mapping: plainMapping(body.mapping) } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
      domainRequestContext(identity, request),
    );
  }

  @Post('bindings/:bindingId/archive')
  @HttpCode(200)
  archiveBinding(
    @Param('bindingId', ParseUUIDPipe) bindingId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.bindings.archive(
      bindingId,
      domainRequestContext(identity, request),
    );
  }

  @Post('bindings/:bindingId/sync')
  @RateLimit(...RATE_LIMITS.googleManual)
  @HttpCode(200)
  syncBinding(
    @Param('bindingId', ParseUUIDPipe) bindingId: string,
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
  ) {
    return this.sync.syncManually(
      bindingId,
      domainRequestContext(identity, request),
    );
  }

  @Get('sync-runs')
  syncRuns(
    @Query() query: SyncRunsQueryDto,
    @AuthUser() identity: AuthenticatedIdentity,
  ) {
    return this.bindings.runs(identity.userId, query);
  }
}

const QUERY_TEXT = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : null;

/**
 * The OAuth redirect target (GOOGLE_OAUTH_REDIRECT_URI). Google's browser redirect carries no
 * bearer token, so the state is bound to the initiating browser by an HttpOnly cookie set at
 * start (and to the initiating user, recorded on the state). Always redirects to the web admin
 * page on WEB_ORIGIN with a result code — never to a URL taken from the request.
 */
@Controller('integrations/google/oauth')
export class GoogleOAuthCallbackController {
  constructor(
    private readonly connections: GoogleConnectionService,
    @Inject(GOOGLE_WORKSPACE_SETTINGS)
    private readonly settings: GoogleWorkspaceSettings,
  ) {}

  @Get('callback')
  @RateLimit(...RATE_LIMITS.googleOAuthCallback)
  async callback(
    // Google appends parameters of its own (scope, authuser, hd, prompt…): read selectively.
    @Query() query: Record<string, unknown>,
    @Req() request: Request & { cookies?: Record<string, string> },
    @Res() response: Response,
  ) {
    // Google's redirect lands in a browser: always answer with a redirect, never raw JSON.
    if (!this.settings.oauth) {
      response.redirect(
        302,
        this.connections.callbackRedirect({
          ok: false,
          code: 'GOOGLE_OAUTH_NOT_CONFIGURED',
        }),
      );
      return;
    }
    const browserNonce = QUERY_TEXT(
      request.cookies?.[OAUTH_CALLBACK_COOKIE],
      200,
    );
    response.clearCookie(OAUTH_CALLBACK_COOKIE, cookieOptions(this.settings));
    const state = QUERY_TEXT(query.state, 200);
    let target: string;
    if (!state) {
      target = this.connections.callbackRedirect({
        ok: false,
        code: 'OAUTH_STATE_INVALID',
      });
    } else {
      try {
        const result = await this.connections.completeOAuth(
          {
            state,
            code: QUERY_TEXT(query.code, 2000),
            error: QUERY_TEXT(query.error, 200),
          },
          { browserNonce },
          {
            ipAddress: request.ip,
            userAgent: request.get('user-agent') ?? undefined,
            correlationId: request.get('x-correlation-id') ?? undefined,
          },
        );
        target = this.connections.callbackRedirect({
          ok: true,
          organizationId: result.organizationId,
        });
      } catch (error) {
        const code =
          error instanceof OAuthCompletionError
            ? error.code
            : error instanceof HttpException
              ? ((error.getResponse() as { code?: string })?.code ??
                'OAUTH_FAILED')
              : 'OAUTH_FAILED';
        target = this.connections.callbackRedirect({ ok: false, code });
      }
    }
    response.redirect(302, target);
  }
}
