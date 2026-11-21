import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PasswordHasherService } from './password-hasher.service.js';

describe('PasswordHasherService', () => {
  it('hashes passwords and verifies only the matching password', async () => {
    const module = await Test.createTestingModule({
      providers: [
        PasswordHasherService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) =>
              ({
                ARGON2_MEMORY_COST_KIB: 1_024,
                ARGON2_TIME_COST: 1,
                ARGON2_PARALLELISM: 1,
              })[key],
          },
        },
      ],
    }).compile();
    const service = module.get(PasswordHasherService);
    const passwordHash = await service.hashPassword(
      'correct horse battery staple',
    );

    expect(passwordHash).not.toContain('correct horse battery staple');
    await expect(
      service.verifyPassword(passwordHash, 'correct horse battery staple'),
    ).resolves.toBe(true);
    await expect(
      service.verifyPassword(passwordHash, 'incorrect password'),
    ).resolves.toBe(false);
    await module.close();
  });
});
