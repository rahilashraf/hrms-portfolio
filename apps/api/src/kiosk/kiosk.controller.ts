import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { RefreshCookieService } from '../auth/refresh-cookie.service.js';
import type { TimeRequestContext } from '../time/time.service.js';
import { AttendanceDeviceService } from './attendance-device.service.js';
import { AttendanceKioskService } from './attendance-kiosk.service.js';
import { KioskDeviceGuard, type KioskRequest } from './kiosk-device.guard.js';
import {
  KioskActionDto,
  KioskCancelDto,
  KioskEnrollDto,
  KioskIdentifyDto,
} from './kiosk.dto.js';
import { KioskRateLimiterService } from './kiosk-rate-limiter.service.js';
import {
  KIOSK_COOKIE_MAX_AGE_MS,
  KIOSK_COOKIE_NAME,
  KIOSK_COOKIE_PATH,
} from './kiosk-secrets.js';
import { RATE_LIMITS, RateLimit } from '../rate-limit/rate-limit.js';

function requestContext(request: Request): TimeRequestContext {
  return {
    ipAddress: request.ip,
    userAgent: request.get('user-agent') ?? undefined,
    correlationId: request.get('x-correlation-id') ?? undefined,
  };
}

/**
 * Phase 9.5 — the onsite attendance kiosk API. Authenticated by the device (httpOnly cookie,
 * issued at enrollment), never by a user session; responses are never cached.
 */
@Controller('kiosk')
@RateLimit(...RATE_LIMITS.kioskDevice)
export class KioskController {
  private readonly secure: boolean;

  constructor(
    private readonly kiosk: AttendanceKioskService,
    private readonly devices: AttendanceDeviceService,
    private readonly limiter: KioskRateLimiterService,
    private readonly origins: RefreshCookieService,
    config: ConfigService,
  ) {
    this.secure = config.getOrThrow<string>('NODE_ENV') === 'production';
  }

  /** At the physical device: a one-time enrollment code becomes the device secret (cookie). */
  @Post('enroll')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async enroll(
    @Body() body: KioskEnrollDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.origins.assertAllowedOrigin(request.get('origin') ?? undefined);
    await this.limiter.assertEnrollAllowed(request.ip ?? 'unknown');
    const context = requestContext(request);
    const { secret } = await this.devices.enroll(body.enrollmentCode, context);
    response.cookie(KIOSK_COOKIE_NAME, secret, {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'strict',
      path: KIOSK_COOKIE_PATH,
      maxAge: KIOSK_COOKIE_MAX_AGE_MS,
    });
    return this.kiosk.session(await this.devices.authenticate(secret, context));
  }

  @Get('session')
  @UseGuards(KioskDeviceGuard)
  @Header('Cache-Control', 'no-store')
  session(@Req() request: KioskRequest) {
    return this.kiosk.session(request.kioskDevice!);
  }

  @Post('identify')
  @HttpCode(200)
  @UseGuards(KioskDeviceGuard)
  @Header('Cache-Control', 'no-store')
  identify(@Body() body: KioskIdentifyDto, @Req() request: KioskRequest) {
    return this.kiosk.identify(
      this.device(request),
      body,
      requestContext(request),
    );
  }

  @Post('actions')
  @HttpCode(200)
  @UseGuards(KioskDeviceGuard)
  @Header('Cache-Control', 'no-store')
  act(@Body() body: KioskActionDto, @Req() request: KioskRequest) {
    return this.kiosk.act(this.device(request), body, requestContext(request));
  }

  @Post('cancel')
  @HttpCode(200)
  @UseGuards(KioskDeviceGuard)
  @Header('Cache-Control', 'no-store')
  cancel(@Body() body: KioskCancelDto, @Req() request: KioskRequest) {
    return this.kiosk.cancel(this.device(request), body.token);
  }

  private device(request: KioskRequest) {
    const device = request.kioskDevice!;
    return {
      id: device.id,
      organizationId: device.organizationId,
      physicalSiteId: device.physicalSiteId,
    };
  }
}
