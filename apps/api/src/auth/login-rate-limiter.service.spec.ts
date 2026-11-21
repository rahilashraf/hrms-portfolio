import { Test } from '@nestjs/testing';
import { RedisService } from '../redis/redis.service.js';
import {
  LoginRateLimiterService,
  LOGIN_IP_EMAIL_LIMIT,
  LOGIN_IP_EMAIL_WINDOW_MS,
  LOGIN_IP_LIMIT,
  LOGIN_IP_WINDOW_MS,
  VERIFICATION_RESEND_LIMIT,
  VERIFICATION_RESEND_WINDOW_MS,
} from './login-rate-limiter.service.js';

describe('LoginRateLimiterService', () => {
  async function createService(evalScript: ReturnType<typeof vi.fn>) {
    const module = await Test.createTestingModule({
      providers: [
        LoginRateLimiterService,
        {
          provide: RedisService,
          useValue: { client: { eval: evalScript } },
        },
      ],
    }).compile();
    return { module, service: module.get(LoginRateLimiterService) };
  }

  it('uses atomic hashed keys and the distinct login windows', async () => {
    const evalScript = vi.fn().mockResolvedValue(1);
    const { module, service } = await createService(evalScript);

    await service.assertLoginAllowed('192.0.2.1', ' Person@Example.com ');

    const [script, count, ipKey, emailKey, ...args] = evalScript.mock.calls[0]!;
    expect(script).toContain('INCR');
    expect(count).toBe(2);
    expect(ipKey).toMatch(/^auth:rate:login:ip:[a-f0-9]{64}$/);
    expect(emailKey).toMatch(
      /^auth:rate:login:ip-email:[a-f0-9]{64}:[a-f0-9]{64}$/,
    );
    expect(ipKey).not.toContain('192.0.2.1');
    expect(emailKey).not.toContain('person@example.com');
    expect(args).toEqual([
      LOGIN_IP_WINDOW_MS,
      LOGIN_IP_EMAIL_WINDOW_MS,
      LOGIN_IP_LIMIT,
      LOGIN_IP_EMAIL_LIMIT,
    ]);
    await module.close();
  });

  it('returns generic throttling errors and fails closed on Redis errors', async () => {
    const limitedEval = vi.fn().mockResolvedValue(0);
    const limited = await createService(limitedEval);
    await expect(
      limited.service.assertLoginAllowed('192.0.2.1', 'person@example.com'),
    ).rejects.toMatchObject({
      status: 429,
      response: { code: 'RATE_LIMITED' },
      retryAfterSeconds: LOGIN_IP_EMAIL_WINDOW_MS / 1000,
    });
    await limited.module.close();

    // Phase 19: the script reports the remaining window, sent as Retry-After.
    const remaining = await createService(vi.fn().mockResolvedValue(-42_100));
    await expect(
      remaining.service.assertLoginAllowed('192.0.2.1', 'person@example.com'),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 43 });
    await expect(
      remaining.service.assertVerificationResendAllowed(
        '192.0.2.1',
        'person@example.com',
      ),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 43 });
    await remaining.module.close();

    const failing = await createService(
      vi.fn().mockRejectedValue(new Error('redis down')),
    );
    await expect(
      failing.service.assertLoginAllowed('192.0.2.1', 'person@example.com'),
    ).rejects.toMatchObject({
      status: 503,
      response: {
        message: 'Authentication temporarily unavailable',
      },
    });
    await failing.module.close();
  });

  it('uses a separate verification resend namespace and limit', async () => {
    const evalScript = vi.fn().mockResolvedValue(1);
    const { module, service } = await createService(evalScript);

    await service.assertVerificationResendAllowed(
      '192.0.2.1',
      'person@example.com',
    );

    const [script, count, key, ...args] = evalScript.mock.calls[0]!;
    expect(script).toContain('PEXPIRE');
    expect(count).toBe(1);
    expect(key).toMatch(/^auth:rate:verification-resend:/);
    expect(args).toEqual([
      VERIFICATION_RESEND_WINDOW_MS,
      VERIFICATION_RESEND_LIMIT,
    ]);
    await module.close();
  });
});
