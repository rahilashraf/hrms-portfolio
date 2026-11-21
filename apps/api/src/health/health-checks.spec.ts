import {
  checkDatabase,
  checkRedis,
  readiness,
  withTimeout,
} from './health-checks.js';

describe('health checks', () => {
  it('reports up and down per component', async () => {
    const database = { $queryRaw: vi.fn(async () => [{ ok: 1 }]) };
    expect(await checkDatabase(database)).toBe('up');
    expect(database.$queryRaw).toHaveBeenCalled();
    expect(
      await checkDatabase({
        $queryRaw: vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
      }),
    ).toBe('down');
    expect(await checkRedis({ ping: async () => 'PONG' })).toBe('up');
    expect(await checkRedis({ ping: async () => 'NOPE' })).toBe('down');
    expect(
      await checkRedis({
        ping: () => Promise.reject(new Error('closed')),
      }),
    ).toBe('down');
  });

  it('treats a probe that hangs as down after its timeout', async () => {
    const started = Date.now();
    expect(
      await checkRedis({ ping: () => new Promise(() => undefined) }, 50),
    ).toBe('down');
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(withTimeout(async () => 'ok', 50)).resolves.toBe('ok');
  });

  it('is ready only when every component is up', async () => {
    expect(
      await readiness({ database: async () => 'up', redis: async () => 'up' }),
    ).toEqual({ status: 'ready', checks: { database: 'up', redis: 'up' } });
    expect(
      await readiness({
        database: async () => 'down',
        redis: async () => 'up',
      }),
    ).toEqual({
      status: 'not_ready',
      checks: { database: 'down', redis: 'up' },
    });
  });
});
