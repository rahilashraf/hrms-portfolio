import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessTokenGuard } from './access-token.guard.js';
import { AllowDuringPasswordChange } from './allow-during-password-change.decorator.js';
import { AuthUser } from './auth-user.decorator.js';
import type { AuthenticatedIdentity } from './auth-user.decorator.js';
import { AccountSessionsService } from './account-sessions.service.js';
import { AuthService } from './auth.service.js';
import type { RequestMetadata } from './auth.service.js';
import { AcceptInvitationDto } from './dto/accept-invitation.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { ResendVerificationDto } from './dto/resend-verification.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { RATE_LIMITS, RateLimit } from '../rate-limit/rate-limit.js';
import {
  REFRESH_COOKIE_NAME,
  RefreshCookieService,
} from './refresh-cookie.service.js';

type RequestWithCookies = Request & {
  cookies?: Record<string, string | undefined>;
};

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: RefreshCookieService,
    private readonly accountSessions: AccountSessionsService,
  ) {}

  @Post('login')
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('origin') origin?: string,
  ) {
    this.cookies.assertAllowedOrigin(origin);
    const result = await this.auth.login(
      body.email,
      body.password,
      this.metadata(request),
    );
    this.cookies.set(response, result.refreshToken);
    return { accessToken: result.accessToken, identity: result.identity };
  }

  @Post('forgot-password')
  @RateLimit(...RATE_LIMITS.authForgotPassword)
  forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.auth.forgotPassword(body.email);
  }

  @Post('reset-password')
  @RateLimit(...RATE_LIMITS.authResetPassword)
  resetPassword(@Body() body: ResetPasswordDto, @Req() request: Request) {
    return this.auth.resetPassword(
      body.token,
      body.newPassword,
      this.metadata(request),
    );
  }

  @Post('accept-invitation')
  @RateLimit(...RATE_LIMITS.authAcceptInvitation)
  acceptInvitation(@Body() body: AcceptInvitationDto, @Req() request: Request) {
    return this.auth.acceptInvitation(
      body.token,
      body.password,
      this.metadata(request),
    );
  }

  @Post('verify-email')
  @RateLimit(...RATE_LIMITS.authVerifyEmail)
  verifyEmail(@Body() body: VerifyEmailDto, @Req() request: Request) {
    return this.auth.verifyEmail(body.token, this.metadata(request));
  }

  @Post('resend-verification')
  @RateLimit(...RATE_LIMITS.authResendVerification)
  resendVerification(
    @Body() body: ResendVerificationDto,
    @Req() request: Request,
  ) {
    return this.auth.resendVerification(body.email, this.metadata(request));
  }

  @Post('refresh')
  @RateLimit(...RATE_LIMITS.authRefresh)
  async refresh(
    @Req() request: RequestWithCookies,
    @Res({ passthrough: true }) response: Response,
    @Headers('origin') origin?: string,
  ) {
    this.cookies.assertAllowedOrigin(origin);
    const result = await this.auth.refresh(
      request.cookies?.[REFRESH_COOKIE_NAME],
      this.metadata(request),
    );
    if (result.refreshToken) {
      this.cookies.set(response, result.refreshToken);
    }
    return { accessToken: result.accessToken };
  }

  @Post('logout')
  async logout(
    @Req() request: RequestWithCookies,
    @Res({ passthrough: true }) response: Response,
    @Headers('origin') origin?: string,
  ) {
    this.cookies.assertAllowedOrigin(origin);
    await this.auth.logout(
      request.cookies?.[REFRESH_COOKIE_NAME],
      this.metadata(request),
    );
    this.cookies.clear(response);
    return { success: true };
  }

  @Post('logout-all')
  @RateLimit(...RATE_LIMITS.authLogoutAll)
  @UseGuards(AccessTokenGuard)
  @AllowDuringPasswordChange()
  async logoutAll(
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('origin') origin?: string,
  ) {
    this.cookies.assertAllowedOrigin(origin);
    await this.auth.logoutAll(identity.userId, this.metadata(request));
    this.cookies.clear(response);
    return { success: true };
  }

  @Post('change-password')
  @HttpCode(200)
  @RateLimit(...RATE_LIMITS.authChangePassword)
  @UseGuards(AccessTokenGuard)
  @AllowDuringPasswordChange()
  changePassword(
    @AuthUser() identity: AuthenticatedIdentity,
    @Body() body: ChangePasswordDto,
    @Req() request: Request,
  ) {
    return this.auth.changePassword(
      identity,
      body.currentPassword,
      body.newPassword,
      this.metadata(request),
    );
  }

  @Get('sessions')
  @RateLimit(...RATE_LIMITS.authSessions)
  @UseGuards(AccessTokenGuard)
  @AllowDuringPasswordChange()
  sessions(@AuthUser() identity: AuthenticatedIdentity) {
    return this.accountSessions.list(identity);
  }

  @Delete('sessions/:id')
  @RateLimit(...RATE_LIMITS.authSessions)
  @UseGuards(AccessTokenGuard)
  @AllowDuringPasswordChange()
  revokeSession(
    @AuthUser() identity: AuthenticatedIdentity,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
  ) {
    return this.accountSessions.revoke(identity, id, this.metadata(request));
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @RateLimit(...RATE_LIMITS.authSessions)
  @UseGuards(AccessTokenGuard)
  @AllowDuringPasswordChange()
  revokeOtherSessions(
    @AuthUser() identity: AuthenticatedIdentity,
    @Req() request: Request,
    @Headers('origin') origin?: string,
  ) {
    this.cookies.assertAllowedOrigin(origin);
    return this.accountSessions.revokeOthers(identity, this.metadata(request));
  }

  @Get('me')
  @UseGuards(AccessTokenGuard)
  @AllowDuringPasswordChange()
  me(@AuthUser() identity: AuthenticatedIdentity) {
    return this.auth.me(identity.userId);
  }

  private metadata(request: Request): RequestMetadata {
    return {
      ipAddress: request.ip,
      userAgent: request.get('user-agent') || undefined,
      correlationId: request.get('x-correlation-id') || undefined,
    };
  }
}
