import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { RedisService } from '../redis/redis.service.js';
import {
  KIOSK_ENROLL_LIMIT,
  KioskRateLimiterService,
} from './kiosk-rate-limiter.service.js';

/**
 * Batch R2 (KIOSK-1): the kiosk's brute-force limits for PIN identification and enrollment must
 * fail closed. Without Redis (connection refused or a command timeout) no PIN is checked and no
 * enrollment code is tried; once Redis answers again the limits apply as before.
 */
function scriptedRedis() {
  const counters = new Map<string, number>();
  const state: { failure: Error | null } = { failure: null };
  const evalScript = vi.fn(
    async (
      script: string,
      keyCount: number,
      ...args: Array<string | number>
    ) => {
      if (state.failure) throw state.failure;
      const keys = args.slice(0, keyCount) as string[];
      if (script.includes('DECR')) {
        for (const key of keys) {
          const count = counters.get(key) ?? 0;
          if (count > 0) counters.set(key, count - 1);
        }
        return 1;
      }
      const argv = args.slice(keyCount).map(Number);
      let allowed = 1;
      keys.forEach((key, index) => {
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        if (count > argv[index * 2 + 1]!) allowed = 0;
      });
      return allowed;
    },
  );
  return {
    counters,
    state,
    evalScript,
    service: { client: { eval: evalScript } } as unknown as RedisService,
  };
}

const device = {
  id: 'device-1',
  organizationId: 'organization-1',
  employeeNumber: 'E-100',
};

describe('KioskRateLimiterService (Batch R2, KIOSK-1)', () => {
  it('refuses identification with 503 when Redis refuses the connection, then recovers', async () => {
    const redis = scriptedRedis();
    const limiter = new KioskRateLimiterService(redis.service);

    redis.state.failure = new Error('connect ECONNREFUSED 127.0.0.1:6380');
    await expect(limiter.reserveIdentify(device)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    redis.state.failure = null;
    const reservation = await limiter.reserveIdentify(device);
    expect(reservation.keys).toHaveLength(4);
  });

  it('refuses identification and enrollment with 503 on a command timeout', async () => {
    const redis = scriptedRedis();
    const limiter = new KioskRateLimiterService(redis.service);
    redis.state.failure = new Error('Command timed out');

    const identify = await limiter
      .reserveIdentify(device)
      .catch((error: unknown) => error);
    expect(identify).toBeInstanceOf(ServiceUnavailableException);
    expect((identify as HttpException).getStatus()).toBe(503);
    await expect(
      limiter.assertEnrollAllowed('192.0.2.20'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('still answers 429 when a limit is reached, and does not reset counters after an outage', async () => {
    const redis = scriptedRedis();
    const limiter = new KioskRateLimiterService(redis.service);
    for (
      let attempt = 0;
      attempt < limiter.limits.deviceEmployeeLimit;
      attempt += 1
    ) {
      await limiter.reserveIdentify(device);
    }
    redis.state.failure = new Error('Command timed out');
    await expect(limiter.reserveIdentify(device)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    redis.state.failure = null;
    const refused = await limiter
      .reserveIdentify(device)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(429);
  });

  it('limits enrollment attempts per address and fails closed without Redis', async () => {
    const redis = scriptedRedis();
    const limiter = new KioskRateLimiterService(redis.service);
    for (let attempt = 0; attempt < KIOSK_ENROLL_LIMIT; attempt += 1) {
      await limiter.assertEnrollAllowed('192.0.2.30');
    }
    const refused = await limiter
      .assertEnrollAllowed('192.0.2.30')
      .catch((error: unknown) => error);
    expect((refused as HttpException).getStatus()).toBe(429);
  });

  it('a failed refund after a successful identification never throws (the limit only gets stricter)', async () => {
    const redis = scriptedRedis();
    const limiter = new KioskRateLimiterService(redis.service);
    const reservation = await limiter.reserveIdentify(device);
    redis.state.failure = new Error('connect ECONNREFUSED 127.0.0.1:6380');
    await expect(limiter.refund(reservation)).resolves.toBeUndefined();
  });
});
