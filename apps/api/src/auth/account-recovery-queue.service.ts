import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { redisRetryDelay } from '../redis/redis.service.js';
import {
  ACCOUNT_EMAIL_JOB_OPTIONS,
  ACCOUNT_EMAIL_QUEUE,
  DELIVER_ACCOUNT_EMAIL_JOB,
  type AccountEmailJobData,
} from './account-email-jobs.js';

const ENQUEUE_TIMEOUT_MS = 5_000;

/**
 * Batch 2 (D6): hands account recovery emails to the worker through the existing BullMQ queue
 * (durable in Redis, retried with backoff). The queue connection opens on first use, so the API
 * starts without it; when Redis cannot take the job in time every request answers the same 503,
 * whether or not an account matched.
 */
@Injectable()
export class AccountRecoveryQueue implements OnModuleDestroy {
  private queue: Queue | null = null;
  private connection: Redis | null = null;
  private readonly logger = new Logger(AccountRecoveryQueue.name);
  private lastErrorLogAt = 0;

  constructor(private readonly config: ConfigService) {}

  async enqueue(data: AccountEmailJobData): Promise<void> {
    const queue = this.open();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        queue.add(DELIVER_ACCOUNT_EMAIL_JOB, data, ACCOUNT_EMAIL_JOB_OPTIONS),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('enqueue timeout')),
            ENQUEUE_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'Service Unavailable',
        code: 'ACCOUNT_RECOVERY_UNAVAILABLE',
        message:
          'Account recovery is temporarily unavailable. Try again shortly.',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Once a minute at most, without connection details: a down Redis must not flood the logs. */
  private logConnectionFailure() {
    const now = Date.now();
    if (now - this.lastErrorLogAt < 60_000) return;
    this.lastErrorLogAt = now;
    this.logger.error('Account recovery queue: Redis connection failed');
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => undefined);
    this.connection?.disconnect();
  }

  private open() {
    if (!this.queue) {
      this.connection = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
        // BullMQ's recommended producer settings; the enqueue timeout bounds a down Redis.
        maxRetriesPerRequest: null,
        connectTimeout: 5_000,
        retryStrategy: redisRetryDelay,
      });
      this.connection.on('error', () => this.logConnectionFailure());
      this.queue = new Queue(ACCOUNT_EMAIL_QUEUE, {
        connection: this.connection,
      });
      // Without a listener BullMQ prints every reconnect failure (with the internal address)
      // straight to the console; requests already answer 503 through enqueue.
      this.queue.on('error', () => this.logConnectionFailure());
    }
    return this.queue;
  }
}
