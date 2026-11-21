import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, jwtVerify } from 'jose';

export interface AccessTokenIdentity {
  userId: string;
  sessionId: string;
}

@Injectable()
export class AccessTokenService {
  private readonly secret: Uint8Array;

  constructor(config: ConfigService) {
    this.secret = new TextEncoder().encode(
      config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    );
  }

  issue(identity: AccessTokenIdentity): Promise<string> {
    return new SignJWT({ sid: identity.sessionId, type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(identity.userId)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(this.secret);
  }

  async verify(token: string): Promise<AccessTokenIdentity> {
    const { payload } = await jwtVerify(token, this.secret, {
      algorithms: ['HS256'],
    });

    if (
      payload.type !== 'access' ||
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number'
    ) {
      throw new Error('Invalid access token claims');
    }

    return { userId: payload.sub, sessionId: payload.sid };
  }
}
