import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { RefreshCookieService } from '../auth/refresh-cookie.service.js';
import { AttendanceDeviceService } from './attendance-device.service.js';
import { KIOSK_COOKIE_NAME } from './kiosk-secrets.js';

export type KioskRequest = Request & {
  kioskDevice?: Awaited<ReturnType<AttendanceDeviceService['authenticate']>>;
};

/**
 * Authenticates a kiosk request by its device secret (httpOnly cookie) and only from the web
 * application's origin (the cookie is sent automatically, so cross-site requests are refused).
 * There is no user here: the device acts for the employee who identifies at it.
 */
@Injectable()
export class KioskDeviceGuard implements CanActivate {
  constructor(
    private readonly devices: AttendanceDeviceService,
    private readonly origins: RefreshCookieService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<KioskRequest>();
    this.origins.assertAllowedOrigin(request.get('origin') ?? undefined);
    const cookies = request.cookies as Record<string, string> | undefined;
    request.kioskDevice = await this.devices.authenticate(
      cookies?.[KIOSK_COOKIE_NAME],
      {
        ipAddress: request.ip,
        userAgent: request.get('user-agent') ?? undefined,
      },
    );
    return true;
  }
}
