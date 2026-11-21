import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';

export const REFRESH_COOKIE_NAME = 'hrms_refresh';
export const REFRESH_COOKIE_PATH = '/auth';
export const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

@Injectable()
export class RefreshCookieService {
  private readonly secure: boolean;
  private readonly webOrigin: string;

  constructor(config: ConfigService) {
    this.secure = config.getOrThrow<string>('NODE_ENV') === 'production';
    this.webOrigin = config.getOrThrow<string>('WEB_ORIGIN');
  }

  set(response: Response, token: string): void {
    response.cookie(REFRESH_COOKIE_NAME, token, {
      ...this.options(),
      maxAge: SESSION_LIFETIME_SECONDS * 1000,
    });
  }

  clear(response: Response): void {
    response.clearCookie(REFRESH_COOKIE_NAME, this.options());
  }

  assertAllowedOrigin(origin: string | undefined): void {
    if (origin !== undefined && origin !== this.webOrigin) {
      throw new ForbiddenException('Untrusted request origin');
    }
  }

  private options(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.secure,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
    };
  }
}
