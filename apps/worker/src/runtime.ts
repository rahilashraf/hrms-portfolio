import { createServer, type Server } from 'node:http';

/**
 * Phase 19 — the worker's operational boundary: settings, safe failure logging, a heartbeat
 * in Redis, an optional health server, and graceful shutdown. Framework-free and injectable
 * so it is unit-tested without Redis, PostgreSQL or BullMQ.
 */

export interface WorkerSettings {
  /** Jobs processed in parallel by this process (WORKER_CONCURRENCY, 1–10, default 1). */
  concurrency: number;
  /** Port of the optional health server (WORKER_HEALTH_PORT); disabled when unset. */
  healthPort: number | null;
  /** How long SIGTERM waits for active jobs before forcing exit (ms). */
  shutdownTimeoutMs: number;
  heartbeatIntervalMs: number;
}

export const HEARTBEAT_KEY = 'hrms:worker:heartbeat';
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;

function integerSetting(
  raw: string | undefined,
  name: string,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function parseWorkerSettings(env: Record<string, string | undefined>): WorkerSettings {
  return {
    // Jobs are organization-wide batch runs that take row locks; one at a time per process
    // is the safe default, and more processes scale horizontally.
    concurrency: integerSetting(env.WORKER_CONCURRENCY, 'WORKER_CONCURRENCY', 1, 10) ?? 1,
    healthPort: integerSetting(env.WORKER_HEALTH_PORT, 'WORKER_HEALTH_PORT', 1, 65_535),
    shutdownTimeoutMs:
      integerSetting(
        env.WORKER_SHUTDOWN_TIMEOUT_MS,
        'WORKER_SHUTDOWN_TIMEOUT_MS',
        1_000,
        600_000,
      ) ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}

export const DEVELOPMENT_REDIS_URL = 'redis://localhost:6380';

export interface WorkerConnections {
  redisUrl: string;
  /** PostgreSQL for the readiness probe (jobs read DATABASE_URL themselves). */
  databaseUrl: string | null;
}

/**
 * Where the worker connects. Outside production Redis defaults to the docker-compose port;
 * production requires REDIS_URL and DATABASE_URL so a missing variable fails at startup
 * instead of silently pointing at localhost.
 */
export function resolveConnections(env: Record<string, string | undefined>): WorkerConnections {
  const redisUrl = env.REDIS_URL?.trim() || null;
  const databaseUrl = env.DATABASE_URL?.trim() || null;
  if (env.NODE_ENV === 'production') {
    const missing = [!redisUrl && 'REDIS_URL', !databaseUrl && 'DATABASE_URL'].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`${missing.join(' and ')} must be configured in production`);
    }
  }
  return { redisUrl: redisUrl ?? DEVELOPMENT_REDIS_URL, databaseUrl };
}

export interface FailedJobLike {
  id?: string;
  name?: string;
  attemptsMade?: number;
  opts?: { attempts?: number };
}

/**
 * One line per failure: job name, id, attempt and the error's class and message (truncated).
 * Never the payload, never the stack (it can embed data in some drivers' messages).
 */
export function describeJobFailure(job: FailedJobLike | undefined, error: unknown): string {
  const name = typeof job?.name === 'string' ? job.name.slice(0, 100) : 'unknown';
  const id = typeof job?.id === 'string' ? job.id.slice(0, 100) : 'unknown';
  const attempts = job?.opts?.attempts ?? 1;
  const attempt = job?.attemptsMade ?? 0;
  const errorName = error instanceof Error ? error.name : 'Error';
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/\s+/g, ' ').slice(0, 500);
  const final = attempt >= attempts || errorName === 'UnrecoverableError';
  return `Job ${name} (${id}) failed on attempt ${attempt}/${attempts}${final ? ' (no further retries)' : ''}: ${errorName}: ${message}`;
}

export interface HeartbeatRedis {
  set(key: string, value: string, mode: 'PX', ttl: number): Promise<unknown>;
}

/**
 * Writes `{"at": <ISO>, "pid": n}` to HEARTBEAT_KEY now and every interval, expiring after
 * three missed beats, so an absent key means no live worker. Failures are swallowed (the
 * readiness check reports Redis).
 */
export function startHeartbeat(
  redis: HeartbeatRedis,
  intervalMs: number,
  now: () => Date = () => new Date(),
): { beat: () => Promise<void>; stop: () => void } {
  const beat = async () => {
    try {
      await redis.set(
        HEARTBEAT_KEY,
        JSON.stringify({ at: now().toISOString(), pid: process.pid }),
        'PX',
        intervalMs * 3,
      );
    } catch {
      // Redis down: the heartbeat simply goes stale.
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref();
  return { beat, stop: () => clearInterval(timer) };
}

export type ComponentStatus = 'up' | 'down';

export interface HealthServerOptions {
  port: number;
  host?: string;
  /** Liveness: the worker is running (not shutting down). */
  alive: () => boolean;
  /** Readiness: Redis and PostgreSQL respond. */
  ready: () => Promise<{ status: 'ready' | 'not_ready'; checks: Record<string, ComponentStatus> }>;
}

/** GET /health and GET /ready only; component status only, never error details. */
export function createHealthServer(options: HealthServerOptions): Server {
  return createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'GET') return send(405, { status: 'method_not_allowed' });
    const path = (request.url ?? '/').split('?')[0];
    if (path === '/health') {
      return options.alive() ? send(200, { status: 'ok' }) : send(503, { status: 'shutting_down' });
    }
    if (path === '/ready') {
      if (!options.alive()) return send(503, { status: 'not_ready', checks: {} });
      options
        .ready()
        .then((report) => send(report.status === 'ready' ? 200 : 503, report))
        .catch(() => send(503, { status: 'not_ready', checks: {} }));
      return;
    }
    send(404, { status: 'not_found' });
  });
}

export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown>;
}

/**
 * Runs the shutdown steps in order once (stop taking jobs and wait for active ones first),
 * logging and continuing past a failing step. Resolves with the exit code: 0 when every step
 * finished within the timeout, 1 otherwise.
 */
export function createShutdown(
  steps: ShutdownStep[],
  timeoutMs: number,
  log: (message: string) => void = (message) => console.log(message),
): () => Promise<number> {
  let running: Promise<number> | undefined;
  return () => {
    running ??= (async () => {
      log('Worker shutting down: no new jobs, waiting for active jobs');
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          log(`Worker shutdown timed out after ${timeoutMs} ms; forcing exit`);
          resolve(1);
        }, timeoutMs);
      });
      const completed = (async () => {
        let code = 0;
        for (const step of steps) {
          try {
            await step.run();
          } catch (error) {
            code = 1;
            log(
              `Worker shutdown step ${step.name} failed: ${error instanceof Error ? error.name : 'Error'}`,
            );
          }
        }
        return code;
      })();
      const code = await Promise.race([completed, timedOut]);
      if (timer) clearTimeout(timer);
      if (code === 0) log('Worker stopped');
      return code;
    })();
    return running;
  };
}
