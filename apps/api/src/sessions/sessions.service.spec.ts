import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import { SessionsService } from './sessions.service.js';

describe('SessionsService', () => {
  it('generates opaque tokens with 32 random bytes and SHA-256 hashes', async () => {
    const module = await Test.createTestingModule({
      providers: [
        SessionsService,
        {
          provide: PrismaService,
          useValue: {},
        },
      ],
    }).compile();
    const service = module.get(SessionsService);
    const token = service.generateRefreshToken();

    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(service.hashRefreshToken(token)).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
    await module.close();
  });

  it('persists only the supplied refresh-token hash', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'session-id' });
    const module = await Test.createTestingModule({
      providers: [
        SessionsService,
        {
          provide: PrismaService,
          useValue: { authSession: { create } },
        },
      ],
    }).compile();
    const service = module.get(SessionsService);
    const input = {
      userId: 'user-id',
      refreshTokenHash: 'sha256-hash',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    };

    await service.create(input);

    expect(create).toHaveBeenCalledWith({ data: input });
    await module.close();
  });
});
