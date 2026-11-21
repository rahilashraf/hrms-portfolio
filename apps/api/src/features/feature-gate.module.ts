import { Global, Module } from '@nestjs/common';
import { FeatureGateService } from './feature-gate.service.js';

/**
 * Phase 18 — the feature gate, global so every domain module's services can depend on it
 * without importing the admin module (which itself depends on domain services).
 */
@Global()
@Module({
  providers: [FeatureGateService],
  exports: [FeatureGateService],
})
export class FeatureGateModule {}
