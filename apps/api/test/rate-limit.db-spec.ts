import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { RATE_LIMIT_SCRIPT } from '../src/rate-limit/rate-limit.service.js';

config({ path: '../../.env' });

/**
 * Phase 19 — the fixed-window script against a real Redis: atomic counting, the remaining
 * window as a negative result, independent keys, expiry and repair of a key without TTL.
 */
describe('Rate limit script (Redis)', () => {
  let redis: Redis;
  const prefix = `rl:test:${randomUUID()}`;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
    });
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  const run = (keys: string[], args: number[]) =>
    redis.eval(RATE_LIMIT_SCRIPT, keys.length, ...keys, ...args);

  it('allows up to the limit, then returns the remaining window', async () => {
    const key = `${prefix}:a`;
    expect(await run([key], [60_000, 3])).toBe(1);
    expect(await run([key], [60_000, 3])).toBe(1);
    expect(await run([key], [60_000, 3])).toBe(1);
    const blocked = (await run([key], [60_000, 3])) as number;
    expect(blocked).toBeLessThan(0);
    expect(-blocked).toBeGreaterThan(55_000);
    expect(-blocked).toBeLessThanOrEqual(60_000);
  });

  it('counts concurrent requests atomically', async () => {
    const key = `${prefix}:concurrent`;
    const results = await Promise.all(
      Array.from({ length: 25 }, () => run([key], [60_000, 10])),
    );
    expect(results.filter((result) => result === 1)).toHaveLength(10);
    expect(await redis.get(key)).toBe('25');
  });

  it('checks every window and reports the longest exceeded one', async () => {
    const short = `${prefix}:short`;
    const long = `${prefix}:long`;
    expect(await run([short, long], [1_000, 1, 120_000, 1])).toBe(1);
    const blocked = (await run(
      [short, long],
      [1_000, 1, 120_000, 1],
    )) as number;
    expect(-blocked).toBeGreaterThan(100_000);
    expect(await redis.get(short)).toBe('2');
    expect(await redis.get(long)).toBe('2');
  });

  it('expires the window and repairs a key that lost its expiry', async () => {
    const key = `${prefix}:expiry`;
    expect(await run([key], [200, 1])).toBe(1);
    expect((await run([key], [200, 1])) as number).toBeLessThan(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await run([key], [200, 1])).toBe(1);

    const stuck = `${prefix}:stuck`;
    await redis.set(stuck, '100');
    expect((await run([stuck], [60_000, 5])) as number).toBeLessThan(0);
    expect(await redis.pttl(stuck)).toBeGreaterThan(0);
  });
});
