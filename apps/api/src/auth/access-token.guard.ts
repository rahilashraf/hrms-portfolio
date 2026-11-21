import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SessionsService } from '../sessions/sessions.service.js';
import {
  AccessTokenService,
  AccessTokenIdentity,
} from './access-token.service.js';
import { ALLOW_DURING_PASSWORD_CHANGE } from './allow-during-password-change.decorator.js';
import { domainError } from '../common/domain-support.js';

type AuthenticatedRequest = Request & { auth?: AccessTokenIdentity };

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly sessions: SessionsService,
    private readonly reflector: Reflector = new Reflector(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer ([^\s]+)$/);
    if (!match) {
      throw new UnauthorizedException();
    }

    let identity: AccessTokenIdentity;
    try {
      identity = await this.accessTokens.verify(match[1]!);
    } catch {
      throw new UnauthorizedException();
    }

    const activeSession = await this.sessions.findActiveByIdAndUser(
      identity.sessionId,
      identity.userId,
      new Date(),
    );
    if (!activeSession) {
      throw new UnauthorizedException();
    }
    // Batch 2: a required password change blocks everything but the routes needed to make it.
    if (
      activeSession.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(ALLOW_DURING_PASSWORD_CHANGE, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      throw new ForbiddenException(
        domainError(
          403,
          'PASSWORD_CHANGE_REQUIRED',
          'Change your password to continue.',
        ),
      );
    }

    request.auth = identity;
    return true;
  }
}
