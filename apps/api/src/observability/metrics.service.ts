import { Injectable } from '@nestjs/common';

export type MetricLabels = Record<string, string | number>;

/**
 * Phase 19 — a minimal metrics hook. The application records counters and observations
 * through this interface; the default implementation discards them. A deployment that wants
 * metrics binds its own implementation (e.g. a Prometheus or OpenTelemetry adapter) to this
 * token in ObservabilityModule. Labels must be low-cardinality and never personal data.
 */
export abstract class MetricsService {
  abstract increment(name: string, labels?: MetricLabels, value?: number): void;
  abstract observe(name: string, value: number, labels?: MetricLabels): void;
}

@Injectable()
export class NoopMetricsService extends MetricsService {
  increment(): void {}
  observe(): void {}
}

/** Counts in memory; for tests and local diagnostics. */
export class InMemoryMetricsService extends MetricsService {
  readonly counters = new Map<string, number>();
  readonly observations = new Map<string, number[]>();

  increment(name: string, labels: MetricLabels = {}, value = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const key = metricKey(name, labels);
    this.observations.set(key, [...(this.observations.get(key) ?? []), value]);
  }
}

export function metricKey(name: string, labels: MetricLabels = {}): string {
  const parts = Object.keys(labels)
    .sort()
    .map((label) => `${label}=${labels[label]}`);
  return parts.length > 0 ? `${name}{${parts.join(',')}}` : name;
}
