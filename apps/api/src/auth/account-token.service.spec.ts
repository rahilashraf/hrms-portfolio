import { Test } from '@nestjs/testing';
import { AccountTokenType } from '../generated/prisma/client.js';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { AccountTokenService } from './account-token.service.js';

describe('AccountTokenService', () => {
  it('stores a random token hash and marks previous tokens used', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn().mockResolvedValue({ id: 'token-id' });
    const transaction = {
      $queryRaw: vi.fn(),
      accountToken: { updateMany, create },
      auditLog: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback) => callback(transaction)),
    };
    const audit = { write: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        AccountTokenService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    const service = module.get(AccountTokenService);

    const issued = await service.issue(
      'user-id',
      AccountTokenType.PASSWORD_RESET,
      30 * 60_000,
    );
    const persisted = create.mock.calls[0]![0].data;

    expect(Buffer.from(issued.token, 'base64url')).toHaveLength(32);
    expect(persisted).toMatchObject({
      userId: 'user-id',
      type: AccountTokenType.PASSWORD_RESET,
    });
    expect(persisted.tokenHash).not.toBe(issued.token);
    expect(persisted.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(issued.token);
    const findFirst = vi.fn().mockResolvedValue({ id: 'token-id' });
    const lookupPrisma = { accountToken: { findFirst } };
    const lookupModule = await Test.createTestingModule({
      providers: [
        AccountTokenService,
        { provide: PrismaService, useValue: lookupPrisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    await lookupModule
      .get(AccountTokenService)
      .findUsable(issued.token, AccountTokenType.PASSWORD_RESET);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tokenHash: createHash('sha256').update(issued.token).digest('hex'),
        }),
      }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-id',
        type: AccountTokenType.PASSWORD_RESET,
        usedAt: null,
      },
      data: { usedAt: expect.any(Date) },
    });
    await module.close();
    await lookupModule.close();
  });
});
