import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
    });
  }

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findForLogin(email: string) {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: {
        id: true,
        personId: true,
        email: true,
        passwordHash: true,
        status: true,
        archivedAt: true,
        lockedUntil: true,
        failedLoginAttempts: true,
        mustChangePassword: true,
        emailVerifiedAt: true,
      },
    });
  }

  findIdentity(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        personId: true,
        email: true,
        status: true,
        emailVerifiedAt: true,
        mustChangePassword: true,
        archivedAt: true,
      },
    });
  }

  findForAccountRecovery(email: string) {
    return this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: {
        id: true,
        email: true,
        status: true,
        passwordHash: true,
        archivedAt: true,
        emailVerifiedAt: true,
      },
    });
  }

  /**
   * Counts a failed password for an eligible account and starts the temporary lock at the
   * threshold. Bound values carry explicit types: an untyped parameter in a SET or CASE result
   * is text to PostgreSQL, which a timestamptz column refuses.
   */
  async recordFailedLogin(
    userId: string,
    now: Date,
    threshold: number,
    lockDurationMs: number,
  ) {
    const lockedUntil = new Date(now.getTime() + lockDurationMs);
    const result = await this.prisma.$queryRaw<
      Array<{ failedLoginAttempts: number; lockedUntil: Date | null }>
    >(Prisma.sql`
      UPDATE "User"
      SET
        "failedLoginAttempts" = CASE
          WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now}::timestamptz THEN 1
          ELSE "failedLoginAttempts" + 1
        END,
        "lockedUntil" = CASE
          WHEN (
            CASE
              WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now}::timestamptz THEN 1
              ELSE "failedLoginAttempts" + 1
            END
          ) >= ${threshold}::int THEN ${lockedUntil}::timestamptz
          ELSE NULL
        END,
        "updatedAt" = ${now}::timestamptz
      WHERE "id" = ${userId}::uuid
        AND "status" = 'ACTIVE'
        AND "archivedAt" IS NULL
        AND "passwordHash" IS NOT NULL
        AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now}::timestamptz)
      RETURNING "failedLoginAttempts", "lockedUntil"
    `);
    return result[0];
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
