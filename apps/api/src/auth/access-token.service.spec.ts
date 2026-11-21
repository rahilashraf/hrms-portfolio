import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { jwtVerify } from 'jose';
import { AccessTokenService } from './access-token.service.js';

describe('AccessTokenService', () => {
  const secret = 'unit-test-secret-value-with-at-least-32-bytes';

  async function createService() {
    const module = await Test.createTestingModule({
      providers: [
        AccessTokenService,
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => secret },
        },
      ],
    }).compile();
    return { module, service: module.get(AccessTokenService) };
  }

  it('issues an HS256 access token with only the approved claims', async () => {
    const { module, service } = await createService();
    const token = await service.issue({
      userId: 'user-1',
      sessionId: 'session-1',
    });
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      { algorithms: ['HS256'] },
    );

    expect(protectedHeader.alg).toBe('HS256');
    expect(payload).toMatchObject({
      sub: 'user-1',
      sid: 'session-1',
      type: 'access',
    });
    expect(Object.keys(payload).sort()).toEqual(
      ['exp', 'iat', 'sid', 'sub', 'type'].sort(),
    );
    await expect(service.verify(token)).resolves.toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
    });
    await module.close();
  });

  it('rejects tokens signed with an algorithm other than HS256', async () => {
    const { module, service } = await createService();
    const token = await service.issue({
      userId: 'user-1',
      sessionId: 'session-1',
    });
    const [header, body, signature] = token.split('.');
    const headerJson = Buffer.from(header!, 'base64url').toString();
    const changedHeader = Buffer.from(
      headerJson.replace('HS256', 'HS384'),
    ).toString('base64url');

    await expect(
      service.verify(`${changedHeader}.${body}.${signature}`),
    ).rejects.toThrow();
    await module.close();
  });
});
