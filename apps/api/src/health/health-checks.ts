/**
 * Phase 19 — dependency probes shared by the API (/ready) and the worker's health signal.
 * Framework-free so the worker can import them through the `api/platform-health` export.
 * Results carry only a component status, never connection strings or error details.
 */
export type ComponentStatus = 'up' | 'down';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: Record<string, ComponentStatus>;
}

export const DATABASE_CHECK_TIMEOUT_MS = 1_500;
export const REDIS_CHECK_TIMEOUT_MS = 1_000;

export interface SqlProbeClient {
  $queryRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<unknown>;
}

export interface PingProbeClient {
  ping(): PromiseLike<unknown>;
}

/** Resolves to the probe's result, or rejects once `timeoutMs` elapsed. */
export async function withTimeout<T>(
  operation: () => PromiseLike<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probe(
  operation: () => PromiseLike<unknown>,
  timeoutMs: number,
): Promise<ComponentStatus> {
  try {
    await withTimeout(operation, timeoutMs);
    return 'up';
  } catch {
    return 'down';
  }
}

export function checkDatabase(
  client: SqlProbeClient,
  timeoutMs = DATABASE_CHECK_TIMEOUT_MS,
): Promise<ComponentStatus> {
  return probe(() => client.$queryRaw`SELECT 1`, timeoutMs);
}

export function checkRedis(
  client: PingProbeClient,
  timeoutMs = REDIS_CHECK_TIMEOUT_MS,
): Promise<ComponentStatus> {
  return probe(async () => {
    const reply = await client.ping();
    if (reply !== 'PONG') throw new Error('unexpected reply');
  }, timeoutMs);
}

export async function readiness(
  checks: Record<string, () => Promise<ComponentStatus>>,
): Promise<ReadinessReport> {
  const names = Object.keys(checks);
  const results = await Promise.all(names.map((name) => checks[name]!()));
  const report: Record<string, ComponentStatus> = {};
  names.forEach((name, index) => (report[name] = results[index]!));
  return {
    status: results.every((result) => result === 'up') ? 'ready' : 'not_ready',
    checks: report,
  };
}

/**
 * A database client for probes outside Nest (the worker's readiness): one connection pool,
 * reused across probes, closed with `$disconnect()` at shutdown.
 */
export async function createDatabaseProbeClient(
  databaseUrl: string,
): Promise<SqlProbeClient & { $disconnect(): Promise<void> }> {
  const { PrismaService } = await import('../database/prisma.service.js');
  return new PrismaService(databaseUrl);
}
