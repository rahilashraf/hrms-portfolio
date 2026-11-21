import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

export interface AuthenticatedIdentity {
  userId: string;
  sessionId: string;
}

export const AuthUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedIdentity => {
    const request = context
      .switchToHttp()
      .getRequest<Request & { auth?: AuthenticatedIdentity }>();
    if (!request.auth) {
      throw new UnauthorizedException();
    }
    return request.auth;
  },
);
