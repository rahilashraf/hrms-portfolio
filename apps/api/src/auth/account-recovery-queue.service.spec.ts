import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AccountRecoveryQueue } from './account-recovery-queue.service.js';

describe('AccountRecoveryQueue', () => {
  it('answers 503 when Redis is down, logging once without connection details or raw console errors', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const loggerError = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    // Nothing listens on this port: every connection attempt is refused.
    const queue = new AccountRecoveryQueue({
      getOrThrow: () => 'redis://127.0.0.1:1',
    } as unknown as ConfigService);
    try {
      const error = await queue
        .enqueue({
          kind: 'password-reset',
          userId: null,
          requestedAt: new Date().toISOString(),
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(
        (error as ServiceUnavailableException).getResponse(),
      ).toMatchObject({ code: 'ACCOUNT_RECOVERY_UNAVAILABLE' });
      // Several reconnect attempts happened meanwhile; none reached the console.
      expect(consoleError).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(loggerError.mock.calls)).not.toMatch(
        /127\.0\.0\.1|ECONNREFUSED/,
      );
    } finally {
      await queue.onModuleDestroy();
      consoleError.mockRestore();
      loggerError.mockRestore();
    }
  }, 20_000);
});
