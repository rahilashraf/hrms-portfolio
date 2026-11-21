import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { passwordSchema } from '@hrms/validation';
import { AccountTokenType } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { domainError } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { PasswordHasherService } from '../security/password-hasher.service.js';
import {
  REFRESH_GRACE_PERIOD_MS,
  SESSION_LIFETIME_MS,
  SessionsService,
} from '../sessions/sessions.service.js';
import { UsersService } from '../users/users.service.js';
import { AccessTokenService } from './access-token.service.js';
import { AccountEmailService } from './account-email.service.js';
import { AccountTokenService } from './account-token.service.js';
import { AccountRecoveryQueue } from './account-recovery-queue.service.js';
import { LoginRateLimiterService } from './login-rate-limiter.service.js';

const INVALID_CREDENTIALS = 'Invalid email or password';
export {
  EMAIL_VERIFICATION_TOKEN_LIFETIME_MS,
  FAILED_LOGIN_THRESHOLD,
  INVITATION_TOKEN_LIFETIME_MS,
  PASSWORD_RESET_TOKEN_LIFETIME_MS,
  TEMPORARY_LOCK_MS,
} from './auth-constants.js';
import {
  FAILED_LOGIN_THRESHOLD,
  INVITATION_TOKEN_LIFETIME_MS,
  TEMPORARY_LOCK_MS,
} from './auth-constants.js';

export interface RequestMetadata {
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  identity: {
    id: string;
    personId: string;
    email: string;
    status: string;
    emailVerifiedAt: Date | null;
    mustChangePassword: boolean;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly passwords: PasswordHasherService,
    private readonly accessTokens: AccessTokenService,
    private readonly accountTokens: AccountTokenService,
    private readonly emails: AccountEmailService,
    private readonly rateLimiter: LoginRateLimiterService,
    private readonly recovery: AccountRecoveryQueue,
  ) {}

  async login(
    email: string,
    password: string,
    metadata: RequestMetadata,
  ): Promise<LoginResult> {
    await this.rateLimiter.assertLoginAllowed(
      metadata.ipAddress ?? 'unknown',
      email,
    );
    const user = await this.users.findForLogin(email);
    const eligible =
      user?.status === 'ACTIVE' &&
      user.archivedAt === null &&
      user.passwordHash !== null;
    const now = new Date();
    const locked = Boolean(user?.lockedUntil && user.lockedUntil > now);
    const passwordMatches =
      eligible && !locked && user.passwordHash
        ? await this.passwords.verifyPassword(user.passwordHash, password)
        : (await this.passwords.verifyDummyPassword(password), false);

    if (!eligible || !passwordMatches || !user) {
      // Batch 2: failed sign-ins of existing accounts are audited (a reason code, never the
      // address that was typed); unknown addresses leave no trace.
      if (user) {
        await this.audit.write({
          actorUserId: null,
          action: 'AUTH_LOGIN_FAILED',
          entityType: 'User',
          entityId: user.id,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          correlationId: metadata.correlationId,
          metadata: {
            reasonCode: !eligible
              ? 'INACTIVE'
              : locked
                ? 'LOCKED'
                : 'INVALID_PASSWORD',
          },
        });
      }
      if (eligible && !locked && user) {
        const lock = await this.users.recordFailedLogin(
          user.id,
          now,
          FAILED_LOGIN_THRESHOLD,
          TEMPORARY_LOCK_MS,
        );
        if (lock?.lockedUntil) {
          await this.audit.write({
            actorUserId: user.id,
            action: 'AUTH_ACCOUNT_TEMP_LOCKED',
            entityType: 'User',
            entityId: user.id,
            ipAddress: metadata.ipAddress,
            userAgent: metadata.userAgent,
            correlationId: metadata.correlationId,
            metadata: { durationMs: TEMPORARY_LOCK_MS },
          });
        }
      }
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const refreshToken = this.sessions.generateRefreshToken();
    const refreshTokenHash = this.sessions.hashRefreshToken(refreshToken);
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    const session = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.user.updateMany({
        where: {
          id: user.id,
          status: 'ACTIVE',
          archivedAt: null,
          passwordHash: user.passwordHash,
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        },
        data: {
          lastLoginAt: now,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      if (updated.count !== 1) {
        throw new UnauthorizedException(INVALID_CREDENTIALS);
      }
      const created = await transaction.authSession.create({
        data: {
          userId: user.id,
          refreshTokenHash,
          expiresAt,
          lastUsedAt: now,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
        },
      });
      await this.audit.write(
        {
          actorUserId: user.id,
          action: 'AUTH_SESSION_CREATED',
          entityType: 'AuthSession',
          entityId: created.id,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          correlationId: metadata.correlationId,
        },
        transaction,
      );
      await this.audit.write(
        {
          actorUserId: user.id,
          action: 'AUTH_LOGIN_SUCCESS',
          entityType: 'User',
          entityId: user.id,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          correlationId: metadata.correlationId,
        },
        transaction,
      );
      return created;
    });

    return {
      accessToken: await this.accessTokens.issue({
        userId: user.id,
        sessionId: session.id,
      }),
      refreshToken,
      identity: {
        id: user.id,
        personId: user.personId,
        email: user.email,
        status: user.status,
        emailVerifiedAt: user.emailVerifiedAt,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  async refresh(
    token: string | undefined,
    metadata: RequestMetadata,
  ): Promise<{ accessToken: string; refreshToken?: string }> {
    if (!token) {
      throw new UnauthorizedException();
    }
    const now = new Date();
    const tokenHash = this.sessions.hashRefreshToken(token);
    const session = await this.sessions.findRefreshSession(tokenHash);
    if (!session || !this.isActiveSession(session, now)) {
      throw new UnauthorizedException();
    }

    if (session.refreshTokenHash === tokenHash) {
      const nextToken = this.sessions.generateRefreshToken();
      const nextHash = this.sessions.hashRefreshToken(nextToken);
      const rotation = await this.prisma.$transaction(async (transaction) => {
        const updated = await transaction.authSession.updateMany({
          where: {
            id: session.id,
            refreshTokenHash: tokenHash,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: {
            refreshTokenHash: nextHash,
            previousRefreshTokenHash: tokenHash,
            previousTokenValidUntil: new Date(
              now.getTime() + REFRESH_GRACE_PERIOD_MS,
            ),
            lastUsedAt: now,
          },
        });
        // Batch 2 (D2): a routine rotation is not audited (lastUsedAt records activity); reuse
        // detection and revocations still are.
        return updated.count;
      });

      if (rotation === 1) {
        return {
          accessToken: await this.accessTokens.issue({
            userId: session.userId,
            sessionId: session.id,
          }),
          refreshToken: nextToken,
        };
      }

      const racedSession = await this.sessions.findRefreshSession(tokenHash);
      if (
        racedSession &&
        racedSession.refreshTokenHash !== tokenHash &&
        racedSession.previousRefreshTokenHash === tokenHash &&
        racedSession.previousTokenValidUntil &&
        racedSession.previousTokenValidUntil > new Date() &&
        this.isActiveSession(racedSession, new Date())
      ) {
        return {
          accessToken: await this.accessTokens.issue({
            userId: racedSession.userId,
            sessionId: racedSession.id,
          }),
        };
      }
      throw new UnauthorizedException();
    }

    if (
      session.previousRefreshTokenHash === tokenHash &&
      session.previousTokenValidUntil &&
      session.previousTokenValidUntil > now
    ) {
      return {
        accessToken: await this.accessTokens.issue({
          userId: session.userId,
          sessionId: session.id,
        }),
      };
    }

    if (
      session.previousRefreshTokenHash === tokenHash &&
      session.previousTokenValidUntil &&
      session.previousTokenValidUntil <= now
    ) {
      const revoked = await this.prisma.$transaction(async (transaction) => {
        const result = await transaction.authSession.updateMany({
          where: {
            id: session.id,
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
        if (result.count === 1) {
          await this.audit.write(
            {
              actorUserId: session.userId,
              action: 'AUTH_REFRESH_TOKEN_REUSE',
              entityType: 'AuthSession',
              entityId: session.id,
              ipAddress: metadata.ipAddress,
              userAgent: metadata.userAgent,
              correlationId: metadata.correlationId,
              metadata: { reason: 'previous_token_outside_grace' },
            },
            transaction,
          );
          await this.audit.write(
            {
              actorUserId: session.userId,
              action: 'AUTH_SESSION_REVOKED',
              entityType: 'AuthSession',
              entityId: session.id,
              ipAddress: metadata.ipAddress,
              userAgent: metadata.userAgent,
              correlationId: metadata.correlationId,
              metadata: {
                reason: 'refresh_token_reuse',
                reasonCode: 'REFRESH_TOKEN_REUSE',
              },
            },
            transaction,
          );
        }
        return result.count;
      });
      if (revoked === 1) {
        throw new UnauthorizedException();
      }
    }

    throw new UnauthorizedException();
  }

  async logout(token: string | undefined, metadata: RequestMetadata) {
    if (!token) {
      return;
    }
    const session = await this.sessions.findRefreshSession(
      this.sessions.hashRefreshToken(token),
    );
    if (!session) {
      return;
    }

    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.authSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'logout' },
      });
      if (updated.count === 1) {
        await this.audit.write(
          {
            actorUserId: session.userId,
            action: 'AUTH_LOGOUT',
            entityType: 'AuthSession',
            entityId: session.id,
            ipAddress: metadata.ipAddress,
            userAgent: metadata.userAgent,
            correlationId: metadata.correlationId,
          },
          transaction,
        );
        await this.audit.write(
          {
            actorUserId: session.userId,
            action: 'AUTH_SESSION_REVOKED',
            entityType: 'AuthSession',
            entityId: session.id,
            ipAddress: metadata.ipAddress,
            userAgent: metadata.userAgent,
            correlationId: metadata.correlationId,
            metadata: { reason: 'logout', reasonCode: 'LOGOUT' },
          },
          transaction,
        );
      }
    });
  }

  async logoutAll(userId: string, metadata: RequestMetadata): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.authSession.updateMany({
        where: {
          userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now, revokedReason: 'logout_all' },
      });
      await this.audit.write(
        {
          actorUserId: userId,
          action: 'AUTH_LOGOUT_ALL',
          entityType: 'User',
          entityId: userId,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          correlationId: metadata.correlationId,
          metadata: { revokedSessionCount: result.count },
        },
        transaction,
      );
    });
  }

  /**
   * Batch 2: a signed-in user changes their own password. The current password is required (a
   * session alone is not enough); wrong ones are audited and rate limited per user but never
   * count toward the account lockout, so a stolen session cannot lock the owner out. The change
   * applies only if the password hash it verified is still current (409 otherwise, e.g. a
   * concurrent change or reset), ends every other session, invalidates outstanding reset links
   * and clears a required password change.
   */
  async changePassword(
    identity: { userId: string; sessionId: string },
    currentPassword: string,
    newPassword: string,
    metadata: RequestMetadata,
  ): Promise<{ success: true; revokedSessionCount: number }> {
    const password = this.parsePassword(newPassword);
    const user = await this.prisma.user.findUnique({
      where: { id: identity.userId },
      select: { id: true, passwordHash: true, status: true, archivedAt: true },
    });
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      user.archivedAt !== null ||
      user.passwordHash === null
    ) {
      throw new UnauthorizedException();
    }
    const event = {
      actorUserId: user.id,
      entityType: 'User',
      entityId: user.id,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      correlationId: metadata.correlationId,
    };
    if (
      !(await this.passwords.verifyPassword(user.passwordHash, currentPassword))
    ) {
      await this.audit.write({
        ...event,
        action: 'AUTH_PASSWORD_CHANGE_FAILED',
        metadata: { reasonCode: 'INVALID_CURRENT_PASSWORD' },
      });
      throw new BadRequestException(
        domainError(
          400,
          'CURRENT_PASSWORD_INVALID',
          'The current password is incorrect.',
        ),
      );
    }
    if (await this.passwords.verifyPassword(user.passwordHash, password)) {
      throw new BadRequestException(
        domainError(
          400,
          'PASSWORD_UNCHANGED',
          'Choose a password different from the current one.',
        ),
      );
    }
    const passwordHash = await this.passwords.hashPassword(password);
    const now = new Date();
    const revokedSessionCount = await this.prisma.$transaction(
      async (transaction) => {
        // The session making the change must still be live (it may have been revoked meanwhile).
        const current = await transaction.authSession.count({
          where: {
            id: identity.sessionId,
            userId: user.id,
            revokedAt: null,
            expiresAt: { gt: now },
          },
        });
        if (current !== 1) throw new UnauthorizedException();
        const updated = await transaction.user.updateMany({
          where: {
            id: user.id,
            status: 'ACTIVE',
            archivedAt: null,
            passwordHash: user.passwordHash,
          },
          data: {
            passwordHash,
            passwordChangedAt: now,
            mustChangePassword: false,
            failedLoginAttempts: 0,
            lockedUntil: null,
          },
        });
        if (updated.count !== 1) {
          throw new ConflictException(
            domainError(
              409,
              'PASSWORD_CHANGED_CONCURRENTLY',
              'Your password was changed meanwhile. Sign in again and retry.',
            ),
          );
        }
        await this.accountTokens.invalidateOutstanding(
          transaction,
          user.id,
          AccountTokenType.PASSWORD_RESET,
          now,
        );
        const revoked = await transaction.authSession.updateMany({
          where: {
            userId: user.id,
            id: { not: identity.sessionId },
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { revokedAt: now, revokedReason: 'password_changed' },
        });
        await this.audit.write(
          {
            ...event,
            action: 'AUTH_PASSWORD_CHANGED',
            metadata: { revokedSessionCount: revoked.count },
          },
          transaction,
        );
        return revoked.count;
      },
    );
    return { success: true, revokedSessionCount };
  }

  /**
   * Batch 2 (D6): the answer never depends on the address. An eligible account is looked up and
   * exactly one recovery job is queued either way (with no account for an unknown or ineligible
   * address); the worker issues and emails the single-use link.
   */
  async forgotPassword(email: string): Promise<{ message: string }> {
    await this.emails.assertAvailable();
    const user = await this.users.findForAccountRecovery(email);
    const eligible =
      user?.status === 'ACTIVE' &&
      user.archivedAt === null &&
      user.passwordHash !== null;
    await this.recovery.enqueue({
      kind: 'password-reset',
      userId: eligible ? user.id : null,
      requestedAt: new Date().toISOString(),
    });
    return {
      message:
        'If the account is eligible, recovery instructions will be sent.',
    };
  }

  async resetPassword(
    token: string,
    newPassword: string,
    metadata: RequestMetadata,
  ): Promise<{ success: true }> {
    const password = this.parsePassword(newPassword);
    const now = new Date();
    const accountToken = await this.accountTokens.findUsable(
      token,
      AccountTokenType.PASSWORD_RESET,
      now,
    );
    if (
      !accountToken ||
      accountToken.user.status !== 'ACTIVE' ||
      accountToken.user.archivedAt !== null
    ) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const passwordHash = await this.passwords.hashPassword(password);

    await this.prisma.$transaction(async (transaction) => {
      const consumed = await this.accountTokens.consume(
        transaction,
        accountToken.id,
        now,
      );
      if (consumed.count !== 1) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      await this.accountTokens.invalidateOutstanding(
        transaction,
        accountToken.userId,
        AccountTokenType.PASSWORD_RESET,
        now,
      );
      const updated = await transaction.user.updateMany({
        where: {
          id: accountToken.userId,
          status: 'ACTIVE',
          archivedAt: null,
        },
        data: {
          passwordHash,
          passwordChangedAt: now,
          mustChangePassword: false,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
      if (updated.count !== 1) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      const revoked = await transaction.authSession.updateMany({
        where: {
          userId: accountToken.userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now, revokedReason: 'password_reset' },
      });
      await this.audit.write(
        {
          actorUserId: accountToken.userId,
          action: 'AUTH_PASSWORD_RESET_COMPLETED',
          entityType: 'User',
          entityId: accountToken.userId,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          correlationId: metadata.correlationId,
        },
        transaction,
      );
      if (revoked.count > 0) {
        await this.audit.write(
          {
            actorUserId: accountToken.userId,
            action: 'AUTH_ALL_SESSIONS_REVOKED',
            entityType: 'User',
            entityId: accountToken.userId,
            ipAddress: metadata.ipAddress,
            userAgent: metadata.userAgent,
            correlationId: metadata.correlationId,
            metadata: {
              count: revoked.count,
              reason: 'password_reset',
              reasonCode: 'PASSWORD_RESET',
            },
          },
          transaction,
        );
      }
    });
    return { success: true };
  }

  async issueInvitation(
    userId: string,
    metadata: RequestMetadata = {},
  ): Promise<void> {
    await this.emails.assertAvailable();
    const user = await this.users.findById(userId);
    if (
      !user ||
      user.status !== 'INVITED' ||
      user.passwordHash !== null ||
      user.archivedAt !== null
    ) {
      throw new BadRequestException('Account is not eligible for invitation');
    }
    const issued = await this.accountTokens.issue(
      user.id,
      AccountTokenType.INVITATION,
      INVITATION_TOKEN_LIFETIME_MS,
      {
        actorUserId: null,
        action: 'AUTH_INVITATION_CREATED',
        entityType: 'User',
        entityId: user.id,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        correlationId: metadata.correlationId,
      },
    );
    try {
      await this.emails.sendInvitation({
        email: user.email,
        token: issued.token,
        expiresAt: issued.expiresAt,
        userId: user.id,
      });
    } catch (error) {
      await this.accountTokens.withdraw(issued.id);
      throw error;
    }
  }

  async acceptInvitation(
    token: string,
    newPassword: string,
    metadata: RequestMetadata,
  ): Promise<{ success: true }> {
    const password = this.parsePassword(newPassword);
    const now = new Date();
    const accountToken = await this.accountTokens.findUsable(
      token,
      AccountTokenType.INVITATION,
      now,
    );
    if (
      !accountToken ||
      accountToken.user.status !== 'INVITED' ||
      accountToken.user.passwordHash !== null ||
      accountToken.user.archivedAt !== null
    ) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const passwordHash = await this.passwords.hashPassword(password);
    await this.prisma.$transaction(async (transaction) => {
      const consumed = await this.accountTokens.consume(
        transaction,
        accountToken.id,
        now,
      );
      const activated = await transaction.user.updateMany({
        where: {
          id: accountToken.userId,
          status: 'INVITED',
          passwordHash: null,
          archivedAt: null,
        },
        data: {
          passwordHash,
          passwordChangedAt: now,
          emailVerifiedAt: now,
          status: 'ACTIVE',
          mustChangePassword: false,
        },
      });
      if (consumed.count !== 1 || activated.count !== 1) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      await this.accountTokens.invalidateOutstanding(
        transaction,
        accountToken.userId,
        AccountTokenType.INVITATION,
        now,
      );
      await this.audit.write(
        {
          actorUserId: accountToken.userId,
          action: 'AUTH_INVITATION_ACCEPTED',
          entityType: 'User',
          entityId: accountToken.userId,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          correlationId: metadata.correlationId,
        },
        transaction,
      );
    });
    return { success: true };
  }

  async verifyEmail(
    token: string,
    metadata: RequestMetadata,
  ): Promise<{ success: true }> {
    const now = new Date();
    const accountToken = await this.accountTokens.findUsable(
      token,
      AccountTokenType.EMAIL_VERIFICATION,
      now,
    );
    if (
      !accountToken ||
      accountToken.user.status !== 'ACTIVE' ||
      accountToken.user.archivedAt !== null
    ) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    await this.prisma.$transaction(async (transaction) => {
      const consumed = await this.accountTokens.consume(
        transaction,
        accountToken.id,
        now,
      );
      const updated = await transaction.user.updateMany({
        where: {
          id: accountToken.userId,
          status: 'ACTIVE',
          archivedAt: null,
          emailVerifiedAt: null,
        },
        data: { emailVerifiedAt: now },
      });
      if (consumed.count !== 1 || updated.count !== 1) {
        throw new UnauthorizedException('Invalid or expired token');
      }
      await this.audit.write(
        {
          actorUserId: accountToken.userId,
          action: 'AUTH_EMAIL_VERIFIED',
          entityType: 'User',
          entityId: accountToken.userId,
          ipAddress: metadata.ipAddress,
          userAgent: metadata.userAgent,
          correlationId: metadata.correlationId,
        },
        transaction,
      );
    });
    return { success: true };
  }

  /** Batch 2 (D6): queued like forgotPassword, so the answer never depends on the address. */
  async resendVerification(
    email: string,
    metadata: RequestMetadata,
  ): Promise<{ message: string }> {
    await this.rateLimiter.assertVerificationResendAllowed(
      metadata.ipAddress ?? 'unknown',
      email,
    );
    await this.emails.assertAvailable();
    const user = await this.users.findForAccountRecovery(email);
    const eligible =
      user?.status === 'ACTIVE' &&
      user.archivedAt === null &&
      user.emailVerifiedAt === null;
    await this.recovery.enqueue({
      kind: 'verification',
      userId: eligible ? user.id : null,
      requestedAt: new Date().toISOString(),
    });
    return {
      message:
        'If the account requires verification, instructions will be sent.',
    };
  }

  private parsePassword(value: string): string {
    try {
      return passwordSchema.parse(value);
    } catch {
      throw new BadRequestException(
        'Password does not meet the required policy',
      );
    }
  }

  async me(userId: string) {
    const identity = await this.users.findIdentity(userId);
    if (
      !identity ||
      identity.status !== 'ACTIVE' ||
      identity.archivedAt !== null
    ) {
      throw new UnauthorizedException();
    }
    return {
      id: identity.id,
      personId: identity.personId,
      email: identity.email,
      status: identity.status,
      emailVerifiedAt: identity.emailVerifiedAt,
      mustChangePassword: identity.mustChangePassword,
    };
  }

  private isActiveSession(
    session: Awaited<ReturnType<SessionsService['findRefreshSession']>>,
    now: Date,
  ): session is NonNullable<
    Awaited<ReturnType<SessionsService['findRefreshSession']>>
  > {
    return Boolean(
      session &&
      !session.revokedAt &&
      session.expiresAt > now &&
      session.user.status === 'ACTIVE' &&
      session.user.archivedAt === null,
    );
  }
}
