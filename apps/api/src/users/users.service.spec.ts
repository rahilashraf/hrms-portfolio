import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service.js';
import { UsersService } from './users.service.js';

describe('UsersService', () => {
  it('normalizes email before lookup', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: { user: { findUnique } },
        },
      ],
    }).compile();
    const service = module.get(UsersService);

    await service.findByEmail('  PERSON@EXAMPLE.COM ');

    expect(findUnique).toHaveBeenCalledWith({
      where: { email: 'person@example.com' },
    });
    await module.close();
  });

  it('returns the atomically updated temporary login-lock state', async () => {
    const lockedUntil = new Date('2030-01-01T00:15:00.000Z');
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ failedLoginAttempts: 5, lockedUntil }]);
    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: PrismaService,
          useValue: { $queryRaw: queryRaw },
        },
      ],
    }).compile();
    const service = module.get(UsersService);

    await expect(
      service.recordFailedLogin(
        'user-id',
        new Date('2030-01-01T00:00:00.000Z'),
        5,
        15 * 60_000,
      ),
    ).resolves.toEqual({ failedLoginAttempts: 5, lockedUntil });
    expect(queryRaw).toHaveBeenCalled();
    await module.close();
  });
});
