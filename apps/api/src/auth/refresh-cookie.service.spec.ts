import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import {
  REFRESH_COOKIE_NAME,
  RefreshCookieService,
} from './refresh-cookie.service.js';

describe('RefreshCookieService', () => {
  async function createService(nodeEnv = 'test') {
    const module = await Test.createTestingModule({
      providers: [
        RefreshCookieService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (key: string) =>
              key === 'NODE_ENV' ? nodeEnv : 'http://localhost:3000',
          },
        },
      ],
    }).compile();
    return { module, service: module.get(RefreshCookieService) };
  }

  it('sets and clears a scoped HttpOnly SameSite=Lax cookie', async () => {
    const { module, service } = await createService();
    const setCookie = vi.fn();
    const clearCookie = vi.fn();
    const response = {
      cookie: setCookie,
      clearCookie,
    } as unknown as Response;

    service.set(response, 'opaque-token');
    service.clear(response);

    expect(setCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      'opaque-token',
      expect.objectContaining({
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/auth',
      }),
    );
    expect(clearCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      expect.objectContaining({ path: '/auth', sameSite: 'lax' }),
    );
    await module.close();
  });

  it('requires production cookies to be Secure and checks present origins', async () => {
    const { module, service } = await createService('production');
    expect(() => service.assertAllowedOrigin(undefined)).not.toThrow();
    expect(() =>
      service.assertAllowedOrigin('https://attacker.example'),
    ).toThrow();
    const setCookie = vi.fn();
    const response = { cookie: setCookie } as unknown as Response;

    service.set(response, 'opaque-token');

    expect(setCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      'opaque-token',
      expect.objectContaining({ secure: true }),
    );
    await module.close();
  });
});
