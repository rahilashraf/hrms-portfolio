import { Global, Module } from '@nestjs/common';
import { MetricsService, NoopMetricsService } from './metrics.service.js';

/**
 * Phase 19: the metrics hook (no-op by default; bind another MetricsService implementation
 * here to export metrics). Request ids, request logging and security headers are applied in
 * configureHttpApplication (config/http-application.ts), before routing.
 */
@Global()
@Module({
  providers: [{ provide: MetricsService, useClass: NoopMetricsService }],
  exports: [MetricsService],
})
export class ObservabilityModule {}
