import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureHttpApplication } from './config/http-application.js';
import { resolveListenPort } from './config/listen-port.js';
import { createAppLogger, resolveLogFormat } from './observability/logger.js';
import { MetricsService } from './observability/metrics.service.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: createAppLogger(
      resolveLogFormat(process.env.NODE_ENV, process.env.LOG_FORMAT),
    ),
  });
  const config = app.get(ConfigService);
  const production = config.getOrThrow<string>('NODE_ENV') === 'production';
  configureHttpApplication(app, {
    production,
    webOrigin: config.getOrThrow<string>('WEB_ORIGIN'),
    trustProxyHops: config.getOrThrow<number>('TRUST_PROXY_HOPS'),
    metrics: app.get(MetricsService),
  });
  // SIGTERM/SIGINT: stop accepting connections, run module destroy hooks (Prisma, Redis).
  app.enableShutdownHooks();
  // Railway injects PORT; 3001 is the local development default only.
  await app.listen(resolveListenPort(process.env.PORT, production));
}
await bootstrap();
