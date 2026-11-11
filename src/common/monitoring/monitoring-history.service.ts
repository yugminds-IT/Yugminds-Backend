import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../../database/database.service';
import {
  HourlyRow,
  MONITORING_ROLES,
  MonitoringRole,
  MonitoringService,
} from './monitoring.service';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const CHUNK = 400; // rows per INSERT, well under the 65,535 parameter limit

interface StatRow {
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

export interface HourPoint {
  hour: string;
  requests: number;
  ok: number;
  client_errors: number;
  server_errors: number;
  avg_ms: number;
  /** requests that took half a second or more */
  slow: number;
  over_1s: number;
  max_ms: number;
}

export interface Breakdown {
  requests: number;
  client_errors: number;
  server_errors: number;
  avg_ms: number;
  slow_percent: number;
}

/**
 * Keeps hourly API traffic totals in the database so the System monitoring trends survive restarts.
 * The live counters are added to the table every minute and when the server shuts down. Each server
 * instance only ever adds its own counts, so several instances can share one table. Rows older than
 * the retention period (7 days unless MONITORING_RETENTION_DAYS says otherwise) are deleted every hour.
 */
@Injectable()
export class MonitoringHistoryService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(MonitoringHistoryService.name);
  readonly retentionDays = Math.min(
    90,
    Math.max(1, Number(process.env.MONITORING_RETENTION_DAYS) || 7),
  );
  private missingTableUntil = 0;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly monitoring: MonitoringService,
  ) {}

  private get enabled(): boolean {
    return process.env.MONITORING_HISTORY !== 'off';
  }

  /** The table comes from a migration; until it exists we wait quietly and keep counting in memory. */
  private noteMissingTable(err: unknown): boolean {
    const msg = String((err as { message?: string })?.message ?? err);
    if (!/ApiHourlyStat/.test(msg) || !/does not exist|42P01/.test(msg))
      return false;
    if (this.missingTableUntil === 0) {
      this.logger.warn(
        'ApiHourlyStat table not found. Monitoring history is paused until the migration is applied (prisma migrate deploy).',
      );
    }
    this.missingTableUntil = Date.now() + 10 * 60_000;
    return true;
  }

  onModuleInit(): void {
    if (this.enabled) void this.purge();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.flush(true);
  }

  @Cron('* * * * *')
  async flush(force = false): Promise<void> {
    if (!this.enabled) return;
    if (this.flushing) return this.flushing; // never run two saves at once
    if (!force && Date.now() < this.missingTableUntil) return;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const rows = this.monitoring.drainHourly();
    if (rows.length === 0) return;
    try {
      for (let i = 0; i < rows.length; i += CHUNK)
        await this.insert(rows.slice(i, i + CHUNK));
      this.missingTableUntil = 0;
    } catch (err) {
      this.monitoring.restoreHourly(rows); // keep the counts for the next try
      if (!this.noteMissingTable(err)) {
        this.logger.warn(
          `Could not save monitoring history: ${(err as Error)?.message?.split('\n').pop() ?? err}`,
        );
      }
    }
  }

  private async insert(rows: HourlyRow[]): Promise<void> {
    const params: unknown[] = [];
    const values = rows.map((r) => {
      const o = params.length;
      params.push(
        randomUUID(),
        r.hour,
        r.role,
        r.schoolId,
        r.requests,
        r.ok,
        r.clientErrors,
        r.serverErrors,
        r.totalMs,
        r.maxMs,
        r.under200,
        r.under500,
        r.under1000,
        r.over1000,
      );
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}::bigint, $${o + 10}, $${o + 11}, $${o + 12}, $${o + 13}, $${o + 14})`;
    });
    const add = (c: string) =>
      `"${c}" = "ApiHourlyStat"."${c}" + EXCLUDED."${c}"`;
    await this.db.$executeRawUnsafe(
      `INSERT INTO "ApiHourlyStat" ("id","hour","role","schoolId","requests","ok","clientErrors","serverErrors","totalMs","maxMs","under200","under500","under1000","over1000")
       VALUES ${values.join(', ')}
       ON CONFLICT ("hour","role","schoolId") DO UPDATE SET
         ${['requests', 'ok', 'clientErrors', 'serverErrors', 'totalMs', 'under200', 'under500', 'under1000', 'over1000'].map(add).join(', ')},
         "maxMs" = GREATEST("ApiHourlyStat"."maxMs", EXCLUDED."maxMs")`,
      ...params,
    );
  }

  /** Delete everything older than the retention period. */
  @Cron('7 * * * *')
  async purge(): Promise<number> {
    if (!this.enabled || Date.now() < this.missingTableUntil) return 0;
    try {
      const cutoff = new Date(Date.now() - this.retentionDays * DAY_MS);
      return Number(
        await this.db.$executeRawUnsafe(
          'DELETE FROM "ApiHourlyStat" WHERE "hour" < $1',
          cutoff,
        ),
      );
    } catch (err) {
      if (!this.noteMissingTable(err))
        this.logger.warn(
          `Could not purge old monitoring history: ${(err as Error)?.message?.split('\n').pop() ?? err}`,
        );
      return 0;
    }
  }

  private breakdown(rows: StatRow[]): Breakdown {
    const requests = rows.reduce((a, r) => a + r.requests, 0);
    const totalMs = rows.reduce((a, r) => a + r.totalMs, 0);
    const slow = rows.reduce((a, r) => a + r.under1000 + r.over1000, 0);
    return {
      requests,
      client_errors: rows.reduce((a, r) => a + r.clientErrors, 0),
      server_errors: rows.reduce((a, r) => a + r.serverErrors, 0),
      avg_ms: requests > 0 ? Math.round(totalMs / requests) : 0,
      slow_percent: requests > 0 ? Math.round((slow / requests) * 100) : 0,
    };
  }

  /** Hour by hour totals for the last `hours` hours, with a split by role and by school. */
  async history(opts: {
    hours?: number;
    role?: MonitoringRole;
    schoolId?: string;
  }) {
    const maxHours = this.retentionDays * 24;
    const hours = Math.min(
      maxHours,
      Math.max(1, Math.floor(Number(opts.hours) || 24)),
    );
    const role =
      opts.role && MONITORING_ROLES.includes(opts.role) ? opts.role : undefined;
    const schoolId = opts.schoolId || undefined;

    await this.flush(true); // include what has happened since the last minute
    const lastHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const firstHour = lastHour - (hours - 1) * HOUR_MS;

    let rows: StatRow[] = [];
    try {
      const where = ['"hour" >= $1'];
      const params: unknown[] = [new Date(firstHour)];
      if (role) {
        params.push(role);
        where.push(`"role" = $${params.length}`);
      }
      if (schoolId) {
        params.push(schoolId);
        where.push(`"schoolId" = $${params.length}`);
      }
      rows = await this.db.$queryRawUnsafe<StatRow[]>(
        `SELECT "hour","role","schoolId","requests","ok","clientErrors","serverErrors","totalMs"::float8 AS "totalMs","maxMs","under200","under500","under1000","over1000"
         FROM "ApiHourlyStat" WHERE ${where.join(' AND ')} ORDER BY "hour"`,
        ...params,
      );
    } catch (err) {
      if (!this.noteMissingTable(err)) throw err;
      return {
        available: false as const,
        retention_days: this.retentionDays,
        hours,
        series: [] as HourPoint[],
        totals: this.breakdown([]),
        by_role: [],
        by_school: [],
      };
    }

    // One point per hour, including quiet hours, so the chart keeps its shape.
    const byHour = new Map<number, StatRow[]>();
    for (const r of rows) {
      const k = new Date(r.hour).getTime();
      (byHour.get(k) ?? byHour.set(k, []).get(k)!).push(r);
    }
    const series: HourPoint[] = [];
    for (let t = firstHour; t <= lastHour; t += HOUR_MS) {
      const g = byHour.get(t) ?? [];
      const b = this.breakdown(g);
      series.push({
        hour: new Date(t).toISOString(),
        requests: b.requests,
        ok: g.reduce((a, r) => a + r.ok, 0),
        client_errors: b.client_errors,
        server_errors: b.server_errors,
        avg_ms: b.avg_ms,
        slow: g.reduce((a, r) => a + r.under1000 + r.over1000, 0),
        over_1s: g.reduce((a, r) => a + r.over1000, 0),
        max_ms: g.reduce((a, r) => Math.max(a, r.maxMs), 0),
      });
    }

    const by_role = MONITORING_ROLES.map((r) => ({
      role: r,
      ...this.breakdown(rows.filter((x) => x.role === r)),
    })).filter((x) => x.requests > 0);

    const schoolIds = [...new Set(rows.map((r) => r.schoolId).filter(Boolean))];
    const names = schoolIds.length
      ? new Map(
          (
            await this.db.school.findMany({
              where: { id: { in: schoolIds } },
              select: { id: true, name: true },
            })
          ).map((s) => [s.id, s.name]),
        )
      : new Map<string, string>();
    const by_school = schoolIds
      .map((id) => ({
        school_id: id,
        school_name: names.get(id) ?? 'A school that no longer exists',
        ...this.breakdown(rows.filter((x) => x.schoolId === id)),
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 12);

    return {
      available: true as const,
      retention_days: this.retentionDays,
      hours,
      series,
      totals: this.breakdown(rows),
      by_role,
      by_school,
    };
  }
}
