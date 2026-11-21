import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { MetricsService } from './metrics.service.js';

export const REQUEST_ID_HEADER = 'x-request-id';
/** The header the Phase 2+ audit context reads; kept in sync with the request id. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** A caller-supplied id is kept only when it is short and of a safe alphabet. */
export function resolveRequestId(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && SAFE_REQUEST_ID.test(candidate)) {
      return candidate;
    }
  }
  return randomUUID();
}

export type RequestWithId = Request & {
  requestId?: string;
  auth?: { userId?: string };
};

/**
 * Accepts a safe `X-Request-Id` (or `X-Correlation-Id`) or generates one, echoes it as
 * `X-Request-Id`, and normalizes both request headers so every audit record and log line of
 * the request carries the same sanitized id (an unchecked client header used to reach the
 * audit log as is).
 */
export function requestIdMiddleware() {
  return (request: RequestWithId, response: Response, next: NextFunction) => {
    const id = resolveRequestId(
      request.headers[REQUEST_ID_HEADER],
      request.headers[CORRELATION_ID_HEADER],
    );
    request.requestId = id;
    request.headers[REQUEST_ID_HEADER] = id;
    request.headers[CORRELATION_ID_HEADER] = id;
    response.setHeader('X-Request-Id', id);
    next();
  };
}

/** The matched route template (e.g. `/documents/records/:recordId`), never the raw URL. */
export function routeTemplate(request: Request): string {
  const route = (request as Request & { route?: { path?: unknown } }).route;
  if (route && typeof route.path === 'string') {
    return `${request.baseUrl ?? ''}${route.path}` || '/';
  }
  return 'unmatched';
}

export interface RequestLogEntry {
  requestId: string | undefined;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  userId?: string;
}

/** Only identifiers and timings: no bodies, query strings, headers, cookies or emails. */
export function requestLogEntry(
  request: RequestWithId,
  status: number,
  durationMs: number,
): RequestLogEntry {
  return {
    requestId: request.requestId,
    method: request.method,
    route: routeTemplate(request),
    status,
    durationMs: Math.round(durationMs * 10) / 10,
    ...(request.auth?.userId ? { userId: request.auth.userId } : {}),
  };
}

/** One structured line and two metrics per finished (or aborted) request. */
export function requestLoggingMiddleware(
  metrics: MetricsService,
  logger: Pick<Logger, 'log' | 'warn' | 'error'> = new Logger('HTTP'),
) {
  return (request: RequestWithId, response: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    let done = false;
    const finish = (aborted: boolean) => {
      if (done) return;
      done = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const entry = requestLogEntry(request, response.statusCode, durationMs);
      const labels = {
        method: entry.method,
        route: entry.route,
        status: entry.status,
      };
      metrics.increment('http_requests_total', labels);
      metrics.observe('http_request_duration_ms', entry.durationMs, labels);
      const fields = { ...entry, ...(aborted ? { aborted: true } : {}) };
      if (entry.status >= 500) logger.error('http_request', fields);
      else if (entry.status >= 400 || aborted)
        logger.warn('http_request', fields);
      else logger.log('http_request', fields);
    };
    response.on('finish', () => finish(false));
    response.on('close', () => finish(!response.writableFinished));
    next();
  };
}
