import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

/** Reconnect delay: grows with each attempt, capped, and never gives up. */
export function redisRetryDelay(attempt: number): number {
  return Math.min(100 * 2 ** Math.max(0, attempt - 1), 5_000);
}

/**
 * The API's Redis client. Commands fail fast while disconnected (no offline queue, one retry,
 * a command timeout), so callers decide whether to fail open or closed; the connection itself
 * is opened at startup and re-established forever in the background after an outage.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);
  private lastErrorLogAt = 0;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      commandTimeout: 2_000,
      connectTimeout: 5_000,
      retryStrategy: redisRetryDelay,
    });
    this.client.on('error', () => {
      // Once a minute at most: a down Redis must not flood the logs.
      const now = Date.now();
      if (now - this.lastErrorLogAt >= 60_000) {
        this.lastErrorLogAt = now;
        this.logger.error('Redis connection failed');
      }
    });
  }

  /**
   * Phase 19: connect eagerly. With lazyConnect and no offline queue, the first command after
   * boot used to fail ("Stream isn't writeable"), so the first login answered 503. A Redis that
   * is down at boot does not stop the API: it keeps reconnecting and /ready reports it.
   */
  async onModuleInit(): Promise<void> {
    if (this.client.status !== 'wait') return;
    try {
      await this.client.connect();
    } catch {
      this.logger.warn(
        'Redis unavailable at startup; reconnecting in the background',
      );
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
