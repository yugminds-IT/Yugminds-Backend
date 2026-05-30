import { Injectable } from '@nestjs/common';

export interface PerformanceMetric {
  endpoint: string;
  method: string;
  duration: number;
  statusCode: number;
  timestamp: number;
  userId?: string;
  error?: string;
}

export interface EndpointStat {
  endpoint: string;
  requests: number;
  errors: number;
  avgDuration: number;
  p95Duration: number;
  successRate: number;
}

export interface ApiMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  requestsByEndpoint: Record<string, number>;
  errorsByEndpoint: Record<string, number>;
  endpointStats: EndpointStat[];
  uptimeSeconds: number;
}

@Injectable()
export class MonitoringService {
  private readonly recent: PerformanceMetric[] = [];
  private readonly maxRecent = 500;

  private totalRequests = 0;
  private successfulRequests = 0;
  private failedRequests = 0;
  private totalDurationMs = 0;
  private readonly requestsByEndpoint = new Map<string, number>();
  private readonly errorsByEndpoint = new Map<string, number>();
  // Per-endpoint duration list for percentile calculation (capped)
  private readonly durationsByEndpoint = new Map<string, number[]>();
  private readonly allDurations: number[] = [];
  private readonly startTime = Date.now();

  record(metric: PerformanceMetric): void {
    this.totalRequests += 1;
    this.totalDurationMs += metric.duration;

    if (metric.statusCode >= 200 && metric.statusCode < 400) {
      this.successfulRequests += 1;
    } else {
      this.failedRequests += 1;
      const key = metric.endpoint;
      this.errorsByEndpoint.set(key, (this.errorsByEndpoint.get(key) || 0) + 1);
    }

    const key = metric.endpoint;
    this.requestsByEndpoint.set(
      key,
      (this.requestsByEndpoint.get(key) || 0) + 1,
    );

    // Track durations per endpoint (keep last 200 per endpoint)
    const epDurations = this.durationsByEndpoint.get(key) ?? [];
    epDurations.push(metric.duration);
    if (epDurations.length > 200)
      epDurations.splice(0, epDurations.length - 200);
    this.durationsByEndpoint.set(key, epDurations);

    // Track all durations for global percentiles (keep last 2000)
    this.allDurations.push(metric.duration);
    if (this.allDurations.length > 2000)
      this.allDurations.splice(0, this.allDurations.length - 2000);

    this.recent.push(metric);
    if (this.recent.length > this.maxRecent) {
      this.recent.splice(0, this.recent.length - this.maxRecent);
    }
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  getSnapshot(): { metrics: ApiMetrics; recent: PerformanceMetric[] } {
    const averageResponseTime =
      this.totalRequests > 0
        ? Math.round(this.totalDurationMs / this.totalRequests)
        : 0;

    const sortedAll = [...this.allDurations].sort((a, b) => a - b);
    const p95ResponseTime = this.percentile(sortedAll, 0.95);
    const p99ResponseTime = this.percentile(sortedAll, 0.99);

    const requestsByEndpoint: Record<string, number> = {};
    for (const [k, v] of this.requestsByEndpoint.entries())
      requestsByEndpoint[k] = v;

    const errorsByEndpoint: Record<string, number> = {};
    for (const [k, v] of this.errorsByEndpoint.entries())
      errorsByEndpoint[k] = v;

    // Build per-endpoint stats
    const endpointStats: EndpointStat[] = [];
    for (const [ep, count] of this.requestsByEndpoint.entries()) {
      const errors = this.errorsByEndpoint.get(ep) ?? 0;
      const durations = this.durationsByEndpoint.get(ep) ?? [];
      const sorted = [...durations].sort((a, b) => a - b);
      const avgDuration =
        sorted.length > 0
          ? Math.round(sorted.reduce((s, d) => s + d, 0) / sorted.length)
          : 0;
      const p95Duration = this.percentile(sorted, 0.95);
      endpointStats.push({
        endpoint: ep,
        requests: count,
        errors,
        avgDuration,
        p95Duration,
        successRate:
          count > 0 ? Math.round(((count - errors) / count) * 100) : 100,
      });
    }
    endpointStats.sort((a, b) => b.requests - a.requests);

    return {
      metrics: {
        totalRequests: this.totalRequests,
        successfulRequests: this.successfulRequests,
        failedRequests: this.failedRequests,
        averageResponseTime,
        p95ResponseTime,
        p99ResponseTime,
        requestsByEndpoint,
        errorsByEndpoint,
        endpointStats,
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      },
      recent: [...this.recent].slice(-200),
    };
  }
}
