import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type { RequestMetadata } from './auth.service.js';
import { userAgentSummary } from './user-agent-summary.js';

export interface SessionIdentity {
  userId: string;
  sessionId: string;
}

/**
 * Batch 2: a signed-in user's own sessions (one per sign-in). Lists the live ones with a device
 * summary and the address they were opened from (shown to their owner only), and ends one or
 * every other session. Another user's session id answers 404, exactly like an unknown one.
 * Revocation is immediate: every request re-checks its session (AccessTokenGuard).
 */
@Injectable()
export class AccountSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(identity: SessionIdentity, now = new Date()) {
    const sessions = await this.prisma.authSession.findMany({
      where: {
        userId: identity.userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: [{ lastUsedAt: 'desc' }, { id: 'asc' }],
      take: 100,
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        ipAddress: true,
        userAgent: true,
      },
    });
    return {
      items: sessions.map((session) => ({
        id: session.id,
        current: session.id === identity.sessionId,
        createdAt: session.createdAt.toISOString(),
        lastUsedAt: session.lastUsedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        ipAddress: session.ipAddress,
        ...userAgentSummary(session.userAgent),
      })),
    };
  }

  async revoke(
    identity: SessionIdentity,
    sessionId: string,
    metadata: RequestMetadata,
  ) {
    if (sessionId === identity.sessionId) {
      throw new BadRequestException(
        domainError(
          400,
          'CURRENT_SESSION',
          'Use "Sign out" to end the session you are using.',
        ),
      );
    }
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const revoked = await transaction.authSession.updateMany({
        where: {
          id: sessionId,
          userId: identity.userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now, revokedReason: 'user_revoked' },
      });
      if (revoked.count !== 1) {
        throw new NotFoundException(
          domainError(404, 'SESSION_NOT_FOUND', 'Session not found.'),
        );
      }
      await this.audit.write(
        {
          actorUserId: identity.userId,
          action: 'AUTH_SESSION_REVOKED',
          entityType: 'AuthSession',
          entityId: sessionId,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          correlationId: metadata.correlationId,
          metadata: { reasonCode: 'USER_REVOKED' },
        },
        transaction,
      );
    });
    return { success: true as const };
  }

  async revokeOthers(identity: SessionIdentity, metadata: RequestMetadata) {
    const now = new Date();
    const count = await this.prisma.$transaction(async (transaction) => {
      const revoked = await transaction.authSession.updateMany({
        where: {
          userId: identity.userId,
          id: { not: identity.sessionId },
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now, revokedReason: 'user_revoked_others' },
      });
      await this.audit.write(
        {
          actorUserId: identity.userId,
          action: 'AUTH_OTHER_SESSIONS_REVOKED',
          entityType: 'User',
          entityId: identity.userId,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          correlationId: metadata.correlationId,
          metadata: { revokedSessionCount: revoked.count },
        },
        transaction,
      );
      return revoked.count;
    });
    return { success: true as const, revokedSessionCount: count };
  }
}
