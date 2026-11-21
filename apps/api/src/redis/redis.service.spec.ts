import type { ConfigService } from '@nestjs/config';
import { RedisService, redisRetryDelay } from './redis.service.js';

const config = {
  getOrThrow: () => 'redis://127.0.0.1:1',
} as unknown as ConfigService;

describe('RedisService', () => {
  it('keeps reconnecting with a capped backoff (never gives up)', () => {
    expect(redisRetryDelay(1)).toBe(100);
    expect(redisRetryDelay(2)).toBe(200);
    expect(redisRetryDelay(50)).toBe(5_000);
    expect(redisRetryDelay(10_000)).toBe(5_000);
  });

  it('connects at startup and does not fail the boot when Redis is down', async () => {
    const service = new RedisService(config);
    const connect = vi
      .spyOn(service.client, 'connect')
      .mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
  });
});
