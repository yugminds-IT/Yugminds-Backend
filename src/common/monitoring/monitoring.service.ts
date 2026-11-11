import { Injectable } from '@nestjs/common';

/** Who made a request: one of the four dashboards, or "public" for anyone not signed in (login, contact form, the website). */
export type MonitoringRole =
  | 'admin'
  | 'school_admin'
  | 'teacher'
  | 'student'
  | 'public';
export const MONITORING_ROLES: MonitoringRole[] = [
  'admin',
  'school_admin',
  'teacher',
  'student',
  'public',
];

export interface PerformanceMetric {
  endpoint: string;
  method: string;
  duration: number;
  statusCode: number;
  timestamp: number;
  userId?: string;
  role?: MonitoringRole;
  /** the school the request was for; empty when it is not tied to one */
  schoolId?: string;
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

export interface SnapshotFilter {
  role?: MonitoringRole;
  schoolId?: string;
}

/** What gets added to the hourly history table: one row per hour, role and school. */
export interface HourlyRow {
  hour: Date;
  role: MonitoringRole;
  schoolId: string;
  requests: number;
  ok: number;
  clientErrors: number;
  serverErrors: number;
  totalMs: number;
  maxMs: number;
  under200: number;
  under500: number;
  under1000: number;
  over1000: number;
}

interface EndpointBucket {
  count: number;
  errors: number;
  durations: number[];
}

/** Everything counted for one role and school since the server started. */
interface Bucket {
  total: number;
  failed: number;
  totalMs: number;
  durations: number[];
  endpoints: Map<string, EndpointBucket>;
}

const HOUR_MS = 3_600_000;

@Injectable()
export class MonitoringService {
  private readonly recent: PerformanceMetric[] = [];
  private readonly maxRecent = 500;

  // One bucket per role and school, so the page can be filtered to "teachers at this school".
  // The key is `${role}|${schoolId}`; the number of keys stays small (roles x schools).
  private readonly buckets = new Map<string, Bucket>();
  private readonly knownEndpoints = new Set<string>();
  private readonly hourly = new Map<string, HourlyRow>();
  private readonly startTime = Date.now();

  // Safety net: never track more than this many distinct endpoint keys.
  private static readonly MAX_ENDPOINT_KEYS = 500;
  private static readonly MAX_DURATIONS = 2000;
  private static readonly MAX_ENDPOINT_DURATIONS = 200;

  record(input: PerformanceMetric): void {
    const known =
      this.knownEndpoints.has(input.endpoint) ||
      this.knownEndpoints.size < MonitoringService.MAX_ENDPOINT_KEYS;
    const metric: PerformanceMetric = {
      ...input,
      endpoint: known ? input.endpoint : '(other)',
      role: input.role ?? 'public',
      schoolId: input.schoolId ?? '',
    };
    this.knownEndpoints.add(metric.endpoint);

    const failed = !(metric.statusCode >= 200 && metric.statusCode < 400);
    const key = `${metric.role}|${metric.schoolId}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = {
        total: 0,
        failed: 0,
        totalMs: 0,
        durations: [],
        endpoints: new Map(),
      };
      this.buckets.set(key, b);
    }
    b.total += 1;
    b.totalMs += metric.duration;
    if (failed) b.failed += 1;
    b.durations.push(metric.duration);
    if (b.durations.length > MonitoringService.MAX_DURATIONS) {
      b.durations.splice(
        0,
        b.durations.length - MonitoringService.MAX_DURATIONS,
      );
    }
    const ep = b.endpoints.get(metric.endpoint) ?? {
      count: 0,
      errors: 0,
      durations: [],
    };
    ep.count += 1;
    if (failed) ep.errors += 1;
    ep.durations.push(metric.duration);
    if (ep.durations.length > MonitoringService.MAX_ENDPOINT_DURATIONS) {
      ep.durations.splice(
        0,
        ep.durations.length - MonitoringService.MAX_ENDPOINT_DURATIONS,
      );
    }
    b.endpoints.set(metric.endpoint, ep);

    this.recent.push(metric);
    if (this.recent.length > this.maxRecent) {
      this.recent.splice(0, this.recent.length - this.maxRecent);
    }

    this.addToHour(metric);
  }

  private addToHour(m: PerformanceMetric): void {
    const hourMs = Math.floor(m.timestamp / HOUR_MS) * HOUR_MS;
    const key = `${hourMs}|${m.role}|${m.schoolId}`;
    let row = this.hourly.get(key);
    if (!row) {
      row = {
        hour: new Date(hourMs),
        role: m.role!,
        schoolId: m.schoolId!,
        requests: 0,
        ok: 0,
        clientErrors: 0,
        serverErrors: 0,
        totalMs: 0,
        maxMs: 0,
        under200: 0,
        under500: 0,
        under1000: 0,
        over1000: 0,
      };
      this.hourly.set(key, row);
    }
    row.requests += 1;
    if (m.statusCode >= 500) row.serverErrors += 1;
    else if (m.statusCode >= 400) row.clientErrors += 1;
    else row.ok += 1;
    row.totalMs += m.duration;
    row.maxMs = Math.max(row.maxMs, m.duration);
    if (m.duration < 200) row.under200 += 1;
    else if (m.duration < 500) row.under500 += 1;
    else if (m.duration < 1000) row.under1000 += 1;
    else row.over1000 += 1;
  }

  /** Hand over the hourly counts collected so far, and start counting again. */
  drainHourly(): HourlyRow[] {
    const rows = [...this.hourly.values()];
    this.hourly.clear();
    return rows;
  }

  /** Put counts back (a save to the database failed) so they are tried again, never lost. */
  restoreHourly(rows: HourlyRow[]): void {
    for (const r of rows) {
      const key = `${r.hour.getTime()}|${r.role}|${r.schoolId}`;
      const cur = this.hourly.get(key);
      if (!cur) {
        this.hourly.set(key, { ...r });
        continue;
      }
      cur.requests += r.requests;
      cur.ok += r.ok;
      cur.clientErrors += r.clientErrors;
      cur.serverErrors += r.serverErrors;
      cur.totalMs += r.totalMs;
      cur.maxMs = Math.max(cur.maxMs, r.maxMs);
      cur.under200 += r.under200;
      cur.under500 += r.under500;
      cur.under1000 += r.under1000;
      cur.over1000 += r.over1000;
    }
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  private matches(key: string, filter?: SnapshotFilter): boolean {
    if (!filter?.role && !filter?.schoolId) return true;
    const [role, schoolId] = key.split('|');
    return (
      (!filter.role || role === filter.role) &&
      (!filter.schoolId || schoolId === filter.schoolId)
    );
  }

  /** Requests since the server started, per role, ignoring any filter (for the role buttons). */
  private countsByRole(): Record<MonitoringRole, number> {
    const out = {
      admin: 0,
      school_admin: 0,
      teacher: 0,
      student: 0,
      public: 0,
    } as Record<MonitoringRole, number>;
    for (const [key, b] of this.buckets)
      out[key.split('|')[0] as MonitoringRole] += b.total;
    return out;
  }

  getSnapshot(filter?: SnapshotFilter): {
    metrics: ApiMetrics;
    recent: PerformanceMetric[];
    byRole: Record<MonitoringRole, number>;
  } {
    let total = 0;
    let failed = 0;
    let totalMs = 0;
    const all: number[] = [];
    const merged = new Map<string, EndpointBucket>();
    for (const [key, b] of this.buckets) {
      if (!this.matches(key, filter)) continue;
      total += b.total;
      failed += b.failed;
      totalMs += b.totalMs;
      all.push(...b.durations);
      for (const [ep, e] of b.endpoints) {
        const m = merged.get(ep) ?? { count: 0, errors: 0, durations: [] };
        m.count += e.count;
        m.errors += e.errors;
        m.durations.push(...e.durations);
        merged.set(ep, m);
      }
    }

    const sortedAll = all.sort((a, b) => a - b);
    const requestsByEndpoint: Record<string, number> = {};
    const errorsByEndpoint: Record<string, number> = {};
    const endpointStats: EndpointStat[] = [];
    for (const [ep, e] of merged) {
      requestsByEndpoint[ep] = e.count;
      if (e.errors > 0) errorsByEndpoint[ep] = e.errors;
      const sorted = [...e.durations].sort((a, b) => a - b);
      endpointStats.push({
        endpoint: ep,
        requests: e.count,
        errors: e.errors,
        avgDuration:
          sorted.length > 0
            ? Math.round(sorted.reduce((s, d) => s + d, 0) / sorted.length)
            : 0,
        p95Duration: this.percentile(sorted, 0.95),
        successRate:
          e.count > 0
            ? Math.round(((e.count - e.errors) / e.count) * 100)
            : 100,
      });
    }
    endpointStats.sort((a, b) => b.requests - a.requests);

    const recent = this.recent.filter(
      (r) =>
        (!filter?.role || r.role === filter.role) &&
        (!filter?.schoolId || r.schoolId === filter.schoolId),
    );

    return {
      metrics: {
        totalRequests: total,
        successfulRequests: total - failed,
        failedRequests: failed,
        averageResponseTime: total > 0 ? Math.round(totalMs / total) : 0,
        p95ResponseTime: this.percentile(sortedAll, 0.95),
        p99ResponseTime: this.percentile(sortedAll, 0.99),
        requestsByEndpoint,
        errorsByEndpoint,
        endpointStats,
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      },
      recent: recent.slice(-200),
      byRole: this.countsByRole(),
    };
  }
}
