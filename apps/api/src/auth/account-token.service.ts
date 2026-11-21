import { Injectable } from '@nestjs/common';
import { AccountTokenType, Prisma } from '../generated/prisma/client.js';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { CreateAuditLogInput } from '../audit/audit.service.js';

export interface IssuedAccountToken {
  id: string;
  token: string;
  expiresAt: Date;
}

@Injectable()
export class AccountTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async issue(
    userId: string,
    type: AccountTokenType,
    lifetimeMs: number,
    auditEvent?: Omit<CreateAuditLogInput, 'occurredAt'>,
  ): Promise<IssuedAccountToken> {
    return this.prisma.$transaction(async (transaction) => {
      const issued = await this.issueWithin(
        transaction,
        userId,
        type,
        lifetimeMs,
      );
      if (auditEvent) {
        await this.audit.write(auditEvent, transaction);
      }
      return issued;
    });
  }

  /**
   * Issues a token inside the caller's transaction (superseding the user's outstanding tokens
   * of the type), so the new token commits atomically with the caller's own locked changes.
   */
  async issueWithin(
    transaction: Prisma.TransactionClient,
    userId: string,
    type: AccountTokenType,
    lifetimeMs: number,
  ): Promise<IssuedAccountToken> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + lifetimeMs);
    await transaction.$queryRaw(
      Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`,
    );
    await transaction.accountToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: now },
    });
    const created = await transaction.accountToken.create({
      data: { userId, type, tokenHash, expiresAt },
      select: { id: true },
    });
    return { id: created.id, token, expiresAt };
  }

  /**
   * Withdraws one issued token that was never delivered (its email failed), so no usable
   * token exists for a message nobody received.
   */
  withdraw(id: string, now = new Date()) {
    return this.prisma.accountToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: now },
    });
  }

  findUsable(token: string, type: AccountTokenType, now = new Date()) {
    const tokenHash = hashToken(token);
    return this.prisma.accountToken.findFirst({
      where: {
        tokenHash,
        type,
        usedAt: null,
        expiresAt: { gt: now },
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            status: true,
            passwordHash: true,
            archivedAt: true,
          },
        },
      },
    });
  }

  consume(transaction: Prisma.TransactionClient, id: string, now = new Date()) {
    return transaction.accountToken.updateMany({
      where: { id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
  }

  invalidateOutstanding(
    transaction: Prisma.TransactionClient,
    userId: string,
    type: AccountTokenType,
    now = new Date(),
    exceptId?: string,
  ) {
    return transaction.accountToken.updateMany({
      where: {
        userId,
        type,
        usedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { usedAt: now },
    });
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
