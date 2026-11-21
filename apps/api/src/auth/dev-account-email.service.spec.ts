import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DevAccountEmailService } from './dev-account-email.service.js';

describe('DevAccountEmailService', () => {
  async function createService(nodeEnv: string) {
    const module = await Test.createTestingModule({
      providers: [
        DevAccountEmailService,
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => nodeEnv },
        },
      ],
    }).compile();
    return { module, service: module.get(DevAccountEmailService) };
  }

  it('keeps a non-production fake email in memory without logging', async () => {
    const { module, service } = await createService('development');
    const logger = vi.spyOn(console, 'log');
    const message = {
      email: 'person@example.com',
      token: 'opaque-token',
      expiresAt: new Date(),
    };

    await service.sendPasswordReset(message);

    expect(service.messages).toEqual([{ type: 'password-reset', message }]);
    expect(logger).not.toHaveBeenCalled();
    logger.mockRestore();
    await module.close();
  });

  it('fails explicitly in production when no provider is configured', async () => {
    const { module, service } = await createService('production');

    expect(() => service.assertAvailable()).toThrow(
      ServiceUnavailableException,
    );
    await expect(
      service.sendInvitation({
        email: 'person@example.com',
        token: 'opaque-token',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(ServiceUnavailableException);
    await module.close();
  });
});
