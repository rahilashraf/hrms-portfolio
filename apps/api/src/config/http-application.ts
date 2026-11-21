import cookieParser from 'cookie-parser';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import type { MetricsService } from '../observability/metrics.service.js';
import {
  requestIdMiddleware,
  requestLoggingMiddleware,
} from '../observability/request-context.js';
import { configureTrustProxy } from './trust-proxy.js';

export interface HttpApplicationOptions {
  production: boolean;
  webOrigin: string;
  trustProxyHops: number;
  metrics: MetricsService;
}

/** JSON bodies: the largest legitimate payloads are bounded imports (500 rows). */
export const JSON_BODY_LIMIT = '1mb';
export const URLENCODED_BODY_LIMIT = '100kb';
export const HSTS_HEADER = 'max-age=31536000; includeSubDomains';

/**
 * Phase 19 security headers for a JSON API (no new dependency). Every response defaults to
 * `Cache-Control: no-store` (the API serves personal data and nothing cacheable; a route may
 * still set its own value), is never framed, never MIME-sniffed and sends no referrer.
 */
export function securityHeadersMiddleware(production: boolean) {
  return (_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
    response.setHeader('Cache-Control', 'no-store');
    if (production)
      response.setHeader('Strict-Transport-Security', HSTS_HEADER);
    next();
  };
}

/**
 * The HTTP pipeline of the API, shared by main.ts and the platform e2e tests. Order matters:
 * request id and headers first (so even body-parser and 404 responses carry them), then
 * request logging, cookies and bounded body parsers, then CORS and validation.
 */
export function configureHttpApplication(
  app: INestApplication,
  options: HttpApplicationOptions,
): void {
  const express = app as NestExpressApplication;
  configureTrustProxy(app, options.trustProxyHops);
  express.disable('x-powered-by');
  app.use(requestIdMiddleware());
  app.use(securityHeadersMiddleware(options.production));
  app.use(requestLoggingMiddleware(options.metrics));
  app.use(cookieParser());
  express.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  express.useBodyParser('urlencoded', {
    limit: URLENCODED_BODY_LIMIT,
    extended: true,
  });
  app.enableCors({
    // Exactly the web application's origin (validated by @hrms/config), with credentials.
    origin: options.webOrigin,
    credentials: true,
    // Content-Disposition: report export file names (Phase 17); Retry-After: 429 responses.
    exposedHeaders: [
      'Content-Disposition',
      'Retry-After',
      'X-Request-Id',
      'X-Report-Truncated',
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
