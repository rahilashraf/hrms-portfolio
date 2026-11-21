import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';

export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_GRACE_PERIOD_MS = 30 * 1000;

export interface CreateSessionInput {
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateSessionInput) {
    return this.prisma.authSession.create({ data: input });
  }

  generateRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  findRefreshSession(refreshTokenHash: string) {
    return this.prisma.authSession.findFirst({
      where: {
        OR: [
          { refreshTokenHash },
          { previousRefreshTokenHash: refreshTokenHash },
        ],
      },
      include: {
        user: {
          select: {
            id: true,
            personId: true,
            email: true,
            status: true,
            archivedAt: true,
            mustChangePassword: true,
            emailVerifiedAt: true,
          },
        },
      },
    });
  }

  rotateCurrentToken(
    id: string,
    currentTokenHash: string,
    nextTokenHash: string,
    now: Date,
  ) {
    return this.prisma.authSession.updateMany({
      where: {
        id,
        refreshTokenHash: currentTokenHash,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        previousRefreshTokenHash: currentTokenHash,
        previousTokenValidUntil: new Date(
          now.getTime() + REFRESH_GRACE_PERIOD_MS,
        ),
        refreshTokenHash: nextTokenHash,
        lastUsedAt: now,
      },
    });
  }

  revokeExpiredPreviousToken(id: string, tokenHash: string, now: Date) {
    return this.prisma.authSession.updateMany({
      where: {
        id,
        previousRefreshTokenHash: tokenHash,
        previousTokenValidUntil: { lte: now },
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        revokedAt: now,
        revokedReason: 'refresh_token_reuse',
      },
    });
  }

  revokeAllActive(userId: string, now: Date) {
    return this.prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        revokedAt: now,
        revokedReason: 'logout_all',
      },
    });
  }

  /**
   * The request's session when it is still usable (not revoked or expired, user ACTIVE), with
   * whether the user must change their password before using anything else.
   */
  async findActiveByIdAndUser(id: string, userId: string, now: Date) {
    const session = await this.prisma.authSession.findFirst({
      where: {
        id,
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
        user: {
          status: 'ACTIVE',
          archivedAt: null,
        },
      },
      select: { id: true, user: { select: { mustChangePassword: true } } },
    });
    return session
      ? { id: session.id, mustChangePassword: session.user.mustChangePassword }
      : null;
  }

  findByRefreshTokenHash(refreshTokenHash: string) {
    return this.prisma.authSession.findUnique({
      where: { refreshTokenHash },
    });
  }

  markUsed(id: string, lastUsedAt = new Date()) {
    return this.prisma.authSession.update({
      where: { id },
      data: { lastUsedAt },
    });
  }

  revoke(id: string, revokedReason: string, revokedAt = new Date()) {
    return this.prisma.authSession.update({
      where: { id },
      data: { revokedAt, revokedReason },
    });
  }
}
