import { EventEmitter } from 'node:events';
import { resolveLogFormat, REDACTED_LOG_KEYS } from './logger.js';
import { InMemoryMetricsService, metricKey } from './metrics.service.js';
import {
  requestIdMiddleware,
  requestLogEntry,
  requestLoggingMiddleware,
  resolveRequestId,
  routeTemplate,
} from './request-context.js';

function fakeResponse(statusCode = 200) {
  const emitter = new EventEmitter() as EventEmitter & {
    statusCode: number;
    writableFinished: boolean;
    headers: Record<string, string>;
    setHeader: (name: string, value: string) => void;
  };
  emitter.statusCode = statusCode;
  emitter.writableFinished = true;
  emitter.headers = {};
  emitter.setHeader = (name, value) => (emitter.headers[name] = value);
  return emitter;
}

describe('observability', () => {
  it('keeps only short, safe request ids', () => {
    expect(resolveRequestId('abc-123')).toBe('abc-123');
    expect(resolveRequestId(undefined, 'trace:9.1')).toBe('trace:9.1');
    for (const unsafe of ['', ' x', 'a b', '<x>', 'x'.repeat(101), ['a'], 7]) {
      expect(resolveRequestId(unsafe)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('normalizes both id headers and echoes the id', () => {
    const request = {
      headers: { 'x-correlation-id': 'from-client', 'x-request-id': '<bad>' },
    } as never as Parameters<ReturnType<typeof requestIdMiddleware>>[0];
    const response = fakeResponse();
    const next = vi.fn();
    requestIdMiddleware()(request, response as never, next);
    expect(request.requestId).toBe('from-client');
    expect(request.headers['x-request-id']).toBe('from-client');
    expect(request.headers['x-correlation-id']).toBe('from-client');
    expect(response.headers['X-Request-Id']).toBe('from-client');
    expect(next).toHaveBeenCalled();
  });

  it('logs the route template, never the URL', () => {
    const request = {
      method: 'GET',
      originalUrl: '/documents/records/42?token=secret',
      url: '/documents/records/42?token=secret',
      baseUrl: '',
      route: { path: '/documents/records/:recordId' },
      requestId: 'r-1',
      auth: { userId: 'user-1' },
      headers: { authorization: 'Bearer x', cookie: 'a=b' },
      body: { email: 'person@example.com' },
    };
    const entry = requestLogEntry(request as never, 200, 12.345);
    expect(entry).toEqual({
      requestId: 'r-1',
      method: 'GET',
      route: '/documents/records/:recordId',
      status: 200,
      durationMs: 12.3,
      userId: 'user-1',
    });
    expect(routeTemplate({ url: '/x?token=1' } as never)).toBe('unmatched');
  });

  it('writes one line and two metrics per request, by severity', () => {
    const metrics = new InMemoryMetricsService();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const middleware = requestLoggingMiddleware(metrics, logger);
    for (const status of [200, 404, 503]) {
      const response = fakeResponse(status);
      middleware(
        { method: 'POST', route: { path: '/x' }, baseUrl: '' } as never,
        response as never,
        vi.fn(),
      );
      response.emit('finish');
      response.emit('close');
    }
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(
      metrics.counters.get(
        metricKey('http_requests_total', {
          method: 'POST',
          route: '/x',
          status: 503,
        }),
      ),
    ).toBe(1);
    expect(metrics.observations.size).toBe(3);
  });

  it('flags requests the client aborted', () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const response = fakeResponse(200);
    response.writableFinished = false;
    requestLoggingMiddleware(new InMemoryMetricsService(), logger)(
      { method: 'GET' } as never,
      response as never,
      vi.fn(),
    );
    response.emit('close');
    expect(logger.warn).toHaveBeenCalledWith(
      'http_request',
      expect.objectContaining({ aborted: true, route: 'unmatched' }),
    );
  });

  it('logs JSON in production unless configured otherwise, and masks secrets', () => {
    expect(resolveLogFormat('production', undefined)).toBe('json');
    expect(resolveLogFormat('development', undefined)).toBe('text');
    expect(resolveLogFormat('production', 'text')).toBe('text');
    expect(resolveLogFormat('test', 'json')).toBe('json');
    for (const key of [
      'password',
      'token',
      'authorization',
      'cookie',
      'email',
    ]) {
      expect(REDACTED_LOG_KEYS).toContain(key);
    }
  });
});
