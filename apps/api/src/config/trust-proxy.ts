import type { INestApplication } from '@nestjs/common';
import type { Express } from 'express';

export function configureTrustProxy(
  app: INestApplication,
  trustedHops: number,
): void {
  const expressApp = app.getHttpAdapter().getInstance() as Express;
  expressApp.set('trust proxy', trustedHops);
}
